import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let LOG_ENTITY_TYPE_ID = "physics_api:tree_log_fragment";
let LOG_RESOURCE_NAME = "tree_log_fragment";
let LEAF_ENTITY_TYPE_ID = "physics_api:tree_leaf_fragment";
let LEAF_RESOURCE_NAME = "tree_leaf_fragment";
let WIDTH = 7;
let HEIGHT = 4;
let DEPTH = 7;
let SLOT_COUNT = WIDTH * HEIGHT * DEPTH;
const SLOTS_PER_WORD = 8;
let WORD_COUNT = Math.ceil(SLOT_COUNT / SLOTS_PER_WORD);
let LEAF_WIDTH = 7;
let LEAF_HEIGHT = 5;
let LEAF_DEPTH = 7;
let LEAF_SLOT_COUNT = LEAF_WIDTH * LEAF_HEIGHT * LEAF_DEPTH;
const LEAF_SLOTS_PER_WORD = 24;
let LEAF_WORD_COUNT = Math.ceil(LEAF_SLOT_COUNT / LEAF_SLOTS_PER_WORD);
const ENTITY_LIGHT_COLOR_MULTIPLIER = 0.88;
const FOLIAGE_COLORMAPS = [
  "foliage",
  "swamp_foliage",
  "mangrove_swamp_foliage",
  "birch",
  "evergreen",
  "foliage_fixed"
];
const LOG_LAYOUTS = [
  {
    depth: 7,
    entityTypeId: "physics_api:tree_log_fragment",
    height: 4,
    resourceName: "tree_log_fragment",
    width: 7
  },
  {
    depth: 4,
    entityTypeId: "physics_api:tree_tall_log_fragment",
    height: 10,
    resourceName: "tree_tall_log_fragment",
    width: 5
  }
];
const LEAF_LAYOUTS = [
  {
    depth: 7,
    entityTypeId: "physics_api:tree_leaf_fragment",
    height: 5,
    resourceName: "tree_leaf_fragment",
    width: 7
  },
  {
    depth: 6,
    entityTypeId: "physics_api:tree_compact_leaf_fragment",
    height: 5,
    resourceName: "tree_compact_leaf_fragment",
    width: 6
  }
];
const families = [
  {
    name: "oak",
    leaf: "textures/blocks/leaves_oak",
    side: "textures/blocks/log_oak",
    top: "textures/blocks/log_oak_top",
    strippedSide: "textures/blocks/stripped_oak_log",
    strippedTop: "textures/blocks/stripped_oak_log_top"
  },
  {
    name: "spruce",
    leaf: "textures/blocks/leaves_spruce",
    side: "textures/blocks/log_spruce",
    top: "textures/blocks/log_spruce_top",
    strippedSide: "textures/blocks/stripped_spruce_log",
    strippedTop: "textures/blocks/stripped_spruce_log_top"
  },
  {
    name: "birch",
    leaf: "textures/blocks/leaves_birch",
    side: "textures/blocks/log_birch",
    top: "textures/blocks/log_birch_top",
    strippedSide: "textures/blocks/stripped_birch_log",
    strippedTop: "textures/blocks/stripped_birch_log_top"
  },
  {
    name: "jungle",
    leaf: "textures/blocks/leaves_jungle",
    side: "textures/blocks/log_jungle",
    top: "textures/blocks/log_jungle_top",
    strippedSide: "textures/blocks/stripped_jungle_log",
    strippedTop: "textures/blocks/stripped_jungle_log_top"
  },
  {
    name: "acacia",
    leaf: "textures/blocks/leaves_acacia",
    side: "textures/blocks/log_acacia",
    top: "textures/blocks/log_acacia_top",
    strippedSide: "textures/blocks/stripped_acacia_log",
    strippedTop: "textures/blocks/stripped_acacia_log_top"
  },
  {
    name: "dark_oak",
    leaf: "textures/blocks/leaves_big_oak",
    side: "textures/blocks/log_big_oak",
    top: "textures/blocks/log_big_oak_top",
    strippedSide: "textures/blocks/stripped_dark_oak_log",
    strippedTop: "textures/blocks/stripped_dark_oak_log_top"
  },
  {
    name: "cherry",
    leaf: "textures/blocks/cherry_leaves",
    side: "textures/blocks/cherry_log_side",
    top: "textures/blocks/cherry_log_top",
    strippedSide: "textures/blocks/stripped_cherry_log_side",
    strippedTop: "textures/blocks/stripped_cherry_log_top"
  },
  {
    name: "mangrove",
    leaf: "textures/blocks/mangrove_leaves",
    side: "textures/blocks/mangrove_log_side",
    top: "textures/blocks/mangrove_log_top",
    strippedSide: "textures/blocks/stripped_mangrove_log_side",
    strippedTop: "textures/blocks/stripped_mangrove_log_top"
  },
  {
    name: "pale_oak",
    leaf: "textures/blocks/pale_oak_leaves",
    side: "textures/blocks/pale_oak_log_side",
    top: "textures/blocks/pale_oak_log_top",
    strippedSide: "textures/blocks/stripped_pale_oak_log_side",
    strippedTop: "textures/blocks/stripped_pale_oak_log_top"
  },
  {
    name: "azalea",
    leaf: "textures/blocks/azalea_leaves",
    side: "textures/blocks/log_oak",
    top: "textures/blocks/log_oak_top",
    strippedSide: "textures/blocks/stripped_oak_log",
    strippedTop: "textures/blocks/stripped_oak_log_top"
  },
  {
    name: "flowering_azalea",
    leaf: "textures/blocks/azalea_leaves_flowers",
    side: "textures/blocks/log_oak",
    top: "textures/blocks/log_oak_top",
    strippedSide: "textures/blocks/stripped_oak_log",
    strippedTop: "textures/blocks/stripped_oak_log_top"
  }
];

