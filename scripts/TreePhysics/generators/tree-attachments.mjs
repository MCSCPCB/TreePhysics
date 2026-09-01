import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ENTITY_TYPE_ID = "physics_api:tree_attachment_fragment";
const MODEL_DIRECTORY = "sample/vanilla-block-model";
const SLOT_COUNT = 26;
const ENTITY_LIGHT_COLOR_MULTIPLIER = 0.88;
const FOLIAGE_COLORMAPS = [
  "foliage",
  "swamp_foliage",
  "mangrove_swamp_foliage",
  "birch",
  "evergreen",
  "foliage_fixed"
];
const FAMILY = {
  beeNest: 0,
  cocoa: 1,
  hangingRoots: 2,
  mangrovePropagule: 3,
  paleHangingMoss: 4,
  vine: 5,
  mangroveRoots: 6,
  muddyMangroveRoots: 7,
  creakingHeart: 8
};
const VINE_DIRECTIONS = [
  {
    condition: "math.mod(math.floor(q.property('physics_api:state') / 4), 2) >= 1",
    name: "north",
    rotation: { x: 0, y: 0, z: 0 }
  },
  {
    condition: "math.mod(math.floor(q.property('physics_api:state') / 8), 2) >= 1",
    name: "east",
    rotation: { x: 0, y: 270, z: 0 }
  },
  {
    condition: "math.mod(q.property('physics_api:state'), 2) >= 1",
    name: "south",
    rotation: { x: 0, y: 180, z: 0 }
  },
  {
    condition: "math.mod(math.floor(q.property('physics_api:state') / 2), 2) >= 1",
    name: "west",
    rotation: { x: 0, y: 90, z: 0 }
  }
];

const variants = [
  variant("bee_nest_empty", FAMILY.beeNest, "bee_nest_empty", "math.floor(q.property('physics_api:state') / 4) == 0", "opaque_block"),
  variant("bee_nest_honey", FAMILY.beeNest, "bee_nest_honey", "math.floor(q.property('physics_api:state') / 4) == 1", "opaque_block"),
  variant("cocoa_0", FAMILY.cocoa, "cocoa_stage0", "math.floor(q.property('physics_api:state') / 4) == 0", "alpha_block_color"),
  variant("cocoa_1", FAMILY.cocoa, "cocoa_stage1", "math.floor(q.property('physics_api:state') / 4) == 1", "alpha_block_color"),
  variant("cocoa_2", FAMILY.cocoa, "cocoa_stage2", "math.floor(q.property('physics_api:state') / 4) == 2", "alpha_block_color"),
  variant("hanging_roots", FAMILY.hangingRoots, "hanging_roots", "1", "alpha_block_color"),
  ...Array.from({ length: 5 }, (_, stage) => variant(
    `mangrove_propagule_${stage}`,
    FAMILY.mangrovePropagule,
    `mangrove_propagule_hanging_${stage}`,
    `q.property('physics_api:state') == ${stage}`,
    "alpha_block_color"
  )),
  variant("pale_hanging_moss", FAMILY.paleHangingMoss, "pale_hanging_moss", "q.property('physics_api:state') == 0", "alpha_block_color"),
  variant("pale_hanging_moss_tip", FAMILY.paleHangingMoss, "pale_hanging_moss_tip", "q.property('physics_api:state') == 1", "alpha_block_color"),
  vineVariant(),
  variant("mangrove_roots", FAMILY.mangroveRoots, "mangrove_roots", "1", "alpha_block_color"),
  variant("muddy_mangrove_roots", FAMILY.muddyMangroveRoots, "muddy_mangrove_roots", "1", "opaque_block"),
  ...creakingHeartVariants()
];

const resolvedModels = new Map();
const geometries = [];
const controllers = {};
const clientGeometries = {};
const clientTextures = Object.fromEntries(
  FOLIAGE_COLORMAPS.map(name => [`colormap_${name}`, `textures/colormap/${name}`])
);
const clientControllers = [];

