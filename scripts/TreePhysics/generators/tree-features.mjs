import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const SOURCE_DIRECTORY = "sample/vanilla-feature/features";
const OUTPUT_DIRECTORY = "packs/TreePhysics/BP/features";
const FEATURE_RULE_OUTPUT_DIRECTORY = "packs/TreePhysics/BP/feature_rules";
const ROOT_BLOCK_ID = "physics_api:natural_tree_root";
const ROOT_STATE = "physics_api:soil_variant";
const EXTERNAL_ROOT_SURFACE_DEPTH = 32;
const EXTERNAL_ROOT_CAVE_CANDIDATES = 32;
const EXTERNAL_ROOT_CAVE_SNAP_RANGE = 16;
const EXTERNAL_ROOT_FOUNDATION_TAGS = [
  "dirt",
  "grass",
  "sand",
  "stone",
  "gravel",
  "minecraft:is_shovel_item_destructible",
  "minecraft:is_pickaxe_item_destructible"
];
const EXTERNAL_ROOT_EXCLUDED_FALLBACK_TAGS = ["log", "wood", "leaves", "water"];
const EXPECTED_FEATURE_COUNT = 30;
const EXCLUDED_FEATURES = new Set([
  "jungle_bush_feature.json"
]);

const SOIL_VARIANTS = new Map([
  ["minecraft:dirt", 0],
  ["minecraft:coarse_dirt", 1],
  ["minecraft:mud", 2],
  ["minecraft:dirt_with_roots", 3],
  ["minecraft:podzol", 4]
]);

const SPECIAL_FEATURES = new Map([
  [
    "fancy_oak_tree_feature.json",
    {
      generatorFile: "fancy_oak_tree.json",
      generatorId: "physics_api:fancy_oak_tree",
      rootFeatureId: "physics_api:fancy_oak_root_scatter"
    }
  ],
  [
    "mangrove_tree_feature.json",
    {
      generatorFile: "mangrove_tree.json",
      generatorId: "physics_api:mangrove_tree",
      rootFeatureId: "physics_api:mangrove_root_scatter"
    }
  ],
  [
    "tall_mangrove_tree_feature.json",
    {
      generatorFile: "tall_mangrove_tree.json",
      generatorId: "physics_api:tall_mangrove_tree",
      rootFeatureId: "physics_api:mangrove_root_scatter"
    }
  ]
]);

const MEGA_CONIFER_FEATURES = new Map([
  ["mega_spruce_tree_feature.json", "mega_spruce"],
  ["mega_pine_tree_feature.json", "mega_pine"]
]);

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
await mkdir(FEATURE_RULE_OUTPUT_DIRECTORY, { recursive: true });
const generated = [];

for (const name of (await readdir(SOURCE_DIRECTORY)).sort()) {
  if (!name.endsWith(".json") || EXCLUDED_FEATURES.has(name)) continue;
  const sourcePath = join(SOURCE_DIRECTORY, name);
  const errors = [];
  const document = parse(await readFile(sourcePath, "utf8"), errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0) {
    const detail = errors
      .map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new SyntaxError(`${sourcePath}: ${detail}`);
  }

  const tree = document?.["minecraft:tree_feature"];
  if (!tree) continue;
  if (!("base_block" in tree)) throw new Error(`${sourcePath}: tree feature has no base_block.`);

  const megaConifer = MEGA_CONIFER_FEATURES.get(name);
  const special = SPECIAL_FEATURES.get(name);
  if (megaConifer) {
    await writeMegaConiferTreeFeatures(name, document, megaConifer, sourcePath);
  } else if (special) {
    await writeSpecialTreeFeatures(name, document, special);
  } else {
    tree.base_block = replaceBaseBlock(tree.base_block, sourcePath);
    await writeJson(join(OUTPUT_DIRECTORY, basename(name)), document);
  }
  generated.push(name);
}

await writeRootMarkerFeatures();
await writeExternalNaturalRootFeatures();

