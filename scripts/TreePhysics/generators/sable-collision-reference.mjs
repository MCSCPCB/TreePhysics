import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_COLLISION_SOURCE_DIRECTORY,
  ensureCollisionSourceFiles
} from "./collision-source-cache.mjs";

const SOURCE_COMMIT = "d7c753a903c5cfee967db04b7f4b146ba8f8d375";
const SOURCE_VERSION = "1.21.4";
const OUTPUT_FILE = "src/data/generated/sable-collision-reference.generated.ts";

const sourceDirectory = process.argv[2] ?? DEFAULT_COLLISION_SOURCE_DIRECTORY;
await ensureCollisionSourceFiles(sourceDirectory);

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(sourceDirectory, name), "utf8"));
}

function shapeToBoxes(shape) {
  if (!shape || shape.length === 0) return [];
  const boxes = Array.isArray(shape[0]) ? shape : [shape];
  return boxes.map((box) => {
    if (box.length !== 6 || box.some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid Java collision box: ${JSON.stringify(box)}`);
    }
    // Sable's RapierVoxelColliderBakery clips every vanilla voxel box to the
    // unit block before creating colliders, including fences and walls.
    return [
      Math.max(box[0], 0),
      Math.max(box[1], 0),
      Math.max(box[2], 0),
      Math.min(box[3], 1),
      Math.min(box[4], 1),
      Math.min(box[5], 1)
    ];
  });
}

const blocks = readJson("pc-blocks.json");
const collision = readJson("pc-blockCollisionShapes.json");
const shapes = [];
const shapeIndexes = new Map();
const records = {};
const blockNames = [];
const dynamicRecords = {};

function getShapeIndex(shapeId) {
  const boxes = shapeToBoxes(collision.shapes[shapeId]);
  const key = JSON.stringify(boxes);
  let index = shapeIndexes.get(key);
  if (index === undefined) {
    index = shapes.length;
    shapes.push(boxes);
    shapeIndexes.set(key, index);
  }
  return index;
}

for (const block of blocks) {
  blockNames.push(block.name);
  const stateShapeIds = Array.isArray(collision.blocks[block.name])
    ? collision.blocks[block.name]
    : [collision.blocks[block.name]];
  if (stateShapeIds.length === 0 || stateShapeIds.some((shapeId) => shapeId === undefined)) continue;
  const uniqueShapeIds = [...new Set(stateShapeIds)];
  if (uniqueShapeIds.length !== 1) continue;
  records[block.name] = getShapeIndex(uniqueShapeIds[0]);
}

for (const [family, definition] of Object.entries({
  chorus_plant: {
    blockName: "chorus_plant",
    states: ["down", "east", "north", "south", "up", "west"]
  },
  fence: {
    blockName: "oak_fence",
    states: ["east", "north", "south", "west"]
  },
  pane: {
    blockName: "glass_pane",
    states: ["east", "north", "south", "west"]
  },
  stairs: {
    blockName: "oak_stairs",
    states: ["facing", "half", "shape"]
  },
  wall: {
    blockName: "cobblestone_wall",
    states: ["east", "north", "south", "up", "west"]
  }
})) {
  dynamicRecords[family] = buildDynamicRecord(definition.blockName, definition.states);
}

function buildDynamicRecord(blockName, selectedStateNames) {
  const block = blocks.find((candidate) => candidate.name === blockName);
  const rawShapeIds = collision.blocks[blockName];
  if (!block || !Array.isArray(rawShapeIds) || !Array.isArray(block.states)) {
    throw new Error(`Missing Java dynamic collision source for ${blockName}.`);
  }

  const stateValues = block.states.map((state) =>
    state.type === "bool" ? [true, false] : state.values
  );
  const expectedStateCount = stateValues.reduce((product, values) => product * values.length, 1);
  if (expectedStateCount !== rawShapeIds.length) {
    throw new Error(
      `Java dynamic collision state count mismatch for ${blockName}: ` +
      `${expectedStateCount} states vs ${rawShapeIds.length} shapes.`
    );
  }

  const result = {};
  for (let stateIndex = 0; stateIndex < rawShapeIds.length; stateIndex++) {
    let remaining = stateIndex;
    const valuesByName = {};
    for (let propertyIndex = 0; propertyIndex < block.states.length; propertyIndex++) {
      const stride = stateValues.slice(propertyIndex + 1)
        .reduce((product, values) => product * values.length, 1);
      const values = stateValues[propertyIndex];
      const valueIndex = Math.floor(remaining / stride);
      remaining %= stride;
      valuesByName[block.states[propertyIndex].name] = values[valueIndex];
    }
    const key = selectedStateNames.map((name) => String(valuesByName[name])).join("|");
    const shapeIndex = getShapeIndex(rawShapeIds[stateIndex]);
    const previousShapeIndex = result[key];
    if (previousShapeIndex !== undefined && previousShapeIndex !== shapeIndex) {
      throw new Error(`Ignored Java state changes collision for ${blockName} key ${key}.`);
    }
    result[key] = shapeIndex;
  }
  return result;
}

const output = `// Generated from PrismarineJS/minecraft-data Java ${SOURCE_VERSION}.\n` +
  `// Source commit: ${SOURCE_COMMIT}\n` +
  `// Sable calls Java BlockState#getCollisionShape; this table contains only state-invariant shapes.\n` +
  `// This file is generated; edit scripts/generators/sable-collision-reference.mjs instead.\n\n` +
  `export const SABLE_STATIC_COLLISION_DATA_VERSION = "java-${SOURCE_VERSION}" as const;\n` +
  `export const SABLE_COLLISION_BLOCK_COUNT = ${blockNames.length} as const;\n` +
  `export const SABLE_STATIC_COLLISION_BLOCK_COUNT = ${Object.keys(records).length} as const;\n\n` +
  `export const SABLE_COLLISION_BLOCK_RECORDS: Readonly<Record<string, true>> = ${JSON.stringify(Object.fromEntries(blockNames.map((name) => [name, true])))};\n\n` +
  `export const SABLE_DYNAMIC_COLLISION_RECORDS: Readonly<Record<string, Readonly<Record<string, number>>>> = ${JSON.stringify(dynamicRecords)};\n\n` +
  `export const SABLE_STATIC_COLLISION_SHAPES = ${JSON.stringify(shapes)} as const;\n\n` +
  `export const SABLE_STATIC_COLLISION_RECORDS: Readonly<Record<string, number>> = ${JSON.stringify(records)};\n`;

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, output, "utf8");
console.log(`[generate-sable-collision-reference] ${Object.keys(records).length} blocks -> ${OUTPUT_FILE}`);
