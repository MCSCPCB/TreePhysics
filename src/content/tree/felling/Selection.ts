import type { Block, Dimension, Vector3 } from "@minecraft/server";
import type { ArtificialTreeRegistry } from "@src/service/ArtificialTreeRegistry";
import { MAX_PHYSICS_CONTRAPTION_BLOCKS } from "@src/physics/core/Types";
import { blockKey } from "@src/utils/BlockKey";
import {
  NATURAL_TREE_ROOT_ID,
  captureTreeBlock,
  isMangroveRoot,
  isPersistentLeaf,
  leafFamily,
  logFamily,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";
import { add, EPSILON_1E6 } from "@src/utils/Vector3Math";
import {
  FACE_OFFSETS as ORTHOGONAL_NEIGHBOR_OFFSETS,
  NEIGHBOR_OFFSETS
} from "@src/utils/Neighborhood";
import { safeGetBlock } from "@src/utils/WorldBlock";

const MAX_CONNECTED_LOG_SCAN_BLOCKS = 16384;
const MAX_CONNECTED_LOG_GRAPH_DISTANCE = 96;
const MAX_LEAF_DISTANCE = 6;
const MAX_RAW_LEAF_SCAN_BLOCKS = 65536;
const MAX_LEAF_DISTANCE_FIELD_BLOCKS = 16384;
const MAX_MANGROVE_ROOT_BLOCKS = 2048;

export interface TreeBreakComponent {
  blocks: readonly CapturedTreeBlock[];
}

export interface TreeBreakPlan {
  breakLocation: Vector3;
  brokenTypeId: string;
  components: readonly TreeBreakComponent[];
  dimension: Dimension;
  rootsToRestore: readonly CapturedTreeBlock[];
}

export interface PreparedTreeBreak {
  readonly brokenTypeId: string;
  readonly plan?: TreeBreakPlan;
  commit(): void;
}

interface LogComponent {
  anchored: boolean;
  index: number;
  logs: CapturedTreeBlock[];
}

interface LeafWave {
  block: CapturedTreeBlock;
  distance: number;
  family: string;
  owner: number;
}

interface OwnedLeafClaim {
  block: CapturedTreeBlock;
  distance: number;
  family: string;
  owner: number;
}

interface CandidateLeafClaim {
  block: CapturedTreeBlock;
  distance: number;
  family: string;
}

interface LeafDistanceFieldWave {
  block: CapturedTreeBlock;
  expansionDistance: number;
}

interface AttachmentClaim {
  block: CapturedTreeBlock;
  owner: number;
}

export interface RootAnalysis {
  markers: Map<string, CapturedTreeBlock>;
  supportRoots: Map<string, CapturedTreeBlock>;
}

interface RootClaim {
  distance: number;
  owners: Set<string>;
}

interface RootWave {
  distance: number;
  key: string;
  owner: string;
}

interface RootOwner {
  key: string;
  markers: CapturedTreeBlock[];
}

interface TreeOwnership {
  logs: Map<string, CapturedTreeBlock>;
  roots: RootAnalysis;
}

export interface ConnectedLogWave {
  block: CapturedTreeBlock;
  distance: number;
}

interface ConnectedLogScan {
  complete: boolean;
  logs: Map<string, CapturedTreeBlock>;
}

export interface TreeTopologyCacheEntry {
  dimension: Dimension;
  lastUsedTick: number;
  logs: Map<string, CapturedTreeBlock>;
  roots: RootAnalysis;
}

export interface TreePlanResult {
  plan?: TreeBreakPlan;
  recognized: boolean;
}

export interface TreeBlockReader {
  (location: Vector3): CapturedTreeBlock | undefined;
  capturedBlocks(): Iterable<CapturedTreeBlock>;
}

/**
 * Reuses a recently scanned log topology while a player cuts through one tree.
 * Final foliage and attachment selection still reads the live world when the
 * cached topology first becomes detached.
 */
export function* topologyBlocks(entry: TreeTopologyCacheEntry): Iterable<CapturedTreeBlock> {
  yield* entry.logs.values();
  yield* entry.roots.markers.values();
  yield* entry.roots.supportRoots.values();
}

export function createTreeBreakPlanFromTopology(
  brokenBlock: Block,
  start: CapturedTreeBlock,
  connectedLogs: ReadonlyMap<string, CapturedTreeBlock>,
  connectedRoots: RootAnalysis,
  readBlock: TreeBlockReader,
  artificialRegistry: ArtificialTreeRegistry
): TreePlanResult {
  const ownership = isolateRootOwnedTree(
    connectedLogs,
    connectedRoots,
    blockKey(start.location)
  );
  if (!ownership) {
    return { recognized: false };
  }
  const { logs: fullLogs, roots } = ownership;

  for (const block of fullLogs.values()) {
    if (artificialRegistry.has(brokenBlock.dimension, block.location)) {
      return { recognized: false };
    }
  }
  for (const block of roots.markers.values()) {
    if (artificialRegistry.has(brokenBlock.dimension, block.location)) {
      return { recognized: false };
    }
  }
  for (const block of roots.supportRoots.values()) {
    if (artificialRegistry.has(brokenBlock.dimension, block.location)) {
      return { recognized: false };
    }
  }

  const components = splitLogComponents(fullLogs, blockKey(start.location));
  for (const component of components) {
    component.anchored = isComponentAnchored(component, roots);
  }
  const directRoot = roots.markers.get(blockKey({
    x: start.location.x,
    y: start.location.y - 1,
    z: start.location.z
  }));
  const detached = components.filter(component => !component.anchored);
  if (detached.length === 0) {
    if (directRoot) {
      return { recognized: true, plan: {
        breakLocation: { ...start.location },
        brokenTypeId: start.typeId,
        components: [],
        dimension: brokenBlock.dimension,
        rootsToRestore: [directRoot]
      } };
    }
    return { recognized: true };
  }

  const leaves = collectLeaves(
    brokenBlock.dimension,
    components,
    artificialRegistry,
    readBlock
  );
  const attachments = collectAttachments(
    brokenBlock.dimension,
    components,
    leaves,
    artificialRegistry,
    readBlock
  );

  // Bucket claims by owner once; per-component filtering over the complete
  // claim maps would rescan every claim for every detached component.
  const attachmentsByOwner = new Map<number, CapturedTreeBlock[]>();
  for (const claim of attachments.values()) {
    let bucket = attachmentsByOwner.get(claim.owner);
    if (!bucket) attachmentsByOwner.set(claim.owner, bucket = []);
    bucket.push(claim.block);
  }
  const leavesByOwner = new Map<number, CapturedTreeBlock[]>();
  for (const claim of leaves.values()) {
    let bucket = leavesByOwner.get(claim.owner);
    if (!bucket) leavesByOwner.set(claim.owner, bucket = []);
    bucket.push(claim.block);
  }

  const plannedComponents: TreeBreakComponent[] = [];
  for (const component of detached) {
    if (component.logs.length > MAX_PHYSICS_CONTRAPTION_BLOCKS) {
      throw new RangeError(
        `Natural tree component has ${component.logs.length} logs, exceeding the physics limit.`
      );
    }
    const componentAttachments = (attachmentsByOwner.get(component.index) ?? [])
      .slice(0, MAX_PHYSICS_CONTRAPTION_BLOCKS - component.logs.length);
    const leafCapacity = MAX_PHYSICS_CONTRAPTION_BLOCKS
      - component.logs.length
      - componentAttachments.length;
    const componentLeaves = (leavesByOwner.get(component.index) ?? [])
      .slice(0, leafCapacity);
    const blocks = [...component.logs, ...componentLeaves, ...componentAttachments];
    if (blocks.length === 0) continue;
    plannedComponents.push({ blocks });
  }
  if (plannedComponents.length === 0) {
    return { recognized: false };
  }

  const rootsToRestore = components.some(component => component.anchored)
    ? directRoot ? [directRoot] : []
    : [...roots.markers.values()];

  return { recognized: true, plan: {
    breakLocation: { ...start.location },
    brokenTypeId: start.typeId,
    components: plannedComponents,
    dimension: brokenBlock.dimension,
    rootsToRestore
  } };
}

export function collectConnectedLogs(
  readBlock: TreeBlockReader,
  start: CapturedTreeBlock,
  family: string
): ConnectedLogScan {
  const logs = new Map<string, CapturedTreeBlock>();
  const queued = new Set([blockKey(start.location)]);
  const queue: ConnectedLogWave[] = [{ block: start, distance: 0 }];
  let complete = true;

  for (let index = 0; index < queue.length; index++) {
    const wave = queue[index];
    const center = wave.block;
    logs.set(blockKey(center.location), center);
    if (
      wave.distance >= MAX_CONNECTED_LOG_GRAPH_DISTANCE
      || logs.size >= MAX_CONNECTED_LOG_SCAN_BLOCKS
    ) {
      complete = false;
      continue;
    }
    for (const offset of NEIGHBOR_OFFSETS) {
      const location = add(center.location, offset);
      const key = blockKey(location);
      if (queued.has(key)) continue;
      queued.add(key);
      const next = readBlock(location);
      if (next?.kind === "log" && logFamily(next) === family) {
        queue.push({ block: next, distance: wave.distance + 1 });
      }
    }
  }
  return { complete, logs };
}

export function collectCachedConnectedLogs(
  cachedLogs: ReadonlyMap<string, CapturedTreeBlock>,
  start: CapturedTreeBlock
): Map<string, CapturedTreeBlock> {
  const logs = new Map<string, CapturedTreeBlock>();
  const startKey = blockKey(start.location);
  const startFamily = logFamily(start);
  const queued = new Set([startKey]);
  const queue: ConnectedLogWave[] = [{ block: start, distance: 0 }];

  for (let index = 0; index < queue.length; index++) {
    const wave = queue[index]!;
    logs.set(blockKey(wave.block.location), wave.block);
    if (
      wave.distance >= MAX_CONNECTED_LOG_GRAPH_DISTANCE
      || logs.size >= MAX_CONNECTED_LOG_SCAN_BLOCKS
    ) continue;
    for (const offset of NEIGHBOR_OFFSETS) {
      const key = blockKey(add(wave.block.location, offset));
      if (queued.has(key)) continue;
      const next = cachedLogs.get(key);
      if (!next || logFamily(next) !== startFamily) continue;
      queued.add(key);
      queue.push({ block: next, distance: wave.distance + 1 });
    }
  }
  return logs;
}

export function cloneRootAnalysis(roots: RootAnalysis): RootAnalysis {
  return {
    markers: new Map(roots.markers),
    supportRoots: new Map(roots.supportRoots)
  };
}

export function topologyIndexKey(dimension: Dimension, location: Vector3): string {
  return `${dimension.id}|${blockKey(location)}`;
}

/**
 * Assigns every log/root block to its nearest root cluster via a multi-source
 * weighted Dijkstra (26-neighbor moves weighted by euclidean offset length).
 * Blocks whose best distances from two clusters differ by no more than
 * ROOT_DISTANCE_EPSILON are considered shared. Only blocks uniquely owned by
 * the broken log's cluster take part in the break, so grown-together trees
 * cannot tear each other's trunks down; a shared or unresolved target log
 * makes the whole tree unrecognized.
 */
function isolateRootOwnedTree(
  logs: ReadonlyMap<string, CapturedTreeBlock>,
  roots: RootAnalysis,
  targetLogKey: string
): TreeOwnership | undefined {
  const rootOwners = collectRootOwners(roots);
  if (rootOwners.length === 1) {
    return { logs: new Map(logs), roots };
  }

  const nodes = new Map<string, CapturedTreeBlock>();
  for (const [key, block] of logs) nodes.set(key, block);
  for (const [key, block] of roots.supportRoots) nodes.set(key, block);
  for (const [key, block] of roots.markers) nodes.set(key, block);

  const claims = new Map<string, RootClaim>();
  const queue: RootWave[] = [];
  for (const owner of rootOwners) {
    for (const marker of owner.markers) {
      claimRootNode(claims, queue, {
        distance: 0,
        key: blockKey(marker.location),
        owner: owner.key
      });
    }
  }

  while (queue.length > 0) {
    const wave = popRootWave(queue)!;
    const claim = claims.get(wave.key);
    const block = nodes.get(wave.key);
    if (
      !claim
      || !block
      || Math.abs(claim.distance - wave.distance) > ROOT_DISTANCE_EPSILON
      || !claim.owners.has(wave.owner)
    ) continue;
    for (const offset of WEIGHTED_NEIGHBOR_OFFSETS) {
      const key = blockKey(add(block.location, offset));
      if (!nodes.has(key)) continue;
      claimRootNode(claims, queue, {
        distance: wave.distance + offset.distance,
        key,
        owner: wave.owner
      });
    }
  }

  const targetClaim = claims.get(targetLogKey);
  if (!targetClaim || targetClaim.owners.size !== 1) return undefined;
  const targetOwner = targetClaim.owners.values().next().value;
  if (!targetOwner) return undefined;

  const ownedLogs = filterUniquelyOwnedBlocks(logs, claims, targetOwner);
  if (ownedLogs.size === 0) return undefined;
  return {
    logs: ownedLogs,
    roots: {
      markers: filterUniquelyOwnedBlocks(roots.markers, claims, targetOwner),
      supportRoots: filterUniquelyOwnedBlocks(roots.supportRoots, claims, targetOwner)
    }
  };
}

function collectRootOwners(roots: RootAnalysis): RootOwner[] {
  const rootNodes = new Map<string, CapturedTreeBlock>();
  for (const [key, block] of roots.markers) rootNodes.set(key, block);
  for (const [key, block] of roots.supportRoots) rootNodes.set(key, block);

  const visited = new Set<string>();
  const owners: RootOwner[] = [];
  for (const [startKey, start] of roots.markers) {
    if (visited.has(startKey)) continue;
    const queue = [start];
    const markers: CapturedTreeBlock[] = [];
    visited.add(startKey);
    for (let index = 0; index < queue.length; index++) {
      const block = queue[index];
      const key = blockKey(block.location);
      const marker = roots.markers.get(key);
      if (marker) markers.push(marker);
      for (const offset of NEIGHBOR_OFFSETS) {
        const neighborKey = blockKey(add(block.location, offset));
        const neighbor = rootNodes.get(neighborKey);
        if (!neighbor || visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        queue.push(neighbor);
      }
    }
    markers.sort((left, right) =>
      blockKey(left.location).localeCompare(blockKey(right.location))
    );
    owners.push({ key: blockKey(markers[0]!.location), markers });
  }
  owners.sort((left, right) => left.key.localeCompare(right.key));
  return owners;
}

function filterUniquelyOwnedBlocks(
  blocks: ReadonlyMap<string, CapturedTreeBlock>,
  claims: ReadonlyMap<string, RootClaim>,
  owner: string
): Map<string, CapturedTreeBlock> {
  const result = new Map<string, CapturedTreeBlock>();
  for (const [key, block] of blocks) {
    const claim = claims.get(key);
    if (claim?.owners.size === 1 && claim.owners.has(owner)) result.set(key, block);
  }
  return result;
}

function claimRootNode(
  claims: Map<string, RootClaim>,
  queue: RootWave[],
  wave: RootWave
): void {
  const current = claims.get(wave.key);
  if (current && current.distance < wave.distance - ROOT_DISTANCE_EPSILON) return;
  if (current && Math.abs(current.distance - wave.distance) <= ROOT_DISTANCE_EPSILON) {
    if (current.owners.has(wave.owner)) return;
    current.owners.add(wave.owner);
    pushRootWave(queue, wave);
    return;
  }
  claims.set(wave.key, { distance: wave.distance, owners: new Set([wave.owner]) });
  pushRootWave(queue, wave);
}

// The root-wave queue is a hand-rolled binary min-heap keyed on distance, so
// the ownership sweep pops waves in nondecreasing distance order (Dijkstra).

/** Sift-up insertion preserving the min-heap invariant. */
function pushRootWave(queue: RootWave[], wave: RootWave): void {
  queue.push(wave);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (queue[parent]!.distance <= wave.distance) break;
    queue[index] = queue[parent]!;
    index = parent;
  }
  queue[index] = wave;
}

/** Removes the minimum-distance wave, sifting the tail element down. */
function popRootWave(queue: RootWave[]): RootWave | undefined {
  const root = queue[0];
  const tail = queue.pop();
  if (!root || !tail || queue.length === 0) return root;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= queue.length) break;
    const right = left + 1;
    const child = right < queue.length && queue[right]!.distance < queue[left]!.distance
      ? right
      : left;
    if (queue[child]!.distance >= tail.distance) break;
    queue[index] = queue[child]!;
    index = child;
  }
  queue[index] = tail;
  return root;
}