if (generated.length !== EXPECTED_FEATURE_COUNT) {
  throw new Error(
    `Expected ${EXPECTED_FEATURE_COUNT} standing/fallen tree features, generated ${generated.length}. `
    + "Review the vanilla feature input and exclusion list."
  );
}

console.log(`Generated ${generated.length} natural-root tree feature overrides.`);

async function writeSpecialTreeFeatures(name, sourceDocument, special) {
  const generatorDocument = structuredClone(sourceDocument);
  const generator = generatorDocument["minecraft:tree_feature"];
  generator.description.identifier = special.generatorId;
  await writeJson(join(OUTPUT_DIRECTORY, special.generatorFile), generatorDocument);

  const originalIdentifier = sourceDocument["minecraft:tree_feature"].description.identifier;
  const wrapperDocument = {
    format_version: "1.13.0",
    "minecraft:aggregate_feature": {
      description: { identifier: originalIdentifier },
      early_out: "first_failure",
      features: [special.generatorId, special.rootFeatureId]
    }
  };
  await writeJson(join(OUTPUT_DIRECTORY, name), wrapperDocument);
}

async function writeRootMarkerFeatures() {
  const rootStates = [0, 1, 2, 3, 4].map(variant => ({
    name: ROOT_BLOCK_ID,
    states: { [ROOT_STATE]: variant }
  }));
  const coarseDirt = {
    name: "minecraft:dirt",
    states: { dirt_type: "coarse" }
  };
  const farmland = Array.from({ length: 8 }, (_, moisturizedAmount) => ({
    name: "minecraft:farmland",
    states: { moisturized_amount: moisturizedAmount }
  }));

  await writeJson(join(OUTPUT_DIRECTORY, "natural_root_dirt.json"), singleBlockFeature(
    "physics_api:natural_root_dirt",
    0,
    ["minecraft:dirt", "minecraft:grass", ...farmland, rootStates[0], rootStates[2], rootStates[3], rootStates[4]]
  ));
  await writeJson(join(OUTPUT_DIRECTORY, "natural_root_coarse_dirt.json"), singleBlockFeature(
    "physics_api:natural_root_coarse_dirt",
    1,
    [coarseDirt, rootStates[1]]
  ));
  await writeJson(join(OUTPUT_DIRECTORY, "natural_root_mud.json"), singleBlockFeature(
    "physics_api:natural_root_mud",
    2,
    [
      "minecraft:mud",
      "minecraft:clay",
      "minecraft:dirt",
      coarseDirt,
      "minecraft:grass",
      "minecraft:podzol",
      "minecraft:dirt_with_roots",
      "minecraft:mycelium",
      ...rootStates
    ]
  ));
  await writeJson(join(OUTPUT_DIRECTORY, "fancy_oak_root_feature.json"), {
    format_version: "1.13.0",
    "minecraft:aggregate_feature": {
      description: { identifier: "physics_api:fancy_oak_root_feature" },
      early_out: "first_success",
      features: [
        "physics_api:natural_root_coarse_dirt",
        "physics_api:natural_root_dirt"
      ]
    }
  });
  await writeJson(join(OUTPUT_DIRECTORY, "fancy_oak_root_scatter.json"), scatterFeature(
    "physics_api:fancy_oak_root_scatter",
    "physics_api:fancy_oak_root_feature"
  ));
  await writeJson(join(OUTPUT_DIRECTORY, "mangrove_root_scatter.json"), scatterFeature(
    "physics_api:mangrove_root_scatter",
    "physics_api:natural_root_mud"
  ));
}

/**
 * Marks tagged addon trees during final-pass terrain generation. Runtime tree
 * selection can then reuse the same explicit-root path as vanilla trees
 * without guessing whether an unmarked structure is natural or player-made.
 */
