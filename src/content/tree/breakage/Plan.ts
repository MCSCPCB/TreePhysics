import type { Vector3 } from "@minecraft/server";
import { blockKey as coordinateKey } from "@src/utils/BlockKey";
import { hasNeighborKey, NEIGHBOR_OFFSETS } from "@src/utils/Neighborhood";
import { squaredDistance } from "@src/utils/Vector3Math";
import {
  compareBlocks,
  deterministicShuffle,
  isIntegerVector,
  mix,
  normalizeSeed,
  trunkColumnKey
} from "@src/content/tree/breakage/Utils";
import {
  getTreeLogImpactDamage,
  collectConnectedKeys,
  pruneTreeLogBreakagePlan,
  resolveTreeLogBreakage,
  TREE_LOG_BREAKAGE_MIN_IMPACT_SPEED
} from "@src/content/tree/breakage/Resolve";

export {
  getTreeLogImpactDamage,
  collectConnectedKeys,
  pruneTreeLogBreakagePlan,
  resolveTreeLogBreakage,
  TREE_LOG_BREAKAGE_MIN_IMPACT_SPEED
};

const MINIMUM_FULL_TRUNK_LAYERS = 4;
const MINIMUM_FANCY_OAK_TRUNK_LAYERS = 4;
const MINIMUM_FANCY_OAK_BRANCH_LOGS = 2;
const MINIMUM_FANCY_OAK_BRANCH_RADIUS = 2;
const GIANT_SPRUCE_PROTECTED_TRUNK_LAYERS = 6;
const MAXIMUM_BRANCH_GROUPS = 4;
const MAXIMUM_TRUNK_BANDS = 4;

export type TreeLogBreakGroupKind = "branch" | "crosscut" | "trunk";

export interface TreeLogBreakageBlock {
  readonly family: string;
  readonly key: string;
  readonly localLocation: Vector3;
}
export interface TreeLogBreakGroup {
  readonly bandId?: number;
  readonly id: number;
  readonly keys: readonly string[];
  readonly kind: TreeLogBreakGroupKind;
}
export interface TreeLogBreakagePlan {
  readonly anchorKey?: string;
  readonly breakGroups: readonly TreeLogBreakGroup[];
  readonly eligible: boolean;
  readonly maximumLever: number;
  readonly protectedKeys: ReadonlySet<string>;
  readonly seed: number;
}

export interface TreeLogBreakageResolution {
  readonly cost: number;
  readonly groupId: number;
  readonly removedKeys: ReadonlySet<string>;
}

export interface RestoreTreeLogBreakageOptions {
  readonly anchorKey?: string;
  readonly breakGroups?: readonly {
    readonly bandId?: number;
    readonly keys: readonly string[];
    readonly kind: TreeLogBreakGroupKind;
  }[];
  readonly maximumLever?: number;
  readonly protectedKeys?: readonly string[];
  readonly seed?: number;
}

interface TrunkFootprint {
  readonly columns: readonly TrunkColumn[];
  readonly fullBottomY: number;
  readonly fullTopY: number;
  readonly minX: number;
  readonly minZ: number;
}

interface TrunkColumn {
  readonly x: number;
  readonly z: number;
}

interface TrunkSpine {
  readonly bottomY: number;
  readonly topY: number;
  readonly x: number;
  readonly z: number;
}

export function createTreeLogBreakagePlan(
  inputBlocks: readonly TreeLogBreakageBlock[],
  options: {
    readonly anchorLocation: Vector3;
    readonly inferFamilyFromStructure?: boolean;
    readonly seed: string | number;
  }
): TreeLogBreakagePlan {
  const blocks = normalizeBlocks(inputBlocks);
  if (blocks.length === 0) return disabledPlan();
  if (options.inferFamilyFromStructure) {
    return createExternalTreeBreakagePlan(blocks, options);
  }
  if (blocks.every(block => block.family === "jungle")) {
    return createGiantJungleBreakagePlan(blocks, options);
  }
  if (blocks.every(block => block.family === "spruce")) {
    return createGiantSpruceBreakagePlan(blocks, options);
  }
  if (blocks.every(block => block.family === "oak")) {
    return createFancyOakBreakagePlan(blocks, options);
  }
  return disabledPlan();
}

