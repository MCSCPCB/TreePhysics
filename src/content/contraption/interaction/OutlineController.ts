import {
  BlockTypes,
  GameMode,
  InputMode,
  system,
  world,
  type Block,
  type Container,
  type Dimension,
  type Entity,
  type ItemStack,
  type Player,
  type Vector3
} from "@minecraft/server";
import {
  type PhysicsContraption,
  type PhysicsContraptionBlock,
  type PhysicsContraptionRaycastHit,
  type PhysicsDimension,
  type PhysicsWorld
} from "@src/Physics";
import {
  CONTRAPTION_OUTLINE_EDGE_CAPACITY,
  createAabbOutline,
  createContraptionOutlineShapeFromTopology,
  createContraptionOutlineTopology,
  type ContraptionOutlineEdge,
  type ContraptionOutlineTopology
} from "@src/render/outline/Geometry";
import type { ActivePlayerRegistry } from "@src/service/ActivePlayerRegistry";
import { blockKey } from "@src/utils/BlockKey";
import { playerEditableContraptionBlockKind } from "@src/content/tree/block/Blocks";
import {
  PLAYER_EDIT_MINING_RESET_TICKS,
  MiningProgress
} from "@src/content/tree/felling/MiningProgress";
import { getTreeMiningTargetTicks } from "@src/content/tree/felling/MiningTime";
import { InteractionTargetBlockController } from "@src/content/contraption/interaction/TargetBlock";
import {
  normalizeFinite as normalize,
  dot,
  squaredDistance,
  subtract
} from "@src/utils/Vector3Math";
import {
  canPlayerBreakContraptionBlock,
  canPlayerPlaceContraptionBlock,
  damageSelectedToolForContraptionBreak
} from "@src/content/contraption/editing/Permissions";
import {
  breakOverlayLocation,
  createBlockPreviewTransform,
  createEdgeWriteExpression,
  edgeSignature,
  hasViewDirectionChanged,
  isPlayerHeadInsideContraptionPlacement,
  resolvePlacementCardinalDirection,
  shouldEnterBlockPreview,
  shouldRefreshOutlineRay,
  vectorComponentsEqual,
  BREAK_OVERLAY_TRANSFORM_EPSILON_SQUARED,
  RAY_REFRESH_TICKS
} from "@src/render/outline/Molang";
import { VANILLA_DIMENSION_IDS } from "@src/utils/WorldBlock";

export const BLOCK_OUTLINE_ENTITY_TYPE_ID = "treephysics:block_outline";
export const BLOCK_CRACK_ENTITY_TYPE_ID = "treephysics:block_crack";

// Per-player property overrides and per-entity properties consumed by the
// outline/break client entities (the namespace is rewritten by the build).
const OUTLINE_VISIBLE_PROPERTY = "treephysics:visible";
const OUTLINE_BLOCK_PREVIEW_PROPERTY = "treephysics:block_preview";
const OUTLINE_PREVIEW_X_PROPERTY = "treephysics:preview_x";
const OUTLINE_PREVIEW_Y_PROPERTY = "treephysics:preview_y";
const OUTLINE_PREVIEW_Z_PROPERTY = "treephysics:preview_z";
const OUTLINE_PREVIEW_SIDE_PROPERTY = "treephysics:preview_side";
const BREAK_OVERLAY_PITCH_PROPERTY = "treephysics:pitch";
const BREAK_OVERLAY_YAW_PROPERTY = "treephysics:yaw";
const BREAK_OVERLAY_ROLL_PROPERTY = "treephysics:roll";
const BREAK_OVERLAY_STAGE_PROPERTY = "treephysics:break_stage";

/** Shared with the drag/punch raycasts so both resolve the same crosshair. */
export const INTERACTION_REACH = 5;
/** Minimum margin by which a world block must precede an contraption hit to occlude it. */
export const WORLD_BLOCK_OCCLUSION_EPSILON = 0.05;
const OUTLINE_FADE_TICKS = 5;
const INITIAL_OUTLINE_REVEAL_DELAY_TICKS = 4;
/** The client entity needs this long after spawning before it accepts property writes. */
const OUTLINE_ENTITY_READY_DELAY_TICKS = 2;
const BREAK_OVERLAY_INITIAL_POSE_DELAY_TICKS = 1;
const OUTLINE_TRANSFORM_ANIMATION =
  "animation.treephysics.block_outline.write_edges";

export interface ContraptionRaycastResult {
  readonly contraption: PhysicsContraption;
  readonly direction: Vector3;
  readonly hit: PhysicsContraptionRaycastHit;
  readonly origin: Vector3;
}

interface RayCache {
  readonly contraptionRevision: number;
  readonly result?: ContraptionRaycastResult;
  readonly tick: number;
}
interface PlayerOutlineState {
  activeContraptionId?: number;
  candidateBlockKey?: string;
  candidateSinceTick?: number;
  interactionTargetDirty?: boolean;
  lastDirection?: Vector3;
  lastOrigin?: Vector3;
  lastRayTick: number;
  mode?: "contraption" | "block";
  rayCache?: RayCache;
  shapeSignature?: string;
}