async function writeExternalNaturalRootFeatures() {
  const exactCandidates = [
    {
      name: "external_natural_root_dirt",
      mayReplace: ["minecraft:dirt", "minecraft:grass", "minecraft:grass_block"],
      variant: 0
    },
    {
      name: "external_natural_root_coarse_dirt",
      mayReplace: [
        "minecraft:coarse_dirt",
        { name: "minecraft:dirt", states: { dirt_type: "coarse" } }
      ],
      variant: 1
    },
    {
      name: "external_natural_root_mud",
      mayReplace: ["minecraft:mud"],
      variant: 2
    },
    {
      name: "external_natural_root_dirt_with_roots",
      mayReplace: ["minecraft:dirt_with_roots"],
      variant: 3
    },
    {
      name: "external_natural_root_podzol",
      mayReplace: ["minecraft:podzol"],
      variant: 4
    }
  ];
  const overworldCandidates = [
    ...exactCandidates,
    // Sand-like addon blocks sometimes also declare dirt/grass tags.
    taggedRootCandidate("external_natural_root_tag_sand", ["sand"], 5),
    taggedRootCandidate(
      "external_natural_root_tag_dirt",
      ["dirt", "grass", "minecraft:is_shovel_item_destructible"],
      0
    ),
    taggedRootCandidate(
      "external_natural_root_tag_stone",
      ["stone", "gravel", "minecraft:is_pickaxe_item_destructible"],
      6
    ),
    fallbackRootCandidate(
      "external_natural_root_stone",
      6
    )
  ];
  const dimensions = [
    {
      candidates: overworldCandidates,
      biomeFilter: {
        all_of: [
          { test: "has_biome_tag", operator: "not", value: "nether" },
          { test: "has_biome_tag", operator: "not", value: "the_end" }
        ]
      },
      minimumY: -48,
      suffix: ""
    },
    {
      candidates: [dimensionalRootCandidate(
        "external_natural_root_netherrack",
        ["minecraft:netherrack"],
        7
      ), fallbackRootCandidate(
        "external_natural_root_netherrack_base",
        7
      )],
      biomeFilter: { test: "has_biome_tag", value: "nether" },
      minimumY: 0,
      suffix: "_nether"
    },
    {
      candidates: [dimensionalRootCandidate(
        "external_natural_root_end_stone",
        ["minecraft:end_stone"],
        8
      ), fallbackRootCandidate(
        "external_natural_root_end_stone_base",
        8
      )],
      biomeFilter: { test: "has_biome_tag", value: "the_end" },
      minimumY: 0,
      suffix: "_the_end"
    }
  ];

  for (const candidate of dimensions.flatMap(dimension => dimension.candidates)) {
    await writeJson(
      join(OUTPUT_DIRECTORY, `${candidate.name}.json`),
      externalNaturalRootFeature(candidate)
    );
  }
  await writeExternalRootAirCheckFeatures();

  for (const dimension of dimensions) await writeExternalRootDimensionFeatures(dimension);
}

/**
 * Mega spruce and mega pine reuse base_block for their surrounding podzol
 * clusters. Keep that vanilla behavior in the body feature, then mark only
 * the four blocks directly below the confirmed 2 x 2 spruce trunk.
 */
async function writeMegaConiferTreeFeatures(name, sourceDocument, prefix, sourcePath) {
  const sourceTree = sourceDocument["minecraft:tree_feature"];
  if (normalizeSoil(sourceTree.base_block) !== "minecraft:podzol") {
    throw new Error(`${sourcePath}: mega conifer base_block must remain minecraft:podzol.`);
  }
  if (!sourceTree.base_cluster || typeof sourceTree.base_cluster !== "object") {
    throw new Error(`${sourcePath}: mega conifer tree feature has no base_cluster.`);
  }
  const trunkBlock = sourceTree.mega_trunk?.trunk_block;
  if (
    trunkBlock?.name !== "minecraft:log"
    || trunkBlock.states?.old_log_type !== "spruce"
  ) {
    throw new Error(`${sourcePath}: mega conifer trunk is not a spruce log.`);
  }

  const bodyId = `physics_api:${prefix}_tree_body`;
  const rootId = `physics_api:${prefix}_trunk_root`;
  const rootsId = `physics_api:${prefix}_trunk_roots`;
  const bodyDocument = structuredClone(sourceDocument);
  bodyDocument["minecraft:tree_feature"].description.identifier = bodyId;
  await writeJson(join(OUTPUT_DIRECTORY, `${prefix}_tree_body.json`), bodyDocument);
  await writeJson(
    join(OUTPUT_DIRECTORY, `${prefix}_trunk_root.json`),
    megaConiferTrunkRootFeature(rootId, trunkBlock)
  );
  await writeJson(
    join(OUTPUT_DIRECTORY, `${prefix}_trunk_roots.json`),
    megaConiferTrunkRootScatter(rootsId, rootId)
  );

  await writeJson(join(OUTPUT_DIRECTORY, name), {
    format_version: "1.13.0",
    "minecraft:aggregate_feature": {
      description: { identifier: sourceTree.description.identifier },
      early_out: "first_failure",
      features: [bodyId, rootsId]
    }
  });
}

