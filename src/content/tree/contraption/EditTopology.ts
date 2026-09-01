import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraptionBlock } from "@src/Physics";
import {
  treeBlockKind,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";
import {
  resolveTreeAttachmentSupport,
  type TreeAttachmentStateUpdate,
  type TreeAttachmentSupportEntry
} from "@src/content/tree/block/AttachmentSupport";
import { createFragmentVisual } from "@src/render/contraption/fragment/FragmentVisual";
import {
  LOCAL_BLOCK_KEY_BASE as PACK_BASE,
  LOCAL_BLOCK_KEY_BIAS as PACK_BIAS,
  blockKey as locationKey,
  packIntegerCoordinates
} from "@src/utils/BlockKey";
import { FACE_OFFSETS, NEIGHBOR_OFFSETS as SUPPORT_OFFSETS } from "@src/utils/Neighborhood";

export interface TreeEditTopologyComponent {
  readonly blocks: readonly PhysicsContraptionBlock[];
  readonly containsLog: boolean;
  readonly containsNonTreeBlock: boolean;
}

export interface TreeEditTopologyPlan {
  readonly attachmentStateUpdates: readonly TreeEditTopologyAttachmentStateUpdate[];
  readonly components: readonly TreeEditTopologyComponent[];
  readonly unsupportedTreeBlocks: readonly PhysicsContraptionBlock[];
}

export interface TreeEditTopologyAttachmentStateUpdate extends TreeAttachmentStateUpdate {
  readonly block: PhysicsContraptionBlock;
}

// Local coordinates are integer-validated below and bounded to |c| <= 511 by
// contraption normalization, so packing on a 2048 base is collision free: an
// out-of-range neighbor coordinate lands on a packed value no real block can
// occupy and simply misses the map. Packed keys keep the 6/26-neighbor loops
// free of per-probe string allocation.
const FACE_OFFSET_DELTAS: readonly number[] = FACE_OFFSETS.map(packOffset);
const SUPPORT_OFFSET_DELTAS: readonly number[] = SUPPORT_OFFSETS.map(packOffset);
const LOCAL_TOPOLOGY_PROOF_LIMIT = 256;

interface MutableTopologyComponent {
  blocks: PhysicsContraptionBlock[];
  containsLog: boolean;
  containsNonTreeBlock: boolean;
}

/** Incrementally mirrors one contraption's blocks and proves cheap no-split edits. */
export class TreeEditTopologyIndex {
  readonly #blocksByKey = new Map<number, PhysicsContraptionBlock>();
  #canonicalSingleComponent: boolean;

  constructor(
    blocks: readonly PhysicsContraptionBlock[],
    canonicalSingleComponent = false
  ) {
    for (const block of blocks) this.#addBlock(block);
    this.#canonicalSingleComponent = canonicalSingleComponent;
  }

  addBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    for (const block of blocks) this.#addBlock(block);
  }

  removeBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    for (const block of blocks) {
      const key = blockLocationKey(block);
      if (!this.#blocksByKey.delete(key)) {
        const { x, y, z } = block.localLocation;
        throw new Error(`Removed topology block is not indexed: ${x},${y},${z}.`);
      }
    }
  }

  updateBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    for (const block of blocks) {
      const key = blockLocationKey(block);
      const current = this.#blocksByKey.get(key);
      if (!current || current.typeId !== block.typeId) {
        const { x, y, z } = block.localLocation;
        throw new Error(`Updated topology block is not indexed: ${x},${y},${z}.`);
      }
      this.#blocksByKey.set(key, block);
    }
  }

  markCanonicalSingleComponent(): void {
    this.#canonicalSingleComponent = true;
  }

  createPlanAfterRemoving(
    locations: readonly Vector3[],
    snapshotsByKey: ReadonlyMap<string, CapturedTreeBlock>
  ): TreeEditTopologyPlan {
    const removedKeys = new Set(locations.map(blockLocationVectorKey));
    const remainingBlocks: PhysicsContraptionBlock[] = [];
    for (const [key, block] of this.#blocksByKey) {
      if (!removedKeys.has(key)) remainingBlocks.push(block);
    }
    if (
      this.#canonicalSingleComponent
      && this.#provesSingleComponentAfterRemoval(removedKeys)
    ) {
      return {
        attachmentStateUpdates: [],
        components: [{
          blocks: remainingBlocks,
          containsLog: remainingBlocks.some(block => treeBlockKind(block.typeId) === "log"),
          containsNonTreeBlock: remainingBlocks.some(block => treeBlockKind(block.typeId) === undefined)
        }],
        unsupportedTreeBlocks: []
      };
    }
    return createTreeEditTopologyPlan(remainingBlocks, snapshotsByKey);
  }

  #addBlock(block: PhysicsContraptionBlock): void {
    const key = blockLocationKey(block);
    if (this.#blocksByKey.has(key)) {
      const { x, y, z } = block.localLocation;
      throw new RangeError(`Duplicate contraption block location in topology index: ${x},${y},${z}.`);
    }
    this.#blocksByKey.set(key, block);
  }

  #provesSingleComponentAfterRemoval(removedKeys: ReadonlySet<number>): boolean {
    let remainingLogCount = 0;
    for (const [key, block] of this.#blocksByKey) {
      if (!removedKeys.has(key) && treeBlockKind(block.typeId) === "log") remainingLogCount++;
    }
    // The existing topology plan has special no-log component semantics; keep
    // those transitions on the complete planner.
    if (remainingLogCount === 0) return false;
    // Attachment support depends on block states and may cascade vertically.
    // Keep that event-only work in the complete planner.
    for (const [key, block] of this.#blocksByKey) {
      if (!removedKeys.has(key) && treeBlockKind(block.typeId) === "attachment") return false;
    }

    let visitedCount = 0;
    for (const removedKey of removedKeys) {
      const removed = this.#blocksByKey.get(removedKey);
      if (!removed) return false;
      const kind = treeBlockKind(removed.typeId);
      if (kind === "log") {
        const logNeighbors = this.#faceLogNeighbors(removedKey, removedKeys);
        if (logNeighbors.length > 1) {
          const result = this.#logsConnectTargets(
            logNeighbors[0]!,
            new Set(logNeighbors.slice(1)),
            removedKeys,
            LOCAL_TOPOLOGY_PROOF_LIMIT - visitedCount
          );
          if (!result.complete) return false;
          visitedCount += result.visited;
        }
      }

      if (kind === "log" || kind === "leaf") {
        for (const neighborKey of this.#neighborKeys(removedKey, SUPPORT_OFFSET_DELTAS)) {
          if (removedKeys.has(neighborKey)) continue;
          const neighbor = this.#blocksByKey.get(neighborKey);
          const neighborKind = neighbor && treeBlockKind(neighbor.typeId);
          if (neighborKind === "leaf") {
            const result = this.#leafRegionReachesLog(
              neighborKey,
              removedKeys,
              LOCAL_TOPOLOGY_PROOF_LIMIT - visitedCount
            );
            if (!result.complete) return false;
            visitedCount += result.visited;
          }
        }
      }

      // Logs, leaves, attachments, and non-tree blocks can all be the sole
      // face support through which an ordinary block island reaches the tree.
      for (const neighborKey of this.#neighborKeys(removedKey, FACE_OFFSET_DELTAS)) {
        if (removedKeys.has(neighborKey)) continue;
        const neighbor = this.#blocksByKey.get(neighborKey);
        if (!neighbor || treeBlockKind(neighbor.typeId) !== undefined) continue;
        const result = this.#nonTreeRegionReachesTree(
          neighborKey,
          removedKeys,
          LOCAL_TOPOLOGY_PROOF_LIMIT - visitedCount
        );
        if (!result.complete) return false;
        visitedCount += result.visited;
      }
    }
    return true;
  }

  #leafRegionReachesLog(
    startKey: number,
    removedKeys: ReadonlySet<number>,
    budget: number
  ): { readonly complete: boolean; readonly visited: number } {
    const queue = [startKey];
    const visited = new Set([startKey]);
    for (let index = 0; index < queue.length; index++) {
      if (visited.size > budget) return { complete: false, visited: visited.size };
      const key = queue[index]!;
      for (const neighborKey of this.#neighborKeys(key, SUPPORT_OFFSET_DELTAS)) {
        if (removedKeys.has(neighborKey)) continue;
        const neighbor = this.#blocksByKey.get(neighborKey);
        if (!neighbor) continue;
        const kind = treeBlockKind(neighbor.typeId);
        if (kind === "log") return { complete: true, visited: visited.size };
        if (kind !== "leaf" || visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }
    return { complete: false, visited: visited.size };
  }

  #nonTreeRegionReachesTree(
    startKey: number,
    removedKeys: ReadonlySet<number>,
    budget: number
  ): { readonly complete: boolean; readonly visited: number } {
    const queue = [startKey];
    const visited = new Set([startKey]);
    for (let index = 0; index < queue.length; index++) {
      if (visited.size > budget) return { complete: false, visited: visited.size };
      const key = queue[index]!;
      for (const neighborKey of this.#neighborKeys(key, FACE_OFFSET_DELTAS)) {
        if (removedKeys.has(neighborKey)) continue;
        const neighbor = this.#blocksByKey.get(neighborKey);
        if (!neighbor) continue;
        const kind = treeBlockKind(neighbor.typeId);
        if (kind === "log" || kind === "leaf" || kind === "attachment") {
          return { complete: true, visited: visited.size };
        }
        if (kind !== undefined || visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }
    return { complete: false, visited: visited.size };
  }

  /** Face-adjacency BFS through surviving logs proving startKey reaches every target. */
  #logsConnectTargets(
    startKey: number,
    targets: Set<number>,
    removedKeys: ReadonlySet<number>,
    budget: number
  ): { readonly complete: boolean; readonly visited: number } {
    const queue = [startKey];
    const visited = new Set([startKey]);
    targets.delete(startKey);
    for (let index = 0; index < queue.length && targets.size > 0; index++) {
      if (visited.size > budget) return { complete: false, visited: visited.size };
      for (const neighborKey of this.#neighborKeys(queue[index]!, FACE_OFFSET_DELTAS)) {
        if (removedKeys.has(neighborKey) || visited.has(neighborKey)) continue;
        const neighbor = this.#blocksByKey.get(neighborKey);
        if (!neighbor || treeBlockKind(neighbor.typeId) !== "log") continue;
        visited.add(neighborKey);
        targets.delete(neighborKey);
        queue.push(neighborKey);
      }
    }
    return { complete: targets.size === 0, visited: visited.size };
  }

  #faceLogNeighbors(key: number, removedKeys: ReadonlySet<number>): number[] {
    const result: number[] = [];
    for (const neighborKey of this.#neighborKeys(key, FACE_OFFSET_DELTAS)) {
      if (removedKeys.has(neighborKey)) continue;
      const neighbor = this.#blocksByKey.get(neighborKey);
      if (neighbor && treeBlockKind(neighbor.typeId) === "log") result.push(neighborKey);
    }
    return result;
  }

  #neighborKeys(key: number, deltas: readonly number[]): number[] {
    return deltas.map(delta => key + delta);
  }
}

