import type { PhysicsContraptionBlockVisual } from "@src/physics/core/Types";
import {
  leafFamily,
  logFamily,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";

export const TREE_FRAGMENT_FAMILIES = [
  "oak",
  "spruce",
  "birch",
  "jungle",
  "acacia",
  "dark_oak",
  "cherry",
  "mangrove",
  "pale_oak",
  "azalea",
  "flowering_azalea"
] as const;

export const TREE_ATTACHMENT_FRAGMENT_FAMILIES = [
  "bee_nest",
  "cocoa",
  "hanging_roots",
  "mangrove_propagule",
  "pale_hanging_moss",
  "vine",
  "mangrove_roots",
  "muddy_mangrove_roots",
  "creaking_heart"
] as const;

const TREE_LOG_FRAGMENT_TYPE_IDS = [
  "minecraft:log",
  "minecraft:log2",
  "minecraft:oak_log",
  "minecraft:spruce_log",
  "minecraft:birch_log",
  "minecraft:jungle_log",
  "minecraft:acacia_log",
  "minecraft:dark_oak_log",
  "minecraft:cherry_log",
  "minecraft:mangrove_log",
  "minecraft:pale_oak_log",
  "minecraft:stripped_oak_log",
  "minecraft:stripped_spruce_log",
  "minecraft:stripped_birch_log",
  "minecraft:stripped_jungle_log",
  "minecraft:stripped_acacia_log",
  "minecraft:stripped_dark_oak_log",
  "minecraft:stripped_cherry_log",
  "minecraft:stripped_mangrove_log",
  "minecraft:stripped_pale_oak_log",
  "minecraft:oak_wood",
  "minecraft:spruce_wood",
  "minecraft:birch_wood",
  "minecraft:jungle_wood",
  "minecraft:acacia_wood",
  "minecraft:dark_oak_wood",
  "minecraft:cherry_wood",
  "minecraft:mangrove_wood",
  "minecraft:pale_oak_wood",
  "minecraft:stripped_oak_wood",
  "minecraft:stripped_spruce_wood",
  "minecraft:stripped_birch_wood",
  "minecraft:stripped_jungle_wood",
  "minecraft:stripped_acacia_wood",
  "minecraft:stripped_dark_oak_wood",
  "minecraft:stripped_cherry_wood",
  "minecraft:stripped_mangrove_wood",
  "minecraft:stripped_pale_oak_wood"
] as const;

const TREE_LEAF_FRAGMENT_TYPE_IDS = [
  "minecraft:leaves",
  "minecraft:leaves2",
  "minecraft:oak_leaves",
  "minecraft:spruce_leaves",
  "minecraft:birch_leaves",
  "minecraft:jungle_leaves",
  "minecraft:acacia_leaves",
  "minecraft:dark_oak_leaves",
  "minecraft:cherry_leaves",
  "minecraft:mangrove_leaves",
  "minecraft:pale_oak_leaves",
  "minecraft:azalea_leaves",
  "minecraft:azalea_leaves_flowered",
  "minecraft:flowering_azalea_leaves"
] as const;

// One shared 3-bit log slot state scheme is produced by encodeLogAxis and read
// back by the fragment packer (isSupportedVisual) and the runtime renderer
// (logFragmentModes): 0 marks an empty slot, the pillar axis maps to
// y=2 / x=3 / z=4, and stripped logs add 3 (states 5-7).
const TREE_LOG_STATE_AXIS_Y = 2;
const TREE_LOG_STATE_AXIS_X = 3;
const TREE_LOG_STATE_AXIS_Z = 4;
const TREE_LOG_STRIPPED_STATE_OFFSET = 3;
export const TREE_LOG_NORMAL_STATE_MIN = TREE_LOG_STATE_AXIS_Y; // = 2
export const TREE_LOG_NORMAL_STATE_MAX = TREE_LOG_STATE_AXIS_Z; // = 4
export const TREE_LOG_STRIPPED_STATE_MIN =
  TREE_LOG_NORMAL_STATE_MIN + TREE_LOG_STRIPPED_STATE_OFFSET; // = 5
export const TREE_LOG_STATE_MAX =
  TREE_LOG_NORMAL_STATE_MAX + TREE_LOG_STRIPPED_STATE_OFFSET; // = 7

const TREE_FRAGMENT_FAMILY_INDEX = new Map<string, number>(
  TREE_FRAGMENT_FAMILIES.map((family, index) => [family, index])
);
const TREE_ATTACHMENT_FRAGMENT_FAMILY_INDEX = new Map<string, number>(
  TREE_ATTACHMENT_FRAGMENT_FAMILIES.map((family, index) => [family, index])
);
const TREE_LOG_FRAGMENT_TYPES = new Set<string>(TREE_LOG_FRAGMENT_TYPE_IDS);
const TREE_LEAF_FRAGMENT_TYPES = new Set<string>(TREE_LEAF_FRAGMENT_TYPE_IDS);

// Keep the visual quarter-turn encoding identical to the shared block
// rotation path: south=0, west=1, north=2, east=3.
const CHEST_QUARTER_TURN_BY_DIRECTION = { south: 0, west: 1, north: 2, east: 3 } as const;

// minecraft:pillar_axis -> model axis index; combined with the mode below as
// axis + mode * 3.
const CREAKING_HEART_AXIS_STATES = new Map<unknown, number>([
  ["y", 0],
  ["x", 1],
  ["z", 2]
]);
const CREAKING_HEART_MODE_STATES = new Map<unknown, number>([
  ["uprooted", 0],
  ["dormant", 1],
  ["awake", 2]
]);

export function createFragmentVisual(
  block: CapturedTreeBlock
): PhysicsContraptionBlockVisual | undefined {
  if (block.typeId === "minecraft:creaking_heart") {
    const state = encodeCreakingHeartState(block);
    return state === undefined ? undefined : attachmentVisual("creaking_heart", state);
  }
  if (block.kind === "log") {
    if (!TREE_LOG_FRAGMENT_TYPES.has(block.typeId)) return undefined;
    const family = TREE_FRAGMENT_FAMILY_INDEX.get(logFamily(block));
    if (family === undefined) return undefined;
    const state = encodeLogAxis(
      stateValue(block, "pillar_axis"),
      block.typeId.startsWith("minecraft:stripped_")
    );
    if (state === undefined) return undefined;
    return {
      allBark: block.typeId.endsWith("_wood"),
      family,
      renderer: "log_fragment",
      state
    };
  }
  if (block.kind === "leaf") {
    if (!TREE_LEAF_FRAGMENT_TYPES.has(block.typeId)) return undefined;
    const familyName = block.typeId === "minecraft:azalea_leaves_flowered"
      || block.typeId === "minecraft:flowering_azalea_leaves"
      ? "flowering_azalea"
      : normalizeLeafFamily(leafFamily(block));
    const family = TREE_FRAGMENT_FAMILY_INDEX.get(familyName);
    if (family === undefined) return undefined;
    return {
      family,
      renderer: "leaf_fragment",
      state: 1
    };
  }
  if (block.kind === "block" && block.typeId === "minecraft:chest") {
    const direction = stateValue(block, "cardinal_direction");
    const state = typeof direction === "string"
      ? CHEST_QUARTER_TURN_BY_DIRECTION[direction as "north" | "east" | "south" | "west"]
      : undefined;
    return state === undefined ? undefined : {
      family: 0,
      renderer: "cube_block_fragment",
      state
    };
  }
  switch (block.typeId) {
    case "minecraft:bee_nest": {
      const state = encodeBeeNestState(block);
      return state === undefined ? undefined : attachmentVisual("bee_nest", state);
    }
    case "minecraft:cocoa": {
      const state = encodeCocoaState(block);
      return state === undefined ? undefined : attachmentVisual("cocoa", state);
    }
    case "minecraft:hanging_roots":
      return attachmentVisual("hanging_roots", 0);
    case "minecraft:mangrove_propagule": {
      const state = encodePropaguleState(block);
      return state === undefined ? undefined : attachmentVisual("mangrove_propagule", state);
    }
    case "minecraft:pale_hanging_moss": {
      const state = encodePaleMossState(block);
      return state === undefined ? undefined : attachmentVisual("pale_hanging_moss", state);
    }
    case "minecraft:vine": {
      const state = encodeVineState(block);
      return state === undefined ? undefined : attachmentVisual("vine", state);
    }
    case "minecraft:mangrove_roots":
      return attachmentVisual("mangrove_roots", 0);
    case "minecraft:muddy_mangrove_roots":
      return attachmentVisual("muddy_mangrove_roots", 0);
    default:
      return undefined;
  }
}

function attachmentVisual(
  familyName: typeof TREE_ATTACHMENT_FRAGMENT_FAMILIES[number],
  state: number
): PhysicsContraptionBlockVisual {
  return {
    family: TREE_ATTACHMENT_FRAGMENT_FAMILY_INDEX.get(familyName)!,
    renderer: "attachment_fragment",
    state
  };
}

function normalizeLeafFamily(family: string): string {
  if (family === "azalea_flowered" || family === "flowering_azalea") {
    return "flowering_azalea";
  }
  return family;
}

function encodeLogAxis(
  value: boolean | number | string | undefined,
  stripped: boolean
): number | undefined {
  const offset = stripped ? TREE_LOG_STRIPPED_STATE_OFFSET : 0;
  if (value === "x") return TREE_LOG_STATE_AXIS_X + offset;
  if (value === "z") return TREE_LOG_STATE_AXIS_Z + offset;
  return value === "y" ? TREE_LOG_STATE_AXIS_Y + offset : undefined;
}

function encodeBeeNestState(block: CapturedTreeBlock): number | undefined {
  const direction = integerState(block, 0, 3, "direction");
  const honey = integerState(block, 0, 5, "honey_level");
  if (direction === undefined || honey === undefined) return undefined;
  // The fragment model counts quarter-turns in the opposite rotational
  // direction to the block state, so invert everything except 0.
  const modelDirection = direction === 0 ? 0 : 4 - direction;
  // Only the full comb (vanilla honey_level 5, the harvestable level) has a
  // distinct model; +4 selects it.
  return modelDirection + (honey >= 5 ? 4 : 0);
}

function encodeCocoaState(block: CapturedTreeBlock): number | undefined {
  const direction = integerState(block, 0, 3, "direction");
  const age = integerState(block, 0, 2, "age");
  if (direction === undefined || age === undefined) return undefined;
  return direction + age * 4;
}

function encodePropaguleState(block: CapturedTreeBlock): number | undefined {
  const hanging = stateValue(block, "hanging");
  if (hanging !== true && hanging !== 1) return undefined;
  return integerState(block, 0, 4, "propagule_stage");
}

function encodePaleMossState(block: CapturedTreeBlock): number | undefined {
  const tip = stateValue(block, "tip");
  if (tip === true || tip === 1) return 1;
  return tip === false || tip === 0 ? 0 : undefined;
}

function encodeVineState(block: CapturedTreeBlock): number | undefined {
  return integerState(block, 0, 15, "vine_direction_bits");
}

function encodeCreakingHeartState(block: CapturedTreeBlock): number | undefined {
  const axis = CREAKING_HEART_AXIS_STATES.get(stateValue(block, "pillar_axis"));
  const mode = CREAKING_HEART_MODE_STATES.get(stateValue(block, "creaking_heart_state"));
  if (axis === undefined || mode === undefined) return undefined;
  return axis + mode * 3;
}

function integerState(
  block: CapturedTreeBlock,
  minimum: number,
  maximum: number,
  name: string
): number | undefined {
  const value = stateValue(block, name);
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}

// Some vanilla state names are namespaced (minecraft:cardinal_direction) while
// others are bare (pillar_axis), so accept either spelling, bare name first.
function stateValue(
  block: CapturedTreeBlock,
  name: string
): boolean | number | string | undefined {
  if (block.states[name] !== undefined) return block.states[name];
  return block.states[`minecraft:${name}`];
}
