import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraption } from "@src/Physics";
import { clamp } from "@src/utils/Vector3Math";

export const DRAG_VALIDATION_REACH = 7;
const DRAG_MINIMUM_DISTANCE = 2;
const DRAG_MAXIMUM_DISTANCE = 2.5;
export const DRAG_STIFFNESS = 240;
export const DRAG_DAMPING = 30;
export const DRAG_MAX_FORCE_PER_AXIS = 120;
export const DRAG_ANGULAR_DAMPING = 4.5;
const DRAG_MAX_NATURAL_FREQUENCY_STEP = 0.5;
const DRAG_STABILITY_MARGIN = 0.8;
const DRAG_REST_POSITION_EPSILON = 0.01;
const DRAG_REST_LINEAR_SPEED_EPSILON = 0.02;
const DRAG_REST_ANGULAR_SPEED_EPSILON = 0.02;

interface DragForceInput {
  damping: number;
  grabPoint: Vector3;
  maxForcePerAxis: number;
  pointVelocity: Vector3;
  stiffness: number;
  targetPoint: Vector3;
}

interface AngularDampingTorqueInput {
  angularVelocity: Vector3;
  damping: number;
  maxTorquePerAxis: number;
}

interface StableDragForceInput extends DragForceInput {
  effectiveMass: Vector3;
  timeStep: number;
}

interface StableAngularDampingTorqueInput extends AngularDampingTorqueInput {
  effectiveInertia: Vector3;
  timeStep: number;
}

interface DragRestInput {
  angularVelocity: Vector3;
  grabPoint: Vector3;
  pointVelocity: Vector3;
  targetPoint: Vector3;
}

export function computeDragForce(input: DragForceInput): Vector3 {
  return clampVectorPerAxis({
    x: (input.targetPoint.x - input.grabPoint.x) * input.stiffness
      - input.pointVelocity.x * input.damping,
    y: (input.targetPoint.y - input.grabPoint.y) * input.stiffness
      - input.pointVelocity.y * input.damping,
    z: (input.targetPoint.z - input.grabPoint.z) * input.stiffness
      - input.pointVelocity.z * input.damping
  }, input.maxForcePerAxis);
}

export function computeAngularDampingTorque(input: AngularDampingTorqueInput): Vector3 {
  return clampVectorPerAxis({
    x: -input.angularVelocity.x * input.damping,
    y: -input.angularVelocity.y * input.damping,
    z: -input.angularVelocity.z * input.damping
  }, input.maxTorquePerAxis);
}

export function computeStableDragForce(input: StableDragForceInput): Vector3 {
  // The physics body's fixed time step can be swapped at runtime, so keep the
  // finiteness guard on it; stiffness and damping are module constants.
  const timeStep = finiteNonNegative(input.timeStep);
  return {
    x: computeStableMotorForce(input.targetPoint.x - input.grabPoint.x, input.pointVelocity.x, input.effectiveMass.x, input.stiffness, input.damping, timeStep, input.maxForcePerAxis),
    y: computeStableMotorForce(input.targetPoint.y - input.grabPoint.y, input.pointVelocity.y, input.effectiveMass.y, input.stiffness, input.damping, timeStep, input.maxForcePerAxis),
    z: computeStableMotorForce(input.targetPoint.z - input.grabPoint.z, input.pointVelocity.z, input.effectiveMass.z, input.stiffness, input.damping, timeStep, input.maxForcePerAxis)
  };
}

export function computeStableAngularDampingTorque(
  input: StableAngularDampingTorqueInput
): Vector3 {
  const timeStep = finiteNonNegative(input.timeStep);
  return {
    x: computeImplicitDampingTorque(input.angularVelocity.x, input.effectiveInertia.x, input.damping, timeStep, input.maxTorquePerAxis),
    y: computeImplicitDampingTorque(input.angularVelocity.y, input.effectiveInertia.y, input.damping, timeStep, input.maxTorquePerAxis),
    z: computeImplicitDampingTorque(input.angularVelocity.z, input.effectiveInertia.z, input.damping, timeStep, input.maxTorquePerAxis)
  };
}