const outputs = new Map();

for (const layout of LEAF_LAYOUTS) {
  selectLeafLayout(layout);
  outputs.set(`packs/TreePhysics/BP/entities/tree_physics/${LEAF_RESOURCE_NAME}.json`, createLeafBehaviorEntity());
  outputs.set(`packs/TreePhysics/RP/entity/tree_physics/${LEAF_RESOURCE_NAME}.json`, createLeafClientEntity());
  outputs.set(`packs/TreePhysics/RP/models/entity/${LEAF_RESOURCE_NAME}.geo.json`, createLeafGeometry());
  outputs.set(`packs/TreePhysics/RP/animations/${LEAF_RESOURCE_NAME}.animation.json`, createLeafAnimation());
  outputs.set(
    `packs/TreePhysics/RP/render_controllers/${LEAF_RESOURCE_NAME}.render_controllers.json`,
    createLeafRenderControllers()
  );
}

for (const layout of LOG_LAYOUTS) {
  selectLogLayout(layout);
  outputs.set(`packs/TreePhysics/BP/entities/tree_physics/${LOG_RESOURCE_NAME}.json`, createBehaviorEntity());
  outputs.set(`packs/TreePhysics/RP/entity/tree_physics/${LOG_RESOURCE_NAME}.json`, createClientEntity());
  outputs.set(`packs/TreePhysics/RP/models/entity/${LOG_RESOURCE_NAME}.geo.json`, createGeometry());
  outputs.set(`packs/TreePhysics/RP/animations/${LOG_RESOURCE_NAME}.animation.json`, createAnimation());
  outputs.set(
    `packs/TreePhysics/RP/render_controllers/${LOG_RESOURCE_NAME}.render_controllers.json`,
    createRenderControllers()
  );
}

for (const [path, value] of outputs) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeResource(value));
}

console.warn(
  `[generate:tree-fragments] logs=${LOG_LAYOUTS.map(layout =>
    `${layout.width}x${layout.height}x${layout.depth}`
  ).join("+")}, leaves=${LEAF_LAYOUTS.map(layout =>
    `${layout.width}x${layout.height}x${layout.depth}`
  ).join("+")}, families=${families.length}`
);

function selectLogLayout(layout) {
  LOG_ENTITY_TYPE_ID = layout.entityTypeId;
  LOG_RESOURCE_NAME = layout.resourceName;
  WIDTH = layout.width;
  HEIGHT = layout.height;
  DEPTH = layout.depth;
  SLOT_COUNT = WIDTH * HEIGHT * DEPTH;
  WORD_COUNT = Math.ceil(SLOT_COUNT / SLOTS_PER_WORD);
}

