// Read adapter over the two block-collision sources (live Block vs. captured
// ContraptionBlockRecord): permutation state/tag probes, neighbor lookup, type
// name helpers, and the custom-block passability ray cache.
import type { Block, Dimension } from "@minecraft/server";
import { safeGetBlock } from "@src/utils/WorldBlock";

interface ContraptionBlockRecord {
  readonly blockTypeId: string;
  readonly dimension?: Dimension;
  readonly location?: { readonly x: number; readonly y: number; readonly z: number };
  readonly permutation: {
    getAllStates?(): Record<string, boolean | number | string>;
    getState(name: string): boolean | number | string | undefined;
    getTags?(): string[];
    hasTag(tag: string): boolean;
  };
}

type BlockCollisionShapeSource = Block | ContraptionBlockRecord;

const MAX_CUSTOM_PASSABILITY_CACHE_ENTRIES = 4096;
const CUSTOM_PASSABILITY_RAY_DIRECTION = { x: 0, y: 1, z: 0 } as const;
const customPassabilityByPermutation = new Map<string, boolean>();

function getPermutationState(block: BlockCollisionShapeSource, stateName: string): boolean | number | string | undefined {
  if (!isLiveBlock(block)) {
    return block.permutation.getState(stateName);
  }
  try {
    return block.permutation.getState(stateName as never);
  } catch {
    return undefined;
  }
}

function getNumberState(block: BlockCollisionShapeSource, stateName: string, defaultValue: number): number {
  const value = getPermutationState(block, stateName);
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function getFirstNumberState(
  block: BlockCollisionShapeSource,
  stateNames: readonly string[],
  defaultValue: number
): number {
  for (const stateName of stateNames) {
    const value = getPermutationState(block, stateName);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return defaultValue;
}

function getRelativeBlock(
  block: BlockCollisionShapeSource,
  x: number,
  y: number,
  z: number
): Block | undefined {
  if (!isLiveBlock(block)) {
    return undefined;
  }

  const dimension: Dimension | undefined = block.dimension;
  const location = block.location;
  if (!dimension || !location) {
    return undefined;
  }

  return safeGetBlock(dimension, {
      x: location.x + x,
      y: location.y + y,
      z: location.z + z
    });
}

function getBlockTypeName(block: BlockCollisionShapeSource): string {
  const typeId = getBlockTypeId(block);
  return typeId.split(":")[1] ?? typeId;
}

function getBlockTypeId(block: BlockCollisionShapeSource): string {
  return isLiveBlock(block) ? block.typeId : block.blockTypeId;
}

function getBlockNamespace(block: BlockCollisionShapeSource): string {
  const typeId = getBlockTypeId(block);
  const separatorIndex = typeId.indexOf(":");
  return separatorIndex >= 0 ? typeId.slice(0, separatorIndex) : "minecraft";
}

function isLiveBlock(block: BlockCollisionShapeSource): block is Block {
  return "typeId" in block;
}

function isEmptyLiveBlock(block: BlockCollisionShapeSource): boolean {
  return isLiveBlock(block) && (block.isAir || block.isLiquid);
}

/**
 * Uses Bedrock's stable passable-ray filter for unknown live addon blocks.
 * The result is permutation-specific because block states may switch an
 * addon's collision component between false and a solid shape.
 */
function isLiveCustomBlockPassable(block: BlockCollisionShapeSource): boolean {
  if (!isLiveBlock(block) || getBlockNamespace(block) === "minecraft") return false;

  const cacheKey = customPassabilityCacheKey(block);
  const cached = customPassabilityByPermutation.get(cacheKey);
  if (cached !== undefined) return cached;

  const hit = block.dimension.getBlockFromRay(
    block.location,
    CUSTOM_PASSABILITY_RAY_DIRECTION,
    {
      includeLiquidBlocks: false,
      includePassableBlocks: false,
      includePermutations: [block.permutation],
      maxDistance: 1
    }
  );
  const passable = hit?.block === undefined || !sameBlockLocation(hit.block, block);
  cacheCustomPassability(cacheKey, passable);
  return passable;
}

function customPassabilityCacheKey(block: Block): string {
  const states = Object.entries(block.permutation.getAllStates())
    .sort(([left], [right]) => left.localeCompare(right));
  return `${block.typeId}:${JSON.stringify(states)}`;
}

function cacheCustomPassability(key: string, passable: boolean): void {
  if (customPassabilityByPermutation.size >= MAX_CUSTOM_PASSABILITY_CACHE_ENTRIES) {
    const oldest = customPassabilityByPermutation.keys().next().value;
    if (oldest !== undefined) customPassabilityByPermutation.delete(oldest);
  }
  customPassabilityByPermutation.set(key, passable);
}

function sameBlockLocation(left: Block, right: Block): boolean {
  return left.dimension.id === right.dimension.id
    && left.location.x === right.location.x
    && left.location.y === right.location.y
    && left.location.z === right.location.z;
}

function hasBlockTag(block: BlockCollisionShapeSource, tag: string): boolean {
  if (!isLiveBlock(block)) {
    return block.permutation.hasTag(tag);
  }
  try {
    return block.hasTag(tag);
  } catch {
    return false;
  }
}

function hasSemanticBlockTag(block: BlockCollisionShapeSource, semanticName: string): boolean {
  const expected = normalizedSemanticName(semanticName);
  try {
    const tags = isLiveBlock(block)
      ? block.permutation.getTags()
      : block.permutation.getTags?.() ?? [];
    return tags.some(tag => normalizedSemanticName(tag) === expected);
  } catch {
    return false;
  }
}

function normalizedSemanticName(value: string): string {
  const separator = value.lastIndexOf(":");
  const localName = separator >= 0 ? value.slice(separator + 1) : value;
  return localName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getSemanticBooleanState(
  block: BlockCollisionShapeSource,
  semanticName: string
): boolean | undefined {
  for (const [name, value] of Object.entries(getAllPermutationStates(block))) {
    if (normalizedSemanticName(name) !== normalizedSemanticName(semanticName)) continue;
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return Boolean(value);
  }
  return undefined;
}

function getAllPermutationStates(
  block: BlockCollisionShapeSource
): Readonly<Record<string, boolean | number | string>> {
  try {
    return block.permutation.getAllStates?.() ?? {};
  } catch {
    return {};
  }
}

export {
  getBlockNamespace,
  getBlockTypeName,
  getFirstNumberState,
  getNumberState,
  getPermutationState,
  getRelativeBlock,
  getSemanticBooleanState,
  hasBlockTag,
  hasSemanticBlockTag,
  isEmptyLiveBlock,
  isLiveCustomBlockPassable
};
export type { BlockCollisionShapeSource };
