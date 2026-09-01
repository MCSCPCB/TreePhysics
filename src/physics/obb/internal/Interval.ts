// Exact convex interval math: world-Y spans cut from the oriented OBB solid
// by upright proxy prisms, with per-pose result caching (including misses).
import type { Vector3 } from "@minecraft/server";
import {
  GEOMETRY_EPSILON,
  type OrientedSolid,
  type SurfacePose
} from "./PoseFrame";

/** Exact world-Y span cut from the convex OBB at one world-XZ cell. */
export interface VolumeColumnInterval {
  readonly bottomY: number;
  readonly topY: number;
}

/** Distinguishes a cached empty intersection from an uncomputed column. */
export interface VolumeColumnIntervalCacheEntry {
  readonly interval: VolumeColumnInterval | undefined;
}

const OBB_EDGE_VERTEX_INDICES = Object.freeze([
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7]
] as const);

/** Reuses exact interval results, including misses, only within one solid pose. */
export function getPoseObbVerticalInterval(
  pose: SurfacePose,
  x: number,
  z: number,
  horizontalHalfSize: number
): VolumeColumnInterval | undefined {
  let intervalsByX = pose.intervalCache.get(horizontalHalfSize);
  if (!intervalsByX) {
    intervalsByX = new Map();
    pose.intervalCache.set(horizontalHalfSize, intervalsByX);
  }
  let intervalsByZ = intervalsByX.get(x);
  if (!intervalsByZ) {
    intervalsByZ = new Map();
    intervalsByX.set(x, intervalsByZ);
  }
  const cached = intervalsByZ.get(z);
  if (cached) return cached.interval;
  const interval = getObbVerticalInterval(
    pose.solid,
    x,
    z,
    horizontalHalfSize
  );
  intervalsByZ.set(z, { interval });
  return interval;
}

/**
 * Returns the exact Y projection of the convex intersection between one OBB
 * and one fixed upright proxy prism. Every possible intersection-polyhedron
 * vertex is either an OBB vertex, an OBB-edge/prism-plane intersection, or an
 * OBB-face/prism-edge intersection; testing those finite candidates avoids the
 * extra corner expansion produced by intersecting independently widened slabs.
 */
function getObbVerticalInterval(
  solid: OrientedSolid,
  x: number,
  z: number,
  horizontalHalfSize: number
): VolumeColumnInterval | undefined {
  const minimumX = x - horizontalHalfSize;
  const maximumX = x + horizontalHalfSize;
  const minimumZ = z - horizontalHalfSize;
  const maximumZ = z + horizontalHalfSize;
  let bottomY = Number.POSITIVE_INFINITY;
  let topY = Number.NEGATIVE_INFINITY;

  const includeY = (pointY: number): void => {
    bottomY = Math.min(bottomY, pointY);
    topY = Math.max(topY, pointY);
  };

  for (const vertex of solid.vertices) {
    if (vertex.x < minimumX - GEOMETRY_EPSILON
      || vertex.x > maximumX + GEOMETRY_EPSILON
      || vertex.z < minimumZ - GEOMETRY_EPSILON
      || vertex.z > maximumZ + GEOMETRY_EPSILON) continue;
    includeY(vertex.y);
  }
  for (const [firstIndex, secondIndex] of OBB_EDGE_VERTEX_INDICES) {
    includeSegmentPrismYExtrema(
      solid.vertices[firstIndex]!,
      solid.vertices[secondIndex]!,
      minimumX,
      maximumX,
      minimumZ,
      maximumZ,
      includeY
    );
  }
  const includeCorner = (cornerX: number, cornerZ: number): void => {
    const cornerInterval = getVerticalLineObbInterval(solid, cornerX, cornerZ);
    if (cornerInterval) {
      includeY(cornerInterval.bottomY);
      includeY(cornerInterval.topY);
    }
  };
  includeCorner(minimumX, minimumZ);
  includeCorner(minimumX, maximumZ);
  includeCorner(maximumX, minimumZ);
  includeCorner(maximumX, maximumZ);

  if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) return undefined;
  return { bottomY, topY };
}

/** Adds the Y extrema of one OBB edge clipped to the proxy's XZ footprint. */
function includeSegmentPrismYExtrema(
  first: Vector3,
  second: Vector3,
  minimumX: number,
  maximumX: number,
  minimumZ: number,
  maximumZ: number,
  includeY: (pointY: number) => void
): void {
  const clippedX = clipSegmentAmountToSlab(first.x, second.x - first.x, minimumX, maximumX, 0, 1);
  if (!clippedX) return;
  const clippedZ = clipSegmentAmountToSlab(
    first.z,
    second.z - first.z,
    minimumZ,
    maximumZ,
    clippedX[0],
    clippedX[1]
  );
  if (!clippedZ) return;

  const deltaY = second.y - first.y;
  includeY(first.y + deltaY * Math.max(0, clippedZ[0]));
  includeY(first.y + deltaY * Math.min(1, clippedZ[1]));
}

/**
 * Narrows a segment's parameter range to one axis slab.
 * A degenerate axis (|delta| within epsilon) never narrows the range; it only
 * rejects segments lying entirely outside the slab. Returns undefined when
 * the clipped range is empty.
 */
function clipSegmentAmountToSlab(
  firstCoordinate: number,
  delta: number,
  minimumBound: number,
  maximumBound: number,
  minimumAmount: number,
  maximumAmount: number
): readonly [number, number] | undefined {
  if (Math.abs(delta) <= GEOMETRY_EPSILON) {
    if (firstCoordinate < minimumBound - GEOMETRY_EPSILON
      || firstCoordinate > maximumBound + GEOMETRY_EPSILON) return undefined;
    return [minimumAmount, maximumAmount];
  }
  const firstAmount = (minimumBound - firstCoordinate) / delta;
  const secondAmount = (maximumBound - firstCoordinate) / delta;
  const clippedMinimum = Math.max(
    minimumAmount,
    Math.min(firstAmount, secondAmount)
  );
  const clippedMaximum = Math.min(
    maximumAmount,
    Math.max(firstAmount, secondAmount)
  );
  if (clippedMinimum > clippedMaximum + GEOMETRY_EPSILON) return undefined;
  return [clippedMinimum, clippedMaximum];
}

/** Intersects one vertical prism edge with the three exact OBB slabs. */
function getVerticalLineObbInterval(
  solid: OrientedSolid,
  x: number,
  z: number
): VolumeColumnInterval | undefined {
  let bottomY = Number.NEGATIVE_INFINITY;
  let topY = Number.POSITIVE_INFINITY;
  const relativeX = x - solid.center.x;
  const relativeZ = z - solid.center.z;
  for (const { axis, extent } of solid.axes) {
    const horizontalProjection = axis.x * relativeX + axis.z * relativeZ;
    if (Math.abs(axis.y) <= GEOMETRY_EPSILON) {
      if (Math.abs(horizontalProjection) > extent + GEOMETRY_EPSILON) {
        return undefined;
      }
      continue;
    }
    const first = (-extent - horizontalProjection) / axis.y + solid.center.y;
    const second = (extent - horizontalProjection) / axis.y + solid.center.y;
    bottomY = Math.max(bottomY, Math.min(first, second));
    topY = Math.min(topY, Math.max(first, second));
    if (bottomY > topY + GEOMETRY_EPSILON) return undefined;
  }
  if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) {
    throw new RangeError("The OBB vertical interval must be finite.");
  }
  return { bottomY, topY };
}