for (const entry of variants) {
  const model = await resolveModel(entry.model);
  const layers = convertModelToLayers(model, entry);
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    const key = `${entry.name}_${layerIndex}`;
    const geometryAlias = `geometry_${key}`;
    const textureAlias = `texture_${sanitize(layer.texture)}`;
    const controllerId = `controller.render.physics_api.tree_attachment_fragment.${key}`;
    const geometryId = `geometry.physics_api.tree_attachment_fragment.${key}`;
    clientGeometries[geometryAlias] = geometryId;
    clientTextures[textureAlias] = layer.texture;
    geometries.push({
      description: {
        identifier: geometryId,
        texture_width: 16,
        texture_height: 16,
        visible_bounds_width: 128,
        visible_bounds_height: 128,
        visible_bounds_offset: [0, 0, 0]
      },
      bones: layer.bones
    });
    const partVisibility = createPartVisibility(layer.bones, entry);
    const controller = {
      geometry: `Geometry.${geometryAlias}`,
      light_color_multiplier: ENTITY_LIGHT_COLOR_MULTIPLIER,
      materials: [{ "*": entry.material === "alpha_block_color" ? "Material.foliage" : `Material.${entry.material === "opaque_block" ? "opaque" : "cutout"}` }],
      textures: [`Texture.${textureAlias}`],
      part_visibility: partVisibility
    };
    clientControllers.push({
      [controllerId]: attachmentFamilyMaskCondition(entry.family)
    });
    controllers[controllerId] = controller;
    // Only vines carry an assembly foliage colormap. Cocoa uses the same
    // alpha_block_color base material for correct transparency, but its
    // colormap kind is intentionally disabled, so extra overlay controllers
    // would only add per-entity render checks.
    if (entry.material === "alpha_block_color" && entry.foliageColormap === true) {
      const familyCondition = attachmentFamilyMaskCondition(entry.family);
      const uniformControllerId = `${controllerId}_foliage_colormap_uniform`;
      clientControllers.push({
        [uniformControllerId]: `(${familyCondition}) && v.tint_uniform && v.tint_kind >= 1`
      });
      controllers[uniformControllerId] = {
        arrays: {
          textures: {
            "Array.colormaps": FOLIAGE_COLORMAPS.map(name =>
              `Texture.colormap_${name}`
            )
          }
        },
        geometry: `Geometry.${geometryAlias}`,
        materials: [{ "*": "Material.foliage_colormap" }],
        textures: [
          `Array.colormaps[math.max(0, (${tintKindExpression()}) - 1)]`
        ],
        part_visibility: createPartVisibility(layer.bones, entry),
        uv_anim: uniformFoliageUvAnimation()
      };
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const colormapControllerId = `${controllerId}_foliage_colormap_${slot}`;
        clientControllers.push({
          [colormapControllerId]: `(${familyCondition}) && !v.tint_uniform && v.tint_kind >= 1`
        });
        controllers[colormapControllerId] = {
          arrays: {
            textures: {
              "Array.colormaps": FOLIAGE_COLORMAPS.map(name =>
                `Texture.colormap_${name}`
              )
            }
          },
          geometry: `Geometry.${geometryAlias}`,
          materials: [{ "*": "Material.foliage_colormap" }],
          textures: [
            `Array.colormaps[math.max(0, (${tintKindExpression()}) - 1)]`
          ],
          part_visibility: createPartVisibility(layer.bones, entry, [slot]),
          uv_anim: gradientFoliageUvAnimation(slot)
        };
      }
    }
  }
}

const outputs = new Map([
  ["packs/TreePhysics/BP/entities/tree_physics/tree_attachment_fragment.json", createBehaviorEntity()],
  ["packs/TreePhysics/RP/entity/tree_physics/tree_attachment_fragment.json", createClientEntity()],
  ["packs/TreePhysics/RP/models/entity/tree_attachment_fragment.geo.json", {
    format_version: "1.12.0",
    "minecraft:geometry": geometries
  }],
  ["packs/TreePhysics/RP/animations/tree_attachment_fragment.animation.json", createAnimation()],
  ["packs/TreePhysics/RP/render_controllers/tree_attachment_fragment.render_controllers.json", {
    format_version: "1.10.0",
    render_controllers: controllers
  }]
]);

