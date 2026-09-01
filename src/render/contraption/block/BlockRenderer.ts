// Per-block contraption visual renderer: one holdable-model entity per block riding
// shared carrier entities, plus an embedded fragment renderer for the
// packed Stage 2 cube blocks.
import { system, type Entity, type Vector3 } from "@minecraft/server";
import { blockKey } from "@src/utils/BlockKey";
import type { PhysicsContraptionBlock, PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import {
  CUBE_FRAGMENT_ENTITY_TYPE_ID,
  packFragments
} from "@src/render/contraption/fragment/FragmentLayout";
import { DEFAULT_CONTRAPTION_FOLIAGE_TINT } from "@src/render/foliage/TintCodec";
import { selectContraptionVisualAnchor } from "@src/render/contraption/shared/VisualAnchor";
// The carrier capacity must stay defined in contraption-visual-renderer.ts because
// physics.ts imports it from there. The resulting module cycle is safe: the
// constant is only read inside method bodies, after both modules initialized.
import { BLOCK_CARRIER_CAPACITY } from "@src/render/contraption/shared/Renderer";
import type {
  ContraptionRenderBody,
  ContraptionRenderer,
  BlockAssignment,
  BlockCarrier,
  BlockSlot
} from "@src/render/contraption/shared/Renderer";
import {
  FRAGMENT_CARRIER_CAPACITY,
  FRAGMENT_CARRIER_ENTITY_TYPE_ID,
  FragmentRenderer
} from "@src/render/contraption/fragment/FragmentRenderer";
import {
  VISUAL_POSITION_WRITE_THRESHOLD,
  VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES,
  ejectCurrentVehicle,
  exceedsWriteThreshold,
  getContinuousVisualRotation,
  hasExactRiders,
  hasRidersConsistentWithPendingAttachments,
  nativeRiders,
  scheduleRiderAttachmentConfirmation,
  validEntityLocations
} from "@src/render/contraption/shared/VisualEntityUtils";

export class BlockRenderer implements ContraptionRenderer {
  readonly #assignments = new Map<string, LiveBlockAssignment>();
  readonly #carriers: LiveBlockCarrier[] = [];
  readonly #carrierByBlockEntityId = new Map<string, LiveBlockCarrier>();
  readonly #body: ContraptionRenderBody;
  // Known Stage 2 cube blocks keep their packed model and lid animation while
  // the original unsupported blocks remain on the block visual chain.
  #cubeFragments?: FragmentRenderer;
  readonly #foliageTint: PhysicsContraptionFoliageTint;
  readonly #visualsByEntityId = new Map<string, LiveBlock>();
  readonly #onEntityAdded?: (entityId: string) => void;
  readonly #onEntityRemoved?: (entityId: string) => void;
  readonly #spawnEntity?: (typeId: string, location: Vector3) => Entity;
  readonly #visualAnchor: Vector3;
  #lastVisualX = Number.NaN;
  #lastVisualY = Number.NaN;
  #lastVisualZ = Number.NaN;
  #initialPoseDeferred = true;
  #knownIntegrityFailure = false;
  #sleepingAtLastSync = false;
  #visualRotation: Vector3 | undefined;
  readonly #publishedVisualRotation: Vector3 = {
    x: Number.NaN,
    y: Number.NaN,
    z: Number.NaN
  };

  get initialPoseDeferred(): boolean {
    return this.#initialPoseDeferred
      || this.#cubeFragments?.initialPoseDeferred === true;
  }
  get supportsBlockAddition(): boolean { return this.#spawnEntity !== undefined; }
  get visualRotation(): Readonly<Vector3> { return this.#publishedVisualRotation; }
  get visualAnchorLocal(): Vector3 { return { ...this.#visualAnchor }; }

  constructor(
    body: ContraptionRenderBody,
    assignments: readonly BlockAssignment[],
    carriers: readonly BlockCarrier[],
    onEntityRemoved?: (entityId: string) => void,
    visualAnchor: Vector3 = selectContraptionVisualAnchor(
      assignments.map(assignment => assignment.block)
    ),
    spawnEntity?: (typeId: string, location: Vector3) => Entity,
    foliageTint: PhysicsContraptionFoliageTint = DEFAULT_CONTRAPTION_FOLIAGE_TINT,
    onEntityAdded?: (entityId: string) => void,
    initialCubeBlocks: readonly PhysicsContraptionBlock[] = []
  ) {
    this.#body = body;
    this.#foliageTint = foliageTint;
    this.#onEntityAdded = onEntityAdded;
    this.#onEntityRemoved = onEntityRemoved;
    this.#spawnEntity = spawnEntity;
    this.#visualAnchor = { ...visualAnchor };
    for (const carrier of carriers) {
      const liveCarrier: LiveBlockCarrier = {
        auxiliaryRiderIds: new Set(),
        dedicatedToPersistentRiders: false,
        entity: carrier.entity,
        pendingRiderIds: new Set(),
        persistentRiderIds: new Set(),
        riderIds: new Set(carrier.riderIds)
      };
      this.#carriers.push(liveCarrier);
      for (const riderId of liveCarrier.riderIds) {
        this.#carrierByBlockEntityId.set(riderId, liveCarrier);
      }
    }
    for (const assignment of assignments) {
      const key = blockKey(assignment.block.localLocation);
      let visual = this.#visualsByEntityId.get(assignment.entity.id);
      if (!visual) {
        visual = { blockKeys: new Set(), entity: assignment.entity };
        this.#visualsByEntityId.set(assignment.entity.id, visual);
      }
      visual.blockKeys.add(key);
      this.#assignments.set(key, {
        entity: assignment.entity,
        slot: assignment.slot,
        visual
      });
    }
    // Initial block riders are mounted before renderer construction. Confirm
    // those native relationships through the same path as later attachments.
    for (const carrier of this.#carriers) {
      for (const riderId of carrier.riderIds) {
        const rider = this.#visualsByEntityId.get(riderId)?.entity;
        if (!rider) {
          throw new Error(`Block carrier ${carrier.entity.id} references unknown visual ${riderId}.`);
        }
        scheduleRiderAttachmentConfirmation(
          carrier.entity,
          rider,
          carrier.pendingRiderIds,
          () => this.#body.isValid && carrier.riderIds.has(riderId),
          () => { this.#knownIntegrityFailure = true; },
          "visual"
        );
      }
    }
    if (initialCubeBlocks.length > 0) {
      try {
        this.#cubeFragments = this.#createCubeFragmentRenderer(initialCubeBlocks);
      } catch (error) {
        this.remove();
        throw error;
      }
    }
  }

  get entityCount(): number {
    return [...this.#visualsByEntityId.values()].filter(visual => visual.entity.isValid).length
      + this.#carriers.filter(carrier => carrier.entity.isValid).length
      + (this.#cubeFragments?.entityCount ?? 0);
  }
  get entityIds(): readonly string[] {
    return [
      ...[...this.#visualsByEntityId.keys()].filter(entityId => this.hasEntity(entityId)),
      ...this.#carriers
        .filter(carrier => carrier.entity.isValid)
        .map(carrier => carrier.entity.id),
      ...(this.#cubeFragments?.entityIds ?? [])
    ];
  }
  get entityLocations(): readonly Vector3[] {
    return [
      ...validEntityLocations([
      ...[...this.#visualsByEntityId.values()].map(visual => visual.entity),
      ...this.#carriers.map(carrier => carrier.entity)
      ]),
      ...(this.#cubeFragments?.entityLocations ?? [])
    ];
  }
  get firstEntityLocation(): Vector3 | undefined {
    return this.entityLocations[0];
  }

  hasEntity(entityId: string): boolean {
    if (this.#visualsByEntityId.get(entityId)?.entity.isValid === true) return true;
    return this.#carriers.some(
      carrier => carrier.entity.id === entityId && carrier.entity.isValid
    ) || this.#cubeFragments?.hasEntity(entityId) === true;
  }

  hasIntactEntities(): boolean {
    if (this.#knownIntegrityFailure) return false;
    if (this.#cubeFragments?.hasKnownIntegrityFailure()) return false;
    const hasBlockVisuals = this.#assignments.size > 0;
    if (hasBlockVisuals !== (this.#visualsByEntityId.size > 0)) return false;
    if (!hasBlockVisuals && !this.#cubeFragments) return false;
    if (
      hasBlockVisuals
      && !this.#carriers.some(carrier => !carrier.dedicatedToPersistentRiders)
    ) return false;
    let assignedBlockCount = 0;
    for (const visual of this.#visualsByEntityId.values()) {
      if (!visual.entity.isValid || visual.blockKeys.size === 0) return false;
      assignedBlockCount += visual.blockKeys.size;
    }
    if (assignedBlockCount !== this.#assignments.size) return false;
    for (const carrier of this.#carriers) {
      const intact = carrier.pendingRiderIds.size > 0
        ? hasRidersConsistentWithPendingAttachments(
          carrier.entity,
          carrier.riderIds,
          carrier.auxiliaryRiderIds,
          carrier.persistentRiderIds,
          carrier.pendingRiderIds
        )
        : hasExactRiders(
          carrier.entity,
          carrier.riderIds,
          carrier.auxiliaryRiderIds,
          carrier.persistentRiderIds
        );
      if (!intact) return false;
    }
    return this.#cubeFragments?.hasIntactEntities() ?? true;
  }

  hasKnownIntegrityFailure(): boolean {
    return this.#knownIntegrityFailure
      || this.#cubeFragments?.hasKnownIntegrityFailure() === true;
  }

  releaseInitialPose(): void {
    if (this.#initialPoseDeferred) {
      for (const visual of this.#visualsByEntityId.values()) {
        if (!visual.entity.isValid) {
          this.#knownIntegrityFailure = true;
          continue;
        }
        visual.entity.setProperty("treephysics:scale", 1);
      }
      this.#initialPoseDeferred = false;
    }
    this.#cubeFragments?.releaseInitialPose();
  }

  setCubeBlockOpenState(blockKey: string, open: boolean): boolean {
    return this.#cubeFragments?.setCubeBlockOpenState(blockKey, open) ?? false;
  }

  setAttachmentBlockVisualState(blockKey: string, _state: number): boolean {
    // Held block items do not expose permutation state. Their visual remains
    // the same while the authoritative captured state is updated by physics.
    return this.#assignments.has(blockKey);
  }

  attachAuxiliaryRider(entity: Entity): boolean {
    if (!entity.isValid) return false;
    const carrier = this.#carriers.find(value => (
      !value.dedicatedToPersistentRiders
      && value.entity.isValid
      && value.auxiliaryRiderIds.size === 0
      && value.riderIds.size + value.persistentRiderIds.size
        < BLOCK_CARRIER_CAPACITY
    ));
    if (carrier) {
      const rideable = carrier.entity.getComponent("minecraft:rideable");
      if (!rideable?.addRider(entity)) return false;
      carrier.auxiliaryRiderIds.add(entity.id);
      this.#syncAuxiliaryRotation(entity);
      return true;
    }
    return false;
  }

  attachPersistentRider(entity: Entity): boolean {
    if (!entity.isValid || !this.#spawnEntity) return false;
    let carrier = this.#carriers.find(value => (
      value.dedicatedToPersistentRiders
      && value.entity.isValid
      && value.persistentRiderIds.size < FRAGMENT_CARRIER_CAPACITY
    ));
    carrier ??= this.#createPersistentCarrier();
    ejectCurrentVehicle(entity);
    const rideable = carrier.entity.getComponent("minecraft:rideable");
    if (!rideable?.addRider(entity)) return false;
    carrier.persistentRiderIds.add(entity.id);
    scheduleRiderAttachmentConfirmation(
      carrier.entity,
      entity,
      carrier.pendingRiderIds,
      () => this.#body.isValid && carrier.persistentRiderIds.has(entity.id),
      () => { this.#knownIntegrityFailure = true; },
      "persistent"
    );
    return true;
  }

  detachAuxiliaryRider(entity: Entity): void {
    const carrier = this.#carriers.find(value => value.auxiliaryRiderIds.has(entity.id));
    if (carrier) {
      carrier.auxiliaryRiderIds.delete(entity.id);
      if (carrier.entity.isValid && entity.isValid) {
        carrier.entity.getComponent("minecraft:rideable")?.ejectRider(entity);
      }
      this.#removeEmptyCarrier(carrier);
    }
  }

  detachPersistentRider(entity: Entity, preserveEmptyCarrier = false): void {
    const carrier = this.#carriers.find(value => value.persistentRiderIds.has(entity.id));
    if (!carrier) return;
    if (carrier.entity.isValid && entity.isValid) {
      carrier.entity.getComponent("minecraft:rideable")?.ejectRider(entity);
    }
    // Commit the script registry only after the native relationship changed.
    carrier.pendingRiderIds.delete(entity.id);
    carrier.persistentRiderIds.delete(entity.id);
    if (!preserveEmptyCarrier) this.#removeEmptyCarrier(carrier, true);
  }

  removeEmptyPersistentRiderCarriers(): void {
    for (const carrier of [...this.#carriers]) {
      if (carrier.dedicatedToPersistentRiders && carrier.persistentRiderIds.size === 0) {
        this.#removeEmptyCarrier(carrier, true);
      }
    }
  }

  removeBlocks(blockKeys: ReadonlySet<string>): void {
    this.#cubeFragments?.removeBlocks(blockKeys);
    this.#releaseEmptyCubeFragmentRenderer();
    for (const key of blockKeys) {
      const assignment = this.#assignments.get(key);
      if (!assignment) continue;
      const { entity, slot, visual } = assignment;
      if (visual.blockKeys.size > 1 && entity.isValid) {
        entity.runCommand(`replaceitem entity @s slot.weapon.${slot} 0 minecraft:air`);
      }
      this.#assignments.delete(key);
      visual.blockKeys.delete(key);
      if (visual.blockKeys.size > 0) continue;
      this.#visualsByEntityId.delete(entity.id);
      this.#onEntityRemoved?.(entity.id);
      if (entity.isValid) entity.remove();
      const carrier = this.#carrierByBlockEntityId.get(entity.id);
      this.#carrierByBlockEntityId.delete(entity.id);
      if (!carrier) continue;
      carrier.pendingRiderIds.delete(entity.id);
      carrier.riderIds.delete(entity.id);
      this.#removeEmptyCarrier(carrier);
    }
  }

  rebaseVisualAnchor(_blocks: readonly PhysicsContraptionBlock[]): void {}

  addBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    if (!this.#spawnEntity) {
      throw new Error("Per-block visual assemblies require an entity factory for Stage 2.");
    }
    if (this.#cubeFragments) {
      this.#cubeFragments.addBlocks(blocks);
      return;
    }
    const renderer = this.#createCubeFragmentRenderer(blocks);
    this.#cubeFragments = renderer;
    renderer.sync(true);
    system.run(() => {
      if (this.#cubeFragments !== renderer || !this.#body.isValid) return;
      renderer.sync(true);
      renderer.releaseInitialPose();
    });
  }

  remove(): void {
    this.#cubeFragments?.remove();
    this.#cubeFragments = undefined;
    for (const visual of this.#visualsByEntityId.values()) {
      this.#onEntityRemoved?.(visual.entity.id);
      if (visual.entity.isValid) visual.entity.remove();
    }
    for (const carrier of this.#carriers) {
      carrier.pendingRiderIds.clear();
      for (const rider of nativeRiders(carrier.entity)) {
        if (carrier.auxiliaryRiderIds.has(rider.id) && rider.isValid) rider.remove();
        else if (carrier.persistentRiderIds.has(rider.id) && rider.isValid) {
          carrier.entity.getComponent("minecraft:rideable")?.ejectRider(rider);
        }
      }
      this.#onEntityRemoved?.(carrier.entity.id);
      if (carrier.entity.isValid) carrier.entity.remove();
    }
    this.#assignments.clear();
    this.#visualsByEntityId.clear();
    this.#carriers.length = 0;
    this.#carrierByBlockEntityId.clear();
  }

  sync(force = false): number {
    let writes = this.#cubeFragments?.sync(force) ?? 0;
    if (!this.#body.isValid) return writes;
    const sleeping = this.#body.isSleeping === true;
    if (!force && sleeping && this.#sleepingAtLastSync) return writes;
    this.#sleepingAtLastSync = sleeping;
    const rotation = getContinuousVisualRotation(this.#body, this.#visualRotation);
    this.#visualRotation = rotation;
    const visualAnchor = this.#body.localPointToWorld(this.#visualAnchor);
    const positionChanged = force
      || exceedsWriteThreshold(visualAnchor.x, this.#lastVisualX, VISUAL_POSITION_WRITE_THRESHOLD)
      || exceedsWriteThreshold(visualAnchor.y, this.#lastVisualY, VISUAL_POSITION_WRITE_THRESHOLD)
      || exceedsWriteThreshold(visualAnchor.z, this.#lastVisualZ, VISUAL_POSITION_WRITE_THRESHOLD);
    const pitchChanged = force || exceedsWriteThreshold(
      rotation.x,
      this.#publishedVisualRotation.x,
      VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES
    );
    const yawChanged = force || exceedsWriteThreshold(
      rotation.y,
      this.#publishedVisualRotation.y,
      VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES
    );
    const rollChanged = force || exceedsWriteThreshold(
      rotation.z,
      this.#publishedVisualRotation.z,
      VISUAL_ROTATION_WRITE_THRESHOLD_DEGREES
    );
    if (!positionChanged && !pitchChanged && !yawChanged && !rollChanged) return writes;
    if (positionChanged) {
      this.#lastVisualX = visualAnchor.x;
      this.#lastVisualY = visualAnchor.y;
      this.#lastVisualZ = visualAnchor.z;
    }
    if (pitchChanged) {
      this.#publishedVisualRotation.x = rotation.x;
    }
    if (yawChanged) {
      this.#publishedVisualRotation.y = rotation.y;
    }
    if (rollChanged) {
      this.#publishedVisualRotation.z = rotation.z;
    }
    if (positionChanged) {
      for (const carrier of this.#carriers) {
        if (!carrier.entity.isValid) {
          this.#knownIntegrityFailure = true;
          continue;
        }
        carrier.entity.teleport(visualAnchor);
        writes++;
      }
    }
    for (const visual of this.#visualsByEntityId.values()) {
      const entity = visual.entity;
      if (!entity.isValid) {
        this.#knownIntegrityFailure = true;
        continue;
      }
      if (pitchChanged) entity.setProperty("treephysics:pitch", rotation.x);
      if (yawChanged) entity.setProperty("treephysics:yaw", rotation.y);
      if (rollChanged) entity.setProperty("treephysics:roll", rotation.z);
      if (pitchChanged || yawChanged || rollChanged) writes++;
    }
    if (pitchChanged || yawChanged || rollChanged) {
      for (const carrier of this.#carriers) {
        if (carrier.auxiliaryRiderIds.size === 0) continue;
        for (const rider of nativeRiders(carrier.entity)) {
          if (!carrier.auxiliaryRiderIds.has(rider.id)) continue;
          this.#syncAuxiliaryRotation(rider, rotation);
          writes++;
        }
      }
    }
    return writes;
  }

  #syncAuxiliaryRotation(entity: Entity, rotation = this.#visualRotation): void {
    if (!entity.isValid || !rotation) return;
    entity.setProperty("treephysics:pitch", rotation.x);
    entity.setProperty("treephysics:yaw", rotation.y);
    entity.setProperty("treephysics:roll", rotation.z);
  }

  #createCubeFragmentRenderer(
    blocks: readonly PhysicsContraptionBlock[]
  ): FragmentRenderer {
    if (!this.#spawnEntity) {
      throw new Error("Per-block visual assemblies require an entity factory for cube fragments.");
    }
    const fragments = packFragments(blocks);
    if (
      !fragments
      || fragments.some(fragment => fragment.entityTypeId !== CUBE_FRAGMENT_ENTITY_TYPE_ID)
    ) {
      throw new Error("Per-block Stage 2 supports only cube-block fragment visuals.");
    }
    return new FragmentRenderer(
      this.#body,
      fragments,
      this.#spawnEntity,
      this.#foliageTint,
      this.#onEntityRemoved,
      this.#visualAnchor,
      this.#onEntityAdded
    );
  }

  #createPersistentCarrier(): LiveBlockCarrier {
    if (!this.#spawnEntity) {
      throw new Error("Per-block storage requires an entity factory.");
    }
    const entity = this.#spawnEntity(
      FRAGMENT_CARRIER_ENTITY_TYPE_ID,
      this.#body.localPointToWorld(this.#visualAnchor)
    );
    if (!entity.getComponent("minecraft:rideable")) {
      if (entity.isValid) entity.remove();
      throw new Error("Per-block persistent fragment carrier does not expose minecraft:rideable.");
    }
    const carrier: LiveBlockCarrier = {
      auxiliaryRiderIds: new Set(),
      dedicatedToPersistentRiders: true,
      entity,
      pendingRiderIds: new Set(),
      persistentRiderIds: new Set(),
      riderIds: new Set()
    };
    this.#carriers.push(carrier);
    this.#onEntityAdded?.(entity.id);
    return carrier;
  }

  #releaseEmptyCubeFragmentRenderer(): void {
    if (!this.#cubeFragments || this.#cubeFragments.entityCount > 0) return;
    this.#cubeFragments.remove();
    this.#cubeFragments = undefined;
  }

  #removeEmptyCarrier(
    carrier: LiveBlockCarrier,
    removeDedicatedCarrier = false
  ): void {
    if (
      carrier.riderIds.size > 0
      || carrier.auxiliaryRiderIds.size > 0
      || carrier.persistentRiderIds.size > 0
      || (carrier.dedicatedToPersistentRiders && !removeDedicatedCarrier)
    ) return;
    const carrierIndex = this.#carriers.indexOf(carrier);
    if (carrierIndex >= 0) this.#carriers.splice(carrierIndex, 1);
    this.#onEntityRemoved?.(carrier.entity.id);
    if (carrier.entity.isValid) carrier.entity.remove();
  }
}

interface LiveBlockCarrier {
  auxiliaryRiderIds: Set<string>;
  dedicatedToPersistentRiders: boolean;
  entity: Entity;
  pendingRiderIds: Set<string>;
  persistentRiderIds: Set<string>;
  riderIds: Set<string>;
}

interface LiveBlock {
  blockKeys: Set<string>;
  entity: Entity;
}

interface LiveBlockAssignment {
  entity: Entity;
  slot: BlockSlot;
  visual: LiveBlock;
}
