import {
  Direction,
  system,
  world,
  type Block,
  type Dimension,
  type ItemStack,
  type Player,
  type Vector3
} from "@minecraft/server";
import { ArtificialTreeRegistry } from "@src/service/ArtificialTreeRegistry";
import { ContraptionExternalEffectsController } from "@src/content/contraption/effects/Controller";
import { installExplosionContraptionPhysics } from "@src/events/contraption/Explosion";
import {
  ContraptionLifecycle,
  createContraptionVisualTag
} from "@src/content/tree/contraption/Lifecycle";
import {
  handleBlockColliderLoad,
  handleContraptionMountLoad,
  physicsWorld,
  type PhysicsContraption
} from "./Physics.js";
import { BLOCK_PHYSICS_PROPERTIES } from "@src/data/BlockPhysicsProperties";
import {
  isCollidingTreeAttachment,
  isVanillaTypeId,
  NATURAL_TREE_ROOT_ID,
  NATURAL_ROOT_SOIL_TYPE_IDS,
  SOIL_VARIANT_STATE,
  isTreeLeaf,
  isTreeStructuralBlock,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";
import { createContraptionBlock } from "@src/content/tree/block/ContraptionBlock";
import { createTreeAttachmentPerformancePlan } from "@src/content/tree/performance/Attachments";
import { captureTreeFoliageTint } from "@src/content/tree/foliage/TintSampling";
import { createTreeLeafPhysicsRuntimeRepresentation } from "@src/content/tree/foliage/PhysicsRuntime";
import { createLowPerformanceBranchPruningPlan } from "@src/content/tree/performance/BranchPruning";
import { prepareTreeWorldRemoval } from "@src/content/tree/felling/WorldRemoval";
import { installPistonContraptionPhysics } from "@src/events/contraption/Piston";
import { SelectionPlanner } from "@src/content/tree/felling/SelectionPlanner";
import {
  type PreparedTreeBreak,
  type TreeBreakPlan
} from "@src/content/tree/felling/Selection";
import {
  getTreeFellingToolProfile,
  getVanillaLogBreakTicks
} from "@src/content/tree/felling/Speed";
import { PlayerInteractionController } from "@src/content/player/Interaction";
import { ContraptionContainerInteractionController } from "@src/content/contraption/interaction/ContainerInteraction";
import { blockCenter, blockKey } from "@src/utils/BlockKey";
import { resolveVanillaBlockBreakSound } from "@src/data/BlockSound";
import {
  installTreeSettings
} from "@src/ui/Settings";
import {
  getTreePhysicsPerformanceLevel,
  getTreeObbCollisionLevel,
  shouldCarryPlayers,
  shouldUseSmoothPlayerCarrying,
  TREE_OBB_COLLISION_DISABLED,
  TREE_OBB_COLLISION_HIGH,
  TREE_PHYSICS_PERFORMANCE_LOW
} from "@src/config/Settings";
import { getTreeBreakTiming } from "@src/content/tree/felling/BreakTiming";

const IMPULSE_FORCE = 1.5;
const IMPULSE_TORQUE = 0.3;
const IMPACT_COOLDOWN_PRUNE_INTERVAL_TICKS = 1200;
const IMPACT_SOUND_MIN_SPEED = 1.5;
const IMPACT_SOUND_COOLDOWN_TICKS = 8;
// A prepared break stays valid while the after-event can still match it; the
// cleanup timeout must outlive that window so valid entries are never pruned early.
const PENDING_BREAK_MAX_AGE_TICKS = 2;
const PENDING_BREAK_CLEANUP_TICKS = PENDING_BREAK_MAX_AGE_TICKS + 1;

interface PendingBreak {
  prepared: PreparedTreeBreak;
  tick: number;
  tool?: ItemStack;
}
const artificialTrees = new ArtificialTreeRegistry();
const treeBreakPlanner = new SelectionPlanner(artificialTrees);
const externalEffects = new ContraptionExternalEffectsController(physicsWorld);
const playerInteraction = new PlayerInteractionController(physicsWorld);
const containerInteraction = new ContraptionContainerInteractionController();
const contraptions = new ContraptionLifecycle({
  canBreakWorldLeaf: isBreakableWorldLeaf,
  chestStorage: containerInteraction,
  configureDimension: configurePhysicsDimension,
  crossDomain: true,
  isDamageImmune: (contraption, entity) => entity.typeId === "minecraft:player"
    && playerInteraction.isDraggingContraption(entity.id, contraption),
  onContraptionReplaced: (source, replacements) => (
    playerInteraction.handleContraptionReplacement(source, replacements)
  ),
  onWorldBlocksChanged: invalidateLowPerformanceWorldMeshBatch
});
containerInteraction.setNativeDeathHandler((ownerId, binding) => {
  contraptions.handleChestStorageNativeDeath(ownerId, binding);
});
const configuredDimensions = new Set<string>();
const pendingBreaks = new Map<string, PendingBreak>();
const lastImpactTickByBody = new Map<number, number>();

playerInteraction.setContraptionBreakHandler((player, itemStack, contraption, block) => (
  contraptions.breakBlockForPlayerEdit(player, itemStack, contraption, block)
));
playerInteraction.setContraptionMiningEffectHandler((contraption, block) => {
  contraptions.emitBlockMiningEffects(contraption, block);
});
playerInteraction.setContraptionPlaceHandler((player, itemStack, contraption, block, placement, direction) => (
  contraptions.placeBlockForPlayerEdit(player, itemStack, contraption, block, placement, direction)
));
playerInteraction.setContraptionPlacementEffectHandler((contraption, block) => {
  contraptions.emitBlockPlacementEffects(contraption, block);
});
playerInteraction.setContraptionInteractHandler(containerInteraction);

physicsWorld.setPerformanceLevelProvider(getTreePhysicsPerformanceLevel);
physicsWorld.setCollisionShellProvider(() => (
  getTreeObbCollisionLevel() === TREE_OBB_COLLISION_HIGH ? "solid" : "walking"
));
physicsWorld.setPlayerCollisionEnabledProvider(() => (
  getTreeObbCollisionLevel() !== TREE_OBB_COLLISION_DISABLED
));
physicsWorld.setPlayerCarryingEnabledProvider(shouldCarryPlayers);
physicsWorld.setPlayerMountEnabledProvider(() => (
  getTreeObbCollisionLevel() !== TREE_OBB_COLLISION_DISABLED
    && shouldCarryPlayers()
    && shouldUseSmoothPlayerCarrying()
));
installTreeSettings();

world.afterEvents.entityLoad.subscribe(event => {
  handleBlockColliderLoad(event.entity);
  handleContraptionMountLoad(event.entity);
  contraptions.handleVisualEntityLoad(event.entity);
  playerInteraction.handleVisualEntityLoad(event.entity);
  containerInteraction.handleEntityLoad(event.entity);
});

world.afterEvents.playerSpawn.subscribe(event => {
  physicsWorld.handleMountPlayerSpawn(event.player);
});

world.beforeEvents.playerBreakBlock.subscribe(event => {
  const key = pendingKey(event.player, event.dimension, event.block.location);
  pendingBreaks.delete(key);
  if (event.player.isSneaking) return;

  let prepared: PreparedTreeBreak | undefined;
  try {
    prepared = treeBreakPlanner.prepare(event.block, system.currentTick);
  } catch {
    // Planning scans neighbouring blocks and can hit an unloaded chunk at the
    // border; an unplannable break simply falls through to vanilla behaviour.
    return;
  }
  if (!prepared) return;
  const pending = {
    prepared,
    tick: system.currentTick,
    tool: cloneItemStack(event.itemStack)
  };
  pendingBreaks.set(key, pending);
  system.runTimeout(() => {
    if (pendingBreaks.get(key) === pending) pendingBreaks.delete(key);
  }, PENDING_BREAK_CLEANUP_TICKS);
});

world.afterEvents.playerPlaceBlock.subscribe(event => {
  artificialTrees.markBlock(event.block);
  treeBreakPlanner.invalidateNear(event.dimension, event.block.location);
  invalidateLowPerformanceWorldMeshBatch(event.dimension, [event.block.location]);
  wakeTreeAssembliesNear(event.dimension, event.block.location);
});

world.afterEvents.playerBreakBlock.subscribe(event => {
  const location = event.block.location;
  const brokenTypeId = event.brokenBlockPermutation.type.id;
  if (isTreeStructuralBlock(brokenTypeId)) {
    artificialTrees.delete(event.dimension, location);
  }

  const key = pendingKey(event.player, event.dimension, location);
  const pending = pendingBreaks.get(key);
  pendingBreaks.delete(key);
  const age = pending ? system.currentTick - pending.tick : Number.POSITIVE_INFINITY;
  const valid = pending
    && age <= PENDING_BREAK_MAX_AGE_TICKS
    && pending.prepared.brokenTypeId === brokenTypeId;
  if (valid) pending.prepared.commit();
  else treeBreakPlanner.invalidateNear(event.dimension, location);

  invalidateLowPerformanceWorldMeshBatch(event.dimension, [location]);
  wakeTreeAssembliesNear(event.dimension, location);
  if (valid && pending.prepared.plan) {
    executeTreeBreak(pending.prepared.plan, event.player, pending.tool);
  }
});

world.afterEvents.blockExplode.subscribe(event => {
  treeBreakPlanner.invalidateNear(event.dimension, event.block.location);
  if (isTreeStructuralBlock(event.explodedBlockPermutation.type.id)) {
    artificialTrees.delete(event.dimension, event.block.location);
  }
});

world.afterEvents.playerInteractWithBlock.subscribe(event => {
  if (!event.isFirstEvent || !isLowPerformanceWorldMeshEnabled()) return;
  const dimension = event.block.dimension;
  const locations: Vector3[] = [];
  if (isManuallyShapeChangingBlock(event.block.typeId)) {
    locations.push({ ...event.block.location });
    if (isDoorBlock(event.block.typeId)) {
      locations.push(
        { ...event.block.location, y: event.block.location.y - 1 },
        { ...event.block.location, y: event.block.location.y + 1 }
      );
    }
  }
  if (isFluidBucket(event.beforeItemStack) || isFluidBucket(event.itemStack)) {
    locations.push(
      { ...event.block.location },
      offsetByDirection(event.block.location, event.blockFace)
    );
  }
  invalidateLowPerformanceWorldMeshBatch(dimension, locations);
});

world.afterEvents.pressurePlatePush.subscribe(event => {
  if (!isLowPerformanceWorldMeshEnabled()) return;
  invalidateLowPerformanceWorldMeshBatch(event.dimension, [event.block.location]);
});

world.afterEvents.pressurePlatePop.subscribe(event => {
  if (!isLowPerformanceWorldMeshEnabled()) return;
  invalidateLowPerformanceWorldMeshBatch(event.dimension, [event.block.location]);
});

physicsWorld.afterEvents.surfaceParticle.subscribe(event => {
  contraptions.handleSurfaceParticle(event);
});

physicsWorld.afterEvents.collision.subscribe(event => {
  const collisionTypeId = contraptions.handleCollision(event);
  if (event.impactSpeed < IMPACT_SOUND_MIN_SPEED) return;
  const previousTick = lastImpactTickByBody.get(event.body.id) ?? -100;
  if (event.currentTick - previousTick < IMPACT_SOUND_COOLDOWN_TICKS) return;
  lastImpactTickByBody.set(event.body.id, event.currentTick);
  const sound = resolveVanillaBlockBreakSound(collisionTypeId);
  try {
    event.body.dimension.dimension.playSound(sound.sound, event.point, {
      pitch: Math.min(1.2, 0.75 + event.impactSpeed * 0.02),
      volume: sound.volume
    });
  } catch {
    // Physics remains valid if a client cannot resolve this sound id.
  }
});

physicsWorld.afterEvents.waterEntry.subscribe(event => {
  contraptions.handleWaterEntry(event);
});

physicsWorld.afterEvents.lavaEntry.subscribe(event => {
  contraptions.handleLavaEntry(event);
});

physicsWorld.afterEvents.step.subscribe(event => {
  contraptions.tick(event.currentTick);
  playerInteraction.tick(event.currentTick);
  if (event.currentTick % IMPACT_COOLDOWN_PRUNE_INTERVAL_TICKS === 0) {
    pruneImpactCooldowns();
  }
});

installExplosionContraptionPhysics(externalEffects, invalidateWorldMeshBatch);
installPistonContraptionPhysics(externalEffects, block => {
  artificialTrees.markBlock(block);
  treeBreakPlanner.invalidateNear(block.dimension, block.location);
}, invalidateWorldMeshBatch, (
  dimension,
  from,
  to,
  block
) => {
  artificialTrees.delete(dimension, from);
  artificialTrees.markBlock(block);
  treeBreakPlanner.invalidateNear(dimension, from);
  treeBreakPlanner.invalidateNear(dimension, to);
});
containerInteraction.start();
playerInteraction.start();
physicsWorld.start();

function executeTreeBreak(
  plan: TreeBreakPlan,
  player: Player,
  tool: ItemStack | undefined
): void {
  if (plan.components.length === 0) {
    for (const root of plan.rootsToRestore) restoreSoil(plan.dimension, root);
    return;
  }

  const physicsDimension = configurePhysicsDimension(plan.dimension);
  const motion = createChopMotion(player, plan.breakLocation);
  let created = 0;

  for (const component of plan.components) {
    let contraption: PhysicsContraption | undefined;
    try {
      const containsAddonTreeBlocks = component.blocks.some(block =>
        (block.kind === "log" || block.kind === "leaf")
        && !isVanillaTypeId(block.typeId)
      );
      // Addon trees can only retain vanilla attachments whose real block has
      // collision. Render-only plants remain in the world instead of becoming
      // artificial full-cube contraption sensors.
      const sourceBlocks = containsAddonTreeBlocks
        ? component.blocks.filter(block =>
          block.kind !== "attachment" || isCollidingTreeAttachment(block.typeId)
        )
        : component.blocks;
      const preparedRemoval = prepareTreeWorldRemoval(
        plan.dimension,
        sourceBlocks,
        invalidateLowPerformanceWorldMeshBatch
      );
      const liveBlocks = preparedRemoval.snapshots;
      const lowPerformance = getTreePhysicsPerformanceLevel() === TREE_PHYSICS_PERFORMANCE_LOW;
      const branchPruningPlan = lowPerformance
        ? createLowPerformanceBranchPruningPlan(
          liveBlocks,
          plan.breakLocation
        )
        : { detachedSnapshots: [], retainedSnapshots: liveBlocks };
      const leafPhysicsPlan = contraptions.prepareLeafPhysicsPlan(
        branchPruningPlan.retainedSnapshots,
        plan.breakLocation
      );
      const attachmentPerformancePlan = createTreeAttachmentPerformancePlan(
        branchPruningPlan.retainedSnapshots,
        plan.breakLocation,
        leafPhysicsPlan.profile.id
      );
      const contraptionSnapshots = attachmentPerformancePlan.retainedSnapshots;
      const foliageTint = captureTreeFoliageTint(
        plan.dimension,
        contraptionSnapshots,
        plan.breakLocation
      );
      const persistenceId = contraptions.allocateContraptionId();
      const visualGeneration = 1;
      const contraptionBlocks = contraptionSnapshots.map(block =>
        createContraptionBlock(block, plan.breakLocation)
      );
      contraption = physicsDimension.createContraption({
        angularVelocity: motion.angularVelocity,
        blocks: contraptionBlocks,
        foliageTint,
        location: blockCenter(plan.breakLocation),
        name: "Felled tree",
        runtimeRepresentation: createTreeLeafPhysicsRuntimeRepresentation(leafPhysicsPlan),
        velocity: motion.velocity,
        visualEntityTags: [createContraptionVisualTag(persistenceId, visualGeneration)]
      });
      const logCount = contraptionSnapshots.filter(block => block.kind === "log").length;
      const toolProfile = getTreeFellingToolProfile(tool);
      const breakTiming = getTreeBreakTiming(logCount, getVanillaLogBreakTicks(toolProfile));
      contraptions.register(contraption, contraptionSnapshots, plan.breakLocation, {
        detachedAttachments: [
          ...branchPruningPlan.detachedSnapshots,
          ...attachmentPerformancePlan.detachedAttachments
        ],
        leafPhysicsPlan,
        lootTool: cloneItemStack(tool),
        persistenceId,
        sleepTicksPerLog: breakTiming.sleepTicksPerLog,
        sleepTimeoutTicks: breakTiming.sleepTimeoutTicks,
        sourceCommitted: false,
        visualGeneration
      });
      try {
        preparedRemoval.commit();
      } catch (error) {
        contraptions.cancelRegistration(contraption);
        throw error;
      }
      contraptions.commitRegistration(contraption);
      created++;
    } catch {
      contraption?.remove();
    }
  }

  if (created > 0) {
    for (const root of plan.rootsToRestore) restoreSoil(plan.dimension, root);
  }
}

function cloneItemStack(itemStack: ItemStack | undefined): ItemStack | undefined {
  return itemStack?.clone();
}

function configurePhysicsDimension(dimension: Dimension) {
  const physicsDimension = physicsWorld.getDimension(dimension);
  if (configuredDimensions.has(dimension.id)) return physicsDimension;
  configuredDimensions.add(dimension.id);
  physicsDimension.setBlockPropertiesBatch(Object.entries(BLOCK_PHYSICS_PROPERTIES));
  physicsDimension.setWorldBlockSensorPredicate(isBreakableWorldLeaf);
  return physicsDimension;
}

function isBreakableWorldLeaf(block: Block): boolean {
  if (!isTreeLeaf(block.typeId)) return false;
  const state = block.permutation.getState("persistent_bit");
  if (state === true || Number(state) === 1) return false;
  return !artificialTrees.has(block.dimension, block.location);
}

function wakeTreeAssembliesNear(dimension: Dimension, location: Vector3): void {
  const physicsDimension = physicsWorld.getExistingDimension(dimension);
  if (!physicsDimension?.hasAssemblies()) return;
  physicsDimension.wakeBodiesNear(location, 1);
}

function pruneImpactCooldowns(): void {
  const liveBodyIds = new Set(
    physicsWorld.getDimensions().flatMap(dimension => dimension.getBodies().map(body => body.id))
  );
  for (const bodyId of lastImpactTickByBody.keys()) {
    if (!liveBodyIds.has(bodyId)) lastImpactTickByBody.delete(bodyId);
  }
}

function restoreSoil(dimension: Dimension, root: CapturedTreeBlock): void {
  const block = dimension.getBlock(root.location);
  if (!block || block.typeId !== NATURAL_TREE_ROOT_ID) return;
  const variant = Number(root.states[SOIL_VARIANT_STATE]);
  const typeId = NATURAL_ROOT_SOIL_TYPE_IDS[variant];
  if (typeId) {
    block.setType(typeId);
    invalidateLowPerformanceWorldMesh(dimension, root.location);
  }
}

function createChopMotion(player: Player, breakLocation: Vector3): {
  angularVelocity: Vector3;
  velocity: Vector3;
} {
  const head = player.getHeadLocation();
  let towardPlayer = horizontalUnit({
    x: head.x - (breakLocation.x + 0.5),
    y: 0,
    z: head.z - (breakLocation.z + 0.5)
  });
  if (towardPlayer.x === 0 && towardPlayer.z === 0) {
    const view = horizontalUnit(player.getViewDirection());
    towardPlayer = { x: -view.x, y: 0, z: -view.z };
  }
  const angle = (Math.random() * 50 - 25) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const forward = {
    x: towardPlayer.x * cos - towardPlayer.z * sin,
    y: 0,
    z: towardPlayer.x * sin + towardPlayer.z * cos
  };
  return {
    angularVelocity: {
      x: -forward.z * IMPULSE_TORQUE,
      y: 0,
      z: forward.x * IMPULSE_TORQUE
    },
    velocity: {
      x: -forward.x * IMPULSE_FORCE,
      y: 0,
      z: -forward.z * IMPULSE_FORCE
    }
  };
}

function invalidateLowPerformanceWorldMesh(dimension: Dimension, location: Vector3): void {
  if (!isLowPerformanceWorldMeshEnabled()) return;
  physicsWorld.invalidateWorldMesh(dimension, location, 0);
}

function invalidateLowPerformanceWorldMeshBatch(
  dimension: Dimension,
  locations: readonly Vector3[]
): void {
  if (locations.length === 0 || !isLowPerformanceWorldMeshEnabled()) return;
  physicsWorld.invalidateWorldMeshBatch(dimension, locations);
}

function invalidateWorldMeshBatch(
  dimension: Dimension,
  locations: readonly Vector3[]
): void {
  if (locations.length === 0) return;
  physicsWorld.invalidateWorldMeshBatch(dimension, locations);
}

function isLowPerformanceWorldMeshEnabled(): boolean {
  return getTreePhysicsPerformanceLevel() === TREE_PHYSICS_PERFORMANCE_LOW;
}

function isDoorBlock(typeId: string): boolean {
  return typeId.endsWith("_door") && !typeId.endsWith("_trapdoor");
}

function isManuallyShapeChangingBlock(typeId: string): boolean {
  return isDoorBlock(typeId)
    || typeId.endsWith("_trapdoor")
    || typeId.endsWith("fence_gate");
}

// Empty buckets count too: scooping a fluid also changes the block.
const FLUID_BUCKET_TYPE_IDS: ReadonlySet<string> = new Set([
  "minecraft:bucket",
  "minecraft:water_bucket",
  "minecraft:lava_bucket"
]);

const DIRECTION_OFFSETS: Readonly<Record<Direction, Vector3>> = {
  [Direction.Down]: { x: 0, y: -1, z: 0 },
  [Direction.Up]: { x: 0, y: 1, z: 0 },
  [Direction.North]: { x: 0, y: 0, z: -1 },
  [Direction.South]: { x: 0, y: 0, z: 1 },
  [Direction.West]: { x: -1, y: 0, z: 0 },
  [Direction.East]: { x: 1, y: 0, z: 0 }
};

function isFluidBucket(itemStack: ItemStack | undefined): boolean {
  return itemStack !== undefined && FLUID_BUCKET_TYPE_IDS.has(itemStack.typeId);
}

function offsetByDirection(location: Vector3, direction: Direction): Vector3 {
  const offset = DIRECTION_OFFSETS[direction];
  return { x: location.x + offset.x, y: location.y + offset.y, z: location.z + offset.z };
}

function pendingKey(player: Player, dimension: Dimension, location: Vector3): string {
  return `${player.id}|${dimension.id}|${blockKey(location)}`;
}

function horizontalUnit(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.z);
  return length < 0.0001
    ? { x: 0, y: 0, z: 0 }
    : { x: value.x / length, y: 0, z: value.z / length };
}
