import type { Block, Vector3 } from "@minecraft/server";
import {
  resolveBlockCollisionShape,
  type PhysicsContraptionBlock
} from "@src/Physics";
import {
  isFragilePlantTreeAttachment,
  isSupportedOrdinaryContraptionBlock,
  visualBlockRotation,
  visualItemTypeId,
  type CapturedTreeBlock,
  type TreeBlockKind
} from "@src/content/tree/block/Blocks";
import { createFragmentVisual } from "@src/render/contraption/fragment/FragmentVisual";

// Per-kind physical parameters of one contraption block (in whole-block units).
const TREE_BLOCK_PHYSICAL_PARAMETERS: Record<
  TreeBlockKind,
  { readonly buoyancyVolume: number; readonly mass: number }
> = {
  attachment: { buoyancyVolume: 0.1, mass: 0.1 },
  block: { buoyancyVolume: 1, mass: 1 },
  leaf: { buoyancyVolume: 0.125, mass: 0.0625 },
  log: { buoyancyVolume: 1, mass: 1 },
  root: { buoyancyVolume: 0.1, mass: 0.1 }
};
// Tuned chest-only override of the ordinary block mass.
const CHEST_MASS = 0.5;

export function createContraptionBlock(
  block: CapturedTreeBlock,
  origin: Vector3,
  liveBlock?: Block
): PhysicsContraptionBlock {
  const collisionShape = resolveContraptionCollisionShape(block, liveBlock);
  const isChest = block.typeId === "minecraft:chest";
  const parameters = TREE_BLOCK_PHYSICAL_PARAMETERS[block.kind];
  return {
    buoyancyVolume: parameters.buoyancyVolume,
    collidable: collisionShape !== "none",
    collisionResponse: block.kind !== "leaf" && !isFragilePlantTreeAttachment(block.typeId),
    collisionShape,
    itemTypeId: visualItemTypeId(block),
    localLocation: {
      x: block.location.x - origin.x,
      y: block.location.y - origin.y,
      z: block.location.z - origin.z
    },
    mass: block.kind === "block" && isChest ? CHEST_MASS : parameters.mass,
    rotation: visualBlockRotation(block),
    runtimeCollidable: block.kind !== "leaf",
    typeId: block.typeId,
    visual: createFragmentVisual(block)
  };
}

export function resolveContraptionCollisionShape(
  block: CapturedTreeBlock,
  liveBlock?: Block
): NonNullable<PhysicsContraptionBlock["collisionShape"]> {
  if (block.kind === "log" || block.kind === "leaf") return "full";
  if (block.kind === "block") {
    if (!isSupportedOrdinaryContraptionBlock(block.typeId)) return "none";
    // A vanilla chest body is inset by one pixel horizontally and is fourteen
    // pixels tall. Its small front lock is visual only for contraption physics.
    return [{
      min: { x: 1 / 16, y: 0, z: 1 / 16 },
      max: { x: 15 / 16, y: 14 / 16, z: 15 / 16 }
    }];
  }
  if (block.kind !== "attachment") return "none";
  if (isFragilePlantTreeAttachment(block.typeId)) return "full";

  const source = liveBlock ?? capturedBlockCollisionSource(block);
  const resolved = resolveBlockCollisionShape(source as never);
  if (resolved.kind === "none") return "none";
  if (resolved.kind === "full") return "full";
  return resolved.shapes.map(box => ({
    min: { x: box.minX, y: box.minY, z: box.minZ },
    max: { x: box.maxX, y: box.maxY, z: box.maxZ }
  }));
}

function capturedBlockCollisionSource(block: CapturedTreeBlock) {
  return {
    blockTypeId: block.typeId,
    permutation: {
      getAllStates: () => ({ ...block.states }),
      getState: (name: string) => block.states[name],
      getTags: () => [],
      hasTag: () => false
    }
  };
}
