import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraption, PhysicsContraptionBlock, PhysicsBodyAabb } from "@src/Physics";
import {
  clamp,
  dot,
  isFiniteVector,
  subtract,
  EPSILON_1E8
} from "@src/utils/Vector3Math";

const CONTACT_EPSILON = EPSILON_1E8;
const SAT_EPSILON = 1e-7;

export interface LocalBox { min: Vector3; max: Vector3; }
export interface OrthonormalBasis { x: Vector3; y: Vector3; z: Vector3; }
export interface SatBasis {
  readonly axes: readonly [Vector3, Vector3, Vector3];
  readonly rotation: Float64Array;
  readonly absolute: Float64Array;
}

export function getLocalCollisionBoxes(block: PhysicsContraptionBlock, requireCollisionResponse: boolean): readonly LocalBox[] {
  if (block.collidable === false || block.collisionShape === "none" || (requireCollisionResponse && block.collisionResponse === false)) return [];
  if (!block.collisionShape || block.collisionShape === "full") {
    return [{
      min: { x: block.localLocation.x - 0.5, y: block.localLocation.y - 0.5, z: block.localLocation.z - 0.5 },
      max: { x: block.localLocation.x + 0.5, y: block.localLocation.y + 0.5, z: block.localLocation.z + 0.5 }
    }];
  }
  return block.collisionShape.map(box => ({
    min: { x: block.localLocation.x + box.min.x - 0.5, y: block.localLocation.y + box.min.y - 0.5, z: block.localLocation.z + box.min.z - 0.5 },
    max: { x: block.localLocation.x + box.max.x - 0.5, y: block.localLocation.y + box.max.y - 0.5, z: block.localLocation.z + box.max.z - 0.5 }
  }));
}

export function getContraptionBasis(contraption: PhysicsContraption): OrthonormalBasis {
  const origin = contraption.body.localPointToWorld({ x: 0, y: 0, z: 0 });
  return {
    x: normalize(subtract(contraption.body.localPointToWorld({ x: 1, y: 0, z: 0 }), origin)),
    y: normalize(subtract(contraption.body.localPointToWorld({ x: 0, y: 1, z: 0 }), origin)),
    z: normalize(subtract(contraption.body.localPointToWorld({ x: 0, y: 0, z: 1 }), origin))
  };
}

export function worldAabbToLocalBounds(contraption: PhysicsContraption, bounds: PhysicsBodyAabb): PhysicsBodyAabb {
  const corners: Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) corners.push(contraption.body.worldPointToLocal({ x, y, z }));
    }
  }
  const first = corners[0]!;
  const result = { min: { ...first }, max: { ...first } };
  for (let index = 1; index < corners.length; index++) {
    const point = corners[index]!;
    result.min.x = Math.min(result.min.x, point.x);
    result.min.y = Math.min(result.min.y, point.y);
    result.min.z = Math.min(result.min.z, point.z);
    result.max.x = Math.max(result.max.x, point.x);
    result.max.y = Math.max(result.max.y, point.y);
    result.max.z = Math.max(result.max.z, point.z);
  }
  return result;
}

export function prepareSatBasis(basis: OrthonormalBasis): SatBasis {
  const rotation = new Float64Array(9);
  const absolute = new Float64Array(9);
  const axes = [basis.x, basis.y, basis.z] as const;
  for (let row = 0; row < 3; row++) {
    const axis = axes[row]!;
    rotation[row * 3] = axis.x;
    rotation[row * 3 + 1] = axis.y;
    rotation[row * 3 + 2] = axis.z;
    absolute[row * 3] = Math.abs(axis.x) + SAT_EPSILON;
    absolute[row * 3 + 1] = Math.abs(axis.y) + SAT_EPSILON;
    absolute[row * 3 + 2] = Math.abs(axis.z) + SAT_EPSILON;
  }
  return { absolute, axes, rotation };
}

