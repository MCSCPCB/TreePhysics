// Settlement side effects for contraptions: loot drops, bee spawns, break
// particles, and the tag-based deduplication that keeps recovered settlements
// idempotent. Split from contraption-lifecycle.ts because these batched world
// effects only consume settlement operation records, never lifecycle state.
import {
  BlockPermutation,
  world,
  type Dimension,
  type ItemStack,
  type Vector3
} from "@minecraft/server";
import type { PhysicsContraptionFoliageTint } from "@src/Physics";
import type { CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import {
  mergeStackableItemDrops,
  totalItemAmount,
  type PendingItemDrop
} from "@src/content/tree/contraption/ItemDropBatching";
import {
  spawnBlockParticle,
  BLOCK_BREAK_PARTICLE_PROFILE
} from "@src/render/particle/BlockParticles";
import type { SerializedSnapshotEntry } from "@src/storage/ContraptionSerialization";

const DROP_MERGE_ITEM_THRESHOLD = 16;
const FINAL_SETTLEMENT_POSITIONAL_OPERATION_LIMIT = 64;
const FINAL_SETTLEMENT_MAX_CENTRALIZED_PARTICLES = 32;
const DETACHED_ATTACHMENT_MAX_PARTICLES = 32;
const BEE_NEST_TYPE_ID = "minecraft:bee_nest";
const BEE_ENTITY_TYPE_ID = "minecraft:bee";

export interface PendingSettlementOperation {
  readonly key: string;
  readonly location: Vector3;
  readonly localLocation: Vector3;
  readonly spawnParticle: boolean;
  readonly snapshot: CapturedTreeBlock;
}

interface SettlementEffectRuntime {
  readonly deduplicate: boolean;
  readonly dimension: Dimension;
  readonly id: string;
  readonly lootTool?: ItemStack;
  readonly foliageTint?: PhysicsContraptionFoliageTint;
}

export interface PendingDropRuntime extends SettlementEffectRuntime {
  cursor: number;
  readonly deadlineTick: number;
  readonly mergeDrops: boolean;
  readonly operations: readonly PendingSettlementOperation[];
  readonly soundLocation: Vector3;
  started: boolean;
}

export interface PendingSettlementRuntime extends SettlementEffectRuntime {
  completed: boolean;
  readonly dropAnchor: Vector3;
  readonly operations: readonly PendingSettlementOperation[];
  readonly soundLocation: Vector3;
}

export function spawnPermutationDrops(
  dimension: Dimension,
  snapshot: CapturedTreeBlock,
  location: Vector3,
  tool?: ItemStack,
  tagPrefix?: string,
  existingTags: ReadonlySet<string> = new Set()
): void {
  const drops = generatePermutationDrops(snapshot, tool).map((item, index) => ({
    item,
    operationTag: tagPrefix ? `${tagPrefix}_item_${index}` : undefined,
    location
  }));
  spawnItemDropBatch(dimension, drops, false, undefined, existingTags);
}

export function generatePermutationDrops(
  snapshot: CapturedTreeBlock,
  tool?: ItemStack
): ItemStack[] {
  try {
    const permutation = BlockPermutation.resolve(snapshot.typeId, { ...snapshot.states });
    return world.getLootTableManager().generateLootFromBlockPermutation(permutation, tool) ?? [];
  } catch {
    return [];
  }
}

export function spawnItemDropBatch(
  dimension: Dimension,
  drops: readonly PendingItemDrop[],
  mergeWhenLarge: boolean,
  tagPrefix?: string,
  existingTags: ReadonlySet<string> = new Set()
): void {
  const planned = mergeWhenLarge && totalItemAmount(drops) > DROP_MERGE_ITEM_THRESHOLD
    ? mergeStackableItemDrops(drops)
    : drops;
  for (let index = 0; index < planned.length; index++) {
    const drop = planned[index]!;
    const tag = tagPrefix ? `${tagPrefix}_item_${index}` : drop.operationTag;
    if (tag && existingTags.has(tag)) continue;
    try {
      const entity = dimension.spawnItem(drop.item, drop.location);
      if (tag) entity.addTag(tag);
    } catch {
      // One invalid drop must not prevent the remaining batch from spawning.
    }
  }
}

export function spawnBeeNestBees(
  dimension: Dimension,
  snapshot: CapturedTreeBlock,
  location: Vector3,
  tagPrefix?: string,
  existingTags: ReadonlySet<string> = new Set()
): void {
  if (snapshot.typeId !== BEE_NEST_TYPE_ID) return;
  const count = getBeeNestSpawnCount(snapshot.states.honey_level);
  for (let index = 0; index < count; index++) {
    try {
      const tag = tagPrefix ? `${tagPrefix}_bee_${index}` : undefined;
      if (tag && existingTags.has(tag)) continue;
      const entity = dimension.spawnEntity(BEE_ENTITY_TYPE_ID, location);
      if (tag) entity.addTag(tag);
    } catch {
      // Bee spawning must not undo the nest break or its drops.
    }
  }
}

export function appendDetachedAttachmentOperations(
  operations: PendingSettlementOperation[],
  attachments: readonly SerializedSnapshotEntry[],
  cursor: number
): void {
  const start = Math.min(attachments.length, Math.max(0, Math.floor(cursor)));
  for (let attachmentIndex = start; attachmentIndex < attachments.length; attachmentIndex++) {
    const attachment = attachments[attachmentIndex]!;
    operations.push({
      key: `detach_${attachmentIndex}`,
      location: { ...attachment.snapshot.location },
      localLocation: { ...attachment.localLocation },
      spawnParticle: isDeterministicParticleSample(
        attachmentIndex,
        attachments.length,
        DETACHED_ATTACHMENT_MAX_PARTICLES
      ),
      snapshot: attachment.snapshot
    });
  }
}

export function isDeterministicParticleSample(index: number, count: number, limit: number): boolean {
  if (count <= limit) return true;
  return Math.floor(index * limit / count) !== Math.floor((index + 1) * limit / count);
}

export function resolveFinalSettlementDropAnchor(
  operations: readonly PendingSettlementOperation[],
  fallback: Vector3
): Vector3 {
  if (operations.length === 0) return { ...fallback };
  const contraptionOperations = operations.filter(operation => !operation.key.startsWith("detach_"));
  const anchorOperations = contraptionOperations.length > 0 ? contraptionOperations : operations;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const operation of anchorOperations) {
    minX = Math.min(minX, operation.location.x);
    minY = Math.min(minY, operation.location.y);
    minZ = Math.min(minZ, operation.location.z);
    maxX = Math.max(maxX, operation.location.x);
    maxZ = Math.max(maxZ, operation.location.z);
  }
  return {
    x: (minX + maxX) * 0.5,
    y: minY + 0.25,
    z: (minZ + maxZ) * 0.5
  };
}

