import { world, type Block, type Dimension, type Vector3 } from "@minecraft/server";
import { isTreeStructuralBlock } from "@src/content/tree/block/Blocks";

// Supported y range of the packed position encoding: 2048 rows, a deliberate
// superset of every current dimension's build limits so persisted entries
// survive future world-height changes.
const MIN_PACKED_Y = -512;
const MAX_PACKED_Y = 1535;
const MAX_CACHED_CHUNKS = 512;

export class ArtificialTreeRegistry {
  readonly #chunks = new Map<string, Set<number>>();
  // Probes arrive in spatially coherent bursts (BFS scans, sensor sweeps), so
  // one memoized chunk record answers nearly every consecutive lookup without
  // rebuilding the dynamic-property id string.
  #lastDimensionId?: string;
  #lastChunkX = 0;
  #lastChunkZ = 0;
  #lastRecord?: ChunkRecord;

  has(dimension: Dimension, location: Vector3): boolean {
    const chunkX = Math.floor(location.x / 16);
    const chunkZ = Math.floor(location.z / 16);
    const chunk = this.#getChunk(dimension, chunkX, chunkZ);
    return chunk.values.has(packLocalPosition(location, chunkX, chunkZ));
  }

  mark(dimension: Dimension, location: Vector3): void {
    const chunkX = Math.floor(location.x / 16);
    const chunkZ = Math.floor(location.z / 16);
    const chunk = this.#getChunk(dimension, chunkX, chunkZ);
    const packed = packLocalPosition(location, chunkX, chunkZ);
    if (chunk.values.has(packed)) return;
    chunk.values.add(packed);
    this.#save(chunk.propertyId, chunk.values);
  }

  markBlock(block: Block): void {
    if (isTreeStructuralBlock(block.typeId)) this.mark(block.dimension, block.location);
  }

  delete(dimension: Dimension, location: Vector3): void {
    const chunkX = Math.floor(location.x / 16);
    const chunkZ = Math.floor(location.z / 16);
    const chunk = this.#getChunk(dimension, chunkX, chunkZ);
    if (!chunk.values.delete(packLocalPosition(location, chunkX, chunkZ))) return;
    this.#save(chunk.propertyId, chunk.values);
  }

  #getChunk(dimension: Dimension, chunkX: number, chunkZ: number): ChunkRecord {
    if (
      this.#lastRecord
      && this.#lastDimensionId === dimension.id
      && this.#lastChunkX === chunkX
      && this.#lastChunkZ === chunkZ
    ) return this.#lastRecord;

    const propertyId = propertyIdFor(dimension.id, chunkX, chunkZ);
    let values = this.#chunks.get(propertyId);
    if (!values) {
      values = parseValues(world.getDynamicProperty(propertyId));
      this.#chunks.set(propertyId, values);
      if (this.#chunks.size > MAX_CACHED_CHUNKS) {
        // Evict the first-inserted chunk (FIFO, deliberately not LRU): probes
        // arrive in spatially coherent bursts served by the memo below, so
        // insertion order is a good enough recency proxy for this cache.
        const oldest = this.#chunks.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          this.#chunks.delete(oldest);
          // The memo must never outlive its backing map entry, or writes could
          // fork between the memoized set and a freshly reloaded one.
          if (this.#lastRecord?.propertyId === oldest) this.#lastRecord = undefined;
        }
      }
    }
    const record: ChunkRecord = { propertyId, values };
    this.#lastDimensionId = dimension.id;
    this.#lastChunkX = chunkX;
    this.#lastChunkZ = chunkZ;
    this.#lastRecord = record;
    return record;
  }

  #save(propertyId: string, values: Set<number>): void {
    if (values.size === 0) {
      world.setDynamicProperty(propertyId, undefined);
      return;
    }
    const encoded = [...values]
      .sort((left, right) => left - right)
      .map(value => value.toString(36))
      .join(".");
    world.setDynamicProperty(propertyId, encoded);
  }
}

interface ChunkRecord {
  propertyId: string;
  values: Set<number>;
}

function parseValues(value: boolean | number | string | Vector3 | undefined): Set<number> {
  if (typeof value !== "string" || value.length === 0) return new Set();
  const values = new Set<number>();
  for (const entry of value.split(".")) {
    const parsed = Number.parseInt(entry, 36);
    if (Number.isSafeInteger(parsed) && parsed >= 0) values.add(parsed);
  }
  return values;
}

// One chunk-local position per value: 16x16 columns per y row, rows stacked
// from MIN_PACKED_Y, i.e. packed = (y - MIN_PACKED_Y) * 256 + z * 16 + x.
function packLocalPosition(location: Vector3, chunkX: number, chunkZ: number): number {
  if (!Number.isInteger(location.y) || location.y < MIN_PACKED_Y || location.y > MAX_PACKED_Y) {
    throw new RangeError(`Tree registry y=${location.y} is outside the supported range.`);
  }
  const localX = location.x - chunkX * 16;
  const localZ = location.z - chunkZ * 16;
  return (location.y - MIN_PACKED_Y) * 256 + localZ * 16 + localX;
}

const DIMENSION_ID_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["minecraft:overworld", "o"],
  ["minecraft:nether", "n"],
  ["minecraft:the_end", "e"]
]);

function propertyIdFor(dimensionId: string, chunkX: number, chunkZ: number): string {
  // Custom dimensions fall back to a sanitized suffix of their id.
  const dimension = DIMENSION_ID_ABBREVIATIONS.get(dimensionId)
    ?? dimensionId.replace(/[^a-z0-9_]/g, "_").slice(-20);
  return `treephysics:placed_${dimension}_${signed(chunkX)}_${signed(chunkZ)}`;
}

function signed(value: number): string {
  return value < 0 ? `n${Math.abs(value).toString(36)}` : `p${value.toString(36)}`;
}
