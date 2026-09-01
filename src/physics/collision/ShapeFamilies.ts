// Hand-written per-family vanilla shape rules: block-name classifier
// predicates, family shape tables, and the state/neighbor-driven resolvers
// dispatched from BlockShapeResolver.ts.
import type {
  BlockCollisionBoxShapeDefinition,
  BlockCollisionShape
} from "./BlockShapeResolver";
import {
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
  type BlockCollisionShapeSource
} from "./BlockState";
import {
  FULL_SHAPE,
  NONE_SHAPE,
  box,
  centeredBox,
  modelBox,
  normalizeQuarterTurns,
  partialShape,
  rotateBoxY,
  rotateBoxesX,
  rotateBoxesY
} from "./ShapeGeometry";
import { resolveSableDynamicBoxes } from "./ShapeTables";

const ONE_SIXTEENTH = 1 / 16;
const THREE_SIXTEENTHS = 3 / 16;
const ONE_THIRTY_SECOND = 1 / 32;
const FENCE_HEIGHT = 1;
const WALL_HEIGHT = 1;
const PANE_THICKNESS = 2 / 16;
const FENCE_MIN = 5 / 16;
const FENCE_MAX = 11 / 16;
const WALL_MIN = 4 / 16;
const WALL_MAX = 12 / 16;
const LADDER_THICKNESS = 3 / 16;

// Vanilla blocks whose Bedrock collision shape is empty (plants, technical
// blocks, portals, wall decorations). Only names NOT already covered by the
// substring fallthrough in isNoCollisionTypeName (rail/flower/sapling/
// seagrass/kelp/banner/torch/sign) need to be listed here.
const NO_COLLISION_TYPE_NAMES = new Set([
  "air",
  "cave_air",
  "void_air",
  "lever",
  "tripwire",
  "tripwire_hook",
  "redstone_wire",
  "fire",
  "soul_fire",
  "web",
  "cobweb",
  "powder_snow",
  "nether_portal",
  "end_portal",
  "end_gateway",
  "light",
  "structure_void",
  "grass",
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "deadbush",
  "dead_bush",
  "bush",
  "firefly_bush",
  "sweet_berry_bush",
  "wheat",
  "carrots",
  "potatoes",
  "beetroot",
  "beetroots",
  "melon_stem",
  "pumpkin_stem",
  "attached_melon_stem",
  "attached_pumpkin_stem",
  "nether_wart",
  "sugar_cane",
  "spore_blossom",
  "leaf_litter",
  "resin_clump",
  "open_eyeblossom",
  "closed_eyeblossom",
  "pale_hanging_moss",
  "mangrove_propagule",
  "short_dry_grass",
  "tall_dry_grass",
  "dry_grass",
  "dandelion",
  "poppy",
  "blue_orchid",
  "allium",
  "azure_bluet",
  "red_tulip",
  "orange_tulip",
  "white_tulip",
  "pink_tulip",
  "oxeye_daisy",
  "lily_of_the_valley",
  "wither_rose",
  "lilac",
  "rose_bush",
  "peony",
  "double_plant",
  "pink_petals",
  "small_dripleaf",
  "big_dripleaf_stem",
  "frogspawn",
  "glow_lichen",
  "sculk_vein",
  "cave_vines_lit",
  "cave_vines_plant",
  "cave_vines_plant_lit",
  "weeping_vines_plant",
  "twisting_vines_plant",
  "crimson_fungus",
  "warped_fungus",
  "nether_sprouts",
  "pale_hanging_moss_tip",
  "item_frame",
  "glow_item_frame",
  "moving_piston"
]);

// Suffixes containing rail/flower/sapling/seagrass/kelp/banner/torch/sign are
// already covered by the substring fallthrough in isNoCollisionTypeName.
const NO_COLLISION_SUFFIXES = [
  "_button",
  "_coral",
  "_coral_fan",
  "_wall_fan",
  "_mushroom",
  "_roots",
  "_vine",
  "_vines"
];

// The vanilla chests with a bedrock-generated collision record; copper chests
// resolve through the manual chest fallback instead (see isChestLikeBlock).
const GENERATED_SHAPE_CHEST_TYPE_NAMES = new Set([
  "chest",
  "trapped_chest",
  "ender_chest"
]);

const THIN_TYPE_NAMES = new Set([
  "carpet",
  "light_weighted_pressure_plate",
  "heavy_weighted_pressure_plate",
  "stone_pressure_plate",
  "wooden_pressure_plate",
  "daylight_detector",
  "daylight_detector_inverted"
]);

const THIN_SUFFIXES = [
  "_carpet",
  "_pressure_plate"
];

const FLOWER_POT_TYPE_NAMES = new Set([
  "flower_pot",
  "tinted_flower_pot",
  "potted_azalea_bush",
  "potted_flowering_azalea_bush"
]);

// These static shapes are shared by every block in their family. Keeping the
// table at module scope avoids rebuilding identical box arrays per resolution.
const CAULDRON_BOXES: readonly BlockCollisionBoxShapeDefinition[] = [
  modelBox(2, 0, 2, 14, 4, 14),
  modelBox(0, 3, 0, 2, 16, 16),
  modelBox(14, 3, 0, 16, 16, 16),
  modelBox(2, 3, 0, 14, 16, 2),
  modelBox(2, 3, 14, 14, 16, 16)
];
const BREWING_STAND_BOXES: readonly BlockCollisionBoxShapeDefinition[] = [
  modelBox(7, 0, 7, 9, 14, 9),
  modelBox(9, 0, 5, 15, 2, 11),
  modelBox(1, 0, 1, 7, 2, 7),
  modelBox(1, 0, 9, 7, 2, 15)
];
const SCAFFOLDING_BOXES: readonly BlockCollisionBoxShapeDefinition[] = [
  modelBox(0, 15, 0, 16, 16, 16),
  modelBox(0, 0, 0, 2, 16, 2),
  modelBox(0, 0, 14, 2, 16, 16),
  modelBox(14, 0, 14, 16, 16, 16),
  modelBox(14, 0, 0, 16, 16, 2),
  modelBox(2, 14, 0, 14, 16, 2),
  modelBox(2, 14, 14, 14, 16, 16),
  modelBox(14, 14, 2, 16, 16, 14),
  modelBox(0, 14, 2, 2, 16, 16)
];
const BELL_BOXES: readonly BlockCollisionBoxShapeDefinition[] = [
  modelBox(4, 3, 4, 12, 5, 12),
  modelBox(5, 5, 5, 11, 13, 11),
  modelBox(14, 0, 6, 16, 16, 10),
  modelBox(0, 0, 6, 2, 16, 10),
  modelBox(2, 13, 7, 14, 15, 9)
];
const AZALEA_BOXES: readonly BlockCollisionBoxShapeDefinition[] = [
  centeredBox(10 / 16, 0, 10 / 16, 1),
  centeredBox(14 / 16, 5 / 16, 14 / 16, 1)
];
const CANDLE_CAKE_BOXES: readonly BlockCollisionBoxShapeDefinition[] = [
  modelBox(1, 0, 1, 15, 8, 15),
  modelBox(7, 8, 7, 9, 14, 9)
];

