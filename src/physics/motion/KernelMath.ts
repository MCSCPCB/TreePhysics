// Quaternion, rotation-matrix, integer-bounds, and interval math utilities for
// the cannon kernel and its world-scan modules. Extracted from cannon-kernel.ts;
// keep these pure so every caller observes identical floating-point results.
import type { Vector3 } from "@minecraft/server";
import { Quaternion, Vec3 } from "cannon-es";
import type { Body } from "cannon-es";
import type { OrientedBoxRotationMatrix } from "@src/physics/collision/OrientedBoxAabbSat";

const DEGREES_TO_RADIANS = Math.PI / 180;
export const RADIANS_TO_DEGREES = 180 / Math.PI;

export interface IntegerBounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
}

export function multiplyInvInertiaWorld(body: Body, value: Vector3): Vec3 {
  return new Vec3(
    body.invInertiaWorld.e(0, 0) * value.x
      + body.invInertiaWorld.e(0, 1) * value.y
      + body.invInertiaWorld.e(0, 2) * value.z,
    body.invInertiaWorld.e(1, 0) * value.x
      + body.invInertiaWorld.e(1, 1) * value.y
      + body.invInertiaWorld.e(1, 2) * value.z,
    body.invInertiaWorld.e(2, 0) * value.x
      + body.invInertiaWorld.e(2, 1) * value.y
      + body.invInertiaWorld.e(2, 2) * value.z
  );
}

export function toCannonQuaternion(rotation: Vector3 | undefined): Quaternion {
  const quaternion = new Quaternion();
  if (!rotation) return quaternion;
  quaternion.setFromEuler(
    rotation.x * DEGREES_TO_RADIANS,
    rotation.y * DEGREES_TO_RADIANS,
    rotation.z * DEGREES_TO_RADIANS,
    "YZX"
  );
  return quaternion;
}

export function quaternionAngularDistance(left: Quaternion, right: Quaternion): number {
  const cosine = Math.min(1, Math.abs(
    left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w
  ));
  return 2 * Math.acos(cosine);
}

export function slerpQuaternionShortest(
  start: Quaternion,
  end: Quaternion,
  time: number
): Quaternion {
  let endX = end.x;
  let endY = end.y;
  let endZ = end.z;
  let endW = end.w;
  let cosine = start.x * endX + start.y * endY + start.z * endZ + start.w * endW;
  if (cosine < 0) {
    cosine = -cosine;
    endX = -endX;
    endY = -endY;
    endZ = -endZ;
    endW = -endW;
  }
  // Above this quaternion dot product the arc is tiny; slerp falls back to a
  // normalized lerp to avoid dividing by a near-zero sine.
  if (cosine > 0.9995) {
    const x = lerp(start.x, endX, time);
    const y = lerp(start.y, endY, time);
    const z = lerp(start.z, endZ, time);
    const w = lerp(start.w, endW, time);
    const inverseLength = 1 / Math.hypot(x, y, z, w);
    return new Quaternion(
      x * inverseLength,
      y * inverseLength,
      z * inverseLength,
      w * inverseLength
    );
  }
  const angle = Math.acos(Math.min(1, cosine));
  const inverseSine = 1 / Math.sin(angle);
  const startScale = Math.sin((1 - time) * angle) * inverseSine;
  const endScale = Math.sin(time * angle) * inverseSine;
  return new Quaternion(
    start.x * startScale + endX * endScale,
    start.y * startScale + endY * endScale,
    start.z * startScale + endZ * endScale,
    start.w * startScale + endW * endScale
  );
}

export function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  return new Quaternion(
    left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z
  );
}

export function quaternionRotationMatrix(rotation: Quaternion): OrientedBoxRotationMatrix {
  const r00 = 1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z);
  const r01 = 2 * (rotation.x * rotation.y - rotation.z * rotation.w);
  const r02 = 2 * (rotation.x * rotation.z + rotation.y * rotation.w);
  const r10 = 2 * (rotation.x * rotation.y + rotation.z * rotation.w);
  const r11 = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
  const r12 = 2 * (rotation.y * rotation.z - rotation.x * rotation.w);
  const r20 = 2 * (rotation.x * rotation.z - rotation.y * rotation.w);
  const r21 = 2 * (rotation.y * rotation.z + rotation.x * rotation.w);
  const r22 = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
  return {
    r00,
    r01,
    r02,
    r10,
    r11,
    r12,
    r20,
    r21,
    r22
  };
}

export function integerBoundsOverlap(left: IntegerBounds, right: IntegerBounds): boolean {
  return left.minX <= right.maxX
    && left.maxX >= right.minX
    && left.minY <= right.maxY
    && left.maxY >= right.minY
    && left.minZ <= right.maxZ
    && left.maxZ >= right.minZ;
}

export function lerp(start: number, end: number, time: number): number {
  return start + (end - start) * time;
}

