import type { ItemStack } from "@minecraft/server";
import {
  getTreeFellingToolProfile,
  getVanillaBlockBreakTicks,
  type TreeFellingToolProfile
} from "@src/content/tree/felling/Speed";
import type { TreeBlockKind } from "@src/content/tree/block/Blocks";

// The attack-mining scale is anchored to the iron golem: bare-handed, breaking
// its construction recipe (four iron blocks plus one carved pumpkin) takes
// IRON_GOLEM_REFERENCE_BREAK_TICKS, and the golem has 100 max health, so each
// attack contributes the recipe's break time per health point.
const IRON_GOLEM_MINING_HEALTH = 100;
const IRON_BLOCK_HARDNESS = 5;
const PUMPKIN_HARDNESS = 1;
const REFERENCE_TOOL_PROFILE: TreeFellingToolProfile = { efficiencyLevel: 0 };
export const IRON_GOLEM_REFERENCE_BREAK_TICKS =
  4 * getVanillaBlockBreakTicks(IRON_BLOCK_HARDNESS, REFERENCE_TOOL_PROFILE)
  + getVanillaBlockBreakTicks(PUMPKIN_HARDNESS, REFERENCE_TOOL_PROFILE);
export const PC_ATTACK_EQUIVALENT_TICKS =
  IRON_GOLEM_REFERENCE_BREAK_TICKS / IRON_GOLEM_MINING_HEALTH;

/**
 * Converts vanilla block-breaking time into the iron-golem scale. The four
 * iron blocks and pumpkin are a fixed baseline; only the target block uses the
 * player's selected tool, otherwise tool speed would cancel out of the ratio.
 */
export function getTreeMiningRequiredHits(
  kind: Exclude<TreeBlockKind, "root">,
  typeId: string,
  itemStack?: ItemStack
): number {
  const targetTicks = getTreeMiningTargetTicks(kind, typeId, itemStack);
  return Math.max(
    1,
    Math.ceil(targetTicks / PC_ATTACK_EQUIVALENT_TICKS)
  );
}

export function getTreeMiningTargetTicks(
  kind: Exclude<TreeBlockKind, "root">,
  typeId: string,
  itemStack?: ItemStack
): number {
  return getTreeBlockBreakTicks(kind, typeId, getTreeFellingToolProfile(itemStack));
}

function getTreeBlockBreakTicks(
  kind: Exclude<TreeBlockKind, "root">,
  typeId: string,
  profile: TreeFellingToolProfile
): number {
  if (kind === "log") return getVanillaBlockBreakTicks(LOG_HARDNESS, profile);
  if (kind === "leaf") return getVanillaBlockBreakTicks(LEAF_HARDNESS, profile);
  const hardness = EDITABLE_BLOCK_HARDNESS[typeId];
  if (hardness === undefined) {
    throw new RangeError(`Unsupported contraption block mining hardness: ${typeId}.`);
  }
  return getVanillaBlockBreakTicks(hardness, profile);
}

// Vanilla hardness values; LOG_HARDNESS mirrors the same-named constant in
// gameplay/tree-felling-speed.ts.
const LOG_HARDNESS = 2;
const LEAF_HARDNESS = 0.2;

// Keys are the attachment set from tree/blocks.ts (ATTACHMENT_TYPE_IDS) plus
// the chest. tree/contraption-visual.ts and tree/attachment-performance.ts keep
// sibling per-typeId tables, so a new attachment needs parallel entries there.
const EDITABLE_BLOCK_HARDNESS: Readonly<Record<string, number>> = {
  "minecraft:bee_nest": 0.3,
  "minecraft:chest": 2.5,
  "minecraft:cocoa": 0.2,
  "minecraft:hanging_roots": 0.2,
  "minecraft:mangrove_propagule": 0.2,
  "minecraft:pale_hanging_moss": 0.2,
  "minecraft:vine": 0.2
};
