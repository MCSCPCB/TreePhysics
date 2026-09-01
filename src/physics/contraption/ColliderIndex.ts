import type { Vector3 } from "@minecraft/server";
import { blockKey, parseBlockKey } from "@src/utils/BlockKey";
import { meshVoxels, type VoxelBox } from "@src/physics/contraption/Mesher";
import type {
  PhysicsContraptionBlock,
  PhysicsBlockCollisionBox,
  PhysicsBodyCollider
} from "@src/physics/core/Types";

type CompoundCollider = Extract<PhysicsBodyCollider, { type: "compound" }>;
type CompoundChild = CompoundCollider["children"][number];

/**
 * Maintains the contraption collider incrementally. Full voxels and the explicit
 * chest partial-shape group are meshed into boxes; unsupported partial shapes
 * retain their existing block cover.
 */
export class ContraptionColliderIndex {
  #cachedCollider?: CompoundCollider;
  readonly #partialChildrenByKey = new Map<string, readonly CompoundChild[]>();
  readonly #mergeablePartialMeshes = new Map<string, MergeablePartialMesh>();
  readonly #respondingVoxels: IncrementalVoxelMesh;
  readonly #sensorVoxels: IncrementalVoxelMesh;

  constructor(blocks: readonly PhysicsContraptionBlock[]) {
    this.#respondingVoxels = new IncrementalVoxelMesh(fullVoxelLocations(blocks, true));
    this.#sensorVoxels = new IncrementalVoxelMesh(fullVoxelLocations(blocks, false));
    for (const block of blocks) {
      const shape = getContraptionBlockCollisionShape(block);
      if (shape === "full" || shape === "none") continue;
      const mergeable = getMergeablePartialShape(block, shape);
      if (mergeable) {
        this.#addMergeablePartialBlock(block, mergeable);
        continue;
      }
      this.#partialChildrenByKey.set(
        blockKey(block.localLocation),
        createPartialColliderChildren(block, shape)
      );
    }
  }

  get collider(): CompoundCollider {
    if (this.#cachedCollider) return this.#cachedCollider;
    const children: CompoundChild[] = [];
    children.push(...createVoxelColliderChildren(this.#respondingVoxels.boxes, true));
    children.push(...createVoxelColliderChildren(this.#sensorVoxels.boxes, false));
    for (const group of this.#mergeablePartialMeshes.values()) {
      children.push(...createMergedPartialColliderChildren(
        group.mesh.boxes,
        group.shape,
        group.collisionResponse
      ));
    }
    for (const partial of this.#partialChildrenByKey.values()) children.push(...partial);
    if (children.length === 0) throw new RangeError("Physics contraption has no collidable blocks.");
    this.#cachedCollider = { children, type: "compound" };
    return this.#cachedCollider;
  }

  removeBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    const responding: Vector3[] = [];
    const sensors: Vector3[] = [];
    let changed = false;
    for (const block of blocks) {
      const shape = getContraptionBlockCollisionShape(block);
      if (shape === "full") {
        ((block.collisionResponse !== false) ? responding : sensors).push(block.localLocation);
      } else if (shape !== "none") {
        const mergeable = getMergeablePartialShape(block, shape);
        if (mergeable) {
          const key = mergeablePartialKey(block, mergeable);
          const group = this.#mergeablePartialMeshes.get(key);
          if (group?.mesh.remove([block.localLocation])) {
            changed = true;
            if (group.mesh.locationCount === 0) this.#mergeablePartialMeshes.delete(key);
          }
        } else {
          changed = this.#partialChildrenByKey.delete(blockKey(block.localLocation)) || changed;
        }
      }
    }
    changed = this.#respondingVoxels.remove(responding) || changed;
    changed = this.#sensorVoxels.remove(sensors) || changed;
    if (changed) this.#cachedCollider = undefined;
  }

  addBlocks(blocks: readonly PhysicsContraptionBlock[]): void {
    let changed = false;
    const responding: Vector3[] = [];
    const sensors: Vector3[] = [];
    for (const block of blocks) {
      const shape = getContraptionBlockCollisionShape(block);
      if (shape === "full") {
        ((block.collisionResponse !== false) ? responding : sensors).push(block.localLocation);
      } else if (shape !== "none") {
        const mergeable = getMergeablePartialShape(block, shape);
        if (mergeable) {
          this.#addMergeablePartialBlock(block, mergeable);
          changed = true;
        } else {
          this.#partialChildrenByKey.set(
            blockKey(block.localLocation),
            createPartialColliderChildren(block, shape)
          );
          changed = true;
        }
      }
    }
    changed = this.#respondingVoxels.add(responding) || changed;
    changed = this.#sensorVoxels.add(sensors) || changed;
    if (changed) this.#cachedCollider = undefined;
  }

  #addMergeablePartialBlock(
    block: PhysicsContraptionBlock,
    shape: PhysicsBlockCollisionBox
  ): void {
    const key = mergeablePartialKey(block, shape);
    const group = this.#mergeablePartialMeshes.get(key);
    if (group) {
      group.mesh.add([block.localLocation]);
      return;
    }
    this.#mergeablePartialMeshes.set(key, {
      collisionResponse: block.collisionResponse !== false,
      mesh: new IncrementalVoxelMesh([block.localLocation]),
      shape: { min: { ...shape.min }, max: { ...shape.max } }
    });
  }
}
interface MergeablePartialMesh {
  readonly collisionResponse: boolean;
  readonly mesh: IncrementalVoxelMesh;
  readonly shape: PhysicsBlockCollisionBox;
}

