import type { Vector3 } from "@minecraft/server";
import { add, scale } from "@src/utils/Vector3Math";
import { rotateVectorByEulerDegreesYzx } from "@src/physics/motion/RotationContinuity";
import { DEFAULT_OBB_SETTINGS, type ObbEntitySnapshot } from "@src/physics/obb";
import type { CollisionBoxState, WorldBounds } from "@src/physics/collision/ContraptionCollider";

export const COLLISION_PREDICTION_TICKS = 4;
export const COLLISION_DOWNWARD_PRELOAD_MARGIN = 8;
export const HORIZONTAL_BROAD_PHASE_MARGIN = DEFAULT_OBB_SETTINGS.collisionQueryMargin + 1;
const LOCAL_INDEX_CELL_SIZE = 4;
const PLAYER_INDEX_CELL_SIZE = 16;

export class ContraptionCollisionSnapshotIndex {
  readonly #cells = new Map<string, ObbEntitySnapshot[]>();

  constructor(snapshots: readonly ObbEntitySnapshot[]) {
    for (const snapshot of snapshots) {
      if (!snapshot.entity.isValid) continue;
      this.#insert(snapshot, createPlayerSweepBounds(snapshot));
    }
  }

  query(contraptionBounds: WorldBounds, bodyVelocity: Vector3): ObbEntitySnapshot[] {
    const bounds = createMovingContraptionBounds(contraptionBounds, bodyVelocity);
    const min = indexedCellCoordinate(bounds.min, PLAYER_INDEX_CELL_SIZE);
    const max = indexedCellCoordinate(bounds.max, PLAYER_INDEX_CELL_SIZE);
    const selected = new Set<ObbEntitySnapshot>();
    for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) for (let x = min.x; x <= max.x; x++) {
      for (const snapshot of this.#cells.get(`${x},${y},${z}`) ?? []) selected.add(snapshot);
    }
    return [...selected];
  }

  #insert(snapshot: ObbEntitySnapshot, bounds: WorldBounds): void {
    const min = indexedCellCoordinate(bounds.min, PLAYER_INDEX_CELL_SIZE);
    const max = indexedCellCoordinate(bounds.max, PLAYER_INDEX_CELL_SIZE);
    for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) for (let x = min.x; x <= max.x; x++) {
      const key = `${x},${y},${z}`;
      const cell = this.#cells.get(key);
      if (cell) cell.push(snapshot);
      else this.#cells.set(key, [snapshot]);
    }
  }
}

const LOCAL_INDEX_KEY_BIAS = 2048;
const LOCAL_INDEX_KEY_BASE = 4096;

function localIndexCellKey(x: number, y: number, z: number): number {
  return (x + LOCAL_INDEX_KEY_BIAS) + (y + LOCAL_INDEX_KEY_BIAS) * LOCAL_INDEX_KEY_BASE + (z + LOCAL_INDEX_KEY_BIAS) * LOCAL_INDEX_KEY_BASE * LOCAL_INDEX_KEY_BASE;
}

export class LocalCollisionBoxIndex {
  readonly #cells = new Map<number, CollisionBoxState[]>();

  rebuild(boxes: readonly CollisionBoxState[]): void {
    this.clear();
    for (const box of boxes) {
      const center = add(box.descriptor.localLocation, rotateVectorByEulerDegreesYzx({ x: 0, y: box.descriptor.size.y / 2, z: 0 }, box.descriptor.localRotation));
      const extent = getRotatedBoxAabbExtent(box.descriptor.size, box.descriptor.localRotation, rotateVectorByEulerDegreesYzx);
      const min = cellCoordinate({ x: center.x - extent.x, y: center.y - extent.y, z: center.z - extent.z });
      const max = cellCoordinate({ x: center.x + extent.x, y: center.y + extent.y, z: center.z + extent.z });
      for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) for (let x = min.x; x <= max.x; x++) {
        const key = localIndexCellKey(x, y, z);
        const cell = this.#cells.get(key);
        if (cell) cell.push(box); else this.#cells.set(key, [box]);
      }
    }
  }

  query(bounds: WorldBounds, output: Set<CollisionBoxState>): void {
    const min = cellCoordinate(bounds.min);
    const max = cellCoordinate(bounds.max);
    const minX = Math.max(min.x, -LOCAL_INDEX_KEY_BIAS);
    const minY = Math.max(min.y, -LOCAL_INDEX_KEY_BIAS);
    const minZ = Math.max(min.z, -LOCAL_INDEX_KEY_BIAS);
    const maxX = Math.min(max.x, LOCAL_INDEX_KEY_BIAS - 1);
    const maxY = Math.min(max.y, LOCAL_INDEX_KEY_BIAS - 1);
    const maxZ = Math.min(max.z, LOCAL_INDEX_KEY_BIAS - 1);
    for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      const cell = this.#cells.get(localIndexCellKey(x, y, z));
      if (!cell) continue;
      for (const box of cell) output.add(box);
    }
  }

  clear(): void { this.#cells.clear(); }
}

