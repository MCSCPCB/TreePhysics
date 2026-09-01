import type { Vector3 } from "@minecraft/server";

const MAX_TREE_LEAF_PHYSICS_LEAVES = 6144;
const TREE_LEAF_CONTACT_COVERAGE_TICKS = 20;

export type TreeLeafPhysicsProfileId = "exact" | "high" | "medium" | "low";

export interface TreeLeafPhysicsActiveBudget {
  buoyancyPointCount: number;
  contactProbeCount: number;
  leafCount: number;
}

export interface TreeLeafPhysicsProfile {
  readonly breakGroupLeafCapacity: number;
  readonly buoyancyPointBudget: number;
  readonly contactProbeBudget: number;
  readonly groupsLeafBreakage: boolean;
  readonly id: TreeLeafPhysicsProfileId;
  readonly maximumActiveBuoyancyPointCount: number;
  readonly maximumActiveContactProbeCount: number;
  readonly maximumActiveLeafCount: number;
  readonly maximumBreakGroupCount: number;
  readonly maximumExactLeafColliderBoxCount: number;
  readonly maximumLeafCount: number;
}

export interface TreeLeafPhysicsProfileSelectionInput {
  readonly currentActiveBudget?: Partial<TreeLeafPhysicsActiveBudget>;
  readonly exactLeafColliderBoxCount: number;
  readonly leafCount: number;
}

export interface TreeLeafPhysicsLeaf {
  readonly buoyancyVolume: number;
  readonly key: string;
  readonly localLocation: Vector3;
}

export interface TreeLeafBreakGroup {
  readonly id: number;
  readonly keys: readonly string[];
  readonly leafIndices: Uint16Array;
}

export interface TreeLeafBuoyancyPoint {
  readonly leafIndices: Uint16Array;
  readonly localLocation: Vector3;
  readonly volume: number;
}

export interface TreeLeafPhysicsPlan {
  readonly allocatedBuoyancyPointCount: number;
  readonly allocatedContactProbeCount: number;
  readonly breakGroupByKey: ReadonlyMap<string, number>;
  readonly breakGroupByLeafIndex: Uint16Array;
  readonly breakGroups: readonly TreeLeafBreakGroup[];
  readonly buoyancyPoints: readonly TreeLeafBuoyancyPoint[];
  readonly leaves: readonly TreeLeafPhysicsLeaf[];
  readonly profile: TreeLeafPhysicsProfile;
  readonly totalBuoyancyVolume: number;
}

export type CreateTreeLeafPhysicsPlanOptions =
  | (TreeLeafPhysicsProfileSelectionInput & { readonly profileId?: undefined })
  | {
      readonly exactLeafColliderBoxCount?: number;
      readonly leafCount: number;
      readonly profileId: TreeLeafPhysicsProfileId;
    };

const PROFILE_EXACT: TreeLeafPhysicsProfile = {
  breakGroupLeafCapacity: 1,
  buoyancyPointBudget: Number.POSITIVE_INFINITY,
  contactProbeBudget: 64,
  groupsLeafBreakage: false,
  id: "exact",
  maximumActiveBuoyancyPointCount: 256,
  maximumActiveContactProbeCount: 128,
  maximumActiveLeafCount: 256,
  maximumBreakGroupCount: Number.POSITIVE_INFINITY,
  maximumExactLeafColliderBoxCount: 48,
  maximumLeafCount: 128
};

const PROFILE_HIGH: TreeLeafPhysicsProfile = {
  breakGroupLeafCapacity: 8,
  buoyancyPointBudget: 32,
  contactProbeBudget: 32,
  groupsLeafBreakage: true,
  id: "high",
  maximumActiveBuoyancyPointCount: 384,
  maximumActiveContactProbeCount: 256,
  maximumActiveLeafCount: 1024,
  maximumBreakGroupCount: 64,
  maximumExactLeafColliderBoxCount: 192,
  maximumLeafCount: 512
};