const SCULK_HALF_HEIGHT_TYPE_NAMES = new Set([
  "sculk_sensor",
  "calibrated_sculk_sensor",
  "sculk_shrieker"
]);

const SHELF_TYPE_NAMES = new Set([
  "acacia_shelf",
  "bamboo_shelf",
  "birch_shelf",
  "cherry_shelf",
  "crimson_shelf",
  "dark_oak_shelf",
  "jungle_shelf",
  "mangrove_shelf",
  "oak_shelf",
  "pale_oak_shelf",
  "spruce_shelf",
  "warped_shelf"
]);

function resolveSlabShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const typeName = getBlockTypeName(block);
  if (isDoubleSlabBlock(typeName) || getSemanticBooleanState(block, "double") === true) {
    return FULL_SHAPE;
  }

  const verticalHalf = getPermutationState(block, "minecraft:vertical_half") ??
    getPermutationState(block, "vertical_half");
  if (verticalHalf === "top") {
    return partialShape([box(0, 0.5, 0, 1, 1, 1)]);
  }

  if (verticalHalf === "bottom") {
    return partialShape([box(0, 0, 0, 1, 0.5, 1)]);
  }

  return partialShape([box(0, 0, 0, 1, 0.5, 1)]);
}

function resolveStairBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const state = resolveStairState(block);
  const upsideDown = state.upsideDown;
  const quarterTurns = state.quarterTurns;
  const cornerShape = resolveStairCornerShape(block, quarterTurns, upsideDown);
  const shape = cornerShape.kind === "straight"
    ? "straight"
    : `${cornerShape.kind}_${cornerShape.side === "max" ? "left" : "right"}`;
  const sableBoxes = resolveSableDynamicBoxes(
    "stairs",
    `${state.facing}|${upsideDown ? "top" : "bottom"}|${shape}`
  );
  if (sableBoxes) return sableBoxes;
  const base = createStairBoxes(cornerShape, upsideDown);

  return rotateBoxesY(base, quarterTurns);
}

interface StairState {
  readonly facing: "east" | "north" | "south" | "west";
  readonly quarterTurns: number;
  readonly upsideDown: boolean;
}

const WEIRDO_DIRECTION_FACINGS: readonly StairState["facing"][] =
  ["east", "west", "south", "north"];

function resolveStairState(block: BlockCollisionShapeSource): StairState {
  const legacyDirection = getPermutationState(block, "weirdo_direction");
  if (typeof legacyDirection === "number" && Number.isFinite(legacyDirection)) {
    const direction = clampInteger(legacyDirection, 0, 3);
    return {
      facing: WEIRDO_DIRECTION_FACINGS[direction],
      quarterTurns: getWeirdoDirectionQuarterTurns(direction),
      upsideDown: Boolean(getPermutationState(block, "upside_down_bit"))
    };
  }

  return {
    facing: getCardinalDirection(block),
    quarterTurns: getCardinalDirectionQuarterTurns(block),
    upsideDown: getVerticalHalf(block) === "top"
  };
}

type StairCornerShape =
  | { readonly kind: "straight" }
  | { readonly kind: "outer"; readonly side: "min" | "max" }
  | { readonly kind: "inner"; readonly side: "min" | "max" };

function resolveStairCornerShape(
  block: BlockCollisionShapeSource,
  quarterTurns: number,
  upsideDown: boolean
): StairCornerShape {
  const front = getStairFacingOffset(quarterTurns);
  const frontNeighbor = getRelativeBlock(block, front.x, 0, front.z);
  const frontQuarterTurns = getNeighborStairQuarterTurns(frontNeighbor, upsideDown);
  if (frontQuarterTurns !== undefined) {
    const relativeTurns = normalizeQuarterTurns(frontQuarterTurns - quarterTurns);
    if (relativeTurns === 1 || relativeTurns === 3) {
      return {
        kind: "outer",
        side: getStairCornerSide(relativeTurns)
      };
    }
  }

  const backNeighbor = getRelativeBlock(block, -front.x, 0, -front.z);
  const backQuarterTurns = getNeighborStairQuarterTurns(backNeighbor, upsideDown);
  if (backQuarterTurns !== undefined) {
    const relativeTurns = normalizeQuarterTurns(backQuarterTurns - quarterTurns);
    if (relativeTurns === 1 || relativeTurns === 3) {
      return {
        kind: "inner",
        side: getStairCornerSide(relativeTurns)
      };
    }
  }

  return { kind: "straight" };
}

function createStairBoxes(
  shape: StairCornerShape,
  upsideDown: boolean
): readonly BlockCollisionBoxShapeDefinition[] {
  const fullHalf = upsideDown
    ? box(0, 0.5, 0, 1, 1, 1)
    : box(0, 0, 0, 1, 0.5, 1);
  const minY = upsideDown ? 0 : 0.5;
  const maxY = upsideDown ? 0.5 : 1;

  if (shape.kind === "outer") {
    return [
      fullHalf,
      getStairCornerQuarterBox(shape.side, minY, maxY)
    ];
  }

  const stepBoxes: BlockCollisionBoxShapeDefinition[] = [
    box(0, minY, 0.5, 1, maxY, 1)
  ];
  if (shape.kind === "inner") {
    stepBoxes.push(getStairCornerBackHalfBox(shape.side, minY, maxY));
  }

  return [fullHalf, ...stepBoxes];
}

function getStairCornerQuarterBox(
  side: "min" | "max",
  minY: number,
  maxY: number
): BlockCollisionBoxShapeDefinition {
  return side === "max"
    ? box(0.5, minY, 0.5, 1, maxY, 1)
    : box(0, minY, 0.5, 0.5, maxY, 1);
}

function getStairCornerBackHalfBox(
  side: "min" | "max",
  minY: number,
  maxY: number
): BlockCollisionBoxShapeDefinition {
  return side === "max"
    ? box(0.5, minY, 0, 1, maxY, 0.5)
    : box(0, minY, 0, 0.5, maxY, 0.5);
}

function getStairCornerSide(relativeTurns: number): "min" | "max" {
  return relativeTurns === 3 ? "max" : "min";
}

function getNeighborStairQuarterTurns(
  block: BlockCollisionShapeSource | undefined,
  upsideDown: boolean
): number | undefined {
  if (!block || isEmptyLiveBlock(block)) {
    return undefined;
  }

  const typeName = getBlockTypeName(block);
  if (!isStairsBlock(typeName)) {
    return undefined;
  }

  const state = resolveStairState(block);
  if (state.upsideDown !== upsideDown) {
    return undefined;
  }

  return state.quarterTurns;
}

