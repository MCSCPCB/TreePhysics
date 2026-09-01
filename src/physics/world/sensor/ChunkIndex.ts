export interface IndexedWorldSensorIntegerBounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
}

const WORLD_MESH_CHUNK_SIZE = 8;

/** Read-only membership view over the kernel's retained world-mesh chunk keys. */
export interface IndexedWorldSensorRetainedKeys {
  has(key: string): boolean;
}

/**
 * Enumerates only retained world-mesh chunks overlapped by one sensor sweep.
 * The y-z-x traversal matches filtering the complete retained region in place,
 * so downstream hit and representative-contact ordering remains unchanged.
 */
export function getIndexedWorldSensorCandidateChunkKeys(
  dimensionId: string,
  bounds: IndexedWorldSensorIntegerBounds,
  retainedKeys: IndexedWorldSensorRetainedKeys
): string[] {
  const keys: string[] = [];
  const minX = chunkOrigin(bounds.minX);
  const maxX = chunkOrigin(bounds.maxX);
  const minY = chunkOrigin(bounds.minY);
  const maxY = chunkOrigin(bounds.maxY);
  const minZ = chunkOrigin(bounds.minZ);
  const maxZ = chunkOrigin(bounds.maxZ);
  for (let y = minY; y <= maxY; y += WORLD_MESH_CHUNK_SIZE) {
    for (let z = minZ; z <= maxZ; z += WORLD_MESH_CHUNK_SIZE) {
      for (let x = minX; x <= maxX; x += WORLD_MESH_CHUNK_SIZE) {
        const key = `${dimensionId}|${x},${y},${z}`;
        if (retainedKeys.has(key)) keys.push(key);
      }
    }
  }
  return keys;
}

function chunkOrigin(coordinate: number): number {
  return Math.floor(coordinate / WORLD_MESH_CHUNK_SIZE) * WORLD_MESH_CHUNK_SIZE;
}
