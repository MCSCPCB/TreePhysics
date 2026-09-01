import type { Vector3 } from "@minecraft/server";
import type {
  PhysicsContraptionBlock,
  PhysicsContraptionBlockFace
} from "@src/physics/core/Types";
import { EPSILON_1E8, isFiniteVector } from "@src/utils/Vector3Math";

const DIRECTION_EPSILON = EPSILON_1E8;
const DISTANCE_EPSILON = 1e-9;
const AXES = ["x", "y", "z"] as const;

export interface ContraptionGridRaycastHit {
  readonly block: PhysicsContraptionBlock;
  readonly distance: number;
  readonly face: PhysicsContraptionBlockFace;
  readonly localLocation: Vector3;
  readonly localNormal: Vector3;
}
export interface ContraptionGridRaycastOptions {
  /** Ignore the starting cell when the ray origin is strictly inside its unit AABB. */
  readonly skipContainingCell?: boolean;
}

/** Traverse integer-centered contraption cells without scanning the complete block array. */
export function raycastContraptionGrid(
  blockAt: (x: number, y: number, z: number) => PhysicsContraptionBlock | undefined,
  origin: Vector3,
  direction: Vector3,
  maximumDistance: number,
  options?: ContraptionGridRaycastOptions
): ContraptionGridRaycastHit | undefined {
  if (!isFiniteVector(origin) || !isFiniteVector(direction)) return undefined;
  // Infinity is rejected along with NaN: the DDA step budget below scales with
  // maximumDistance, so an unbounded ray cannot be traversed and yields undefined.
  if (!Number.isFinite(maximumDistance) || maximumDistance < 0) return undefined;
  const directionLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(directionLength) || directionLength < DIRECTION_EPSILON) return undefined;
  const ray = {
    x: direction.x / directionLength,
    y: direction.y / directionLength,
    z: direction.z / directionLength
  };

  // Contraption block centers are integers, so shifting by one half maps their
  // unit AABBs to the ordinary floor-based voxel grid used by DDA.
  let x = Math.floor(origin.x + 0.5);
  let y = Math.floor(origin.y + 0.5);
  let z = Math.floor(origin.z + 0.5);
  const skipStartingCell = options?.skipContainingCell === true
    && isStrictlyInsideUnitCell(origin, x, y, z);
  const stepX = Math.sign(ray.x);
  const stepY = Math.sign(ray.y);
  const stepZ = Math.sign(ray.z);
  let tMaxX = firstBoundaryDistance(origin.x, ray.x, x, stepX);
  let tMaxY = firstBoundaryDistance(origin.y, ray.y, y, stepY);
  let tMaxZ = firstBoundaryDistance(origin.z, ray.z, z, stepZ);
  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(ray.x);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(ray.y);
  const tDeltaZ = stepZ === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(ray.z);

  // A normalized ray crosses at most roughly sqrt(3) cells per unit. The
  // larger bound also covers simultaneous boundary crossings and start cells.
  const maximumSteps = Math.ceil(maximumDistance * 3) + 8;
  for (let step = 0; step < maximumSteps; step++) {
    // A passable contraption block can contain the player's head. Selection rays
    // may opt out of that zero-distance hit so the crosshair reaches the next cell.
    const block = step === 0 && skipStartingCell ? undefined : blockAt(x, y, z);
    if (block) {
      const hit = rayUnitAabbHit(origin, ray, x, y, z, maximumDistance);
      if (hit) {
        return {
          block,
          distance: hit.distance,
          face: faceFromNormal(hit.normal),
          localLocation: {
            x: origin.x + ray.x * hit.distance,
            y: origin.y + ray.y * hit.distance,
            z: origin.z + ray.z * hit.distance
          },
          localNormal: hit.normal
        };
      }
    }

    const nextDistance = Math.min(tMaxX, tMaxY, tMaxZ);
    if (nextDistance > maximumDistance) break;
    // Step every tied axis. A ray passing exactly through an edge or corner
    // enters the diagonal cell instead of selecting a merely touched cell.
    if (tMaxX <= nextDistance + DISTANCE_EPSILON) {
      x += stepX;
      tMaxX += tDeltaX;
    }
    if (tMaxY <= nextDistance + DISTANCE_EPSILON) {
      y += stepY;
      tMaxY += tDeltaY;
    }
    if (tMaxZ <= nextDistance + DISTANCE_EPSILON) {
      z += stepZ;
      tMaxZ += tDeltaZ;
    }
  }
  return undefined;
}

function isStrictlyInsideUnitCell(origin: Vector3, x: number, y: number, z: number): boolean {
  return origin.x > x - 0.5 && origin.x < x + 0.5
    && origin.y > y - 0.5 && origin.y < y + 0.5
    && origin.z > z - 0.5 && origin.z < z + 0.5;
}

function firstBoundaryDistance(
  origin: number,
  direction: number,
  cell: number,
  step: number
): number {
  if (step === 0) return Number.POSITIVE_INFINITY;
  const boundary = cell + (step > 0 ? 0.5 : -0.5);
  return Math.max(0, (boundary - origin) / direction);
}

// Slab test tracking the entry normal. contraption-spatial-index.ts
// rayIntersectsAabb runs the same axis-by-axis slab sequence as a boolean-only
// prefilter; keep the arithmetic of the two in sync.
function rayUnitAabbHit(
  origin: Vector3,
  direction: Vector3,
  x: number,
  y: number,
  z: number,
  maximumDistance: number
): { readonly distance: number; readonly normal: Vector3 } | undefined {
  let near = 0;
  let far = maximumDistance;
  // Only origin-inside-the-box hits keep this initial normal: every axisNear is
  // then negative, so no axis overwrites it and the zero-distance hit reports
  // the face opposing the dominant travel axis.
  let normal = dominantOppositeNormal(direction);
  const min = { x: x - 0.5, y: y - 0.5, z: z - 0.5 };
  const max = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
  for (const axis of AXES) {
    const component = direction[axis];
    if (Math.abs(component) < DIRECTION_EPSILON) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return undefined;
      continue;
    }
    let axisNear = (min[axis] - origin[axis]) / component;
    let axisFar = (max[axis] - origin[axis]) / component;
    const axisNormal = component > 0 ? -1 : 1;
    if (axisNear > axisFar) [axisNear, axisFar] = [axisFar, axisNear];
    if (axisNear > near) {
      near = axisNear;
      normal = {
        x: axis === "x" ? axisNormal : 0,
        y: axis === "y" ? axisNormal : 0,
        z: axis === "z" ? axisNormal : 0
      };
    }
    far = Math.min(far, axisFar);
    if (near > far) return undefined;
  }
  return far < 0 || near > maximumDistance
    ? undefined
    : { distance: Math.max(0, near), normal };
}

function dominantOppositeNormal(direction: Vector3): Vector3 {
  const x = Math.abs(direction.x);
  const y = Math.abs(direction.y);
  const z = Math.abs(direction.z);
  if (x >= y && x >= z) return { x: direction.x > 0 ? -1 : 1, y: 0, z: 0 };
  if (y >= z) return { x: 0, y: direction.y > 0 ? -1 : 1, z: 0 };
  return { x: 0, y: 0, z: direction.z > 0 ? -1 : 1 };
}

function faceFromNormal(normal: Vector3): PhysicsContraptionBlockFace {
  if (normal.x < 0) return "west";
  if (normal.x > 0) return "east";
  if (normal.y < 0) return "down";
  if (normal.y > 0) return "up";
  if (normal.z < 0) return "north";
  return "south";
}
