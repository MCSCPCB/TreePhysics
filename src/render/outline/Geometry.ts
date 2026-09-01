import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraptionBlock } from "@src/Physics";
import { blockKey } from "@src/utils/BlockKey";
import { treeBlockKind } from "@src/content/tree/block/Blocks";
import { squaredDistance } from "@src/utils/Vector3Math";

export const CONTRAPTION_OUTLINE_EDGE_CAPACITY = 28;

/** One AABB already needs its 12 edges, so smaller capacities can render nothing. */
const MIN_OUTLINE_EDGE_CAPACITY = 12;

export type ContraptionOutlineAxis = "x" | "y" | "z";

export interface ContraptionOutlineEdge {
  readonly axis: ContraptionOutlineAxis;
  readonly length: number;
  readonly start: Vector3;
}

export interface ContraptionOutlineShape {
  readonly edges: readonly ContraptionOutlineEdge[];
  readonly kind: "complete" | "local-aabb" | "local-exact";
}

export interface ContraptionOutlineTopology {
  readonly completeEdges?: readonly ContraptionOutlineEdge[];
  readonly structuralBlocks: readonly PhysicsContraptionBlock[];
}

interface UnitEdge {
  readonly axis: ContraptionOutlineAxis;
  readonly start: Vector3;
}

function assertOutlineCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < MIN_OUTLINE_EDGE_CAPACITY) {
    throw new RangeError(`Contraption outline capacity must be an integer of at least ${MIN_OUTLINE_EDGE_CAPACITY}, got ${capacity}.`);
  }
}

const NEIGHBORS: readonly Vector3[] = [
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 }
];

/** Build an exact complete outline or a capacity-bounded target-local outline. */
export function createContraptionOutlineShape(
  blocks: readonly PhysicsContraptionBlock[],
  target: Vector3,
  capacity = CONTRAPTION_OUTLINE_EDGE_CAPACITY
): ContraptionOutlineShape | undefined {
  return createContraptionOutlineShapeFromTopology(
    createContraptionOutlineTopology(blocks, capacity),
    target,
    capacity
  );
}

/** Precompute the target-independent complete outline once per content revision. */
export function createContraptionOutlineTopology(
  blocks: readonly PhysicsContraptionBlock[],
  capacity = CONTRAPTION_OUTLINE_EDGE_CAPACITY
): ContraptionOutlineTopology {
  assertOutlineCapacity(capacity);
  const structural = blocks.filter(isWholeOutlineBlock);
  if (structural.length === 0) return { structuralBlocks: structural };
  const complete = createMergedVoxelOutline(structural.map(block => block.localLocation));
  return {
    completeEdges: complete.length <= capacity ? complete : undefined,
    structuralBlocks: structural
  };
}

/** Build a complete or target-local shape from cached structural topology. */
export function createContraptionOutlineShapeFromTopology(
  topology: ContraptionOutlineTopology,
  target: Vector3,
  capacity = CONTRAPTION_OUTLINE_EDGE_CAPACITY
): ContraptionOutlineShape | undefined {
  assertOutlineCapacity(capacity);
  if (topology.structuralBlocks.length === 0) return undefined;
  if (topology.completeEdges) return { edges: topology.completeEdges, kind: "complete" };

  const localBlocks = selectLocalTopology(topology.structuralBlocks, target, capacity);
  if (localBlocks.length === 0) return undefined;
  if (isSolidCuboid(localBlocks)) {
    return { edges: createAabbOutline(localBlocks), kind: "local-aabb" };
  }
  return {
    edges: createMergedVoxelOutline(localBlocks),
    kind: "local-exact"
  };
}

