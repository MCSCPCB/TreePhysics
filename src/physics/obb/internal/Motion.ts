import type { Entity, Vector3 } from "@minecraft/server";
import type { ObbFrictionSettings } from "../Types";
import { EPSILON_1E6, add, dot, length, scale, subtract } from "@src/utils/Vector3Math";

const MOTION_EPSILON = EPSILON_1E6;

export interface TangentialFriction {
  readonly entity: Entity;
  readonly entityVelocity: Vector3;
  readonly normal: Vector3;
  /** Previous carrier velocity used while native movement input is active. */
  readonly previousSurfaceVelocity?: Vector3;
  readonly settings: ObbFrictionSettings;
  readonly surfaceVelocity: Vector3;
  /** Preserves native relative movement by transferring carrier delta only. */
  readonly transferSurfaceDelta?: boolean;
}

export interface TangentialFrictionResult {
  readonly impulse: Vector3;
  readonly magnitude: number;
  readonly mode: "kinetic" | "none" | "static";
}

export interface SurfaceMotionImpulse {
  readonly applyFriction: boolean;
  readonly entityVelocity: Vector3;
  readonly normal: Vector3;
  readonly previousSurfaceVelocity?: Vector3;
  readonly settings: ObbFrictionSettings;
  readonly surfaceVelocity: Vector3;
}

export interface SurfaceMotionImpulseResult {
  /** Unbounded carrier inheritance required to reproduce surface motion. */
  readonly carrierImpulse: Vector3;
  /** Bounded correction of relative tangential slip. */
  readonly frictionImpulse: Vector3;
  /** The single combined impulse that should be applied to the actor. */
  readonly impulse: Vector3;
  readonly magnitude: number;
}

const NO_FRICTION: TangentialFrictionResult = Object.freeze({
  impulse: Object.freeze({ x: 0, y: 0, z: 0 }),
  magnitude: 0,
  mode: "none"
});

const NO_SURFACE_MOTION: SurfaceMotionImpulseResult = Object.freeze({
  carrierImpulse: Object.freeze({ x: 0, y: 0, z: 0 }),
  frictionImpulse: Object.freeze({ x: 0, y: 0, z: 0 }),
  impulse: Object.freeze({ x: 0, y: 0, z: 0 }),
  magnitude: 0
});

/**
 * Separates rigid-surface motion inheritance from finite sliding friction.
 * Carrier inheritance is intentionally not capped by friction: otherwise a
 * fast but steady surface inevitably outruns the actor. The optional bounded
 * correction only removes relative tangential slip, and both contributions
 * are returned as one impulse so the caller performs one native operation.
 */
export function calculateSurfaceMotionImpulse(
  motion: SurfaceMotionImpulse
): SurfaceMotionImpulseResult {
  assertFiniteVector(motion.entityVelocity, "entityVelocity");
  assertFiniteVector(motion.surfaceVelocity, "surfaceVelocity");
  if (motion.previousSurfaceVelocity) {
    assertFiniteVector(
      motion.previousSurfaceVelocity,
      "previousSurfaceVelocity"
    );
  }
  assertFiniteVector(motion.normal, "normal");
  assertFrictionSettings(motion.settings);

  const normalLength = length(motion.normal);
  if (normalLength <= MOTION_EPSILON) {
    throw new RangeError("normal must be a finite non-zero vector.");
  }
  const normal = scale(motion.normal, 1 / normalLength);
  const surfaceTangent = rejectNormal(motion.surfaceVelocity, normal);
  const previousSurfaceTangent = rejectNormal(
    motion.previousSurfaceVelocity ?? motion.surfaceVelocity,
    normal
  );
  if (length(surfaceTangent) <= MOTION_EPSILON
    && length(previousSurfaceTangent) <= MOTION_EPSILON) {
    return NO_SURFACE_MOTION;
  }

  // Bedrock retains only this measured fraction of grounded horizontal
  // velocity. Supplying the missing carrier delta preserves constant surface
  // motion without repeatedly chasing it through a finite friction cap.
  const carrierImpulse = subtract(
    surfaceTangent,
    scale(previousSurfaceTangent, motion.settings.groundVelocityRetention)
  );
  let frictionImpulse = ZERO_VECTOR;
  if (motion.applyFriction) {
    const entityTangent = rejectNormal(motion.entityVelocity, normal);
    const velocityAfterInheritance = add(
      scale(entityTangent, motion.settings.groundVelocityRetention),
      carrierImpulse
    );
    const slipCorrection = subtract(surfaceTangent, velocityAfterInheritance);
    const slipMagnitude = length(slipCorrection);
    if (slipMagnitude > MOTION_EPSILON) {
      const correctionMagnitude = Math.min(
        slipMagnitude,
        motion.settings.maxStaticImpulse
      );
      frictionImpulse = scale(
        slipCorrection,
        correctionMagnitude / slipMagnitude
      );
    }
  }
  const impulse = add(carrierImpulse, frictionImpulse);
  const magnitude = length(impulse);
  if (magnitude <= MOTION_EPSILON) return NO_SURFACE_MOTION;
  return { carrierImpulse, frictionImpulse, impulse, magnitude };
}