function getStairFacingOffset(quarterTurns: number): { readonly x: number; readonly z: number } {
  switch (normalizeQuarterTurns(quarterTurns)) {
    case 1:
      return { x: -1, z: 0 };
    case 2:
      return { x: 0, z: -1 };
    case 3:
      return { x: 1, z: 0 };
    default:
      return { x: 0, z: 1 };
  }
}

function resolveTrapdoorBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const open = Boolean(getPermutationState(block, "open_bit"));
  const upsideDown = Boolean(getPermutationState(block, "upside_down_bit"));
  const direction = getNumberState(block, "direction", 0);

  if (!open) {
    return [
      upsideDown
        ? box(0, 1 - THREE_SIXTEENTHS, 0, 1, 1, 1)
        : box(0, 0, 0, 1, THREE_SIXTEENTHS, 1)
    ];
  }

  return rotateBoxesY(
    [box(0, 0, 1 - THREE_SIXTEENTHS, 1, 1, 1)],
    getTrapdoorDirectionQuarterTurns(direction)
  );
}

function getTrapdoorDirectionQuarterTurns(direction: number): number {
  if (direction === 0) return 1;
  if (direction === 1) return 3;
  if (direction === 2) return 2;
  return 0;
}

function resolveDoorBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const open = Boolean(getPermutationState(block, "open_bit"));
  const hinge = Boolean(getPermutationState(block, "door_hinge_bit"));
  const numericDirection = getPermutationState(block, "direction");
  const quarterTurns = numericDirection !== undefined
    ? normalizeQuarterTurns(
      getNumberState(block, "direction", 0) + (open ? (hinge ? 1 : 3) : 0)
    )
    : normalizeQuarterTurns(
      getCardinalDirectionQuarterTurns(block) + (open ? (hinge ? 1 : 3) : 0)
    );
  return rotateBoxesY(
    [box(0, 0, 0, 1, 1, THREE_SIXTEENTHS)],
    quarterTurns
  );
}

function resolveFenceGateShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  if (Boolean(getPermutationState(block, "open_bit"))) {
    return NONE_SHAPE;
  }

  const direction = getNumberState(block, "direction", 0);
  const quarterTurns = normalizeQuarterTurns(direction);
  return partialShape(
    rotateBoxesY(
      [box(0, 0, 6 / 16, 1, FENCE_HEIGHT, 10 / 16)],
      quarterTurns
    )
  );
}

function resolveFenceBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const connections = getHorizontalConnections(block, false);
  const sableBoxes = resolveSableDynamicBoxes(
    "fence",
    [connections.east, connections.north, connections.south, connections.west].join("|")
  );
  if (sableBoxes) return sableBoxes;
  const boxes: BlockCollisionBoxShapeDefinition[] = [
    box(FENCE_MIN, 0, FENCE_MIN, FENCE_MAX, FENCE_HEIGHT, FENCE_MAX)
  ];

  if (connections.north) {
    boxes.push(box(FENCE_MIN, 0, 0, FENCE_MAX, FENCE_HEIGHT, FENCE_MAX));
  }
  if (connections.south) {
    boxes.push(box(FENCE_MIN, 0, FENCE_MIN, FENCE_MAX, FENCE_HEIGHT, 1));
  }
  if (connections.west) {
    boxes.push(box(0, 0, FENCE_MIN, FENCE_MAX, FENCE_HEIGHT, FENCE_MAX));
  }
  if (connections.east) {
    boxes.push(box(FENCE_MIN, 0, FENCE_MIN, 1, FENCE_HEIGHT, FENCE_MAX));
  }

  return boxes;
}

function resolveWallBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const stateValues = ["east", "north", "south", "west"].map((direction) =>
    normalizeSableWallConnection(getPermutationState(block, `wall_connection_type_${direction}`))
  );
  if (stateValues.every((value) => value !== undefined)) {
    const [east, north, south, west] = stateValues;
    const up = Boolean(getPermutationState(block, "wall_post_bit"));
    const sableBoxes = resolveSableDynamicBoxes(
      "wall",
      [east, north, south, up, west].join("|")
    );
    if (sableBoxes) return sableBoxes;
  }

  const connections = getHorizontalConnections(block, true);
  const boxes: BlockCollisionBoxShapeDefinition[] = [
    box(WALL_MIN, 0, WALL_MIN, WALL_MAX, WALL_HEIGHT, WALL_MAX)
  ];

  if (connections.north) {
    boxes.push(box(WALL_MIN, 0, 0, WALL_MAX, WALL_HEIGHT, WALL_MAX));
  }
  if (connections.south) {
    boxes.push(box(WALL_MIN, 0, WALL_MIN, WALL_MAX, WALL_HEIGHT, 1));
  }
  if (connections.west) {
    boxes.push(box(0, 0, WALL_MIN, WALL_MAX, WALL_HEIGHT, WALL_MAX));
  }
  if (connections.east) {
    boxes.push(box(WALL_MIN, 0, WALL_MIN, 1, WALL_HEIGHT, WALL_MAX));
  }

  return boxes;
}

function resolvePaneBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const connections = getHorizontalConnections(block, false);
  const sableBoxes = resolveSableDynamicBoxes(
    "pane",
    [connections.east, connections.north, connections.south, connections.west].join("|")
  );
  if (sableBoxes) return sableBoxes;
  const centerMin = 0.5 - PANE_THICKNESS * 0.5;
  const centerMax = 0.5 + PANE_THICKNESS * 0.5;
  const boxes: BlockCollisionBoxShapeDefinition[] = [
    box(centerMin, 0, centerMin, centerMax, 1, centerMax)
  ];

  if (connections.north) {
    boxes.push(box(centerMin, 0, 0, centerMax, 1, centerMax));
  }
  if (connections.south) {
    boxes.push(box(centerMin, 0, centerMin, centerMax, 1, 1));
  }
  if (connections.west) {
    boxes.push(box(0, 0, centerMin, centerMax, 1, centerMax));
  }
  if (connections.east) {
    boxes.push(box(centerMin, 0, centerMin, 1, 1, centerMax));
  }

  return boxes;
}

function resolveFacingRodBox(block: BlockCollisionShapeSource, width: number): BlockCollisionBoxShapeDefinition {
  const facingDirection = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 1)
  );
  if (facingDirection === 2 || facingDirection === 3) {
    return box((1 - width) * 0.5, (1 - width) * 0.5, 0, (1 + width) * 0.5, (1 + width) * 0.5, 1);
  }

  if (facingDirection === 4 || facingDirection === 5) {
    return box(0, (1 - width) * 0.5, (1 - width) * 0.5, 1, (1 + width) * 0.5, (1 + width) * 0.5);
  }

  return centeredBox(width, 0, width, 1);
}