function spawnSettlementOperation(
  pending: SettlementEffectRuntime,
  operation: PendingSettlementOperation
): void {
  const tagPrefix = `treephysics_settle_${pending.id}_${operation.key}`;
  const existingTags = pending.deduplicate
    ? getNearbySettlementTags(pending.dimension, operation.location, tagPrefix)
    : new Set<string>();
  if (operation.spawnParticle) {
    spawnBlockParticle(
      pending.dimension,
      operation.location,
      operation.snapshot,
      operation.localLocation,
      pending.foliageTint,
      { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
    );
  }
  spawnPermutationDrops(
    pending.dimension,
    operation.snapshot,
    operation.location,
    pending.lootTool,
    tagPrefix,
    existingTags
  );
  spawnBeeNestBees(
    pending.dimension,
    operation.snapshot,
    operation.location,
    tagPrefix,
    existingTags
  );
}

export function spawnFinalSettlementBatch(pending: PendingSettlementRuntime): void {
  if (pending.operations.length <= FINAL_SETTLEMENT_POSITIONAL_OPERATION_LIMIT) {
    for (const operation of pending.operations) spawnSettlementOperation(pending, operation);
    return;
  }

  const itemTagPrefix = `treephysics_settle_${pending.id}_batch`;
  const existingItemTags = pending.deduplicate
    ? getNearbySettlementTags(pending.dimension, pending.dropAnchor, itemTagPrefix, 8)
    : new Set<string>();
  const drops: PendingItemDrop[] = [];
  for (let operationIndex = 0; operationIndex < pending.operations.length; operationIndex++) {
    const operation = pending.operations[operationIndex]!;
    for (const item of generatePermutationDrops(operation.snapshot, pending.lootTool)) {
      drops.push({ item, location: pending.dropAnchor });
    }
    if (
      operation.spawnParticle
      && isDeterministicParticleSample(
        operationIndex,
        pending.operations.length,
        FINAL_SETTLEMENT_MAX_CENTRALIZED_PARTICLES
      )
    ) {
      spawnBlockParticle(
        pending.dimension,
        operation.location,
        operation.snapshot,
        operation.localLocation,
        pending.foliageTint,
        { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
      );
    }
    const operationTagPrefix = `treephysics_settle_${pending.id}_${operation.key}`;
    const existingOperationTags = pending.deduplicate
      ? getNearbySettlementTags(
        pending.dimension,
        operation.location,
        operationTagPrefix
      )
      : new Set<string>();
    spawnBeeNestBees(
      pending.dimension,
      operation.snapshot,
      operation.location,
      operationTagPrefix,
      existingOperationTags
    );
  }
  spawnItemDropBatch(
    pending.dimension,
    drops,
    true,
    itemTagPrefix,
    existingItemTags
  );
}

export function spawnSettlementOperations(
  pending: PendingDropRuntime,
  operations: readonly PendingSettlementOperation[]
): void {
  if (!pending.mergeDrops || operations.length === 0) {
    for (const operation of operations) spawnSettlementOperation(pending, operation);
    return;
  }

  const settlementPrefix = `treephysics_settle_${pending.id}_`;
  const existingTags = pending.deduplicate
    ? getSettlementTagsForOperations(pending.dimension, operations, settlementPrefix)
    : new Set<string>();
  const drops: PendingItemDrop[] = [];
  for (const operation of operations) {
    const operationPrefix = `${settlementPrefix}${operation.key}`;
    const generated = generatePermutationDrops(operation.snapshot, pending.lootTool);
    for (let index = 0; index < generated.length; index++) {
      const operationTag = `${operationPrefix}_item_${index}`;
      if (existingTags.has(operationTag)) continue;
      drops.push({ item: generated[index]!, operationTag, location: operation.location });
    }
    if (operation.spawnParticle) {
      spawnBlockParticle(
        pending.dimension,
        operation.location,
        operation.snapshot,
        operation.localLocation,
        pending.foliageTint,
        { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
      );
    }
    spawnBeeNestBees(
      pending.dimension,
      operation.snapshot,
      operation.location,
      operationPrefix,
      existingTags
    );
  }
  const first = operations[0]!.key;
  const last = operations[operations.length - 1]!.key;
  spawnItemDropBatch(
    pending.dimension,
    drops,
    true,
    `${settlementPrefix}merge_${first}_${last}`,
    existingTags
  );
}

function getNearbySettlementTags(
  dimension: Dimension,
  location: Vector3,
  prefix: string,
  maxDistance = 2
): Set<string> {
  const tags = new Set<string>();
  try {
    for (const entity of dimension.getEntities({ location, maxDistance })) {
      for (const tag of entity.getTags()) {
        if (tag.startsWith(prefix)) tags.add(tag);
      }
    }
  } catch {
    // Tag inspection is best-effort; the durable pending record still prevents contraption recovery.
  }
  return tags;
}

export function getSettlementTagsForOperations(
  dimension: Dimension,
  operations: readonly PendingSettlementOperation[],
  prefix: string
): Set<string> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const operation of operations) {
    minX = Math.min(minX, operation.location.x);
    minY = Math.min(minY, operation.location.y);
    minZ = Math.min(minZ, operation.location.z);
    maxX = Math.max(maxX, operation.location.x);
    maxY = Math.max(maxY, operation.location.y);
    maxZ = Math.max(maxZ, operation.location.z);
  }
  const location = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2
  };
  const maxDistance = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 4;
  return getNearbySettlementTags(dimension, location, prefix, maxDistance);
}

function getBeeNestSpawnCount(honeyLevel: unknown): number {
  const numeric = Number(honeyLevel);
  if (!Number.isFinite(numeric)) return 0;
  const level = Math.max(0, Math.min(5, Math.floor(numeric)));
  return Math.min(3, Math.ceil(level / 2));
}