export function computeDragDistance(hitDistance: number): number {
  return clamp(hitDistance, DRAG_MINIMUM_DISTANCE, DRAG_MAXIMUM_DISTANCE);
}

export type DragItemUseAction = "acquire" | "ignore" | "release";

export function resolveDragItemUseAction(
  hasSession: boolean,
  hasTarget: boolean
): DragItemUseAction {
  if (hasSession) return "release";
  return hasTarget ? "acquire" : "ignore";
}

export function isDragConstraintAtRest(input: DragRestInput): boolean {
  return distance(input.grabPoint, input.targetPoint) <= DRAG_REST_POSITION_EPSILON
    && vectorLength(input.pointVelocity) <= DRAG_REST_LINEAR_SPEED_EPSILON
    && vectorLength(input.angularVelocity) <= DRAG_REST_ANGULAR_SPEED_EPSILON;
}

function clampVectorPerAxis(value: Vector3, maximum: number): Vector3 {
  return {
    x: clampFinite(value.x, -maximum, maximum),
    y: clampFinite(value.y, -maximum, maximum),
    z: clampFinite(value.z, -maximum, maximum)
  };
}

function computeStableMotorForce(positionError: number, pointVelocity: number, effectiveMass: number, stiffness: number, damping: number, timeStep: number, maximumForce: number): number {
  if (!Number.isFinite(positionError) || !Number.isFinite(pointVelocity) || !Number.isFinite(effectiveMass) || effectiveMass <= 0) return 0;
  let stableStiffness = stiffness;
  let stableDamping = damping;
  if (timeStep > 0) {
    const maximumStiffness = effectiveMass * Math.pow(DRAG_MAX_NATURAL_FREQUENCY_STEP / timeStep, 2);
    stableStiffness = Math.min(stiffness, maximumStiffness);
    if (stiffness > 0) stableDamping *= Math.sqrt(stableStiffness / stiffness);
    const dampingBudget = (4 * DRAG_STABILITY_MARGIN * effectiveMass - timeStep * timeStep * stableStiffness) / (2 * timeStep);
    stableDamping = Math.min(stableDamping, Math.max(0, dampingBudget), effectiveMass / timeStep);
  }
  // Preserve the original damping ratio while keeping each semi-implicit substep stable.
  const stableForce = stableStiffness * positionError - stableDamping * pointVelocity;
  const limit = finiteNonNegative(maximumForce);
  return clampFinite(stableForce, -limit, limit);
}

function computeImplicitDampingTorque(angularVelocity: number, effectiveInertia: number, damping: number, timeStep: number, maximumTorque: number): number {
  if (!Number.isFinite(angularVelocity) || !Number.isFinite(effectiveInertia) || effectiveInertia <= 0) return 0;
  const limit = finiteNonNegative(maximumTorque);
  return clampFinite(-damping * angularVelocity / (1 + timeStep * damping / effectiveInertia), -limit, limit);
}

const WORLD_AXIS_X: Vector3 = Object.freeze({ x: 1, y: 0, z: 0 });
const WORLD_AXIS_Y: Vector3 = Object.freeze({ x: 0, y: 1, z: 0 });
const WORLD_AXIS_Z: Vector3 = Object.freeze({ x: 0, y: 0, z: 1 });

export function getEffectiveMassByWorldAxis(body: PhysicsContraption["body"], location: Vector3): Vector3 {
  return {
    x: body.getEffectiveMassAt(location, WORLD_AXIS_X),
    y: body.getEffectiveMassAt(location, WORLD_AXIS_Y),
    z: body.getEffectiveMassAt(location, WORLD_AXIS_Z)
  };
}

export function getEffectiveInertiaByWorldAxis(body: PhysicsContraption["body"]): Vector3 {
  return {
    x: body.getEffectiveInertia(WORLD_AXIS_X),
    y: body.getEffectiveInertia(WORLD_AXIS_Y),
    z: body.getEffectiveInertia(WORLD_AXIS_Z)
  };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : 0;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function distance(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function vectorLength(value: Vector3): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function isNegligibleVector(value: Vector3): boolean {
  return Math.abs(value.x) < 1e-6 && Math.abs(value.y) < 1e-6 && Math.abs(value.z) < 1e-6;
}