interface OutlineViewer {
  fadeEndTick?: number;
  revealTick: number;
  revealed: boolean;
}

interface SharedOutlineShape {
  readonly edges: readonly ContraptionOutlineEdge[];
  /** Full write signature cached with the edges so unchanged frames compare one string. */
  readonly signature: string;
}

interface SharedOutlineRecord {
  readonly contraption: PhysicsContraption;
  readonly entity: Entity;
  readonly viewers: Map<string, OutlineViewer>;
  contentRevision: number;
  outlineTopology?: ContraptionOutlineTopology;
  readyTick: number;
  shapeCache: Map<string, SharedOutlineShape>;
}

interface SharedBreakOverlayRecord {
  readonly contraption: PhysicsContraption;
  readonly entity: Entity;
  readonly key: string;
  readonly localLocation: Vector3;
  lastLocation: Vector3;
  lastProgressTick: number;
  lastRotation?: Vector3;
  publishedStage?: number;
  readonly readyTick: number;
  targetStage: number;
}

export interface ContraptionOutlineActionTarget {
  readonly contraptionId: number;
  readonly blockKey: string;
  readonly face: PhysicsContraptionRaycastHit["face"];
}

export type ContraptionBlockBreakHandler = (
  player: Player,
  itemStack: ItemStack | undefined,
  contraption: PhysicsContraption,
  block: PhysicsContraptionBlock
) => boolean;

export type ContraptionBlockMiningEffectHandler = (
  contraption: PhysicsContraption,
  block: PhysicsContraptionBlock
) => void;

export type ContraptionBlockPlaceHandler = (
  player: Player,
  itemStack: ItemStack,
  contraption: PhysicsContraption,
  block: PhysicsContraptionBlock,
  placement: Vector3,
  cardinalDirection: "north" | "east" | "south" | "west"
) => boolean;

export type ContraptionBlockPlacementEffectHandler = (
  contraption: PhysicsContraption,
  block: PhysicsContraptionBlock
) => void;

type InteractionTargetSuppressor = (
  contraption: PhysicsContraption,
  block: PhysicsContraptionBlock
) => boolean;

export interface BlockPreviewTransform {
  readonly side: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Maintains private outlines and world-visible mining overlays for fragment assemblies. */
export class ContraptionOutlineController {
  readonly #players: ActivePlayerRegistry;
  readonly #physicsWorld: PhysicsWorld;
  readonly #records = new Map<number, SharedOutlineRecord>();
  readonly #breakOverlays = new Map<string, SharedBreakOverlayRecord>();
  readonly #states = new Map<string, PlayerOutlineState>();
  readonly #interactionTargets = new InteractionTargetBlockController();
  readonly #trackedEntityIds = new Set<string>();
  readonly #miningProgress = new MiningProgress();
  #startupCleanupComplete = false;
  #startupCleanupScheduled = false;
  #breakHandler?: ContraptionBlockBreakHandler;
  #miningEffectHandler?: ContraptionBlockMiningEffectHandler;
  #placeHandler?: ContraptionBlockPlaceHandler;
  #placementEffectHandler?: ContraptionBlockPlacementEffectHandler;
  #interactionTargetSuppressor?: InteractionTargetSuppressor;

  constructor(physicsWorld: PhysicsWorld, players: ActivePlayerRegistry) {
    this.#physicsWorld = physicsWorld;
    this.#players = players;
  }

  setBreakHandler(handler: ContraptionBlockBreakHandler | undefined): void {
    this.#breakHandler = handler;
  }

  setMiningEffectHandler(handler: ContraptionBlockMiningEffectHandler | undefined): void {
    this.#miningEffectHandler = handler;
  }

  setPlaceHandler(handler: ContraptionBlockPlaceHandler | undefined): void {
    this.#placeHandler = handler;
  }

  setPlacementEffectHandler(
    handler: ContraptionBlockPlacementEffectHandler | undefined
  ): void {
    this.#placementEffectHandler = handler;
  }

  setInteractionTargetSuppressor(suppressor: InteractionTargetSuppressor | undefined): void {
    this.#interactionTargetSuppressor = suppressor;
  }

  markInteractionTargetDirty(playerId: string): void {
    const state = this.#states.get(playerId);
    if (state) state.interactionTargetDirty = true;
  }

