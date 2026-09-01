// Pose and coordinate-frame math for the OBB geometry cluster: orientation
// frames, oriented surface/solid construction, and immutable pose snapshots.
import type { Vector3 } from "@minecraft/server";
import type { ObbSize, ObbTransform } from "../Types";
import { EPSILON_1E6 } from "@src/utils/Vector3Math";
import type { VolumeColumnIntervalCacheEntry } from "./Interval";

interface SurfaceFrame {
  readonly forward: Readonly<{ x: number; z: number }>;
  readonly sideways: Readonly<{ x: number; z: number }>;
}

export interface OrientedSurfaceFrame {
  readonly forward: Vector3;
  readonly normal: Vector3;
  readonly sideways: Vector3;
}

/** Precomputed designated face shared by every proxy sampled in one pose. */
export interface FiniteTopSurface {
  readonly determinant: number;
  readonly frame: OrientedSurfaceFrame;
  readonly topCenter: Vector3;
}

export interface OrientedSolidAxis {
  readonly axis: Vector3;
  readonly extent: number;
}

/** Pose-local convex data reused by every fixed-world volume column. */
export interface OrientedSolid {
  readonly axes: readonly OrientedSolidAxis[];
  readonly center: Vector3;
  readonly vertices: readonly Vector3[];
}

/** Cached orientation and designated face for one immutable pose snapshot. */
export interface SurfacePose {
  readonly finiteTop: FiniteTopSurface | undefined;
  readonly intervalCache: Map<
    number,
    Map<number, Map<number, VolumeColumnIntervalCacheEntry>>
  >;
  readonly solid: OrientedSolid;
  readonly surface: FiniteTopSurface;
  readonly transform: ObbTransform;
  readonly verticalAxis: VerticalProjectionAxis | undefined;
}

export type VerticalProjectionAxis = "x" | "z";

/** Shared comparison epsilon for the whole OBB geometry cluster. */
export const GEOMETRY_EPSILON = EPSILON_1E6;
/** Face signs iterated per axis; hoisted so hot loops allocate nothing. */
export const SIGNS = Object.freeze([-1, 1] as const);

/** Returns horizontal local axes for a Minecraft yaw angle. */
function getSurfaceFrame(yaw: number): SurfaceFrame {
  const radians = yaw * Math.PI / 180;
  const forward = { x: -Math.sin(radians), z: Math.cos(radians) };
  return {
    forward,
    sideways: { x: -forward.z, z: forward.x }
  };
}

function getOrientedSurfaceFrame(
  transform: ObbTransform
): OrientedSurfaceFrame {
  const horizontal = getSurfaceFrame(transform.yaw);
  const pitchRadians = toRadians(transform.pitch);
  const sinPitch = Math.sin(pitchRadians);
  const cosPitch = Math.cos(pitchRadians);
  const rollRadians = toRadians(transform.roll);
  const sinRoll = Math.sin(rollRadians);
  const cosRoll = Math.cos(rollRadians);
  const pitchedForward = {
    x: horizontal.forward.x * cosPitch,
    y: sinPitch,
    z: horizontal.forward.z * cosPitch
  };
  const pitchedNormal = {
    x: -horizontal.forward.x * sinPitch,
    y: cosPitch,
    z: -horizontal.forward.z * sinPitch
  };
  return {
    forward: pitchedForward,
    normal: {
      x: pitchedNormal.x * cosRoll - horizontal.sideways.x * sinRoll,
      y: pitchedNormal.y * cosRoll,
      z: pitchedNormal.z * cosRoll - horizontal.sideways.z * sinRoll
    },
    sideways: {
      x: horizontal.sideways.x * cosRoll + pitchedNormal.x * sinRoll,
      y: pitchedNormal.y * sinRoll,
      z: horizontal.sideways.z * cosRoll + pitchedNormal.z * sinRoll
    }
  };
}

