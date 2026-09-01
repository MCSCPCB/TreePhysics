import type { Dimension, Player, Vector3 } from "@minecraft/server";
import type { PhysicsBodyAabb } from "@src/physics/core/Types";
import { EPSILON_1E6 } from "@src/utils/Vector3Math";

const CROSS_DOMAIN_PREDICTION_SECONDS = 0.35;
const CROSS_DOMAIN_MAX_PREDICTIVE_TRAVEL = 12;
const CROSS_DOMAIN_SUPPORT_MARGIN = 1.5;
const CROSS_DOMAIN_GUARD_BLOCKS = 16;

export function vectorSignature(value: Vector3): string {
  return `${value.x},${value.y},${value.z}`;
}

export function createPredictedBounds(bounds: PhysicsBodyAabb, velocity: Vector3): PhysicsBodyAabb {
  const travel = {
    x: clampTravel(velocity.x * CROSS_DOMAIN_PREDICTION_SECONDS),
    y: clampTravel(velocity.y * CROSS_DOMAIN_PREDICTION_SECONDS),
    z: clampTravel(velocity.z * CROSS_DOMAIN_PREDICTION_SECONDS)
  };
  return {
    min: {
      x: bounds.min.x - CROSS_DOMAIN_SUPPORT_MARGIN + Math.min(0, travel.x),
      y: bounds.min.y - CROSS_DOMAIN_SUPPORT_MARGIN + Math.min(0, travel.y),
      z: bounds.min.z - CROSS_DOMAIN_SUPPORT_MARGIN + Math.min(0, travel.z)
    },
    max: {
      x: bounds.max.x + CROSS_DOMAIN_SUPPORT_MARGIN + Math.max(0, travel.x),
      y: bounds.max.y + CROSS_DOMAIN_SUPPORT_MARGIN + Math.max(0, travel.y),
      z: bounds.max.z + CROSS_DOMAIN_SUPPORT_MARGIN + Math.max(0, travel.z)
    }
  };
}

export function createOutwardGuardBounds(bounds: PhysicsBodyAabb, treeLocation: Vector3, playerLocation: Vector3): PhysicsBodyAabb {
  const result = cloneBounds(bounds);
  const dx = treeLocation.x - playerLocation.x;
  const dz = treeLocation.z - playerLocation.z;
  if (Math.abs(dx) >= Math.abs(dz)) {
    if (dx >= 0) result.max.x += CROSS_DOMAIN_GUARD_BLOCKS;
    else result.min.x -= CROSS_DOMAIN_GUARD_BLOCKS;
  } else if (dz >= 0) {
    result.max.z += CROSS_DOMAIN_GUARD_BLOCKS;
  } else {
    result.min.z -= CROSS_DOMAIN_GUARD_BLOCKS;
  }
  return result;
}

export function areBoundsChunksReadable(dimension: Dimension, bounds: PhysicsBodyAabb, cache?: Map<string, boolean>): boolean {
  const minChunkX = Math.floor(bounds.min.x / 16);
  const maxChunkX = Math.floor((bounds.max.x - EPSILON_1E6) / 16);
  const minChunkZ = Math.floor(bounds.min.z / 16);
  const maxChunkZ = Math.floor((bounds.max.z - EPSILON_1E6) / 16);
  const y = Math.floor((bounds.min.y + bounds.max.y) * 0.5);
  for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
      const key = `${dimension.id}|${chunkX}|${y}|${chunkZ}`;
      let readable = cache?.get(key);
      if (readable === undefined) {
        readable = isLocationChunkReadable(dimension, { x: chunkX * 16 + 8, y, z: chunkZ * 16 + 8 });
        cache?.set(key, readable);
      }
      if (!readable) return false;
    }
  }
  return true;
}

function isLocationChunkReadable(dimension: Dimension, location: Vector3): boolean {
  try {
    return dimension.getBlock(location) !== undefined;
  } catch {
    return false;
  }
}

export function groupPlayersByDimension(players: readonly Player[]): Map<string, Player[]> {
  const result = new Map<string, Player[]>();
  for (const player of players) {
    let dimensionPlayers = result.get(player.dimension.id);
    if (!dimensionPlayers) {
      dimensionPlayers = [];
      result.set(player.dimension.id, dimensionPlayers);
    }
    dimensionPlayers.push(player);
  }
  return result;
}

export function expandBounds(bounds: PhysicsBodyAabb, amount: number): PhysicsBodyAabb {
  return {
    min: { x: bounds.min.x - amount, y: bounds.min.y - amount, z: bounds.min.z - amount },
    max: { x: bounds.max.x + amount, y: bounds.max.y + amount, z: bounds.max.z + amount }
  };
}

export function boundsOverlap(left: PhysicsBodyAabb, right: PhysicsBodyAabb): boolean {
  return left.min.x <= right.max.x && left.max.x >= right.min.x
    && left.min.y <= right.max.y && left.max.y >= right.min.y
    && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

export function mergeBounds(left: PhysicsBodyAabb, right: PhysicsBodyAabb): PhysicsBodyAabb {
  return {
    min: { x: Math.min(left.min.x, right.min.x), y: Math.min(left.min.y, right.min.y), z: Math.min(left.min.z, right.min.z) },
    max: { x: Math.max(left.max.x, right.max.x), y: Math.max(left.max.y, right.max.y), z: Math.max(left.max.z, right.max.z) }
  };
}

export function vectorDistance(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function cloneBounds(bounds: PhysicsBodyAabb): PhysicsBodyAabb {
  return { min: { ...bounds.min }, max: { ...bounds.max } };
}

function clampTravel(value: number): number {
  return Math.max(-CROSS_DOMAIN_MAX_PREDICTIVE_TRAVEL, Math.min(CROSS_DOMAIN_MAX_PREDICTIVE_TRAVEL, value));
}