/** Routes external logs through the existing vanilla algorithms using only tree structure. */
function createExternalTreeBreakagePlan(
  blocks: readonly TreeLogBreakageBlock[],
  options: { readonly anchorLocation: Vector3; readonly seed: string | number }
): TreeLogBreakagePlan {
  const footprint = findExternalGiantTrunkFootprint(blocks);
  if (footprint) {
    const hasBranches = blocks.some(block => !isInsideFootprint(block.localLocation, footprint));
    return hasBranches
      ? createGiantJungleBreakagePlan(blocks, options, footprint)
      : createGiantSpruceBreakagePlan(blocks, options, footprint);
  }
  return createFancyOakBreakagePlan(blocks, options);
}

function createGiantJungleBreakagePlan(
  blocks: readonly TreeLogBreakageBlock[],
  options: { readonly anchorLocation: Vector3; readonly seed: string | number },
  resolvedFootprint?: TrunkFootprint
): TreeLogBreakagePlan {
  const coordinateIndex = createCoordinateIndex(blocks);
  const footprint = resolvedFootprint ?? findGiantTrunkFootprint(blocks, coordinateIndex);
  if (!footprint) return disabledPlan();

  const anchorKey = resolveAnchorKey(blocks, footprint, options.anchorLocation);
  if (!anchorKey) return disabledPlan();
  const anchor = blocks.find(block => block.key === anchorKey)!.localLocation;
  const protectedTopY = Math.max(footprint.fullBottomY + 1, anchor.y + 1);
  const protectedKeys = new Set(
    blocks
      .filter(block => isInsideFootprint(block.localLocation, footprint)
        && block.localLocation.y <= protectedTopY)
      .map(block => block.key)
  );
  protectedKeys.add(anchorKey);

  const seed = normalizeSeed(options.seed);
  const groups: Omit<TreeLogBreakGroup, "id">[] = [];
  groups.push(...createBranchGroups(blocks, footprint, protectedKeys, seed));
  groups.push(...createTrunkGroups(
    blocks,
    coordinateIndex,
    footprint,
    protectedTopY,
    seed,
    "trunk"
  ));
  const breakGroups = groups.map((group, id): TreeLogBreakGroup => ({ ...group, id }));
  if (breakGroups.length === 0) return disabledPlan();

  return {
    anchorKey,
    breakGroups,
    eligible: true,
    maximumLever: computeMaximumLever(blocks, anchor),
    protectedKeys,
    seed
  };
}

function createGiantSpruceBreakagePlan(
  blocks: readonly TreeLogBreakageBlock[],
  options: { readonly anchorLocation: Vector3; readonly seed: string | number },
  resolvedFootprint?: TrunkFootprint
): TreeLogBreakagePlan {
  const coordinateIndex = createCoordinateIndex(blocks);
  const footprint = resolvedFootprint ?? findGiantTrunkFootprint(blocks, coordinateIndex);
  if (!footprint) return disabledPlan();

  const anchorKey = resolveAnchorKey(blocks, footprint, options.anchorLocation);
  if (!anchorKey) return disabledPlan();
  const anchor = blocks.find(block => block.key === anchorKey)!.localLocation;
  const protectedTopY = footprint.fullBottomY + GIANT_SPRUCE_PROTECTED_TRUNK_LAYERS - 1;
  const protectedKeys = new Set(
    blocks
      .filter(block => isInsideFootprint(block.localLocation, footprint)
        && block.localLocation.y <= protectedTopY)
      .map(block => block.key)
  );
  protectedKeys.add(anchorKey);

  const seed = normalizeSeed(options.seed);
  const groups = createTrunkGroups(
    blocks,
    coordinateIndex,
    footprint,
    protectedTopY,
    seed,
    "crosscut"
  );
  const breakGroups = groups.map((group, id): TreeLogBreakGroup => ({ ...group, id }));
  if (breakGroups.length === 0) return disabledPlan();

  return {
    anchorKey,
    breakGroups,
    eligible: true,
    maximumLever: computeMaximumLever(blocks, anchor),
    protectedKeys,
    seed
  };
}