export function analyzeRoots(
  readBlock: TreeBlockReader,
  logs: ReadonlyMap<string, CapturedTreeBlock>,
  family: string
): RootAnalysis {
  const markers = new Map<string, CapturedTreeBlock>();
  const supportRoots = new Map<string, CapturedTreeBlock>();

  for (const log of logs.values()) {
    const below = readBlock({
      x: log.location.x,
      y: log.location.y - 1,
      z: log.location.z
    });
    if (below?.typeId === NATURAL_TREE_ROOT_ID) markers.set(blockKey(below.location), below);
  }

  if (family !== "mangrove") return { markers, supportRoots };

  const queued = new Set<string>();
  const queue: CapturedTreeBlock[] = [];
  for (const log of logs.values()) {
    for (const offset of NEIGHBOR_OFFSETS) {
      const root = readBlock(add(log.location, offset));
      if (!root || !isMangroveRoot(root.typeId)) continue;
      const key = blockKey(root.location);
      if (queued.has(key)) continue;
      queued.add(key);
      queue.push(root);
    }
  }

  for (let index = 0; index < queue.length && index < MAX_MANGROVE_ROOT_BLOCKS; index++) {
    const root = queue[index];
    supportRoots.set(blockKey(root.location), root);
    for (const offset of NEIGHBOR_OFFSETS) {
      const next = readBlock(add(root.location, offset));
      if (!next) continue;
      const key = blockKey(next.location);
      if (next.typeId === NATURAL_TREE_ROOT_ID) {
        markers.set(key, next);
      } else if (isMangroveRoot(next.typeId) && !queued.has(key)) {
        queued.add(key);
        queue.push(next);
      }
    }
  }

  return { markers, supportRoots };
}