for (const [path, value] of outputs) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeResource(value));
}

console.warn(
  `[generate:tree-attachments] ${variants.length} variants, ${geometries.length} texture layers`
);

function variant(name, family, model, condition, material, rotation = {}) {
  return {
    condition,
    family,
    foliageColormap: family === FAMILY.vine,
    material,
    model,
    name,
    rotation: { x: rotation.x ?? 0, y: rotation.y ?? 0, z: rotation.z ?? 0 }
  };
}

function vineVariant() {
  return {
    ...variant("vine", FAMILY.vine, "vine", "1", "alpha_block_color"),
    directions: VINE_DIRECTIONS.map(direction => ({
      ...direction,
      rotation: { ...direction.rotation }
    }))
  };
}

function creakingHeartVariants() {
  const modes = [
    { index: 0, name: "inactive", vertical: "creaking_heart", horizontal: "creaking_heart_horizontal" },
    { index: 1, name: "dormant", vertical: "creaking_heart_dormant", horizontal: "creaking_heart_dormant_horizontal" },
    { index: 2, name: "awake", vertical: "creaking_heart_awake", horizontal: "creaking_heart_awake_horizontal" }
  ];
  const result = [];
  for (const mode of modes) {
    result.push(variant(
      `creaking_heart_${mode.name}_y`,
      FAMILY.creakingHeart,
      mode.vertical,
      `math.floor(q.property('physics_api:state') / 3) == ${mode.index} && math.mod(q.property('physics_api:state'), 3) == 0`,
      "opaque_block"
    ));
    result.push(variant(
      `creaking_heart_${mode.name}_x`,
      FAMILY.creakingHeart,
      mode.horizontal,
      `math.floor(q.property('physics_api:state') / 3) == ${mode.index} && math.mod(q.property('physics_api:state'), 3) == 1`,
      "opaque_block",
      { x: 90, y: 90 }
    ));
    result.push(variant(
      `creaking_heart_${mode.name}_z`,
      FAMILY.creakingHeart,
      mode.horizontal,
      `math.floor(q.property('physics_api:state') / 3) == ${mode.index} && math.mod(q.property('physics_api:state'), 3) == 2`,
      "opaque_block",
      { x: 90 }
    ));
  }
  return result;
}

async function resolveModel(name) {
  if (resolvedModels.has(name)) return resolvedModels.get(name);
  const raw = JSON.parse(await readFile(join(MODEL_DIRECTORY, `${name}.json`), "utf8"));
  let parent = { elements: [], textures: {} };
  if (typeof raw.parent === "string") parent = await resolveModel(modelName(raw.parent));
  const result = {
    elements: raw.elements ?? parent.elements,
    textures: { ...parent.textures, ...(raw.textures ?? {}) }
  };
  resolvedModels.set(name, result);
  return result;
}

