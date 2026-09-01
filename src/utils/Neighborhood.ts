import type { Vector3 } from "@minecraft/server";
import { blockKey } from "@src/utils/BlockKey";
import { add } from "@src/utils/Vector3Math";

export const FACE_OFFSETS: readonly Vector3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 }
];

export const NEIGHBOR_OFFSETS: readonly Vector3[] = (() => {
  const offsets: Vector3[] = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (x !== 0 || y !== 0 || z !== 0) offsets.push({ x, y, z });
      }
    }
  }
  return offsets;
})();

export const NEIGHBOR_OFFSETS_WITH_CENTER: readonly Vector3[] = [
  { x: 0, y: 0, z: 0 },
  ...NEIGHBOR_OFFSETS
];

export function hasNeighborKey(
  location: Vector3,
  keys: ReadonlyMap<string, unknown> | ReadonlySet<string>,
  offsets: readonly Vector3[] = NEIGHBOR_OFFSETS
): boolean {
  for (const offset of offsets) {
    if (keys.has(blockKey(add(location, offset)))) return true;
  }
  return false;
}