const PROFILE_MEDIUM: TreeLeafPhysicsProfile = {
  breakGroupLeafCapacity: 32,
  buoyancyPointBudget: 12,
  contactProbeBudget: 12,
  groupsLeafBreakage: true,
  id: "medium",
  maximumActiveBuoyancyPointCount: 768,
  maximumActiveContactProbeCount: 512,
  maximumActiveLeafCount: 4096,
  maximumBreakGroupCount: 24,
  maximumExactLeafColliderBoxCount: 768,
  maximumLeafCount: 2048
};

const PROFILE_LOW: TreeLeafPhysicsProfile = {
  breakGroupLeafCapacity: Number.POSITIVE_INFINITY,
  buoyancyPointBudget: 1,
  contactProbeBudget: 4,
  groupsLeafBreakage: true,
  id: "low",
  maximumActiveBuoyancyPointCount: Number.POSITIVE_INFINITY,
  maximumActiveContactProbeCount: Number.POSITIVE_INFINITY,
  maximumActiveLeafCount: Number.POSITIVE_INFINITY,
  maximumBreakGroupCount: 1,
  maximumExactLeafColliderBoxCount: Number.POSITIVE_INFINITY,
  maximumLeafCount: MAX_TREE_LEAF_PHYSICS_LEAVES
};

export const TREE_LEAF_PHYSICS_PROFILES: Readonly<Record<TreeLeafPhysicsProfileId, TreeLeafPhysicsProfile>> = {
  exact: PROFILE_EXACT,
  high: PROFILE_HIGH,
  low: PROFILE_LOW,
  medium: PROFILE_MEDIUM
};

const ORDERED_PROFILES = [PROFILE_EXACT, PROFILE_HIGH, PROFILE_MEDIUM, PROFILE_LOW] as const;
const FACE_OFFSETS = [
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 }
] as const;

function selectTreeLeafPhysicsProfile(
  input: TreeLeafPhysicsProfileSelectionInput
): TreeLeafPhysicsProfile {
  const leafCount = normalizeCount(input.leafCount, "leafCount");
  const exactLeafColliderBoxCount = normalizeCount(
    input.exactLeafColliderBoxCount,
    "exactLeafColliderBoxCount"
  );
  if (leafCount > MAX_TREE_LEAF_PHYSICS_LEAVES) {
    throw new RangeError(`Tree leaf physics supports at most ${MAX_TREE_LEAF_PHYSICS_LEAVES} leaves.`);
  }
  const activeLeafCount = normalizeCount(input.currentActiveBudget?.leafCount ?? 0, "active leafCount");
  const activeBuoyancyPointCount = normalizeCount(
    input.currentActiveBudget?.buoyancyPointCount ?? 0,
    "active buoyancyPointCount"
  );
  const activeContactProbeCount = normalizeCount(
    input.currentActiveBudget?.contactProbeCount ?? 0,
    "active contactProbeCount"
  );

  for (const profile of ORDERED_PROFILES) {
    const estimatedBuoyancyPoints = Math.min(leafCount, profile.buoyancyPointBudget);
    const estimatedContactProbes = getTreeLeafContactProbeBudget(leafCount, profile);
    if (
      leafCount <= profile.maximumLeafCount
      && exactLeafColliderBoxCount <= profile.maximumExactLeafColliderBoxCount
      && activeLeafCount + leafCount <= profile.maximumActiveLeafCount
      && activeBuoyancyPointCount + estimatedBuoyancyPoints
        <= profile.maximumActiveBuoyancyPointCount
      && activeContactProbeCount + estimatedContactProbes
        <= profile.maximumActiveContactProbeCount
    ) return profile;
  }
  return PROFILE_LOW;
}

