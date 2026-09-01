import type { AABB, Vector3 } from "@minecraft/server";
import type { PhysicsBody } from "@src/Physics";
import type { ObbTransform } from "@src/physics/obb";
import { rotateVectorByEulerDegreesYzx } from "@src/physics/motion/RotationContinuity";
import type { PhysicsBodyCollider } from "@src/physics/core/Types";
import { EPSILON_1E6, add, clamp, dot, scale, subtract } from "@src/utils/Vector3Math";

export interface ContraptionCollisionBoxDescriptor {
  /** Bottom-center location in rigid-body local coordinates. */
  readonly localLocation: Vector3;
  readonly localRotation: Vector3;
  readonly size: Vector3;
}

export interface BodyFrame {
  readonly origin: Vector3;
  readonly x: Vector3;
  readonly y: Vector3;
  readonly z: Vector3;
}

const ANGLE_EPSILON = EPSILON_1E6;
const RADIANS_TO_DEGREES = 180 / Math.PI;

export function getContraptionCollisionBoxDescriptors(
  collider: PhysicsBodyCollider
): ContraptionCollisionBoxDescriptor[] {
  if (collider.type === "sensor") return [];
  if (collider.type === "box") {
    return [{
      localLocation: { x: 0, y: 0, z: 0 },
      localRotation: { x: 0, y: 0, z: 0 },
      size: getBoxSize(collider)
    }];
  }
  if (collider.type !== "compound") {
    throw new TypeError(
      `Contraption collision requires a box-based collider, received ${collider.type}.`
    );
  }

  const boxes: ContraptionCollisionBoxDescriptor[] = [];
  for (let index = 0; index < collider.children.length; index++) {
    const child = collider.children[index]!;
    if (child.collisionResponse === false) continue;
    if (child.collider.type !== "box") {
      throw new TypeError(
        `Contraption collision child ${index} must be a box, received ${child.collider.type}.`
      );
    }
    boxes.push({
      localLocation: cloneFiniteVector(
        child.location ?? { x: 0, y: 0, z: 0 },
        `collider child ${index} location`
      ),
      localRotation: cloneFiniteVector(
        child.rotation ?? { x: 0, y: 0, z: 0 },
        `collider child ${index} rotation`
      ),
      size: getBoxSize(child.collider)
    });
  }
  return boxes;
}

export function createBodyFrame(body: Pick<PhysicsBody, "localPointToWorld">): BodyFrame {
  const origin = body.localPointToWorld({ x: 0, y: 0, z: 0 });
  return {
    origin,
    x: normalize(subtract(body.localPointToWorld({ x: 1, y: 0, z: 0 }), origin)),
    y: normalize(subtract(body.localPointToWorld({ x: 0, y: 1, z: 0 }), origin)),
    z: normalize(subtract(body.localPointToWorld({ x: 0, y: 0, z: 1 }), origin))
  };
}

export function getContraptionCollisionBoxTransformFromFrame(
  frame: BodyFrame,
  box: ContraptionCollisionBoxDescriptor,
  previous?: ObbTransform
): ObbTransform {
  const localCenter = add(
    box.localLocation,
    rotateVectorByEulerDegreesYzx(
      { x: 0, y: box.size.y / 2, z: 0 },
      box.localRotation
    )
  );
  const localForward = rotateVectorByEulerDegreesYzx(
    { x: 0, y: 0, z: 1 },
    box.localRotation
  );
  const localNormal = rotateVectorByEulerDegreesYzx(
    { x: 0, y: 1, z: 0 },
    box.localRotation
  );
  const worldForward = transformDirection(frame, localForward);
  const worldNormal = transformDirection(frame, localNormal);
  const angles = getObbAnglesFromAxes(worldForward, worldNormal, previous);
  return {
    center: transformPoint(frame, localCenter),
    pitch: angles.pitch,
    roll: angles.roll,
    yaw: angles.yaw
  };
}

