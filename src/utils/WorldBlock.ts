import type { Vector3 } from "@minecraft/server";

/** Every dimension that can host physics content; used to sweep world-scoped state. */
export const VANILLA_DIMENSION_IDS = [
  "minecraft:overworld",
  "minecraft:nether",
  "minecraft:the_end"
] as const;

export interface BlockDimensionLike<TBlock> {
  getBlock(location: Vector3): TBlock | undefined;
}

/** World reads throw when the target chunk is unavailable; callers intentionally receive undefined. */
export function safeGetBlock<TBlock>(
  dimension: BlockDimensionLike<TBlock>,
  location: Vector3
): TBlock | undefined {
  try {
    return dimension.getBlock(location);
  } catch {
    return undefined;
  }
}