export function createTreeLeafPhysicsPlan(
  inputLeaves: readonly TreeLeafPhysicsLeaf[],
  options: CreateTreeLeafPhysicsPlanOptions
): TreeLeafPhysicsPlan {
  if (inputLeaves.length > MAX_TREE_LEAF_PHYSICS_LEAVES) {
    throw new RangeError(`Tree leaf physics supports at most ${MAX_TREE_LEAF_PHYSICS_LEAVES} leaves.`);
  }
  const leaves = normalizeLeaves(inputLeaves);
  if (options.leafCount !== leaves.length) {
    throw new RangeError("leafCount must match the number of supplied leaves.");
  }
  const profile = options.profileId !== undefined
    ? TREE_LEAF_PHYSICS_PROFILES[options.profileId]
    : selectTreeLeafPhysicsProfile(options);
  const partition = createBreakGroups(leaves, profile);
  return createPlanFromPartition(
    leaves,
    profile,
    partition
  );
}

export function restoreTreeLeafPhysicsPlan(
  inputLeaves: readonly TreeLeafPhysicsLeaf[],
  options: {
    readonly breakGroups?: readonly (readonly string[])[];
    readonly exactLeafColliderBoxCount?: number;
    readonly profileId: TreeLeafPhysicsProfileId;
  }
): TreeLeafPhysicsPlan {
  const leaves = normalizeLeaves(inputLeaves);
  const profile = TREE_LEAF_PHYSICS_PROFILES[options.profileId];
  const partition = !profile.groupsLeafBreakage || !options.breakGroups
    ? createBreakGroups(leaves, profile)
    : restoreBreakGroups(leaves, options.breakGroups);
  return createPlanFromPartition(leaves, profile, partition);
}

function createPlanFromPartition(
  leaves: readonly TreeLeafPhysicsLeaf[],
  profile: TreeLeafPhysicsProfile,
  partition: Pick<TreeLeafPhysicsPlan, "breakGroupByKey" | "breakGroupByLeafIndex" | "breakGroups">
): TreeLeafPhysicsPlan {
  const totalBuoyancyVolume = sumLeafVolume(leaves);
  const buoyancyPoints = aggregateTreeLeafBuoyancyPoints(leaves, profile.buoyancyPointBudget);
  return {
    ...partition,
    allocatedBuoyancyPointCount: buoyancyPoints.length,
    allocatedContactProbeCount: getTreeLeafContactProbeBudget(leaves.length, profile),
    buoyancyPoints,
    leaves,
    profile,
    totalBuoyancyVolume
  };
}

function getTreeLeafContactProbeBudget(
  leafCount: number,
  profile: TreeLeafPhysicsProfile
): number {
  const count = normalizeCount(leafCount, "leafCount");
  if (count === 0) return 0;
  return Math.min(
    count,
    Math.max(profile.contactProbeBudget, Math.ceil(count / TREE_LEAF_CONTACT_COVERAGE_TICKS))
  );
}

function restoreBreakGroups(
  leaves: readonly TreeLeafPhysicsLeaf[],
  savedGroups: readonly (readonly string[])[]
): Pick<TreeLeafPhysicsPlan, "breakGroupByKey" | "breakGroupByLeafIndex" | "breakGroups"> {
  const indexByKey = new Map(leaves.map((leaf, index) => [leaf.key, index]));
  const seen = new Uint8Array(leaves.length);
  const groupByLeaf = new Uint16Array(leaves.length);
  const breakGroups = savedGroups.map((keys, id): TreeLeafBreakGroup => {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new RangeError("Saved leaf break groups must not be empty.");
    }
    const indices = keys.map(key => {
      const index = indexByKey.get(key);
      if (index === undefined || seen[index]) {
        throw new RangeError("Saved leaf break groups must partition the current leaves exactly.");
      }
      seen[index] = 1;
      groupByLeaf[index] = id;
      return index;
    }).sort((left, right) => compareLeafIndices(leaves, left, right));
    return {
      id,
      keys: indices.map(index => leaves[index]!.key),
      leafIndices: Uint16Array.from(indices)
    };
  });
  if (seen.some(value => value === 0)) {
    throw new RangeError("Saved leaf break groups must partition the current leaves exactly.");
  }
  return {
    breakGroupByKey: new Map(leaves.map((leaf, index) => [leaf.key, groupByLeaf[index]!])),
    breakGroupByLeafIndex: groupByLeaf,
    breakGroups
  };
}