function selectLeafLayout(layout) {
  LEAF_ENTITY_TYPE_ID = layout.entityTypeId;
  LEAF_RESOURCE_NAME = layout.resourceName;
  LEAF_WIDTH = layout.width;
  LEAF_HEIGHT = layout.height;
  LEAF_DEPTH = layout.depth;
  LEAF_SLOT_COUNT = LEAF_WIDTH * LEAF_HEIGHT * LEAF_DEPTH;
  LEAF_WORD_COUNT = Math.ceil(LEAF_SLOT_COUNT / LEAF_SLOTS_PER_WORD);
}

function createBehaviorEntity() {
  const properties = {
    "physics_api:pitch": syncedFloat(-400, 400),
    "physics_api:yaw": syncedFloat(-400, 400),
    "physics_api:roll": syncedFloat(-400, 400),
    "physics_api:family": syncedInt(0, families.length - 1),
    "physics_api:modes": syncedInt(0, 3),
    "physics_api:origin_xz": syncedInt(0, 0x3fffff),
    "physics_api:origin_y": syncedInt(0, 0x7ff)
  };
  for (let index = 0; index < WORD_COUNT; index++) {
    properties[`physics_api:s${index}`] = syncedInt(0, 0xffffff);
  }
  if (Object.keys(properties).length > 32) throw new Error("Tree fragment exceeds 32 properties.");
  return {
    format_version: "1.20.30",
    "minecraft:entity": {
      description: {
        identifier: LOG_ENTITY_TYPE_ID,
        is_spawnable: false,
        is_summonable: true,
        runtime_identifier: "minecraft:arrow",
        properties
      },
      components: visualEntityComponents()
    }
  };
}

function createLeafBehaviorEntity() {
  const properties = {
    "physics_api:pitch": syncedFloat(-400, 400),
    "physics_api:yaw": syncedFloat(-400, 400),
    "physics_api:roll": syncedFloat(-400, 400),
    "physics_api:family": syncedInt(0, families.length - 1),
    "physics_api:tint": syncedInt(0, 0xffffff),
    "physics_api:origin_xz": syncedInt(0, 0x3fffff),
    "physics_api:origin_y": syncedInt(0, 0x7ff)
  };
  for (let index = 0; index < LEAF_WORD_COUNT; index++) {
    properties[`physics_api:l${index}`] = syncedInt(0, 0xffffff);
  }
  if (Object.keys(properties).length > 32) {
    throw new Error("Tree leaf fragment exceeds 32 properties.");
  }
  return {
    format_version: "1.20.30",
    "minecraft:entity": {
      description: {
        identifier: LEAF_ENTITY_TYPE_ID,
        is_spawnable: false,
        is_summonable: true,
        runtime_identifier: "minecraft:arrow",
        properties
      },
      components: visualEntityComponents()
    }
  };
}

function createClientEntity() {
  const textures = {};
  for (const family of families) {
    textures[`side_${family.name}`] = family.side;
    textures[`top_${family.name}`] = family.top;
    textures[`stripped_side_${family.name}`] = family.strippedSide;
    textures[`stripped_top_${family.name}`] = family.strippedTop;
  }
  return {
    format_version: "1.20.30",
    "minecraft:client_entity": {
      description: {
        identifier: LOG_ENTITY_TYPE_ID,
        materials: {
          log: "opaque_block"
        },
        textures,
        geometry: {
          log_side: `geometry.physics_api.${LOG_RESOURCE_NAME}.log_side`,
          log_top: `geometry.physics_api.${LOG_RESOURCE_NAME}.log_top`
        },
        render_controllers: [
          {
            [`controller.render.physics_api.${LOG_RESOURCE_NAME}.log_side`]:
              "math.mod(q.property('physics_api:modes'), 2) >= 1"
          },
          {
            [`controller.render.physics_api.${LOG_RESOURCE_NAME}.log_top`]:
              "math.mod(q.property('physics_api:modes'), 2) >= 1"
          },
          {
            [`controller.render.physics_api.${LOG_RESOURCE_NAME}.stripped_log_side`]:
              "math.floor(q.property('physics_api:modes') / 2) >= 1"
          },
          {
            [`controller.render.physics_api.${LOG_RESOURCE_NAME}.stripped_log_top`]:
              "math.floor(q.property('physics_api:modes') / 2) >= 1"
          }
        ],
        animations: {
          transform: `animation.physics_api.${LOG_RESOURCE_NAME}.transform`
        },
        scripts: {
          animate: ["transform"],
          pre_animation: [
            "v.pitch = math.lerprotate(v.pitch ?? 0, q.property('physics_api:pitch'), q.delta_time/0.05);",
            "v.yaw = math.lerprotate(v.yaw ?? 0, q.property('physics_api:yaw'), q.delta_time/0.05);",
            "v.roll = math.lerprotate(v.roll ?? 0, q.property('physics_api:roll'), q.delta_time/0.05);",
            ...Array.from(
              { length: WORD_COUNT },
              (_, index) => `v.s${index} = q.property('physics_api:s${index}');`
            )
          ]
        }
      }
    }
  };
}

