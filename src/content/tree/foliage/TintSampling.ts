import type { Dimension, Vector3 } from "@minecraft/server";
import { BIOME_FOLIAGE_CLIMATES } from "@src/data/BiomeFoliage";
import type { PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import { type CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import {
  DEFAULT_CONTRAPTION_FOLIAGE_TINT,
  FOLIAGE_COLORMAP_DEFAULT,
  FOLIAGE_COLORMAP_FIXED,
  FOLIAGE_COLORMAP_MANGROVE_SWAMP,
  FOLIAGE_COLORMAP_SWAMP,
  FOLIAGE_TINT_COORDINATE_STEPS,
  climateToColormapUv
} from "@src/render/foliage/TintCodec";

const FIXED_CHERRY_GROVE_PALETTE_U = 8 / FOLIAGE_TINT_COORDINATE_STEPS;
const FIXED_PALE_GARDEN_PALETTE_U = 23 / FOLIAGE_TINT_COORDINATE_STEPS;
const FIXED_PALETTE_V = 16 / FOLIAGE_TINT_COORDINATE_STEPS;

// Leaf blocks whose color follows the biome colormap, plus vine. Cherry,
// azalea, flowering azalea and pale oak leaves are intentionally absent:
// their tint is fixed or disabled (see foliageColormapKindForTreeFamily).
const TINTED_TREE_BLOCKS = new Set([
  "minecraft:leaves",
  "minecraft:leaves2",
  "minecraft:oak_leaves",
  "minecraft:spruce_leaves",
  "minecraft:birch_leaves",
  "minecraft:jungle_leaves",
  "minecraft:acacia_leaves",
  "minecraft:dark_oak_leaves",
  "minecraft:mangrove_leaves",
  "minecraft:vine"
]);

interface FoliageSample {
  kind: number;
  localX: number;
  localZ: number;
  palette: FixedFoliagePalette | undefined;
  u: number;
  v: number;
}

type FixedFoliagePalette = "cherry_grove" | "pale_garden";

interface FoliageColorSource {
  kind: number;
  palette: FixedFoliagePalette | undefined;
}

export interface BiomeFoliageTintSample {
  biomeId: string;
  downfall: number;
  fallback: boolean;
  kind: number;
  palette: FixedFoliagePalette | undefined;
  temperature: number;
  u: number;
  v: number;
}

export function captureTreeFoliageTint(
  dimension: Dimension,
  blocks: readonly CapturedTreeBlock[],
  origin: Vector3
): PhysicsContraptionFoliageTint {
  const foliage = blocks.filter(block => TINTED_TREE_BLOCKS.has(block.typeId));
  if (foliage.length === 0) return { ...DEFAULT_CONTRAPTION_FOLIAGE_TINT };
  const minimumX = Math.min(...foliage.map(block => block.location.x));
  const maximumX = Math.max(...foliage.map(block => block.location.x));
  const minimumZ = Math.min(...foliage.map(block => block.location.z));
  const maximumZ = Math.max(...foliage.map(block => block.location.z));
  const sampleY = Math.floor(
    foliage.reduce((sum, block) => sum + block.location.y, 0) / foliage.length
  );
  const centerX = Math.floor((minimumX + maximumX) / 2);
  const centerZ = Math.floor((minimumZ + maximumZ) / 2);
  const locations = deduplicateLocations([
    { x: centerX, y: sampleY, z: centerZ },
    { x: minimumX, y: sampleY, z: minimumZ },
    { x: maximumX, y: sampleY, z: minimumZ },
    { x: minimumX, y: sampleY, z: maximumZ },
    { x: maximumX, y: sampleY, z: maximumZ }
  ]);
  const samples = locations.map(location => sampleFoliage(dimension, location, origin));
  const source = chooseFoliageColorSource(samples);
  if (source.kind === FOLIAGE_COLORMAP_FIXED) {
    const palette = source.palette ?? "cherry_grove";
    const uv = fixedPaletteUv(palette);
    return {
      gradientAxis: "x",
      mapKind: source.kind,
      uAtLocalOrigin: uv.u,
      uPerLocalX: 0,
      vAtLocalOrigin: uv.v,
      vPerLocalZ: 0
    };
  }
  const selectedSamples = samples.filter(sample => sample.kind === source.kind);
  const xFit = fitFoliageAxis(selectedSamples, "x");
  const zFit = fitFoliageAxis(selectedSamples, "z");
  const fit = zFit.error < xFit.error ? zFit : xFit;
  return {
    gradientAxis: fit.axis,
    mapKind: source.kind,
    uAtLocalOrigin: fit.u.intercept,
    uPerLocalX: fit.u.slope,
    vAtLocalOrigin: fit.v.intercept,
    vPerLocalZ: fit.v.slope
  };
}

function sampleBiomeFoliageTint(
  dimension: Dimension,
  location: Vector3
): BiomeFoliageTintSample {
  let biomeId = "minecraft:plains";
  let fallback = false;
  try {
    biomeId = dimension.getBiome(location).id;
  } catch {
    fallback = true;
  }
  const climate = BIOME_FOLIAGE_CLIMATES[biomeId];
  if (!climate) fallback = true;
  const resolved = climate ?? BIOME_FOLIAGE_CLIMATES["minecraft:plains"]!;
  const uv = climateToColormapUv(resolved.temperature, resolved.downfall);
  return {
    biomeId,
    downfall: resolved.downfall,
    fallback,
    kind: biomeColormapKind(biomeId),
    palette: biomeFixedPalette(biomeId),
    temperature: resolved.temperature,
    ...uv
  };
}

function sampleFoliage(
  dimension: Dimension,
  location: Vector3,
  origin: Vector3
): FoliageSample {
  const sample = sampleBiomeFoliageTint(dimension, location);
  return {
    kind: sample.kind,
    localX: location.x - origin.x,
    localZ: location.z - origin.z,
    palette: sample.palette,
    u: sample.u,
    v: sample.v
  };
}

function biomeColormapKind(typeId: string): number {
  if (biomeFixedPalette(typeId)) return FOLIAGE_COLORMAP_FIXED;
  if (typeId === "minecraft:mangrove_swamp") return FOLIAGE_COLORMAP_MANGROVE_SWAMP;
  if (
    typeId === "minecraft:swamp"
    || typeId === "minecraft:swampland"
    || typeId === "minecraft:swampland_mutated"
  ) return FOLIAGE_COLORMAP_SWAMP;
  return FOLIAGE_COLORMAP_DEFAULT;
}

function biomeFixedPalette(typeId: string): FixedFoliagePalette | undefined {
  if (typeId === "minecraft:cherry_grove") return "cherry_grove";
  if (typeId === "minecraft:pale_garden") return "pale_garden";
  return undefined;
}

function chooseFoliageColorSource(samples: readonly FoliageSample[]): FoliageColorSource {
  const fallback: FoliageColorSource = {
    kind: FOLIAGE_COLORMAP_DEFAULT,
    palette: undefined
  };
  if (samples.length === 0) return fallback;
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = foliageColorSourceKey(sample);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maximum = Math.max(...counts.values());
  // Samples are ordered center first. Selecting the first tied winner makes the
  // center authoritative whenever it participates in the highest-count tie.
  for (const sample of samples) {
    if ((counts.get(foliageColorSourceKey(sample)) ?? 0) === maximum) {
      return { kind: sample.kind, palette: sample.palette };
    }
  }
  return fallback;
}

function foliageColorSourceKey(source: FoliageColorSource): string {
  return `${source.kind}:${source.palette ?? ""}`;
}

function fixedPaletteUv(palette: FixedFoliagePalette): { u: number; v: number } {
  return {
    u: palette === "pale_garden" ? FIXED_PALE_GARDEN_PALETTE_U : FIXED_CHERRY_GROVE_PALETTE_U,
    v: FIXED_PALETTE_V
  };
}

function fitAxis(
  samples: readonly FoliageSample[],
  coordinate: (sample: FoliageSample) => number,
  value: (sample: FoliageSample) => number
): { intercept: number; slope: number } {
  const meanCoordinate = samples.reduce((sum, sample) => sum + coordinate(sample), 0)
    / samples.length;
  const meanValue = samples.reduce((sum, sample) => sum + value(sample), 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of samples) {
    const delta = coordinate(sample) - meanCoordinate;
    covariance += delta * (value(sample) - meanValue);
    variance += delta * delta;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { intercept: meanValue - slope * meanCoordinate, slope };
}

function fitFoliageAxis(
  samples: readonly FoliageSample[],
  axis: "x" | "z"
): {
  axis: "x" | "z";
  error: number;
  u: { intercept: number; slope: number };
  v: { intercept: number; slope: number };
} {
  const coordinate = axis === "x"
    ? (sample: FoliageSample) => sample.localX
    : (sample: FoliageSample) => sample.localZ;
  const u = fitAxis(samples, coordinate, sample => sample.u);
  const v = fitAxis(samples, coordinate, sample => sample.v);
  const error = samples.reduce((sum, sample) => {
    const at = coordinate(sample);
    const uError = sample.u - (u.intercept + u.slope * at);
    const vError = sample.v - (v.intercept + v.slope * at);
    return sum + uError * uError + vError * vError;
  }, 0);
  return { axis, error, u, v };
}

function deduplicateLocations(locations: readonly Vector3[]): Vector3[] {
  const result = new Map<string, Vector3>();
  for (const location of locations) {
    result.set(`${location.x},${location.y},${location.z}`, location);
  }
  return [...result.values()];
}