function createFancyOakBreakagePlan(
  blocks: readonly TreeLogBreakageBlock[],
  options: { readonly anchorLocation: Vector3; readonly seed: string | number }
): TreeLogBreakagePlan {
  const spine = findFancyOakSpine(blocks, options.anchorLocation);
  if (!spine) return disabledPlan();
  const spineBlocks = blocks.filter(block => isInsideSpine(block.localLocation, spine));
  const protectedKeys = new Set(spineBlocks.map(block => block.key));
  const anchorKey = resolveSpineAnchorKey(spineBlocks, options.anchorLocation);
  if (!anchorKey) return disabledPlan();
  protectedKeys.add(anchorKey);

  const branchBlocks = blocks.filter(block => !protectedKeys.has(block.key));
  if (
    branchBlocks.length < MINIMUM_FANCY_OAK_BRANCH_LOGS
    || branchBlocks.some(block => block.localLocation.y <= spine.bottomY)
    || maximumHorizontalDistance(branchBlocks, spine) < MINIMUM_FANCY_OAK_BRANCH_RADIUS
  ) return disabledPlan();
  const allKeys = new Set(blocks.map(block => block.key));
  if (collectConnectedKeys(anchorKey, allKeys).size !== allKeys.size) return disabledPlan();

  const seed = normalizeSeed(options.seed);
  const branchGroups = createFancyOakBranchGroups(
    branchBlocks,
    protectedKeys,
    spine,
    seed
  );
  if (branchGroups.length === 0) return disabledPlan();
  const anchor = blocks.find(block => block.key === anchorKey)!.localLocation;
  return {
    anchorKey,
    breakGroups: branchGroups.map((group, id): TreeLogBreakGroup => ({ ...group, id })),
    eligible: true,
    maximumLever: computeMaximumLever(blocks, anchor),
    protectedKeys,
    seed
  };
}

export function restoreTreeLogBreakagePlan(
  inputBlocks: readonly TreeLogBreakageBlock[],
  options: RestoreTreeLogBreakageOptions
): TreeLogBreakagePlan {
  if (
    options.anchorKey === undefined
    || options.breakGroups === undefined
    || options.protectedKeys === undefined
    || options.seed === undefined
  ) return disabledPlan();

  const blocks = normalizeBlocks(inputBlocks);
  const keyIndex = new Map(blocks.map((block, index) => [block.key, index]));
  if (!keyIndex.has(options.anchorKey)) throw new RangeError("Saved log anchor is missing.");
  const protectedKeys = new Set(options.protectedKeys);
  if (!protectedKeys.has(options.anchorKey)) {
    throw new RangeError("Saved log protection must contain the anchor.");
  }
  for (const key of protectedKeys) {
    if (!keyIndex.has(key)) throw new RangeError("Saved protected log is missing.");
  }

  const claimedKeys = new Set<string>();
  const breakGroups = options.breakGroups.map((saved, id): TreeLogBreakGroup => {
    if (saved.kind !== "branch" && saved.kind !== "crosscut" && saved.kind !== "trunk") {
      throw new RangeError("Saved log break group kind is invalid.");
    }
    if (saved.kind !== "branch" && !Number.isInteger(saved.bandId)) {
      throw new RangeError("Saved structural break group must have a band id.");
    }
    if (saved.kind === "branch" && saved.bandId !== undefined) {
      throw new RangeError("Saved branch break group must not have a band id.");
    }
    if (saved.keys.length === 0) throw new RangeError("Saved log break group is empty.");
    const keys = [...saved.keys];
    for (const key of keys) {
      if (!keyIndex.has(key) || protectedKeys.has(key) || claimedKeys.has(key)) {
        throw new RangeError("Saved log break groups are inconsistent with current logs.");
      }
      claimedKeys.add(key);
    }
    return { bandId: saved.bandId, id, keys, kind: saved.kind };
  });
  const anchor = blocks[keyIndex.get(options.anchorKey)!]!.localLocation;
  return {
    anchorKey: options.anchorKey,
    breakGroups,
    eligible: breakGroups.length > 0,
    maximumLever: normalizeMaximumLever(options.maximumLever)
      ?? computeMaximumLever(blocks, anchor),
    protectedKeys,
    seed: normalizeSeed(options.seed)
  };
}