/** Filters the saved root graph without issuing any world block reads. */
export function analyzeCachedRoots(
  logs: ReadonlyMap<string, CapturedTreeBlock>,
  cached: RootAnalysis,
  family: string
): RootAnalysis {
  const markers = new Map<string, CapturedTreeBlock>();
  const supportRoots = new Map<string, CapturedTreeBlock>();

  for (const log of logs.values()) {
    const belowKey = blockKey({
      x: log.location.x,
      y: log.location.y - 1,
      z: log.location.z
    });
    const marker = cached.markers.get(belowKey);
    if (marker) markers.set(belowKey, marker);
  }
  if (family !== "mangrove") return { markers, supportRoots };

  const queued = new Set<string>();
  const queue: CapturedTreeBlock[] = [];
  for (const log of logs.values()) {
    for (const offset of NEIGHBOR_OFFSETS) {
      const key = blockKey(add(log.location, offset));
      const root = cached.supportRoots.get(key);
      if (!root || queued.has(key)) continue;
      queued.add(key);
      queue.push(root);
    }
  }

  for (let index = 0; index < queue.length && index < MAX_MANGROVE_ROOT_BLOCKS; index++) {
    const root = queue[index]!;
    supportRoots.set(blockKey(root.location), root);
    for (const offset of NEIGHBOR_OFFSETS) {
      const key = blockKey(add(root.location, offset));
      const marker = cached.markers.get(key);
      if (marker) {
        markers.set(key, marker);
        continue;
      }
      const next = cached.supportRoots.get(key);
      if (!next || queued.has(key)) continue;
      queued.add(key);
      queue.push(next);
    }
  }
  return { markers, supportRoots };
}