function createLeafClientEntity() {
  const textures = {};
  for (const family of families) textures[`leaf_${family.name}`] = family.leaf;
  for (const colormap of FOLIAGE_COLORMAPS) {
    textures[`colormap_${colormap}`] = `textures/colormap/${colormap}`;
  }
  return {
    format_version: "1.20.30",
    "minecraft:client_entity": {
      description: {
        identifier: LEAF_ENTITY_TYPE_ID,
        materials: {
          leaves: "alpha_block_color",
          foliage_colormap: "foliage_colormap_multiply"
        },
        textures,
        geometry: {
          leaves: `geometry.physics_api.${LEAF_RESOURCE_NAME}.leaves`,
          foliage_colormap_x: `geometry.physics_api.${LEAF_RESOURCE_NAME}.foliage_colormap_x`,
          foliage_colormap_z: `geometry.physics_api.${LEAF_RESOURCE_NAME}.foliage_colormap_z`
        },
        render_controllers: [
          `controller.render.physics_api.${LEAF_RESOURCE_NAME}.leaves`,
          {
            [`controller.render.physics_api.${LEAF_RESOURCE_NAME}.foliage_colormap`]:
              "v.tint_kind >= 1"
          }
        ],
        animations: { transform: `animation.physics_api.${LEAF_RESOURCE_NAME}.transform` },
        scripts: {
          animate: ["transform"],
          pre_animation: [
            "v.pitch = math.lerprotate(v.pitch ?? 0, q.property('physics_api:pitch'), q.delta_time/0.05);",
            "v.yaw = math.lerprotate(v.yaw ?? 0, q.property('physics_api:yaw'), q.delta_time/0.05);",
            "v.roll = math.lerprotate(v.roll ?? 0, q.property('physics_api:roll'), q.delta_time/0.05);",
            "v.tint = q.property('physics_api:tint');",
            ...Array.from(
              { length: 4 },
              (_, index) => `v.tint_${index} = math.mod(math.floor(v.tint / ${32 ** index}), 32);`
            ),
            `v.tint_state = math.floor(v.tint / ${32 ** 4});`,
            "v.tint_uniform = v.tint_state == 7;",
            "v.tint_axis_z = v.tint_state >= 8;",
            "v.tint_kind = v.tint_uniform ? 1 : math.mod(v.tint_state, 8);",
            "v.tint_pixel_u = math.mod(v.tint, 256);",
            "v.tint_pixel_v = math.mod(math.floor(v.tint / 256), 256);",
            ...Array.from(
              { length: LEAF_WORD_COUNT },
              (_, index) => `v.l${index} = q.property('physics_api:l${index}');`
            )
          ]
        }
      }
    }
  };
}

function createGeometry() {
  return {
    format_version: "1.12.0",
    "minecraft:geometry": [
      createGeometryLayer("log_side", sideFaces()),
      createGeometryLayer("log_top", endFaces())
    ]
  };
}

function createLeafGeometry() {
  return {
    format_version: "1.12.0",
    "minecraft:geometry": [
      createLeafGeometryLayer("leaves", 16, 16, () => allFaces()),
      createLeafGeometryLayer(
        "foliage_colormap_x",
        LEAF_WIDTH * 16,
        LEAF_WIDTH * 16,
        ({ x }) => colormapFaces(x, x)
      ),
      createLeafGeometryLayer(
        "foliage_colormap_z",
        LEAF_DEPTH * 16,
        LEAF_DEPTH * 16,
        ({ z }) => colormapFaces(z, z)
      )
    ]
  };
}