function megaConiferTrunkRootFeature(identifier, trunkBlock) {
  return {
    format_version: "1.13.0",
    "minecraft:single_block_feature": {
      description: { identifier },
      places_block: {
        name: ROOT_BLOCK_ID,
        states: { [ROOT_STATE]: 4 }
      },
      enforce_survivability_rules: false,
      enforce_placement_rules: false,
      may_replace: ["minecraft:podzol"],
      may_attach_to: {
        auto_rotate: false,
        min_sides_must_attach: 1,
        top: [structuredClone(trunkBlock)]
      }
    }
  };
}

function megaConiferTrunkRootScatter(identifier, rootFeatureId) {
  return {
    format_version: "1.13.0",
    "minecraft:scatter_feature": {
      description: { identifier },
      iterations: 4,
      coordinate_eval_order: "xzy",
      x: { distribution: "fixed_grid", extent: [0, 1] },
      y: -1,
      z: { distribution: "fixed_grid", extent: [0, 1] },
      project_input_to_floor: false,
      places_feature: rootFeatureId
    }
  };
}

function taggedRootCandidate(name, tags, variant) {
  return {
    name,
    mayReplace: [{ tags: `query.any_tag(${tags.map(tag => `'${tag}'`).join(", ")})` }],
    variant
  };
}

function dimensionalRootCandidate(name, exactBlocks, variant) {
  return {
    name,
    mayReplace: [
      ...exactBlocks,
      {
        tags: `query.any_tag(${EXTERNAL_ROOT_FOUNDATION_TAGS
          .map(tag => `'${tag}'`)
          .join(", ")})`
      }
    ],
    variant
  };
}

function fallbackRootCandidate(name, variant) {
  return {
    name,
    mayReplace: [{
      tags: `!query.any_tag(${EXTERNAL_ROOT_EXCLUDED_FALLBACK_TAGS
        .map(tag => `'${tag}'`)
        .join(", ")})`
    }],
    variant
  };
}

async function writeExternalRootDimensionFeatures({
  biomeFilter,
  candidates,
  minimumY,
  suffix
}) {
  const selectorName = `external_natural_root${suffix}_feature`;
  const selectorId = `physics_api:${selectorName}`;
  const featureIds = candidates.map(candidate =>
    `physics_api:${candidate.name}`
  );
  featureIds.splice(featureIds.length - 1, 0, "physics_api:external_natural_root_air_check");
  await writeJson(join(OUTPUT_DIRECTORY, `${selectorName}.json`), {
    format_version: "1.21.60",
    "minecraft:aggregate_feature": {
      description: { identifier: selectorId },
      early_out: "first_success",
      features: featureIds
    }
  });

  const featureWriters = [
    [`external_natural_root${suffix}_column`, externalNaturalRootColumn(suffix, selectorId)],
    [`external_natural_root${suffix}_surface`, externalNaturalRootSurface(suffix)],
    [`external_natural_root${suffix}_cave_offset`, externalNaturalRootCaveOffset(suffix, selectorId)],
    [`external_natural_root${suffix}_cave_snap`, externalNaturalRootCaveSnap(suffix)],
    [`external_natural_root${suffix}_cave_threshold`, externalNaturalRootCaveThreshold(suffix)],
    [`external_natural_root${suffix}_caves`, externalNaturalRootCaves(suffix, minimumY)],
    [`external_natural_root${suffix}_placement`, externalNaturalRootPlacement(suffix)]
  ];
  for (const [name, document] of featureWriters) {
    await writeJson(join(OUTPUT_DIRECTORY, `${name}.json`), document);
  }
  const ruleName = `external_natural_root${suffix}_feature`;
  await writeJson(
    join(FEATURE_RULE_OUTPUT_DIRECTORY, `${ruleName}.json`),
    externalNaturalRootFeatureRule(suffix, biomeFilter)
  );
}

