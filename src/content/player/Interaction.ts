import {
  BlockTypes,
  EntitySwingSource,
  GameMode,
  InputButton,
  InputMode,
  system,
  world,
  type Entity,
  type EntityInventoryComponent,
  type ItemStack,
  type ItemUseBeforeEvent,
  type Player,
  type PlayerSwingStartAfterEvent,
  type Vector3
} from "@minecraft/server";
import {
  type PhysicsContraption,
  type PhysicsContraptionBlock,
  type PhysicsDimension,
  type PhysicsWorld
} from "@src/Physics";
import {
  getTreePhysicsPerformanceLevel,
  TREE_PHYSICS_PERFORMANCE_LOW
} from "@src/config/Settings";
import {
  ContraptionOutlineController,
  INTERACTION_REACH,
  BLOCK_CRACK_ENTITY_TYPE_ID,
  BLOCK_OUTLINE_ENTITY_TYPE_ID,
  WORLD_BLOCK_OCCLUSION_EPSILON,
  type ContraptionBlockBreakHandler,
  type ContraptionBlockMiningEffectHandler,
  type ContraptionBlockPlaceHandler,
  type ContraptionBlockPlacementEffectHandler,
  type ContraptionOutlineActionTarget,
  type ContraptionRaycastResult
} from "@src/content/contraption/interaction/OutlineController";
import { ActivePlayerRegistry } from "@src/service/ActivePlayerRegistry";
import {
  dot,
  normalizeFinite as normalize,
  subtract,
  vectorsEqual
} from "@src/utils/Vector3Math";
import {
  computeAngularDampingTorque,
  computeDragDistance,
  computeDragForce,
  computeStableAngularDampingTorque,
  computeStableDragForce,
  distance,
  DRAG_ANGULAR_DAMPING,
  DRAG_DAMPING,
  DRAG_MAX_FORCE_PER_AXIS,
  DRAG_STIFFNESS,
  DRAG_VALIDATION_REACH,
  getEffectiveInertiaByWorldAxis,
  getEffectiveMassByWorldAxis,
  isDragConstraintAtRest,
  isNegligibleVector,
  resolveDragItemUseAction
} from "@src/content/player/Drag";
import {
  applySableDownwardPunchMultiplier,
  computeTreePunchStrength,
  getContraptionUprightness,
  isPunchCooldownReady
} from "@src/content/player/Punch";
// Break/place gestures can emit the same action from adjacent ticks (native
// event plus deferred swing); treat a same-target repeat inside this window as
// one action.
const PLACE_ACTION_DEDUP_WINDOW_TICKS = 1;
const DRAG_ITEM_TYPE_ID = "minecraft:slime_ball";

interface DragSession {
  contraption: PhysicsContraption;
  dimensionId: string;
  grabDistance: number;
  itemTypeId: string;
  lastSampleTick: number;
  localGrabPoint: Vector3;
  player: Player;
  slot: number;
  targetPoint?: Vector3;
}

interface ContraptionRaycastCache {
  readonly contraptionRevision: number;
  readonly dimensionId: string;
  readonly direction: Vector3;
  /** Interaction rays traverse passable foliage; drag and punch rays do not. */
  readonly ignorePassableBlocks: boolean;
  readonly maximumDistance: number;
  readonly origin: Vector3;
  readonly result: ContraptionRaycastResult | undefined;
}

interface PendingPlaceAction {
  readonly itemTypeId: string;
  readonly originTick: number;
  readonly player: Player;
  readonly slot: number;
  readonly target: ContraptionOutlineActionTarget;
}

interface PendingTouchBreakAction {
  readonly itemTypeId?: string;
  readonly slot: number;
  readonly target: ContraptionOutlineActionTarget;
}

interface CompletedPlaceAction {
  readonly signature: string;
  readonly tick: number;
}

export type ContraptionEditAction = "break" | "place";

export interface ContraptionBlockInteractionHandler {
  canInteract(contraption: PhysicsContraption, block: PhysicsContraptionBlock): boolean;
  interact(player: Player, contraption: PhysicsContraption, block: PhysicsContraptionBlock): boolean;
  handleContraptionReplacement?(
    source: PhysicsContraption,
    replacements: readonly PhysicsContraption[]
  ): void;
  /** When false, every syncTarget call would be a no-op and may be skipped. */
  hasSyncTargets?(dimensionId?: string): boolean;
  releasePlayer?(playerId: string): void;
  syncTarget?(
    player: Player,
    contraption: PhysicsContraption | undefined,
    block: PhysicsContraptionBlock | undefined
  ): void;
  tick?(currentTick: number): void;
}