/** Generate EdgeRender-compatible visible voxel edges, then merge collinear units. */
export function createMergedVoxelOutline(
  locations: readonly Vector3[]
): ContraptionOutlineEdge[] {
  const occupied = new Set(locations.map(blockKey));
  const unitEdges = new Map<string, UnitEdge>();
  // Inline key format must match blockKey ("x,y,z"); building a Vector3 just
  // to call blockKey would allocate on every probe of this hot loop.
  const has = (x: number, y: number, z: number) => occupied.has(`${x},${y},${z}`);
  const add = (axis: ContraptionOutlineAxis, start: Vector3) => {
    unitEdges.set(edgeKey(axis, start), { axis, start });
  };

  // Twelve unit-edge checks per voxel, grouped four per edge axis (y, x, z).
  // Each check passes the exposure of the two faces flanking that edge plus
  // the diagonal neighbor across the edge.
  for (const location of locations) {
    const { x, y, z } = location;
    const west = has(x - 1, y, z);
    const east = has(x + 1, y, z);
    const down = has(x, y - 1, z);
    const up = has(x, y + 1, z);
    const north = has(x, y, z - 1);
    const south = has(x, y, z + 1);

    if (visibleVoxelEdge(!north, !west, has(x - 1, y, z - 1))) {
      add("y", { x: x - 0.5, y: y - 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!north, !east, has(x + 1, y, z - 1))) {
      add("y", { x: x + 0.5, y: y - 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!south, !west, has(x - 1, y, z + 1))) {
      add("y", { x: x - 0.5, y: y - 0.5, z: z + 0.5 });
    }
    if (visibleVoxelEdge(!south, !east, has(x + 1, y, z + 1))) {
      add("y", { x: x + 0.5, y: y - 0.5, z: z + 0.5 });
    }

    if (visibleVoxelEdge(!down, !north, has(x, y - 1, z - 1))) {
      add("x", { x: x - 0.5, y: y - 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!down, !south, has(x, y - 1, z + 1))) {
      add("x", { x: x - 0.5, y: y - 0.5, z: z + 0.5 });
    }
    if (visibleVoxelEdge(!up, !north, has(x, y + 1, z - 1))) {
      add("x", { x: x - 0.5, y: y + 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!up, !south, has(x, y + 1, z + 1))) {
      add("x", { x: x - 0.5, y: y + 0.5, z: z + 0.5 });
    }

    if (visibleVoxelEdge(!down, !west, has(x - 1, y - 1, z))) {
      add("z", { x: x - 0.5, y: y - 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!down, !east, has(x + 1, y - 1, z))) {
      add("z", { x: x + 0.5, y: y - 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!up, !west, has(x - 1, y + 1, z))) {
      add("z", { x: x - 0.5, y: y + 0.5, z: z - 0.5 });
    }
    if (visibleVoxelEdge(!up, !east, has(x + 1, y + 1, z))) {
      add("z", { x: x + 0.5, y: y + 0.5, z: z - 0.5 });
    }
  }
  return mergeUnitEdges([...unitEdges.values()]);
}

export function createAabbOutline(locations: readonly Vector3[]): ContraptionOutlineEdge[] {
  if (locations.length === 0) return [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const location of locations) {
    minX = Math.min(minX, location.x - 0.5);
    minY = Math.min(minY, location.y - 0.5);
    minZ = Math.min(minZ, location.z - 0.5);
    maxX = Math.max(maxX, location.x + 0.5);
    maxY = Math.max(maxY, location.y + 0.5);
    maxZ = Math.max(maxZ, location.z + 0.5);
  }
  return [
    edge("x", minX, minY, minZ, maxX - minX),
    edge("x", minX, minY, maxZ, maxX - minX),
    edge("x", minX, maxY, minZ, maxX - minX),
    edge("x", minX, maxY, maxZ, maxX - minX),
    edge("y", minX, minY, minZ, maxY - minY),
    edge("y", minX, minY, maxZ, maxY - minY),
    edge("y", maxX, minY, minZ, maxY - minY),
    edge("y", maxX, minY, maxZ, maxY - minY),
    edge("z", minX, minY, minZ, maxZ - minZ),
    edge("z", minX, maxY, minZ, maxZ - minZ),
    edge("z", maxX, minY, minZ, maxZ - minZ),
    edge("z", maxX, maxY, minZ, maxZ - minZ)
  ];
}

export function isSolidCuboid(locations: readonly Vector3[]): boolean {
  if (locations.length === 0) return false;
  const unique = new Set(locations.map(blockKey));
  if (unique.size !== locations.length) return false;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const location of locations) {
    if (location.x < minX) minX = location.x;
    if (location.x > maxX) maxX = location.x;
    if (location.y < minY) minY = location.y;
    if (location.y > maxY) maxY = location.y;
    if (location.z < minZ) minZ = location.z;
    if (location.z > maxZ) maxZ = location.z;
  }
  const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  return volume === unique.size;
}

function selectLocalTopology(
  blocks: readonly PhysicsContraptionBlock[],
  target: Vector3,
  capacity: number
): Vector3[] {
  const byKey = new Map(blocks.map(block => [blockKey(block.localLocation), block]));
  let start: PhysicsContraptionBlock | undefined;
  let startDistance = Number.POSITIVE_INFINITY;
  let startKey = "";
  for (const block of blocks) {
    const distance = squaredDistance(block.localLocation, target);
    if (distance > startDistance) continue;
    const key = blockKey(block.localLocation);
    if (distance < startDistance || key.localeCompare(startKey) < 0) {
      start = block;
      startDistance = distance;
      startKey = key;
    }
  }
  if (!start) return [];

  const queue: PhysicsContraptionBlock[] = [start];
  const queued = new Set([startKey]);
  // The accepted prefix, its bounding box, and the solid-cuboid test all grow
  // incrementally; rebuilding them per BFS step made this pass quadratic.
  const accepted: Vector3[] = [];
  let bestLength = 1;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const block = queue[cursor]!;
    for (const offset of NEIGHBORS) {
      // Inline key format must match blockKey ("x,y,z"), which built byKey.
      const key = `${block.localLocation.x + offset.x},${block.localLocation.y + offset.y},${block.localLocation.z + offset.z}`;
      const neighbor = byKey.get(key);
      if (!neighbor || queued.has(key)) continue;
      queued.add(key);
      queue.push(neighbor);
    }
    const location = block.localLocation;
    accepted.push(location);
    if (location.x < minX) minX = location.x;
    if (location.x > maxX) maxX = location.x;
    if (location.y < minY) minY = location.y;
    if (location.y > maxY) maxY = location.y;
    if (location.z < minZ) minZ = location.z;
    if (location.z > maxZ) maxZ = location.z;
    // BFS visitation guarantees uniqueness, so bounding-box volume alone
    // decides the solid-cuboid test.
    const solidCuboid = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1)
      === accepted.length;
    if (solidCuboid || createMergedVoxelOutline(accepted).length <= capacity) {
      bestLength = accepted.length;
      continue;
    }
    break;
  }
  return accepted.slice(0, bestLength);
}

function mergeUnitEdges(unitEdges: readonly UnitEdge[]): ContraptionOutlineEdge[] {
  const groups = new Map<string, UnitEdge[]>();
  for (const unit of unitEdges) {
    const fixed = unit.axis === "x"
      ? `${unit.start.y},${unit.start.z}`
      : unit.axis === "y"
        ? `${unit.start.x},${unit.start.z}`
        : `${unit.start.x},${unit.start.y}`;
    const key = `${unit.axis}:${fixed}`;
    const group = groups.get(key);
    if (group) group.push(unit);
    else groups.set(key, [unit]);
  }

  const merged: ContraptionOutlineEdge[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => axisValue(left.start, left.axis) - axisValue(right.start, right.axis));
    let start = group[0]!.start;
    let end = axisValue(start, group[0]!.axis) + 1;
    const axis = group[0]!.axis;
    for (let index = 1; index < group.length; index++) {
      const next = group[index]!;
      const nextStart = axisValue(next.start, axis);
      if (Math.abs(nextStart - end) < 1e-9) {
        end++;
        continue;
      }
      merged.push({ axis, length: end - axisValue(start, axis), start: { ...start } });
      start = next.start;
      end = nextStart + 1;
    }
    merged.push({ axis, length: end - axisValue(start, axis), start: { ...start } });
  }
  return merged.sort(compareEdges);
}

// An edge is drawn when both flanking faces are exposed (convex silhouette
// edge), or when exactly one is exposed and the diagonal voxel across the
// edge is filled (concave crease against that diagonal). One exposed face
// with an empty diagonal is a flat surface interior, drawing nothing.
function visibleVoxelEdge(firstFaceExposed: boolean, secondFaceExposed: boolean, diagonal: boolean): boolean {
  return (firstFaceExposed && secondFaceExposed)
    || (firstFaceExposed && !secondFaceExposed && diagonal)
    || (!firstFaceExposed && secondFaceExposed && diagonal);
}

function isWholeOutlineBlock(block: PhysicsContraptionBlock): boolean {
  if (block.visual?.renderer === "log_fragment"
    || block.visual?.renderer === "attachment_fragment") return true;
  if (block.visual?.renderer === "leaf_fragment") return false;
  const kind = treeBlockKind(block.typeId);
  return kind === "log" || kind === "attachment";
}

function edge(
  axis: ContraptionOutlineAxis,
  x: number,
  y: number,
  z: number,
  length: number
): ContraptionOutlineEdge {
  return { axis, length, start: { x, y, z } };
}

function edgeKey(axis: ContraptionOutlineAxis, start: Vector3): string {
  return `${axis}:${start.x},${start.y},${start.z}`;
}

function axisValue(value: Vector3, axis: ContraptionOutlineAxis): number {
  return value[axis];
}

function compareEdges(left: ContraptionOutlineEdge, right: ContraptionOutlineEdge): number {
  return left.axis.localeCompare(right.axis)
    || left.start.x - right.start.x
    || left.start.y - right.start.y
    || left.start.z - right.start.z
    || left.length - right.length;
}