function splitLogComponents(
  fullLogs: ReadonlyMap<string, CapturedTreeBlock>,
  ignoredKey: string
): LogComponent[] {
  const remaining = new Map(fullLogs);
  remaining.delete(ignoredKey);
  const visited = new Set<string>();
  const components: LogComponent[] = [];

  for (const start of remaining.values()) {
    const startKey = blockKey(start.location);
    if (visited.has(startKey)) continue;
    const logs: CapturedTreeBlock[] = [];
    const queue = [start];
    visited.add(startKey);
    for (let index = 0; index < queue.length; index++) {
      const center = queue[index];
      logs.push(center);
      for (const offset of NEIGHBOR_OFFSETS) {
        const key = blockKey(add(center.location, offset));
        const next = remaining.get(key);
        if (!next || visited.has(key)) continue;
        visited.add(key);
        queue.push(next);
      }
    }
    components.push({ anchored: false, index: components.length, logs });
  }
  return components;
}

function isComponentAnchored(component: LogComponent, roots: RootAnalysis): boolean {
  for (const log of component.logs) {
    const belowKey = blockKey({ x: log.location.x, y: log.location.y - 1, z: log.location.z });
    if (roots.markers.has(belowKey)) return true;
    for (const offset of NEIGHBOR_OFFSETS) {
      if (roots.supportRoots.has(blockKey(add(log.location, offset)))) return true;
    }
  }
  return false;
}