function externalNaturalRootFeature({ mayReplace, name, variant }) {
  return {
    format_version: "1.21.60",
    "minecraft:single_block_feature": {
      description: { identifier: `physics_api:${name}` },
      places_block: {
        name: ROOT_BLOCK_ID,
        states: { [ROOT_STATE]: variant }
      },
      enforce_survivability_rules: false,
      enforce_placement_rules: false,
      may_replace: mayReplace,
      may_attach_to: {
        auto_rotate: false,
        min_sides_must_attach: 1,
        top: [{ tags: "query.any_tag('log', 'wood')" }]
      }
    }
  };
}

async function writeExternalRootAirCheckFeatures() {
  const conditionId = "physics_api:external_natural_root_air_condition";
  const restoreId = "physics_api:external_natural_root_air_restore";
  await writeJson(join(OUTPUT_DIRECTORY, "external_natural_root_air_condition.json"), {
    format_version: "1.21.60",
    "minecraft:single_block_feature": {
      description: { identifier: conditionId },
      places_block: "minecraft:cobblestone",
      enforce_survivability_rules: false,
      enforce_placement_rules: false,
      may_replace: ["minecraft:air"],
      may_attach_to: {
        auto_rotate: false,
        min_sides_must_attach: 1,
        top: [{ tags: "query.any_tag('log', 'wood')" }]
      }
    }
  });
  await writeJson(join(OUTPUT_DIRECTORY, "external_natural_root_air_restore.json"), {
    format_version: "1.21.60",
    "minecraft:single_block_feature": {
      description: { identifier: restoreId },
      places_block: "minecraft:air",
      enforce_survivability_rules: false,
      enforce_placement_rules: false,
      may_replace: ["minecraft:cobblestone"]
    }
  });
  await writeJson(join(OUTPUT_DIRECTORY, "external_natural_root_air_check.json"), {
    format_version: "1.21.60",
    "minecraft:aggregate_feature": {
      description: { identifier: "physics_api:external_natural_root_air_check" },
      early_out: "first_failure",
      features: [conditionId, restoreId]
    }
  });
}

function externalNaturalRootColumn(suffix, selectorId) {
  return {
    format_version: "1.21.60",
    "minecraft:search_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_column` },
      places_feature: selectorId,
      search_volume: {
        min: [0, -(EXTERNAL_ROOT_SURFACE_DEPTH - 1), 0],
        max: [0, 0, 0]
      },
      search_axis: "-y",
      required_successes: 1
    }
  };
}

function externalNaturalRootSurface(suffix) {
  return {
    format_version: "1.21.60",
    "minecraft:scatter_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_surface` },
      places_feature: `physics_api:external_natural_root${suffix}_column`,
      distribution: {
        iterations: 256,
        coordinate_eval_order: "xzy",
        x: { distribution: "fixed_grid", extent: [0, 15] },
        y: "query.heightmap(variable.worldx, variable.worldz)",
        z: { distribution: "fixed_grid", extent: [0, 15] }
      }
    }
  };
}

function externalNaturalRootCaveOffset(suffix, selectorId) {
  return {
    format_version: "1.21.60",
    "minecraft:scatter_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_cave_offset` },
      places_feature: selectorId,
      distribution: {
        iterations: 1,
        coordinate_eval_order: "xzy",
        x: 0,
        y: -2,
        z: 0
      }
    }
  };
}

