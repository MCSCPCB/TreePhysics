import type { Dimension, Vector3 } from "@minecraft/server";
import type { PhysicsBody, PhysicsBodyAabb } from "@src/Physics";
import {
  clamp,
  EPSILON_1E8,
  isFiniteVector,
  length,
  scale,
  subtract
} from "@src/utils/Vector3Math";
import { sphereIntersectsAabb } from "@src/content/contraption/interaction/ContactQuery";

export const MAX_PISTON_EFFECTS_PER_CONTRAPTION = 16;
export const EXPLOSION_PLAYER_IMPULSE_MULTIPLIER = 2.78;
export const PISTON_PLAYER_IMPULSE_MULTIPLIER = 2.5;
export const SLIME_PISTON_PLAYER_IMPULSE_MULTIPLIER = PISTON_PLAYER_IMPULSE_MULTIPLIER * EXPLOSION_PLAYER_IMPULSE_MULTIPLIER;
export const EXPLOSION_OCCLUDED_IMPULSE_SCALE = 0.35;
const EXPLOSION_FALLOFF_POWER = 0.68;
const EXPLOSION_UPWARD_BIAS = 0.4;
const MAX_EXPLOSION_EFFECTS_PER_CONTRAPTION = 16;
export const MAX_OCCLUSION_RAYS_PER_CONTRAPTION = 4;
export const MAX_BATCH_LINEAR_VELOCITY_CHANGE = 12;
export const MAX_BATCH_ANGULAR_VELOCITY_CHANGE = 2.5;
const VECTOR_EPSILON = EPSILON_1E8;

export interface PendingExplosionEffect {
  center: Vector3;
  count: number;
  dimension: Dimension;
  radius: number;
}

export interface BodyImpulseAccumulator {
  body: PhysicsBody;
  centerOfMass: Vector3;
  linear: Vector3;
  pistonLinear: Vector3;
  torque: Vector3;
  pistonTorque: Vector3;
  wakeOnly: boolean;
}

interface PistonImpulseInput {
  playerImpulse: number;
  playerImpulseMultiplier: number;
}

interface ExplosionImpulseInput {
  count: number;
  distance: number;
  occlusionScale: number;
  playerImpulse: number;
  radius: number;
}

export function computePistonImpulseMagnitude(input: PistonImpulseInput): number {
  if (!Number.isFinite(input.playerImpulse) || !Number.isFinite(input.playerImpulseMultiplier) || input.playerImpulse < 0 || input.playerImpulseMultiplier < 0) return 0;
  return input.playerImpulse * input.playerImpulseMultiplier;
}

export function computeExplosionImpulseMagnitude(input: ExplosionImpulseInput): number {
  if (!Number.isFinite(input.count) || !Number.isFinite(input.distance) || !Number.isFinite(input.occlusionScale) || !Number.isFinite(input.playerImpulse) || !Number.isFinite(input.radius) || input.occlusionScale < 0 || input.radius <= 0 || input.playerImpulse < 0 || input.distance >= input.radius) return 0;
  const attenuation = Math.pow(Math.max(0, 1 - input.distance / input.radius), EXPLOSION_FALLOFF_POWER);
  const explosionImpulse = input.playerImpulse * EXPLOSION_PLAYER_IMPULSE_MULTIPLIER;
  const countScale = Math.min(2, Math.sqrt(Math.max(1, Math.floor(input.count))));
  return input.occlusionScale * attenuation * countScale * explosionImpulse;
}

export function createAccumulator(body: PhysicsBody): BodyImpulseAccumulator {
  return { body, centerOfMass: body.localPointToWorld(body.getCenterOfMass()), linear: zeroVector(), pistonLinear: zeroVector(), torque: zeroVector(), pistonTorque: zeroVector(), wakeOnly: false };
}

export function addImpulseAt(accumulator: BodyImpulseAccumulator, location: Vector3, impulse: Vector3): void {
  if (!isFiniteVector(impulse) || isNegligibleVector(impulse)) return;
  const armX = location.x - accumulator.centerOfMass.x;
  const armY = location.y - accumulator.centerOfMass.y;
  const armZ = location.z - accumulator.centerOfMass.z;
  accumulator.linear.x += impulse.x;
  accumulator.linear.y += impulse.y;
  accumulator.linear.z += impulse.z;
  accumulator.torque.x += armY * impulse.z - armZ * impulse.y;
  accumulator.torque.y += armZ * impulse.x - armX * impulse.z;
  accumulator.torque.z += armX * impulse.y - armY * impulse.x;
}