function collectLeaves(
  dimension: Dimension,
  components: readonly LogComponent[],
  artificialRegistry: ArtificialTreeRegistry,
  readBlock: TreeBlockReader
): Map<string, OwnedLeafClaim> {
  const candidates = collectCandidateLeaves(
    dimension,
    components,
    artificialRegistry,
    readBlock
  );
  const supportDistances = createLeafSupportDistanceField(candidates, readBlock);
  const claims = new Map<string, OwnedLeafClaim>();
  const queue: LeafWave[] = [];

  for (const component of components) {
    for (const log of component.logs) {
      for (const offset of NEIGHBOR_OFFSETS) {
        const candidate = candidates.get(blockKey(add(log.location, offset)));
        if (!candidate) continue;
        claimLeaf(claims, queue, {
          block: candidate.block,
          distance: 1,
          family: candidate.family,
          owner: component.index
        });
      }
    }
  }

  for (let index = 0; index < queue.length; index++) {
    const claim = queue[index];
    const current = claims.get(blockKey(claim.block.location));
    if (
      !current
      || current.distance !== claim.distance
      || current.owner !== claim.owner
    ) continue;
    if (claim.distance >= MAX_LEAF_DISTANCE) continue;
    for (const offset of NEIGHBOR_OFFSETS) {
      const key = blockKey(add(claim.block.location, offset));
      const candidate = candidates.get(key);
      if (!candidate || candidate.family !== claim.family) continue;
      if (supportDistances && !isIncreasingLeafSupportDistance(
        claim.block,
        candidate.block,
        supportDistances
      )) continue;
      claimLeaf(claims, queue, {
        block: candidate.block,
        distance: claim.distance + 1,
        family: claim.family,
        owner: claim.owner
      });
    }
  }

  const owned = [...claims.entries()];
  owned.sort((left, right) =>
    left[1].distance - right[1].distance || left[0].localeCompare(right[0])
  );
  return new Map(owned);
}

