import type { PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import {
  COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID,
  TREE_COMPACT_LEAF_FRAGMENT_DEPTH,
  TREE_COMPACT_LEAF_FRAGMENT_WIDTH,
  ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID,
  TREE_FRAGMENT_DEPTH,
  TREE_FRAGMENT_WIDTH,
  TREE_LEAF_FRAGMENT_DEPTH,
  LEAF_FRAGMENT_ENTITY_TYPE_ID,
  TREE_LEAF_FRAGMENT_WIDTH,
  type PackedFragment
} from "@src/render/contraption/fragment/FragmentLayout";
import {
  TREE_ATTACHMENT_FRAGMENT_FAMILIES,
  TREE_FRAGMENT_FAMILIES
} from "@src/render/contraption/fragment/FragmentVisual";

export const FOLIAGE_COLORMAP_DISABLED = 0;
export const FOLIAGE_COLORMAP_DEFAULT = 1;
export const FOLIAGE_COLORMAP_SWAMP = 2;
export const FOLIAGE_COLORMAP_MANGROVE_SWAMP = 3;
export const FOLIAGE_COLORMAP_BIRCH = 4;
export const FOLIAGE_COLORMAP_EVERGREEN = 5;
export const FOLIAGE_COLORMAP_FIXED = 6;

// Packed fragment tint layout (24-bit integer, decoded again by the fragment
// entities' molang in the resource pack, which must mirror any change here):
// value = u0 + v0*32 + u1*32^2 + v1*32^3 + state*32^4.
export const FOLIAGE_TINT_COORDINATE_STEPS = 31;
const FOLIAGE_TINT_COORDINATE_BASE = FOLIAGE_TINT_COORDINATE_STEPS + 1;
const FOLIAGE_TINT_KIND_PLACE = FOLIAGE_TINT_COORDINATE_BASE ** 4;
const FOLIAGE_TINT_AXIS_Z_PLACE = 8 * FOLIAGE_TINT_KIND_PLACE;
const FOLIAGE_TINT_UNIFORM_DEFAULT_STATE = 7;
const FOLIAGE_TINT_TEXTURE_SIZE = 256;

export const DEFAULT_CONTRAPTION_FOLIAGE_TINT: PhysicsContraptionFoliageTint = (() => {
  // Keep the renderer-side default independent from the gameplay biome table.
  // These are the generated Bedrock plains climate values.
  const uv = climateToColormapUv(0.8, 0.4);
  return {
    gradientAxis: "x",
    mapKind: FOLIAGE_COLORMAP_DEFAULT,
    uAtLocalOrigin: uv.u,
    uPerLocalX: 0,
    vAtLocalOrigin: uv.v,
    vPerLocalZ: 0
  };
})();

export function climateToColormapUv(baseTemperature: number, baseDownfall: number): { u: number; v: number } {
  const temperature = clamp(baseTemperature);
  const rainfall = clamp(baseDownfall) * temperature;
  return { u: 1 - temperature, v: 1 - rainfall };
}

export function packFragmentFoliageTint(
  fragment: PackedFragment,
  field: PhysicsContraptionFoliageTint = DEFAULT_CONTRAPTION_FOLIAGE_TINT
): number {
  const kind = fragmentColormapKind(fragment, field.mapKind);
  if (kind === FOLIAGE_COLORMAP_DISABLED) return 0;
  const width = fragment.entityTypeId === LEAF_FRAGMENT_ENTITY_TYPE_ID
    ? TREE_LEAF_FRAGMENT_WIDTH
    : fragment.entityTypeId === COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID
      ? TREE_COMPACT_LEAF_FRAGMENT_WIDTH
      : TREE_FRAGMENT_WIDTH;
  const depth = fragment.entityTypeId === LEAF_FRAGMENT_ENTITY_TYPE_ID
    ? TREE_LEAF_FRAGMENT_DEPTH
    : fragment.entityTypeId === COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID
      ? TREE_COMPACT_LEAF_FRAGMENT_DEPTH
      : TREE_FRAGMENT_DEPTH;
  const minimumX = fragment.anchorLocalLocation.x - 0.5;
  const maximumX = minimumX + width;
  const minimumZ = fragment.anchorLocalLocation.z - 0.5;
  const maximumZ = minimumZ + depth;
  if (kind === FOLIAGE_COLORMAP_DEFAULT && isUniformFoliageField(field)) {
    const u = texturePixelCoordinate(field.uAtLocalOrigin);
    const v = texturePixelCoordinate(field.vAtLocalOrigin);
    return u + v * FOLIAGE_TINT_TEXTURE_SIZE + FOLIAGE_TINT_UNIFORM_DEFAULT_STATE * FOLIAGE_TINT_KIND_PLACE;
  }
  const projection = projectFoliageField(field, { maximumX, maximumZ, minimumX, minimumZ });
  const u0 = quantizeCoordinate(projection.u0);
  const u1 = quantizeCoordinate(projection.u1);
  const v0 = quantizeCoordinate(projection.v0);
  const v1 = quantizeCoordinate(projection.v1);
  return u0
    + v0 * FOLIAGE_TINT_COORDINATE_BASE
    + u1 * FOLIAGE_TINT_COORDINATE_BASE ** 2
    + v1 * FOLIAGE_TINT_COORDINATE_BASE ** 3
    + kind * FOLIAGE_TINT_KIND_PLACE
    + (projection.axis === "z" ? FOLIAGE_TINT_AXIS_Z_PLACE : 0);
}

export function isContraptionFoliageTint(value: unknown): value is PhysicsContraptionFoliageTint {
  if (!value || typeof value !== "object") return false;
  const field = value as Partial<PhysicsContraptionFoliageTint>;
  return Number.isInteger(field.mapKind)
    && field.mapKind! >= FOLIAGE_COLORMAP_DEFAULT
    && field.mapKind! <= FOLIAGE_COLORMAP_FIXED
    && isFiniteCoefficient(field.uAtLocalOrigin)
    && isFiniteCoefficient(field.uPerLocalX)
    && isFiniteCoefficient(field.vAtLocalOrigin)
    && isFiniteCoefficient(field.vPerLocalZ)
    && (field.gradientAxis === "x" || field.gradientAxis === "z");
}

function isFiniteCoefficient(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 4;
}

interface FoliageProjectionBounds {
  maximumX: number;
  maximumZ: number;
  minimumX: number;
  minimumZ: number;
}

function projectFoliageField(field: PhysicsContraptionFoliageTint, bounds: FoliageProjectionBounds): { axis: "x" | "z"; u0: number; u1: number; v0: number; v1: number } {
  const axis = field.gradientAxis;
  const minimum = axis === "x" ? bounds.minimumX : bounds.minimumZ;
  const maximum = axis === "x" ? bounds.maximumX : bounds.maximumZ;
  const u0 = field.uAtLocalOrigin + field.uPerLocalX * minimum;
  const u1 = field.uAtLocalOrigin + field.uPerLocalX * maximum;
  const v0 = field.vAtLocalOrigin + field.vPerLocalZ * minimum;
  const v1 = field.vAtLocalOrigin + field.vPerLocalZ * maximum;
  return { axis, u0, u1, v0, v1 };
}

function fragmentColormapKind(fragment: PackedFragment, biomeKind: number): number {
  if (fragment.entityTypeId === LEAF_FRAGMENT_ENTITY_TYPE_ID || fragment.entityTypeId === COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID) {
    const family = TREE_FRAGMENT_FAMILIES[fragment.family];
    if (family === "spruce") return FOLIAGE_COLORMAP_EVERGREEN;
    if (family === "birch") return FOLIAGE_COLORMAP_BIRCH;
    if (family === "cherry" || family === "pale_oak" || family === "azalea" || family === "flowering_azalea") return FOLIAGE_COLORMAP_DISABLED;
    return biomeKind;
  }
  if (fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID) {
    return fragment.words.some(descriptor => Math.floor(descriptor / 0x100) % 0x10 === TREE_ATTACHMENT_FRAGMENT_FAMILIES.indexOf("vine"))
      ? biomeKind
      : FOLIAGE_COLORMAP_DISABLED;
  }
  return FOLIAGE_COLORMAP_DISABLED;
}

function isUniformFoliageField(field: PhysicsContraptionFoliageTint): boolean {
  return field.uPerLocalX === 0 && field.vPerLocalZ === 0;
}

function quantizeCoordinate(value: number): number {
  return Math.max(0, Math.min(FOLIAGE_TINT_COORDINATE_STEPS, Math.round(value * FOLIAGE_TINT_COORDINATE_STEPS)));
}

function texturePixelCoordinate(value: number): number {
  return Math.floor(clamp(value) * (FOLIAGE_TINT_TEXTURE_SIZE - 1));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
