import type { Vector3 } from "@minecraft/server";
import { blockKey, parseBlockKey } from "@src/utils/BlockKey";

export interface VoxelBox {
  readonly min: Vector3;
  readonly size: Vector3;
}
type Axis = "x" | "y" | "z";

const AXIS_ORDERS: readonly (readonly [Axis, Axis, Axis])[] = [
  ["x", "z", "y"],
  ["x", "y", "z"],
  ["y", "x", "z"],
  ["y", "z", "x"],
  ["z", "x", "y"],
  ["z", "y", "x"]
];

/**
 * Covers integer voxels exactly with deterministic, non-overlapping boxes.
 * This minimum-box mesher intentionally differs from cannon-kernel's
 * per-tick GreedyBoxMesher, which prioritizes update throughput.
 */
export function meshVoxels(locations: readonly Vector3[]): VoxelBox[] {
  let best: VoxelBox[] | undefined;
  for (const order of AXIS_ORDERS) {
    const candidate = meshVoxelsInAxisOrder(locations, order);
    if (!best || candidate.length < best.length) best = candidate;
  }
  return best ?? [];
}

function meshVoxelsInAxisOrder(
  locations: readonly Vector3[],
  order: readonly [Axis, Axis, Axis]
): VoxelBox[] {
  const remaining = new Set(locations.map(blockKey));
  const sortOrder = [order[2], order[1], order[0]] as const;
  const starts = [...remaining]
    .map(parseBlockKey)
    .sort((left, right) =>
      left[sortOrder[0]] - right[sortOrder[0]]
      || left[sortOrder[1]] - right[sortOrder[1]]
      || left[sortOrder[2]] - right[sortOrder[2]]
    );
  const boxes: VoxelBox[] = [];

  for (const start of starts) {
    if (!remaining.has(blockKey(start))) continue;
    const size = { x: 1, y: 1, z: 1 };
    for (const axis of order) {
      while (canGrowBox(remaining, start, size, axis)) size[axis]++;
    }

    for (let y = 0; y < size.y; y++) {
      for (let z = 0; z < size.z; z++) {
        for (let x = 0; x < size.x; x++) {
          remaining.delete(blockKey({ x: start.x + x, y: start.y + y, z: start.z + z }));
        }
      }
    }

    boxes.push({
      min: { ...start },
      size
    });
  }

  return boxes;
}

function canGrowBox(
  remaining: ReadonlySet<string>,
  start: Vector3,
  size: Vector3,
  axis: Axis
): boolean {
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const offset = { x, y, z };
        if (offset[axis] !== 0) continue;
        offset[axis] = size[axis];
        if (!remaining.has(blockKey({
          x: start.x + offset.x,
          y: start.y + offset.y,
          z: start.z + offset.z
        }))) return false;
      }
    }
  }
  return true;
}