/**
 * Logs form components through face adjacency. Leaves retain the existing
 * 26-neighbor support behavior and are assigned to one log component without
 * joining separate trunks back together. Pure tree fragments without a log
 * become normal leaf/attachment break effects.
 */
export function createTreeEditTopologyPlan(
  blocks: readonly PhysicsContraptionBlock[],
  snapshotsByKey: ReadonlyMap<string, CapturedTreeBlock>
): TreeEditTopologyPlan {
  const blocksByKey = new Map<number, PhysicsContraptionBlock>();
  for (const block of blocks) {
    const key = blockLocationKey(block);
    if (blocksByKey.has(key)) {
      const { x, y, z } = block.localLocation;
      throw new RangeError(`Duplicate contraption block location in edit topology: ${x},${y},${z}.`);
    }
    blocksByKey.set(key, block);
  }

  const ownerByKey = new Map<number, number>();
  const components: MutableTopologyComponent[] = [];
  const unvisitedLogs = new Set<number>();
  for (const [key, block] of blocksByKey) {
    if (treeBlockKind(block.typeId) === "log") unvisitedLogs.add(key);
  }
  while (unvisitedLogs.size > 0) {
    const componentIndex = components.length;
    const startKey = unvisitedLogs.values().next().value as number;
    const queue = [startKey];
    const component: MutableTopologyComponent = {
      blocks: [],
      containsLog: true,
      containsNonTreeBlock: false
    };
    components.push(component);
    unvisitedLogs.delete(startKey);
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      const block = blocksByKey.get(key)!;
      ownerByKey.set(key, componentIndex);
      component.blocks.push(block);
      for (const delta of FACE_OFFSET_DELTAS) {
        const neighborKey = key + delta;
        if (!unvisitedLogs.delete(neighborKey)) continue;
        queue.push(neighborKey);
      }
    }
  }

  // A multi-source traversal assigns supported leaves while preserving the
  // already separated log components.
  const supportQueue = [...ownerByKey.keys()];
  for (let index = 0; index < supportQueue.length; index++) {
    const key = supportQueue[index]!;
    const owner = ownerByKey.get(key)!;
    for (const delta of SUPPORT_OFFSET_DELTAS) {
      const neighborKey = key + delta;
      if (ownerByKey.has(neighborKey)) continue;
      const neighbor = blocksByKey.get(neighborKey);
      if (!neighbor || treeBlockKind(neighbor.typeId) !== "leaf") continue;
      ownerByKey.set(neighborKey, owner);
      components[owner]!.blocks.push(neighbor);
      supportQueue.push(neighborKey);
    }
  }

  const attachmentEntries = createAttachmentSupportEntries(blocks, snapshotsByKey);
  const unsupportedStructuralKeys = new Set(
    [...blocksByKey]
      .filter(([key, block]) => (
        !ownerByKey.has(key)
        && treeBlockKind(block.typeId) !== "attachment"
        && treeBlockKind(block.typeId) !== undefined
      ))
      .map(([, block]) => locationKey(block.localLocation))
  );
  const attachmentSupport = resolveTreeAttachmentSupport(
    attachmentEntries,
    unsupportedStructuralKeys
  );
  const attachmentEntryByKey = new Map(
    attachmentEntries.map(entry => [entry.key, entry])
  );
  const unsupportedAttachmentKeys = new Set(
    [...attachmentSupport.unsupportedKeys].map(key => blockLocationVectorKey(
      attachmentEntryByKey.get(key)!.localLocation
    ))
  );
  const attachmentStateUpdates: TreeEditTopologyAttachmentStateUpdate[] = [];
  for (const update of attachmentSupport.stateUpdates.values()) {
    const key = blockLocationVectorKey(
      attachmentEntryByKey.get(update.key)!.localLocation
    );
    const block = blocksByKey.get(key);
    if (!block) throw new Error(`Updated tree attachment ${update.key} has no topology block.`);
    const visual = createFragmentVisual(update.snapshot);
    if (!visual || visual.renderer !== "attachment_fragment") {
      throw new Error(`Updated tree attachment ${update.key} has no attachment visual state.`);
    }
    const updatedBlock = { ...block, visual };
    blocksByKey.set(key, updatedBlock);
    attachmentStateUpdates.push({ ...update, block: updatedBlock });
  }

  // Assign attachments through their actual host, iterating because hanging
  // moss and vines may be supported by another attachment above them.
  const pendingAttachmentKeys = new Set(
    [...blocksByKey]
      .filter(([key, block]) => (
        !unsupportedAttachmentKeys.has(key)
        && treeBlockKind(block.typeId) === "attachment"
      ))
      .map(([key]) => key)
  );
  assignSupportedAttachments(
    pendingAttachmentKeys,
    attachmentEntries,
    attachmentSupport.supportKeysByAttachment,
    blocksByKey,
    ownerByKey,
    components
  );

  // Non-tree blocks connected to a supported tree component remain with that
  // component. They trigger the lifecycle pause but never merge two trunks. A
  // multi-source traversal seeded with every owned key mirrors the leaf pass
  // above: owned seeds are visited first, discovered non-tree blocks after.
  const nonTreeQueue = [...ownerByKey.keys()];
  for (let index = 0; index < nonTreeQueue.length; index++) {
    const key = nonTreeQueue[index]!;
    const owner = ownerByKey.get(key)!;
    for (const delta of FACE_OFFSET_DELTAS) {
      const neighborKey = key + delta;
      if (ownerByKey.has(neighborKey)) continue;
      const neighbor = blocksByKey.get(neighborKey);
      if (!neighbor || treeBlockKind(neighbor.typeId) !== undefined) continue;
      ownerByKey.set(neighborKey, owner);
      const component = components[owner]!;
      component.blocks.push(neighbor);
      component.containsNonTreeBlock = true;
      nonTreeQueue.push(neighborKey);
    }
  }

  // A detached non-tree island is still a physical child. Absorb directly
  // connected tree foliage so future attachment edits can split mixed bodies.
  for (const [startKey, startBlock] of blocksByKey) {
    if (ownerByKey.has(startKey) || treeBlockKind(startBlock.typeId) !== undefined) continue;
    const componentIndex = components.length;
    const component: MutableTopologyComponent = {
      blocks: [],
      containsLog: false,
      containsNonTreeBlock: true
    };
    components.push(component);
    const queue = [startKey];
    ownerByKey.set(startKey, componentIndex);
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      const block = blocksByKey.get(key)!;
      component.blocks.push(block);
      const kind = treeBlockKind(block.typeId);
      const deltas = kind === "leaf" ? SUPPORT_OFFSET_DELTAS : FACE_OFFSET_DELTAS;
      for (const delta of deltas) {
        const neighborKey = key + delta;
        if (ownerByKey.has(neighborKey)) continue;
        const neighbor = blocksByKey.get(neighborKey);
        if (!neighbor) continue;
        const neighborKind = treeBlockKind(neighbor.typeId);
        if (unsupportedAttachmentKeys.has(neighborKey)) continue;
        if (neighborKind === "log" || neighborKind === "root") continue;
        // Attachments join only through their resolved host after this ordinary
        // block island has an owner; arbitrary face contact is not support.
        if (neighborKind === "attachment") continue;
        if (kind === "attachment" && neighborKind !== undefined) continue;
        ownerByKey.set(neighborKey, componentIndex);
        queue.push(neighborKey);
      }
    }
  }

  assignSupportedAttachments(
    pendingAttachmentKeys,
    attachmentEntries,
    attachmentSupport.supportKeysByAttachment,
    blocksByKey,
    ownerByKey,
    components
  );

  // Bee nests deliberately have no host dependency. Keep an otherwise
  // isolated nest with a deterministic surviving component instead of turning
  // it into an unsupported attachment drop.
  if (components.length > 0) {
    for (const key of pendingAttachmentKeys) {
      const block = blocksByKey.get(key)!;
      if (block.typeId !== "minecraft:bee_nest") continue;
      ownerByKey.set(key, 0);
      components[0]!.blocks.push(block);
      pendingAttachmentKeys.delete(key);
    }
  }

  const unsupportedTreeBlocks: PhysicsContraptionBlock[] = [];
  for (const [key, block] of blocksByKey) {
    if (
      !ownerByKey.has(key)
      && treeBlockKind(block.typeId) !== undefined
      && (block.typeId !== "minecraft:bee_nest" || components.length === 0)
    ) {
      unsupportedTreeBlocks.push(block);
    }
  }
  return { attachmentStateUpdates, components, unsupportedTreeBlocks };
}