function createLeafGeometryLayer(name, textureWidth, textureHeight, createUv) {
  const bones = leafTransformBones();
  for (let slot = 0; slot < LEAF_SLOT_COUNT; slot++) {
    const location = leafSlotLocation(slot);
    const { x, y, z } = location;
    const pivot = [x * 16, (y - 1) * 16, -z * 16];
    bones.push({
      name: `slot_${slot}`,
      parent: "fragment_offset",
      pivot,
      cubes: [{
        origin: [pivot[0] - 8, pivot[1] - 8, pivot[2] - 8],
        size: [16, 16, 16],
        uv: createUv(location)
      }]
    });
  }
  return {
    description: {
      identifier: `geometry.physics_api.${LEAF_RESOURCE_NAME}.${name}`,
      texture_width: textureWidth,
      texture_height: textureHeight,
      visible_bounds_width: 128,
      visible_bounds_height: 128,
      visible_bounds_offset: [0, 0, 0]
    },
    bones
  };
}

function createGeometryLayer(name, uv) {
  const bones = transformBones();
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const { x, y, z } = slotLocation(slot);
    const pivot = [x * 16, (y - 1) * 16, -z * 16];
    bones.push({
      name: `slot_${slot}`,
      parent: "fragment_offset",
      pivot,
      cubes: [{
        origin: [pivot[0] - 8, pivot[1] - 8, pivot[2] - 8],
        size: [16, 16, 16],
        uv
      }]
    });
  }
  return {
    description: {
      identifier: `geometry.physics_api.${LOG_RESOURCE_NAME}.${name}`,
      texture_width: 16,
      texture_height: 16,
      visible_bounds_width: 128,
      visible_bounds_height: 128,
      visible_bounds_offset: [0, 0, 0]
    },
    bones
  };
}

function createAnimation() {
  const bones = {
    root: { rotation: ["-q.body_x_rotation", "-q.body_y_rotation", 0] },
    pitch: { rotation: ["v.pitch", 0, 0] },
    roll: { rotation: [0, 0, "-v.roll"] },
    yaw: { rotation: [0, "-v.yaw", 0] },
    fragment_offset: {
      position: [
        "(math.mod(q.property('physics_api:origin_xz'), 2048) - 1024) * 16",
        "(q.property('physics_api:origin_y') - 1024) * 16",
        "-(math.floor(q.property('physics_api:origin_xz') / 2048) - 1024) * 16"
      ]
    }
  };
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const state = stateExpression(slot);
    bones[`slot_${slot}`] = {
      rotation: [
        `((${state}) == 4 || (${state}) == 7) ? 90 : 0`,
        0,
        `((${state}) == 3 || (${state}) == 6) ? 90 : 0`
      ]
    };
  }
  return {
    format_version: "1.8.0",
    animations: {
      [`animation.physics_api.${LOG_RESOURCE_NAME}.transform`]: { loop: true, bones }
    }
  };
}

function createLeafAnimation() {
  return {
    format_version: "1.8.0",
    animations: {
      [`animation.physics_api.${LEAF_RESOURCE_NAME}.transform`]: {
        loop: true,
        bones: {
          root: { rotation: ["-q.body_x_rotation", "-q.body_y_rotation", 0] },
          pitch: { rotation: ["v.pitch", 0, 0] },
          roll: { rotation: [0, 0, "-v.roll"] },
          yaw: { rotation: [0, "-v.yaw", 0] },
          fragment_offset: {
            position: [
              "(math.mod(q.property('physics_api:origin_xz'), 2048) - 1024) * 16",
              "(q.property('physics_api:origin_y') - 1024) * 16",
              "-(math.floor(q.property('physics_api:origin_xz') / 2048) - 1024) * 16"
            ]
          }
        }
      }
    }
  };
}