function collectCandidateLeaves(
  dimension: Dimension,
  components: readonly LogComponent[],
  artificialRegistry: ArtificialTreeRegistry,
  readBlock: TreeBlockReader
): Map<string, CandidateLeafClaim> {
  const candidates = new Map<string, CandidateLeafClaim>();
  const queue: CandidateLeafClaim[] = [];

  for (const component of components) {
    for (const log of component.logs) {
      for (const offset of NEIGHBOR_OFFSETS) {
        const leaf = readBlock(add(log.location, offset));
        if (!isSelectableLeaf(dimension, leaf, artificialRegistry)) continue;
        claimCandidateLeaf(candidates, queue, {
          block: leaf,
          distance: 1,
          family: leafFamily(leaf)
        });
      }
    }
  }

  for (let index = 0; index < queue.length; index++) {
    const claim = queue[index]!;
    const current = candidates.get(blockKey(claim.block.location));
    if (!current || current.distance !== claim.distance) continue;
    if (claim.distance >= MAX_LEAF_DISTANCE) continue;
    for (const offset of NEIGHBOR_OFFSETS) {
      const leaf = readBlock(add(claim.block.location, offset));
      if (
        !isSelectableLeaf(dimension, leaf, artificialRegistry)
        || leafFamily(leaf) !== claim.family
      ) continue;
      claimCandidateLeaf(candidates, queue, {
        block: leaf,
        distance: claim.distance + 1,
        family: claim.family
      });
    }
  }

  return candidates;
}