function resolveLadderBox(block: BlockCollisionShapeSource): BlockCollisionBoxShapeDefinition {
  const direction = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 3)
  );
  return rotateBoxY(
    box(0, 0, 0, 1, 1, LADDER_THICKNESS),
    getBlockFaceFacingDirectionQuarterTurns(direction)
  );
}

function resolveAxisBox(block: BlockCollisionShapeSource, width: number): BlockCollisionBoxShapeDefinition {
  const axis = getPermutationState(block, "pillar_axis") ??
    getPermutationState(block, "minecraft:pillar_axis");
  if (axis === "x") {
    return box(0, (1 - width) * 0.5, (1 - width) * 0.5, 1, (1 + width) * 0.5, (1 + width) * 0.5);
  }

  if (axis === "z") {
    return box((1 - width) * 0.5, (1 - width) * 0.5, 0, (1 + width) * 0.5, (1 + width) * 0.5, 1);
  }

  return centeredBox(width, 0, width, 1);
}

function resolveComposterBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const boxes: BlockCollisionBoxShapeDefinition[] = [
    modelBox(0, 0, 0, 16, 2, 16),
    modelBox(0, 0, 0, 2, 16, 16),
    modelBox(14, 0, 0, 16, 16, 16),
    modelBox(2, 0, 0, 14, 16, 2),
    modelBox(2, 0, 14, 14, 16, 16)
  ];
  const fillLevel = getFirstNumberState(block, [
    "composter_fill_level",
    "minecraft:composter_fill_level",
    "fill_level",
    "minecraft:fill_level"
  ], 0);
  if (fillLevel > 0) {
    boxes.push(modelBox(2, 0, 2, 14, Math.min(15, fillLevel * 2 + 1), 14));
  }

  return boxes;
}

function resolveHopperBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const boxes = [
    modelBox(0, 10, 0, 16, 11, 16),
    modelBox(0, 11, 0, 2, 16, 16),
    modelBox(14, 11, 0, 16, 16, 16),
    modelBox(2, 11, 0, 14, 16, 2),
    modelBox(2, 11, 14, 14, 16, 16),
    modelBox(4, 4, 4, 12, 10, 12)
  ];
  const facingDirection = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 0)
  );
  const outletBox = facingDirection >= 2 && facingDirection <= 5
    ? modelBox(6, 4, 0, 10, 8, 4)
    : modelBox(6, 0, 6, 10, 4, 10);
  boxes.push(outletBox);

  return facingDirection >= 2 && facingDirection <= 5
    ? rotateBoxesY(boxes, getBlockFaceFacingDirectionQuarterTurns(facingDirection))
    : boxes;
}

function resolveAnvilBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const boxes = [
    modelBox(2, 0, 2, 14, 4, 14),
    modelBox(4, 4, 3, 12, 5, 13),
    modelBox(6, 5, 4, 10, 10, 12),
    modelBox(3, 10, 0, 13, 16, 16)
  ];
  return rotateBoxesY(boxes, getCardinalDirectionQuarterTurns(block));
}

function resolveLanternBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const hanging = Boolean(getPermutationState(block, "hanging")) ||
    Boolean(getPermutationState(block, "minecraft:hanging"));
  return hanging
    ? [
        modelBox(5, 1, 5, 11, 8, 11),
        modelBox(6, 8, 6, 10, 10, 10)
      ]
    : [
        modelBox(5, 0, 5, 11, 7, 11),
        modelBox(6, 7, 6, 10, 9, 10)
    ];
}

function resolveLecternBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  return rotateBoxesY(
    [
      modelBox(0, 0, 0, 16, 2, 16),
      modelBox(4, 2, 4, 12, 15, 12),
      modelBox(0, 12, 3, 16, 16, 16)
    ],
    getCardinalDirectionQuarterTurns(block)
  );
}

function resolveGrindstoneBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  let boxes: readonly BlockCollisionBoxShapeDefinition[] = [
    modelBox(12, 0, 6, 14, 7, 10),
    modelBox(2, 0, 6, 4, 7, 10),
    modelBox(12, 7, 5, 14, 13, 11),
    modelBox(2, 7, 5, 4, 13, 11),
    modelBox(4, 4, 2, 12, 16, 14)
  ];
  const attachment = getPermutationState(block, "attachment") ??
    getPermutationState(block, "minecraft:attachment");
  if (attachment === "side") {
    boxes = rotateBoxesX(boxes, 1);
  } else if (attachment === "hanging") {
    boxes = rotateBoxesX(boxes, 2);
  }

  return rotateBoxesY(boxes, getDirectionQuarterTurns(getNumberState(block, "direction", 0)));
}

function resolveTurtleEggBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const eggCount = getTurtleEggCount(block);
  return eggCount === 1
    ? [modelBox(3, 0, 3, 12, 7, 12)]
    : [modelBox(1, 0, 1, 15, 7, 15)];
}

function getTurtleEggCount(block: BlockCollisionShapeSource): number {
  const raw = getPermutationState(block, "turtle_egg_count") ??
    getPermutationState(block, "minecraft:turtle_egg_count") ??
    getPermutationState(block, "eggs") ??
    getPermutationState(block, "minecraft:eggs");
  if (typeof raw === "number") {
    return clampInteger(raw + 1, 1, 4);
  }

  switch (raw) {
    case "two_egg":
      return 2;
    case "three_egg":
      return 3;
    case "four_egg":
      return 4;
    default:
      return 1;
  }
}

function resolveSeaPickleBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const rawCount = getFirstNumberState(block, [
    "cluster_count",
    "minecraft:cluster_count",
    "pickles",
    "minecraft:pickles"
  ], 0);
  const count = clampInteger(rawCount + 1, 1, 4);
  if (count === 1) return [modelBox(6, 0, 6, 10, 6, 10)];
  if (count === 2) return [modelBox(3, 0, 3, 13, 6, 13)];
  if (count === 3) return [modelBox(2, 0, 2, 14, 6, 14)];
  return [modelBox(2, 0, 2, 14, 7, 14)];
}

function resolvePointedDripstoneBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const thickness = getPermutationState(block, "dripstone_thickness") ??
    getPermutationState(block, "minecraft:dripstone_thickness") ??
    "tip";
  const width = thickness === "base"
    ? 14 / 16
    : thickness === "middle"
      ? 10 / 16
      : thickness === "frustum"
        ? 8 / 16
        : 6 / 16;
  return [centeredBox(width, 0, width, 1)];
}

function resolveCocoaBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const age = clampInteger(
    getFirstNumberState(block, ["age", "minecraft:age"], 2),
    0,
    2
  );
  const boxByAge = age <= 0
    ? modelBox(6, 7, 11, 10, 12, 15)
    : age === 1
      ? modelBox(5, 5, 9, 11, 12, 15)
      : modelBox(4, 3, 7, 12, 12, 15);
  return rotateBoxesY([boxByAge], getDirectionQuarterTurns(getNumberState(block, "direction", 0)));
}

function resolveBigDripleafShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const isHead = getPermutationState(block, "big_dripleaf_head") ??
    getPermutationState(block, "minecraft:big_dripleaf_head");
  if (isHead === 0 || isHead === false) {
    return NONE_SHAPE;
  }

  const tilt = getPermutationState(block, "big_dripleaf_tilt") ??
    getPermutationState(block, "minecraft:big_dripleaf_tilt");
  if (tilt === "full_tilt" || tilt === "full") {
    return NONE_SHAPE;
  }

  const leafBox = tilt === "partial_tilt" || tilt === "partial"
    ? modelBox(0, 13, 0, 16, 15, 16)
    : modelBox(0, 14, 0, 16, 16, 16);
  return partialShape(
    rotateBoxesY([leafBox], getCardinalDirectionQuarterTurns(block))
  );
}

function resolvePistonHeadBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const short = Boolean(getPermutationState(block, "short")) ||
    Boolean(getPermutationState(block, "minecraft:short")) ||
    Boolean(getPermutationState(block, "short_bit")) ||
    Boolean(getPermutationState(block, "minecraft:short_bit"));
  const boxes = [
    modelBox(0, 0, 0, 16, 16, 4),
    modelBox(6, 6, 4, 10, 10, short ? 16 : 20)
  ];
  const direction = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 3)
  );
  return rotateBoxesToFacingDirection(boxes, direction);
}

function resolvePistonShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const extended = Boolean(getPermutationState(block, "extended_bit")) ||
    Boolean(getPermutationState(block, "minecraft:extended_bit"));
  if (!extended) {
    return FULL_SHAPE;
  }

  const direction = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 3)
  );
  return partialShape(rotateBoxesToFacingDirection([modelBox(0, 0, 4, 16, 16, 16)], direction));
}

function resolveHeadBoxes(
  block: BlockCollisionShapeSource,
  typeName: string
): readonly BlockCollisionBoxShapeDefinition[] {
  const baseBox = typeName.includes("wall_") || typeName.endsWith("_wall_head") ||
    typeName.endsWith("_wall_skull")
    ? [modelBox(2, 4, 0, 14, 16, 8)]
    : [centeredBox(8 / 16, 0, 8 / 16, 8 / 16)];
  const direction = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 3)
  );
  return typeName.includes("wall_") || typeName.endsWith("_wall_head") ||
    typeName.endsWith("_wall_skull")
    ? rotateBoxesY(baseBox, getBlockFaceFacingDirectionQuarterTurns(direction))
    : baseBox;
}

function resolveAmethystClusterBox(
  block: BlockCollisionShapeSource,
  typeName: string
): BlockCollisionBoxShapeDefinition {
  const depth = typeName === "amethyst_cluster"
    ? 7 / 16
    : typeName === "large_amethyst_bud"
      ? 5 / 16
      : typeName === "medium_amethyst_bud"
        ? 4 / 16
        : 3 / 16;
  const sideWidth = typeName === "small_amethyst_bud" ? 8 / 16 : 10 / 16;
  const direction = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 1)
  );
  const blockFace = getBlockFaceState(block);
  if (blockFace === "down") {
    return centeredBox(sideWidth, 1 - depth, sideWidth, 1);
  }
  if (blockFace === "up") {
    return centeredBox(sideWidth, 0, sideWidth, depth);
  }

  if (blockFace) {
    const wallBox = box(
      (1 - sideWidth) * 0.5,
      (1 - sideWidth) * 0.5,
      0,
      (1 + sideWidth) * 0.5,
      (1 + sideWidth) * 0.5,
      depth
    );
    return rotateBoxY(wallBox, getBlockFaceQuarterTurns(blockFace));
  }

  if (direction === 0) {
    return centeredBox(sideWidth, 1 - depth, sideWidth, 1);
  }
  if (direction === 1) {
    return centeredBox(sideWidth, 0, sideWidth, depth);
  }

  const wallBox = box(
    (1 - sideWidth) * 0.5,
    (1 - sideWidth) * 0.5,
    0,
    (1 + sideWidth) * 0.5,
    (1 + sideWidth) * 0.5,
    depth
  );
  return rotateBoxY(wallBox, getBlockFaceFacingDirectionQuarterTurns(direction));
}

function resolveHangingSignBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const centerMin = 0.5 - PANE_THICKNESS * 0.5;
  const centerMax = 0.5 + PANE_THICKNESS * 0.5;
  const facingDirection = getNumberState(
    block,
    "facing_direction",
    getNumberState(block, "minecraft:facing_direction", 0)
  );

  if (facingDirection >= 2 && facingDirection <= 5) {
    return rotateBoxesY(
      [box(centerMin, 0, 0, centerMax, 1, centerMax)],
      getBlockFaceFacingDirectionQuarterTurns(facingDirection)
    );
  }

  const groundSignDirection = getFirstNumberState(block, [
    "ground_sign_direction",
    "minecraft:ground_sign_direction",
    "direction",
    "minecraft:direction"
  ], 0);
  const quarterTurns = normalizeQuarterTurns(Math.round(groundSignDirection / 4));
  return rotateBoxesY([box(centerMin, 0, 0, centerMax, 1, 1)], quarterTurns);
}

function resolvePitcherPlantBox(block: BlockCollisionShapeSource): BlockCollisionBoxShapeDefinition {
  const age = getFirstNumberState(block, [
    "growth",
    "minecraft:growth",
    "age",
    "minecraft:age"
  ], 1);
  return age <= 0
    ? centeredBox(12 / 16, 0, 12 / 16, 3 / 16)
    : centeredBox(12 / 16, 0, 12 / 16, 5 / 16);
}