function aggregateTreeLeafBuoyancyPoints(
  inputLeaves: readonly TreeLeafPhysicsLeaf[],
  pointBudget: number
): TreeLeafBuoyancyPoint[] {
  const leaves = normalizeLeaves(inputLeaves);
  const positiveIndices = leaves
    .map((leaf, index) => leaf.buoyancyVolume > 0 ? index : -1)
    .filter(index => index >= 0);
  if (positiveIndices.length === 0) return [];
  const target = Math.max(1, Math.min(positiveIndices.length, normalizePositiveBudget(pointBudget)));
  const clusters: number[][] = [positiveIndices];
  while (clusters.length < target) {
    const splitIndex = selectBuoyancyClusterToSplit(leaves, clusters);
    if (splitIndex < 0) break;
    const split = splitBuoyancyCluster(leaves, clusters[splitIndex]!);
    clusters.splice(splitIndex, 1, split[0], split[1]);
  }
  clusters.sort((left, right) => compareLeafIndices(leaves, left[0]!, right[0]!));

  const result = clusters.map(indices => createBuoyancyPoint(leaves, indices));
  const expectedVolume = sumLeafVolume(leaves);
  const actualVolume = result.reduce((sum, point) => sum + point.volume, 0);
  const finalPoint = result[result.length - 1]!;
  result[result.length - 1] = {
    ...finalPoint,
    volume: finalPoint.volume + (expectedVolume - actualVolume)
  };
  return result;
}

function createBreakGroups(
  leaves: readonly TreeLeafPhysicsLeaf[],
  profile: TreeLeafPhysicsProfile
): Pick<TreeLeafPhysicsPlan, "breakGroupByKey" | "breakGroupByLeafIndex" | "breakGroups"> {
  const count = leaves.length;
  const groupByLeaf = new Uint16Array(count);
  if (count === 0) {
    return { breakGroupByKey: new Map(), breakGroupByLeafIndex: groupByLeaf, breakGroups: [] };
  }
  if (!profile.groupsLeafBreakage) {
    const groups = leaves.map((leaf, index): TreeLeafBreakGroup => ({
      id: index,
      keys: [leaf.key],
      leafIndices: Uint16Array.of(index)
    }));
    for (let index = 0; index < count; index++) groupByLeaf[index] = index;
    return {
      breakGroupByKey: new Map(leaves.map((leaf, index) => [leaf.key, index])),
      breakGroupByLeafIndex: groupByLeaf,
      breakGroups: groups
    };
  }

  const coordinateIndex = createCoordinateIndex(leaves);
  const components = findConnectedComponents(leaves, coordinateIndex);
  const desiredCount = Math.max(
    components.length,
    Math.min(
      count,
      profile.maximumBreakGroupCount,
      Math.ceil(count / profile.breakGroupLeafCapacity)
    )
  );
  const allocations = allocateGroupsToComponents(components, desiredCount);
  const memberGroups: number[][] = [];
  for (let index = 0; index < components.length; index++) {
    memberGroups.push(...partitionConnectedComponent(
      leaves,
      coordinateIndex,
      components[index]!,
      allocations[index]!
    ));
  }
  memberGroups.sort((left, right) => compareLeafIndices(leaves, left[0]!, right[0]!));

  const breakGroups = memberGroups.map((members, groupId): TreeLeafBreakGroup => {
    members.sort((left, right) => compareLeafIndices(leaves, left, right));
    for (const member of members) groupByLeaf[member] = groupId;
    return {
      id: groupId,
      keys: members.map(member => leaves[member]!.key),
      leafIndices: Uint16Array.from(members)
    };
  });
  return {
    breakGroupByKey: new Map(leaves.map((leaf, index) => [leaf.key, groupByLeaf[index]!])),
    breakGroupByLeafIndex: groupByLeaf,
    breakGroups
  };
}