function cellCoordinate(location: Vector3): Vector3 { return indexedCellCoordinate(location, LOCAL_INDEX_CELL_SIZE); }
function indexedCellCoordinate(location: Vector3, cellSize: number): Vector3 { return { x: Math.floor(location.x / cellSize), y: Math.floor(location.y / cellSize), z: Math.floor(location.z / cellSize) }; }

function createPlayerSweepBounds(snapshot: ObbEntitySnapshot): WorldBounds {
  const start = snapshot.aabb.center;
  const predicted = add(start, scale(snapshot.velocity, COLLISION_PREDICTION_TICKS));
  const downward = { x: start.x, y: start.y - COLLISION_DOWNWARD_PRELOAD_MARGIN, z: start.z };
  const radius = Math.hypot(snapshot.aabb.extent.x, snapshot.aabb.extent.y, snapshot.aabb.extent.z) + HORIZONTAL_BROAD_PHASE_MARGIN;
  return {
    min: { x: Math.min(start.x, predicted.x, downward.x) - radius, y: Math.min(start.y, predicted.y, downward.y) - radius, z: Math.min(start.z, predicted.z, downward.z) - radius },
    max: { x: Math.max(start.x, predicted.x, downward.x) + radius, y: Math.max(start.y, predicted.y, downward.y) + radius, z: Math.max(start.z, predicted.z, downward.z) + radius }
  };
}

function createMovingContraptionBounds(bounds: WorldBounds, velocity: Vector3): WorldBounds {
  const travel = scale(velocity, COLLISION_PREDICTION_TICKS);
  return {
    min: { x: Math.min(bounds.min.x, bounds.min.x + travel.x), y: Math.min(bounds.min.y, bounds.min.y + travel.y), z: Math.min(bounds.min.z, bounds.min.z + travel.z) },
    max: { x: Math.max(bounds.max.x, bounds.max.x + travel.x), y: Math.max(bounds.max.y, bounds.max.y + travel.y), z: Math.max(bounds.max.z, bounds.max.z + travel.z) }
  };
}

export function createContraptionRotationSweepBounds(previousFrame: { origin: Vector3 }, frame: { origin: Vector3 }, localBounds: WorldBounds): WorldBounds {
  const radius = Math.hypot(Math.max(Math.abs(localBounds.min.x), Math.abs(localBounds.max.x)), Math.max(Math.abs(localBounds.min.y), Math.abs(localBounds.max.y)), Math.max(Math.abs(localBounds.min.z), Math.abs(localBounds.max.z)));
  return {
    min: { x: Math.min(previousFrame.origin.x, frame.origin.x) - radius, y: Math.min(previousFrame.origin.y, frame.origin.y) - radius, z: Math.min(previousFrame.origin.z, frame.origin.z) - radius },
    max: { x: Math.max(previousFrame.origin.x, frame.origin.x) + radius, y: Math.max(previousFrame.origin.y, frame.origin.y) + radius, z: Math.max(previousFrame.origin.z, frame.origin.z) + radius }
  };
}

export function getDescriptorBounds(boxes: readonly CollisionBoxState[], rotate: (value: Vector3, rotation: Vector3) => Vector3): WorldBounds | undefined {
  if (boxes.length === 0) return undefined;
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  for (const box of boxes) {
    const center = add(box.descriptor.localLocation, rotate({ x: 0, y: box.descriptor.size.y / 2, z: 0 }, box.descriptor.localRotation));
    const extent = getRotatedBoxAabbExtent(box.descriptor.size, box.descriptor.localRotation, rotate);
    min.x = Math.min(min.x, center.x - extent.x); min.y = Math.min(min.y, center.y - extent.y); min.z = Math.min(min.z, center.z - extent.z);
    max.x = Math.max(max.x, center.x + extent.x); max.y = Math.max(max.y, center.y + extent.y); max.z = Math.max(max.z, center.z + extent.z);
  }
  return { max, min };
}

function getRotatedBoxAabbExtent(size: Vector3, rotation: Vector3, rotate = (value: Vector3, _rotation: Vector3) => value): Vector3 {
  const halfWidth = size.x / 2; const halfHeight = size.y / 2; const halfDepth = size.z / 2;
  const sideways = rotate({ x: 1, y: 0, z: 0 }, rotation); const normal = rotate({ x: 0, y: 1, z: 0 }, rotation); const forward = rotate({ x: 0, y: 0, z: 1 }, rotation);
  return { x: Math.abs(sideways.x) * halfWidth + Math.abs(normal.x) * halfHeight + Math.abs(forward.x) * halfDepth, y: Math.abs(sideways.y) * halfWidth + Math.abs(normal.y) * halfHeight + Math.abs(forward.y) * halfDepth, z: Math.abs(sideways.z) * halfWidth + Math.abs(normal.z) * halfHeight + Math.abs(forward.z) * halfDepth };
}
