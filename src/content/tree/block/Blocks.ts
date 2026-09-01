import type { Block, BlockPermutation, Vector3 } from "@minecraft/server";

export const NATURAL_TREE_ROOT_ID = "treephysics:natural_tree_root";
export const SOIL_VARIANT_STATE = "treephysics:soil_variant";
export const NATURAL_ROOT_SOIL_TYPE_IDS = [
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:mud",
  "minecraft:dirt_with_roots",
  "minecraft:podzol",
  "minecraft:sand",
  "minecraft:gravel",
  "minecraft:netherrack",
  "minecraft:end_stone",
  "minecraft:bedrock"
] as const;

const ATTACHMENT_TYPE_IDS = new Set([
  "minecraft:bee_nest",
  "minecraft:cocoa",
  "minecraft:hanging_roots",
  "minecraft:mangrove_propagule",
  "minecraft:pale_hanging_moss",
  "minecraft:vine"
]);

const COLLIDING_ATTACHMENT_TYPE_IDS = new Set([
  "minecraft:bee_nest"
]);

const FRAGILE_PLANT_ATTACHMENT_TYPE_IDS = new Set([
  "minecraft:hanging_roots",
  "minecraft:mangrove_propagule",
  "minecraft:pale_hanging_moss",
  "minecraft:vine"
]);

// Performance detachment currently targets exactly the fragile plant set.
// Give the concept its own literal again if the two ever diverge.
const PERFORMANCE_DETACHABLE_ATTACHMENT_TYPE_IDS = FRAGILE_PLANT_ATTACHMENT_TYPE_IDS;

const LEGACY_LOG_ITEMS: Readonly<Record<string, string>> = {
  acacia: "minecraft:acacia_log",
  birch: "minecraft:birch_log",
  dark_oak: "minecraft:dark_oak_log",
  jungle: "minecraft:jungle_log",
  oak: "minecraft:oak_log",
  spruce: "minecraft:spruce_log"
};

const LEGACY_LEAF_ITEMS: Readonly<Record<string, string>> = {
  acacia: "minecraft:acacia_leaves",
  birch: "minecraft:birch_leaves",
  dark_oak: "minecraft:dark_oak_leaves",
  jungle: "minecraft:jungle_leaves",
  oak: "minecraft:oak_leaves",
  spruce: "minecraft:spruce_leaves"
};

export type BlockStates = Readonly<Record<string, boolean | number | string>>;
/** Tree blocks plus the small set of ordinary blocks retained by Stage 2. */
export type TreeBlockKind = "attachment" | "block" | "leaf" | "log" | "root";

export interface TreeBlockMapColor {
  blue: number;
  green: number;
  red: number;
}

export interface CapturedTreeBlock {
  kind: TreeBlockKind;
  location: Vector3;
  mapColor?: TreeBlockMapColor;
  states: BlockStates;
  typeId: string;
}

export function captureTreeBlock(block: Block): CapturedTreeBlock | undefined {
  const captured = capturePermutation(block.permutation, block.location);
  if (
    !captured
    || isVanillaTypeId(captured.typeId)
    || (captured.kind !== "log" && captured.kind !== "leaf")
  ) return captured;

  const component = block.getComponent("minecraft:map_color");
  if (!component) return captured;
  const { blue, green, red } = component.tintedColor;
  assertMapColorChannel(red, "red", captured.typeId);
  assertMapColorChannel(green, "green", captured.typeId);
  assertMapColorChannel(blue, "blue", captured.typeId);
  return { ...captured, mapColor: { blue, green, red } };
}

function capturePermutation(
  permutation: BlockPermutation,
  location: Vector3
): CapturedTreeBlock | undefined {
  const typeId = permutation.type.id;
  const states = permutation.getAllStates();
  const kind = treeBlockKind(typeId);
  if (!kind) return undefined;
  return {
    kind,
    location: { x: location.x, y: location.y, z: location.z },
    states,
    typeId
  };
}

// Classification is a pure function of the type id, and the id set a world
// can produce is small and stable. Memoizing removes the repeated substring
// and suffix scans from topology BFS loops and per-tick sensor predicates.
const TREE_BLOCK_KIND_CACHE = new Map<string, TreeBlockKind | undefined>();

export function treeBlockKind(typeId: string): TreeBlockKind | undefined {
  if (TREE_BLOCK_KIND_CACHE.has(typeId)) return TREE_BLOCK_KIND_CACHE.get(typeId);
  let kind: TreeBlockKind | undefined;
  if (typeId === NATURAL_TREE_ROOT_ID || isMangroveRoot(typeId)) kind = "root";
  else if (isTreeLog(typeId)) kind = "log";
  else if (isTreeLeaf(typeId)) kind = "leaf";
  else if (isTreeAttachment(typeId)) kind = "attachment";
  TREE_BLOCK_KIND_CACHE.set(typeId, kind);
  return kind;
}

export function isSupportedOrdinaryContraptionBlock(typeId: string): boolean {
  return typeId === "minecraft:chest";
}

/** Resolve the blocks accepted by the shared player-edit mining transaction. */
export function playerEditableContraptionBlockKind(
  typeId: string
): Exclude<TreeBlockKind, "root"> | undefined {
  const kind = treeBlockKind(typeId);
  if (kind === "log" || kind === "leaf" || kind === "attachment") return kind;
  return isSupportedOrdinaryContraptionBlock(typeId) ? "block" : undefined;
}