function partitionConnectedComponent(
  leaves: readonly TreeLeafPhysicsLeaf[],
  coordinateIndex: CoordinateIndex,
  component: readonly number[],
  groupCount: number
): number[][] {
  if (groupCount <= 1) return [[...component]];
  if (groupCount >= component.length) return component.map(index => [index]);

  const componentSet = new Uint8Array(leaves.length);
  for (const index of component) componentSet[index] = 1;
  const traversal = breadthFirstTraversal(leaves, coordinateIndex, component[0]!, componentSet);
  const seeds: number[] = [];
  const used = new Uint8Array(leaves.length);
  for (let index = 0; index < groupCount; index++) {
    let position = Math.floor((index + 0.5) * traversal.length / groupCount);
    position = Math.min(traversal.length - 1, position);
    while (position < traversal.length && used[traversal[position]!]) position++;
    if (position >= traversal.length) position = traversal.findIndex(candidate => !used[candidate]);
    const seed = traversal[position]!;
    used[seed] = 1;
    seeds.push(seed);
  }

  const groupByLeaf = new Int32Array(leaves.length).fill(-1);
  const queue = new Uint16Array(component.length);
  let queueStart = 0;
  let queueEnd = 0;
  for (let groupId = 0; groupId < seeds.length; groupId++) {
    const seed = seeds[groupId]!;
    groupByLeaf[seed] = groupId;
    queue[queueEnd++] = seed;
  }
  while (queueStart < queueEnd) {
    const current = queue[queueStart++]!;
    const groupId = groupByLeaf[current]!;
    forEachNeighbor(leaves[current]!.localLocation, coordinateIndex, neighbor => {
      if (!componentSet[neighbor] || groupByLeaf[neighbor] >= 0) return;
      groupByLeaf[neighbor] = groupId;
      queue[queueEnd++] = neighbor;
    });
  }
  const groups = Array.from({ length: groupCount }, () => [] as number[]);
  for (const index of component) groups[groupByLeaf[index]!]!.push(index);
  return groups;
}

function findConnectedComponents(
  leaves: readonly TreeLeafPhysicsLeaf[],
  coordinateIndex: CoordinateIndex
): number[][] {
  const visited = new Uint8Array(leaves.length);
  const components: number[][] = [];
  for (let start = 0; start < leaves.length; start++) {
    if (visited[start]) continue;
    const members: number[] = [];
    const queue = new Uint16Array(leaves.length);
    let queueStart = 0;
    let queueEnd = 0;
    visited[start] = 1;
    queue[queueEnd++] = start;
    while (queueStart < queueEnd) {
      const current = queue[queueStart++]!;
      members.push(current);
      forEachNeighbor(leaves[current]!.localLocation, coordinateIndex, neighbor => {
        if (visited[neighbor]) return;
        visited[neighbor] = 1;
        queue[queueEnd++] = neighbor;
      });
    }
    members.sort((left, right) => compareLeafIndices(leaves, left, right));
    components.push(members);
  }
  return components.sort((left, right) => compareLeafIndices(leaves, left[0]!, right[0]!));
}

function breadthFirstTraversal(
  leaves: readonly TreeLeafPhysicsLeaf[],
  coordinateIndex: CoordinateIndex,
  start: number,
  included: Uint8Array
): number[] {
  const visited = new Uint8Array(leaves.length);
  const result: number[] = [];
  const queue = new Uint16Array(leaves.length);
  let queueStart = 0;
  let queueEnd = 0;
  visited[start] = 1;
  queue[queueEnd++] = start;
  while (queueStart < queueEnd) {
    const current = queue[queueStart++]!;
    result.push(current);
    const neighbors: number[] = [];
    forEachNeighbor(leaves[current]!.localLocation, coordinateIndex, neighbor => {
      if (included[neighbor] && !visited[neighbor]) neighbors.push(neighbor);
    });
    neighbors.sort((left, right) => compareLeafIndices(leaves, left, right));
    for (const neighbor of neighbors) {
      visited[neighbor] = 1;
      queue[queueEnd++] = neighbor;
    }
  }
  return result;
}