function modelName(reference) {
  return reference.replace(/^minecraft:/, "").replace(/^block\//, "");
}

function convertModelToLayers(model, entry) {
  const textures = new Map();
  for (const element of model.elements) {
    for (const [faceName, face] of Object.entries(element.faces ?? {})) {
      const texture = normalizeTexture(resolveTexture(face.texture, model.textures));
      let elements = textures.get(texture);
      if (!elements) {
        elements = new Map();
        textures.set(texture, elements);
      }
      let faces = elements.get(element);
      if (!faces) {
        faces = {};
        elements.set(element, faces);
      }
      faces[convertFaceName(faceName)] = convertFace(
        bedrockAttachmentFace(entry, element, faceName, face)
      );
    }
  }
  return [...textures.entries()].map(([texture, elements]) => ({
    texture,
    bones: entry.directions
      ? createDirectionalLayerBones(elements, entry.directions)
      : createLayerBones(elements, entry.rotation)
  }));
}

function createLayerBones(elements, rotation) {
  const bones = transformBones();
  const hasRotation = rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0;
  const compoundRotation = rotation.x !== 0 && rotation.y !== 0;
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const slotBone = {
      name: `slot_${slot}`,
      parent: "attachment_offset",
      pivot: [0, 0, 0]
    };
    bones.push(slotBone);
    let elementParent = `slot_${slot}`;
    let elementParentBone = slotBone;
    if (compoundRotation) {
      bones.push({
        name: `variant_y_${slot}`,
        parent: `slot_${slot}`,
        pivot: [0, -16, 0],
        rotation: [0, normalizeBoneAngle(-rotation.y), 0]
      });
      const xVariant = {
        name: `variant_x_${slot}`,
        parent: `variant_y_${slot}`,
        pivot: [0, -16, 0],
        rotation: [-rotation.x, 0, rotation.z]
      };
      bones.push(xVariant);
      elementParent = `variant_x_${slot}`;
      elementParentBone = xVariant;
    } else if (hasRotation) {
      elementParent = `variant_${slot}`;
      const variantBone = {
        name: elementParent,
        parent: `slot_${slot}`,
        pivot: [0, -16, 0],
        rotation: [
          normalizeBoneAngle(-rotation.x),
          normalizeBoneAngle(-rotation.y),
          normalizeBoneAngle(rotation.z)
        ]
      };
      bones.push(variantBone);
      elementParentBone = variantBone;
    }
    appendLayerElements(
      bones,
      elements,
      elementParent,
      elementParentBone,
      `slot_${slot}_element`
    );
  }
  return bones;
}

function createDirectionalLayerBones(elements, directions) {
  const bones = transformBones();
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    bones.push({
      name: `slot_${slot}`,
      parent: "attachment_offset",
      pivot: [0, 0, 0]
    });
    for (const direction of directions) {
      const directionBone = {
        name: `vine_${direction.name}_${slot}`,
        parent: `slot_${slot}`,
        pivot: [0, -16, 0],
        rotation: [
          normalizeBoneAngle(-direction.rotation.x),
          normalizeBoneAngle(-direction.rotation.y),
          normalizeBoneAngle(direction.rotation.z)
        ]
      };
      bones.push(directionBone);
      appendLayerElements(
        bones,
        elements,
        directionBone.name,
        directionBone,
        `${directionBone.name}_element`
      );
    }
  }
  return bones;
}

function appendLayerElements(
  bones,
  elements,
  elementParent,
  elementParentBone,
  rotatedBonePrefix
) {
  const rotatedGroups = new Map();
  for (const [element, faces] of elements) {
    const rotationOrigin = element.rotation?.origin ?? [8, 8, 8];
    const { from, to } = rescaleElementBounds(element, rotationOrigin);
    const cube = {
      origin: [from[0] - 8, from[1] - 24, 8 - to[2]],
      size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
      uv: faces
    };
    if (element.rotation?.angle) {
      const groupKey = JSON.stringify([
        element.rotation.axis,
        element.rotation.angle,
        rotationOrigin
      ]);
      let bone = rotatedGroups.get(groupKey);
      if (!bone) {
        bone = {
          name: `${rotatedBonePrefix}_${rotatedGroups.size}`,
          parent: elementParent,
          pivot: convertPoint(rotationOrigin),
          rotation: convertElementRotation(element.rotation.axis, element.rotation.angle),
          cubes: []
        };
        rotatedGroups.set(groupKey, bone);
        bones.push(bone);
      }
      bone.cubes.push(cube);
    } else {
      elementParentBone.cubes ??= [];
      elementParentBone.cubes.push(cube);
    }
  }
}

function createPartVisibility(
  bones,
  entry,
  slots = Array.from({ length: SLOT_COUNT }, (_, slot) => slot)
) {
  if (entry.directions) {
    return createDirectionalPartVisibility(bones, entry, slots);
  }
  const parentByName = new Map(bones.map(bone => [bone.name, bone.parent]));
  const result = [{ "*": false }];
  for (const slot of slots) {
    const slotName = `slot_${slot}`;
    const condition = slotVariantCondition(entry, slot);
    for (const bone of bones) {
      if (isBoneInSlot(bone.name, slotName, parentByName)) {
        result.push({ [bone.name]: condition });
      }
    }
  }
  return result;
}

