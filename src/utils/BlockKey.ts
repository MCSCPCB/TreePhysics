import type { Vector3 } from "@minecraft/server";

export const LOCAL_BLOCK_KEY_BIAS = 512;
export const LOCAL_BLOCK_KEY_BASE = 2048;
export const LOCAL_BLOCK_COORDINATE_LIMIT = 511;

export function blockKey(location: Vector3): string {
  return `${location.x},${location.y},${location.z}`;
}

export function parseBlockKey(key: string): Vector3 {
  const [x, y, z] = key.split(",").map(Number);
  return { x: x!, y: y!, z: z! };
}

export function blockCenter(location: Vector3): Vector3 {
  return { x: location.x + 0.5, y: location.y + 0.5, z: location.z + 0.5 };
}

/** Integer packing shared by topology maps and local contraption indexes. */
export function packIntegerCoordinates(
  x: number,
  y: number,
  z: number,
  bias: number,
  base: number
): number {
  return (x + bias) + (y + bias) * base + (z + bias) * base * base;
}

export function packLocalBlockKey(x: number, y: number, z: number): number {
  if (
    x < -LOCAL_BLOCK_KEY_BIAS || x > LOCAL_BLOCK_COORDINATE_LIMIT
    || y < -LOCAL_BLOCK_KEY_BIAS || y > LOCAL_BLOCK_COORDINATE_LIMIT
    || z < -LOCAL_BLOCK_KEY_BIAS || z > LOCAL_BLOCK_COORDINATE_LIMIT
  ) return Number.NaN;
  return packIntegerCoordinates(x, y, z, LOCAL_BLOCK_KEY_BIAS, LOCAL_BLOCK_KEY_BASE);
}