function allocateGroupsToComponents(components: readonly (readonly number[])[], target: number): number[] {
  const result = components.map(() => 1);
  for (let allocated = components.length; allocated < target; allocated++) {
    let selected = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < components.length; index++) {
      if (result[index]! >= components[index]!.length) continue;
      const score = components[index]!.length / result[index]!;
      if (score > bestScore) {
        bestScore = score;
        selected = index;
      }
    }
    if (selected < 0) break;
    result[selected]++;
  }
  return result;
}

function selectBuoyancyClusterToSplit(
  leaves: readonly TreeLeafPhysicsLeaf[],
  clusters: readonly (readonly number[])[]
): number {
  let selected = -1;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index]!;
    if (cluster.length < 2) continue;
    const bounds = leafBounds(leaves, cluster);
    const score = Math.max(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    ) * sumIndexedLeafVolume(leaves, cluster);
    if (score > selectedScore) {
      selectedScore = score;
      selected = index;
    }
  }
  return selected;
}

function splitBuoyancyCluster(
  leaves: readonly TreeLeafPhysicsLeaf[],
  cluster: readonly number[]
): [number[], number[]] {
  const bounds = leafBounds(leaves, cluster);
  const axes: ("x" | "y" | "z")[] = ["y", "x", "z"];
  axes.sort((left, right) =>
    (bounds.max[right] - bounds.min[right]) - (bounds.max[left] - bounds.min[left])
    || buoyancyAxisOrder(left) - buoyancyAxisOrder(right)
  );
  const axis = axes[0]!;
  const sorted = [...cluster].sort((left, right) =>
    leaves[left]!.localLocation[axis] - leaves[right]!.localLocation[axis]
    || compareLeafIndices(leaves, left, right)
  );
  const total = sumIndexedLeafVolume(leaves, sorted);
  let accumulated = 0;
  let splitIndex = 1;
  for (; splitIndex < sorted.length; splitIndex++) {
    accumulated += leaves[sorted[splitIndex - 1]!]!.buoyancyVolume;
    if (accumulated >= total / 2) break;
  }
  splitIndex = Math.max(1, Math.min(sorted.length - 1, splitIndex));
  return [sorted.slice(0, splitIndex), sorted.slice(splitIndex)];
}

function createBuoyancyPoint(
  leaves: readonly TreeLeafPhysicsLeaf[],
  indices: readonly number[]
): TreeLeafBuoyancyPoint {
  let volume = 0;
  const center = { x: 0, y: 0, z: 0 };
  for (const index of indices) {
    const leaf = leaves[index]!;
    volume += leaf.buoyancyVolume;
    center.x += leaf.localLocation.x * leaf.buoyancyVolume;
    center.y += leaf.localLocation.y * leaf.buoyancyVolume;
    center.z += leaf.localLocation.z * leaf.buoyancyVolume;
  }
  return {
    leafIndices: Uint16Array.from([...indices].sort((left, right) => compareLeafIndices(leaves, left, right))),
    localLocation: { x: center.x / volume, y: center.y / volume, z: center.z / volume },
    volume
  };
}

type CoordinateIndex = Map<number, Map<number, Map<number, number>>>;

function createCoordinateIndex(leaves: readonly TreeLeafPhysicsLeaf[]): CoordinateIndex {
  const result: CoordinateIndex = new Map();
  for (let index = 0; index < leaves.length; index++) {
    const location = leaves[index]!.localLocation;
    let byY = result.get(location.x);
    if (!byY) result.set(location.x, byY = new Map());
    let byZ = byY.get(location.y);
    if (!byZ) byY.set(location.y, byZ = new Map());
    if (byZ.has(location.z)) throw new RangeError("Leaf localLocation values must be unique.");
    byZ.set(location.z, index);
  }
  return result;
}