function createBranchGroups(
  blocks: readonly TreeLogBreakageBlock[],
  footprint: TrunkFootprint,
  protectedKeys: ReadonlySet<string>,
  seed: number
): Omit<TreeLogBreakGroup, "id">[] {
  const branchBlocks = blocks.filter(block =>
    !isInsideFootprint(block.localLocation, footprint) && !protectedKeys.has(block.key)
  );
  if (branchBlocks.length === 0) return [];
  const components = findComponents(branchBlocks);
  deterministicShuffle(components, mix(seed, 0x41c64e6d));
  const binCount = Math.min(MAXIMUM_BRANCH_GROUPS, components.length);
  const bins = Array.from({ length: binCount }, () => [] as string[]);
  const sizes = new Uint32Array(binCount);
  for (const component of components.sort((left, right) => right.length - left.length)) {
    let selected = 0;
    for (let index = 1; index < bins.length; index++) {
      if (sizes[index]! < sizes[selected]!) selected = index;
    }
    bins[selected]!.push(...component.map(block => block.key));
    sizes[selected] += component.length;
  }
  deterministicShuffle(bins, mix(seed, 0x9e3779b9));
  return bins
    .filter(keys => keys.length > 0)
    .map(keys => ({
      keys: keys.sort(),
      kind: "branch" as const
    }));
}

function createFancyOakBranchGroups(
  branchBlocks: readonly TreeLogBreakageBlock[],
  protectedKeys: ReadonlySet<string>,
  spine: TrunkSpine,
  seed: number
): Omit<TreeLogBreakGroup, "id">[] {
  const branchByKey = new Map(branchBlocks.map(block => [block.key, block]));
  const labels = new Map<string, number>();
  const queue: string[] = [];
  for (const block of branchBlocks) {
    if (!hasNeighborKey(block.localLocation, protectedKeys)) continue;
    labels.set(block.key, radialBranchLabel(block.localLocation, spine));
    queue.push(block.key);
  }
  if (queue.length === 0) return [];
  queue.sort();

  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]!;
    const block = branchByKey.get(key)!;
    const label = labels.get(key)!;
    for (const offset of NEIGHBOR_OFFSETS) {
      const neighborKey = coordinateKey({
        x: block.localLocation.x + offset.x,
        y: block.localLocation.y + offset.y,
        z: block.localLocation.z + offset.z
      });
      if (!branchByKey.has(neighborKey) || labels.has(neighborKey)) continue;
      labels.set(neighborKey, label);
      queue.push(neighborKey);
    }
  }

  const bins = new Map<number, string[]>();
  for (const block of branchBlocks) {
    const label = labels.get(block.key) ?? radialBranchLabel(block.localLocation, spine);
    let keys = bins.get(label);
    if (!keys) bins.set(label, keys = []);
    keys.push(block.key);
  }
  const groups = [...bins.values()]
    .filter(keys => keys.length > 0)
    .map(keys => ({ keys: keys.sort(), kind: "branch" as const }));
  deterministicShuffle(groups, mix(seed, 0x7f4a7c15));
  return groups.slice(0, MAXIMUM_BRANCH_GROUPS);
}

function radialBranchLabel(location: Vector3, spine: TrunkSpine): number {
  const dx = location.x - spine.x;
  const dz = location.z - spine.z;
  if (Math.abs(dx) >= Math.abs(dz)) return dx < 0 ? 0 : 1;
  return dz < 0 ? 2 : 3;
}