function createRenderControllers() {
  const arrays = createTextureArrays();
  const family = "q.property('physics_api:family')";
  return {
    format_version: "1.10.0",
    render_controllers: {
      [`controller.render.physics_api.${LOG_RESOURCE_NAME}.log_side`]: {
        arrays: { textures: { "Array.log_side": arrays.sideTextures } },
        geometry: "Geometry.log_side",
        light_color_multiplier: ENTITY_LIGHT_COLOR_MULTIPLIER,
        materials: [{ "*": "Material.log" }],
        textures: [`Array.log_side[${family}]`],
        part_visibility: slotVisibility(state => `(${state}) >= 2 && (${state}) <= 4`)
      },
      [`controller.render.physics_api.${LOG_RESOURCE_NAME}.log_top`]: {
        arrays: { textures: { "Array.log_top": arrays.topTextures } },
        geometry: "Geometry.log_top",
        light_color_multiplier: ENTITY_LIGHT_COLOR_MULTIPLIER,
        materials: [{ "*": "Material.log" }],
        textures: [`Array.log_top[${family}]`],
        part_visibility: slotVisibility(state => `(${state}) >= 2 && (${state}) <= 4`)
      },
      [`controller.render.physics_api.${LOG_RESOURCE_NAME}.stripped_log_side`]: {
        arrays: { textures: { "Array.stripped_log_side": arrays.strippedSideTextures } },
        geometry: "Geometry.log_side",
        light_color_multiplier: ENTITY_LIGHT_COLOR_MULTIPLIER,
        materials: [{ "*": "Material.log" }],
        textures: [`Array.stripped_log_side[${family}]`],
        part_visibility: slotVisibility(state => `(${state}) >= 5`)
      },
      [`controller.render.physics_api.${LOG_RESOURCE_NAME}.stripped_log_top`]: {
        arrays: { textures: { "Array.stripped_log_top": arrays.strippedTopTextures } },
        geometry: "Geometry.log_top",
        light_color_multiplier: ENTITY_LIGHT_COLOR_MULTIPLIER,
        materials: [{ "*": "Material.log" }],
        textures: [`Array.stripped_log_top[${family}]`],
        part_visibility: slotVisibility(state => `(${state}) >= 5`)
      }
    }
  };
}

function createLeafRenderControllers() {
  const leafTextures = families.map(family => `Texture.leaf_${family.name}`);
  const colormaps = FOLIAGE_COLORMAPS.map(name => `Texture.colormap_${name}`);
  const family = "q.property('physics_api:family')";
  const tintKind = tintKindExpression();
  return {
    format_version: "1.10.0",
    render_controllers: {
      [`controller.render.physics_api.${LEAF_RESOURCE_NAME}.leaves`]: {
        arrays: { textures: { "Array.leaves": leafTextures } },
        geometry: "Geometry.leaves",
        materials: [{ "*": "Material.leaves" }],
        textures: [`Array.leaves[${family}]`],
        part_visibility: leafSlotVisibility()
      },
      [`controller.render.physics_api.${LEAF_RESOURCE_NAME}.foliage_colormap`]: {
        arrays: {
          geometries: {
            "Array.foliage_colormap": [
              "Geometry.foliage_colormap_x",
              "Geometry.foliage_colormap_z"
            ]
          },
          textures: { "Array.colormaps": colormaps }
        },
        geometry: "Array.foliage_colormap[v.tint_axis_z]",
        materials: [{ "*": "Material.foliage_colormap" }],
        textures: [`Array.colormaps[math.max(0, (${tintKind}) - 1)]`],
        part_visibility: leafSlotVisibility(),
        uv_anim: foliageUvAnimation()
      }
    }
  };
}

function createTextureArrays() {
  return {
    sideTextures: families.map(family => `Texture.side_${family.name}`),
    topTextures: families.map(family => `Texture.top_${family.name}`),
    strippedSideTextures: families.map(family => `Texture.stripped_side_${family.name}`),
    strippedTopTextures: families.map(family => `Texture.stripped_top_${family.name}`)
  };
}

function slotVisibility(predicate) {
  const result = [{ "*": false }];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    result.push({ [`slot_${slot}`]: predicate(stateExpression(slot)) });
  }
  return result;
}

function stateExpression(slot) {
  const word = Math.floor(slot / SLOTS_PER_WORD);
  const shift = (slot % SLOTS_PER_WORD) * 3;
  return `math.mod(math.floor(v.s${word} / ${2 ** shift}), 8)`;
}

function leafStateExpression(slot) {
  const word = Math.floor(slot / LEAF_SLOTS_PER_WORD);
  const shift = slot % LEAF_SLOTS_PER_WORD;
  return `math.mod(math.floor(v.l${word} / ${2 ** shift}), 2)`;
}

function leafSlotVisibility(predicate = state => `(${state}) >= 1`) {
  const result = [{ "*": false }];
  for (let slot = 0; slot < LEAF_SLOT_COUNT; slot++) {
    result.push({ [`slot_${slot}`]: predicate(leafStateExpression(slot)) });
  }
  return result;
}

function tintCoordinateExpression(index) {
  return `v.tint_${index}`;
}

function tintKindExpression() {
  return "v.tint_kind";
}

