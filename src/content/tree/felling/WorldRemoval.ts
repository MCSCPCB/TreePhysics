import { BlockPermutation, type Block, type Dimension, type Vector3 } from "@minecraft/server";
import type { CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import { blockKey } from "@src/utils/BlockKey";

interface PreparedTreeBlock {
  block: Block;
  snapshot: CapturedTreeBlock;
}

export interface PreparedTreeWorldRemoval {
  readonly snapshots: readonly CapturedTreeBlock[];
  commit(): void;
}

export function prepareTreeWorldRemoval(
  dimension: Dimension,
  snapshots: readonly CapturedTreeBlock[],
  onWorldBlocksChanged?: (dimension: Dimension, locations: readonly Vector3[]) => void
): PreparedTreeWorldRemoval {
  const prepared: PreparedTreeBlock[] = [];
  for (const snapshot of snapshots) {
    const block = dimension.getBlock(snapshot.location);
    if (!block) {
      throw new Error(`Tree block became unavailable at ${blockKey(snapshot.location)}.`);
    }
    if (block.typeId === snapshot.typeId) {
      prepared.push({ block, snapshot });
      continue;
    }
    if (snapshot.kind === "leaf" || snapshot.kind === "attachment") continue;
    throw new Error(
      `Tree block changed at ${blockKey(snapshot.location)}: `
      + `expected ${snapshot.typeId}, found ${block.typeId}.`
    );
  }

  return {
    snapshots: prepared.map(entry => entry.snapshot),
    commit: () => commitTreeWorldRemoval(dimension, prepared, onWorldBlocksChanged)
  };
}

function commitTreeWorldRemoval(
  dimension: Dimension,
  prepared: readonly PreparedTreeBlock[],
  onWorldBlocksChanged?: (dimension: Dimension, locations: readonly Vector3[]) => void
): void {
  const attachments: PreparedTreeBlock[] = [];
  const leaves: PreparedTreeBlock[] = [];
  const structural: PreparedTreeBlock[] = [];
  for (const entry of prepared) {
    if (entry.snapshot.kind === "attachment") attachments.push(entry);
    else if (entry.snapshot.kind === "leaf") leaves.push(entry);
    else structural.push(entry);
  }
  const removed: CapturedTreeBlock[] = [];

  try {
    // Remove supported blocks before their supports (attachments, then leaves,
    // then structural logs) so vanilla neighbor updates cannot pop dependent
    // blocks off as free item drops mid-transaction.
    for (const entries of [attachments, leaves, structural]) {
      for (const entry of entries) {
        removed.push(entry.snapshot);
        entry.block.setType("minecraft:air");
      }
    }
    notifyWorldBlocksChanged(onWorldBlocksChanged, dimension, removed);
  } catch (error) {
    try {
      restoreRemovedBlocks(dimension, removed);
    } finally {
      notifyWorldBlocksChanged(onWorldBlocksChanged, dimension, removed);
    }
    throw error;
  }
}

function notifyWorldBlocksChanged(
  callback: ((dimension: Dimension, locations: readonly Vector3[]) => void) | undefined,
  dimension: Dimension,
  snapshots: readonly CapturedTreeBlock[]
): void {
  if (!callback || snapshots.length === 0) return;
  try {
    callback(dimension, snapshots.map(snapshot => snapshot.location));
  } catch {
    // Cache invalidation must not change the removal transaction result.
  }
}

function restoreRemovedBlocks(
  dimension: Dimension,
  snapshots: readonly CapturedTreeBlock[]
): void {
  for (const snapshot of snapshots) {
    const block = dimension.getBlock(snapshot.location);
    if (!block) continue;
    block.setPermutation(BlockPermutation.resolve(snapshot.typeId, { ...snapshot.states }));
  }
}
