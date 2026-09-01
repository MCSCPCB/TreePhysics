// World solid-block scanning for the cannon kernel: scan-bounds clusters, row
// coverage, shadow filtering, batch block reads, and the greedy-meshed solid and
// fluid scans shared by the cached and uncached collider sync paths.
import { BlockVolume, type Block, type Dimension, type Vector3 } from "@minecraft/server";
import type { PhysicsBlockCollisionBox, PhysicsBlockProperties } from "@src/physics/core/Types";
import { GreedyBoxMesher, type GreedyBox } from "@src/physics/core/GreedyBoxMesher";
import {
  addMergedNumericInterval,
  compareStrings,
  integerBoundsOverlapOrTouch,
  mergeIntegerBounds,
  type IntegerBounds
} from "@src/physics/motion/KernelMath";
import {
  createFluidSurface,
  getWorldBlockMaterialId,
  isPhysicsFluidBlock,
  isWorldBlockColliding,
  matchesWorldBlockSensorPredicate,
  resolveWorldBlockCollisionShape
} from "@src/physics/world/BlockClassification";
import { safeGetBlock } from "@src/utils/WorldBlock";

const WORLD_BLOCK_SLEEP_BATCH_MIN_SCAN_VOLUME = 256;

const WORLD_BLOCK_SHADOW_MIN_BATCH_LOCATIONS = 256;

const WORLD_SCAN_NON_AIR_FILTER = { excludeTypes: ["minecraft:air"] };

export interface ScanBoundsCluster {
  bounds: IntegerBounds;
  coverage?: WorldScanCoverage;
  members: IntegerBounds[];
  shadowFilterEligible: boolean;
  shadowShapes?: ShadowScanShape[];
  sparse: boolean;
}

export interface AppliedShadowScan {
  readonly coverage: WorldScanCoverage;
  readonly shapes: readonly ShadowScanShape[];
}

export interface ShadowScanShape {
  readonly localHalfX: number;
  readonly localHalfY: number;
  readonly localHalfZ: number;
  readonly localMaxX: number;
  readonly localMaxY: number;
  readonly localMaxZ: number;
  readonly localMinX: number;
  readonly localMinY: number;
  readonly localMinZ: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly positionZ: number;
  readonly rotation00: number;
  readonly rotation01: number;
  readonly rotation02: number;
  readonly rotation10: number;
  readonly rotation11: number;
  readonly rotation12: number;
  readonly rotation20: number;
  readonly rotation21: number;
  readonly rotation22: number;
}

export interface WorldScanCoverage {
  readonly bounds: IntegerBounds;
  readonly rows?: readonly (readonly number[] | undefined)[];
  readonly sizeZ: number;
}

export interface WorldSolidBlockScan {
  readonly boxes: readonly GreedyBox[];
  readonly coverage: WorldScanCoverage;
  readonly fluids: readonly {
    nativeFlowing: boolean;
    x: number;
    y: number;
    z: number;
    surfaceY: number;
    typeId: string;
  }[];
  readonly shadowApplied: boolean;
}

export function addScanBoundsCluster(
  clustersByDimension: Map<Dimension, ScanBoundsCluster[]>,
  dimension: Dimension,
  bounds: IntegerBounds,
  sparse = false,
  shadowShapes?: readonly ShadowScanShape[],
  shadowFilterEligible = false
): void {
  const list = clustersByDimension.get(dimension);
  if (!list) {
    clustersByDimension.set(dimension, [{
      bounds,
      members: [bounds],
      shadowFilterEligible,
      shadowShapes: shadowShapes ? [...shadowShapes] : undefined,
      sparse
    }]);
    return;
  }
  addScanBoundsClusterToList(list, {
    bounds,
    members: [bounds],
    shadowFilterEligible,
    shadowShapes: shadowShapes ? [...shadowShapes] : undefined,
    sparse
  });
}

