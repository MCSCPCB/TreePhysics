import type { PhysicsContraptionBlock, PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import { MAX_PHYSICS_CONTRAPTION_BLOCKS } from "@src/physics/core/Types";
import { isContraptionFoliageTint } from "@src/render/foliage/TintCodec";
import { blockKey, LOCAL_BLOCK_COORDINATE_LIMIT } from "@src/utils/BlockKey";
import { isFiniteVector, isIntegerVector } from "@src/utils/Vector3Math";

const SAFE_TYPE_ID_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const DEFAULT_LEAF_MASS = 0.0625;
const DEFAULT_LOG_MASS = 1;
const DEFAULT_OTHER_BLOCK_MASS = 0.25;

export function normalizeContraptionBlocks(blocks: readonly PhysicsContraptionBlock[]): PhysicsContraptionBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new RangeError("PhysicsContraptionOptions.blocks must not be empty.");
  }
  if (blocks.length > MAX_PHYSICS_CONTRAPTION_BLOCKS) {
    throw new RangeError(`Physics assemblies support at most ${MAX_PHYSICS_CONTRAPTION_BLOCKS} blocks.`);
  }
  const occupied = new Set<string>();
  return blocks.map((block, index) => {
    if (!block || !isFiniteVector(block.localLocation) || !isIntegerVector(block.localLocation)) {
      throw new TypeError(`Contraption block ${index} must use a finite integer localLocation.`);
    }
    if (block.rotation && !isFiniteVector(block.rotation)) {
      throw new TypeError(`Contraption block ${index} must use a finite rotation.`);
    }
    if (Math.max(Math.abs(block.localLocation.x), Math.abs(block.localLocation.y), Math.abs(block.localLocation.z)) > LOCAL_BLOCK_COORDINATE_LIMIT) {
      throw new RangeError(`Contraption block ${index} exceeds the visual offset range.`);
    }
    if (!isSafeTypeId(block.typeId)) throw new TypeError(`Contraption block ${index} has an invalid typeId.`);
    const key = blockKey(block.localLocation);
    if (occupied.has(key)) throw new RangeError(`Contraption block location ${key} is duplicated.`);
    occupied.add(key);
    return {
      ...block,
      itemTypeId: block.itemTypeId && isSafeTypeId(block.itemTypeId) ? block.itemTypeId : block.typeId,
      collisionShape: normalizeContraptionBlockCollisionShape(block, index),
      localLocation: { ...block.localLocation },
      mass: normalizeBlockMass(block),
      rotation: block.rotation ? { ...block.rotation } : undefined,
      visual: block.visual ? { ...block.visual } : undefined
    };
  });
}

export function normalizeContraptionFoliageTint(value: PhysicsContraptionFoliageTint | undefined): PhysicsContraptionFoliageTint | undefined {
  if (value === undefined) return undefined;
  if (!isContraptionFoliageTint(value)) throw new TypeError("PhysicsContraptionOptions.foliageTint is invalid.");
  return { ...value };
}

export function normalizeVisualEntityTags(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(tag => typeof tag !== "string" || tag.length === 0 || tag.length > 255 || /[\r\n]/.test(tag))) {
    throw new TypeError("PhysicsContraptionOptions.visualEntityTags is invalid.");
  }
  return [...new Set(value)];
}

function normalizeContraptionBlockCollisionShape(block: PhysicsContraptionBlock, index: number): PhysicsContraptionBlock["collisionShape"] {
  const shape = block.collisionShape;
  if (shape === undefined || shape === "full" || shape === "none") return shape;
  if (!Array.isArray(shape) || shape.length === 0) throw new TypeError(`Contraption block ${index} collisionShape must contain at least one box.`);
  return shape.map((box, boxIndex) => {
    if (!box || !isFiniteVector(box.min) || !isFiniteVector(box.max)
      || box.min.x < 0 || box.min.y < 0 || box.min.z < 0
      || box.max.x > 1 || box.max.y > 1 || box.max.z > 1
      || box.min.x >= box.max.x || box.min.y >= box.max.y || box.min.z >= box.max.z) {
      throw new RangeError(`Contraption block ${index} collisionShape box ${boxIndex} must be a positive box within one block.`);
    }
    return { min: { ...box.min }, max: { ...box.max } };
  });
}

function getContraptionBlockCollisionShape(block: PhysicsContraptionBlock): "full" | "none" | readonly import("@src/physics/core/Types").PhysicsBlockCollisionBox[] {
  if (block.collidable === false || block.collisionShape === "none") return "none";
  return block.collisionShape ?? "full";
}

export function isContraptionBlockCollidable(block: PhysicsContraptionBlock): boolean {
  return getContraptionBlockCollisionShape(block) !== "none";
}

/** Whether a block stops interaction rays: passable foliage lets them through. */
export function isContraptionBlockRaySolid(block: PhysicsContraptionBlock): boolean {
  return block.collisionResponse !== false && isContraptionBlockCollidable(block);
}

function isSafeTypeId(value: string): boolean {
  return SAFE_TYPE_ID_PATTERN.test(value);
}

function normalizeBlockMass(block: PhysicsContraptionBlock): number {
  const mass = block.mass;
  if (Number.isFinite(mass) && mass! > 0) return mass!;
  const name = block.typeId.slice(block.typeId.indexOf(":") + 1);
  if (name.endsWith("_leaves") || name === "leaves" || name === "leaves2") return DEFAULT_LEAF_MASS;
  if (name.endsWith("_log") || name.endsWith("_wood") || name.endsWith("_stem") || name.endsWith("_hyphae")) {
    return DEFAULT_LOG_MASS;
  }
  return DEFAULT_OTHER_BLOCK_MASS;
}