/** Separating-axis test for an oriented contraption block against an axis-aligned piston volume. */
export function obbIntersectsAabb(obbCenter: Vector3, obbHalf: Vector3, sat: SatBasis, bounds: PhysicsBodyAabb): boolean {
  const { absolute, axes, rotation } = sat;
  const translationX = obbCenter.x - (bounds.min.x + bounds.max.x) * 0.5;
  const translationY = obbCenter.y - (bounds.min.y + bounds.max.y) * 0.5;
  const translationZ = obbCenter.z - (bounds.min.z + bounds.max.z) * 0.5;
  const halfA0 = obbHalf.x;
  const halfA1 = obbHalf.y;
  const halfA2 = obbHalf.z;
  const halfB0 = (bounds.max.x - bounds.min.x) * 0.5;
  const halfB1 = (bounds.max.y - bounds.min.y) * 0.5;
  const halfB2 = (bounds.max.z - bounds.min.z) * 0.5;
  const translationA0 = translationX * axes[0].x + translationY * axes[0].y + translationZ * axes[0].z;
  const translationA1 = translationX * axes[1].x + translationY * axes[1].y + translationZ * axes[1].z;
  const translationA2 = translationX * axes[2].x + translationY * axes[2].y + translationZ * axes[2].z;
  const translationA = [translationA0, translationA1, translationA2] as const;
  const halfA = [halfA0, halfA1, halfA2] as const;
  const halfB = [halfB0, halfB1, halfB2] as const;
  for (let i = 0; i < 3; i++) {
    const projected = Math.abs(translationA[i]!);
    const radiusB = halfB0 * absolute[i * 3]! + halfB1 * absolute[i * 3 + 1]! + halfB2 * absolute[i * 3 + 2]!;
    if (projected > halfA[i]! + radiusB) return false;
  }
  const translationB = [translationX, translationY, translationZ] as const;
  for (let j = 0; j < 3; j++) {
    const radiusA = halfA0 * absolute[j]! + halfA1 * absolute[3 + j]! + halfA2 * absolute[6 + j]!;
    if (Math.abs(translationB[j]!) > radiusA + halfB[j]!) return false;
  }
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const projected = Math.abs(translationA[i2]! * rotation[i1 * 3 + j]! - translationA[i1]! * rotation[i2 * 3 + j]!);
      const radiusA = halfA[i1]! * absolute[i2 * 3 + j]! + halfA[i2]! * absolute[i1 * 3 + j]!;
      const radiusB = halfB[j1]! * absolute[i * 3 + j2]! + halfB[j2]! * absolute[i * 3 + j1]!;
      if (projected > radiusA + radiusB) return false;
    }
  }
  return true;
}

export function getObbSupportPoint(center: Vector3, halfExtents: Vector3, basis: OrthonormalBasis, direction: Vector3): Vector3 {
  const result = { ...center };
  for (const [axis, extent] of [[basis.x, halfExtents.x], [basis.y, halfExtents.y], [basis.z, halfExtents.z]] as const) {
    const projection = dot(axis, direction);
    // A perpendicular axis spans the whole support face. Keep its center so an
    // axis-aligned piston does not turn a centered face hit into a corner hit.
    const amount = Math.abs(projection) <= CONTACT_EPSILON
      ? 0
      : projection > 0 ? extent : -extent;
    result.x += axis.x * amount;
    result.y += axis.y * amount;
    result.z += axis.z * amount;
  }
  return result;
}

export function clampPointToAabb(point: Vector3, bounds: PhysicsBodyAabb): Vector3 {
  return { x: clamp(point.x, bounds.min.x, bounds.max.x), y: clamp(point.y, bounds.min.y, bounds.max.y), z: clamp(point.z, bounds.min.z, bounds.max.z) };
}

export function isAxisDirection(value: Vector3): boolean {
  if (!isFiniteVector(value)) return false;
  const nonZero = Number(value.x !== 0) + Number(value.y !== 0) + Number(value.z !== 0);
  return nonZero === 1 && Math.abs(value.x + value.y + value.z) === 1;
}

export function midpoint(left: Vector3, right: Vector3): Vector3 {
  return { x: (left.x + right.x) * 0.5, y: (left.y + right.y) * 0.5, z: (left.z + right.z) * 0.5 };
}

function normalize(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > CONTACT_EPSILON ? { x: value.x / length, y: value.y / length, z: value.z / length } : { x: 0, y: 0, z: 0 };
}