export class PlayerInteractionController {
  readonly #dimensionSubsteps = new Map<string, () => void>();
  readonly #drags = new Map<string, DragSession>();
  readonly #lastDragToggleTickByPlayer = new Map<string, number>();
  readonly #lastPlaceActionByPlayer = new Map<string, CompletedPlaceAction>();
  readonly #lastPunchTickByPlayer = new Map<string, number>();
  readonly #lastTouchBlockInteractionTickByPlayer = new Map<string, number>();
  readonly #pendingPlaceByPlayer = new Map<string, PendingPlaceAction>();
  readonly #pendingTouchBreakByPlayer = new Map<string, PendingTouchBreakAction>();
  readonly #raycastByPlayer = new Map<string, ContraptionRaycastCache>();
  readonly #standingChestGestureTickByPlayer = new Map<string, number>();
  readonly #players = new ActivePlayerRegistry();
  readonly #physicsWorld: PhysicsWorld;
  readonly #outlines: ContraptionOutlineController;
  #interactionHandler?: ContraptionBlockInteractionHandler;
  #started = false;

  constructor(physicsWorld: PhysicsWorld) {
    this.#physicsWorld = physicsWorld;
    this.#outlines = new ContraptionOutlineController(physicsWorld, this.#players);
  }

  tick(currentTick: number): void {
    this.#syncStandingInteractionTargets();
    this.#interactionHandler?.tick?.(currentTick);
    this.#outlines.tick(currentTick);
  }

  handleVisualEntityLoad(entity: Entity): void {
    this.#outlines.handleEntityLoad(entity);
  }

  isDraggingContraption(playerId: string, contraption: PhysicsContraption): boolean {
    return this.#drags.get(playerId)?.contraption === contraption;
  }

  setContraptionBreakHandler(handler: ContraptionBlockBreakHandler): void {
    this.#outlines.setBreakHandler(handler);
  }

  setContraptionMiningEffectHandler(handler: ContraptionBlockMiningEffectHandler): void {
    this.#outlines.setMiningEffectHandler(handler);
  }

  setContraptionPlaceHandler(handler: ContraptionBlockPlaceHandler): void {
    this.#outlines.setPlaceHandler(handler);
  }

  setContraptionPlacementEffectHandler(
    handler: ContraptionBlockPlacementEffectHandler
  ): void {
    this.#outlines.setPlacementEffectHandler(handler);
  }