  start(): void {
    if (this.#startupCleanupScheduled) return;
    this.#startupCleanupScheduled = true;
    this.#interactionTargets.start();
    // Dimension queries are unavailable during early execution. No managed
    // outline or break entity may spawn until reload cleanup completes.
    system.run(() => {
      for (const dimensionId of VANILLA_DIMENSION_IDS) {
        const dimension = world.getDimension(dimensionId);
        for (const typeId of [
          BLOCK_OUTLINE_ENTITY_TYPE_ID,
          BLOCK_CRACK_ENTITY_TYPE_ID
        ]) {
          for (const entity of dimension.getEntities({ type: typeId })) {
            if (entity.isValid) entity.remove();
          }
        }
      }
      this.#startupCleanupComplete = true;
    });
  }

  tick(currentTick: number): void {
    if (!this.#startupCleanupComplete) return;
    this.#miningProgress.prune(currentTick);
    this.#tickBreakOverlays(currentTick);
    for (const player of this.#players.sneakingPlayers()) this.#tickPlayer(player, currentTick);
    for (const playerId of this.#states.keys()) {
      if (this.#players.hasSneakingPlayer(playerId)) continue;
      const player = this.#players.get(playerId);
      if (player) this.#tickPlayer(player, currentTick);
      else this.clearPlayer(playerId, false);
    }
    this.#finishFades(currentTick);
  }

  captureActionTarget(player: Player): ContraptionOutlineActionTarget | undefined {
    if (!this.#startupCleanupComplete) return undefined;
    const result = this.#raycastForEvent(player);
    return result ? actionTargetFromResult(result) : undefined;
  }

  isManagedInteractionTarget(dimension: Dimension, block: Block): boolean {
    return this.#interactionTargets.isManagedBlock(dimension, block);
  }

  handleBreak(
    player: Player,
    itemStack: ItemStack | undefined,
    expected?: ContraptionOutlineActionTarget
  ): void {
    if (!this.#startupCleanupComplete) return;
    const result = this.#validatedActionResult(player, expected);
    if (!result) return;
    if (!canPlayerBreakContraptionBlock(player, itemStack, result.hit.block.typeId)) return;
    const kind = playerEditableContraptionBlockKind(result.hit.block.typeId);
    if (kind === undefined) return;
    const targetKey = blockKey(result.hit.block.localLocation);
    const progress = this.#miningProgress.advance(
      `${result.contraption.id}|${targetKey}`,
      system.currentTick,
      getTreeMiningTargetTicks(kind, result.hit.block.typeId, itemStack),
      player.inputInfo.lastInputModeUsed === InputMode.Touch
        ? { playerId: player.id, type: "touch" }
        : { type: "attack" }
    );
    if (!progress) return;
    if (!progress.completed) {
      this.#setSharedMiningStage(result.contraption, result.hit.block, progress.stage);
    }
    if (!progress.completed && progress.stageChanged) {
      if (!this.#miningEffectHandler) {
        throw new Error("Contraption block mining effect handler is not configured.");
      }
      this.#miningEffectHandler(result.contraption, result.hit.block);
    }
    if (!progress.completed) return;
    this.#clearSharedMiningStage(result.contraption.id, targetKey);
    if (!this.#breakHandler) {
      throw new Error("Contraption block break handler is not configured.");
    }
    if (this.#breakHandler(player, itemStack, result.contraption, result.hit.block)) {
      damageSelectedToolForContraptionBreak(player, itemStack);
      this.#miningProgress.clearContraption(result.contraption.id);
      this.#clearContraptionBreakOverlays(result.contraption.id);
    }
  }

  handlePlace(
    player: Player,
    itemStack: ItemStack,
    expected?: ContraptionOutlineActionTarget
  ): void {
    if (!this.#startupCleanupComplete || !BlockTypes.get(itemStack.typeId)) return;
    const result = this.#validatedActionResult(player, expected);
    if (!result) return;
    if (!canPlayerPlaceContraptionBlock(player, itemStack, result.hit.block.typeId)) return;
    if (!result.contraption.supportsFragmentBlockPlacement) return;
    const placement = this.#getPlacementTarget(result, itemStack);
    if (!placement) return;
    if (isPlayerHeadInsideContraptionPlacement(
      player.getHeadLocation(),
      placement,
      point => result.contraption.body.worldPointToLocal(point)
    )) return;
    if (!this.#placeHandler) {
      throw new Error("Contraption block place handler is not configured.");
    }
    const cardinalDirection = resolvePlacementCardinalDirection(
      result.contraption,
      result.origin,
      result.direction
    );
    const consumed = consumeSelectedBlock(player, itemStack);
    let placed: boolean;
    try {
      placed = this.#placeHandler(
        player,
        itemStack,
        result.contraption,
        result.hit.block,
        placement,
        cardinalDirection
      );
    } catch (error) {
      restoreSelectedBlock(player, consumed);
      throw error;
    }
    if (!placed) {
      restoreSelectedBlock(player, consumed);
      return;
    }
    const placedBlock = result.contraption.getBlockAtLocalLocation(placement);
    if (!placedBlock || placedBlock.typeId !== itemStack.typeId) {
      throw new Error(`Placed contraption block ${itemStack.typeId} is unavailable for effects.`);
    }
    if (!this.#placementEffectHandler) {
      throw new Error("Contraption block placement effect handler is not configured.");
    }
    this.#placementEffectHandler(result.contraption, placedBlock);
  }

  clearPlayer(playerId: string, immediate: boolean): void {
    this.#miningProgress.clearPlayer(playerId);
    const state = this.#states.get(playerId);
    if (state) this.#clearInteractionTargets(playerId);
    if (state?.activeContraptionId !== undefined) {
      this.#releaseViewer(playerId, state.activeContraptionId, immediate);
    }
    this.#states.delete(playerId);
  }

  /** Remove outline entities left by a script reload, while retaining entities created this tick. */
  handleEntityLoad(entity: Entity): void {
    if (entity.typeId !== BLOCK_OUTLINE_ENTITY_TYPE_ID
      && entity.typeId !== BLOCK_CRACK_ENTITY_TYPE_ID) return;
    system.run(() => {
      if (entity.isValid && !this.#trackedEntityIds.has(entity.id)) entity.remove();
    });
  }

  #tickPlayer(player: Player, currentTick: number): void {
    if (!this.#canPreview(player)) {
      this.clearPlayer(player.id, false);
      return;
    }
    const sneaking = player.isSneaking;
    const state = this.#states.get(player.id) ?? {
      lastRayTick: currentTick - RAY_REFRESH_TICKS
    };
    this.#states.set(player.id, state);

    let direction: Vector3;
    let origin: Vector3;
    try {
      direction = normalize(player.getViewDirection());
      origin = player.getHeadLocation();
    } catch {
      this.clearPlayer(player.id, true);
      return;
    }
    const viewChanged = (
      state.lastDirection !== undefined
      && hasViewDirectionChanged(state.lastDirection, direction)
    ) || (state.lastOrigin !== undefined && !vectorComponentsEqual(state.lastOrigin, origin));
    state.lastDirection = direction;
    state.lastOrigin = origin;
    const dimension = this.#physicsWorld.getExistingDimension(player.dimension);
    const contraptionMoving = state.rayCache?.result?.contraption.body.isActive === true
      || state.rayCache?.contraptionRevision !== contraptionRevisionOf(dimension);
    const refresh = shouldRefreshOutlineRay(
      state.mode,
      currentTick - state.lastRayTick,
      viewChanged,
      contraptionMoving
    );
    if (refresh) {
      state.rayCache = {
        contraptionRevision: contraptionRevisionOf(dimension),
        result: this.#raycastPlayerAssemblies(player, origin, direction),
        tick: currentTick
      };
      state.lastRayTick = currentTick;
    }
    const result = state.rayCache?.result;
    if (!result) {
      if (!sneaking) {
        this.clearPlayer(player.id, false);
        return;
      }
      this.#clearInteractionTargets(player.id);
      if (state.activeContraptionId !== undefined) {
        this.#releaseViewer(player.id, state.activeContraptionId, false);
      }
      state.activeContraptionId = undefined;
      state.mode = undefined;
      state.shapeSignature = undefined;
      return;
    }

    this.#syncInteractionTargets(player, result, refresh || state.interactionTargetDirty === true);
    state.interactionTargetDirty = false;
    if (!sneaking) {
      if (state.activeContraptionId !== undefined) {
        this.#releaseViewer(player.id, state.activeContraptionId, false);
      }
      state.activeContraptionId = undefined;
      state.mode = undefined;
      state.shapeSignature = undefined;
      return;
    }

    const targetKey = blockKey(result.hit.block.localLocation);
    if (state.activeContraptionId !== result.contraption.id) {
      if (state.activeContraptionId !== undefined) {
        this.#releaseViewer(player.id, state.activeContraptionId, false);
      }
      if (!this.#acquireViewer(player, result.contraption)) {
        this.#clearInteractionTargets(player.id);
        return;
      }
      state.activeContraptionId = result.contraption.id;
      state.candidateBlockKey = targetKey;
      state.candidateSinceTick = currentTick;
      state.mode = "contraption";
      state.shapeSignature = undefined;
    } else if (state.candidateBlockKey !== targetKey) {
      state.candidateBlockKey = targetKey;
      state.candidateSinceTick = currentTick;
      if (state.mode === "block") state.shapeSignature = undefined;
    }

    if (shouldEnterBlockPreview(
      state.mode,
      currentTick - (state.candidateSinceTick ?? currentTick),
      viewChanged
    )) {
      state.mode = "block";
      state.shapeSignature = undefined;
    }
    this.#updateViewerShape(player, state, result);
    this.#revealViewer(player, state, result.contraption.id);
  }

  #acquireViewer(player: Player, contraption: PhysicsContraption): boolean {
    let record = this.#records.get(contraption.id);
    const created = record === undefined;
    if (!record) {
      let entity: Entity;
      try {
        entity = contraption.body.dimension.dimension.spawnEntity(
          BLOCK_OUTLINE_ENTITY_TYPE_ID,
          contraption.outlineAnchorLocation
        );
      } catch {
        return false;
      }
      if (!contraption.attachOutlineEntity(entity)) {
        if (entity.isValid) entity.remove();
        return false;
      }
      record = {
        contraption,
        contentRevision: contraption.contentRevision,
        entity,
        outlineTopology: undefined,
        readyTick: system.currentTick + OUTLINE_ENTITY_READY_DELAY_TICKS,
        shapeCache: new Map(),
        viewers: new Map()
      };
      this.#records.set(contraption.id, record);
      this.#trackedEntityIds.add(entity.id);
    }
    record.viewers.set(player.id, {
      revealTick: created
        ? record.readyTick + INITIAL_OUTLINE_REVEAL_DELAY_TICKS
        : system.currentTick + 1,
      revealed: false
    });
    try {
      player.setPropertyOverrideForEntity(record.entity, OUTLINE_VISIBLE_PROPERTY, false);
    } catch {
      record.viewers.delete(player.id);
      this.#destroyRecordIfUnused(record);
      return false;
    }
    return true;
  }

  #releaseViewer(playerId: string, contraptionId: number, immediate: boolean): void {
    const record = this.#records.get(contraptionId);
    if (!record) return;
    const viewer = record.viewers.get(playerId);
    if (!viewer) return;
    const player = this.#players.get(playerId);
    if (player && record.entity.isValid) {
      try {
        player.setPropertyOverrideForEntity(record.entity, OUTLINE_VISIBLE_PROPERTY, false);
      } catch {
        immediate = true;
      }
    }
    if (!immediate) {
      viewer.fadeEndTick = system.currentTick + OUTLINE_FADE_TICKS;
      return;
    }
    if (player && record.entity.isValid) {
      clearOverridesQuietly(player, record.entity);
    }
    record.viewers.delete(playerId);
    this.#destroyRecordIfUnused(record);
  }

  #revealViewer(player: Player, state: PlayerOutlineState, contraptionId: number): void {
    const record = this.#records.get(contraptionId);
    const viewer = record?.viewers.get(player.id);
    if (
      !record?.entity.isValid
      || !viewer
      || viewer.revealed
      || state.shapeSignature === undefined
      || system.currentTick < viewer.revealTick
    ) return;
    player.setPropertyOverrideForEntity(record.entity, OUTLINE_VISIBLE_PROPERTY, true);
    viewer.revealed = true;
  }

  #finishFades(currentTick: number): void {
    if (this.#records.size === 0) return;
    // Map iterators tolerate deletion of the current entry, so no copy is needed.
    for (const record of this.#records.values()) {
      if (!record.contraption.isValid || !record.entity.isValid) {
        this.#destroyRecord(record);
        continue;
      }
      for (const [playerId, viewer] of record.viewers) {
        if (viewer.fadeEndTick === undefined || currentTick < viewer.fadeEndTick) continue;
        const player = this.#players.get(playerId);
        if (player) {
          clearOverridesQuietly(player, record.entity);
        }
        record.viewers.delete(playerId);
      }
      this.#destroyRecordIfUnused(record);
    }
  }

  #destroyRecordIfUnused(record: SharedOutlineRecord): void {
    if (record.viewers.size === 0) this.#destroyRecord(record);
  }