function externalNaturalRootCaveSnap(suffix) {
  return {
    format_version: "1.21.60",
    "minecraft:snap_to_surface_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_cave_snap` },
      feature_to_snap: `physics_api:external_natural_root${suffix}_cave_offset`,
      vertical_search_range: EXTERNAL_ROOT_CAVE_SNAP_RANGE,
      surface: "floor",
      allow_air_placement: true,
      allow_underwater_placement: false
    }
  };
}

function externalNaturalRootCaveThreshold(suffix) {
  return {
    format_version: "1.21.60",
    "minecraft:surface_relative_threshold_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_cave_threshold` },
      feature_to_place: `physics_api:external_natural_root${suffix}_cave_snap`,
      minimum_distance_below_surface: 2
    }
  };
}

function externalNaturalRootCaves(suffix, minimumY) {
  return {
    format_version: "1.21.60",
    "minecraft:scatter_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_caves` },
      places_feature: `physics_api:external_natural_root${suffix}_cave_threshold`,
      distribution: {
        iterations: EXTERNAL_ROOT_CAVE_CANDIDATES,
        coordinate_eval_order: "xzy",
        x: { distribution: "fixed_grid", extent: [0, 15] },
        z: { distribution: "fixed_grid", extent: [0, 15] },
        // The lower bound plus the snap range reaches the dimension minimum Y.
        y: `math.random(${minimumY}, query.heightmap(variable.worldx, variable.worldz) - 2)`
      }
    }
  };
}

function externalNaturalRootPlacement(suffix) {
  return {
    format_version: "1.21.60",
    "minecraft:aggregate_feature": {
      description: { identifier: `physics_api:external_natural_root${suffix}_placement` },
      early_out: "none",
      features: [
        `physics_api:external_natural_root${suffix}_surface`,
        `physics_api:external_natural_root${suffix}_caves`
      ]
    }
  };
}

function externalNaturalRootFeatureRule(suffix, biomeFilter) {
  return {
    format_version: "1.21.60",
    "minecraft:feature_rules": {
      description: {
        identifier: `physics_api:external_natural_root${suffix}_feature`,
        places_feature: `physics_api:external_natural_root${suffix}_placement`
      },
      conditions: {
        placement_pass: "final_pass",
        "minecraft:biome_filter": biomeFilter
      },
      distribution: {
        iterations: 1,
        coordinate_eval_order: "xzy",
        x: 0,
        y: 0,
        z: 0
      }
    }
  };
}

function singleBlockFeature(identifier, variant, mayReplace) {
  return {
    format_version: "1.13.0",
    "minecraft:single_block_feature": {
      description: { identifier },
      places_block: {
        name: ROOT_BLOCK_ID,
        states: { [ROOT_STATE]: variant }
      },
      enforce_survivability_rules: false,
      enforce_placement_rules: false,
      may_replace: mayReplace
    }
  };
}

function scatterFeature(identifier, placesFeature) {
  return {
    format_version: "1.13.0",
    "minecraft:scatter_feature": {
      description: { identifier },
      places_feature: placesFeature,
      iterations: 1,
      x: 0,
      z: 0,
      y: -1
    }
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceBaseBlock(value, sourcePath) {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[1] === "number") {
      return [toRootPermutation(value[0], sourcePath), value[1]];
    }
    return value.map(entry => replaceBaseBlock(entry, sourcePath));
  }
  return toRootPermutation(value, sourcePath);
}

function toRootPermutation(value, sourcePath) {
  const soil = normalizeSoil(value);
  const variant = SOIL_VARIANTS.get(soil);
  if (variant === undefined) {
    throw new Error(`${sourcePath}: unsupported base_block ${JSON.stringify(value)}.`);
  }
  return {
    name: ROOT_BLOCK_ID,
    states: { [ROOT_STATE]: variant }
  };
}

function normalizeSoil(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (value.name === "minecraft:dirt" && value.states?.dirt_type === "coarse") {
    return "minecraft:coarse_dirt";
  }
  return value.name ?? "";
}