export function contraptionContainsNonTreeBlock(
  blocks: readonly PhysicsContraptionBlock[]
): boolean {
  return blocks.some(block => treeBlockKind(block.typeId) === undefined);
}

function blockLocationKey(block: PhysicsContraptionBlock): number {
  return blockLocationVectorKey(block.localLocation);
}

function blockLocationVectorKey(location: Vector3): number {
  const { x, y, z } = location;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    throw new RangeError(`Contraption edit topology requires integer locations: ${x},${y},${z}.`);
  }
  return packIntegerCoordinates(x, y, z, PACK_BIAS, PACK_BASE);
}

function packOffset(offset: { readonly x: number; readonly y: number; readonly z: number }): number {
  return offset.x + offset.y * PACK_BASE + offset.z * PACK_BASE * PACK_BASE;
}

function firstNeighborOwner(
  key: number,
  deltas: readonly number[],
  ownerByKey: ReadonlyMap<number, number>
): number | undefined {
  for (const delta of deltas) {
    const owner = ownerByKey.get(key + delta);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

function createAttachmentSupportEntries(
  blocks: readonly PhysicsContraptionBlock[],
  snapshotsByKey: ReadonlyMap<string, CapturedTreeBlock>
): TreeAttachmentSupportEntry[] {
  return blocks.map(block => {
    const key = locationKey(block.localLocation);
    const snapshot = snapshotsByKey.get(key);
    if (!snapshot) {
      throw new Error(`Tree edit topology block ${key} has no captured snapshot.`);
    }
    return { key, localLocation: block.localLocation, snapshot };
  });
}

function assignSupportedAttachments(
  pendingKeys: Set<number>,
  entries: readonly TreeAttachmentSupportEntry[],
  supportKeysByAttachment: ReadonlyMap<string, readonly string[]>,
  blocksByKey: ReadonlyMap<number, PhysicsContraptionBlock>,
  ownerByKey: Map<number, number>,
  components: readonly MutableTopologyComponent[]
): void {
  const entryByKey = new Map(entries.map(entry => [entry.key, entry]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...pendingKeys]) {
      const block = blocksByKey.get(key)!;
      const stringKey = locationKey(block.localLocation);
      const supportKeys = supportKeysByAttachment.get(stringKey) ?? [];
      let owner: number | undefined;
      for (const supportKey of supportKeys) {
        const support = entryByKey.get(supportKey);
        if (!support) continue;
        owner = ownerByKey.get(blockLocationVectorKey(support.localLocation));
        if (owner !== undefined) break;
      }
      if (owner === undefined && block.typeId === "minecraft:bee_nest") {
        owner = firstNeighborOwner(key, SUPPORT_OFFSET_DELTAS, ownerByKey);
      }
      if (owner === undefined) continue;
      ownerByKey.set(key, owner);
      components[owner]!.blocks.push(block);
      pendingKeys.delete(key);
      changed = true;
    }
  }
}