export function addScanBoundsClusterToList(
  list: ScanBoundsCluster[],
  cluster: ScanBoundsCluster
): void {
  let merged: ScanBoundsCluster = {
    bounds: cluster.bounds,
    coverage: cluster.coverage,
    members: [...cluster.members],
    shadowFilterEligible: cluster.shadowFilterEligible,
    shadowShapes: cluster.shadowShapes ? [...cluster.shadowShapes] : undefined,
    sparse: cluster.sparse
  };
  let changed = false;
  for (let index = 0; index < list.length; index++) {
    const existing = list[index];
    if (!integerBoundsOverlapOrTouch(existing.bounds, merged.bounds)) continue;
    merged.bounds = mergeIntegerBounds(existing.bounds, merged.bounds);
    merged.members.push(...existing.members);
    merged.shadowFilterEligible &&= existing.shadowFilterEligible;
    if (existing.shadowShapes) {
      if (merged.shadowShapes) merged.shadowShapes.push(...existing.shadowShapes);
      else merged.shadowShapes = [...existing.shadowShapes];
    }
    merged.sparse ||= existing.sparse;
    changed = true;
    list.splice(index, 1);
    index = -1;
  }
  if (changed) merged.coverage = undefined;
  list.push(merged);
}

export function findWorldSupportInBounds(
  dimension: Dimension,
  bounds: IntegerBounds,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>,
  sensorPredicate: ((block: Block) => boolean) | undefined
): boolean {
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        if (isWorldBlockColliding(
          dimension,
          { x, y, z },
          blockProperties,
          sensorPredicate
        )) return true;
      }
    }
  }
  return false;
}

export function scanSleepingEnvironment(
  dimension: Dimension,
  cluster: ScanBoundsCluster,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>,
  sensorPredicate: ((block: Block) => boolean) | undefined
): { readonly signature: string } {
  const bounds = cluster.bounds;
  const sizeX = bounds.maxX - bounds.minX + 1;
  const sizeY = bounds.maxY - bounds.minY + 1;
  const sizeZ = bounds.maxZ - bounds.minZ + 1;
  const coverage = createWorldScanCoverage(cluster, sizeY, sizeZ);
  const entries: string[] = [
    `${bounds.minX},${bounds.minY},${bounds.minZ}:${bounds.maxX},${bounds.maxY},${bounds.maxZ}`
  ];
  const scanVolume = worldScanCoverageVolume(coverage, sizeX, sizeY, sizeZ);
  const batchLocations = scanVolume >= WORLD_BLOCK_SLEEP_BATCH_MIN_SCAN_VOLUME
    ? getBatchWorldScanLocations(dimension, bounds, coverage)
    : undefined;
  const scan = (x: number, y: number, z: number): void => {
    const block = safeGetBlock(dimension, { x, y, z });
    if (block === undefined || block.isAir) return;
    const index = x - bounds.minX
      + (z - bounds.minZ) * sizeX
      + (y - bounds.minY) * sizeX * sizeZ;
    if (isPhysicsFluidBlock(block)) {
      const fluid = createFluidSurface(block, y);
      entries.push(
        `${index}:l:${fluid.typeId}:${fluid.surfaceY}:${fluid.nativeFlowing ? 1 : 0}`
      );
      return;
    }
    const shape = resolveWorldBlockCollisionShape(block, blockProperties);
    if (shape === "none") return;
    // Single-character world-scan group codes: "s" = solid (collision response
    // on), "n" = non-colliding sensor block. Baked into mesher group keys and
    // chunk scan signatures, so the byte values must stay stable.
    entries.push(
      `${index}:${matchesWorldBlockSensorPredicate(block, sensorPredicate) ? "n" : "s"}:`
      + `${getWorldBlockMaterialId(block, blockProperties)}:${collisionShapeSignature(shape)}`
    );
  };
  if (batchLocations !== undefined) {
    batchLocations.sort((left, right) => {
      const leftIndex = left.x - bounds.minX
        + (left.z - bounds.minZ) * sizeX
        + (left.y - bounds.minY) * sizeX * sizeZ;
      const rightIndex = right.x - bounds.minX
        + (right.z - bounds.minZ) * sizeX
        + (right.y - bounds.minY) * sizeX * sizeZ;
      return leftIndex - rightIndex;
    });
    for (const location of batchLocations) scan(location.x, location.y, location.z);
  } else if (!coverage.rows) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        for (let x = bounds.minX; x <= bounds.maxX; x++) scan(x, y, z);
      }
    }
  } else {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
        const intervals = coverage.rows[(y - bounds.minY) * sizeZ + z - bounds.minZ];
        if (!intervals) continue;
        for (let offset = 0; offset < intervals.length; offset += 2) {
          for (let x = intervals[offset]!; x <= intervals[offset + 1]!; x++) {
            scan(x, y, z);
          }
        }
      }
    }
  }
  return { signature: entries.join(";") };
}