function resolveChorusPlantBoxes(block: BlockCollisionShapeSource): readonly BlockCollisionBoxShapeDefinition[] {
  const connections = {
    down: isChorusConnection(getRelativeBlock(block, 0, -1, 0), true),
    east: isChorusConnection(getRelativeBlock(block, 1, 0, 0), false),
    north: isChorusConnection(getRelativeBlock(block, 0, 0, -1), false),
    south: isChorusConnection(getRelativeBlock(block, 0, 0, 1), false),
    up: isChorusConnection(getRelativeBlock(block, 0, 1, 0), false),
    west: isChorusConnection(getRelativeBlock(block, -1, 0, 0), false)
  };
  const sableBoxes = resolveSableDynamicBoxes(
    "chorus_plant",
    [
      connections.down,
      connections.east,
      connections.north,
      connections.south,
      connections.up,
      connections.west
    ].join("|")
  );
  if (sableBoxes) return sableBoxes;

  const boxes: BlockCollisionBoxShapeDefinition[] = [
    box(3 / 16, 0, 3 / 16, 13 / 16, 1, 13 / 16)
  ];
  const arms = [
    { x: 0, y: 0.1875, z: 0.1875, maxX: 3 / 16, maxY: 13 / 16, maxZ: 13 / 16 },
    { x: 13 / 16, y: 0.1875, z: 3 / 16, maxX: 1, maxY: 13 / 16, maxZ: 13 / 16 },
    { x: 3 / 16, y: 0.1875, z: 0, maxX: 13 / 16, maxY: 13 / 16, maxZ: 3 / 16 },
    { x: 3 / 16, y: 0.1875, z: 13 / 16, maxX: 13 / 16, maxY: 13 / 16, maxZ: 1 }
  ] as const;
  const offsets = [
    { x: -1, z: 0 },
    { x: 1, z: 0 },
    { x: 0, z: -1 },
    { x: 0, z: 1 }
  ] as const;

  for (const [index, offset] of offsets.entries()) {
    const neighbor = getRelativeBlock(block, offset.x, 0, offset.z);
    if (!neighbor || isEmptyLiveBlock(neighbor)) continue;
    const neighborType = getBlockTypeName(neighbor);
    if (neighborType !== "chorus_plant" && !neighborType.includes("chorus_flower")) continue;
    const arm = arms[index];
    boxes.push(box(arm.x, arm.y, arm.z, arm.maxX, arm.maxY, arm.maxZ));
  }

  return boxes;
}

function isChorusConnection(
  block: BlockCollisionShapeSource | undefined,
  allowEndStone: boolean
): boolean {
  if (!block || isEmptyLiveBlock(block)) return false;
  const typeName = getBlockTypeName(block);
  return typeName === "chorus_plant"
    || typeName.includes("chorus_flower")
    || (allowEndStone && typeName === "end_stone");
}

function normalizeSableWallConnection(
  value: boolean | number | string | undefined
): "none" | "low" | "tall" | undefined {
  if (value === "none" || value === "tall") return value;
  if (value === "short" || value === "low") return "low";
  return undefined;
}

function getHorizontalConnections(
  block: BlockCollisionShapeSource,
  preferWallState: boolean
): {
  readonly north: boolean;
  readonly south: boolean;
  readonly west: boolean;
  readonly east: boolean;
} {
  if (preferWallState) {
    const north = getPermutationState(block, "wall_connection_type_north");
    const south = getPermutationState(block, "wall_connection_type_south");
    const west = getPermutationState(block, "wall_connection_type_west");
    const east = getPermutationState(block, "wall_connection_type_east");
    if (
      typeof north === "string" ||
      typeof south === "string" ||
      typeof west === "string" ||
      typeof east === "string"
    ) {
      return {
        north: north !== "none" && north !== undefined,
        south: south !== "none" && south !== undefined,
        west: west !== "none" && west !== undefined,
        east: east !== "none" && east !== undefined
      };
    }
  }

  return {
    north: shouldConnectToNeighbor(getRelativeBlock(block, 0, 0, -1)),
    south: shouldConnectToNeighbor(getRelativeBlock(block, 0, 0, 1)),
    west: shouldConnectToNeighbor(getRelativeBlock(block, -1, 0, 0)),
    east: shouldConnectToNeighbor(getRelativeBlock(block, 1, 0, 0))
  };
}

function shouldConnectToNeighbor(block: BlockCollisionShapeSource | undefined): boolean {
  if (!block || isEmptyLiveBlock(block)) {
    return false;
  }

  const typeName = getBlockTypeName(block);
  return !(
    isSlabBlock(typeName) ||
    isCarpetBlock(typeName) ||
    isPressurePlateBlock(typeName) ||
    isDaylightDetectorBlock(typeName) ||
    typeName === "hopper"
  );
}

function isNoCollisionBlock(typeName: string, block: BlockCollisionShapeSource): boolean {
  return isNoCollisionTypeName(typeName) || hasBlockTag(block, "rail");
}

function isNoCollisionTypeName(typeName: string): boolean {
  if (
    isFlowerPotBlock(typeName) ||
    isAzaleaBlock(typeName) ||
    isHangingSignBlock(typeName) ||
    typeName === "flowering_azalea_leaves" ||
    typeName === "chorus_flower" ||
    typeName === "chorus_flower_dead" ||
    typeName === "mangrove_roots" ||
    typeName === "muddy_mangrove_roots"
  ) {
    return false;
  }

  if (NO_COLLISION_TYPE_NAMES.has(typeName) || hasAnySuffix(typeName, NO_COLLISION_SUFFIXES)) {
    return true;
  }

  return typeName.includes("rail") ||
    typeName.includes("flower") ||
    typeName.includes("sapling") ||
    typeName.includes("seagrass") ||
    typeName.includes("kelp") ||
    typeName.includes("banner") ||
    typeName.includes("torch") ||
    typeName.includes("sign");
}

function resolveTaggedCustomBlockCollisionShape(
  block: BlockCollisionShapeSource
): BlockCollisionShape | undefined {
  if (getBlockNamespace(block) === "minecraft") {
    return undefined;
  }

  if (
    hasSemanticBlockTag(block, "rail") ||
    hasSemanticBlockTag(block, "plant") ||
    hasSemanticBlockTag(block, "crop") ||
    hasSemanticBlockTag(block, "nonsolid") ||
    hasSemanticBlockTag(block, "passable")
  ) {
    return NONE_SHAPE;
  }

  if (hasBlockTag(block, "minecraft:cornerable_stairs")) {
    return hasRequiredStairShapeStates(block)
      ? partialShape(resolveStairBoxes(block))
      : FULL_SHAPE;
  }

  if (hasBlockTag(block, "trapdoors")) {
    return hasRequiredTrapdoorShapeStates(block)
      ? partialShape(resolveTrapdoorBoxes(block))
      : FULL_SHAPE;
  }

  if (hasBlockTag(block, "minecraft:has_fence_connections")) {
    return partialShape(resolveFenceBoxes(block));
  }

  return undefined;
}

function hasRequiredStairShapeStates(block: BlockCollisionShapeSource): boolean {
  const legacy = typeof getPermutationState(block, "weirdo_direction") === "number"
    && typeof getPermutationState(block, "upside_down_bit") === "boolean";
  const modern = getCardinalDirectionState(block) !== undefined
    && getVerticalHalf(block) !== undefined;
  return legacy || modern;
}

function hasRequiredTrapdoorShapeStates(block: BlockCollisionShapeSource): boolean {
  return typeof getPermutationState(block, "open_bit") === "boolean" &&
    typeof getPermutationState(block, "upside_down_bit") === "boolean" &&
    typeof getPermutationState(block, "direction") === "number";
}

function isCarpetBlock(typeName: string): boolean {
  return typeName === "carpet" || typeName.endsWith("_carpet");
}

