import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_COLLISION_SOURCE_DIRECTORY,
  ensureCollisionSourceFiles
} from "./collision-source-cache.mjs";

const SOURCE_COMMIT = "edfc78fe849b0203672a7fe1f533971ab56732d6";
const SOURCE_VERSION = "1.21.111";
const OUTPUT_FILE = "src/data/generated/bedrock-block-collision.generated.ts";

const sourceDirectory = process.argv[2] ?? DEFAULT_COLLISION_SOURCE_DIRECTORY;
await ensureCollisionSourceFiles(sourceDirectory);

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(sourceDirectory, name), "utf8"));
}

function normalizeStateValue(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function shapeToBoxes(shape) {
  if (shape === undefined || shape === null || shape.length === 0) return [];
  const boxes = Array.isArray(shape[0]) ? shape : [shape];
  return boxes.map((box) => {
    if (box.length !== 6 || box.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid collision box: ${JSON.stringify(box)}`);
    }
    const [centerX, centerY, centerZ, sizeX, sizeY, sizeZ] = box;
    return [
      centerX - sizeX / 2,
      centerY - sizeY / 2,
      centerZ - sizeZ / 2,
      centerX + sizeX / 2,
      centerY + sizeY / 2,
      centerZ + sizeZ / 2
    ];
  });
}

function buildCompressedSelector(states, shapeIds) {
  const stateNames = Object.keys(states[0].states);
  const relevantStateNames = stateNames.filter((stateName) => {
    const groups = new Map();
    for (let index = 0; index < states.length; index++) {
      const otherKey = stateNames
        .filter((candidate) => candidate !== stateName)
        .map((candidate) => normalizeStateValue(states[index].states[candidate].value))
        .join("\u001f");
      const values = groups.get(otherKey) ?? new Set();
      values.add(shapeIds[index]);
      groups.set(otherKey, values);
    }
    return [...groups.values()].some((values) => values.size > 1);
  });

  const tupleOrder = [];
  const tupleIndexes = new Map();
  const compressedShapeIds = [];
  for (let index = 0; index < states.length; index++) {
    const tuple = relevantStateNames
      .map((stateName) => normalizeStateValue(states[index].states[stateName].value))
      .join("\u001f");
    if (!tupleIndexes.has(tuple)) {
      tupleIndexes.set(tuple, tupleOrder.length);
      tupleOrder.push(tuple);
      compressedShapeIds.push(shapeIds[index]);
    }
  }

  const selectors = relevantStateNames.map((stateName) => {
    const values = new Map();
    for (const tuple of tupleOrder) {
      const value = tuple.split("\u001f")[relevantStateNames.indexOf(stateName)];
      if (!values.has(value)) values.set(value, tupleIndexes.get(tuple));
    }
    const offsets = {};
    for (const value of values.keys()) {
      const offset = [...tupleIndexes.entries()]
        .find(([tuple]) => tuple.split("\u001f")[relevantStateNames.indexOf(stateName)] === value)?.[1];
      offsets[value] = offset;
    }
    return { name: stateName, offsets };
  });

  for (const [tuple, index] of tupleIndexes) {
    const values = tuple.split("\u001f");
    const calculated = selectors.reduce((sum, selector, selectorIndex) => {
      return sum + selector.offsets[values[selectorIndex]];
    }, 0);
    if (calculated !== index) {
      throw new Error(`Collision state selector is not additive for tuple ${tuple}`);
    }
  }

  return { shapeIds: compressedShapeIds, selectors };
}

function validateAndBuild() {
  const blocks = readJson("blocks.json");
  const blockStates = readJson("blockStates.json");
  const collision = readJson("blockCollisionShapes.json");
  const blockNames = new Set(blocks.map((block) => block.name));
  const collisionNames = new Set(Object.keys(collision.blocks));

  if (blocks.length !== collisionNames.size || blocks.some((block) => !collisionNames.has(block.name))) {
    throw new Error("Vanilla block list and collision block list are not identical");
  }

  const shapeNames = Object.keys(collision.shapes);
  const shapeTable = shapeNames.map((shapeId) => shapeToBoxes(collision.shapes[shapeId]));
  const records = {};
  let stateCount = 0;

  for (const block of blocks) {
    const shapeIds = Array.isArray(collision.blocks[block.name])
      ? collision.blocks[block.name]
      : [collision.blocks[block.name]];
    const expectedStateCount = block.maxStateId - block.minStateId + 1;
    if (shapeIds.length !== expectedStateCount) {
      throw new Error(`${block.name} has ${shapeIds.length} shapes for ${expectedStateCount} states`);
    }
    stateCount += expectedStateCount;
    for (const shapeId of shapeIds) {
      if (!Number.isInteger(shapeId) || !shapeTable[shapeId]) {
        throw new Error(`${block.name} references invalid shape ${shapeId}`);
      }
    }

    const uniqueShapeIds = [...new Set(shapeIds)];
    if (uniqueShapeIds.length === 1) {
      records[block.name] = { shapeIds: uniqueShapeIds };
      continue;
    }

    const states = blockStates.slice(block.minStateId, block.maxStateId + 1);
    if (states.length !== expectedStateCount || states.some((state) => state.name !== block.name)) {
      throw new Error(`${block.name} state range is not aligned with blockStates.json`);
    }
    records[block.name] = buildCompressedSelector(states, shapeIds);
  }

  if (stateCount !== blockStates.length) {
    throw new Error(`State coverage mismatch: generated ${stateCount}, source has ${blockStates.length}`);
  }

  return { shapeTable, records, blockCount: blocks.length, stateCount };
}

const { shapeTable, records, blockCount, stateCount } = validateAndBuild();
const output = `// Generated from PrismarineJS/minecraft-data Bedrock ${SOURCE_VERSION}.\n// Source commit: ${SOURCE_COMMIT}\n// This file is generated; edit scripts/generators/bedrock-block-collision.mjs instead.\n\n` +
  `export const VANILLA_COLLISION_DATA_VERSION = "bedrock-${SOURCE_VERSION}" as const;\n` +
  `export const VANILLA_COLLISION_BLOCK_COUNT = ${blockCount} as const;\n` +
  `export const VANILLA_COLLISION_STATE_COUNT = ${stateCount} as const;\n\n` +
  `export interface VanillaCollisionSelector {\n  readonly name: string;\n  readonly offsets: Readonly<Record<string, number>>;\n}\n\n` +
  `export interface VanillaCollisionRecord {\n  readonly shapeIds: readonly number[];\n  readonly selectors?: readonly VanillaCollisionSelector[];\n}\n\n` +
  `export const VANILLA_COLLISION_SHAPES = ${JSON.stringify(shapeTable)} as const;\n\n` +
  `export const VANILLA_COLLISION_RECORDS: Readonly<Record<string, VanillaCollisionRecord>> = ${JSON.stringify(records)};\n`;

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, output, "utf8");
console.log(`[generate-bedrock-block-collision] ${blockCount} blocks, ${stateCount} states -> ${OUTPUT_FILE}`);
