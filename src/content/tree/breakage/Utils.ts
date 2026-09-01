import type { Vector3 } from "@minecraft/server";
import type { TreeLogBreakageBlock } from "@src/content/tree/breakage/Plan";

export function deterministicShuffle<T>(values: T[], seed: number): void {
  for (let index = values.length - 1; index > 0; index--) {
    seed = mix(seed, index);
    const selected = seed % (index + 1);
    [values[index], values[selected]] = [values[selected]!, values[index]!];
  }
}

export function normalizeSeed(value: string | number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value) >>> 0;
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mix(left: number, right: number): number {
  let value = (left ^ Math.imul(right, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export function compareBlocks(left: TreeLogBreakageBlock, right: TreeLogBreakageBlock): number {
  return left.localLocation.y - right.localLocation.y
    || left.localLocation.x - right.localLocation.x
    || left.localLocation.z - right.localLocation.z
    || left.key.localeCompare(right.key);
}

export function isIntegerVector(value: Vector3): boolean {
  return !!value
    && Number.isInteger(value.x)
    && Number.isInteger(value.y)
    && Number.isInteger(value.z);
}

export function trunkColumnKey(location: Pick<Vector3, "x" | "z">): string {
  return `${location.x},${location.z}`;
}