  setContraptionInteractHandler(handler: ContraptionBlockInteractionHandler): void {
    this.#interactionHandler = handler;
    this.#outlines.setInteractionTargetSuppressor(
      (contraption, block) => handler.canInteract(contraption, block)
    );
  }

  handleContraptionReplacement(
    source: PhysicsContraption,
    replacements: readonly PhysicsContraption[]
  ): void {
    this.#interactionHandler?.handleContraptionReplacement?.(source, replacements);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#players.start();
    this.#outlines.start();
    world.beforeEvents.itemUse.subscribe(event => this.#handleItemUse(event));
    world.afterEvents.itemStartUse.subscribe(event => {
      const { itemStack, source } = event;
      if (source.inputInfo.lastInputModeUsed !== InputMode.Touch) return;
      const pending = this.#pendingTouchBreakByPlayer.get(source.id);
      if (
        pending
        && pending.slot === source.selectedSlotIndex
        && pending.itemTypeId === itemStack.typeId
      ) this.#pendingTouchBreakByPlayer.delete(source.id);
    });
    world.beforeEvents.playerBreakBlock.subscribe(event => {
      if (this.#outlines.isManagedInteractionTarget(event.dimension, event.block)) {
        event.cancel = true;
        return;
      }
      if (this.#outlines.captureActionTarget(event.player)) {
        event.cancel = true;
      }
    });
    world.beforeEvents.playerInteractWithBlock.subscribe(event => {
      const { itemStack, player } = event;
      const heldItemIsBlock = itemStack !== undefined
        && BlockTypes.get(itemStack.typeId) !== undefined;
      if (
        heldItemIsBlock
        && player.inputInfo.lastInputModeUsed === InputMode.KeyboardAndMouse
        && !player.isSneaking
        && this.#canInteract(player)
        && (
          this.#ownsStandingChestGesture(player)
          || this.#findStandingInteractionTarget(player) !== undefined
        )
      ) {
        event.cancel = true;
        this.#claimStandingChestGesture(player);
        return;
      }
      const target = this.#outlines.captureActionTarget(player);
      if (!target) return;
      if (heldItemIsBlock) event.cancel = true;
      if (player.inputInfo.lastInputModeUsed === InputMode.Touch) {
        // Every native block interaction is definitive non-mining evidence on
        // touch. Bedrock may mark rapid follow-up taps as repeated interaction
        // events, so retain the evidence even when isFirstEvent is false.
        this.#lastTouchBlockInteractionTickByPlayer.set(player.id, system.currentTick);
        this.#pendingTouchBreakByPlayer.delete(player.id);
      }
      if (!heldItemIsBlock || !itemStack) return;
      this.#queuePlaceAction(player, itemStack, target);
    });
    world.beforeEvents.entityHurt.subscribe(event => {
      if (this.#isContraptionVisualEntity(event.hurtEntity)) event.cancel = true;
    });
    world.afterEvents.playerSwingStart.subscribe(event => this.#handleSwing(event));
    world.afterEvents.playerHotbarSelectedSlotChange.subscribe(event => {
      this.#stopDrag(event.player.id);
      this.#clearEditActionState(event.player.id);
    });
    world.afterEvents.playerDimensionChange.subscribe(event => {
      this.#stopDrag(event.player.id);
      this.#raycastByPlayer.delete(event.player.id);
      this.#releasePlayerInteractionSession(event.player.id);
      this.#clearEditActionState(event.player.id);
      this.#outlines.clearPlayer(event.player.id, true);
    });
    world.afterEvents.playerButtonInput.subscribe(event => {
      if (event.button !== InputButton.Sneak || !event.player.isSneaking) return;
      this.#interactionHandler?.syncTarget?.(event.player, undefined, undefined);
      this.#outlines.markInteractionTargetDirty(event.player.id);
    }, { buttons: [InputButton.Sneak] });
    world.afterEvents.playerSpawn.subscribe(event => {
      this.#stopDrag(event.player.id);
      this.#raycastByPlayer.delete(event.player.id);
      this.#lastDragToggleTickByPlayer.delete(event.player.id);
      this.#lastPunchTickByPlayer.delete(event.player.id);
      this.#releasePlayerInteractionSession(event.player.id);
      this.#clearEditActionState(event.player.id);
      this.#outlines.clearPlayer(event.player.id, true);
    });
    world.afterEvents.entityDie.subscribe(event => {
      if (event.deadEntity.typeId !== "minecraft:player") return;
      this.#stopDrag(event.deadEntity.id);
      this.#raycastByPlayer.delete(event.deadEntity.id);
      this.#lastDragToggleTickByPlayer.delete(event.deadEntity.id);
      this.#lastPunchTickByPlayer.delete(event.deadEntity.id);
      this.#releasePlayerInteractionSession(event.deadEntity.id);
      this.#clearEditActionState(event.deadEntity.id);
      this.#outlines.clearPlayer(event.deadEntity.id, true);
    });
    world.beforeEvents.playerLeave.subscribe(event => {
      const playerId = event.player.id;
      this.#stopDrag(playerId);
      this.#raycastByPlayer.delete(playerId);
      this.#lastDragToggleTickByPlayer.delete(playerId);
      this.#lastPunchTickByPlayer.delete(playerId);
      this.#clearEditActionState(playerId);
      system.run(() => {
        this.#releasePlayerInteractionSession(playerId);
        this.#outlines.clearPlayer(playerId, true);
      });
    });
  }

  #handleItemUse(event: ItemUseBeforeEvent): void {
    const player = event.source;
    const heldItemIsSlimeBall = event.itemStack.typeId === DRAG_ITEM_TYPE_ID;
    if (
      !heldItemIsSlimeBall
      && !player.isSneaking
      && this.#canInteract(player)
      && this.#tryPlayerStandingInteraction(player)
    ) {
      this.#claimStandingChestGesture(player);
      return;
    }
    if (this.#lastDragToggleTickByPlayer.get(player.id) === system.currentTick) {
      event.cancel = true;
      return;
    }
    const current = this.#drags.get(player.id);
    if (resolveDragItemUseAction(current !== undefined, false) === "release") {
      event.cancel = true;
      this.#lastDragToggleTickByPlayer.set(player.id, system.currentTick);
      this.#stopDrag(player.id);
      return;
    }
    if (!this.#canInteract(player)) return;
    const inputMode = player.inputInfo.lastInputModeUsed;
    if (shouldPrioritizeFoodUse(player, event.itemStack, inputMode === InputMode.Touch)) return;
    if (!player.isSneaking && heldItemIsSlimeBall) {
      const dragTarget = this.#raycastPlayerAssemblies(player, INTERACTION_REACH);
      if (
        resolveDragItemUseAction(false, dragTarget !== undefined) !== "acquire"
        || !dragTarget
      ) return;
      event.cancel = true;
      this.#lastDragToggleTickByPlayer.set(player.id, system.currentTick);
      const drag: DragSession = {
        contraption: dragTarget.contraption,
        dimensionId: player.dimension.id,
        grabDistance: computeDragDistance(dragTarget.hit.distance),
        itemTypeId: event.itemStack.typeId,
        lastSampleTick: -1,
        localGrabPoint: { ...dragTarget.hit.localLocation },
        player,
        slot: player.selectedSlotIndex
      };
      this.#drags.set(player.id, drag);
      this.#ensureDimensionSubstep(dragTarget.contraption.body.dimension);
      dragTarget.contraption.body.wakeUp();
      return;
    }
    const target = this.#outlines.captureActionTarget(player);
    if (!target) return;
    if (inputMode === InputMode.Touch) {
      if (
        this.#pendingPlaceByPlayer.has(player.id)
        || this.#shouldSuppressTouchBreak(
          player.id,
          system.currentTick,
          system.currentTick
        )
      ) {
        event.cancel = true;
        return;
      }
      // Let the engine reveal sustained vanilla use through itemStartUse.
      // The deferred break remains pending only for a plain touch hold.
      this.#queueTouchBreakAction(player, event.itemStack, target);
      return;
    }
    // Desktop block placement is handled exclusively by playerInteractWithBlock.
  }

  #handleSwing(event: PlayerSwingStartAfterEvent): void {
    const { player, swingSource } = event;
    if (!this.#canInteract(player)) return;
    const itemStack = event.heldItemStack ?? this.#getSelectedItem(player);
    if (
      !player.isSneaking
      && (!itemStack || itemStack.typeId === DRAG_ITEM_TYPE_ID)
    ) {
      if (
        !itemStack
        && (swingSource === EntitySwingSource.Attack || swingSource === EntitySwingSource.Mine)
      ) {
        this.#applyAttackImpulse(player);
      }
      return;
    }
    this.#stopDrag(player.id);
    const pending = this.#pendingPlaceByPlayer.get(player.id);
    const pendingTouchBreak = this.#pendingTouchBreakByPlayer.get(player.id);
    const editAction = resolveContraptionEditAction(
      swingSource,
      pending !== undefined,
      player.inputInfo.lastInputModeUsed,
      pendingTouchBreak !== undefined,
      itemStack !== undefined && BlockTypes.get(itemStack.typeId) !== undefined
    );
    if (editAction === "break") {
      if (
        player.inputInfo.lastInputModeUsed === InputMode.Touch
        && swingSource === EntitySwingSource.Mine
        && pendingTouchBreak === undefined
      ) {
        const target = this.#outlines.captureActionTarget(player);
        if (!target) {
          this.#outlines.handleBreak(player, itemStack, target);
          return;
        }
        // A tap may report Mine on either side of its native block interaction.
        // Resolve it next tick so the interaction can cancel the pending action.
        this.#queueTouchBreakAction(player, itemStack, target);
        return;
      }
      if (pending) this.#pendingPlaceByPlayer.delete(player.id);
      if (pendingTouchBreak) this.#pendingTouchBreakByPlayer.delete(player.id);
      if (
        pendingTouchBreak
        && (
          pendingTouchBreak.slot !== player.selectedSlotIndex
          || pendingTouchBreak.itemTypeId !== itemStack?.typeId
        )
      ) return;
      const target = pendingTouchBreak?.target ?? this.#outlines.captureActionTarget(player);
      if (!target) {
        this.#outlines.handleBreak(player, itemStack, target);
        return;
      }
      this.#performBreakAction(player, itemStack, target);
      return;
    }
    if (editAction !== "place") return;

    if (pending) this.#pendingPlaceByPlayer.delete(player.id);
    if (pendingTouchBreak) this.#pendingTouchBreakByPlayer.delete(player.id);
    if (!itemStack || !BlockTypes.get(itemStack.typeId)) return;
    if (
      pending
      && (pending.slot !== player.selectedSlotIndex || pending.itemTypeId !== itemStack.typeId)
    ) return;
    const target = pending?.target ?? this.#outlines.captureActionTarget(player);
    if (!target) {
      this.#outlines.handlePlace(player, itemStack);
      return;
    }
    this.#performPlaceAction(
      player,
      itemStack,
      target,
      pending?.originTick ?? system.currentTick
    );
  }

  /** Touch itemUse marks a hold gesture; its deferred action can be superseded by the swing. */
  #queueTouchBreakAction(
    player: Player,
    itemStack: ItemStack | undefined,
    target: ContraptionOutlineActionTarget
  ): void {
    const originTick = system.currentTick;
    if (this.#shouldSuppressTouchBreak(
      player.id,
      originTick,
      originTick
    )) return;
    const pending: PendingTouchBreakAction = {
      itemTypeId: itemStack?.typeId,
      slot: player.selectedSlotIndex,
      target
    };
    this.#pendingTouchBreakByPlayer.set(player.id, pending);
    system.run(() => {
      if (this.#pendingTouchBreakByPlayer.get(player.id) !== pending) return;
      this.#pendingTouchBreakByPlayer.delete(player.id);
      if (this.#shouldSuppressTouchBreak(
        player.id,
        originTick,
        system.currentTick
      )) return;
      const selected = this.#getSelectedItem(player);
      if (
        player.selectedSlotIndex !== pending.slot
        || selected?.typeId !== pending.itemTypeId
      ) return;
      this.#performBreakAction(player, selected, pending.target);
    });
  }

  #performBreakAction(
    player: Player,
    itemStack: ItemStack | undefined,
    target: ContraptionOutlineActionTarget
  ): void {
    this.#outlines.handleBreak(player, itemStack, target);
  }

  #shouldSuppressTouchBreak(
    playerId: string,
    breakOriginTick: number,
    observationTick: number
  ): boolean {
    return shouldSuppressTouchBreak(
      this.#lastTouchBlockInteractionTickByPlayer.get(playerId),
      breakOriginTick,
      observationTick
    );
  }

  /** Touch placement resolves on the next tick; other input modes wait for Build. */
  #queuePlaceAction(
    player: Player,
    itemStack: ItemStack,
    target: ContraptionOutlineActionTarget
  ): void {
    const pending: PendingPlaceAction = {
      itemTypeId: itemStack.typeId,
      originTick: system.currentTick,
      player,
      slot: player.selectedSlotIndex,
      target
    };
    this.#pendingPlaceByPlayer.set(player.id, pending);
    if (player.inputInfo.lastInputModeUsed !== InputMode.Touch) return;
    system.run(() => {
      if (this.#pendingPlaceByPlayer.get(player.id) !== pending) return;
      this.#pendingPlaceByPlayer.delete(player.id);
      const selected = this.#getSelectedItem(player);
      if (
        player.selectedSlotIndex !== pending.slot
        || selected?.typeId !== pending.itemTypeId
      ) return;
      this.#performPlaceAction(player, selected, pending.target, pending.originTick);
    });
  }

  #performPlaceAction(
    player: Player,
    itemStack: ItemStack,
    target: ContraptionOutlineActionTarget,
    originTick: number
  ): void {
    if (!this.#claimPlaceAction(player.id, target, originTick)) return;
    this.#outlines.handlePlace(player, itemStack, target);
  }

  #claimPlaceAction(
    playerId: string,
    target: ContraptionOutlineActionTarget,
    tick: number
  ): boolean {
    const signature = `${target.contraptionId}:${target.blockKey}:${target.face}`;
    const previous = this.#lastPlaceActionByPlayer.get(playerId);
    if (
      previous?.signature === signature
      && Math.abs(tick - previous.tick) <= PLACE_ACTION_DEDUP_WINDOW_TICKS
    ) return false;
    this.#lastPlaceActionByPlayer.set(playerId, { signature, tick });
    return true;
  }

  #clearEditActionState(playerId: string): void {
    this.#pendingPlaceByPlayer.delete(playerId);
    this.#pendingTouchBreakByPlayer.delete(playerId);
    this.#lastPlaceActionByPlayer.delete(playerId);
    this.#lastTouchBlockInteractionTickByPlayer.delete(playerId);
    this.#standingChestGestureTickByPlayer.delete(playerId);
  }

  #isContraptionVisualEntity(entity: Entity): boolean {
    if (entity.typeId === BLOCK_OUTLINE_ENTITY_TYPE_ID
      || entity.typeId === BLOCK_CRACK_ENTITY_TYPE_ID) return true;
    return this.#physicsWorld
      .getExistingDimension(entity.dimension)
      ?.getContraptionByVisualEntityId(entity.id) !== undefined;
  }

  #tickDrag(drag: DragSession): boolean {
    if (drag.lastSampleTick !== system.currentTick) {
      drag.lastSampleTick = system.currentTick;
      drag.targetPoint = this.#sampleDragTarget(drag);
    }
    const targetPoint = drag.targetPoint;
    if (!targetPoint) return false;
    const grabPoint = drag.contraption.body.localPointToWorld(drag.localGrabPoint);
    if (distance(targetPoint, grabPoint) > DRAG_VALIDATION_REACH) return false;
    const pointVelocity = drag.contraption.body.getVelocityAt(grabPoint);
    const angularVelocity = drag.contraption.body.getAngularVelocity();
    if (isDragConstraintAtRest({
      angularVelocity,
      grabPoint,
      pointVelocity,
      targetPoint
    })) return true;

    let force: Vector3;
    let torque: Vector3;
    if (getTreePhysicsPerformanceLevel() === TREE_PHYSICS_PERFORMANCE_LOW) {
      const timeStep = drag.contraption.body.dimension.fixedTimeStep;
      force = computeStableDragForce({
        damping: DRAG_DAMPING,
        effectiveMass: getEffectiveMassByWorldAxis(drag.contraption.body, grabPoint),
        grabPoint,
        maxForcePerAxis: DRAG_MAX_FORCE_PER_AXIS,
        pointVelocity,
        stiffness: DRAG_STIFFNESS,
        targetPoint,
        timeStep
      });
      torque = computeStableAngularDampingTorque({
        angularVelocity,
        damping: DRAG_ANGULAR_DAMPING,
        effectiveInertia: getEffectiveInertiaByWorldAxis(drag.contraption.body),
        maxTorquePerAxis: DRAG_MAX_FORCE_PER_AXIS,
        timeStep
      });
    } else {
      force = computeDragForce({
        damping: DRAG_DAMPING,
        grabPoint,
        maxForcePerAxis: DRAG_MAX_FORCE_PER_AXIS,
        pointVelocity,
        stiffness: DRAG_STIFFNESS,
        targetPoint
      });
      torque = computeAngularDampingTorque({
        angularVelocity,
        damping: DRAG_ANGULAR_DAMPING,
        maxTorquePerAxis: DRAG_MAX_FORCE_PER_AXIS
      });
    }
    if (!isNegligibleVector(force)) drag.contraption.body.applyForceAt(grabPoint, force);
    if (!isNegligibleVector(torque)) drag.contraption.body.applyTorque(torque);
    return true;
  }

  #sampleDragTarget(drag: DragSession): Vector3 | undefined {
    const { player } = drag;
    if (
      !drag.contraption.isValid
      || !this.#canInteract(player)
      || player.isSneaking
      || player.dimension.id !== drag.dimensionId
      || player.selectedSlotIndex !== drag.slot
      || this.#getSelectedItem(player)?.typeId !== drag.itemTypeId
    ) return undefined;

    try {
      const origin = player.getHeadLocation();
      const direction = normalize(player.getViewDirection());
      const grabPoint = drag.contraption.body.localPointToWorld(drag.localGrabPoint);
      if (distance(origin, grabPoint) > DRAG_VALIDATION_REACH) return undefined;
      const targetPoint = {
        x: origin.x + direction.x * drag.grabDistance,
        y: origin.y + direction.y * drag.grabDistance,
        z: origin.z + direction.z * drag.grabDistance
      };
      return distance(targetPoint, grabPoint) <= DRAG_VALIDATION_REACH
        ? targetPoint
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Interactable blocks consume the gesture before impulse or dragging. */
  #tryPlayerStandingInteraction(player: Player): boolean {
    const handler = this.#interactionHandler;
    const target = this.#findStandingInteractionTarget(player);
    if (!target || !handler) return false;
    if (!handler.interact(player, target.contraption, target.hit.block)) return false;
    this.#stopDrag(player.id);
    return true;
  }

  #findStandingInteractionTarget(player: Player): ContraptionRaycastResult | undefined {
    const handler = this.#interactionHandler;
    if (handler?.hasSyncTargets && !handler.hasSyncTargets(player.dimension.id)) return undefined;
    // Interaction aims through passable foliage: a chest behind leaves should
    // respond to the same crosshair that the drag gesture resolves to a leaf.
    const target = this.#raycastPlayerAssemblies(player, INTERACTION_REACH, true);
    if (!target || !handler?.canInteract(target.contraption, target.hit.block)) return undefined;
    return target;
  }

  #claimStandingChestGesture(player: Player): void {
    if (
      player.inputInfo.lastInputModeUsed !== InputMode.KeyboardAndMouse
      || player.isSneaking
    ) return;
    this.#standingChestGestureTickByPlayer.set(player.id, system.currentTick);
    // A block interaction can arrive before or after itemUse. In either order,
    // a chest-owned gesture must not leave a placement that a later Build swing
    // could commit.
    this.#pendingPlaceByPlayer.delete(player.id);
  }

  #ownsStandingChestGesture(player: Player): boolean {
    const tick = this.#standingChestGestureTickByPlayer.get(player.id);
    if (tick === system.currentTick) return true;
    if (tick !== undefined) this.#standingChestGestureTickByPlayer.delete(player.id);
    return false;
  }

  /** Keep native container entities ready before a standing player interacts. */
  #syncStandingInteractionTargets(): void {
    const handler = this.#interactionHandler;
    if (!handler?.syncTarget) return;
    // Without any live storage the per-player raycasts below feed only no-op
    // syncTarget calls, so the whole pass can be skipped.
    if (handler.hasSyncTargets && !handler.hasSyncTargets()) return;
    for (const player of this.#players.players()) {
      if (handler.hasSyncTargets && !handler.hasSyncTargets(player.dimension.id)) {
        // A player can carry a preview into a dimension with no storage. Keep
        // the release call while avoiding a raycast that cannot find a target.
        handler.syncTarget(player, undefined, undefined);
        continue;
      }
      if (!this.#canInteract(player) || player.isSneaking) {
        handler.syncTarget(player, undefined, undefined);
        continue;
      }
      if (this.#getSelectedItem(player)?.typeId === DRAG_ITEM_TYPE_ID) {
        handler.syncTarget(player, undefined, undefined);
        continue;
      }
      const target = this.#raycastPlayerAssemblies(player, INTERACTION_REACH, true);
      if (!target || !handler.canInteract(target.contraption, target.hit.block)) {
        handler.syncTarget(player, undefined, undefined);
        continue;
      }
      handler.syncTarget(player, target.contraption, target.hit.block);
    }
  }

  #releasePlayerInteractionSession(playerId: string): void {
    this.#interactionHandler?.releasePlayer?.(playerId);
  }

  #applyAttackImpulse(player: Player): void {
    if (!this.#canInteract(player)) return;
    const previousTick = this.#lastPunchTickByPlayer.get(player.id);
    if (!isPunchCooldownReady(previousTick, system.currentTick)) {
      return;
    }
    const target = this.#raycastPlayerAssemblies(player, INTERACTION_REACH);
    if (!target) return;

    const direction = applySableDownwardPunchMultiplier(target.direction);
    const effectiveMass = target.contraption.body.getEffectiveMassAt(target.hit.location, direction);
    const magnitude = computeTreePunchStrength(
      effectiveMass,
      getContraptionUprightness(target.contraption)
    );
    if (!Number.isFinite(magnitude) || magnitude <= 0) return;

    this.#lastPunchTickByPlayer.set(player.id, system.currentTick);
    target.contraption.body.applyImpulseAt(target.hit.location, {
      x: direction.x * magnitude,
      y: direction.y * magnitude,
      z: direction.z * magnitude
    });
  }

  #raycastPlayerAssemblies(
    player: Player,
    maximumDistance: number,
    ignorePassableBlocks = false
  ): ContraptionRaycastResult | undefined {
    const dimension = this.#physicsWorld.getExistingDimension(player.dimension);
    // Without assemblies the ray can never hit; skip the native player reads.
    if (!dimension || !dimension.hasAssemblies()) return undefined;
    let origin: Vector3;
    let direction: Vector3;
    try {
      origin = player.getHeadLocation();
      direction = normalize(player.getViewDirection());
    } catch {
      return undefined;
    }
    const contraptionRevision = dimension.contraptionRaycastRevision;
    const cached = this.#raycastByPlayer.get(player.id);
    if (
      cached?.dimensionId === player.dimension.id
      && cached.contraptionRevision === contraptionRevision
      && cached.maximumDistance === maximumDistance
      && cached.ignorePassableBlocks === ignorePassableBlocks
      && vectorsEqual(cached.origin, origin)
      && vectorsEqual(cached.direction, direction)
    ) return cached.result;

    let closest: ContraptionRaycastResult | undefined;
    for (const contraption of dimension.getContraptionRaycastCandidates(
      origin,
      direction,
      maximumDistance
    )) {
      if (!contraption.isValid) continue;
      const hit = contraption.raycast(origin, direction, maximumDistance, { ignorePassableBlocks });
      if (!hit || (closest && hit.distance >= closest.hit.distance)) continue;
      closest = { contraption, direction, hit, origin };
    }
    if (
      !closest
      || this.#isWorldBlockBefore(player, origin, direction, closest.hit.distance)
    ) closest = undefined;
    this.#raycastByPlayer.set(player.id, {
      contraptionRevision,
      dimensionId: player.dimension.id,
      direction,
      ignorePassableBlocks,
      maximumDistance,
      origin,
      result: closest
    });
    return closest;
  }

  #isWorldBlockBefore(
    player: Player,
    origin: Vector3,
    direction: Vector3,
    distanceToContraption: number
  ): boolean {
    try {
      const hit = player.getBlockFromViewDirection({
        includeLiquidBlocks: false,
        includePassableBlocks: false,
        maxDistance: DRAG_VALIDATION_REACH
      });
      if (!hit) return false;
      const point = {
        x: hit.block.location.x + hit.faceLocation.x,
        y: hit.block.location.y + hit.faceLocation.y,
        z: hit.block.location.z + hit.faceLocation.z
      };
      const blockDistance = dot(subtract(point, origin), direction);
      return blockDistance >= 0
        && blockDistance + WORLD_BLOCK_OCCLUSION_EPSILON < distanceToContraption;
    } catch {
      return false;
    }
  }

  #canInteract(player: Player): boolean {
    try {
      return player.isValid && player.getGameMode() !== GameMode.Spectator;
    } catch {
      return false;
    }
  }

  #getSelectedItem(player: Player): ItemStack | undefined {
    try {
      return getInventory(player)?.container.getItem(player.selectedSlotIndex);
    } catch {
      return undefined;
    }
  }

  #stopDrag(playerId: string): void {
    const drag = this.#drags.get(playerId);
    if (!drag) return;
    this.#drags.delete(playerId);
    for (const value of this.#drags.values()) {
      if (value.dimensionId === drag.dimensionId) return;
    }
    this.#dimensionSubsteps.get(drag.dimensionId)?.();
    this.#dimensionSubsteps.delete(drag.dimensionId);
  }

  #ensureDimensionSubstep(dimension: PhysicsDimension): void {
    if (this.#dimensionSubsteps.has(dimension.id)) return;
    const stop = dimension.addBeforeSubstepCallback(() => {
      for (const [playerId, drag] of this.#drags) {
        if (drag.dimensionId !== dimension.id) continue;
        if (!this.#tickDrag(drag)) this.#stopDrag(playerId);
      }
    });
    this.#dimensionSubsteps.set(dimension.id, stop);
  }
}