function forEachNeighbor(
  location: Vector3,
  index: CoordinateIndex,
  callback: (neighbor: number) => void
): void {
  for (const offset of FACE_OFFSETS) {
    const neighbor = index
      .get(location.x + offset.x)
      ?.get(location.y + offset.y)
      ?.get(location.z + offset.z);
    if (neighbor !== undefined) callback(neighbor);
  }
}

interface LeafBounds { min: Vector3; max: Vector3 }

function leafBounds(leaves: readonly TreeLeafPhysicsLeaf[], indices: readonly number[]): LeafBounds {
  const first = leaves[indices[0]!]!.localLocation;
  const min = { ...first };
  const max = { ...first };
  for (let offset = 1; offset < indices.length; offset++) {
    const location = leaves[indices[offset]!]!.localLocation;
    min.x = Math.min(min.x, location.x);
    min.y = Math.min(min.y, location.y);
    min.z = Math.min(min.z, location.z);
    max.x = Math.max(max.x, location.x);
    max.y = Math.max(max.y, location.y);
    max.z = Math.max(max.z, location.z);
  }
  return { max, min };
}

function normalizeLeaves(input: readonly TreeLeafPhysicsLeaf[]): TreeLeafPhysicsLeaf[] {
  const keys = new Set<string>();
  const result = input.map((leaf, index): TreeLeafPhysicsLeaf => {
    if (!leaf || typeof leaf.key !== "string" || leaf.key.length === 0) {
      throw new TypeError(`Leaf ${index} must have a non-empty key.`);
    }
    if (keys.has(leaf.key)) throw new RangeError(`Leaf key ${leaf.key} is duplicated.`);
    keys.add(leaf.key);
    if (!isIntegerVector(leaf.localLocation)) {
      throw new TypeError(`Leaf ${index} must use a finite integer localLocation.`);
    }
    if (!Number.isFinite(leaf.buoyancyVolume) || leaf.buoyancyVolume < 0) {
      throw new RangeError(`Leaf ${index} buoyancyVolume must be finite and non-negative.`);
    }
    return {
      buoyancyVolume: leaf.buoyancyVolume,
      key: leaf.key,
      localLocation: { ...leaf.localLocation }
    };
  });
  result.sort(compareLeaves);
  createCoordinateIndex(result);
  return result;
}

function compareLeaves(left: TreeLeafPhysicsLeaf, right: TreeLeafPhysicsLeaf): number {
  return left.localLocation.y - right.localLocation.y
    || left.localLocation.z - right.localLocation.z
    || left.localLocation.x - right.localLocation.x
    || left.key.localeCompare(right.key);
}

function compareLeafIndices(
  leaves: readonly TreeLeafPhysicsLeaf[],
  left: number,
  right: number
): number {
  return compareLeaves(leaves[left]!, leaves[right]!);
}

function sumLeafVolume(leaves: readonly TreeLeafPhysicsLeaf[]): number {
  return leaves.reduce((sum, leaf) => sum + leaf.buoyancyVolume, 0);
}

function sumIndexedLeafVolume(
  leaves: readonly TreeLeafPhysicsLeaf[],
  indices: readonly number[]
): number {
  return indices.reduce((sum, index) => sum + leaves[index]!.buoyancyVolume, 0);
}

function normalizeCount(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative.`);
  return Math.floor(value);
}

function normalizePositiveBudget(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("pointBudget must be positive.");
  return Math.max(1, Math.floor(value));
}

function isIntegerVector(value: Vector3): boolean {
  return !!value
    && Number.isInteger(value.x)
    && Number.isInteger(value.y)
    && Number.isInteger(value.z);
}

function buoyancyAxisOrder(axis: "x" | "y" | "z"): number {
  return axis === "y" ? 0 : axis === "x" ? 1 : 2;
}
