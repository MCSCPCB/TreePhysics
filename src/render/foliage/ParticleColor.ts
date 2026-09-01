import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import { leafFamily, type CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import { sampleVanillaFoliageColor } from "@src/data/FoliageColorMap";
import {
  DEFAULT_CONTRAPTION_FOLIAGE_TINT,
  FOLIAGE_COLORMAP_BIRCH,
  FOLIAGE_COLORMAP_DISABLED,
  FOLIAGE_COLORMAP_EVERGREEN,
  FOLIAGE_COLORMAP_FIXED,
  FOLIAGE_COLORMAP_MANGROVE_SWAMP,
  FOLIAGE_COLORMAP_SWAMP
} from "@src/render/foliage/TintCodec";

const SWAMP_FOLIAGE_COLOR = color(0x6a, 0x70, 0x39);
const MANGROVE_SWAMP_FOLIAGE_COLOR = color(0x8d, 0xb1, 0x27);
const BIRCH_FOLIAGE_COLOR = color(0x80, 0xa7, 0x55);
const EVERGREEN_FOLIAGE_COLOR = color(0x61, 0x99, 0x61);
const CHERRY_GROVE_FOLIAGE_COLOR = color(0xb6, 0xdb, 0x61);
const PALE_GARDEN_FOLIAGE_COLOR = color(0x87, 0x8d, 0x76);

export interface TreeParticleFoliageColor {
  alpha: number;
  blue: number;
  green: number;
  red: number;
}

/**
 * Resolves the single frozen color used by a leaf or vine particle. Unlike the
 * fragment renderer this has no second texture sampler, so it samples the
 * documented vanilla colormap only when the particle is spawned. It therefore
 * intentionally does not follow resource-pack colormap replacements.
 */
export function resolveTreeParticleFoliageColor(
  block: CapturedTreeBlock,
  localLocation: Vector3,
  field: PhysicsContraptionFoliageTint = DEFAULT_CONTRAPTION_FOLIAGE_TINT
): TreeParticleFoliageColor | undefined {
  const kind = particleColormapKind(block, field.mapKind);
  if (kind === FOLIAGE_COLORMAP_DISABLED) return undefined;
  if (kind === FOLIAGE_COLORMAP_SWAMP) return SWAMP_FOLIAGE_COLOR;
  if (kind === FOLIAGE_COLORMAP_MANGROVE_SWAMP) return MANGROVE_SWAMP_FOLIAGE_COLOR;
  if (kind === FOLIAGE_COLORMAP_BIRCH) return BIRCH_FOLIAGE_COLOR;
  if (kind === FOLIAGE_COLORMAP_EVERGREEN) return EVERGREEN_FOLIAGE_COLOR;
  if (kind === FOLIAGE_COLORMAP_FIXED) {
    return field.uAtLocalOrigin >= 0.5
      ? PALE_GARDEN_FOLIAGE_COLOR
      : CHERRY_GROVE_FOLIAGE_COLOR;
  }
  const colorAt = sampleVanillaFoliageColor(
    foliageFieldCoordinate(field, localLocation, "u"),
    foliageFieldCoordinate(field, localLocation, "v")
  );
  return { alpha: 1, ...colorAt };
}

function foliageColormapKindForTreeFamily(
  family: string,
  biomeKind: number
): number {
  if (family === "spruce") return FOLIAGE_COLORMAP_EVERGREEN;
  if (family === "birch") return FOLIAGE_COLORMAP_BIRCH;
  if (
    family === "cherry"
    || family === "pale_oak"
    || family === "azalea"
    || family === "flowering_azalea"
  ) return FOLIAGE_COLORMAP_DISABLED;
  return biomeKind;
}

function particleColormapKind(block: CapturedTreeBlock, biomeKind: number): number {
  if (block.typeId === "minecraft:vine") return biomeKind;
  if (block.kind !== "leaf") return FOLIAGE_COLORMAP_DISABLED;
  const rawFamily = leafFamily(block);
  const family = rawFamily === "azalea_flowered" ? "flowering_azalea" : rawFamily;
  return foliageColormapKindForTreeFamily(family, biomeKind);
}

function foliageFieldCoordinate(
  field: PhysicsContraptionFoliageTint,
  location: Vector3,
  component: "u" | "v"
): number {
  const coordinate = field.gradientAxis === "z" ? location.z : location.x;
  return component === "u"
    ? field.uAtLocalOrigin + field.uPerLocalX * coordinate
    : field.vAtLocalOrigin + field.vPerLocalZ * coordinate;
}

function color(red: number, green: number, blue: number): TreeParticleFoliageColor {
  return { alpha: 1, red: red / 255, green: green / 255, blue: blue / 255 };
}