function createTrunkGroups(
  blocks: readonly TreeLogBreakageBlock[],
  coordinateIndex: ReadonlyMap<string, number>,
  footprint: TrunkFootprint,
  protectedTopY: number,
  seed: number,
  kind: Extract<TreeLogBreakGroupKind, "crosscut" | "trunk">
): Omit<TreeLogBreakGroup, "id">[] {
  const span = footprint.fullTopY - protectedTopY;
  if (span < 4) return [];
  const spacing = Math.max(3, Math.ceil(span / (MAXIMUM_TRUNK_BANDS + 1)));
  const centers: number[] = [];
  for (
    let center = footprint.fullTopY - spacing;
    center >= protectedTopY + 2 && centers.length < MAXIMUM_TRUNK_BANDS;
    center -= spacing
  ) centers.push(center);

  const result: Omit<TreeLogBreakGroup, "id">[] = [];
  for (let bandId = 0; bandId < centers.length; bandId++) {
    const centerY = centers[bandId]!;
    const random = mix(seed, bandId + 1);
    const splitX = (random & 1) === 0;
    const firstSideIsMinimum = (random & 2) === 0;
    const columns = footprint.columns;
    const first = columns.filter(column => (
      splitX ? column.x === footprint.minX : column.z === footprint.minZ
    ) === firstSideIsMinimum);
    const second = columns.filter(column => !first.includes(column));
    for (const [sideIndex, side] of [first, second].entries()) {
      const keys = new Set<string>();
      for (let columnIndex = 0; columnIndex < side.length; columnIndex++) {
        const column = side[columnIndex]!;
        const centerKey = coordinateKey({ x: column.x, y: centerY, z: column.z });
        if (coordinateIndex.has(centerKey)) keys.add(blocks[coordinateIndex.get(centerKey)!]!.key);
        const direction = (mix(random, sideIndex * 2 + columnIndex + 11) & 1) === 0 ? -1 : 1;
        const jaggedY = centerY + direction;
        if (jaggedY <= protectedTopY || jaggedY > footprint.fullTopY) continue;
        const jaggedKey = coordinateKey({ x: column.x, y: jaggedY, z: column.z });
        if (coordinateIndex.has(jaggedKey)) keys.add(blocks[coordinateIndex.get(jaggedKey)!]!.key);
      }
      if (keys.size > 0) {
        result.push({ bandId, keys: [...keys].sort(), kind });
      }
    }
  }
  return result;
}

function findGiantTrunkFootprint(
  blocks: readonly TreeLogBreakageBlock[],
  coordinateIndex: ReadonlyMap<string, number>
): TrunkFootprint | undefined {
  let best: TrunkFootprint | undefined;
  for (const minX of [-1, 0]) {
    for (const minZ of [-1, 0]) {
      const columns = rectangularTrunkColumns(minX, minZ);
      const occupiedLevels = new Set<number>();
      for (const block of blocks) {
        const y = block.localLocation.y;
        if (columns.every(column =>
          coordinateIndex.has(coordinateKey({ x: column.x, y, z: column.z }))
        )) occupiedLevels.add(y);
      }
      const levels = [...occupiedLevels].sort((left, right) => left - right);
      let start = 0;
      for (let index = 0; index <= levels.length; index++) {
        if (index < levels.length && (index === start || levels[index] === levels[index - 1]! + 1)) {
          continue;
        }
        const count = index - start;
        if (count >= MINIMUM_FULL_TRUNK_LAYERS) {
          const candidate: TrunkFootprint = {
            columns,
            fullBottomY: levels[start]!,
            fullTopY: levels[index - 1]!,
            minX,
            minZ
          };
          if (!best || trunkLength(candidate) > trunkLength(best)
            || (trunkLength(candidate) === trunkLength(best)
              && footprintScore(candidate) < footprintScore(best))) best = candidate;
        }
        start = index;
      }
    }
  }
  return best;
}