function foliageUvAnimation() {
  const u0 = tintCoordinateExpression(0);
  const v0 = tintCoordinateExpression(1);
  const u1 = tintCoordinateExpression(2);
  const v1 = tintCoordinateExpression(3);
  return {
    offset: [
      `v.tint_uniform ? (v.tint_pixel_u + 0.5) / 256 : ${colormapCoordinate(u0)}`,
      `v.tint_uniform ? (v.tint_pixel_v + 0.5) / 256 : ${colormapCoordinate(v0)}`
    ],
    scale: [
      `v.tint_uniform ? 0 : ${colormapSpan(u0, u1)}`,
      `v.tint_uniform ? 0 : ${colormapSpan(v0, v1)}`
    ]
  };
}

function colormapCoordinate(value) {
  return `(0.5 + (${value}) * 255 / 31) / 256`;
}

function colormapSpan(start, end) {
  return `((${end}) - (${start})) * 255 / 7936`;
}

function transformBones() {
  return [
    { name: "root", pivot: [0, 0, 0] },
    { name: "yaw", parent: "root", pivot: [0, 0, 0] },
    { name: "roll", parent: "yaw", pivot: [0, 0, 0] },
    { name: "pitch", parent: "roll", pivot: [0, 0, 0] },
    { name: "fragment_offset", parent: "pitch", pivot: [0, 0, 0] }
  ];
}

function leafTransformBones() {
  return [
    { name: "root", pivot: [0, 0, 0] },
    { name: "yaw", parent: "root", pivot: [0, 0, 0] },
    { name: "roll", parent: "yaw", pivot: [0, 0, 0] },
    { name: "pitch", parent: "roll", pivot: [0, 0, 0] },
    { name: "fragment_offset", parent: "pitch", pivot: [0, 0, 0] }
  ];
}

function slotLocation(slot) {
  const layerSize = WIDTH * DEPTH;
  const y = Math.floor(slot / layerSize);
  const remainder = slot % layerSize;
  return { x: remainder % WIDTH, y, z: Math.floor(remainder / WIDTH) };
}

function leafSlotLocation(slot) {
  const layerSize = LEAF_WIDTH * LEAF_DEPTH;
  const y = Math.floor(slot / layerSize);
  const remainder = slot % layerSize;
  return { x: remainder % LEAF_WIDTH, y, z: Math.floor(remainder / LEAF_WIDTH) };
}

function allFaces(textureSize = 16) {
  return Object.fromEntries(
    ["north", "east", "south", "west", "up", "down"]
      .map(face => [face, { uv: [0, 0], uv_size: [textureSize, textureSize] }])
  );
}

function colormapFaces(x, z) {
  return Object.fromEntries(
    ["north", "east", "south", "west", "up", "down"]
      .map(face => [face, { uv: [x * 16, z * 16], uv_size: [16, 16] }])
  );
}

function sideFaces() {
  return Object.fromEntries(
    ["north", "east", "south", "west"]
      .map(face => [face, { uv: [0, 0], uv_size: [16, 16] }])
  );
}

function endFaces() {
  return Object.fromEntries(
    ["up", "down"].map(face => [face, { uv: [0, 0], uv_size: [16, 16] }])
  );
}

function syncedFloat(minimum, maximum) {
  return {
    type: "float",
    range: [floatLiteral(minimum), floatLiteral(maximum)],
    client_sync: true,
    default: "0"
  };
}

function syncedInt(minimum, maximum, defaultValue = 0) {
  return { type: "int", range: [minimum, maximum], client_sync: true, default: defaultValue };
}

function floatLiteral(value) {
  if (!Number.isInteger(value)) throw new TypeError("Generated float literal must be integral.");
  return `__physics_api_float:${value}__`;
}

function serializeResource(value) {
  const json = JSON.stringify(value, null, 2).replace(
    /"__physics_api_float:(-?\d+)__"/g,
    (_match, integer) => `${integer}.0`
  );
  return `${json}\n`;
}

function visualEntityComponents() {
  return {
    "minecraft:type_family": { family: ["physics_api_visual", "inanimate"] },
    "minecraft:damage_sensor": { triggers: [{ cause: "all", deals_damage: false }] },
    "minecraft:collision_box": { height: 0, width: 0 },
    "minecraft:pushable": { is_pushable: false, is_pushable_by_piston: false },
    "minecraft:persistent": {},
    "minecraft:physics": { has_collision: false, has_gravity: false },
    "minecraft:conditional_bandwidth_optimization": {
      conditional_values: [],
      default_values: {}
    }
  };
}
