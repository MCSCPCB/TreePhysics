// Box geometry for block collision shapes: canonical none/full shape values,
// quarter-turn rotations about the block center, and the box constructors
// shared by the resolver dispatch, table decoders, and per-family rules.
import type {
  BlockCollisionBoxShapeDefinition,
  BlockCollisionShape
} from "./BlockShapeResolver";

const FULL_BOX: BlockCollisionBoxShapeDefinition = box(0, 0, 0, 1, 1, 1);
const NONE_SHAPE: BlockCollisionShape = { kind: "none", shapes: [] };
const FULL_SHAPE: BlockCollisionShape = { kind: "full", shapes: [FULL_BOX] };

function normalizeQuarterTurns(value: number): number {
  return ((Math.floor(value) % 4) + 4) % 4;
}

function rotateBoxesY(
  boxes: readonly BlockCollisionBoxShapeDefinition[],
  quarterTurns: number
): readonly BlockCollisionBoxShapeDefinition[] {
  const turns = normalizeQuarterTurns(quarterTurns);
  if (turns === 0) {
    return boxes;
  }

  return boxes.map((entry) => rotateBoxY(entry, turns));
}

function rotateBoxesX(
  boxes: readonly BlockCollisionBoxShapeDefinition[],
  quarterTurns: number
): readonly BlockCollisionBoxShapeDefinition[] {
  const turns = normalizeQuarterTurns(quarterTurns);
  if (turns === 0) {
    return boxes;
  }

  return boxes.map((entry) => rotateBoxX(entry, turns));
}

function rotateBoxY(
  entry: BlockCollisionBoxShapeDefinition,
  quarterTurns: number
): BlockCollisionBoxShapeDefinition {
  let minX = entry.minX;
  let minZ = entry.minZ;
  let maxX = entry.maxX;
  let maxZ = entry.maxZ;

  for (let turn = 0; turn < quarterTurns; turn++) {
    const nextMinX = 1 - maxZ;
    const nextMaxX = 1 - minZ;
    const nextMinZ = minX;
    const nextMaxZ = maxX;
    minX = nextMinX;
    maxX = nextMaxX;
    minZ = nextMinZ;
    maxZ = nextMaxZ;
  }

  return box(minX, entry.minY, minZ, maxX, entry.maxY, maxZ);
}

function rotateBoxX(
  entry: BlockCollisionBoxShapeDefinition,
  quarterTurns: number
): BlockCollisionBoxShapeDefinition {
  let minY = entry.minY;
  let minZ = entry.minZ;
  let maxY = entry.maxY;
  let maxZ = entry.maxZ;

  for (let turn = 0; turn < quarterTurns; turn++) {
    const nextMinY = 1 - maxZ;
    const nextMaxY = 1 - minZ;
    const nextMinZ = minY;
    const nextMaxZ = maxY;
    minY = nextMinY;
    maxY = nextMaxY;
    minZ = nextMinZ;
    maxZ = nextMaxZ;
  }

  return box(entry.minX, minY, minZ, entry.maxX, maxY, maxZ);
}

function partialShape(boxes: readonly BlockCollisionBoxShapeDefinition[]): BlockCollisionShape {
  const validBoxes = boxes.filter((entry) =>
    entry.maxX > entry.minX &&
    entry.maxY > entry.minY &&
    entry.maxZ > entry.minZ
  );

  return validBoxes.length === 0
    ? NONE_SHAPE
    : { kind: "partial", shapes: validBoxes };
}

function centeredBox(
  sizeX: number,
  minY: number,
  sizeZ: number,
  maxY: number
): BlockCollisionBoxShapeDefinition {
  const minX = (1 - sizeX) * 0.5;
  const minZ = (1 - sizeZ) * 0.5;
  return box(minX, minY, minZ, minX + sizeX, maxY, minZ + sizeZ);
}

function modelBox(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): BlockCollisionBoxShapeDefinition {
  return box(minX / 16, minY / 16, minZ / 16, maxX / 16, maxY / 16, maxZ / 16);
}

function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): BlockCollisionBoxShapeDefinition {
  return {
    type: "box",
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ
  };
}

export {
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
};