export function predictBodyRotation(
  rotation: Quaternion,
  angularVelocity: Vec3,
  time: number,
  angle: number
): Quaternion {
  const inverseSpeed = time / angle;
  const halfAngle = angle / 2;
  const sine = Math.sin(halfAngle);
  const deltaX = angularVelocity.x * inverseSpeed * sine;
  const deltaY = angularVelocity.y * inverseSpeed * sine;
  const deltaZ = angularVelocity.z * inverseSpeed * sine;
  const deltaW = Math.cos(halfAngle);
  return new Quaternion(
    deltaW * rotation.x + deltaX * rotation.w + deltaY * rotation.z - deltaZ * rotation.y,
    deltaW * rotation.y - deltaX * rotation.z + deltaY * rotation.w + deltaZ * rotation.x,
    deltaW * rotation.z + deltaX * rotation.y - deltaY * rotation.x + deltaZ * rotation.w,
    deltaW * rotation.w - deltaX * rotation.x - deltaY * rotation.y - deltaZ * rotation.z
  );
}

export function transformAxisAlignedBounds(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  rotation: Quaternion,
  translation: Vec3
): { readonly max: Vector3; readonly min: Vector3 } {
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const halfX = (maxX - minX) / 2;
  const halfY = (maxY - minY) / 2;
  const halfZ = (maxZ - minZ) / 2;
  const x = rotation.x;
  const y = rotation.y;
  const z = rotation.z;
  const w = rotation.w;
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - z * w);
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const worldCenterX = translation.x + r00 * centerX + r01 * centerY + r02 * centerZ;
  const worldCenterY = translation.y + r10 * centerX + r11 * centerY + r12 * centerZ;
  const worldCenterZ = translation.z + r20 * centerX + r21 * centerY + r22 * centerZ;
  const worldHalfX = Math.abs(r00) * halfX + Math.abs(r01) * halfY + Math.abs(r02) * halfZ;
  const worldHalfY = Math.abs(r10) * halfX + Math.abs(r11) * halfY + Math.abs(r12) * halfZ;
  const worldHalfZ = Math.abs(r20) * halfX + Math.abs(r21) * halfY + Math.abs(r22) * halfZ;
  return {
    max: {
      x: worldCenterX + worldHalfX,
      y: worldCenterY + worldHalfY,
      z: worldCenterZ + worldHalfZ
    },
    min: {
      x: worldCenterX - worldHalfX,
      y: worldCenterY - worldHalfY,
      z: worldCenterZ - worldHalfZ
    }
  };
}

export function integerBoundsVolume(bounds: IntegerBounds): number {
  return Math.max(0, bounds.maxX - bounds.minX + 1)
    * Math.max(0, bounds.maxY - bounds.minY + 1)
    * Math.max(0, bounds.maxZ - bounds.minZ + 1);
}

export function integerBoundsOverlapOrTouch(left: IntegerBounds, right: IntegerBounds): boolean {
  return (
    left.minX <= right.maxX + 1
    && left.maxX + 1 >= right.minX
    && left.minY <= right.maxY + 1
    && left.maxY + 1 >= right.minY
    && left.minZ <= right.maxZ + 1
    && left.maxZ + 1 >= right.minZ
  );
}

export function mergeIntegerBounds(left: IntegerBounds, right: IntegerBounds): IntegerBounds {
  return {
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
    maxZ: Math.max(left.maxZ, right.maxZ),
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    minZ: Math.min(left.minZ, right.minZ)
  };
}

export function intersectIntegerBounds(
  left: IntegerBounds,
  right: IntegerBounds
): IntegerBounds | undefined {
  const bounds = {
    maxX: Math.min(left.maxX, right.maxX),
    maxY: Math.min(left.maxY, right.maxY),
    maxZ: Math.min(left.maxZ, right.maxZ),
    minX: Math.max(left.minX, right.minX),
    minY: Math.max(left.minY, right.minY),
    minZ: Math.max(left.minZ, right.minZ)
  };
  return bounds.minX <= bounds.maxX
      && bounds.minY <= bounds.maxY
      && bounds.minZ <= bounds.maxZ
    ? bounds
    : undefined;
}

export function addMergedNumericInterval(intervals: number[], minX: number, maxX: number): void {
  let index = 0;
  while (index < intervals.length && intervals[index + 1]! < minX - 1) index += 2;
  if (index >= intervals.length) {
    intervals.push(minX, maxX);
    return;
  }
  if (maxX < intervals[index]! - 1) {
    intervals.splice(index, 0, minX, maxX);
    return;
  }
  intervals[index] = Math.min(intervals[index]!, minX);
  intervals[index + 1] = Math.max(intervals[index + 1]!, maxX);
  let next = index + 2;
  while (next < intervals.length && intervals[next]! <= intervals[index + 1]! + 1) {
    intervals[index + 1] = Math.max(intervals[index + 1]!, intervals[next + 1]!);
    next += 2;
  }
  if (next > index + 2) intervals.splice(index + 2, next - index - 2);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
