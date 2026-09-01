// Public surface of the block collision resolver: the resolveBlockCollisionShape
// dispatch entry, the resolution-plan metadata consumed by cannon-kernel, and the
// shared shape types. Implementations live in the sibling shape and block-state
// modules.
import { VANILLA_COLLISION_RECORDS } from "@src/data/BlockCollision";
import {
  SABLE_COLLISION_BLOCK_RECORDS,
  SABLE_STATIC_COLLISION_RECORDS
} from "@src/data/BlockCollisionReference";
import {
  getBlockNamespace,
  getBlockTypeName,
  isEmptyLiveBlock,
  isLiveCustomBlockPassable,
  type BlockCollisionShapeSource
} from "./BlockState";
import {
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
} from "./ShapeFamilies";
import {
  FULL_SHAPE,
  NONE_SHAPE,
  box,
  centeredBox,
  modelBox,
  partialShape
} from "./ShapeGeometry";
import {
  resolveGeneratedVanillaShape,
  resolveSableStaticShape
} from "./ShapeTables";

export type BlockCollisionShape = { readonly kind: "none" | "full"; readonly shapes: readonly BlockCollisionBoxShapeDefinition[] } | { readonly kind: "partial"; readonly shapes: readonly BlockCollisionBoxShapeDefinition[] };