function createDirectionalPartVisibility(bones, entry, slots) {
  const parentByName = new Map(bones.map(bone => [bone.name, bone.parent]));
  const result = [{ "*": false }];
  for (const slot of slots) {
    const slotName = `slot_${slot}`;
    const familyCondition = slotFamilyCondition(entry, slot);
    const slotCondition = familyCondition;
    result.push({ [slotName]: slotCondition });
    for (const direction of entry.directions) {
      const directionName = `vine_${direction.name}_${slot}`;
      const state = stateExpression(slot);
      const directionCondition = direction.condition.replaceAll(
        "q.property('physics_api:state')",
        state
      );
      const condition = `(${slotCondition}) && (${directionCondition})`;
      for (const bone of bones) {
        if (isBoneInSlot(bone.name, directionName, parentByName)) {
          result.push({ [bone.name]: condition });
        }
      }
    }
  }
  return result;
}

function isBoneInSlot(name, slotName, parentByName) {
  let current = name;
  while (current) {
    if (current === slotName) return true;
    current = parentByName.get(current);
  }
  return false;
}

function rescaleElementBounds(element, origin) {
  const rotation = element.rotation;
  if (!rotation?.rescale || !rotation.angle) {
    return { from: element.from, to: element.to };
  }
  const factor = 1 / Math.cos(Math.abs(rotation.angle) * Math.PI / 180);
  const scaledAxes = rotation.axis === "x"
    ? [false, true, true]
    : rotation.axis === "y"
      ? [true, false, true]
      : [true, true, false];
  const scalePoint = point => point.map((value, axis) => scaledAxes[axis]
    ? origin[axis] + (value - origin[axis]) * factor
    : value);
  return { from: scalePoint(element.from), to: scalePoint(element.to) };
}

function transformBones() {
  return [
    { name: "root", pivot: [0, 0, 0] },
    { name: "yaw", parent: "root", pivot: [0, 0, 0] },
    { name: "roll", parent: "yaw", pivot: [0, 0, 0] },
    { name: "pitch", parent: "roll", pivot: [0, 0, 0] },
    { name: "attachment_offset", parent: "pitch", pivot: [0, 0, 0] }
  ];
}

function convertPoint(point) {
  return [point[0] - 8, point[1] - 24, 8 - point[2]];
}

function convertElementRotation(axis, angle) {
  if (axis === "x") return [-angle, 0, 0];
  if (axis === "y") return [0, -angle, 0];
  return [0, 0, angle];
}

