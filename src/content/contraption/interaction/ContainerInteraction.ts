import {
  system,
  world,
  type Dimension,
  type Entity,
  type Player,
  type Vector3
} from "@minecraft/server";
import type { PhysicsContraption, PhysicsContraptionBlock } from "@src/Physics";
import { squaredDistance } from "@src/utils/Vector3Math";
import { EPSILON_1E6 } from "@src/utils/Vector3Math";
import { VANILLA_DIMENSION_IDS } from "@src/utils/WorldBlock";

export const CHEST_ENTITY_TYPE_ID = "treephysics:chest";

const CHEST_BLOCK_TYPE_ID = "minecraft:chest";
const CHEST_NAME_TRANSLATION_KEY = "tile.chest.name";
const STORAGE_ID_PROPERTY = "treephysics:storage_id";
const STORAGE_OWNER_PROPERTY = "treephysics:storage_owner";
const STORAGE_LOCATION_PROPERTY = "treephysics:storage_location";
const ACTIVE_EVENT = "treephysics:chest_activate";
const INACTIVE_EVENT = "treephysics:chest_deactivate";
// Height of the vanilla chest body (14/16 blocks, matching the chest collision
// box in tree/contraption-block.ts). The storage entity origin sits half of this
// below the cell center — the bottom of the rendered chest cube — so the
// entity's upward-growing interaction box tracks the chest fragment.
const STORAGE_COLLISION_HEIGHT = 0.875;
const POSITION_EPSILON_SQUARED = EPSILON_1E6;
const STORAGE_DETACH_TIMEOUT_TICKS = 20;
const CHEST_CLOSE_SOUND_DELAY_TICKS = 1;

export interface ContraptionChestStorageBinding {
  readonly localLocation: Vector3;
  readonly storageId: string;
}

export interface ContraptionChestStorageReplacement {
  readonly contraption: PhysicsContraption;
  readonly bindings: readonly ContraptionChestStorageBinding[];
  readonly ownerId: string;
}

interface ChestStorageRecord {
  active: boolean;
  contraption?: PhysicsContraption;
  attached: boolean;
  claimed: boolean;
  entity?: Entity;
  lastLocation?: Vector3;
  localLocation: Vector3;
  ownerId: string;
  pendingAttachTick: number | undefined;
  readonly previewers: Set<string>;
  readonly storageId: string;
  readonly viewers: Set<string>;
}

/**
 * Owns persistent native chest containers while assemblies own their lifetime.
 * Contraption replacement needs no interaction-handler hook here: storage
 * ownership is transferred transactionally by ContraptionLifecycle through
 * replaceContraptionStorages.
 */
