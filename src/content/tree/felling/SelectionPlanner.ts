import type { Block, Dimension, Vector3 } from "@minecraft/server";
import type { ArtificialTreeRegistry } from "@src/service/ArtificialTreeRegistry";
import { add } from "@src/utils/Vector3Math";
import { blockKey } from "@src/utils/BlockKey";
import {
  captureTreeBlock,
  logFamily,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";
import { NEIGHBOR_OFFSETS_WITH_CENTER } from "@src/utils/Neighborhood";
import type { PreparedTreeBreak, TreeBreakPlan } from "@src/content/tree/felling/Selection";
import {
  analyzeCachedRoots,
  analyzeRoots,
  cloneRootAnalysis,
  collectCachedConnectedLogs,
  collectConnectedLogs,
  createTreeBlockReader,
  createTreeBreakPlanFromTopology,
  topologyBlocks,
  topologyIndexKey,
  type RootAnalysis,
  type TreeBlockReader,
  type TreeTopologyCacheEntry
} from "@src/content/tree/felling/Selection";

const TREE_TOPOLOGY_CACHE_TTL_TICKS = 200;
const MAX_CACHED_TREE_TOPOLOGIES = 32;

/** Reuses a recently scanned topology while a player cuts through one tree. */
export class SelectionPlanner {
  readonly #artificialRegistry: ArtificialTreeRegistry;
  readonly #entries = new Set<TreeTopologyCacheEntry>();
  readonly #entryByBlock = new Map<string, TreeTopologyCacheEntry>();

  constructor(artificialRegistry: ArtificialTreeRegistry) {
    this.#artificialRegistry = artificialRegistry;
  }

  prepare(brokenBlock: Block, currentTick: number): PreparedTreeBreak | undefined {
    const start = captureTreeBlock(brokenBlock);
    if (!start || start.kind !== "log") return undefined;

    this.#prune(currentTick);
    const indexedKey = topologyIndexKey(brokenBlock.dimension, start.location);
    let entry = this.#entryByBlock.get(indexedKey);
    let connectedLogs: Map<string, CapturedTreeBlock>;
    let connectedRoots: RootAnalysis;
    let readBlock: TreeBlockReader;

    if (entry && this.#canReuseEntry(entry, brokenBlock.dimension, start)) {
      entry.lastUsedTick = currentTick;
      connectedLogs = collectCachedConnectedLogs(entry.logs, start);
      readBlock = createTreeBlockReader(brokenBlock.dimension, [
        ...entry.logs.values(),
        ...entry.roots.markers.values(),
        ...entry.roots.supportRoots.values(),
        start
      ]);
      connectedRoots = analyzeCachedRoots(connectedLogs, entry.roots, logFamily(start));
    } else {
      if (entry) this.#removeEntry(entry);
      entry = undefined;
      readBlock = createTreeBlockReader(brokenBlock.dimension, [start]);
      const scan = collectConnectedLogs(readBlock, start, logFamily(start));
      connectedLogs = scan.logs;
      if (connectedLogs.size === 0) return undefined;
      connectedRoots = analyzeRoots(readBlock, connectedLogs, logFamily(start));
      if (connectedRoots.markers.size === 0) return undefined;
      if (scan.complete) {
        entry = {
          dimension: brokenBlock.dimension,
          lastUsedTick: currentTick,
          logs: new Map(connectedLogs),
          roots: cloneRootAnalysis(connectedRoots)
        };
      }
    }

    const result = createTreeBreakPlanFromTopology(
      brokenBlock,
      start,
      connectedLogs,
      connectedRoots,
      readBlock,
      this.#artificialRegistry
    );
    if (!result.recognized) return undefined;
    if (entry && !this.#entries.has(entry)) this.#addEntry(entry);
    const preparedEntry = entry;
    return {
      brokenTypeId: start.typeId,
      plan: result.plan,
      commit: () => {
        if (!preparedEntry || !this.#entries.has(preparedEntry)) return;
        this.#commitBreak(preparedEntry, start.location, result.plan, currentTick);
      }
    };
  }

  invalidateNear(dimension: Dimension, location: Vector3): void {
    const affected = new Set<TreeTopologyCacheEntry>();
    for (const offset of NEIGHBOR_OFFSETS_WITH_CENTER) {
      const entry = this.#entryByBlock.get(topologyIndexKey(dimension, add(location, offset)));
      if (entry) affected.add(entry);
    }
    for (const entry of affected) this.#removeEntry(entry);
  }

  #prune(currentTick: number): void {
    for (const entry of this.#entries) {
      if (currentTick - entry.lastUsedTick > TREE_TOPOLOGY_CACHE_TTL_TICKS) this.#removeEntry(entry);
    }
  }

  #canReuseEntry(entry: TreeTopologyCacheEntry, dimension: Dimension, start: CapturedTreeBlock): boolean {
    if (entry.dimension.id !== dimension.id) return false;
    const cached = entry.logs.get(blockKey(start.location));
    return cached?.typeId === start.typeId && logFamily(cached) === logFamily(start);
  }

  #commitBreak(entry: TreeTopologyCacheEntry, location: Vector3, plan: TreeBreakPlan | undefined, currentTick: number): void {
    entry.lastUsedTick = currentTick;
    const key = blockKey(location);
    entry.logs.delete(key);
    this.#entryByBlock.delete(topologyIndexKey(entry.dimension, location));
    if (plan && plan.components.length > 0) {
      this.#removeEntry(entry);
      return;
    }
    for (const root of plan?.rootsToRestore ?? []) {
      const rootKey = blockKey(root.location);
      entry.roots.markers.delete(rootKey);
      entry.roots.supportRoots.delete(rootKey);
      this.#entryByBlock.delete(topologyIndexKey(entry.dimension, root.location));
    }
    if (entry.logs.size === 0) this.#removeEntry(entry);
  }

  #addEntry(entry: TreeTopologyCacheEntry): void {
    while (this.#entries.size >= MAX_CACHED_TREE_TOPOLOGIES) {
      const oldest = this.#entries.values().next().value as TreeTopologyCacheEntry | undefined;
      if (!oldest) break;
      this.#removeEntry(oldest);
    }
    for (const block of topologyBlocks(entry)) {
      const indexKey = topologyIndexKey(entry.dimension, block.location);
      const previous = this.#entryByBlock.get(indexKey);
      if (previous && previous !== entry) this.#removeEntry(previous);
    }
    this.#entries.add(entry);
    for (const block of topologyBlocks(entry)) this.#entryByBlock.set(topologyIndexKey(entry.dimension, block.location), entry);
  }

  #removeEntry(entry: TreeTopologyCacheEntry): void {
    if (!this.#entries.delete(entry)) return;
    for (const block of topologyBlocks(entry)) {
      const key = topologyIndexKey(entry.dimension, block.location);
      if (this.#entryByBlock.get(key) === entry) this.#entryByBlock.delete(key);
    }
  }
}