export function worldToLocal(frame: BodyFrame, point: Vector3): Vector3 {
  const delta = subtract(point, frame.origin);
  return {
    x: dot(delta, frame.x),
    y: dot(delta, frame.y),
    z: dot(delta, frame.z)
  };
}

export function getSweptAabbObbHitTime(
  start: Vector3,
  end: Vector3,
  actorExtent: Vector3,
  box: { readonly transform: ObbTransform; readonly descriptor: ContraptionCollisionBoxDescriptor }
): number | undefined {
  const axes = getObbAxes(box.transform);
  const relativeStart = subtract(start, box.transform.center);
  const relativeEnd = subtract(end, box.transform.center);
  const localStart = {
    x: dot(relativeStart, axes.sideways),
    y: dot(relativeStart, axes.normal),
    z: dot(relativeStart, axes.forward)
  };
  const localEnd = {
    x: dot(relativeEnd, axes.sideways),
    y: dot(relativeEnd, axes.normal),
    z: dot(relativeEnd, axes.forward)
  };
  const expandedExtent = {
    x: box.descriptor.size.x / 2 + projectAabbRadius(actorExtent, axes.sideways),
    y: box.descriptor.size.y / 2 + projectAabbRadius(actorExtent, axes.normal),
    z: box.descriptor.size.z / 2 + projectAabbRadius(actorExtent, axes.forward)
  };
  let entry = 0;
  let exit = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const delta = localEnd[axis] - localStart[axis];
    if (Math.abs(delta) <= ANGLE_EPSILON) {
      if (Math.abs(localStart[axis]) > expandedExtent[axis]) return undefined;
      continue;
    }
    const first = (-expandedExtent[axis] - localStart[axis]) / delta;
    const second = (expandedExtent[axis] - localStart[axis]) / delta;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return undefined;
  }
  return entry >= 0 && entry <= 1 ? entry : undefined;
}

export function lerp(start: Vector3, end: Vector3, time: number): Vector3 {
  return {
    x: start.x + (end.x - start.x) * time,
    y: start.y + (end.y - start.y) * time,
    z: start.z + (end.z - start.z) * time
  };
}

export function collisionBoxKey(box: ContraptionCollisionBoxDescriptor): string {
  return [
    box.localLocation.x, box.localLocation.y, box.localLocation.z,
    box.localRotation.x, box.localRotation.y, box.localRotation.z,
    box.size.x, box.size.y, box.size.z
  ].join(",");
}

function getBoxSize(collider: Readonly<{ halfExtents?: Vector3; size?: Vector3 }>): Vector3 {
  const size = collider.halfExtents
    ? scale(collider.halfExtents, 2)
    : collider.size ?? { x: 1, y: 1, z: 1 };
  if (!isFiniteVector(size) || size.x <= 0 || size.y <= 0 || size.z <= 0) {
    throw new RangeError("Contraption collision box size must contain positive finite components.");
  }
  return { ...size };
}

function cloneFiniteVector(value: Vector3, name: string): Vector3 {
  if (!isFiniteVector(value)) throw new TypeError(`${name} must be a finite vector.`);
  return { ...value };
}

export function assertAabb(aabb: AABB): void {
  if (!isFiniteVector(aabb.center)
    || !isFiniteVector(aabb.extent)
    || aabb.extent.x <= 0
    || aabb.extent.y <= 0
    || aabb.extent.z <= 0) {
    throw new TypeError("Collision entity AABB must be finite with positive extents.");
  }
}

function normalize(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= ANGLE_EPSILON) {
    throw new RangeError("Contraption collision orientation axes must be finite and non-zero.");
  }
  return scale(value, 1 / length);
}

function transformPoint(frame: BodyFrame, point: Vector3): Vector3 {
  return {
    x: frame.origin.x + frame.x.x * point.x + frame.y.x * point.y + frame.z.x * point.z,
    y: frame.origin.y + frame.x.y * point.x + frame.y.y * point.y + frame.z.y * point.z,
    z: frame.origin.z + frame.x.z * point.x + frame.y.z * point.y + frame.z.z * point.z
  };
}