export class ContraptionContainerInteractionController {
  readonly #activeRecords = new Set<ChestStorageRecord>();
  readonly #recordByStorageId = new Map<string, ChestStorageRecord>();
  readonly #recordCountByDimension = new Map<string, number>();
  readonly #storageIdByContraptionBlock = new Map<string, string>();
  readonly #storageIdByEntityId = new Map<string, string>();
  readonly #previewStorageByPlayer = new Map<string, string>();
  readonly #viewerStorageByPlayer = new Map<string, string>();
  readonly #nativeDeathEntityIds = new Set<string>();
  readonly #settlingEntityIds = new Set<string>();
  #nativeDeathHandler?: (
    ownerId: string,
    binding: ContraptionChestStorageBinding
  ) => void;
  #bindingRegistrationComplete = false;
  #started = false;

  setNativeDeathHandler(
    handler: (ownerId: string, binding: ContraptionChestStorageBinding) => void
  ): void {
    if (this.#nativeDeathHandler) {
      throw new Error("The chest storage native-death handler is already configured.");
    }
    this.#nativeDeathHandler = handler;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    world.beforeEvents.playerInteractWithEntity.subscribe(event => {
      if (event.target.typeId !== CHEST_ENTITY_TYPE_ID) return;
      const record = this.#recordForEntity(event.target);
      if (record?.contraption?.isValid && record.active) return;
      event.cancel = true;
      // A registered but inactive record is a benign race between deactivation
      // and player input; only a truly unregistered entity indicates a leak.
      if (!record) {
        system.run(() => {
          throw new Error(`Unbound chest storage entity ${event.target.id} was interacted with.`);
        });
      }
    });
    world.afterEvents.entityContainerOpened.subscribe(event => {
      if (event.entity.typeId !== CHEST_ENTITY_TYPE_ID) return;
      const player = event.openSource.entity;
      if (player?.typeId !== "minecraft:player") return;
      this.#openContainer(player as Player, event.entity);
    });
    world.afterEvents.entityContainerClosed.subscribe(event => {
      if (event.entity.typeId !== CHEST_ENTITY_TYPE_ID) return;
      const player = event.closeSource.entity;
      if (player?.typeId !== "minecraft:player") return;
      this.#closeContainer(player.id, event.entity);
    });
    world.afterEvents.entityDie.subscribe(event => {
      if (event.deadEntity.typeId !== CHEST_ENTITY_TYPE_ID) return;
      if (
        !this.#settlingEntityIds.has(event.deadEntity.id)
        && this.#storageIdByEntityId.has(event.deadEntity.id)
      ) this.#nativeDeathEntityIds.add(event.deadEntity.id);
      // Native death owns the inventory drop. The script owns the invisible
      // storage entity itself, just as the fragment renderer owns its entities.
      if (event.deadEntity.isValid) event.deadEntity.remove();
    });
    world.afterEvents.entityRemove.subscribe(event => {
      if (event.typeId !== CHEST_ENTITY_TYPE_ID) return;
      this.handleEntityRemove(event.removedEntityId);
    });

    // Entity-load events do not replay for entities already loaded with the script.
    system.run(() => {
      for (const dimensionId of VANILLA_DIMENSION_IDS) {
        const dimension = world.getDimension(dimensionId);
        for (const entity of dimension.getEntities({ type: CHEST_ENTITY_TYPE_ID })) {
          this.handleEntityLoad(entity);
        }
      }
    });
  }

  canInteract(_contraption: PhysicsContraption, block: PhysicsContraptionBlock): boolean {
    return block.typeId === CHEST_BLOCK_TYPE_ID
      && block.visual?.renderer === "cube_block_fragment";
  }

  /** Native entity interaction opens the container; this only consumes contraption gestures. */
  interact(
    _player: Player,
    contraption: PhysicsContraption,
    block: PhysicsContraptionBlock
  ): boolean {
    if (!this.canInteract(contraption, block)) return false;
    const record = this.#recordAt(contraption, block.localLocation);
    if (!record?.entity?.isValid) {
      throw new Error(`Physical chest ${contraptionBlockKey(contraption.id, block.localLocation)} has no storage entity.`);
    }
    // The before-item-use callback may run under restricted execution, so it
    // only consumes the chest gesture. The existing per-tick preview sync owns
    // native rider detachment, teleportation, and activation.
    return true;
  }

  /** Whether any storage record in a dimension could react to syncTarget. */
  hasSyncTargets(dimensionId?: string): boolean {
    if (dimensionId === undefined) {
      return this.#recordCountByDimension.size > 0 || this.#previewStorageByPlayer.size > 0;
    }
    return (this.#recordCountByDimension.get(dimensionId) ?? 0) > 0;
  }

  syncTarget(
    player: Player,
    contraption: PhysicsContraption | undefined,
    block: PhysicsContraptionBlock | undefined
  ): void {
    const next = contraption && block && this.canInteract(contraption, block)
      ? this.#recordAt(contraption, block.localLocation)
      : undefined;
    const previousId = this.#previewStorageByPlayer.get(player.id);
    if (previousId === next?.storageId) return;
    if (previousId) this.#releasePreview(player.id, previousId);
    if (!next?.entity?.isValid) return;
    this.#previewStorageByPlayer.set(player.id, next.storageId);
    next.previewers.add(player.id);
    this.#activate(next);
  }

  tick(): void {
    for (const record of this.#activeRecords) {
      if (!record.entity?.isValid || !record.contraption?.isValid) {
        this.#invalidateRuntimeReferences(record);
        continue;
      }
      const location = activeStorageLocation(record.contraption, record.localLocation);
      if (record.lastLocation && squaredDistance(record.lastLocation, location) <= POSITION_EPSILON_SQUARED) {
        continue;
      }
      record.entity.teleport(location);
      record.lastLocation = location;
    }
  }

  releasePlayer(playerId: string): void {
    const previewStorageId = this.#previewStorageByPlayer.get(playerId);
    if (previewStorageId) this.#releasePreview(playerId, previewStorageId);
    const viewerStorageId = this.#viewerStorageByPlayer.get(playerId);
    if (viewerStorageId) this.#releaseViewer(playerId, viewerStorageId);
  }

  handleEntityLoad(entity: Entity): void {
    if (entity.typeId !== CHEST_ENTITY_TYPE_ID) return;
    const identity = readStorageIdentity(entity);
    let record = this.#recordByStorageId.get(identity.storageId);
    if (!record) {
      if (this.#bindingRegistrationComplete) {
        entity.remove();
        return;
      }
      record = {
        active: false,
        attached: false,
        claimed: false,
        entity,
        localLocation: identity.localLocation,
        ownerId: identity.ownerId,
        pendingAttachTick: undefined,
        previewers: new Set(),
        storageId: identity.storageId,
        viewers: new Set()
      };
      this.#recordByStorageId.set(record.storageId, record);
    } else {
      assertStorageIdentity(record, identity);
      if (record.entity?.isValid && record.entity.id !== entity.id) {
        throw new Error(`Storage ID ${record.storageId} is owned by multiple loaded entities.`);
      }
      record.entity = entity;
    }
    this.#storageIdByEntityId.set(entity.id, record.storageId);
    if (record.contraption?.isValid && !record.active) this.#queueAttach(record);
  }

  handleEntityRemove(entityId: string): void {
    if (this.#settlingEntityIds.delete(entityId)) return;
    const diedNatively = this.#nativeDeathEntityIds.delete(entityId);
    const storageId = this.#storageIdByEntityId.get(entityId);
    if (diedNatively && !storageId) {
      throw new Error(`Native death for chest storage entity ${entityId} lost its storage index.`);
    }
    if (!storageId) return;
    this.#storageIdByEntityId.delete(entityId);
    const record = this.#recordByStorageId.get(storageId);
    if (!record || record.entity?.id !== entityId) return;
    const contraption = record.contraption;
    if (contraption?.isValid) contraption.detachPersistentEntity(record.entity);
    if (diedNatively) {
      this.#invalidateRuntimeReferences(record);
      const handler = this.#nativeDeathHandler;
      if (!handler) {
        throw new Error(`Storage ${record.storageId} died without a native-death handler.`);
      }
      handler(record.ownerId, {
        localLocation: { ...record.localLocation },
        storageId: record.storageId
      });
      this.#removeRecordIndexes(record);
      this.#removeUnusedStorageCarrier(contraption);
      return;
    }
    record.entity = undefined;
    record.active = false;
    record.attached = false;
    record.lastLocation = undefined;
    this.#invalidateRuntimeReferences(record);
  }

  registerSavedBindings(ownerId: string, bindings: readonly ContraptionChestStorageBinding[]): void {
    if (this.#bindingRegistrationComplete) {
      throw new Error("Saved chest storage bindings were registered after reconciliation completed.");
    }
    for (const binding of bindings) this.#claimBinding(ownerId, binding);
  }

  /** Remove every loaded storage entity not claimed by persisted contraption data. */
  completeSavedBindingRegistration(): void {
    if (this.#bindingRegistrationComplete) return;
    this.#bindingRegistrationComplete = true;
    for (const record of [...this.#recordByStorageId.values()]) {
      if (record.claimed) continue;
      this.#removeRecordIndexes(record);
      if (record.entity?.isValid) record.entity.remove();
    }
  }

  bindContraption(
    ownerId: string,
    contraption: PhysicsContraption,
    bindings: readonly ContraptionChestStorageBinding[]
  ): void {
    for (const binding of bindings) {
      const block = contraption.getBlockAtLocalLocation(binding.localLocation);
      if (block?.typeId !== CHEST_BLOCK_TYPE_ID) {
        throw new Error(`Storage ${binding.storageId} does not point to a chest block.`);
      }
      const record = this.#claimBinding(ownerId, binding);
      if (record.contraption && record.contraption !== contraption && record.contraption.isValid) {
        throw new Error(`Storage ${binding.storageId} is already bound to another contraption.`);
      }
      if (record.contraption !== contraption) record.attached = false;
      this.#setRecordContraption(record, contraption);
      this.#storageIdByContraptionBlock.set(
        contraptionBlockKey(contraption.id, binding.localLocation),
        binding.storageId
      );
      if (record.entity?.isValid && !record.active) this.#queueAttach(record);
    }
  }

  /** Roll back runtime ownership when a restored contraption fails before commit. */
  rollbackContraptionBinding(ownerId: string, contraption: PhysicsContraption): void {
    for (const record of this.#recordByStorageId.values()) {
      if (record.ownerId !== ownerId || record.contraption !== contraption) continue;
      if (record.attached && record.entity?.isValid && contraption.isValid) {
        contraption.detachPersistentEntity(record.entity);
      }
      this.#storageIdByContraptionBlock.delete(
        contraptionBlockKey(contraption.id, record.localLocation)
      );
      this.#setRecordContraption(record, undefined);
      record.attached = false;
      record.lastLocation = undefined;
    }
  }

  createStorage(
    ownerId: string,
    contraption: PhysicsContraption,
    localLocation: Vector3
  ): ContraptionChestStorageBinding {
    const entity = contraption.body.dimension.dimension.spawnEntity(
      CHEST_ENTITY_TYPE_ID,
      activeStorageLocation(contraption, localLocation)
    );
    try {
      const storageId = entity.id;
      entity.setDynamicProperty(STORAGE_ID_PROPERTY, storageId);
      entity.setDynamicProperty(STORAGE_OWNER_PROPERTY, ownerId);
      entity.setDynamicProperty(STORAGE_LOCATION_PROPERTY, { ...localLocation });
      entity.nameTag = CHEST_NAME_TRANSLATION_KEY;
      entity.triggerEvent(INACTIVE_EVENT);
      const container = entity.getComponent("minecraft:inventory")?.container;
      if (!container || container.size !== 27) {
        throw new Error("Chest storage entity does not expose a 27-slot inventory.");
      }
      const record: ChestStorageRecord = {
        active: false,
        contraption: undefined,
        attached: false,
        claimed: true,
        entity,
        localLocation: { ...localLocation },
        ownerId,
        pendingAttachTick: undefined,
        previewers: new Set(),
        storageId,
        viewers: new Set()
      };
      this.#recordByStorageId.set(storageId, record);
      this.#setRecordContraption(record, contraption);
      this.#storageIdByEntityId.set(entity.id, storageId);
      this.#storageIdByContraptionBlock.set(contraptionBlockKey(contraption.id, localLocation), storageId);
      this.#attach(record);
      return { localLocation: { ...localLocation }, storageId };
    } catch (error) {
      const record = this.#recordByStorageId.get(entity.id);
      if (record) this.#removeRecordIndexes(record);
      if (entity.isValid) entity.remove();
      throw error;
    }
  }

  discardStorage(storageId: string): void {
    const record = this.#requiredRecord(storageId);
    const contraption = record.contraption;
    if (record.contraption?.isValid && record.entity?.isValid) {
      record.contraption.detachPersistentEntity(record.entity);
    }
    this.#removeRecordIndexes(record);
    if (record.entity?.isValid) record.entity.remove();
    this.#removeUnusedStorageCarrier(contraption);
  }

  replaceContraptionStorages(
    sourceOwnerId: string,
    sourceContraption: PhysicsContraption,
    replacements: readonly ContraptionChestStorageReplacement[]
  ): void {
    const assigned = new Set<string>();
    for (const replacement of replacements) {
      for (const binding of replacement.bindings) {
        if (!assigned.add(binding.storageId)) {
          throw new Error(`Storage ${binding.storageId} was assigned to multiple replacement assemblies.`);
        }
        const record = this.#requiredRecord(binding.storageId);
        if (record.ownerId !== sourceOwnerId || record.contraption !== sourceContraption) {
          throw new Error(`Storage ${binding.storageId} is not owned by the replaced contraption.`);
        }
        if (record.entity?.isValid) sourceContraption.detachPersistentEntity(record.entity);
        this.#storageIdByContraptionBlock.delete(
          contraptionBlockKey(sourceContraption.id, record.localLocation)
        );
        record.ownerId = replacement.ownerId;
        record.localLocation = { ...binding.localLocation };
        this.#setRecordContraption(record, replacement.contraption);
        record.attached = false;
        if (record.entity?.isValid) {
          record.entity.setDynamicProperty(STORAGE_OWNER_PROPERTY, replacement.ownerId);
          record.entity.setDynamicProperty(STORAGE_LOCATION_PROPERTY, { ...binding.localLocation });
        }
        this.#storageIdByContraptionBlock.set(
          contraptionBlockKey(replacement.contraption.id, binding.localLocation),
          binding.storageId
        );
        if (
          record.viewers.size > 0
          && !replacement.contraption.setCubeBlockOpenState(binding.localLocation, true)
        ) {
          throw new Error(`Could not transfer open state for storage ${binding.storageId}.`);
        }
        // The source carrier and contraption are removed by the lifecycle caller
        // immediately after this method. Defer the native rider attachment so
        // Bedrock cannot retain a stale parent rider relationship during that
        // deletion.
        if (!record.active && record.entity?.isValid) this.#queueAttach(record);
      }
    }
  }

  settleStorages(
    ownerId: string,
    bindings: readonly ContraptionChestStorageBinding[],
    dimension: Dimension,
    resolveLocation: (localLocation: Vector3) => Vector3
  ): void {
    for (const binding of bindings) {
      const record = this.#requiredRecord(binding.storageId);
      if (record.ownerId !== ownerId || !sameLocation(record.localLocation, binding.localLocation)) {
        throw new Error(`Storage ${binding.storageId} does not match settlement owner ${ownerId}.`);
      }
      const entity = record.entity;
      if (!entity?.isValid || entity.dimension.id !== dimension.id) {
        throw new Error(`Storage ${binding.storageId} is unavailable for contraption settlement.`);
      }
      this.#invalidateRuntimeReferences(record);
      if (record.contraption?.isValid) record.contraption.detachPersistentEntity(entity);
      entity.triggerEvent(ACTIVE_EVENT);
      entity.teleport(storageLocationFromCellCenter(resolveLocation(binding.localLocation)));
      this.#settlingEntityIds.add(entity.id);
      if (!entity.kill()) {
        this.#settlingEntityIds.delete(entity.id);
        throw new Error(`Storage ${binding.storageId} could not complete native inventory settlement.`);
      }
      // Native death owns the inventory drop. Remove any surviving entity on
      // the next tick if the death event did not already close its lifecycle.
      system.run(() => {
        if (entity.isValid) entity.remove();
      });
      this.#removeRecordIndexes(record);
      this.#removeUnusedStorageCarrier(record.contraption);
    }
  }

  #claimBinding(ownerId: string, binding: ContraptionChestStorageBinding): ChestStorageRecord {
    let record = this.#recordByStorageId.get(binding.storageId);
    if (!record) {
      record = {
        active: false,
        attached: false,
        claimed: true,
        localLocation: { ...binding.localLocation },
        ownerId,
        pendingAttachTick: undefined,
        previewers: new Set(),
        storageId: binding.storageId,
        viewers: new Set()
      };
      this.#recordByStorageId.set(binding.storageId, record);
      return record;
    }
    assertStorageIdentity(record, {
      localLocation: binding.localLocation,
      ownerId,
      storageId: binding.storageId
    });
    record.claimed = true;
    return record;
  }

  #recordAt(contraption: PhysicsContraption, localLocation: Vector3): ChestStorageRecord | undefined {
    const storageId = this.#storageIdByContraptionBlock.get(
      contraptionBlockKey(contraption.id, localLocation)
    );
    return storageId ? this.#recordByStorageId.get(storageId) : undefined;
  }

  #recordForEntity(entity: Entity): ChestStorageRecord | undefined {
    const storageId = this.#storageIdByEntityId.get(entity.id)
      ?? entity.getDynamicProperty(STORAGE_ID_PROPERTY);
    return typeof storageId === "string" ? this.#recordByStorageId.get(storageId) : undefined;
  }

  #requiredRecord(storageId: string): ChestStorageRecord {
    const record = this.#recordByStorageId.get(storageId);
    if (!record) throw new Error(`Storage ${storageId} is not registered.`);
    return record;
  }

  #activate(record: ChestStorageRecord): void {
    if (record.active) return;
    const entity = record.entity;
    const contraption = record.contraption;
    if (!entity?.isValid || !contraption?.isValid) return;
    if (record.attached) contraption.detachPersistentEntity(entity, true);
    record.attached = false;
    const location = activeStorageLocation(contraption, record.localLocation);
    entity.teleport(location);
    entity.triggerEvent(ACTIVE_EVENT);
    record.active = true;
    this.#activeRecords.add(record);
    record.lastLocation = location;
  }

  #deactivate(record: ChestStorageRecord): void {
    if (!record.active || record.previewers.size > 0 || record.viewers.size > 0) return;
    const entity = record.entity;
    if (!entity?.isValid) return;
    entity.triggerEvent(INACTIVE_EVENT);
    record.active = false;
    this.#activeRecords.delete(record);
    record.lastLocation = undefined;
    this.#attach(record);
  }

  #queueAttach(record: ChestStorageRecord): void {
    if (record.pendingAttachTick !== undefined) return;
    record.pendingAttachTick = system.currentTick;
    system.run(() => this.#completeQueuedAttach(record));
  }

  #completeQueuedAttach(record: ChestStorageRecord): void {
    const queuedTick = record.pendingAttachTick;
    if (queuedTick === undefined) return;
    if (
      this.#recordByStorageId.get(record.storageId) !== record
      || record.active
      || record.attached
      || !record.entity?.isValid
      || !record.contraption?.isValid
    ) {
      record.pendingAttachTick = undefined;
      return;
    }
    const vehicle = record.entity.getComponent("minecraft:riding")?.entityRidingOn;
    if (vehicle) {
      if (system.currentTick - queuedTick >= STORAGE_DETACH_TIMEOUT_TICKS) {
        record.pendingAttachTick = undefined;
        throw new Error(
          `Storage ${record.storageId} did not detach from carrier ${vehicle.id} before attaching to contraption ${record.contraption.id}.`
        );
      }
      // Native rider removal is asynchronous. Do not create a competing child
      // relationship until Bedrock has removed the source riding component.
      system.run(() => this.#completeQueuedAttach(record));
      return;
    }
    record.pendingAttachTick = undefined;
    this.#attach(record);
  }

  #attach(record: ChestStorageRecord): void {
    const entity = record.entity;
    const contraption = record.contraption;
    if (!entity?.isValid || !contraption?.isValid) return;
    if (!contraption.attachPersistentEntity(entity)) {
      throw new Error(`Storage ${record.storageId} could not attach to its contraption carrier.`);
    }
    record.attached = true;
  }

  #releasePreview(playerId: string, storageId: string): void {
    if (this.#previewStorageByPlayer.get(playerId) === storageId) {
      this.#previewStorageByPlayer.delete(playerId);
    }
    const record = this.#recordByStorageId.get(storageId);
    if (!record) return;
    record.previewers.delete(playerId);
    this.#deactivate(record);
  }

  #releaseViewer(playerId: string, storageId: string): void {
    if (this.#viewerStorageByPlayer.get(playerId) === storageId) {
      this.#viewerStorageByPlayer.delete(playerId);
    }
    const record = this.#recordByStorageId.get(storageId);
    if (!record || !record.viewers.delete(playerId)) return;
    if (record.viewers.size === 0) this.#setOpen(record, false);
    this.#deactivate(record);
  }

  #openContainer(player: Player, entity: Entity): void {
    const record = this.#recordForEntity(entity);
    if (!record?.contraption?.isValid || !record.active) {
      throw new Error(`Container opened for invalid storage entity ${entity.id}.`);
    }
    const previous = this.#viewerStorageByPlayer.get(player.id);
    if (previous && previous !== record.storageId) this.#releaseViewer(player.id, previous);
    if (record.viewers.size === 0) this.#setOpen(record, true);
    record.viewers.add(player.id);
    this.#viewerStorageByPlayer.set(player.id, record.storageId);
  }

  #closeContainer(playerId: string, entity: Entity): void {
    const record = this.#recordForEntity(entity);
    if (!record) return;
    this.#releaseViewer(playerId, record.storageId);
  }

  #setOpen(record: ChestStorageRecord, open: boolean): void {
    const contraption = record.contraption;
    if (!contraption?.isValid) return;
    if (!contraption.setCubeBlockOpenState(record.localLocation, open)) {
      throw new Error(`Could not set chest ${record.storageId} open state to ${open}.`);
    }
    const dimension = contraption.body.dimension.dimension;
    const location = contraption.body.localPointToWorld(record.localLocation);
    if (open) {
      dimension.playSound("random.chestopen", location, { pitch: 1, volume: 0.5 });
      return;
    }
    system.runTimeout(() => {
      dimension.playSound("random.chestclosed", location, { pitch: 1, volume: 0.5 });
    }, CHEST_CLOSE_SOUND_DELAY_TICKS);
  }

  #invalidateRuntimeReferences(record: ChestStorageRecord): void {
    this.#activeRecords.delete(record);
    record.active = false;
    record.attached = false;
    record.lastLocation = undefined;
    for (const playerId of record.previewers) {
      if (this.#previewStorageByPlayer.get(playerId) === record.storageId) {
        this.#previewStorageByPlayer.delete(playerId);
      }
    }
    for (const playerId of record.viewers) {
      if (this.#viewerStorageByPlayer.get(playerId) === record.storageId) {
        this.#viewerStorageByPlayer.delete(playerId);
      }
    }
    const wasOpen = record.viewers.size > 0;
    record.previewers.clear();
    record.viewers.clear();
    if (
      wasOpen
      && record.contraption?.isValid
      && record.contraption.getBlockAtLocalLocation(record.localLocation)?.typeId === CHEST_BLOCK_TYPE_ID
    ) this.#setOpen(record, false);
  }

  #removeRecordIndexes(record: ChestStorageRecord): void {
    record.pendingAttachTick = undefined;
    this.#activeRecords.delete(record);
    if (this.#recordByStorageId.get(record.storageId) === record) {
      this.#recordByStorageId.delete(record.storageId);
      this.#adjustRecordCount(record.contraption?.body.dimension.id, -1);
    }
    if (record.entity) this.#storageIdByEntityId.delete(record.entity.id);
    if (record.contraption) {
      this.#storageIdByContraptionBlock.delete(
        contraptionBlockKey(record.contraption.id, record.localLocation)
      );
    }
  }

  #setRecordContraption(
    record: ChestStorageRecord,
    contraption: PhysicsContraption | undefined
  ): void {
    const previousDimensionId = record.contraption?.body.dimension.id;
    const nextDimensionId = contraption?.body.dimension.id;
    record.contraption = contraption;
    if (previousDimensionId === nextDimensionId) return;
    this.#adjustRecordCount(previousDimensionId, -1);
    this.#adjustRecordCount(nextDimensionId, 1);
  }

  #adjustRecordCount(dimensionId: string | undefined, delta: -1 | 1): void {
    if (dimensionId === undefined) return;
    const next = (this.#recordCountByDimension.get(dimensionId) ?? 0) + delta;
    if (next < 0) {
      throw new Error(`Chest storage count for dimension ${dimensionId} became negative.`);
    }
    if (next === 0) this.#recordCountByDimension.delete(dimensionId);
    else this.#recordCountByDimension.set(dimensionId, next);
  }

  #removeUnusedStorageCarrier(contraption: PhysicsContraption | undefined): void {
    if (!contraption?.isValid) return;
    for (const record of this.#recordByStorageId.values()) {
      if (record.contraption === contraption) return;
    }
    contraption.removeEmptyPersistentEntityCarriers();
  }
}