export interface BlockCollisionBoxShapeDefinition {
  readonly type: "box";
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export type VanillaCollisionResolutionSource =
  | "manual-context"
  | "manual-neighbor"
  | "manual-no-collision"
  | "manual-state"
  | "manual-static"
  | "sable-static"
  | "bedrock-generated"
  | "unknown";

export type VanillaCollisionEvidenceSource = "sable" | "bedrock" | "manual-inference";

export type VanillaCollisionImplementation =
  | "context-rule"
  | "neighbor-rule"
  | "state-rule"
  | "static-rule"
  | "generated-table"
  | "unresolved";

export interface VanillaCollisionResolutionPlan {
  readonly contextDependent: boolean;
  readonly evidence: VanillaCollisionEvidenceSource;
  readonly implementation: VanillaCollisionImplementation;
  readonly neighborDependent: boolean;
  readonly source: VanillaCollisionResolutionSource;
  readonly stateDependent: boolean;
}

const FIFTEEN_SIXTEENTHS = 15 / 16;
const FOURTEEN_SIXTEENTHS = 14 / 16;
const ROD_WIDTH = 4 / 16;
const CHAIN_WIDTH = 19 / 32;

export function getVanillaCollisionResolutionPlan(
  typeId: string
): VanillaCollisionResolutionPlan {
  // Keeps everything after the first colon, unlike getBlockTypeName which
  // takes only the segment between the first and second colon. The two only
  // diverge for typeIds containing two or more colons.
  const typeName = typeId.includes(":") ? typeId.slice(typeId.indexOf(":") + 1) : typeId;
  if (SABLE_STATIC_COLLISION_RECORDS[typeName] !== undefined) {
    return resolutionPlan(typeName, "sable-static", false, false, false);
  }
  if (typeName === "scaffolding" || typeName === "powder_snow") {
    return resolutionPlan(typeName, "manual-context", true, false, true);
  }
  if (
    typeName === "chorus_plant"
    || isStairsBlock(typeName)
    || isFenceBlock(typeName)
    || isWallBlock(typeName)
    || isPaneBlock(typeName)
    || isBarBlock(typeName)
  ) {
    return resolutionPlan(typeName, "manual-neighbor", true, true, false);
  }
  if (isNoCollisionTypeName(typeName)) {
    return resolutionPlan(typeName, "manual-no-collision", false, false, false);
  }
  if (
    typeName === "ladder"
    || isHangingSignBlock(typeName)
    || isPressurePlateBlock(typeName)
    || isSnowLayerBlock(typeName)
    || isRodBlock(typeName)
    || isChainBlock(typeName)
    || typeName === "composter"
    || typeName === "hopper"
    || isAnvilBlock(typeName)
    || isLanternBlock(typeName)
    || isLecternBlock(typeName)
    || typeName === "grindstone"
    || typeName === "turtle_egg"
    || typeName === "sea_pickle"
    || typeName === "pointed_dripstone"
    || typeName === "cocoa"
    || typeName === "big_dripleaf"
    || isPistonBlock(typeName)
    || typeName === "piston_head"
    || typeName === "piston_arm_collision"
    || isHeadBlock(typeName)
    || typeName === "amethyst_cluster"
    || typeName === "large_amethyst_bud"
    || typeName === "medium_amethyst_bud"
    || typeName === "small_amethyst_bud"
    || typeName === "pitcher_plant"
    || SHELF_TYPE_NAMES.has(typeName)
    || isCandleBlock(typeName)
    || isCakeBlock(typeName)
    || isEndPortalFrameBlock(typeName)
    || isSlabBlock(typeName)
    || isTrapdoorBlock(typeName)
    || isDoorBlock(typeName)
    || isFenceGateBlock(typeName)
  ) {
    return resolutionPlan(typeName, "manual-state", true, false, false);
  }
  if (
    isCarpetBlock(typeName)
    || isDaylightDetectorBlock(typeName)
    || isBedBlock(typeName)
    || isFarmlandLikeBlock(typeName)
    || isMudBlock(typeName)
    || isChestLikeBlock(typeName)
    || typeName === "honey_block"
    || typeName === "soul_sand"
    || typeName === "cactus"
    || typeName === "enchanting_table"
    || typeName === "stonecutter"
    || typeName === "stonecutter_block"
    || typeName === "campfire"
    || typeName === "soul_campfire"
    || typeName === "lily_pad"
    || typeName === "dragon_egg"
    || typeName === "decorated_pot"
    || typeName === "conduit"
    || isCauldronBlock(typeName)
    || typeName === "brewing_stand"
    || typeName === "bamboo"
    || typeName === "bell"
    || isAzaleaBlock(typeName)
    || isCandleCakeBlock(typeName)
    || typeName === "heavy_core"
    || typeName === "sniffer_egg"
    || typeName === "dried_ghast"
    || isCopperGolemStatueBlock(typeName)
    || isFlowerPotBlock(typeName)
    || isSculkHalfHeightBlock(typeName)
    || typeName === "unpowered_repeater"
    || typeName === "powered_repeater"
    || typeName === "unpowered_comparator"
    || typeName === "powered_comparator"
    || typeName.endsWith("_repeater")
    || typeName.endsWith("_comparator")
  ) {
    return resolutionPlan(typeName, "manual-static", false, false, false);
  }
  const generatedRecord = VANILLA_COLLISION_RECORDS[typeName];
  if (generatedRecord !== undefined) {
    const stateDependent = (generatedRecord.selectors?.length ?? 0) > 0;
    return resolutionPlan(typeName, "bedrock-generated", stateDependent, false, false);
  }
  return resolutionPlan(typeName, "unknown", false, false, false);
}

function resolutionPlan(
  typeName: string,
  source: VanillaCollisionResolutionSource,
  stateDependent: boolean,
  neighborDependent: boolean,
  contextDependent: boolean
): VanillaCollisionResolutionPlan {
  return {
    contextDependent,
    evidence: getResolutionEvidence(typeName, source),
    implementation: getResolutionImplementation(source),
    neighborDependent,
    source,
    stateDependent
  };
}

function getResolutionEvidence(
  typeName: string,
  source: VanillaCollisionResolutionSource
): VanillaCollisionEvidenceSource {
  if (source === "sable-static") return "sable";
  if (source === "bedrock-generated") return "bedrock";
  if (
    SABLE_COLLISION_BLOCK_RECORDS[typeName]
    && (
      source === "manual-neighbor"
      || source === "manual-context"
      || (source === "manual-state" && isVerifiedSableStateRule(typeName))
    )
  ) {
    return "sable";
  }
  if (VANILLA_COLLISION_RECORDS[typeName]) return "bedrock";
  return "manual-inference";
}

function isVerifiedSableStateRule(typeName: string): boolean {
  return typeName === "ladder"
    || typeName === "cake"
    || typeName === "cocoa"
    || typeName === "turtle_egg"
    || typeName === "sea_pickle"
    || isLanternBlock(typeName)
    || isCandleBlock(typeName)
    || isEndPortalFrameBlock(typeName)
    || isTrapdoorBlock(typeName)
    || isDoorBlock(typeName);
}

function getResolutionImplementation(
  source: VanillaCollisionResolutionSource
): VanillaCollisionImplementation {
  if (source === "manual-context") return "context-rule";
  if (source === "manual-neighbor") return "neighbor-rule";
  if (source === "manual-state") return "state-rule";
  if (source === "bedrock-generated") return "generated-table";
  if (source === "unknown") return "unresolved";
  return "static-rule";
}

export function resolveBlockCollisionShape(
  block: BlockCollisionShapeSource | undefined
): BlockCollisionShape {
  if (!block || isEmptyLiveBlock(block)) {
    return NONE_SHAPE;
  }

  const typeName = getBlockTypeName(block);
  const taggedCustomShape = resolveTaggedCustomBlockCollisionShape(block);
  if (taggedCustomShape) {
    return taggedCustomShape;
  }

  if (isLiveCustomBlockPassable(block)) {
    return NONE_SHAPE;
  }

  // Sable's BlockState#getCollisionShape result is authoritative whenever it
  // is state-invariant. Dynamic rules below exist only where a static shape
  // cannot represent Sable's state, neighbor, or collision-context behavior.
  if (getBlockNamespace(block) === "minecraft") {
    const sableStaticShape = resolveSableStaticShape(typeName);
    if (sableStaticShape) {
      return sableStaticShape;
    }
  }

  if (isNoCollisionBlock(typeName, block)) {
    return NONE_SHAPE;
  }

  if (typeName === "ladder") {
    return partialShape([resolveLadderBox(block)]);
  }

  if (isHangingSignBlock(typeName)) {
    const generatedHangingSignShape = resolveGeneratedVanillaShape(block, typeName);
    if (generatedHangingSignShape) return generatedHangingSignShape;
    return partialShape(resolveHangingSignBoxes(block));
  }

  if (isCarpetBlock(typeName)) {
    return partialShape([box(0, 0, 0, 1, ONE_SIXTEENTH, 1)]);
  }

  if (isPressurePlateBlock(typeName)) {
    return resolvePressurePlateShape(block);
  }

  if (isDaylightDetectorBlock(typeName)) {
    return partialShape([box(0, 0, 0, 1, 6 / 16, 1)]);
  }

  if (isBedBlock(typeName)) {
    return partialShape([modelBox(0, 0, 0, 16, 9, 16)]);
  }

  if (isSnowLayerBlock(typeName)) {
    return resolveSnowLayerShape(block);
  }

  if (isFarmlandLikeBlock(typeName)) {
    return partialShape([box(0, 0, 0, 1, FIFTEEN_SIXTEENTHS, 1)]);
  }

  if (isMudBlock(typeName)) {
    return partialShape([box(0, 0, 0, 1, FOURTEEN_SIXTEENTHS, 1)]);
  }

  if (isChestLikeBlock(typeName)) {
    if (GENERATED_SHAPE_CHEST_TYPE_NAMES.has(typeName)) {
      const generatedChestShape = resolveGeneratedVanillaShape(block, typeName);
      if (generatedChestShape && generatedChestShape.kind !== "none") {
        return generatedChestShape;
      }
    }
    return partialShape([centeredBox(FOURTEEN_SIXTEENTHS, 0, FOURTEEN_SIXTEENTHS, FOURTEEN_SIXTEENTHS)]);
  }

  if (typeName === "honey_block") {
    return partialShape([centeredBox(FOURTEEN_SIXTEENTHS, 0, FOURTEEN_SIXTEENTHS, FIFTEEN_SIXTEENTHS)]);
  }

  if (typeName === "soul_sand") {
    return partialShape([box(0, 0, 0, 1, FOURTEEN_SIXTEENTHS, 1)]);
  }

  if (typeName === "cactus") {
    return partialShape([box(ONE_SIXTEENTH, 0, ONE_SIXTEENTH, FIFTEEN_SIXTEENTHS, FIFTEEN_SIXTEENTHS, FIFTEEN_SIXTEENTHS)]);
  }

  if (typeName === "enchanting_table") {
    return partialShape([modelBox(0, 0, 0, 16, 12, 16)]);
  }

  if (typeName === "stonecutter" || typeName === "stonecutter_block") {
    return partialShape([modelBox(0, 0, 0, 16, 9, 16)]);
  }

  if (typeName === "campfire" || typeName === "soul_campfire") {
    return partialShape([modelBox(0, 0, 0, 16, 7, 16)]);
  }

  if (typeName === "lily_pad") {
    return partialShape([box(0, 0, 0, 1, 3 / 32, 1)]);
  }

  if (isRodBlock(typeName)) {
    return partialShape([resolveFacingRodBox(block, ROD_WIDTH)]);
  }

  if (isChainBlock(typeName)) {
    return partialShape([resolveAxisBox(block, CHAIN_WIDTH)]);
  }

  if (typeName === "dragon_egg" || typeName === "decorated_pot") {
    return partialShape([centeredBox(FIFTEEN_SIXTEENTHS, 0, FIFTEEN_SIXTEENTHS, 1)]);
  }

  if (typeName === "conduit") {
    return partialShape([centeredBox(11 / 16, 0, 11 / 16, 11 / 16)]);
  }

  if (isCauldronBlock(typeName)) {
    return partialShape(CAULDRON_BOXES);
  }

  if (typeName === "composter") {
    return partialShape(resolveComposterBoxes(block));
  }

  if (typeName === "hopper") {
    return partialShape(resolveHopperBoxes(block));
  }

  if (isAnvilBlock(typeName)) {
    return partialShape(resolveAnvilBoxes(block));
  }

  if (typeName === "brewing_stand") {
    return partialShape(BREWING_STAND_BOXES);
  }

  if (isLanternBlock(typeName)) {
    return partialShape(resolveLanternBoxes(block));
  }

  if (typeName === "scaffolding") {
    return partialShape(SCAFFOLDING_BOXES);
  }

  if (isLecternBlock(typeName)) {
    return partialShape(resolveLecternBoxes(block));
  }

  if (typeName === "grindstone") {
    const generatedGrindstoneShape = resolveGeneratedVanillaShape(block, typeName);
    if (generatedGrindstoneShape) return generatedGrindstoneShape;
    return partialShape(resolveGrindstoneBoxes(block));
  }

  if (typeName === "turtle_egg") {
    return partialShape(resolveTurtleEggBoxes(block));
  }

  if (typeName === "sea_pickle") {
    return partialShape(resolveSeaPickleBoxes(block));
  }

  if (typeName === "pointed_dripstone") {
    return partialShape(resolvePointedDripstoneBoxes(block));
  }

  if (typeName === "cocoa") {
    return partialShape(resolveCocoaBoxes(block));
  }

  if (typeName === "bamboo") {
    return partialShape([modelBox(7, 0, 7, 9, 16, 9)]);
  }

  if (typeName === "big_dripleaf") {
    return resolveBigDripleafShape(block);
  }

  if (isPistonBlock(typeName)) {
    return resolvePistonShape(block);
  }

  if (typeName === "piston_head" || typeName === "piston_arm_collision") {
    return partialShape(resolvePistonHeadBoxes(block));
  }

  if (isHeadBlock(typeName)) {
    const generatedHeadShape = resolveGeneratedVanillaShape(block, typeName);
    if (generatedHeadShape) return generatedHeadShape;
    return partialShape(resolveHeadBoxes(block, typeName));
  }

  if (typeName === "amethyst_cluster" ||
    typeName === "large_amethyst_bud" ||
    typeName === "medium_amethyst_bud" ||
    typeName === "small_amethyst_bud") {
    return partialShape([resolveAmethystClusterBox(block, typeName)]);
  }

  if (typeName === "bell") {
    const generatedBellShape = resolveGeneratedVanillaShape(block, typeName);
    if (generatedBellShape) return generatedBellShape;
    return partialShape(BELL_BOXES);
  }

  if (typeName === "chorus_plant") {
    return partialShape(resolveChorusPlantBoxes(block));
  }

  if (isAzaleaBlock(typeName)) {
    return partialShape(AZALEA_BOXES);
  }

  if (isCandleCakeBlock(typeName)) {
    return partialShape(CANDLE_CAKE_BOXES);
  }

  if (typeName === "pitcher_plant") {
    return partialShape([resolvePitcherPlantBox(block)]);
  }

  if (typeName === "heavy_core") {
    return partialShape([modelBox(4, 0, 4, 12, 8, 12)]);
  }

  if (typeName === "sniffer_egg") {
    return partialShape([modelBox(1, 0, 2, 15, 16, 14)]);
  }

  if (typeName === "dried_ghast") {
    return partialShape([modelBox(3, 0, 3, 13, 10, 13)]);
  }

  if (SHELF_TYPE_NAMES.has(typeName)) {
    return partialShape(resolveShelfBoxes(block));
  }

  if (isCopperGolemStatueBlock(typeName)) {
    return partialShape([centeredBox(10 / 16, 0, 10 / 16, 14 / 16)]);
  }

  if (isCandleBlock(typeName)) {
    return resolveCandleShape(block);
  }

  if (isCakeBlock(typeName)) {
    return resolveCakeShape(block);
  }

  if (isFlowerPotBlock(typeName)) {
    return partialShape([centeredBox(6 / 16, 0, 6 / 16, 6 / 16)]);
  }

  if (isEndPortalFrameBlock(typeName)) {
    return resolveEndPortalFrameShape(block);
  }

  if (isSculkHalfHeightBlock(typeName)) {
    return partialShape([modelBox(0, 0, 0, 16, 8, 16)]);
  }

  if (typeName === "unpowered_repeater" || typeName === "powered_repeater" ||
    typeName === "unpowered_comparator" || typeName === "powered_comparator" ||
    typeName.endsWith("_repeater") || typeName.endsWith("_comparator")) {
    return partialShape([modelBox(0, 0, 0, 16, 2, 16)]);
  }

  if (isSlabBlock(typeName)) {
    return resolveSlabShape(block);
  }

  if (isStairsBlock(typeName)) {
    return partialShape(resolveStairBoxes(block));
  }

  if (isTrapdoorBlock(typeName)) {
    return partialShape(resolveTrapdoorBoxes(block));
  }

  if (isDoorBlock(typeName)) {
    const generatedDoorShape = resolveGeneratedVanillaShape(block, typeName);
    if (generatedDoorShape) return generatedDoorShape;
    return partialShape(resolveDoorBoxes(block));
  }

  if (isFenceGateBlock(typeName)) {
    return resolveFenceGateShape(block);
  }

  if (isFenceBlock(typeName)) {
    return partialShape(resolveFenceBoxes(block));
  }

  if (isWallBlock(typeName)) {
    return partialShape(resolveWallBoxes(block));
  }

  if (isPaneBlock(typeName) || isBarBlock(typeName)) {
    return partialShape(resolvePaneBoxes(block));
  }

  const generatedVanillaShape = resolveGeneratedVanillaShape(block, typeName);
  if (generatedVanillaShape) {
    return generatedVanillaShape;
  }

  return FULL_SHAPE;
}