function normalizeBoneAngle(angle) {
  const normalized = ((angle % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}

function convertFaceName(face) {
  if (face === "north") return "south";
  if (face === "south") return "north";
  return face;
}

function bedrockAttachmentFace(entry, element, faceName, face) {
  const cocoaStem = entry.family === FAMILY.cocoa
    && element.from?.[0] === 8
    && element.from?.[1] === 12
    && element.from?.[2] === 12
    && element.to?.[0] === 8
    && element.to?.[1] === 16
    && element.to?.[2] === 16;
  if (cocoaStem) {
    const uv = Array.isArray(face.uv) ? face.uv : [0, 0, 16, 16];
    return { ...face, uv: [uv[2], uv[1], uv[0], uv[3]] };
  }

  const matureCocoaBody = entry.model === "cocoa_stage2"
    && element.from?.[0] === 4
    && element.from?.[1] === 3
    && element.from?.[2] === 7;
  if (!matureCocoaBody) return face;

  // Bedrock's current mature cocoa texture is not laid out like the Java
  // model source: its four side strips start at U=7, while the top and bottom
  // occupy a 7x7 region. These explicit UVs match the vanilla Bedrock atlas.
  return {
    ...face,
    uv: faceName === "up" || faceName === "down"
      ? [0, 0, 7, 7]
      : [7, 4, 15, 13]
  };
}

function convertFace(face) {
  const uv = Array.isArray(face.uv) ? face.uv : [0, 0, 16, 16];
  const result = {
    uv: [uv[0], uv[1]],
    uv_size: [uv[2] - uv[0], uv[3] - uv[1]]
  };
  if (face.rotation) result.uv_rotation = face.rotation;
  return result;
}

function resolveTexture(reference, textures, seen = new Set()) {
  if (typeof reference !== "string") throw new Error("Attachment face is missing a texture.");
  if (!reference.startsWith("#")) return reference;
  const key = reference.slice(1);
  if (seen.has(key)) throw new Error(`Circular texture alias: ${key}`);
  seen.add(key);
  return resolveTexture(textures[key], textures, seen);
}

function normalizeTexture(reference) {
  let path = reference.replace(/^minecraft:/, "").replace(/^block\//, "");
  const replacements = {
    cocoa_stage0: "cocoa_stage_0",
    cocoa_stage1: "cocoa_stage_1",
    cocoa_stage2: "cocoa_stage_2",
    creaking_heart: "creaking_heart_side_inactive",
    creaking_heart_top: "creaking_heart_top_inactive",
    creaking_heart_dormant: "creaking_heart_side_dormant",
    creaking_heart_awake: "creaking_heart_side_active",
    creaking_heart_top_awake: "creaking_heart_top_active",
    pale_hanging_moss: "pale_hanging_moss_middle"
  };
  path = replacements[path] ?? path;
  return `textures/blocks/${path}`;
}

function createBehaviorEntity() {
  return {
    format_version: "1.20.30",
    "minecraft:entity": {
      description: {
        identifier: ENTITY_TYPE_ID,
        is_spawnable: false,
        is_summonable: true,
        runtime_identifier: "minecraft:arrow",
        properties: {
          "physics_api:pitch": syncedFloat(),
          "physics_api:yaw": syncedFloat(),
          "physics_api:roll": syncedFloat(),
          "physics_api:origin_xz": syncedInt(0, 0x3fffff),
          "physics_api:origin_y": syncedInt(0, 0xfffff),
          "physics_api:tint": syncedInt(0, 0xffffff),
          ...Object.fromEntries(Array.from(
            { length: SLOT_COUNT },
            (_, slot) => [`physics_api:a${slot}`, syncedInt(0, 0x1ffff)]
          ))
        }
      },
      components: visualEntityComponents()
    }
  };
}

function createClientEntity() {
  return {
    format_version: "1.20.30",
    "minecraft:client_entity": {
      description: {
        identifier: ENTITY_TYPE_ID,
        materials: {
          cutout: "alpha_block",
          opaque: "opaque_block",
          foliage: "alpha_block_color",
          foliage_colormap: "foliage_colormap_multiply"
        },
        textures: clientTextures,
        geometry: clientGeometries,
        render_controllers: clientControllers,
        animations: { transform: "animation.physics_api.tree_attachment_fragment.transform" },
        scripts: {
          animate: ["transform"],
          pre_animation: [
            "v.pitch = math.lerprotate(v.pitch ?? 0, q.property('physics_api:pitch'), q.delta_time/0.05);",
            "v.yaw = math.lerprotate(v.yaw ?? 0, q.property('physics_api:yaw'), q.delta_time/0.05);",
            "v.roll = math.lerprotate(v.roll ?? 0, q.property('physics_api:roll'), q.delta_time/0.05);",
            "v.family_mask = math.floor(q.property('physics_api:origin_y') / 2048);",
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
            ...Array.from({ length: SLOT_COUNT }, (_, slot) => [
              `v.a${slot} = q.property('physics_api:a${slot}');`,
              `v.ap${slot} = math.floor(v.a${slot} / 65536);`,
              `v.af${slot} = math.mod(math.floor(v.a${slot} / 256), 16);`,
              `v.as${slot} = math.mod(math.floor(v.a${slot} / 4096), 16);`
            ]).flat()
          ]
        }
      }
    }
  };
}

function createAnimation() {
  const bones = {
    root: { rotation: ["-q.body_x_rotation", "-q.body_y_rotation", 0] },
    pitch: { rotation: ["v.pitch", 0, 0] },
    roll: { rotation: [0, 0, "-v.roll"] },
    yaw: { rotation: [0, "-v.yaw", 0] },
    attachment_offset: {
      position: [
        "(math.mod(q.property('physics_api:origin_xz'), 2048) - 1024) * 16",
        "(math.mod(q.property('physics_api:origin_y'), 2048) - 1024) * 16",
        "-(math.floor(q.property('physics_api:origin_xz') / 2048) - 1024) * 16"
      ]
    }
  };
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const descriptor = descriptorExpression(slot);
    const family = familyExpression(slot);
    const state = stateExpression(slot);
    bones[`slot_${slot}`] = {
      position: [
        `math.mod(${descriptor}, 8) * 16`,
        `math.mod(math.floor(${descriptor} / 8), 4) * 16`,
        `-math.mod(math.floor(${descriptor} / 32), 8) * 16`
      ],
      rotation: [
        0,
        `(${family}) == 0 ? (math.mod(${state}, 4) - 2) * 90 : ((${family}) == 1 ? math.mod(${state}, 4) * 90 : 0)`,
        0
      ]
    };
  }
  return {
    format_version: "1.8.0",
    animations: {
      "animation.physics_api.tree_attachment_fragment.transform": {
        loop: true,
        bones
      }
    }
  };
}

function slotVariantCondition(entry, slot) {
  const state = stateExpression(slot);
  const condition = entry.condition.replaceAll("q.property('physics_api:state')", state);
  return `${slotFamilyCondition(entry, slot)} && (${condition})`;
}

function slotFamilyCondition(entry, slot) {
  return `v.ap${slot} >= 1 && (${familyExpression(slot)}) == ${entry.family}`;
}

function descriptorExpression(slot) {
  return `v.a${slot}`;
}

function familyExpression(slot) {
  return `v.af${slot}`;
}

function stateExpression(slot) {
  return `v.as${slot}`;
}

function tintCoordinateExpression(index) {
  return `v.tint_${index}`;
}

function tintKindExpression() {
  return "v.tint_kind";
}

function attachmentFamilyMaskCondition(family) {
  return `v.family_mask == 0 || math.mod(math.floor(v.family_mask / ${2 ** family}), 2) >= 1`;
}

function uniformFoliageUvAnimation() {
  return {
    offset: [
      "(v.tint_pixel_u + 0.5) / 256",
      "(v.tint_pixel_v + 0.5) / 256"
    ],
    scale: [0, 0]
  };
}

function gradientFoliageUvAnimation(slot) {
  const descriptor = descriptorExpression(slot);
  const localX = `math.mod(${descriptor}, 8)`;
  const localZ = `math.mod(math.floor(${descriptor} / 32), 8)`;
  const localAxis = `(v.tint_axis_z ? (${localZ}) : (${localX}))`;
  const u0 = tintCoordinateExpression(0);
  const v0 = tintCoordinateExpression(1);
  const u1 = tintCoordinateExpression(2);
  const v1 = tintCoordinateExpression(3);
  const uSpan = colormapSpan(u0, u1);
  const vSpan = colormapSpan(v0, v1);
  return {
    offset: [
      `${colormapCoordinate(u0)} + (${uSpan}) * ${localAxis} / 7`,
      `${colormapCoordinate(v0)} + (${vSpan}) * ${localAxis} / 7`
    ],
    scale: [
      `(${uSpan}) / 7`,
      `(${vSpan}) / 7`
    ]
  };
}

function colormapCoordinate(value) {
  return `(0.5 + (${value}) * 255 / 31) / 256`;
}

function colormapSpan(start, end) {
  return `((${end}) - (${start})) * 255 / 7936`;
}

function syncedFloat() {
  return {
    type: "float",
    range: [floatLiteral(-400), floatLiteral(400)],
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

function sanitize(value) {
  return value.replace(/^textures\/blocks\//, "").replace(/[^a-z0-9_]+/g, "_");
}
