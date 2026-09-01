import {
  ListBlockVolume,
  type Block,
  type Dimension,
  type Vector3
} from "@minecraft/server";
import { blockKey } from "@src/utils/BlockKey";

const NON_AIR_BLOCK_FILTER = { excludeTypes: ["minecraft:air"] };

/**
 * Resolves a sparse set of probe locations through one native dimension query.
 * Air and unloaded locations are absent from the result; callers only cross the
 * script/native boundary again for locations that actually contain a block.
 * Map keys use the `x,y,z` integer format of the probed location, matching the
 * keys consumers build for their own probe locations.
 */
export function readWorldBlockProbeBatch(
  dimension: Dimension,
  /** Owned by this call; the array is handed to the native volume unchanged. */
  locations: Vector3[]
): Map<string, Block> {
  if (locations.length === 0) return new Map();

  const matching = dimension.getBlocks(
    new ListBlockVolume(locations),
    NON_AIR_BLOCK_FILTER,
    true
  );
  const blocks = new Map<string, Block>();
  for (const location of matching.getBlockLocationIterator()) {
    const block = dimension.getBlock(location);
    // getBlocks resolved these locations synchronously just above with unloaded
    // chunks excluded, so an undefined block here is not an expected outcome.
    if (block) blocks.set(blockKey(location), block);
  }
  return blocks;
}