/** Finds a stable face-connected trunk section without assuming a rectangular shape. */
function findExternalGiantTrunkFootprint(
  blocks: readonly TreeLogBreakageBlock[]
): TrunkFootprint | undefined {
  const columnsByLevel = new Map<number, Set<string>>();
  for (const block of blocks) {
    let columns = columnsByLevel.get(block.localLocation.y);
    if (!columns) columnsByLevel.set(block.localLocation.y, columns = new Set());
    columns.add(trunkColumnKey(block.localLocation));
  }
  const levels = [...columnsByLevel.keys()].sort((left, right) => left - right);
  let best: TrunkFootprint | undefined;
  for (let start = 0; start < levels.length; start++) {
    const stableColumns = new Set(columnsByLevel.get(levels[start]!)!);
    for (let end = start; end < levels.length; end++) {
      if (end > start) {
        if (levels[end] !== levels[end - 1]! + 1) break;
        intersectSets(stableColumns, columnsByLevel.get(levels[end]!)!);
      }
      const columns = connectedTrunkColumns(stableColumns);
      if (columns.length < 4) break;
      if (end - start + 1 < MINIMUM_FULL_TRUNK_LAYERS) continue;
      const candidate: TrunkFootprint = {
        columns,
        fullBottomY: levels[start]!,
        fullTopY: levels[end]!,
        minX: Math.min(...columns.map(column => column.x)),
        minZ: Math.min(...columns.map(column => column.z))
      };
      if (!best || trunkLength(candidate) > trunkLength(best)
        || (trunkLength(candidate) === trunkLength(best)
          && (candidate.columns.length > best.columns.length
            || (candidate.columns.length === best.columns.length
              && footprintScore(candidate) < footprintScore(best))))) best = candidate;
    }
  }
  return best;
}

/** Finds the face-connected stable trunk section containing the chopped column. */
function connectedTrunkColumns(columnKeys: ReadonlySet<string>): TrunkColumn[] {
  const remaining = new Set(columnKeys);
  let best: TrunkColumn[] = [];
  const offsets = [
    { x: -1, z: 0 },
    { x: 1, z: 0 },
    { x: 0, z: -1 },
    { x: 0, z: 1 }
  ];
  while (remaining.size > 0) {
    const startKey = remaining.values().next().value as string;
    const [startX, startZ] = startKey.split(",").map(Number);
    const visited = new Set([startKey]);
    const queue: TrunkColumn[] = [{ x: startX!, z: startZ! }];
    remaining.delete(startKey);
    for (let index = 0; index < queue.length; index++) {
      const column = queue[index]!;
      for (const offset of offsets) {
        const neighbor = { x: column.x + offset.x, z: column.z + offset.z };
        const key = trunkColumnKey(neighbor);
        if (!remaining.has(key)) continue;
        remaining.delete(key);
        visited.add(key);
        queue.push(neighbor);
      }
    }
    if (queue.length > best.length) best = queue;
  }
  return best.sort((left, right) => left.z - right.z || left.x - right.x);
}

function intersectSets(target: Set<string>, values: ReadonlySet<string>): void {
  for (const value of target) {
    if (!values.has(value)) target.delete(value);
  }
}

function rectangularTrunkColumns(minX: number, minZ: number): readonly TrunkColumn[] {
  return [
    { x: minX, z: minZ },
    { x: minX + 1, z: minZ },
    { x: minX, z: minZ + 1 },
    { x: minX + 1, z: minZ + 1 }
  ];
}

function findFancyOakSpine(
  blocks: readonly TreeLogBreakageBlock[],
  requested: Vector3
): TrunkSpine | undefined {
  if (!Number.isInteger(requested.x) || !Number.isInteger(requested.z)) return undefined;
  const levels = blocks
    .filter(block => block.localLocation.x === requested.x && block.localLocation.z === requested.z)
    .map(block => block.localLocation.y)
    .sort((left, right) => left - right);
  let best: TrunkSpine | undefined;
  let start = 0;
  for (let index = 0; index <= levels.length; index++) {
    if (index < levels.length && (index === start || levels[index] === levels[index - 1]! + 1)) {
      continue;
    }
    if (index - start >= MINIMUM_FANCY_OAK_TRUNK_LAYERS) {
      const candidate: TrunkSpine = {
        bottomY: levels[start]!,
        topY: levels[index - 1]!,
        x: requested.x,
        z: requested.z
      };
      if (
        requested.y >= candidate.bottomY
        && requested.y <= candidate.topY
        && (!best || candidate.topY - candidate.bottomY > best.topY - best.bottomY)
      ) best = candidate;
    }
    start = index;
  }
  return best;
}

function isInsideSpine(location: Vector3, spine: TrunkSpine): boolean {
  return location.x === spine.x && location.z === spine.z;
}

function resolveSpineAnchorKey(
  spineBlocks: readonly TreeLogBreakageBlock[],
  requested: Vector3
): string | undefined {
  return [...spineBlocks].sort((left, right) =>
    squaredDistance(left.localLocation, requested) - squaredDistance(right.localLocation, requested)
    || compareBlocks(left, right)
  )[0]?.key;
}