export function isTreeStructuralBlock(typeId: string): boolean {
  return treeBlockKind(typeId) !== undefined;
}

const TREE_LOG_CACHE = new Map<string, boolean>();
const TREE_LEAF_CACHE = new Map<string, boolean>();

export function isTreeLog(typeId: string): boolean {
  const cached = TREE_LOG_CACHE.get(typeId);
  if (cached !== undefined) return cached;
  const name = pathName(typeId);
  const result = name === "creaking_heart"
    || name === "log"
    || name === "log2"
    || name.endsWith("_log")
    || name.endsWith("_wood");
  TREE_LOG_CACHE.set(typeId, result);
  return result;
}

export function isTreeLeaf(typeId: string): boolean {
  const cached = TREE_LEAF_CACHE.get(typeId);
  if (cached !== undefined) return cached;
  const name = pathName(typeId);
  const result = name === "leaves"
    || name === "leaves2"
    || name.endsWith("_leaves")
    || name === "azalea_leaves_flowered";
  TREE_LEAF_CACHE.set(typeId, result);
  return result;
}

function isTreeAttachment(typeId: string): boolean {
  return ATTACHMENT_TYPE_IDS.has(typeId);
}

export function isCollidingTreeAttachment(typeId: string): boolean {
  return COLLIDING_ATTACHMENT_TYPE_IDS.has(typeId);
}

export function isFragilePlantTreeAttachment(typeId: string): boolean {
  return FRAGILE_PLANT_ATTACHMENT_TYPE_IDS.has(typeId);
}

export function isStrippedTreeLog(typeId: string): boolean {
  return pathName(typeId).startsWith("stripped_");
}

export function isPerformanceDetachableTreeAttachment(block: CapturedTreeBlock): boolean {
  if (!PERFORMANCE_DETACHABLE_ATTACHMENT_TYPE_IDS.has(block.typeId)) return false;
  return block.typeId !== "minecraft:mangrove_propagule"
    || block.states.hanging === true
    || block.states.hanging === 1;
}

export function isMangroveRoot(typeId: string): boolean {
  return typeId === "minecraft:mangrove_roots" || typeId === "minecraft:muddy_mangrove_roots";
}

// Only the legacy multi-variant blocks derive their family from block states;
// every modern id maps to a fixed family, so that branch can be memoized.
const LOG_FAMILY_BY_TYPE_ID = new Map<string, string>();

export function logFamily(block: CapturedTreeBlock): string {
  if (block.typeId === "minecraft:creaking_heart") return "pale_oak";
  if (block.typeId === "minecraft:log") {
    return String(block.states.old_log_type ?? "oak");
  }
  if (block.typeId === "minecraft:log2") {
    return String(block.states.new_log_type ?? "acacia");
  }
  const cached = LOG_FAMILY_BY_TYPE_ID.get(block.typeId);
  if (cached !== undefined) return cached;
  const family = pathName(block.typeId)
    .replace(/^stripped_/, "")
    .replace(/_(log|wood)$/, "");
  LOG_FAMILY_BY_TYPE_ID.set(block.typeId, family);
  return family;
}

export function leafFamily(block: CapturedTreeBlock): string {
  if (block.typeId === "minecraft:leaves") {
    return String(block.states.old_leaf_type ?? "oak");
  }
  if (block.typeId === "minecraft:leaves2") {
    return String(block.states.new_leaf_type ?? "acacia");
  }
  const name = pathName(block.typeId);
  if (name === "azalea_leaves_flowered") return "azalea";
  return name.replace(/_leaves$/, "");
}

export function isPersistentLeaf(block: CapturedTreeBlock): boolean {
  return block.kind === "leaf"
    && (block.states.persistent_bit === true || block.states.persistent_bit === 1);
}

export function isVanillaTypeId(typeId: string): boolean {
  return typeId.startsWith("minecraft:") || typeId.startsWith("treephysics:");
}

export function visualItemTypeId(block: CapturedTreeBlock): string {
  if (block.typeId === "minecraft:log" || block.typeId === "minecraft:log2") {
    return LEGACY_LOG_ITEMS[logFamily(block)] ?? block.typeId;
  }
  if (block.typeId === "minecraft:leaves" || block.typeId === "minecraft:leaves2") {
    return LEGACY_LEAF_ITEMS[leafFamily(block)] ?? block.typeId;
  }
  return block.typeId;
}

export function visualBlockRotation(block: CapturedTreeBlock): Vector3 | undefined {
  const axis = block.states.pillar_axis ?? block.states["minecraft:pillar_axis"];
  if (axis === "x") return { x: 0, y: 0, z: 90 };
  if (axis === "z") return { x: 90, y: 0, z: 0 };
  const blockFace = block.states["minecraft:block_face"] ?? block.states.block_face;
  if (blockFace === "east" || blockFace === "west") return { x: 0, y: 0, z: 90 };
  if (blockFace === "north" || blockFace === "south") return { x: 90, y: 0, z: 0 };
  return undefined;
}

function pathName(typeId: string): string {
  const separator = typeId.indexOf(":");
  return separator >= 0 ? typeId.slice(separator + 1) : typeId;
}

function assertMapColorChannel(value: number, channel: string, typeId: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`Invalid ${channel} map-color channel for ${typeId}: ${value}.`);
  }
}
