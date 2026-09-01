// Decoders for the generated collision-shape tables: Bedrock's per-permutation
// vanilla records plus Sable's static and dynamic (state-keyed) shape indices.
import {
  VANILLA_COLLISION_RECORDS,
  VANILLA_COLLISION_SHAPES
} from "@src/data/BlockCollision";
import {
  SABLE_DYNAMIC_COLLISION_RECORDS,
  SABLE_STATIC_COLLISION_RECORDS,
  SABLE_STATIC_COLLISION_SHAPES
} from "@src/data/BlockCollisionReference";
import type {
  BlockCollisionBoxShapeDefinition,
  BlockCollisionShape
} from "./BlockShapeResolver";
import {
  getBlockNamespace,
  getPermutationState,
  type BlockCollisionShapeSource
} from "./BlockState";
import { FULL_SHAPE, NONE_SHAPE, box, partialShape } from "./ShapeGeometry";

function resolveGeneratedVanillaShape(
  block: BlockCollisionShapeSource,
  typeName: string
): BlockCollisionShape | undefined {
  if (getBlockNamespace(block) !== "minecraft") {
    return undefined;
  }

  const record = VANILLA_COLLISION_RECORDS[typeName];
  if (!record) {
    return undefined;
  }

  // The record stores a flat shapeIds array indexed with a mixed-radix code:
  // every selector maps its state value to an offset, and the offsets of all
  // selectors sum to the index. A state or state value the table does not
  // know means the table cannot be applied, so the caller falls back to the
  // manual rules.
  let shapeIndex = 0;
  for (const selector of record.selectors ?? []) {
    const value = getGeneratedStateValue(block, selector.name);
    if (value === undefined) {
      return undefined;
    }

    const offset = selector.offsets[value];
    if (offset === undefined) {
      return undefined;
    }
    shapeIndex += offset;
  }

  const shapeId = record.shapeIds[shapeIndex];
  if (shapeId === undefined) {
    return undefined;
  }

  const rawBoxes = VANILLA_COLLISION_SHAPES[shapeId] as readonly (readonly number[])[] | undefined;
  if (!rawBoxes) {
    return undefined;
  }

  return shapeFromDecodedBoxes(decodeShapeTableBoxes(rawBoxes));
}

function resolveSableStaticShape(typeName: string): BlockCollisionShape | undefined {
  const shapeIndex = SABLE_STATIC_COLLISION_RECORDS[typeName];
  if (shapeIndex === undefined) {
    return undefined;
  }

  const rawBoxes = SABLE_STATIC_COLLISION_SHAPES[shapeIndex] as readonly (readonly number[])[] | undefined;
  if (!rawBoxes) {
    return undefined;
  }

  return shapeFromDecodedBoxes(decodeShapeTableBoxes(rawBoxes));
}

function resolveSableDynamicBoxes(
  family: string,
  stateKey: string
): readonly BlockCollisionBoxShapeDefinition[] | undefined {
  const shapeIndex = SABLE_DYNAMIC_COLLISION_RECORDS[family]?.[stateKey];
  if (shapeIndex === undefined) return undefined;
  const rawBoxes = SABLE_STATIC_COLLISION_SHAPES[shapeIndex] as
    readonly (readonly number[])[] | undefined;
  if (!rawBoxes) return undefined;
  return decodeShapeTableBoxes(rawBoxes);
}

/**
 * Decodes one generated shape-table entry. Every row is a
 * [minX, minY, minZ, maxX, maxY, maxZ] 6-tuple by construction of the
 * generators (scripts/generators), so rows are converted without filtering.
 */
function decodeShapeTableBoxes(
  rawBoxes: readonly (readonly number[])[]
): readonly BlockCollisionBoxShapeDefinition[] {
  return rawBoxes.map(([minX, minY, minZ, maxX, maxY, maxZ]) =>
    box(minX, minY, minZ, maxX, maxY, maxZ)
  );
}

/** Collapses decoded table boxes into the canonical none/full/partial shape. */
function shapeFromDecodedBoxes(
  boxes: readonly BlockCollisionBoxShapeDefinition[]
): BlockCollisionShape {
  if (boxes.length === 0) {
    return NONE_SHAPE;
  }

  const onlyBox = boxes[0];
  if (
    boxes.length === 1
    && onlyBox.minX === 0
    && onlyBox.minY === 0
    && onlyBox.minZ === 0
    && onlyBox.maxX === 1
    && onlyBox.maxY === 1
    && onlyBox.maxZ === 1
  ) {
    return FULL_SHAPE;
  }

  return partialShape(boxes);
}

function getGeneratedStateValue(
  block: BlockCollisionShapeSource,
  stateName: string
): string | undefined {
  const candidates = stateName.startsWith("minecraft:")
    ? [stateName, stateName.slice("minecraft:".length)]
    : [stateName, `minecraft:${stateName}`];

  for (const candidate of candidates) {
    const value = getPermutationState(block, candidate);
    if (value !== undefined) {
      if (typeof value === "boolean") return value ? "1" : "0";
      return String(value);
    }
  }

  return undefined;
}

export {
  resolveGeneratedVanillaShape,
  resolveSableDynamicBoxes,
  resolveSableStaticShape
};
