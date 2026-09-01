import type { ItemStack } from "@minecraft/server";

// Vanilla break-time model for a correct tool: ticks = hardness * 30 / speed,
// with log hardness 2 and an efficiency enchantment adding level^2 + 1 speed.
const LOG_HARDNESS = 2;
const HARVEST_DIVISOR = 30;

const AXE_SPEEDS: Readonly<Record<string, number>> = {
  "minecraft:copper_axe": 5,
  "minecraft:diamond_axe": 8,
  "minecraft:golden_axe": 12,
  "minecraft:iron_axe": 6,
  "minecraft:netherite_axe": 9,
  "minecraft:stone_axe": 4,
  "minecraft:wooden_axe": 2
};

export interface TreeFellingToolProfile {
  /** Always a normalized non-negative integer (see normalizeEfficiencyLevel). */
  efficiencyLevel: number;
  typeId?: string;
}

export function getTreeFellingToolProfile(
  itemStack: ItemStack | undefined
): TreeFellingToolProfile {
  let efficiencyLevel = 0;
  try {
    efficiencyLevel = itemStack
      ?.getComponent("minecraft:enchantable")
      ?.getEnchantment("minecraft:efficiency")
      ?.level ?? 0;
  } catch {
    // Unknown or custom enchantment components fall back to the vanilla base speed.
  }
  return {
    efficiencyLevel: normalizeEfficiencyLevel(efficiencyLevel),
    typeId: itemStack?.typeId
  };
}

export function getVanillaLogBreakTicks(profile: TreeFellingToolProfile): number {
  return getVanillaBlockBreakTicks(LOG_HARDNESS, profile);
}

export function getVanillaBlockBreakTicks(
  hardness: number,
  profile: TreeFellingToolProfile
): number {
  const axeSpeed = profile.typeId ? AXE_SPEEDS[profile.typeId] : undefined;
  let speed = axeSpeed ?? 1;
  if (axeSpeed !== undefined && profile.efficiencyLevel > 0) {
    // Vanilla efficiency bonus: level^2 + 1 added to the tool speed.
    speed += profile.efficiencyLevel * profile.efficiencyLevel + 1;
  }
  return Math.ceil(Math.max(0, hardness) * HARVEST_DIVISOR / speed);
}

function normalizeEfficiencyLevel(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
