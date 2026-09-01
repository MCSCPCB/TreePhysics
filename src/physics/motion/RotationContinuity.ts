export interface EulerDegrees {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface QuaternionComponents {
  readonly w: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Vector3Components {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const SINGULARITY_THRESHOLD = 0.499999;

/** Rotates a vector using the same YZX Euler convention as Cannon-es. */
export function rotateVectorByEulerDegreesYzx(
  vector: Vector3Components,
  rotation: EulerDegrees
): Vector3Components {
  const halfX = rotation.x * DEGREES_TO_RADIANS / 2;
  const halfY = rotation.y * DEGREES_TO_RADIANS / 2;
  const halfZ = rotation.z * DEGREES_TO_RADIANS / 2;
  const c1 = Math.cos(halfX);
  const c2 = Math.cos(halfY);
  const c3 = Math.cos(halfZ);
  const s1 = Math.sin(halfX);
  const s2 = Math.sin(halfY);
  const s3 = Math.sin(halfZ);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 + s1 * c2 * s3;
  const qz = c1 * c2 * s3 - s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  const ix = qw * vector.x + qy * vector.z - qz * vector.y;
  const iy = qw * vector.y + qz * vector.x - qx * vector.z;
  const iz = qw * vector.z + qx * vector.y - qy * vector.x;
  const iw = -qx * vector.x - qy * vector.y - qz * vector.z;
  return {
    x: ix * qw - iw * qx - iy * qz + iz * qy,
    y: iy * qw - iw * qy - iz * qx + ix * qz,
    z: iz * qw - iw * qz - ix * qy + iy * qx
  };
}

/**
 * Converts a quaternion to the YZX Euler convention used by the entity
 * animation hierarchy, choosing the representation nearest to the prior
 * visual frame. This prevents equivalent Euler branches from interpolating
 * through a visibly different orientation near gimbal lock.
 */
export function quaternionToContinuousEulerDegreesYzx(
  quaternion: QuaternionComponents,
  reference?: EulerDegrees
): EulerDegrees {
  const referenceX = reference?.x ?? 0;
  const referenceY = reference?.y ?? 0;
  const referenceZ = reference?.z ?? 0;
  const { x, y, z, w } = quaternion;
  const test = x * y + z * w;
  let primaryX: number;
  let primaryY: number;
  let primaryZ: number;

  if (test > SINGULARITY_THRESHOLD) {
    const combinedYawPitch = 2 * Math.atan2(x, w) * RADIANS_TO_DEGREES;
    primaryX = referenceX;
    primaryY = combinedYawPitch - referenceX;
    primaryZ = 90;
  } else if (test < -SINGULARITY_THRESHOLD) {
    const yawMinusPitch = -2 * Math.atan2(x, w) * RADIANS_TO_DEGREES;
    primaryX = referenceX;
    primaryY = yawMinusPitch + referenceX;
    primaryZ = -90;
  } else {
    const squaredX = x * x;
    const squaredY = y * y;
    const squaredZ = z * z;
    primaryX = Math.atan2(
      2 * x * w - 2 * y * z,
      1 - 2 * squaredX - 2 * squaredZ
    ) * RADIANS_TO_DEGREES;
    primaryY = Math.atan2(
      2 * y * w - 2 * x * z,
      1 - 2 * squaredY - 2 * squaredZ
    ) * RADIANS_TO_DEGREES;
    primaryZ = Math.asin(Math.max(-1, Math.min(1, 2 * test))) * RADIANS_TO_DEGREES;
  }

  primaryX = normalizeDegrees(primaryX);
  primaryY = normalizeDegrees(primaryY);
  primaryZ = normalizeDegrees(primaryZ);
  const alternateX = normalizeDegrees(primaryX + 180);
  const alternateY = normalizeDegrees(primaryY + 180);
  const alternateZ = normalizeDegrees(180 - primaryZ);
  const primaryScore = continuityScore(
    primaryX,
    primaryY,
    primaryZ,
    referenceX,
    referenceY,
    referenceZ
  );
  const alternateScore = continuityScore(
    alternateX,
    alternateY,
    alternateZ,
    referenceX,
    referenceY,
    referenceZ
  );

  return alternateScore < primaryScore
    ? { x: alternateX, y: alternateY, z: alternateZ }
    : { x: primaryX, y: primaryY, z: primaryZ };
}

function continuityScore(
  x: number,
  y: number,
  z: number,
  referenceX: number,
  referenceY: number,
  referenceZ: number
): number {
  const deltaX = normalizeDegrees(x - referenceX);
  const deltaY = normalizeDegrees(y - referenceY);
  const deltaZ = normalizeDegrees(z - referenceZ);
  return deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
}

function normalizeDegrees(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}
