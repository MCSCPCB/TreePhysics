import type { Vector3 } from "@minecraft/server";

/** Shared scalar epsilon values whose numeric identity is part of the query contracts. */
export const EPSILON_1E8 = 1e-8;
export const EPSILON_1E6 = 0.000001;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function add(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

export function subtract(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

export function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function scale(value: Vector3, amount: number): Vector3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

export function length(value: Vector3): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function squaredDistance(left: Vector3, right: Vector3): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Division-based normalization shared by the two identical finite-vector callers. */
export function normalizeFinite(value: Vector3): Vector3 {
  const magnitude = Math.hypot(value.x, value.y, value.z);
  return !Number.isFinite(magnitude) || magnitude < EPSILON_1E8
    ? { x: 0, y: 0, z: 0 }
    : { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude };
}

export function isFiniteVector(value: Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export function isIntegerVector(value: Vector3): boolean {
  return Number.isInteger(value.x) && Number.isInteger(value.y) && Number.isInteger(value.z);
}

export function vectorsEqual(left: Vector3, right: Vector3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}