export function collisionShapeSignature(
  shape: "full" | readonly PhysicsBlockCollisionBox[]
): string {
  if (shape === "full") return "f";
  return shape.map(box => [
    box.min.x,
    box.min.y,
    box.min.z,
    box.max.x,
    box.max.y,
    box.max.z
  ].join(",")).join("|");
}

export function scanWorldSolidBlocks(
  dimension: Dimension,
  cluster: ScanBoundsCluster,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>,
  sensorPredicate: ((block: Block) => boolean) | undefined
): WorldSolidBlockScan {
  const bounds = cluster.bounds;
  const sizeX = Math.max(0, bounds.maxX - bounds.minX + 1);
  const sizeY = Math.max(0, bounds.maxY - bounds.minY + 1);
  const sizeZ = Math.max(0, bounds.maxZ - bounds.minZ + 1);
  const coverage = createWorldScanCoverage(cluster, sizeY, sizeZ);
  const meshers = new Map<string, GreedyBoxMesher>();
  const partialBoxes: GreedyBox[] = [];
  const fluids: {
    nativeFlowing: boolean;
    x: number;
    y: number;
    z: number;
    surfaceY: number;
    typeId: string;
  }[] = [];
  const scan = (location: Vector3): void => {
    const block = safeGetBlock(dimension, location);
    if (block === undefined || block.isAir) return;
    if (isPhysicsFluidBlock(block)) {
      fluids.push({
        ...location,
        ...createFluidSurface(block, location.y)
      });
      return;
    }
    const shape = resolveWorldBlockCollisionShape(block, blockProperties);
    if (shape === "none") return;
    const materialId = getWorldBlockMaterialId(block, blockProperties);
    const collisionResponse = !matchesWorldBlockSensorPredicate(block, sensorPredicate);
    if (shape === "full") {
      const mesherId = `${collisionResponse ? "s" : "n"}:${materialId}`;
      let mesher = meshers.get(mesherId);
      if (!mesher) {
        mesher = new GreedyBoxMesher(
          sizeX,
          sizeY,
          sizeZ,
          materialId,
          collisionResponse
        );
        meshers.set(mesherId, mesher);
      }
      mesher.setVoxel(
        location.x - bounds.minX,
        location.y - bounds.minY,
        location.z - bounds.minZ
      );
      return;
    }
    for (const box of shape) {
      partialBoxes.push({
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
  };
  const batchLocations = getBatchWorldScanLocations(dimension, bounds, coverage);
  let scanLocations = batchLocations;
  const applyShadowFilter = batchLocations !== undefined
    && batchLocations.length >= WORLD_BLOCK_SHADOW_MIN_BATCH_LOCATIONS
    && cluster.shadowFilterEligible
    && cluster.shadowShapes !== undefined;
  if (batchLocations !== undefined && cluster.shadowShapes !== undefined && applyShadowFilter) {
    let retainedWriteIndex = 0;
    for (const location of batchLocations) {
      if (isLocationRetainedByShadowScan(cluster.shadowShapes, location)) {
        batchLocations[retainedWriteIndex++] = location;
      }
    }
    batchLocations.length = retainedWriteIndex;
  }
  if (scanLocations !== undefined) {
    for (const location of scanLocations) scan(location);
  } else if (!coverage.rows) {
    const location = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
    for (let y = 0; y < sizeY; y++) {
      location.y = bounds.minY + y;
      for (let z = 0; z < sizeZ; z++) {
        location.z = bounds.minZ + z;
        for (let x = 0; x < sizeX; x++) {
          location.x = bounds.minX + x;
          scan(location);
        }
      }
    }
  } else {
    const location = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
    for (let y = 0; y < sizeY; y++) {
      location.y = bounds.minY + y;
      for (let z = 0; z < sizeZ; z++) {
        location.z = bounds.minZ + z;
        const intervals = coverage.rows[y * sizeZ + z];
        if (!intervals) continue;
        for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex += 2) {
          const minX = intervals[intervalIndex]!;
          const maxX = intervals[intervalIndex + 1]!;
          for (let worldX = minX; worldX <= maxX; worldX++) {
            location.x = worldX;
            scan(location);
          }
        }
      }
    }
  }
  const boxes = [
    ...Array.from(meshers.values()).flatMap((mesher) =>
      mesher.meshBoxes(bounds.minX, bounds.minY, bounds.minZ)
    ),
    ...partialBoxes
  ];
  return {
    boxes,
    coverage,
    fluids,
    shadowApplied: applyShadowFilter
  };
}

function isLocationRetainedByShadowScan(
  shapes: readonly ShadowScanShape[],
  location: Vector3
): boolean {
  const centerX = location.x + 0.5;
  const centerY = location.y + 0.5;
  const centerZ = location.z + 0.5;
  for (const shape of shapes) {
    const deltaX = centerX - shape.positionX;
    const deltaY = centerY - shape.positionY;
    const deltaZ = centerZ - shape.positionZ;
    const localX = shape.rotation00 * deltaX
      + shape.rotation10 * deltaY
      + shape.rotation20 * deltaZ;
    const localY = shape.rotation01 * deltaX
      + shape.rotation11 * deltaY
      + shape.rotation21 * deltaZ;
    const localZ = shape.rotation02 * deltaX
      + shape.rotation12 * deltaY
      + shape.rotation22 * deltaZ;
    if (
      localX + shape.localHalfX >= shape.localMinX
      && localX - shape.localHalfX <= shape.localMaxX
      && localY + shape.localHalfY >= shape.localMinY
      && localY - shape.localHalfY <= shape.localMaxY
      && localZ + shape.localHalfZ >= shape.localMinZ
      && localZ - shape.localHalfZ <= shape.localMaxZ
    ) return true;
  }
  return false;
}

export function getBatchWorldScanLocations(
  dimension: Dimension,
  bounds: IntegerBounds,
  coverage: WorldScanCoverage
): Vector3[] | undefined {
  if (typeof dimension.getBlocks !== "function") return undefined;
  const locations: Vector3[] = [];
  try {
    const volume = new BlockVolume(
      { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
      { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ }
    );
    const matches = dimension.getBlocks(volume, WORLD_SCAN_NON_AIR_FILTER, true);
    for (const location of matches.getBlockLocationIterator()) {
      if (isLocationCoveredByWorldScan(coverage, location)) locations.push(location);
    }
  } catch {
    return undefined;
  }
  return locations;
}

export function worldScanCoverageVolume(
  coverage: WorldScanCoverage,
  sizeX: number,
  sizeY: number,
  sizeZ: number
): number {
  if (!coverage.rows) return sizeX * sizeY * sizeZ;
  let count = 0;
  for (const intervals of coverage.rows) {
    if (!intervals) continue;
    for (let index = 0; index < intervals.length; index += 2) {
      count += intervals[index + 1]! - intervals[index]! + 1;
    }
  }
  return count;
}

export function createWorldScanCoverage(
  cluster: ScanBoundsCluster,
  sizeY: number,
  sizeZ: number
): WorldScanCoverage {
  if (cluster.coverage) return cluster.coverage;
  const bounds = cluster.bounds;
  if (!cluster.sparse || cluster.members.length === 1) {
    cluster.coverage = { bounds, sizeZ };
    return cluster.coverage;
  }
  const rows: (number[] | undefined)[] = new Array(sizeY * sizeZ);
  for (const member of cluster.members) {
    for (let y = member.minY; y <= member.maxY; y++) {
      const yOffset = y - bounds.minY;
      for (let z = member.minZ; z <= member.maxZ; z++) {
        const index = yOffset * sizeZ + z - bounds.minZ;
        let intervals = rows[index];
        if (!intervals) {
          intervals = [];
          rows[index] = intervals;
        }
        addMergedNumericInterval(intervals, member.minX, member.maxX);
      }
    }
  }
  let full = true;
  for (const intervals of rows) {
    if (
      intervals?.length !== 2
      || intervals[0] !== bounds.minX
      || intervals[1] !== bounds.maxX
    ) {
      full = false;
      break;
    }
  }
  cluster.coverage = full ? { bounds, sizeZ } : { bounds, rows, sizeZ };
  return cluster.coverage;
}

export function isCoveredByWorldScans(
  coverages: readonly WorldScanCoverage[] | undefined,
  location: Vector3
): boolean {
  if (!coverages) return false;
  for (const coverage of coverages) {
    if (isLocationCoveredByWorldScan(coverage, location)) return true;
  }
  return false;
}

export function isCoveredByAppliedShadowScans(
  scans: readonly AppliedShadowScan[] | undefined,
  location: Vector3
): boolean {
  if (!scans) return false;
  for (const scan of scans) {
    if (
      isLocationCoveredByWorldScan(scan.coverage, location)
      && isLocationRetainedByShadowScan(scan.shapes, location)
    ) return true;
  }
  return false;
}

function isLocationCoveredByWorldScan(
  coverage: WorldScanCoverage,
  location: Vector3
): boolean {
  const bounds = coverage.bounds;
  if (
    location.x < bounds.minX || location.x > bounds.maxX
    || location.y < bounds.minY || location.y > bounds.maxY
    || location.z < bounds.minZ || location.z > bounds.maxZ
  ) return false;
  if (!coverage.rows) return true;
  const row = coverage.rows[
    (location.y - bounds.minY) * coverage.sizeZ + location.z - bounds.minZ
  ];
  if (!row) return false;
  let low = 0;
  let high = row.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const minX = row[middle * 2]!;
    const maxX = row[middle * 2 + 1]!;
    if (location.x < minX) high = middle - 1;
    else if (location.x > maxX) low = middle + 1;
    else return true;
  }
  return false;
}

export function sortGreedyBoxes(boxes: GreedyBox[]): void {
  boxes.sort((left, right) =>
    Number(left.collisionResponse) - Number(right.collisionResponse)
    || compareStrings(left.materialId, right.materialId)
    || left.minY - right.minY
    || left.minZ - right.minZ
    || left.minX - right.minX
    || left.sizeY - right.sizeY
    || left.sizeZ - right.sizeZ
    || left.sizeX - right.sizeX
  );
}

export function createWorldColliderKeys(boxes: readonly GreedyBox[]): string[] {
  const occurrences = new Map<string, number>();
  return boxes.map(box => {
    const base = [
      box.minX,
      box.minY,
      box.minZ,
      box.sizeX,
      box.sizeY,
      box.sizeZ,
      box.collisionResponse ? 1 : 0,
      box.materialId
    ].join("|");
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${base}|${occurrence}`;
  });
}

export function greedyBoxLayoutsEqual(
  left: readonly GreedyBox[],
  right: readonly GreedyBox[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftBox = left[index]!;
    const rightBox = right[index]!;
    if (
      leftBox.collisionResponse !== rightBox.collisionResponse
      || leftBox.materialId !== rightBox.materialId
      || leftBox.minX !== rightBox.minX
      || leftBox.minY !== rightBox.minY
      || leftBox.minZ !== rightBox.minZ
      || leftBox.sizeX !== rightBox.sizeX
      || leftBox.sizeY !== rightBox.sizeY
      || leftBox.sizeZ !== rightBox.sizeZ
    ) return false;
  }
  return true;
}