/** Records piston thrust separately so its configured floor is not batch-clamped. */
export function addPistonImpulseAt(
  accumulator: BodyImpulseAccumulator,
  location: Vector3,
  impulse: Vector3
): void {
  if (!isFiniteVector(impulse) || isNegligibleVector(impulse)) return;
  const armX = location.x - accumulator.centerOfMass.x;
  const armY = location.y - accumulator.centerOfMass.y;
  const armZ = location.z - accumulator.centerOfMass.z;
  accumulator.pistonLinear.x += impulse.x;
  accumulator.pistonLinear.y += impulse.y;
  accumulator.pistonLinear.z += impulse.z;
  accumulator.pistonTorque.x += armY * impulse.z - armZ * impulse.y;
  accumulator.pistonTorque.y += armZ * impulse.x - armX * impulse.z;
  accumulator.pistonTorque.z += armX * impulse.y - armY * impulse.x;
}

export function getExplosionDirection(center: Vector3, contact: Vector3, centerOfMass: Vector3): Vector3 {
  let radial = subtract(contact, center);
  if (length(radial) < VECTOR_EPSILON) radial = subtract(centerOfMass, center);
  radial.y += EXPLOSION_UPWARD_BIAS;
  const direction = normalize(radial);
  return length(direction) >= VECTOR_EPSILON ? direction : { x: 0, y: 1, z: 0 };
}

export function isWorldOccluded(dimension: Dimension, center: Vector3, contact: Vector3): boolean {
  const offset = subtract(contact, center);
  const distance = length(offset);
  if (!Number.isFinite(distance) || distance <= 0.2) return false;
  try {
    return dimension.getBlockFromRay(center, scale(offset, 1 / distance), { includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: Math.max(0, distance - 0.15) }) !== undefined;
  } catch {
    // getBlockFromRay throws for rays entering unloaded chunks; treat those as
    // unoccluded so the explosion still applies.
    return false;
  }
}

export function selectNearbyExplosions(explosions: readonly PendingExplosionEffect[], bounds: PhysicsBodyAabb): PendingExplosionEffect[] {
  const selected: { effect: PendingExplosionEffect; score: number }[] = [];
  for (const effect of explosions) {
    if (!sphereIntersectsAabb(effect.center, effect.radius, bounds)) continue;
    const closest = { x: clamp(effect.center.x, bounds.min.x, bounds.max.x), y: clamp(effect.center.y, bounds.min.y, bounds.max.y), z: clamp(effect.center.z, bounds.min.z, bounds.max.z) };
    const offset = subtract(effect.center, closest);
    const score = squaredLength(offset) / (effect.radius * effect.radius);
    let index = selected.length;
    while (index > 0 && score < selected[index - 1]!.score) index--;
    if (index >= MAX_EXPLOSION_EFFECTS_PER_CONTRAPTION) continue;
    selected.splice(index, 0, { effect, score });
    if (selected.length > MAX_EXPLOSION_EFFECTS_PER_CONTRAPTION) selected.pop();
  }
  return selected.map(value => value.effect);
}

export function getExplosionMergeKey(center: Vector3, radius: number): string {
  return `${Math.round(center.x * 4)},${Math.round(center.y * 4)},${Math.round(center.z * 4)}|${Math.round(radius * 2)}`;
}

export function weightedAverage(left: Vector3, leftWeight: number, right: Vector3, rightWeight: number): Vector3 {
  const total = leftWeight + rightWeight;
  return { x: (left.x * leftWeight + right.x * rightWeight) / total, y: (left.y * leftWeight + right.y * rightWeight) / total, z: (left.z * leftWeight + right.z * rightWeight) / total };
}

export function isAxisDirection(value: Vector3): boolean {
  if (!isFiniteVector(value)) return false;
  const nonZero = Number(value.x !== 0) + Number(value.y !== 0) + Number(value.z !== 0);
  return nonZero === 1 && Math.abs(value.x + value.y + value.z) === 1;
}

export function isNegligibleVector(value: Vector3): boolean { return squaredLength(value) < VECTOR_EPSILON * VECTOR_EPSILON; }

export function clampMagnitude(value: Vector3, maximum: number): Vector3 {
  if (!Number.isFinite(maximum) || maximum <= 0) return zeroVector();
  const magnitude = length(value);
  return magnitude <= maximum || magnitude < VECTOR_EPSILON ? value : scale(value, maximum / magnitude);
}

function normalize(value: Vector3): Vector3 {
  const magnitude = length(value);
  return magnitude > VECTOR_EPSILON ? scale(value, 1 / magnitude) : zeroVector();
}

function squaredLength(value: Vector3): number { return value.x * value.x + value.y * value.y + value.z * value.z; }
function zeroVector(): Vector3 { return { x: 0, y: 0, z: 0 }; }