  #destroyRecord(record: SharedOutlineRecord): void {
    this.#records.delete(record.contraption.id);
    this.#trackedEntityIds.delete(record.entity.id);
    for (const [playerId] of record.viewers) {
      const player = this.#players.get(playerId);
      if (player && record.entity.isValid) {
        clearOverridesQuietly(player, record.entity);
      }
      const state = this.#states.get(playerId);
      if (state?.activeContraptionId === record.contraption.id) {
        this.#clearInteractionTargets(playerId);
        state.activeContraptionId = undefined;
        state.mode = undefined;
        state.shapeSignature = undefined;
      }
    }
    record.viewers.clear();
    if (record.entity.isValid) {
      if (record.contraption.isValid) record.contraption.detachOutlineEntity(record.entity);
      if (record.entity.isValid) record.entity.remove();
    }
  }

  /** Keep the native block target aligned with the selected contraption cell. */
  #syncInteractionTargets(
    player: Player,
    result: ContraptionRaycastResult,
    refreshInteractionTarget: boolean
  ): void {
    if (
      player.inputInfo.lastInputModeUsed === InputMode.KeyboardAndMouse
      && !player.isSneaking
      && this.#interactionTargetSuppressor?.(result.contraption, result.hit.block)
    ) {
      // Native storage interaction needs the entity to remain the first target
      // on the right-click ray, so standing desktop players get no proxy here.
      this.#clearInteractionTargets(player.id);
      return;
    }
    if (refreshInteractionTarget) {
      this.#interactionTargets.syncPlayer(
        player.id,
        player.dimension,
        result.origin,
        result.hit.location,
        result.direction,
        player.inputInfo.lastInputModeUsed === InputMode.Touch
      );
    }
  }

  #setSharedMiningStage(
    contraption: PhysicsContraption,
    block: PhysicsContraptionBlock,
    stage: number
  ): void {
    const targetKey = blockKey(block.localLocation);
    const key = miningTargetKey(contraption.id, targetKey);
    let record = this.#breakOverlays.get(key);
    if (record && (!record.contraption.isValid || !record.entity.isValid)) {
      this.#destroyBreakOverlay(record);
      record = undefined;
    }
    if (!record) {
      const location = breakOverlayLocation(
        contraption.body.localPointToWorld(block.localLocation)
      );
      const entity = contraption.body.dimension.dimension.spawnEntity(
        BLOCK_CRACK_ENTITY_TYPE_ID,
        location
      );
      record = {
        contraption,
        entity,
        key,
        lastLocation: { ...location },
        lastProgressTick: system.currentTick,
        localLocation: { ...block.localLocation },
        readyTick: system.currentTick + BREAK_OVERLAY_INITIAL_POSE_DELAY_TICKS,
        targetStage: stage
      };
      this.#breakOverlays.set(key, record);
      this.#trackedEntityIds.add(entity.id);
    }
    record.lastProgressTick = system.currentTick;
    record.targetStage = stage;
    this.#syncBreakOverlay(record, system.currentTick);
  }

  #tickBreakOverlays(currentTick: number): void {
    if (this.#breakOverlays.size === 0) return;
    for (const record of this.#breakOverlays.values()) {
      if (
        currentTick - record.lastProgressTick > PLAYER_EDIT_MINING_RESET_TICKS
        || !record.contraption.isValid
        || !record.entity.isValid
        || !record.contraption.getBlockAtLocalLocation(record.localLocation)
      ) {
        this.#destroyBreakOverlay(record);
        continue;
      }
      this.#syncBreakOverlay(record, currentTick);
    }
  }

  #syncBreakOverlay(record: SharedBreakOverlayRecord, currentTick: number): void {
    const { contraption, entity } = record;
    const location = breakOverlayLocation(
      contraption.body.localPointToWorld(record.localLocation)
    );
    const rotation = contraption.visualRotation;
    if (squaredDistance(record.lastLocation, location) > BREAK_OVERLAY_TRANSFORM_EPSILON_SQUARED) {
      entity.teleport(location);
      record.lastLocation = { ...location };
    }
    const publishingInitialPose = record.publishedStage === undefined
      && currentTick >= record.readyTick;
    if (
      publishingInitialPose
      || !record.lastRotation
      || squaredDistance(record.lastRotation, rotation)
        > BREAK_OVERLAY_TRANSFORM_EPSILON_SQUARED
    ) {
      entity.setProperty(BREAK_OVERLAY_PITCH_PROPERTY, rotation.x);
      entity.setProperty(BREAK_OVERLAY_YAW_PROPERTY, rotation.y);
      entity.setProperty(BREAK_OVERLAY_ROLL_PROPERTY, rotation.z);
      record.lastRotation = { ...rotation };
    }
    if (currentTick < record.readyTick || record.publishedStage === record.targetStage) return;
    entity.setProperty(BREAK_OVERLAY_STAGE_PROPERTY, record.targetStage);
    record.publishedStage = record.targetStage;
  }

  #destroyBreakOverlay(record: SharedBreakOverlayRecord): void {
    this.#breakOverlays.delete(record.key);
    this.#trackedEntityIds.delete(record.entity.id);
    if (record.entity.isValid) record.entity.remove();
  }

  #clearContraptionBreakOverlays(contraptionId: number): void {
    for (const record of this.#breakOverlays.values()) {
      if (record.contraption.id === contraptionId) this.#destroyBreakOverlay(record);
    }
  }

  #clearInteractionTargets(playerId: string): void {
    this.#interactionTargets.releasePlayer(playerId);
  }

  #clearSharedMiningStage(contraptionId: number, targetKey: string): void {
    const record = this.#breakOverlays.get(miningTargetKey(contraptionId, targetKey));
    if (record) this.#destroyBreakOverlay(record);
  }

  #updateViewerShape(
    player: Player,
    state: PlayerOutlineState,
    result: ContraptionRaycastResult
  ): void {
    const record = this.#records.get(result.contraption.id);
    if (!record?.entity.isValid) return;
    // The client entity must finish initialization before playAnimation can write its variables.
    if (system.currentTick < record.readyTick) return;
    if (record.contentRevision !== result.contraption.contentRevision) {
      record.contentRevision = result.contraption.contentRevision;
      record.outlineTopology = undefined;
      record.shapeCache.clear();
      state.shapeSignature = undefined;
    }
    if (state.mode === "block") {
      // The preview outline is a pure function of these inputs, so an input
      // signature can gate all placement resolution and edge building.
      const item = selectedItem(player);
      const target = result.hit.block.localLocation;
      const normal = result.hit.localNormal;
      const signature = `b|${record.contentRevision}:${blockKey(target)}:`
        + `${normal.x},${normal.y},${normal.z}:${item?.typeId ?? ""}`;
      if (signature === state.shapeSignature) return;
      const blockPlacement = item ? this.#getPlacementTarget(result, item) : undefined;
      const locations = blockPlacement ? [target, blockPlacement] : [target];
      const edges = createAabbOutline(locations);
      if (edges.length === 0) return;
      const preview = createBlockPreviewTransform(
        target,
        blockPlacement,
        result.contraption.outlineAnchorLocal
      );
      player.setPropertyOverrideForEntity(record.entity, OUTLINE_BLOCK_PREVIEW_PROPERTY, true);
      player.setPropertyOverrideForEntity(record.entity, OUTLINE_PREVIEW_X_PROPERTY, preview.x);
      player.setPropertyOverrideForEntity(record.entity, OUTLINE_PREVIEW_Y_PROPERTY, preview.y);
      player.setPropertyOverrideForEntity(record.entity, OUTLINE_PREVIEW_Z_PROPERTY, preview.z);
      player.setPropertyOverrideForEntity(record.entity, OUTLINE_PREVIEW_SIDE_PROPERTY, preview.side);
      state.shapeSignature = signature;
      return;
    }
    const targetKey = blockKey(result.hit.block.localLocation);
    const cacheKey = `${record.contentRevision}:${targetKey}`;
    let cached = record.shapeCache.get(cacheKey);
    if (!cached) {
      record.outlineTopology ??= createContraptionOutlineTopology(
        result.contraption.blocks,
        CONTRAPTION_OUTLINE_EDGE_CAPACITY
      );
      const edges = createContraptionOutlineShapeFromTopology(
        record.outlineTopology,
        result.hit.block.localLocation,
        CONTRAPTION_OUTLINE_EDGE_CAPACITY
      )?.edges ?? [];
      // The anchor can only move together with a content revision, so the
      // complete signature is stable for the cached revision and target.
      const anchorSignature = blockKey(result.contraption.outlineAnchorLocal);
      cached = {
        edges,
        signature: `${record.contentRevision}:${anchorSignature}:${edgeSignature(edges)}`
      };
      record.shapeCache.set(cacheKey, cached);
    }
    if (cached.edges.length === 0) return;
    if (cached.signature === state.shapeSignature) return;
    player.setPropertyOverrideForEntity(record.entity, OUTLINE_BLOCK_PREVIEW_PROPERTY, false);
    record.entity.playAnimation(OUTLINE_TRANSFORM_ANIMATION, {
      nextState: "none",
      players: [player],
      stopExpression: createEdgeWriteExpression(cached.edges, result.contraption.outlineAnchorLocal)
    });
    state.shapeSignature = cached.signature;
  }

  #getPlacementTarget(result: ContraptionRaycastResult, itemStack: ItemStack): Vector3 | undefined {
    if (!BlockTypes.get(itemStack.typeId)) return undefined;
    const target = {
      x: result.hit.block.localLocation.x + result.hit.localNormal.x,
      y: result.hit.block.localLocation.y + result.hit.localNormal.y,
      z: result.hit.block.localLocation.z + result.hit.localNormal.z
    };
    if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || !Number.isInteger(target.z)) {
      throw new Error(`Contraption placement target is not on the local block grid: ${blockKey(target)}.`);
    }
    return result.contraption.getBlockAtLocalLocation(target) ? undefined : target;
  }

  #validatedActionResult(
    player: Player,
    expected: ContraptionOutlineActionTarget | undefined
  ): ContraptionRaycastResult | undefined {
    const result = this.#raycastForEvent(player);
    if (!result || (expected && !actionTargetMatchesResult(expected, result))) return undefined;
    return result;
  }

  #raycastForEvent(player: Player): ContraptionRaycastResult | undefined {
    if (!this.#canPreview(player)) return undefined;
    const state = this.#states.get(player.id) ?? {
      lastRayTick: system.currentTick - RAY_REFRESH_TICKS
    };
    this.#states.set(player.id, state);
    let direction: Vector3;
    let origin: Vector3;
    try {
      direction = normalize(player.getViewDirection());
      origin = player.getHeadLocation();
    } catch {
      return undefined;
    }
    const dimension = this.#physicsWorld.getExistingDimension(player.dimension);
    if (
      state.rayCache?.tick === system.currentTick
      && state.rayCache.contraptionRevision === contraptionRevisionOf(dimension)
      && state.lastDirection !== undefined
      && !hasViewDirectionChanged(state.lastDirection, direction)
      && state.lastOrigin !== undefined
      && vectorComponentsEqual(state.lastOrigin, origin)
    ) return state.rayCache.result;
    const result = this.#raycastPlayerAssemblies(player, origin, direction);
    state.rayCache = {
      contraptionRevision: contraptionRevisionOf(dimension),
      result,
      tick: system.currentTick
    };
    state.interactionTargetDirty = true;
    state.lastRayTick = system.currentTick;
    state.lastDirection = direction;
    state.lastOrigin = origin;
    return result;
  }

  #raycastPlayerAssemblies(
    player: Player,
    origin: Vector3,
    direction: Vector3
  ): ContraptionRaycastResult | undefined {
    const dimension = this.#physicsWorld.getExistingDimension(player.dimension);
    if (!dimension?.hasAssemblies()) return undefined;
    let closest: ContraptionRaycastResult | undefined;
    for (const contraption of dimension.getContraptionRaycastCandidates(
      origin,
      direction,
      INTERACTION_REACH
    )) {
      if (!contraption.isValid) continue;
      const hit = contraption.raycast(origin, direction, INTERACTION_REACH, {
        skipContainingBlock: true
      });
      if (!hit || (closest && hit.distance >= closest.hit.distance)) continue;
      closest = { contraption, direction, hit, origin };
    }
    if (!closest || worldBlockPrecedes(player, origin, direction, closest.hit.distance)) {
      return undefined;
    }
    return closest;
  }

  #canPreview(player: Player): boolean {
    try {
      return player.isValid && player.getGameMode() !== GameMode.Spectator;
    } catch {
      return false;
    }
  }

}

