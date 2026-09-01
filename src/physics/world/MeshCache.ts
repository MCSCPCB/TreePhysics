// Chunked world-mesh cache primitives for the cannon kernel: chunk keys and
// requests, cached-chunk scanning/signatures, and the per-chunk sensor-box bin
// index. The runtime cache bookkeeping itself remains in cannon-kernel.ts.
import type { Block, Dimension, Vector3 } from "@minecraft/server";
import type { Body } from "cannon-es";
import type { PhysicsBlockProperties } from "@src/physics/core/Types";
import { GreedyBoxMesher, type GreedyBox } from "@src/physics/core/GreedyBoxMesher";
import {
  compareStrings,
  intersectIntegerBounds,
  mergeIntegerBounds,
  type IntegerBounds
} from "@src/physics/motion/KernelMath";
import {
  createFluidSurface,
  getWorldBlockMaterialId,
  isPhysicsFluidBlock,
  matchesWorldBlockSensorPredicate,
  resolveWorldBlockCollisionShape,
  type FluidSurface
} from "@src/physics/world/BlockClassification";
import {
  addScanBoundsClusterToList,
  collisionShapeSignature,
  getBatchWorldScanLocations,
  sortGreedyBoxes,
  type ScanBoundsCluster,
  type WorldScanCoverage
} from "@src/physics/world/BlockScan";
import { safeGetBlock } from "@src/utils/WorldBlock";

export const WORLD_MESH_CACHE_CHUNK_SIZE = 8;

const WORLD_SENSOR_BIN_SIZE = 2;
const WORLD_SENSOR_BINS_PER_AXIS = WORLD_MESH_CACHE_CHUNK_SIZE / WORLD_SENSOR_BIN_SIZE;
const WORLD_SENSOR_BIN_COUNT = WORLD_SENSOR_BINS_PER_AXIS ** 3;

export interface CachedWorldColliderGroup {
  readonly boxes: readonly GreedyBox[];
  readonly collisionResponse: boolean;
  readonly materialId: string;
}

export interface CachedWorldMeshChunk {
  body?: Body;
  readonly bounds: IntegerBounds;
  readonly dimension: Dimension;
  readonly fluidSurfaces: ReadonlyMap<string, FluidSurface>;
  readonly groups: readonly CachedWorldColliderGroup[];
  readonly indexedSensorBoxBins: readonly (readonly number[] | undefined)[];
  readonly indexedSensorBoxes: readonly GreedyBox[];
  readonly indexedSensorBoxVisitMarks: number[];
  lastAuditedTick: number;
  lastUsedTick: number;
  scannedTick: number;
  sensorBody?: Body;
  sensorBodyAttached?: boolean;
  readonly signature: string;
}

export interface WorldMeshChunkRequest {
  readonly dimension: Dimension;
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
}

export const EMPTY_WORLD_MESH_CHUNKS: ReadonlyMap<string, WorldMeshChunkRequest> = new Map();

export function worldSensorBinCoordinate(coordinate: number, chunkOrigin: number): number {
  return Math.max(0, Math.min(
    WORLD_SENSOR_BINS_PER_AXIS - 1,
    Math.floor((coordinate - chunkOrigin) / WORLD_SENSOR_BIN_SIZE)
  ));
}

export function worldSensorBinIndex(x: number, y: number, z: number): number {
  return x
    + z * WORLD_SENSOR_BINS_PER_AXIS
    + y * WORLD_SENSOR_BINS_PER_AXIS * WORLD_SENSOR_BINS_PER_AXIS;
}

function createIndexedWorldSensorBoxBins(
  boxes: readonly GreedyBox[],
  originX: number,
  originY: number,
  originZ: number
): readonly (readonly number[] | undefined)[] {
  const bins: (number[] | undefined)[] = new Array(WORLD_SENSOR_BIN_COUNT);
  for (let boxIndex = 0; boxIndex < boxes.length; boxIndex++) {
    const box = boxes[boxIndex]!;
    const minBinX = worldSensorBinCoordinate(box.minX, originX);
    const minBinY = worldSensorBinCoordinate(box.minY, originY);
    const minBinZ = worldSensorBinCoordinate(box.minZ, originZ);
    const maxBinX = worldSensorBinCoordinate(box.minX + box.sizeX - 1, originX);
    const maxBinY = worldSensorBinCoordinate(box.minY + box.sizeY - 1, originY);
    const maxBinZ = worldSensorBinCoordinate(box.minZ + box.sizeZ - 1, originZ);
    for (let binY = minBinY; binY <= maxBinY; binY++) {
      for (let binZ = minBinZ; binZ <= maxBinZ; binZ++) {
        for (let binX = minBinX; binX <= maxBinX; binX++) {
          const binIndex = worldSensorBinIndex(binX, binY, binZ);
          (bins[binIndex] ??= []).push(boxIndex);
        }
      }
    }
  }
  return bins;
}

