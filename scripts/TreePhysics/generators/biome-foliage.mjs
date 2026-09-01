import { readdir, readFile, writeFile } from "node:fs/promises";
import { load } from "cheerio";
import { MinecraftBiomeTypes } from "@minecraft/vanilla-data";

const SOURCE_DIRECTORY = "sample/entity-tint";
const OUTPUT_PATH = "src/data/generated/biome-foliage.generated.ts";
const BIOME_ALIASES = {
  "minecraft:bamboo_jungle_hills": "bamboo_jungle",
  "minecraft:birch_forest_hills": "birch_forest",
  "minecraft:birch_forest_hills_mutated": "old_growth_birch_forest",
  "minecraft:birch_forest_mutated": "old_growth_birch_forest",
  "minecraft:cold_beach": "snowy_beach",
  "minecraft:cold_taiga": "snowy_taiga",
  "minecraft:cold_taiga_hills": "snowy_taiga",
  "minecraft:cold_taiga_mutated": "snowy_taiga",
  "minecraft:deep_warm_ocean": "warm_ocean",
  "minecraft:desert_hills": "desert",
  "minecraft:desert_mutated": "desert",
  "minecraft:extreme_hills": "windswept_hills",
  "minecraft:extreme_hills_edge": "windswept_hills",
  "minecraft:extreme_hills_mutated": "windswept_gravelly_hills",
  "minecraft:extreme_hills_plus_trees": "windswept_forest",
  "minecraft:extreme_hills_plus_trees_mutated": "windswept_forest",
  "minecraft:forest_hills": "forest",
  "minecraft:ice_mountains": "snowy_slopes",
  "minecraft:ice_plains": "snowy_plains",
  "minecraft:ice_plains_spikes": "ice_spikes",
  "minecraft:jungle_edge": "sparse_jungle",
  "minecraft:jungle_edge_mutated": "sparse_jungle",
  "minecraft:jungle_hills": "jungle",
  "minecraft:jungle_mutated": "jungle",
  "minecraft:legacy_frozen_ocean": "frozen_ocean",
  "minecraft:hell": "nether_wastes",
  "minecraft:mega_taiga": "old_growth_pine_taiga",
  "minecraft:mega_taiga_hills": "old_growth_pine_taiga",
  "minecraft:mesa": "badlands",
  "minecraft:mesa_bryce": "eroded_badlands",
  "minecraft:mesa_plateau": "badlands",
  "minecraft:mesa_plateau_mutated": "badlands",
  "minecraft:mesa_plateau_stone": "wooded_badlands",
  "minecraft:mesa_plateau_stone_mutated": "wooded_badlands",
  "minecraft:mushroom_island": "mushroom_fields",
  "minecraft:mushroom_island_shore": "mushroom_fields",
  "minecraft:redwood_taiga_hills_mutated": "old_growth_spruce_taiga",
  "minecraft:redwood_taiga_mutated": "old_growth_spruce_taiga",
  "minecraft:roofed_forest": "dark_forest",
  "minecraft:roofed_forest_mutated": "dark_forest",
  "minecraft:savanna_mutated": "windswept_savanna",
  "minecraft:savanna_plateau_mutated": "windswept_savanna",
  "minecraft:stone_beach": "stony_shore",
  "minecraft:soulsand_valley": "soul_sand_valley",
  "minecraft:swampland": "swamp",
  "minecraft:swampland_mutated": "swamp",
  "minecraft:taiga_hills": "taiga",
  "minecraft:taiga_mutated": "taiga"
};

const files = await readdir(SOURCE_DIRECTORY);
const htmlName = files.find(name => name.endsWith(".html"));
if (!htmlName) throw new Error(`No downloaded biome Wiki HTML found in ${SOURCE_DIRECTORY}.`);
const html = await readFile(`${SOURCE_DIRECTORY}/${htmlName}`, "utf8");
const $ = load(html);
const climatesByName = new Map();
const tables = $('table[data-description^="Climates of biomes"]');
if (tables.length !== 3) throw new Error("Could not find all biome climate tables.");
for (const table of tables.toArray()) {
  const rowSpans = [];
  for (const row of $(table).find("tbody > tr").toArray()) {
    const cells = createTableRow($, row, rowSpans);
    const name = normalizeBiomeName($(cells[0]).find(".sprite-text").first().text());
    if (!name) continue;
    const temperature = parseBedrockNumber($(cells[1]).text());
    const downfall = parseBedrockNumber($(cells[2]).text());
    climatesByName.set(name, { downfall, temperature });
  }
}

const biomeIds = Object.values(MinecraftBiomeTypes);
const missingMappings = [];
const climates = {};
for (const typeId of biomeIds) {
  const name = BIOME_ALIASES[typeId] ?? typeId.replace(/^minecraft:/, "");
  const climate = climatesByName.get(name);
  if (!climate) {
    missingMappings.push(`${typeId} -> ${name}`);
    continue;
  }
  climates[typeId] = climate;
}
// Newer APIs may expose the modern name while older Bedrock data still uses swampland.
climates["minecraft:swamp"] = climatesByName.get("swamp");
if (missingMappings.length > 0) {
  throw new Error(`Missing biome climate mappings:\n${missingMappings.join("\n")}`);
}

const entries = Object.entries(climates).sort(([left], [right]) => left.localeCompare(right));
const output = [
  "// Generated from sample/entity-tint/Biome - Minecraft Wiki.html.",
  "// Bedrock-only values are selected when the table differs by edition.",
  "export interface BiomeFoliageClimate {",
  "  downfall: number;",
  "  temperature: number;",
  "}",
  "",
  "export const BIOME_FOLIAGE_CLIMATES: Readonly<Record<string, BiomeFoliageClimate>> = {",
  ...entries.map(([typeId, climate]) =>
    `  ${JSON.stringify(typeId)}: { downfall: ${climate.downfall}, temperature: ${climate.temperature} },`
  ),
  "};",
  ""
].join("\n");
await writeFile(OUTPUT_PATH, output);
console.warn(`[generate:biome-foliage] ${entries.length} Bedrock biome climates`);

function createTableRow($, row, rowSpans) {
  const result = [];
  for (let column = 0; column < rowSpans.length; column++) {
    const span = rowSpans[column];
    if (!span || span.remaining <= 0) continue;
    result[column] = span.cell;
    span.remaining--;
  }
  let column = 0;
  for (const cell of $(row).children("th,td").toArray()) {
    while (result[column]) column++;
    const columnSpan = Number($(cell).attr("colspan") ?? 1);
    const rowSpan = Number($(cell).attr("rowspan") ?? 1);
    for (let offset = 0; offset < columnSpan; offset++) {
      result[column + offset] = cell;
      if (rowSpan > 1) {
        rowSpans[column + offset] = { cell, remaining: rowSpan - 1 };
      }
    }
    column += columnSpan;
  }
  return result;
}

function normalizeBiomeName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function parseBedrockNumber(value) {
  const text = value.replace(/\s+/g, " ").trim();
  const bedrockMarker = text.indexOf("[BE only]");
  const relevant = bedrockMarker >= 0 ? text.slice(0, bedrockMarker) : text;
  const matches = relevant.match(/-?\d+(?:\.\d+)?/g);
  const parsed = Number(matches?.at(-1));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid biome climate value: ${text}`);
  return parsed;
}