function maximumHorizontalDistance(
  blocks: readonly TreeLogBreakageBlock[],
  spine: TrunkSpine
): number {
  let maximum = 0;
  for (const block of blocks) {
    maximum = Math.max(
      maximum,
      Math.hypot(block.localLocation.x - spine.x, block.localLocation.z - spine.z)
    );
  }
  return maximum;
}

function resolveAnchorKey(
  blocks: readonly TreeLogBreakageBlock[],
  footprint: TrunkFootprint,
  requested: Vector3
): string | undefined {
  const candidates = blocks.filter(block => isInsideFootprint(block.localLocation, footprint));
  candidates.sort((left, right) =>
    squaredDistance(left.localLocation, requested) - squaredDistance(right.localLocation, requested)
    || compareBlocks(left, right)
  );
  return candidates[0]?.key;
}

function findComponents(blocks: readonly TreeLogBreakageBlock[]): TreeLogBreakageBlock[][] {
  const byKey = new Map(blocks.map(block => [block.key, block]));
  const remaining = new Set(byKey.keys());
  const result: TreeLogBreakageBlock[][] = [];
  while (remaining.size > 0) {
    const start = remaining.values().next().value as string;
    const component: TreeLogBreakageBlock[] = [];
    const queue = [start];
    remaining.delete(start);
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      const block = byKey.get(key)!;
      component.push(block);
      for (const offset of NEIGHBOR_OFFSETS) {
        const neighbor = coordinateKey({
          x: block.localLocation.x + offset.x,
          y: block.localLocation.y + offset.y,
          z: block.localLocation.z + offset.z
        });
        if (!remaining.delete(neighbor)) continue;
        queue.push(neighbor);
      }
    }
    component.sort(compareBlocks);
    result.push(component);
  }
  return result;
}

function normalizeBlocks(input: readonly TreeLogBreakageBlock[]): TreeLogBreakageBlock[] {
  const keys = new Set<string>();
  const coordinates = new Set<string>();
  const result = input.map((block, index): TreeLogBreakageBlock => {
    if (!block || typeof block.key !== "string" || block.key.length === 0) {
      throw new TypeError(`Log ${index} must have a key.`);
    }
    if (keys.has(block.key)) throw new RangeError(`Duplicate log key ${block.key}.`);
    if (!isIntegerVector(block.localLocation)) {
      throw new TypeError(`Log ${index} must have an integer local location.`);
    }
    const coordinate = coordinateKey(block.localLocation);
    if (coordinates.has(coordinate)) throw new RangeError(`Duplicate log coordinate ${coordinate}.`);
    keys.add(block.key);
    coordinates.add(coordinate);
    return {
      family: block.family,
      key: block.key,
      localLocation: { ...block.localLocation }
    };
  });
  return result.sort(compareBlocks);
}

function createCoordinateIndex(
  blocks: readonly TreeLogBreakageBlock[]
): ReadonlyMap<string, number> {
  return new Map(blocks.map((block, index) => [coordinateKey(block.localLocation), index]));
}

function isInsideFootprint(location: Vector3, footprint: TrunkFootprint): boolean {
  return footprint.columns.some(column =>
    location.x === column.x && location.z === column.z
  );
}

function computeMaximumLever(
  blocks: readonly TreeLogBreakageBlock[],
  anchor: Vector3
): number {
  return Math.max(1, ...blocks.map(block => Math.hypot(
    block.localLocation.x - anchor.x,
    block.localLocation.y - anchor.y,
    block.localLocation.z - anchor.z
  )));
}

function normalizeMaximumLever(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : undefined;
}

function disabledPlan(): TreeLogBreakagePlan {
  return {
    breakGroups: [],
    eligible: false,
    maximumLever: 1,
    protectedKeys: new Set(),
    seed: 0
  };
}

function trunkLength(footprint: TrunkFootprint): number {
  return footprint.fullTopY - footprint.fullBottomY + 1;
}

function footprintScore(footprint: TrunkFootprint): number {
  return Math.abs(footprint.minX) + Math.abs(footprint.minZ);
}