function getTopCenter(
  transform: ObbTransform,
  size: ObbSize,
  normal: Vector3
): Vector3 {
  const halfHeight = size.height / 2;
  return {
    x: transform.center.x + normal.x * halfHeight,
    y: transform.center.y + normal.y * halfHeight,
    z: transform.center.z + normal.z * halfHeight
  };
}

/** Converts an OBB-local XYZ point through the public yaw-pitch-roll frame. */
export function getWorldPoint(transform: ObbTransform, localPoint: Vector3): Vector3 {
  const frame = getOrientedSurfaceFrame(transform);
  return {
    x: transform.center.x
      + frame.sideways.x * localPoint.x
      + frame.normal.x * localPoint.y
      + frame.forward.x * localPoint.z,
    y: transform.center.y
      + frame.sideways.y * localPoint.x
      + frame.normal.y * localPoint.y
      + frame.forward.y * localPoint.z,
    z: transform.center.z
      + frame.sideways.z * localPoint.x
      + frame.normal.z * localPoint.y
      + frame.forward.z * localPoint.z
  };
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

/** Chooses a non-singular vertical projection once the face exceeds 45°. */
export function getVerticalProjectionAxis(
  normal: Vector3
): VerticalProjectionAxis | undefined {
  if (normal.y < -GEOMETRY_EPSILON) return undefined;
  const absoluteX = Math.abs(normal.x);
  const absoluteZ = Math.abs(normal.z);
  if (normal.y >= Math.max(absoluteX, absoluteZ) - GEOMETRY_EPSILON) {
    return undefined;
  }
  return absoluteX >= absoluteZ ? "x" : "z";
}

export function createOrientedSurface(
  transform: ObbTransform,
  size: ObbSize,
  frame = getOrientedSurfaceFrame(transform)
): FiniteTopSurface {
  return {
    determinant: frame.forward.x * frame.sideways.z
      - frame.forward.z * frame.sideways.x,
    frame,
    topCenter: getTopCenter(transform, size, frame.normal)
  };
}

/** Precomputes the OBB axes and eight vertices once per immutable pose. */
export function createOrientedSolid(
  transform: ObbTransform,
  size: ObbSize,
  frame: OrientedSurfaceFrame
): OrientedSolid {
  const axes = Object.freeze([
    { axis: frame.forward, extent: size.depth / 2 },
    { axis: frame.sideways, extent: size.width / 2 },
    { axis: frame.normal, extent: size.height / 2 }
  ]);
  const vertices: Vector3[] = [];
  for (const forwardSign of SIGNS) {
    for (const sidewaysSign of SIGNS) {
      for (const normalSign of SIGNS) {
        vertices.push({
          x: transform.center.x
            + frame.forward.x * axes[0]!.extent * forwardSign
            + frame.sideways.x * axes[1]!.extent * sidewaysSign
            + frame.normal.x * axes[2]!.extent * normalSign,
          y: transform.center.y
            + frame.forward.y * axes[0]!.extent * forwardSign
            + frame.sideways.y * axes[1]!.extent * sidewaysSign
            + frame.normal.y * axes[2]!.extent * normalSign,
          z: transform.center.z
            + frame.forward.z * axes[0]!.extent * forwardSign
            + frame.sideways.z * axes[1]!.extent * sidewaysSign
            + frame.normal.z * axes[2]!.extent * normalSign
        });
      }
    }
  }
  return {
    axes,
    center: { ...transform.center },
    vertices: Object.freeze(vertices)
  };
}

export function transformsEqual(left: ObbTransform, right: ObbTransform): boolean {
  return left.center.x === right.center.x
    && left.center.y === right.center.y
    && left.center.z === right.center.z
    && left.pitch === right.pitch
    && left.roll === right.roll
    && left.yaw === right.yaw;
}

export function orientationsEqual(left: ObbTransform, right: ObbTransform): boolean {
  return left.pitch === right.pitch
    && left.roll === right.roll
    && left.yaw === right.yaw;
}
