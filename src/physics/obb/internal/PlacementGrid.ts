// Fixed-world grid support for placement rasterization: face bounds,
// origin-anchored quantization, and region/cell coverage tests.
import type { Vector3 } from "@minecraft/server";
import type { CollisionRegion } from "./Activation";
import type { ObbSize, ObbTransform } from "../Types";
import { dot, subtract } from "@src/utils/Vector3Math";
import {
  GEOMETRY_EPSILON,
  type FiniteTopSurface,
  type OrientedSurfaceFrame
} from "./PoseFrame";

/** Assigns each fixed-world proxy column to one half-open collision region. */
export function isWithinHorizontalRegion(
  x: number,
  z: number,
  region: CollisionRegion
): boolean {
  // Half-open ownership gives every fixed-world proxy column exactly one
  // region, including when a grid center lies precisely on a region boundary.
  return x >= region.location.x - region.extent.x - GEOMETRY_EPSILON
    && x < region.location.x + region.extent.x - GEOMETRY_EPSILON
    && z >= region.location.z - region.extent.z - GEOMETRY_EPSILON
    && z < region.location.z + region.extent.z - GEOMETRY_EPSILON;
}

export function getTopFaceBounds(
  surface: FiniteTopSurface,
  size: ObbSize
): { minimumX: number; maximumX: number; minimumZ: number; maximumZ: number } {
  const { frame, topCenter } = surface;
  const forwardExtent = size.depth / 2;
  const sidewaysExtent = size.width / 2;
  return {
    minimumX: topCenter.x - Math.abs(frame.forward.x) * forwardExtent
      - Math.abs(frame.sideways.x) * sidewaysExtent,
    maximumX: topCenter.x + Math.abs(frame.forward.x) * forwardExtent
      + Math.abs(frame.sideways.x) * sidewaysExtent,
    minimumZ: topCenter.z - Math.abs(frame.forward.z) * forwardExtent
      - Math.abs(frame.sideways.z) * sidewaysExtent,
    maximumZ: topCenter.z + Math.abs(frame.forward.z) * forwardExtent
      + Math.abs(frame.sideways.z) * sidewaysExtent
  };
}

export function getTopFaceBounds3d(
  surface: FiniteTopSurface,
  size: ObbSize
): {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
  minimumZ: number;
  maximumZ: number;
} {
  const { frame, topCenter } = surface;
  const forwardExtent = size.depth / 2;
  const sidewaysExtent = size.width / 2;
  const xExtent = Math.abs(frame.forward.x) * forwardExtent
    + Math.abs(frame.sideways.x) * sidewaysExtent;
  const yExtent = Math.abs(frame.forward.y) * forwardExtent
    + Math.abs(frame.sideways.y) * sidewaysExtent;
  const zExtent = Math.abs(frame.forward.z) * forwardExtent
    + Math.abs(frame.sideways.z) * sidewaysExtent;
  return {
    minimumX: topCenter.x - xExtent,
    maximumX: topCenter.x + xExtent,
    minimumY: topCenter.y - yExtent,
    maximumY: topCenter.y + yExtent,
    minimumZ: topCenter.z - zExtent,
    maximumZ: topCenter.z + zExtent
  };
}

export function getObbHorizontalBounds(
  transform: ObbTransform,
  size: ObbSize,
  frame: OrientedSurfaceFrame
): Readonly<{
  maximumX: number;
  maximumZ: number;
  minimumX: number;
  minimumZ: number;
}> {
  const xExtent = Math.abs(frame.forward.x) * size.depth / 2
    + Math.abs(frame.sideways.x) * size.width / 2
    + Math.abs(frame.normal.x) * size.height / 2;
  const zExtent = Math.abs(frame.forward.z) * size.depth / 2
    + Math.abs(frame.sideways.z) * size.width / 2
    + Math.abs(frame.normal.z) * size.height / 2;
  return {
    maximumX: transform.center.x + xExtent,
    maximumZ: transform.center.z + zExtent,
    minimumX: transform.center.x - xExtent,
    minimumZ: transform.center.z - zExtent
  };
}

export function quantizeDownFromOrigin(
  value: number,
  origin: number,
  step: number
): number {
  return origin + Math.floor(
    (value - origin + GEOMETRY_EPSILON) / step
  ) * step;
}

export function quantizeNearestFromOrigin(
  value: number,
  origin: number,
  step: number
): number {
  return origin + Math.round((value - origin) / step) * step;
}

export function quantizeUpFromOrigin(
  value: number,
  origin: number,
  step: number
): number {
  return origin + Math.ceil(
    (value - origin - GEOMETRY_EPSILON) / step
  ) * step;
}

/** Conservative finite-face test for one upright proxy lattice cell. */
export function cellIntersectsFiniteFace(
  center: Vector3,
  surface: FiniteTopSurface,
  size: ObbSize,
  horizontalHalfSize: number,
  verticalHalfSize: number
): boolean {
  const relative = subtract(center, surface.topCenter);
  const forwardRadius = horizontalHalfSize * (
    Math.abs(surface.frame.forward.x) + Math.abs(surface.frame.forward.z)
  ) + verticalHalfSize * Math.abs(surface.frame.forward.y);
  const sidewaysRadius = horizontalHalfSize * (
    Math.abs(surface.frame.sideways.x) + Math.abs(surface.frame.sideways.z)
  ) + verticalHalfSize * Math.abs(surface.frame.sideways.y);
  return Math.abs(dot(relative, surface.frame.forward))
      <= size.depth / 2 + forwardRadius + GEOMETRY_EPSILON
    && Math.abs(dot(relative, surface.frame.sideways))
      <= size.width / 2 + sidewaysRadius + GEOMETRY_EPSILON;
}

export function getFiniteTopSurfaceY(
  surface: FiniteTopSurface,
  size: ObbSize,
  x: number,
  z: number
): number | undefined {
  const relativeX = x - surface.topCenter.x;
  const relativeZ = z - surface.topCenter.z;
  const localForward = (
    relativeX * surface.frame.sideways.z
    - relativeZ * surface.frame.sideways.x
  ) / surface.determinant;
  const localSideways = (
    surface.frame.forward.x * relativeZ
    - surface.frame.forward.z * relativeX
  ) / surface.determinant;
  if (Math.abs(localForward) > size.depth / 2
    || Math.abs(localSideways) > size.width / 2) return undefined;
  return surface.topCenter.y
    + surface.frame.forward.y * localForward
    + surface.frame.sideways.y * localSideways;
}
