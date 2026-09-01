// Tree block particle rendering: destruct/collision emitters, addon tint
// fitting, and the Oklab-based gamut mapping used to color particle quads.
// Split from contraption-lifecycle.ts because this color science is pure
// presentation and shares no state with the lifecycle orchestration.
import {
  MolangVariableMap,
  type Dimension,
  type Vector3
} from "@minecraft/server";
import type { PhysicsContraptionFoliageTint } from "@src/Physics";
import {
  isStrippedTreeLog,
  isVanillaTypeId,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";
import {
  TREE_ATTACHMENT_FRAGMENT_FAMILIES,
  TREE_FRAGMENT_FAMILIES,
  createFragmentVisual
} from "@src/render/contraption/fragment/FragmentVisual";
import { resolveTreeParticleFoliageColor } from "@src/render/foliage/ParticleColor";

const TREE_DUST_PARTICLE_ID = "treephysics:tree_dust";
const TREE_COLLIDE_PARTICLE_PREFIX = "treephysics:tree_collide";
const TREE_BLOCK_DESTRUCT_PARTICLE_PREFIX = "treephysics:tree_block_destruct";
const REPORTED_PARTICLE_SPAWN_FAILURES = new Set<string>();
export const BLOCK_HIT_PARTICLE_PROFILE: BlockParticleProfile = {
  particleCount: 27,
  radius: 0.45,
  velocityScalar: 1.1
};
export const BLOCK_BREAK_PARTICLE_PROFILE: BlockParticleProfile = {
  particleCount: 27,
  radius: 0.5,
  velocityScalar: 1
};
const ADDON_BARK_PARTICLE_SUFFIX = "pale_oak_log";
const ADDON_STRIPPED_PARTICLE_SUFFIX = "stripped_pale_oak_log";
const ADDON_LEAF_PARTICLE_SUFFIX = "oak_leaves";
// Fitted in sRGB space against representative paired map colors and source
// textures. The affine fit models bark tint before the particle expression
// clamps channels to Bedrock's [0, 1] range.
const ADDON_BARK_MAP_COLOR_SCALE = { blue: 2.77653, green: 2.59065, red: 1.37374 };
const ADDON_BARK_MAP_COLOR_OFFSET = { blue: 0.09168, green: 0.1104, red: 0.45764 };
const ADDON_STRIPPED_MAP_COLOR_SCALE = { blue: 0.87778, green: 0.7098, red: 0.75551 };
const ADDON_STRIPPED_MAP_COLOR_OFFSET = { blue: 0.12766, green: 0.20247, red: 0.19373 };
// Mean representative bark color relative to the ordinary pale-oak particle
// texture, used only when a custom block exposes no map_color.
const DEFAULT_ADDON_BARK_TINT = { blue: 0.8046, green: 0.929, red: 0.968 };
const DEFAULT_ADDON_STRIPPED_TINT = { blue: 0.36337, green: 0.605, red: 0.72205 };
// Effective mean RGB of visible texels under the oak-leaf particle's random 4x4 UV sampling.
const ADDON_LEAF_PARTICLE_BASE_COLOR = {
  blue: 0.5522222646359,
  green: 0.550694099833315,
  red: 0.5522222646359
};
const PARTICLE_CHROMA_SOFT_THRESHOLD = 0.08;
const PARTICLE_CHROMA_MIDTONE_LIMIT = 0.15;
const PARTICLE_GAMUT_SEARCH_STEPS = 8;

export interface BlockParticleProfile {
  readonly direction?: Vector3;
  readonly directionRandomness?: Vector3;
  readonly offsetRadius?: Vector3;
  readonly particleCount: number;
  readonly radius: number;
  readonly speedMax?: number;
  readonly speedMin?: number;
  readonly velocityScalar: number;
}

type TreeBlockParticleOptions =
  | {
    readonly kind: "collision";
    readonly includeDust: boolean;
    readonly inLiquid: boolean;
  }
  | {
    readonly kind: "destruct";
    readonly profile: BlockParticleProfile;
  };

export function spawnBlockParticle(
  dimension: Dimension,
  location: Vector3,
  snapshot: CapturedTreeBlock,
  localLocation: Vector3,
  foliageTint: PhysicsContraptionFoliageTint | undefined,
  options: TreeBlockParticleOptions
): void {
  const effectSuffix = getTreeParticleEffectSuffix(snapshot);
  if (effectSuffix === undefined) return;
  const molang = new MolangVariableMap();
  const color = resolveTreeBlockParticleColor(
    snapshot,
    localLocation,
    foliageTint
  );
  molang.setFloat("variable.activation_flag", 1);
  molang.setFloat("variable.block_color_r", color.red);
  molang.setFloat("variable.block_color_g", color.green);
  molang.setFloat("variable.block_color_b", color.blue);
  molang.setFloat("variable.block_color_a", color.alpha);
  const effectPrefix = options.kind === "destruct"
    ? TREE_BLOCK_DESTRUCT_PARTICLE_PREFIX
    : TREE_COLLIDE_PARTICLE_PREFIX;
  if (options.kind === "destruct") {
    molang.setFloat("variable.emitter_particles_count", options.profile.particleCount);
    molang.setFloat("variable.emitter_radius", options.profile.radius);
    molang.setFloat("variable.velocity_scalar", options.profile.velocityScalar);
    if (options.profile.offsetRadius) {
      molang.setFloat("variable.emitter_radius_x", options.profile.offsetRadius.x);
      molang.setFloat("variable.emitter_radius_y", options.profile.offsetRadius.y);
      molang.setFloat("variable.emitter_radius_z", options.profile.offsetRadius.z);
    }
    if (options.profile.direction) {
      molang.setFloat("variable.emitter_direction_x", options.profile.direction.x);
      molang.setFloat("variable.emitter_direction_y", options.profile.direction.y);
      molang.setFloat("variable.emitter_direction_z", options.profile.direction.z);
    }
    if (options.profile.directionRandomness) {
      molang.setFloat(
        "variable.emitter_direction_random_x",
        options.profile.directionRandomness.x
      );
      molang.setFloat(
        "variable.emitter_direction_random_y",
        options.profile.directionRandomness.y
      );
      molang.setFloat(
        "variable.emitter_direction_random_z",
        options.profile.directionRandomness.z
      );
    }
    if (options.profile.speedMin !== undefined) {
      molang.setFloat("variable.emitter_speed_min", options.profile.speedMin);
    }
    if (options.profile.speedMax !== undefined) {
      molang.setFloat("variable.emitter_speed_max", options.profile.speedMax);
    }
  } else {
    molang.setFloat("variable.underwater", options.inLiquid ? 1 : 0);
    if (options.includeDust && !options.inLiquid) {
      try {
        dimension.spawnParticle(TREE_DUST_PARTICLE_ID, location, molang);
      } catch (error) {
        reportParticleSpawnFailure(TREE_DUST_PARTICLE_ID, error);
        // The typed collision particles remain independent from the dust resource.
      }
    }
  }
  const effectId = `${effectPrefix}_${effectSuffix}`;
  try {
    dimension.spawnParticle(effectId, location, molang);
  } catch (error) {
    reportParticleSpawnFailure(effectId, error);
    // Particle availability must not affect block removal or physics.
  }
}

function reportParticleSpawnFailure(effectId: string, error: unknown): void {
  if (REPORTED_PARTICLE_SPAWN_FAILURES.has(effectId)) return;
  REPORTED_PARTICLE_SPAWN_FAILURES.add(effectId);
  // See the restore-failure report in contraption-lifecycle.ts for why the
  // globalThis cast is used and why the two call sites must stay separate.
  (globalThis as unknown as { console: { error(message: string): void } }).console.error(
    `[treephysics/particle] Failed to spawn ${effectId}: ${describeError(error)}`
  );
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function getTreeParticleEffectSuffix(snapshot: CapturedTreeBlock): string | undefined {
  if (!isVanillaTypeId(snapshot.typeId)) {
    if (snapshot.kind === "log") {
      return isStrippedTreeLog(snapshot.typeId)
        ? ADDON_STRIPPED_PARTICLE_SUFFIX
        : ADDON_BARK_PARTICLE_SUFFIX;
    }
    if (snapshot.kind === "leaf") return ADDON_LEAF_PARTICLE_SUFFIX;
  }
  const visual = createFragmentVisual(snapshot);
  if (!visual) return undefined;
  if (visual.renderer === "cube_block_fragment") {
    return snapshot.typeId === "minecraft:chest" ? "chest" : undefined;
  }
  const family = TREE_FRAGMENT_FAMILIES[visual.family];
  if (visual.renderer === "log_fragment") {
    return family
      ? `${snapshot.typeId.startsWith("minecraft:stripped_") ? "stripped_" : ""}${family}_log`
      : undefined;
  }
  if (visual.renderer === "leaf_fragment") return family ? `${family}_leaves` : undefined;
  switch (TREE_ATTACHMENT_FRAGMENT_FAMILIES[visual.family]) {
    case "bee_nest": return "bee_nest_side";
    case "cocoa": return `cocoa_stage_${Math.floor(visual.state / 4)}`;
    case "hanging_roots": return "hanging_roots";
    case "mangrove_propagule": return "mangrove_propagule";
    case "pale_hanging_moss": return `pale_hanging_moss_${visual.state === 1 ? "tip" : "middle"}`;
    case "vine": return "vine";
    case "mangrove_roots": return "mangrove_roots_side";
    case "muddy_mangrove_roots": return "muddy_mangrove_roots_side";
    case "creaking_heart": {
      const mode = ["inactive", "dormant", "active"][Math.floor(visual.state / 3)];
      return mode ? `creaking_heart_${mode}` : undefined;
    }
    default: return undefined;
  }
}

export function producesDustOnImpact(typeId: string): boolean {
  const name = typeId.startsWith("minecraft:") ? typeId.slice("minecraft:".length) : typeId;
  return name === "dirt"
    || name === "coarse_dirt"
    || name === "grass_block"
    || name === "podzol"
    || name === "mycelium"
    || name === "rooted_dirt"
    || name === "dirt_with_roots"
    || name === "mud"
    || name === "sand"
    || name === "red_sand"
    || name === "gravel"
    || name === "suspicious_gravel"
    || name === "stone"
    || name === "smooth_stone"
    || name === "granite"
    || name === "polished_granite"
    || name === "diorite"
    || name === "polished_diorite"
    || name === "andesite"
    || name === "polished_andesite"
    || name === "deepslate"
    || name === "cobblestone"
    || name === "mossy_cobblestone"
    || name === "calcite"
    || name === "tuff"
    || name === "blackstone"
    || name === "basalt"
    || name === "netherrack"
    || name === "crimson_nylium"
    || name === "warped_nylium"
    || name === "snow"
    || name === "snow_layer"
    || name === "snow_block"
    || name === "end_stone"
    || name.endsWith("_sandstone")
    || name.endsWith("_stone_bricks")
    || name.endsWith("_deepslate")
    || name.endsWith("_deepslate_bricks")
    || name.endsWith("_deepslate_tiles")
    || name.endsWith("_concrete_powder")
    || name === "terracotta"
    || name.endsWith("_terracotta");
}

function resolveTreeBlockParticleColor(
  snapshot: CapturedTreeBlock,
  localLocation: Vector3,
  foliageTint: PhysicsContraptionFoliageTint | undefined
): { alpha: number; blue: number; green: number; red: number } {
  if (!isVanillaTypeId(snapshot.typeId)) {
    if (snapshot.kind === "log") return resolveAddonLogParticleColor(snapshot);
    if (snapshot.kind === "leaf" && snapshot.mapColor) {
      return resolveAddonLeafParticleColor(snapshot.mapColor);
    }
  }
  return resolveTreeParticleFoliageColor(snapshot, localLocation, foliageTint) ?? {
    alpha: 0,
    blue: 1,
    green: 1,
    red: 1
  };
}

function resolveAddonLeafParticleColor(
  mapColor: { blue: number; green: number; red: number }
): { alpha: number; blue: number; green: number; red: number } {
  const balanced = balanceParticleColor(mapColor);
  return {
    alpha: 1,
    blue: clampParticleColor(balanced.blue / ADDON_LEAF_PARTICLE_BASE_COLOR.blue),
    green: clampParticleColor(balanced.green / ADDON_LEAF_PARTICLE_BASE_COLOR.green),
    red: clampParticleColor(balanced.red / ADDON_LEAF_PARTICLE_BASE_COLOR.red)
  };
}

function balanceParticleColor(
  color: { blue: number; green: number; red: number }
): { blue: number; green: number; red: number } {
  const lab = srgbToOklab(color);
  const chroma = Math.hypot(lab.a, lab.b);
  if (chroma <= PARTICLE_CHROMA_SOFT_THRESHOLD) return color;

  // Midtones tolerate more colorfulness than shadows and highlights. The
  // rational shoulder leaves ordinary colors unchanged and compresses only
  // the excess without introducing a hard clipping boundary.
  const lightnessWeight = 2 * Math.sqrt(Math.max(0, lab.lightness * (1 - lab.lightness)));
  const chromaLimit = PARTICLE_CHROMA_SOFT_THRESHOLD
    + (PARTICLE_CHROMA_MIDTONE_LIMIT - PARTICLE_CHROMA_SOFT_THRESHOLD)
    * lightnessWeight;
  const excess = chroma - PARTICLE_CHROMA_SOFT_THRESHOLD;
  const shoulder = chromaLimit - PARTICLE_CHROMA_SOFT_THRESHOLD;
  const compressedChroma = PARTICLE_CHROMA_SOFT_THRESHOLD
    + shoulder * excess / (excess + shoulder);
  const hueA = lab.a / chroma;
  const hueB = lab.b / chroma;
  return oklabToGamutMappedSrgb(lab.lightness, hueA, hueB, compressedChroma);
}

function srgbToOklab(
  color: { blue: number; green: number; red: number }
): { a: number; b: number; lightness: number } {
  const red = srgbChannelToLinear(color.red);
  const green = srgbChannelToLinear(color.green);
  const blue = srgbChannelToLinear(color.blue);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  };
}

function oklabToGamutMappedSrgb(
  lightness: number,
  hueA: number,
  hueB: number,
  chroma: number
): { blue: number; green: number; red: number } {
  let lowerChroma = 0;
  let upperChroma = chroma;
  let candidate = oklabToSrgb(lightness, hueA * chroma, hueB * chroma);
  if (isSrgbColor(candidate)) return candidate;

  candidate = oklabToSrgb(lightness, 0, 0);
  for (let step = 0; step < PARTICLE_GAMUT_SEARCH_STEPS; step++) {
    const probeChroma = (lowerChroma + upperChroma) / 2;
    const probe = oklabToSrgb(lightness, hueA * probeChroma, hueB * probeChroma);
    if (isSrgbColor(probe)) {
      lowerChroma = probeChroma;
      candidate = probe;
    } else {
      upperChroma = probeChroma;
    }
  }
  return {
    blue: clampParticleColor(candidate.blue),
    green: clampParticleColor(candidate.green),
    red: clampParticleColor(candidate.red)
  };
}

function oklabToSrgb(
  lightness: number,
  a: number,
  b: number
): { blue: number; green: number; red: number } {
  const l = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(lightness - 0.0894841775 * a - 1.291485548 * b, 3);
  return {
    blue: linearChannelToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    green: linearChannelToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    red: linearChannelToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  };
}

function srgbChannelToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function isSrgbColor(color: { blue: number; green: number; red: number }): boolean {
  return color.blue >= 0 && color.blue <= 1
    && color.green >= 0 && color.green <= 1
    && color.red >= 0 && color.red <= 1;
}

function resolveAddonLogParticleColor(
  snapshot: CapturedTreeBlock
): { alpha: number; blue: number; green: number; red: number } {
  const stripped = isStrippedTreeLog(snapshot.typeId);
  if (!snapshot.mapColor) {
    return {
      alpha: 1,
      ...(stripped ? DEFAULT_ADDON_STRIPPED_TINT : DEFAULT_ADDON_BARK_TINT)
    };
  }
  if (!stripped) {
    return {
      alpha: 1,
      blue: clampParticleColor(
        snapshot.mapColor.blue * ADDON_BARK_MAP_COLOR_SCALE.blue
        + ADDON_BARK_MAP_COLOR_OFFSET.blue
      ),
      green: clampParticleColor(
        snapshot.mapColor.green * ADDON_BARK_MAP_COLOR_SCALE.green
        + ADDON_BARK_MAP_COLOR_OFFSET.green
      ),
      red: clampParticleColor(
        snapshot.mapColor.red * ADDON_BARK_MAP_COLOR_SCALE.red
        + ADDON_BARK_MAP_COLOR_OFFSET.red
      )
    };
  }
  return {
    alpha: 1,
    blue: clampParticleColor(
      snapshot.mapColor.blue * ADDON_STRIPPED_MAP_COLOR_SCALE.blue
      + ADDON_STRIPPED_MAP_COLOR_OFFSET.blue
    ),
    green: clampParticleColor(
      snapshot.mapColor.green * ADDON_STRIPPED_MAP_COLOR_SCALE.green
      + ADDON_STRIPPED_MAP_COLOR_OFFSET.green
    ),
    red: clampParticleColor(
      snapshot.mapColor.red * ADDON_STRIPPED_MAP_COLOR_SCALE.red
      + ADDON_STRIPPED_MAP_COLOR_OFFSET.red
    )
  };
}

function clampParticleColor(value: number): number {
  return Math.max(0, Math.min(1, value));
}
