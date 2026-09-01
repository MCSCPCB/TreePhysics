import type { Vector3 } from "@minecraft/server";
import type { PhysicsBodyAabb } from "@src/physics/core/Types";
import { EPSILON_1E8, isFiniteVector } from "@src/utils/Vector3Math";

const SPATIAL_CELL_SIZE = 16;
const AXES = ["x", "y", "z"] as const;

interface IndexedContraption {
  readonly id: number;
  readonly isValid: boolean;
  readonly body: {
    getAabb(): PhysicsBodyAabb;
  };
}
interface SpatialCellBounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
}

interface SpatialMembership<T extends IndexedContraption> {
  readonly contraption: T;
  bounds: SpatialCellBounds;
}

/** Coarse world-space index used to reduce precise contraption raycasts to nearby bodies. */
export class ContraptionSpatialIndex<T extends IndexedContraption> {
  readonly #cells = new Map<string, Set<T>>();
  readonly #memberships = new Map<number, SpatialMembership<T>>();

  update(contraption: T): void {
    const bounds = toSpatialCellBounds(contraption.body.getAabb());
    const previous = this.#memberships.get(contraption.id);
    if (previous && cellBoundsEqual(previous.bounds, bounds)) return;
    if (previous) this.#removeFromCells(previous.contraption, previous.bounds);
    this.#addToCells(contraption, bounds);
    this.#memberships.set(contraption.id, { contraption, bounds });
  }

  remove(contraptionId: number): void {
    const membership = this.#memberships.get(contraptionId);
    if (!membership) return;
    this.#memberships.delete(contraptionId);
    this.#removeFromCells(membership.contraption, membership.bounds);
  }

  queryRay(origin: Vector3, direction: Vector3, maximumDistance: number): readonly T[] {
    if (!isFiniteVector(origin) || !isFiniteVector(direction)
      || !Number.isFinite(maximumDistance) || maximumDistance < 0) return [];
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!Number.isFinite(length) || length < EPSILON_1E8) return [];
    const ray = {
      x: direction.x / length,
      y: direction.y / length,
      z: direction.z / length
    };
    const end = {
      x: origin.x + ray.x * maximumDistance,
      y: origin.y + ray.y * maximumDistance,
      z: origin.z + ray.z * maximumDistance
    };
    const queryBounds = toSpatialCellBounds({
      max: {
        x: Math.max(origin.x, end.x),
        y: Math.max(origin.y, end.y),
        z: Math.max(origin.z, end.z)
      },
      min: {
        x: Math.min(origin.x, end.x),
        y: Math.min(origin.y, end.y),
        z: Math.min(origin.z, end.z)
      }
    });
    const candidates = new Set<T>();
    forEachCell(queryBounds, key => {
      const cell = this.#cells.get(key);
      if (!cell) return;
      for (const contraption of cell) candidates.add(contraption);
    });
    return [...candidates]
      .filter(contraption => {
        if (!contraption.isValid) return false;
        const bounds = contraption.body.getAabb();
        return rayIntersectsAabb(
          origin,
          ray,
          bounds.min,
          bounds.max,
          maximumDistance
        );
      })
      // Ascending id gives callers a deterministic candidate order that is
      // independent of Set/cell insertion order; downstream closest-hit loops
      // keep the first-seen contraption on distance ties, so this fixes which
      // contraption wins such a tie.
      .sort((left, right) => left.id - right.id);
  }

  queryAabb(bounds: PhysicsBodyAabb): readonly T[] {
    if (!isFiniteVector(bounds.min) || !isFiniteVector(bounds.max)) return [];
    const queryBounds = toSpatialCellBounds(bounds);
    const candidates = new Set<T>();
    forEachCell(queryBounds, key => {
      const cell = this.#cells.get(key);
      if (!cell) return;
      for (const contraption of cell) candidates.add(contraption);
    });
    return [...candidates]
      .filter(contraption => (
        contraption.isValid && aabbsOverlap(contraption.body.getAabb(), bounds)
      ))
      .sort((left, right) => left.id - right.id);
  }

  #addToCells(contraption: T, bounds: SpatialCellBounds): void {
    forEachCell(bounds, key => {
      const cell = this.#cells.get(key);
      if (cell) cell.add(contraption);
      else this.#cells.set(key, new Set([contraption]));
    });
  }

  #removeFromCells(contraption: T, bounds: SpatialCellBounds): void {
    forEachCell(bounds, key => {
      const cell = this.#cells.get(key);
      if (!cell) return;
      cell.delete(contraption);
      if (cell.size === 0) this.#cells.delete(key);
    });
  }
}

function aabbsOverlap(left: PhysicsBodyAabb, right: PhysicsBodyAabb): boolean {
  return left.min.x <= right.max.x && left.max.x >= right.min.x
    && left.min.y <= right.max.y && left.max.y >= right.min.y
    && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

function toSpatialCellBounds(bounds: PhysicsBodyAabb): SpatialCellBounds {
  if (!isFiniteVector(bounds.min) || !isFiniteVector(bounds.max)) {
    throw new RangeError("Contraption AABB must contain finite coordinates.");
  }
  return {
    maxX: Math.floor(bounds.max.x / SPATIAL_CELL_SIZE),
    maxY: Math.floor(bounds.max.y / SPATIAL_CELL_SIZE),
    maxZ: Math.floor(bounds.max.z / SPATIAL_CELL_SIZE),
    minX: Math.floor(bounds.min.x / SPATIAL_CELL_SIZE),
    minY: Math.floor(bounds.min.y / SPATIAL_CELL_SIZE),
    minZ: Math.floor(bounds.min.z / SPATIAL_CELL_SIZE)
  };
}

function forEachCell(bounds: SpatialCellBounds, callback: (key: string) => void): void {
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) callback(`${x},${y},${z}`);
    }
  }
}

function cellBoundsEqual(left: SpatialCellBounds, right: SpatialCellBounds): boolean {
  return left.minX === right.minX
    && left.minY === right.minY
    && left.minZ === right.minZ
    && left.maxX === right.maxX
    && left.maxY === right.maxY
    && left.maxZ === right.maxZ;
}

// Boolean slab test. contraption-grid-raycast.ts rayUnitAabbHit runs the same
// axis-by-axis slab sequence while additionally tracking the entry normal;
// keep the arithmetic of the two in sync.
function rayIntersectsAabb(
  origin: Vector3,
  direction: Vector3,
  min: Vector3,
  max: Vector3,
  maximumDistance: number
): boolean {
  let near = 0;
  let far = maximumDistance;
  for (const axis of AXES) {
    const component = direction[axis];
        if (Math.abs(component) < EPSILON_1E8) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    let axisNear = (min[axis] - origin[axis]) / component;
    let axisFar = (max[axis] - origin[axis]) / component;
    if (axisNear > axisFar) [axisNear, axisFar] = [axisFar, axisNear];
    near = Math.max(near, axisNear);
    far = Math.min(far, axisFar);
    if (near > far) return false;
  }
  return far >= 0 && near <= maximumDistance;
}