function isPressurePlateBlock(typeName: string): boolean {
  return typeName.includes("pressure_plate") || THIN_TYPE_NAMES.has(typeName) ||
    hasAnySuffix(typeName, THIN_SUFFIXES);
}

function resolvePressurePlateShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const active = Boolean(getPermutationState(block, "powered_bit")) ||
    Boolean(getPermutationState(block, "minecraft:powered_bit"));
  return partialShape([
    box(1 / 16, 0, 1 / 16, 15 / 16, active ? ONE_THIRTY_SECOND : ONE_SIXTEENTH, 15 / 16)
  ]);
}

function isDaylightDetectorBlock(typeName: string): boolean {
  return typeName === "daylight_detector" || typeName === "daylight_detector_inverted";
}

function isBedBlock(typeName: string): boolean {
  return typeName === "bed" || typeName.endsWith("_bed");
}

function isSnowLayerBlock(typeName: string): boolean {
  return typeName === "snow_layer";
}

function resolveSnowLayerShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const extraLayerCount = getNumberState(block, "height", 0);
  if (extraLayerCount <= 0) {
    return NONE_SHAPE;
  }

  return partialShape([box(0, 0, 0, 1, Math.min(14 / 16, extraLayerCount / 8), 1)]);
}

function isFarmlandLikeBlock(typeName: string): boolean {
  return typeName === "farmland" ||
    typeName === "grass_path" ||
    typeName === "dirt_path";
}

function isMudBlock(typeName: string): boolean {
  return typeName === "mud";
}

function isChestLikeBlock(typeName: string): boolean {
  return GENERATED_SHAPE_CHEST_TYPE_NAMES.has(typeName) ||
    typeName === "copper_chest" ||
    typeName.endsWith("_copper_chest");
}

function isCakeBlock(typeName: string): boolean {
  return typeName === "cake";
}

function resolveCakeShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const biteCount = clampInteger(
    getNumberState(block, "bite_counter", getNumberState(block, "minecraft:bite_counter", 0)),
    0,
    6
  );
  return partialShape([
    box((1 + biteCount * 2) / 16, 0, 1 / 16, 15 / 16, 8 / 16, 15 / 16)
  ]);
}

function isFlowerPotBlock(typeName: string): boolean {
  return FLOWER_POT_TYPE_NAMES.has(typeName) ||
    typeName.startsWith("potted_") ||
    typeName.endsWith("_flower_pot");
}

function isEndPortalFrameBlock(typeName: string): boolean {
  return typeName === "end_portal_frame";
}

function resolveEndPortalFrameShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const boxes: BlockCollisionBoxShapeDefinition[] = [
    box(0, 0, 0, 1, 13 / 16, 1)
  ];
  const hasEye = Boolean(getPermutationState(block, "end_portal_eye_bit")) ||
    Boolean(getPermutationState(block, "eye")) ||
    Boolean(getPermutationState(block, "minecraft:eye"));
  if (hasEye) {
    boxes.push(centeredBox(8 / 16, 13 / 16, 8 / 16, 1));
  }

  return partialShape(boxes);
}

function isSculkHalfHeightBlock(typeName: string): boolean {
  return SCULK_HALF_HEIGHT_TYPE_NAMES.has(typeName);
}

function resolveShelfBoxes(
  block: BlockCollisionShapeSource
): readonly BlockCollisionBoxShapeDefinition[] {
  const northFacingBoxes = [
    modelBox(0, 12, 11, 16, 16, 13),
    modelBox(0, 0, 13, 16, 16, 16),
    modelBox(0, 0, 11, 16, 4, 13)
  ];
  return rotateBoxesY(
    northFacingBoxes,
    normalizeQuarterTurns(getCardinalDirectionQuarterTurns(block) + 2)
  );
}

function isCopperGolemStatueBlock(typeName: string): boolean {
  return typeName === "copper_golem_statue" || typeName.endsWith("_copper_golem_statue");
}

function isRodBlock(typeName: string): boolean {
  return typeName === "end_rod" ||
    typeName === "lightning_rod" ||
    typeName.endsWith("_lightning_rod");
}

function isPistonBlock(typeName: string): boolean {
  return typeName === "piston" || typeName === "sticky_piston";
}

function isChainBlock(typeName: string): boolean {
  return typeName === "chain" ||
    typeName === "iron_chain" ||
    typeName.endsWith("_chain");
}

function isCauldronBlock(typeName: string): boolean {
  return typeName === "cauldron" ||
    typeName === "_cauldron" ||
    typeName.endsWith("_cauldron");
}

function isAnvilBlock(typeName: string): boolean {
  return typeName === "anvil" ||
    typeName === "chipped_anvil" ||
    typeName === "damaged_anvil";
}

function isLanternBlock(typeName: string): boolean {
  return typeName === "lantern" ||
    typeName === "soul_lantern" ||
    typeName.endsWith("copper_lantern");
}

function isLecternBlock(typeName: string): boolean {
  return typeName === "lectern" || typeName === "_lectern";
}

function isHeadBlock(typeName: string): boolean {
  return typeName === "skull" ||
    typeName.endsWith("_skull") ||
    typeName.endsWith("_wall_skull") ||
    typeName.endsWith("_head") ||
    typeName.endsWith("_wall_head");
}

function isHangingSignBlock(typeName: string): boolean {
  return typeName === "hanging_sign" ||
    typeName.endsWith("_hanging_sign") ||
    typeName.endsWith("_wall_hanging_sign");
}

function isAzaleaBlock(typeName: string): boolean {
  return typeName === "azalea" || typeName === "flowering_azalea";
}

function isCandleCakeBlock(typeName: string): boolean {
  return typeName === "candle_cake" || typeName.endsWith("_candle_cake");
}

function isCandleBlock(typeName: string): boolean {
  return typeName === "candle" || typeName.endsWith("_candle");
}

function resolveCandleShape(block: BlockCollisionShapeSource): BlockCollisionShape {
  const candleState = getNumberState(
    block,
    "candles",
    getNumberState(block, "minecraft:candles", 0)
  );
  const candleCount = clampInteger(candleState + 1, 1, 4);
  if (candleCount === 1) return partialShape([modelBox(7, 0, 7, 9, 6, 9)]);
  if (candleCount === 2) return partialShape([modelBox(5, 0, 6, 11, 6, 9)]);
  if (candleCount === 3) return partialShape([modelBox(5, 0, 6, 10, 6, 11)]);
  return partialShape([modelBox(5, 0, 5, 11, 6, 10)]);
}

function isSlabBlock(typeName: string): boolean {
  return typeName.endsWith("_slab") || typeName.includes("_slab_");
}