export function scanWorldMeshChunk(
  dimension: Dimension,
  originX: number,
  originY: number,
  originZ: number,
  currentTick: number,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>,
  sensorPredicate: ((block: Block) => boolean) | undefined
): CachedWorldMeshChunk | undefined {
  const bounds: IntegerBounds = {
    maxX: originX + WORLD_MESH_CACHE_CHUNK_SIZE - 1,
    maxY: originY + WORLD_MESH_CACHE_CHUNK_SIZE - 1,
    maxZ: originZ + WORLD_MESH_CACHE_CHUNK_SIZE - 1,
    minX: originX,
    minY: originY,
    minZ: originZ
  };
  const coverage: WorldScanCoverage = { bounds, sizeZ: WORLD_MESH_CACHE_CHUNK_SIZE };
  const fluidSurfaces = new Map<string, FluidSurface>();
  const groupBoxes = new Map<string, {
    boxes: GreedyBox[];
    collisionResponse: boolean;
    materialId: string;
  }>();
  const indexedSensorMesher = new GreedyBoxMesher(
    WORLD_MESH_CACHE_CHUNK_SIZE,
    WORLD_MESH_CACHE_CHUNK_SIZE,
    WORLD_MESH_CACHE_CHUNK_SIZE,
    "world_block",
    false
  );
  const meshers = new Map<string, GreedyBoxMesher>();
  const signatureEntries: string[] = [];
  const scan = (location: Vector3): boolean => {
    const block = safeGetBlock(dimension, location);
    if (block === undefined) return false;
    if (block.isAir) return true;
    const index = location.x - originX
      + (location.z - originZ) * WORLD_MESH_CACHE_CHUNK_SIZE
      + (location.y - originY)
        * WORLD_MESH_CACHE_CHUNK_SIZE
        * WORLD_MESH_CACHE_CHUNK_SIZE;
    if (isPhysicsFluidBlock(block)) {
      const fluid = createFluidSurface(block, location.y);
      fluidSurfaces.set(`${location.x},${location.y},${location.z}`, fluid);
      signatureEntries.push(
        `${index}:l:${fluid.typeId}:${fluid.surfaceY}:${fluid.nativeFlowing ? 1 : 0}`
      );
      return true;
    }
    const shape = resolveWorldBlockCollisionShape(block, blockProperties);
    if (shape === "none") return true;
    const sensor = matchesWorldBlockSensorPredicate(block, sensorPredicate);
    const collisionResponse = !sensor;
    const materialId = getWorldBlockMaterialId(block, blockProperties);
    const groupKey = `${collisionResponse ? "s" : "n"}:${materialId}`;
    signatureEntries.push(
      `${index}:${collisionResponse ? "s" : "n"}:${materialId}:`
      + collisionShapeSignature(shape)
    );
    if (sensor && shape === "full") {
      indexedSensorMesher.setVoxel(
        location.x - originX,
        location.y - originY,
        location.z - originZ
      );
      return true;
    }
    if (shape === "full") {
      let mesher = meshers.get(groupKey);
      if (!mesher) {
        mesher = new GreedyBoxMesher(
          WORLD_MESH_CACHE_CHUNK_SIZE,
          WORLD_MESH_CACHE_CHUNK_SIZE,
          WORLD_MESH_CACHE_CHUNK_SIZE,
          materialId,
          collisionResponse
        );
        meshers.set(groupKey, mesher);
      }
      mesher.setVoxel(location.x - originX, location.y - originY, location.z - originZ);
      return true;
    }
    let group = groupBoxes.get(groupKey);
    if (!group) {
      group = { boxes: [], collisionResponse, materialId };
      groupBoxes.set(groupKey, group);
    }
    for (const box of shape) {
      group.boxes.push({
        collisionResponse,
        materialId,
        minX: location.x + box.min.x,
        minY: location.y + box.min.y,
        minZ: location.z + box.min.z,
        sizeX: box.max.x - box.min.x,
        sizeY: box.max.y - box.min.y,
        sizeZ: box.max.z - box.min.z
      });
    }
    return true;
  };
  const batchLocations = getBatchWorldScanLocations(dimension, bounds, coverage);
  if (batchLocations !== undefined) {
    for (const location of batchLocations) {
      if (!scan(location)) return undefined;
    }
  } else {
    const location = { x: originX, y: originY, z: originZ };
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      location.y = y;
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        location.z = z;
        for (let x = bounds.minX; x <= bounds.maxX; x++) {
          location.x = x;
          if (!scan(location)) return undefined;
        }
      }
    }
  }
  for (const [groupKey, mesher] of meshers) {
    let group = groupBoxes.get(groupKey);
    if (!group) {
      group = {
        boxes: [],
        collisionResponse: mesher.collisionResponse,
        materialId: mesher.materialId
      };
      groupBoxes.set(groupKey, group);
    }
    group.boxes.push(...mesher.meshBoxes(originX, originY, originZ));
  }
  const groups = [...groupBoxes.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, group]) => {
      sortGreedyBoxes(group.boxes);
      return group;
    });
  const indexedSensorBoxes = indexedSensorMesher.meshBoxes(originX, originY, originZ);
  sortGreedyBoxes(indexedSensorBoxes);
  const indexedSensorBoxBins = createIndexedWorldSensorBoxBins(
    indexedSensorBoxes,
    originX,
    originY,
    originZ
  );
  signatureEntries.sort(compareStrings);
  return {
    bounds,
    dimension,
    fluidSurfaces,
    groups,
    indexedSensorBoxBins,
    indexedSensorBoxes,
    indexedSensorBoxVisitMarks: new Array<number>(indexedSensorBoxes.length).fill(0),
    lastAuditedTick: currentTick,
    lastUsedTick: currentTick,
    scannedTick: currentTick,
    signature: signatureEntries.join(";")
  };
}