function transformDirection(frame: BodyFrame, direction: Vector3): Vector3 {
  return normalize({
    x: frame.x.x * direction.x + frame.y.x * direction.y + frame.z.x * direction.z,
    y: frame.x.y * direction.x + frame.y.y * direction.y + frame.z.y * direction.z,
    z: frame.x.z * direction.x + frame.y.z * direction.y + frame.z.z * direction.z
  });
}

function getObbAxes(transform: ObbTransform): Readonly<{ forward: Vector3; normal: Vector3; sideways: Vector3 }> {
  const yaw = transform.yaw / RADIANS_TO_DEGREES;
  const pitch = transform.pitch / RADIANS_TO_DEGREES;
  const roll = transform.roll / RADIANS_TO_DEGREES;
  const horizontalForward = { x: -Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  const horizontalSideways = { x: -horizontalForward.z, y: 0, z: horizontalForward.x };
  const pitchedForward = scale(horizontalForward, Math.cos(pitch));
  pitchedForward.y = Math.sin(pitch);
  const pitchedNormal = {
    x: -horizontalForward.x * Math.sin(pitch), y: Math.cos(pitch), z: -horizontalForward.z * Math.sin(pitch)
  };
  return {
    forward: pitchedForward,
    normal: add(scale(pitchedNormal, Math.cos(roll)), scale(horizontalSideways, -Math.sin(roll))),
    sideways: add(scale(horizontalSideways, Math.cos(roll)), scale(pitchedNormal, Math.sin(roll)))
  };
}

function projectAabbRadius(extent: Vector3, axis: Vector3): number {
  return Math.abs(axis.x) * extent.x + Math.abs(axis.y) * extent.y + Math.abs(axis.z) * extent.z;
}

function getObbAnglesFromAxes(
  forward: Vector3,
  normal: Vector3,
  previous?: Pick<ObbTransform, "pitch" | "roll" | "yaw">
): Pick<ObbTransform, "pitch" | "roll" | "yaw"> {
  const unitForward = normalize(forward);
  const unitNormal = normalize(normal);
  const pitch = Math.asin(clamp(unitForward.y, -1, 1)) * RADIANS_TO_DEGREES;
  const cosPitch = Math.cos(pitch / RADIANS_TO_DEGREES);
  const rawYaw = Math.abs(cosPitch) <= ANGLE_EPSILON
    ? previous?.yaw ?? 0
    : Math.atan2(-unitForward.x, unitForward.z) * RADIANS_TO_DEGREES;
  const yaw = unwrapDegrees(rawYaw, previous?.yaw);
  const yawRadians = yaw / RADIANS_TO_DEGREES;
  const horizontalForward = { x: -Math.sin(yawRadians), y: 0, z: Math.cos(yawRadians) };
  const horizontalSideways = { x: -horizontalForward.z, y: 0, z: horizontalForward.x };
  const pitchRadians = pitch / RADIANS_TO_DEGREES;
  const pitchedNormal = {
    x: -horizontalForward.x * Math.sin(pitchRadians), y: Math.cos(pitchRadians), z: -horizontalForward.z * Math.sin(pitchRadians)
  };
  const rawRoll = Math.atan2(-dot(unitNormal, horizontalSideways), dot(unitNormal, pitchedNormal)) * RADIANS_TO_DEGREES;
  return { pitch, roll: unwrapDegrees(rawRoll, previous?.roll), yaw };
}

function unwrapDegrees(value: number, reference: number | undefined): number {
  if (reference === undefined) return normalizeDegrees(value);
  return reference + normalizeDegrees(value - reference);
}

function normalizeDegrees(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function isFiniteVector(value: Vector3): boolean {
  return Boolean(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