export function resolveContraptionEditAction(
  swingSource: EntitySwingSource,
  hasPendingPlace: boolean,
  inputMode: InputMode,
  hasTouchItemUse = false,
  heldItemIsBlock = false
): ContraptionEditAction | undefined {
  // On touch, itemUse marks a hold while native block interaction identifies a tap.
  if (inputMode === InputMode.Touch) {
    // A cancellable native block interaction is stronger than every swing or
    // item-use signal emitted by the same gesture.
    if (hasPendingPlace) return "place";
    // A hold is resolved on the next tick so itemStartUse can preserve food
    // and other sustained vanilla item actions before the break is committed.
    if (hasTouchItemUse) return undefined;
    if (swingSource === EntitySwingSource.Mine) return "break";
    return undefined;
  }
  // A cancellable native use event is stronger evidence of placement than the
  // accompanying generic swing. On keyboard and mouse, the native block
  // interaction is therefore required before a Build swing can place.
  if (hasPendingPlace && swingSource === EntitySwingSource.Build) return "place";
  return swingSource === EntitySwingSource.Attack
    || swingSource === EntitySwingSource.Mine
    ? "break"
    : undefined;
}

/** A touch break signal adjacent to a native block interaction belongs to that interaction. */
export function shouldSuppressTouchBreak(
  touchTapTick: number | undefined,
  breakOriginTick: number,
  observationTick: number
): boolean {
  if (touchTapTick === undefined) return false;
  return touchTapTick >= breakOriginTick - 1
    && touchTapTick <= observationTick;
}

export function canEatFoodNow(
  canAlwaysEat: boolean,
  currentHunger: number,
  maximumHunger: number
): boolean {
  return canAlwaysEat || currentHunger < maximumHunger;
}

/** May throw on an invalid player; the only caller (#getSelectedItem) catches. */
function getInventory(player: Player): EntityInventoryComponent | undefined {
  return player.getComponent("minecraft:inventory") as EntityInventoryComponent | undefined;
}

function shouldPrioritizeFoodUse(
  player: Player,
  itemStack: ItemStack,
  includeVanillaFoodTag = false
): boolean {
  const food = itemStack.getComponent("minecraft:food");
  if (!food && !(includeVanillaFoodTag && itemStack.hasTag("minecraft:is_food"))) return false;
  const hunger = player.getComponent("minecraft:player.hunger");
  if (!hunger) throw new Error(`Player ${player.id} has no hunger component.`);
  return canEatFoodNow(food?.canAlwaysEat ?? false, hunger.currentValue, hunger.effectiveMax);
}