function claimCandidateLeaf(
  candidates: Map<string, CandidateLeafClaim>,
  queue: CandidateLeafClaim[],
  claim: CandidateLeafClaim
): void {
  const key = blockKey(claim.block.location);
  const current = candidates.get(key);
  if (current && current.distance <= claim.distance) return;
  if (!current && candidates.size >= MAX_RAW_LEAF_SCAN_BLOCKS) return;
  candidates.set(key, claim);
  queue.push(claim);
}

function isSelectableLeaf(
  dimension: Dimension,
  block: CapturedTreeBlock | undefined,
  artificialRegistry: ArtificialTreeRegistry
): block is CapturedTreeBlock {
  return block?.kind === "leaf"
    && !isPersistentLeaf(block)
    && !artificialRegistry.has(dimension, block.location);
}

/**
 * Vanilla-style leaf support distances used to stop claims from walking into
 * foliage that is still held up by a standing log. Three phases: (1) flood
 * outward from the candidates through every leaf (including leaves of other
 * trees) to gather the relevant neighborhood, seeding distance 1 at leaves
 * orthogonally touching any log; (2) relax distances by +1 per orthogonal
 * step across that neighborhood; (3) report distances for the candidates,
 * with MAX_LEAF_DISTANCE + 1 as the "unsupported" sentinel for leaves no log
 * can reach. Returns undefined when the field would be too large to build.
 */
function createLeafSupportDistanceField(
  candidates: ReadonlyMap<string, CandidateLeafClaim>,
  readBlock: TreeBlockReader
): Map<string, number> | undefined {
  if (candidates.size === 0 || candidates.size > MAX_LEAF_DISTANCE_FIELD_BLOCKS) {
    return undefined;
  }

  const supportLeaves = new Map<string, CapturedTreeBlock>();
  const scanQueue: LeafDistanceFieldWave[] = [];
  for (const candidate of candidates.values()) {
    const key = blockKey(candidate.block.location);
    if (supportLeaves.has(key)) continue;
    supportLeaves.set(key, candidate.block);
    scanQueue.push({ block: candidate.block, expansionDistance: 0 });
  }

  const distances = new Map<string, number>();
  for (let index = 0; index < scanQueue.length; index++) {
    const wave = scanQueue[index]!;
    const key = blockKey(wave.block.location);
    for (const offset of ORTHOGONAL_NEIGHBOR_OFFSETS) {
      const neighbor = readBlock(add(wave.block.location, offset));
      if (neighbor?.kind === "log") {
        distances.set(key, 1);
        continue;
      }
      if (neighbor?.kind !== "leaf" || wave.expansionDistance >= MAX_LEAF_DISTANCE) {
        continue;
      }
      const neighborKey = blockKey(neighbor.location);
      if (supportLeaves.has(neighborKey)) continue;
      if (supportLeaves.size >= MAX_LEAF_DISTANCE_FIELD_BLOCKS) return undefined;
      supportLeaves.set(neighborKey, neighbor);
      scanQueue.push({
        block: neighbor,
        expansionDistance: wave.expansionDistance + 1
      });
    }
  }

  const distanceQueue = [...distances.keys()];
  for (let index = 0; index < distanceQueue.length; index++) {
    const key = distanceQueue[index]!;
    const block = supportLeaves.get(key)!;
    const distance = distances.get(key)!;
    if (distance >= MAX_LEAF_DISTANCE + 1) continue;
    for (const offset of ORTHOGONAL_NEIGHBOR_OFFSETS) {
      const neighborKey = blockKey(add(block.location, offset));
      if (!supportLeaves.has(neighborKey)) continue;
      const nextDistance = distance + 1;
      const currentDistance = distances.get(neighborKey);
      if (currentDistance !== undefined && currentDistance <= nextDistance) continue;
      distances.set(neighborKey, nextDistance);
      distanceQueue.push(neighborKey);
    }
  }

  const result = new Map<string, number>();
  for (const key of candidates.keys()) {
    result.set(key, distances.get(key) ?? MAX_LEAF_DISTANCE + 1);
  }
  return result;
}