class IncrementalVoxelMesh {
  readonly #locations = new Set<string>();
  readonly #boxByVoxelKey = new Map<string, VoxelBox>();
  #boxes: VoxelBox[];
  #indexed = false;

  constructor(locations: readonly Vector3[]) {
    for (const location of locations) this.#locations.add(blockKey(location));
    this.#boxes = meshVoxels(locations);
  }

  get boxes(): readonly VoxelBox[] {
    return this.#boxes;
  }

  get locationCount(): number {
    return this.#locations.size;
  }

  remove(locations: readonly Vector3[]): boolean {
    if (locations.length === 0 || this.#boxes.length === 0) return false;
    const removedKeys = new Set(locations.map(blockKey));
    let changed = false;
    for (const key of removedKeys) changed = this.#locations.delete(key) || changed;
    if (!changed) return false;
    if (!this.#indexed) {
      for (const box of this.#boxes) this.indexBox(box);
      this.#indexed = true;
    }
    const affected = new Set<VoxelBox>();
    for (const key of removedKeys) {
      const box = this.#boxByVoxelKey.get(key);
      if (box) affected.add(box);
    }
    if (affected.size === 0) return false;
    const untouched = this.#boxes.filter(box => !affected.has(box));
    const affectedRemaining: Vector3[] = [];
    for (const box of affected) {
      forEachVoxel(box, location => {
        this.#boxByVoxelKey.delete(blockKey(location));
        if (!removedKeys.has(blockKey(location))) affectedRemaining.push(location);
      });
    }
    const replacements = meshVoxels(affectedRemaining);
    for (const box of replacements) this.indexBox(box);
    this.#boxes = [...untouched, ...replacements];
    return true;
  }

  add(locations: readonly Vector3[]): boolean {
    let changed = false;
    for (const location of locations) {
      const key = blockKey(location);
      if (this.#locations.has(key)) continue;
      this.#locations.add(key);
      changed = true;
    }
    if (!changed) return false;
    this.#boxes = meshVoxels([...this.#locations].map(parseBlockKey));
    this.#boxByVoxelKey.clear();
    this.#indexed = false;
    return true;
  }

  private indexBox(box: VoxelBox): void {
    forEachVoxel(box, location => this.#boxByVoxelKey.set(blockKey(location), box));
  }
}

function fullVoxelLocations(
  blocks: readonly PhysicsContraptionBlock[],
  collisionResponse: boolean
): Vector3[] {
  return blocks
    .filter(block => (
      getContraptionBlockCollisionShape(block) === "full"
      && (block.collisionResponse !== false) === collisionResponse
    ))
    .map(block => block.localLocation);
}

function createVoxelColliderChildren(
  boxes: readonly VoxelBox[],
  collisionResponse: boolean
): CompoundChild[] {
  return boxes.map(box => ({
    collider: { size: box.size, type: "box" as const },
    collisionResponse,
    location: {
      x: box.min.x + (box.size.x - 1) / 2,
      y: box.min.y - 0.5,
      z: box.min.z + (box.size.z - 1) / 2
    }
  }));
}

function createPartialColliderChildren(
  block: PhysicsContraptionBlock,
  shape: readonly PhysicsBlockCollisionBox[]
): CompoundChild[] {
  return shape.map(box => ({
    collider: {
      size: {
        x: box.max.x - box.min.x,
        y: box.max.y - box.min.y,
        z: box.max.z - box.min.z
      },
      type: "box" as const
    },
    collisionResponse: block.collisionResponse !== false,
    location: {
      x: block.localLocation.x + (box.min.x + box.max.x - 1) / 2,
      y: block.localLocation.y + box.min.y - 0.5,
      z: block.localLocation.z + (box.min.z + box.max.z - 1) / 2
    }
  }));
}

/**
 * Merge the repeated inset chest body while retaining the outer inset. The
 * internal 1/8-block seams are not exposed to a player and do not need their
 * own Cannon shapes.
 */
function createMergedPartialColliderChildren(
  boxes: readonly VoxelBox[],
  shape: PhysicsBlockCollisionBox,
  collisionResponse: boolean
): CompoundChild[] {
  const width = shape.max.x - shape.min.x;
  const height = shape.max.y - shape.min.y;
  const depth = shape.max.z - shape.min.z;
  return boxes.map(box => ({
    collider: {
      size: {
        x: width + box.size.x - 1,
        y: height + box.size.y - 1,
        z: depth + box.size.z - 1
      },
      type: "box" as const
    },
    collisionResponse,
    location: {
      x: box.min.x + (box.size.x - 1) / 2 + (shape.min.x + shape.max.x - 1) / 2,
      y: box.min.y + shape.min.y - 0.5,
      z: box.min.z + (box.size.z - 1) / 2 + (shape.min.z + shape.max.z - 1) / 2
    }
  }));
}

function getMergeablePartialShape(
  block: PhysicsContraptionBlock,
  shape: readonly PhysicsBlockCollisionBox[]
): PhysicsBlockCollisionBox | undefined {
  // Stage 2 currently supports only the ordinary, closed chest. Keep the
  // merge rule explicit so future partial blocks do not silently change their
  // collision semantics.
  if (block.typeId !== "minecraft:chest" || shape.length !== 1) return undefined;
  const candidate = shape[0]!;
  if (
    candidate.min.x !== 1 / 16
    || candidate.min.y !== 0
    || candidate.min.z !== 1 / 16
    || candidate.max.x !== 15 / 16
    || candidate.max.y !== 14 / 16
    || candidate.max.z !== 15 / 16
  ) return undefined;
  return candidate;
}

function mergeablePartialKey(
  block: PhysicsContraptionBlock,
  shape: PhysicsBlockCollisionBox
): string {
  return `${block.typeId}:${block.collisionResponse !== false ? "response" : "sensor"}:${shape.min.x},${shape.min.y},${shape.min.z},${shape.max.x},${shape.max.y},${shape.max.z}`;
}

function getContraptionBlockCollisionShape(
  block: PhysicsContraptionBlock
): "full" | "none" | readonly PhysicsBlockCollisionBox[] {
  if (block.collidable === false || block.collisionShape === "none") return "none";
  return block.collisionShape ?? "full";
}

function forEachVoxel(box: VoxelBox, callback: (location: Vector3) => void): void {
  for (let y = 0; y < box.size.y; y++) {
    for (let z = 0; z < box.size.z; z++) {
      for (let x = 0; x < box.size.x; x++) {
        callback({ x: box.min.x + x, y: box.min.y + y, z: box.min.z + z });
      }
    }
  }
}