/**
 * Applies finite friction in the contact plane only. Native collision owns
 * every normal response; this solver cannot lift, separate, or depenetrate an
 * actor regardless of contact error or OBB speed.
 */
export function applyTangentialFriction(
  friction: TangentialFriction
): TangentialFrictionResult {
  assertFiniteVector(friction.entityVelocity, "entityVelocity");
  assertFiniteVector(friction.surfaceVelocity, "surfaceVelocity");
  if (friction.previousSurfaceVelocity) {
    assertFiniteVector(
      friction.previousSurfaceVelocity,
      "previousSurfaceVelocity"
    );
  }
  assertFiniteVector(friction.normal, "normal");
  assertFrictionSettings(friction.settings);

  const normalLength = Math.hypot(
    friction.normal.x,
    friction.normal.y,
    friction.normal.z
  );
  if (normalLength <= MOTION_EPSILON) {
    throw new RangeError("normal must be a finite non-zero vector.");
  }
  const normal = scale(friction.normal, 1 / normalLength);
  const surfaceTangent = rejectNormal(friction.surfaceVelocity, normal);
  // A stationary contact plane does not exert scripted friction. This strict
  // boundary prevents actor movement, gravity, or contact error from turning
  // a static OBB into an impulse source.
  if (length(surfaceTangent) <= MOTION_EPSILON) return NO_FRICTION;

  const entityTangent = rejectNormal(friction.entityVelocity, normal);
  const retainedReference = friction.transferSurfaceDelta
    ? scale(rejectNormal(
      friction.previousSurfaceVelocity ?? ZERO_VECTOR,
      normal
    ), friction.settings.groundVelocityRetention)
    : scale(entityTangent, friction.settings.groundVelocityRetention);
  // Bedrock damps grounded horizontal velocity before the next displacement.
  // Inverting that measured retention is what keeps carrier and actor motion
  // simultaneous instead of allowing the actor to lose speed every tick.
  const required = subtract(surfaceTangent, retainedReference);
  const requiredMagnitude = length(required);
  if (requiredMagnitude <= MOTION_EPSILON) return NO_FRICTION;

  const isStatic = requiredMagnitude <= friction.settings.maxStaticImpulse;
  const magnitude = isStatic
    ? requiredMagnitude
    : Math.min(requiredMagnitude, friction.settings.kineticImpulse);
  if (magnitude <= MOTION_EPSILON) return NO_FRICTION;

  const impulse = scale(required, magnitude / requiredMagnitude);
  friction.entity.applyImpulse(impulse);
  return {
    impulse,
    magnitude,
    mode: isStatic ? "static" : "kinetic"
  };
}

export function rejectNormal(vector: Vector3, normal: Vector3): Vector3 {
  const normalComponent = dot(vector, normal);
  return {
    x: vector.x - normal.x * normalComponent,
    y: vector.y - normal.y * normalComponent,
    z: vector.z - normal.z * normalComponent
  };
}

function assertFiniteVector(vector: Vector3, name: string): void {
  if (!vector
    || !Number.isFinite(vector.x)
    || !Number.isFinite(vector.y)
    || !Number.isFinite(vector.z)) {
    throw new RangeError(`${name} must be a finite vector.`);
  }
}

/**
 * Validates finite friction settings. `namePrefix` only decorates the thrown
 * messages so each caller reports the field path its own API exposes
 * (e.g. "friction." from SolidObb settings validation).
 */
export function assertFrictionSettings(
  settings: ObbFrictionSettings,
  namePrefix = ""
): void {
  if (!settings
    || !Number.isFinite(settings.groundVelocityRetention)
    || settings.groundVelocityRetention < 0
    || settings.groundVelocityRetention > 1) {
    throw new RangeError(
      `${namePrefix}groundVelocityRetention must be finite and between zero and one.`
    );
  }
  if (!Number.isFinite(settings.maxStaticImpulse)
    || settings.maxStaticImpulse < 0) {
    throw new RangeError(
      `${namePrefix}maxStaticImpulse must be finite and non-negative.`
    );
  }
  if (!Number.isFinite(settings.kineticImpulse)
    || settings.kineticImpulse < 0
    || settings.kineticImpulse > settings.maxStaticImpulse) {
    throw new RangeError(
      `${namePrefix}kineticImpulse must be finite, non-negative, and no greater than ${namePrefix}maxStaticImpulse.`
    );
  }
}

const ZERO_VECTOR: Vector3 = Object.freeze({ x: 0, y: 0, z: 0 });