/**
 * The player or entity can be invalidated between the registry read and this
 * native call (leave/despawn races), so the override wipe stays best-effort.
 */
function clearOverridesQuietly(player: Player, entity: Entity): void {
  try { player.clearPropertyOverridesForEntity(entity); } catch {}
}

/** The -1 sentinel marks "no physics dimension yet" so the next comparison refreshes. */
function contraptionRevisionOf(dimension: PhysicsDimension | undefined): number {
  return dimension?.contraptionRaycastRevision ?? -1;
}

function actionTargetFromResult(result: ContraptionRaycastResult): ContraptionOutlineActionTarget {
  return {
    contraptionId: result.contraption.id,
    blockKey: blockKey(result.hit.block.localLocation),
    face: result.hit.face
  };
}

function actionTargetMatchesResult(
  expected: ContraptionOutlineActionTarget,
  result: ContraptionRaycastResult
): boolean {
  return expected.contraptionId === result.contraption.id
    && expected.blockKey === blockKey(result.hit.block.localLocation)
    && expected.face === result.hit.face;
}

/** Encode a one- or two-cell preview as one center and an optional adjacent side. */
function miningTargetKey(contraptionId: number, targetKey: string): string {
  return `${contraptionId}|${targetKey}`;
}

function requirePlayerContainer(player: Player, purpose = ""): Container {
  const container = player.getComponent("minecraft:inventory")?.container;
  if (!container) {
    throw new Error(`Player ${player.id} has no inventory container${purpose}.`);
  }
  return container;
}