function isIncreasingLeafSupportDistance(
  from: CapturedTreeBlock,
  to: CapturedTreeBlock,
  distances: ReadonlyMap<string, number>
): boolean {
  const fromDistance = distances.get(blockKey(from.location)) ?? MAX_LEAF_DISTANCE + 1;
  const toDistance = distances.get(blockKey(to.location)) ?? MAX_LEAF_DISTANCE + 1;
  return toDistance > fromDistance;
}

function claimLeaf(
  claims: Map<string, OwnedLeafClaim>,
  queue: LeafWave[],
  claim: LeafWave
): void {
  const key = blockKey(claim.block.location);
  const current = claims.get(key);
  // Closest component wins a leaf; on equal distance the lowest component
  // index wins, so ownership is deterministic regardless of scan order.
  if (current && (
    current.distance < claim.distance
    || (current.distance === claim.distance && current.owner <= claim.owner)
  )) return;
  claims.set(key, claim);
  queue.push(claim);
}

function collectAttachments(
  dimension: Dimension,
  components: readonly LogComponent[],
  leaves: ReadonlyMap<string, OwnedLeafClaim>,
  artificialRegistry: ArtificialTreeRegistry,
  readBlock: TreeBlockReader
): Map<string, AttachmentClaim> {
  const claims = new Map<string, AttachmentClaim>();
  const sourceOwners = new Map<string, number>();
  for (const component of components) {
    for (const log of component.logs) {
      const key = blockKey(log.location);
      if (!sourceOwners.has(key)) sourceOwners.set(key, component.index);
    }
    for (const leaf of leaves.values()) {
      if (leaf.owner !== component.index) continue;
      const key = blockKey(leaf.block.location);
      if (!sourceOwners.has(key)) sourceOwners.set(key, component.index);
    }
  }

  // Candidate-leaf expansion already read every source neighborhood except the
  // outermost wave. Fill that boundary, then invert the cached attachment scan.
  for (const leaf of leaves.values()) {
    if (leaf.distance < MAX_LEAF_DISTANCE) continue;
    for (const offset of NEIGHBOR_OFFSETS) readBlock(add(leaf.block.location, offset));
  }

  for (const block of readBlock.capturedBlocks()) {
    if (block.kind !== "attachment") continue;
    let owner: number | undefined;
    for (const offset of NEIGHBOR_OFFSETS) {
      const sourceOwner = sourceOwners.get(blockKey(add(block.location, offset)));
      if (sourceOwner === undefined || (owner !== undefined && owner <= sourceOwner)) continue;
      owner = sourceOwner;
    }
    if (owner === undefined || artificialRegistry.has(dimension, block.location)) continue;
    const key = blockKey(block.location);
    if (!claims.has(key)) claims.set(key, { block, owner });
  }
  return claims;
}

export function createTreeBlockReader(
  dimension: Dimension,
  initialBlocks: readonly CapturedTreeBlock[] = []
): TreeBlockReader {
  const cache = new Map<string, CapturedTreeBlock | undefined>();
  for (const block of initialBlocks) cache.set(blockKey(block.location), block);
  const reader = ((location: Vector3): CapturedTreeBlock | undefined => {
    const key = blockKey(location);
    if (cache.has(key)) return cache.get(key);
    const block = readTreeBlock(dimension, location);
    cache.set(key, block);
    return block;
  }) as TreeBlockReader;
  reader.capturedBlocks = function* (): Iterable<CapturedTreeBlock> {
    for (const block of cache.values()) {
      if (block) yield block;
    }
  };
  return reader;
}

function readTreeBlock(
  dimension: Dimension,
  location: Vector3
): CapturedTreeBlock | undefined {
  const block = safeGetBlock(dimension, location);
  return block ? captureTreeBlock(block) : undefined;
}

const WEIGHTED_NEIGHBOR_OFFSETS = NEIGHBOR_OFFSETS.map(offset => ({
  ...offset,
  distance: Math.hypot(offset.x, offset.y, offset.z)
}));

const ROOT_DISTANCE_EPSILON = EPSILON_1E6;