function isDoubleSlabBlock(typeName: string): boolean {
  return typeName.startsWith("double_") || typeName.includes("double_slab") ||
    typeName.includes("_double_") ||
    typeName.endsWith("_double_slab");
}

function isStairsBlock(typeName: string): boolean {
  return typeName.endsWith("_stairs") || typeName === "stairs";
}

function isTrapdoorBlock(typeName: string): boolean {
  return typeName === "trapdoor" || typeName.endsWith("_trapdoor");
}

function isDoorBlock(typeName: string): boolean {
  return typeName === "wooden_door" || typeName.endsWith("_door");
}

function isFenceGateBlock(typeName: string): boolean {
  return typeName === "fence_gate" || typeName.endsWith("_fence_gate");
}

function isFenceBlock(typeName: string): boolean {
  return (typeName === "fence" || typeName.endsWith("_fence")) &&
    !isFenceGateBlock(typeName);
}

function isWallBlock(typeName: string): boolean {
  return typeName.endsWith("_wall") &&
    !typeName.includes("sign") &&
    !typeName.includes("banner");
}

function isPaneBlock(typeName: string): boolean {
  return typeName === "glass_pane" || typeName.endsWith("_glass_pane");
}

function isBarBlock(typeName: string): boolean {
  return typeName === "iron_bars" || typeName.endsWith("_bars");
}

function hasAnySuffix(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function getDirectionQuarterTurns(direction: number): number {
  return normalizeQuarterTurns(direction);
}

function getBlockFaceState(block: BlockCollisionShapeSource): string | undefined {
  const value = getPermutationState(block, "minecraft:block_face") ??
    getPermutationState(block, "block_face");
  return typeof value === "string" ? value : undefined;
}

function getBlockFaceQuarterTurns(blockFace: string): number {
  if (blockFace === "north") {
    return 2;
  }

  if (blockFace === "west") {
    return 1;
  }

  if (blockFace === "east") {
    return 3;
  }

  return 0;
}

function getBlockFaceFacingDirectionQuarterTurns(direction: number): number {
  if (direction === 2) {
    return 2;
  }

  if (direction === 4) {
    return 1;
  }

  if (direction === 5) {
    return 3;
  }

  return 0;
}

function getHorizontalFacingDirectionQuarterTurns(direction: number): number {
  if (direction === 2) {
    return 2;
  }

  if (direction === 4) {
    return 1;
  }

  if (direction === 5) {
    return 3;
  }

  return 0;
}

function getCardinalDirectionQuarterTurns(block: BlockCollisionShapeSource): number {
  const cardinalDirection = getCardinalDirection(block);
  if (cardinalDirection === "west") {
    return 1;
  }

  if (cardinalDirection === "north") {
    return 2;
  }

  if (cardinalDirection === "east") {
    return 3;
  }

  return 0;
}

function getCardinalDirection(block: BlockCollisionShapeSource): StairState["facing"] {
  return getCardinalDirectionState(block) ?? "south";
}

function getCardinalDirectionState(
  block: BlockCollisionShapeSource
): StairState["facing"] | undefined {
  const value = getPermutationState(block, "minecraft:cardinal_direction") ??
    getPermutationState(block, "cardinal_direction");
  return value === "east" || value === "north" || value === "south" || value === "west"
    ? value
    : undefined;
}

function getVerticalHalf(block: BlockCollisionShapeSource): "bottom" | "top" | undefined {
  const value = getPermutationState(block, "minecraft:vertical_half") ??
    getPermutationState(block, "vertical_half");
  return value === "bottom" || value === "top" ? value : undefined;
}

function getWeirdoDirectionQuarterTurns(direction: number): number {
  if (direction === 0) {
    return 3;
  }

  if (direction === 1) {
    return 1;
  }

  if (direction === 2) {
    return 0;
  }

  return 2;
}

function rotateBoxesToFacingDirection(
  boxes: readonly BlockCollisionBoxShapeDefinition[],
  direction: number
): readonly BlockCollisionBoxShapeDefinition[] {
  if (direction === 0) {
    return rotateBoxesX(boxes, 3);
  }

  if (direction === 1) {
    return rotateBoxesX(boxes, 1);
  }

  return rotateBoxesY(boxes, getHorizontalFacingDirectionQuarterTurns(direction));
}

export {
  AZALEA_BOXES,
  BELL_BOXES,
  BREWING_STAND_BOXES,
  CANDLE_CAKE_BOXES,
  CAULDRON_BOXES,
  GENERATED_SHAPE_CHEST_TYPE_NAMES,
  ONE_SIXTEENTH,
  SCAFFOLDING_BOXES,
  SHELF_TYPE_NAMES,
  isAnvilBlock,
  isAzaleaBlock,
  isBarBlock,
  isBedBlock,
  isCakeBlock,
  isCandleBlock,
  isCandleCakeBlock,
  isCarpetBlock,
  isCauldronBlock,
  isChainBlock,
  isChestLikeBlock,
  isCopperGolemStatueBlock,
  isDaylightDetectorBlock,
  isDoorBlock,
  isEndPortalFrameBlock,
  isFarmlandLikeBlock,
  isFenceBlock,
  isFenceGateBlock,
  isFlowerPotBlock,
  isHangingSignBlock,
  isHeadBlock,
  isLanternBlock,
  isLecternBlock,
  isMudBlock,
  isNoCollisionBlock,
  isNoCollisionTypeName,
  isPaneBlock,
  isPistonBlock,
  isPressurePlateBlock,
  isRodBlock,
  isSculkHalfHeightBlock,
  isSlabBlock,
  isSnowLayerBlock,
  isStairsBlock,
  isTrapdoorBlock,
  isWallBlock,
  resolveAmethystClusterBox,
  resolveAnvilBoxes,
  resolveAxisBox,
  resolveBigDripleafShape,
  resolveCakeShape,
  resolveCandleShape,
  resolveChorusPlantBoxes,
  resolveCocoaBoxes,
  resolveComposterBoxes,
  resolveDoorBoxes,
  resolveEndPortalFrameShape,
  resolveFacingRodBox,
  resolveFenceBoxes,
  resolveFenceGateShape,
  resolveGrindstoneBoxes,
  resolveHangingSignBoxes,
  resolveHeadBoxes,
  resolveHopperBoxes,
  resolveLadderBox,
  resolveLanternBoxes,
  resolveLecternBoxes,
  resolvePaneBoxes,
  resolvePistonHeadBoxes,
  resolvePistonShape,
  resolvePitcherPlantBox,
  resolvePointedDripstoneBoxes,
  resolvePressurePlateShape,
  resolveSeaPickleBoxes,
  resolveShelfBoxes,
  resolveSlabShape,
  resolveSnowLayerShape,
  resolveStairBoxes,
  resolveTaggedCustomBlockCollisionShape,
  resolveTrapdoorBoxes,
  resolveTurtleEggBoxes,
  resolveWallBoxes
};