function readStorageIdentity(entity: Entity): {
  readonly localLocation: Vector3;
  readonly ownerId: string;
  readonly storageId: string;
} {
  const storageId = entity.getDynamicProperty(STORAGE_ID_PROPERTY);
  const ownerId = entity.getDynamicProperty(STORAGE_OWNER_PROPERTY);
  const localLocation = entity.getDynamicProperty(STORAGE_LOCATION_PROPERTY);
  if (
    typeof storageId !== "string"
    || storageId.length === 0
    || typeof ownerId !== "string"
    || ownerId.length === 0
    || !isIntegerVector(localLocation)
  ) {
    throw new Error(`Chest storage entity ${entity.id} has invalid persistent identity.`);
  }
  return { localLocation, ownerId, storageId };
}

function assertStorageIdentity(
  record: ChestStorageRecord,
  identity: {
    readonly localLocation: Vector3;
    readonly ownerId: string;
    readonly storageId: string;
  }
): void {
  if (
    record.storageId !== identity.storageId
    || record.ownerId !== identity.ownerId
    || !sameLocation(record.localLocation, identity.localLocation)
  ) {
    throw new Error(`Storage ${identity.storageId} has conflicting persistent ownership.`);
  }
}

function activeStorageLocation(contraption: PhysicsContraption, localLocation: Vector3): Vector3 {
  return storageLocationFromCellCenter(contraption.body.localPointToWorld(localLocation));
}

function storageLocationFromCellCenter(center: Vector3): Vector3 {
  return {
    x: center.x,
    y: center.y - STORAGE_COLLISION_HEIGHT * 0.5,
    z: center.z
  };
}

function contraptionBlockKey(contraptionId: number, localLocation: Vector3): string {
  return `${contraptionId}|${localLocation.x},${localLocation.y},${localLocation.z}`;
}

function sameLocation(left: Vector3, right: Vector3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function isIntegerVector(value: unknown): value is Vector3 {
  if (!value || typeof value !== "object") return false;
  const vector = value as Partial<Vector3>;
  return Number.isInteger(vector.x) && Number.isInteger(vector.y) && Number.isInteger(vector.z);
}