function consumeSelectedBlock(player: Player, usedItem: ItemStack): ItemStack | undefined {
  if (player.getGameMode() === GameMode.Creative) return undefined;
  const container = requirePlayerContainer(player);
  const selected = container.getItem(player.selectedSlotIndex);
  if (!selected || selected.typeId !== usedItem.typeId || selected.amount <= 0) {
    throw new Error(`Player ${player.id}'s selected block changed before placement commit.`);
  }
  const previous = selected.clone();
  selected.amount -= 1;
  container.setItem(player.selectedSlotIndex, selected.amount > 0 ? selected : undefined);
  return previous;
}

function restoreSelectedBlock(player: Player, previous: ItemStack | undefined): void {
  if (!previous || player.getGameMode() === GameMode.Creative) return;
  requirePlayerContainer(player).setItem(player.selectedSlotIndex, previous);
}

function selectedItem(player: Player): ItemStack | undefined {
  try {
    return player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex);
  } catch {
    return undefined;
  }
}
//
function worldBlockPrecedes(
  player: Player,
  origin: Vector3,
  direction: Vector3,
  contraptionDistance: number
): boolean {
  try {
    const hit = player.getBlockFromViewDirection({
      includeLiquidBlocks: false,
      includePassableBlocks: false,
      maxDistance: INTERACTION_REACH
    });
    if (!hit) return false;
    const point = {
      x: hit.block.location.x + hit.faceLocation.x,
      y: hit.block.location.y + hit.faceLocation.y,
      z: hit.block.location.z + hit.faceLocation.z
    };
    const blockDistance = dot(subtract(point, origin), direction);
    return blockDistance >= 0
      && blockDistance + WORLD_BLOCK_OCCLUSION_EPSILON < contraptionDistance;
  } catch {
    return false;
  }
}