export function getWorldMeshChunkRequests(
  dimension: Dimension,
  bounds: IntegerBounds
): WorldMeshChunkRequest[] {
  const requests: WorldMeshChunkRequest[] = [];
  const minX = worldMeshChunkOrigin(bounds.minX);
  const maxX = worldMeshChunkOrigin(bounds.maxX);
  const minY = worldMeshChunkOrigin(bounds.minY);
  const maxY = worldMeshChunkOrigin(bounds.maxY);
  const minZ = worldMeshChunkOrigin(bounds.minZ);
  const maxZ = worldMeshChunkOrigin(bounds.maxZ);
  for (let y = minY; y <= maxY; y += WORLD_MESH_CACHE_CHUNK_SIZE) {
    for (let z = minZ; z <= maxZ; z += WORLD_MESH_CACHE_CHUNK_SIZE) {
      for (let x = minX; x <= maxX; x += WORLD_MESH_CACHE_CHUNK_SIZE) {
        requests.push({ dimension, originX: x, originY: y, originZ: z });
      }
    }
  }
  return requests;
}

export function worldMeshChunkRegionSignature(bounds: IntegerBounds): string {
  return [
    worldMeshChunkOrigin(bounds.minX),
    worldMeshChunkOrigin(bounds.minY),
    worldMeshChunkOrigin(bounds.minZ),
    worldMeshChunkOrigin(bounds.maxX),
    worldMeshChunkOrigin(bounds.maxY),
    worldMeshChunkOrigin(bounds.maxZ)
  ].join(",");
}

export function getMissingWorldMeshScanClusters(
  dimension: Dimension,
  clusters: readonly ScanBoundsCluster[],
  cache: ReadonlyMap<string, CachedWorldMeshChunk>
): ScanBoundsCluster[] {
  const missing: ScanBoundsCluster[] = [];
  for (const cluster of clusters) {
    for (const request of getWorldMeshChunkRequests(dimension, cluster.bounds)) {
      if (cache.has(worldMeshChunkRequestKey(request))) continue;
      const clipped = clipScanBoundsCluster(cluster, {
        maxX: request.originX + WORLD_MESH_CACHE_CHUNK_SIZE - 1,
        maxY: request.originY + WORLD_MESH_CACHE_CHUNK_SIZE - 1,
        maxZ: request.originZ + WORLD_MESH_CACHE_CHUNK_SIZE - 1,
        minX: request.originX,
        minY: request.originY,
        minZ: request.originZ
      });
      if (clipped) addScanBoundsClusterToList(missing, clipped);
    }
  }
  return missing;
}

function clipScanBoundsCluster(
  cluster: ScanBoundsCluster,
  clipBounds: IntegerBounds
): ScanBoundsCluster | undefined {
  const members = cluster.members
    .map(member => intersectIntegerBounds(member, clipBounds))
    .filter((member): member is IntegerBounds => member !== undefined);
  if (members.length === 0) return undefined;
  const bounds = members.slice(1).reduce(mergeIntegerBounds, members[0]!);
  return {
    bounds,
    members,
    shadowFilterEligible: cluster.shadowFilterEligible,
    shadowShapes: cluster.shadowShapes ? [...cluster.shadowShapes] : undefined,
    sparse: cluster.sparse || members.length > 1
  };
}

export function worldMeshChunkRequest(
  dimension: Dimension,
  location: Vector3
): WorldMeshChunkRequest {
  return {
    dimension,
    originX: worldMeshChunkOrigin(location.x),
    originY: worldMeshChunkOrigin(location.y),
    originZ: worldMeshChunkOrigin(location.z)
  };
}

export function worldMeshChunkRequestKey(request: WorldMeshChunkRequest): string {
  return worldMeshChunkKey(
    request.dimension,
    request.originX,
    request.originY,
    request.originZ
  );
}

export function addWorldMeshChunkRequest(
  requests: Map<string, WorldMeshChunkRequest>,
  dimension: Dimension,
  originX: number,
  originY: number,
  originZ: number
): void {
  const key = worldMeshChunkKey(dimension, originX, originY, originZ);
  requests.set(key, { dimension, originX, originY, originZ });
}

export function worldMeshChunkOrigin(coordinate: number): number {
  return Math.floor(coordinate / WORLD_MESH_CACHE_CHUNK_SIZE) * WORLD_MESH_CACHE_CHUNK_SIZE;
}

function worldMeshChunkKey(
  dimension: Dimension,
  originX: number,
  originY: number,
  originZ: number
): string {
  return `${dimension.id}|${originX},${originY},${originZ}`;
}
