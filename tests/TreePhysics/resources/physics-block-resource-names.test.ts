import { existsSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

interface PhysicsBlockEntityResources {
  readonly animationId: string;
  readonly animationPath: string;
  readonly behaviorPath: string;
  readonly clientPath: string;
  readonly controllerId: string;
  readonly controllerPath: string;
  readonly entityId: string;
  readonly geometryId: string;
  readonly geometryPath: string;
}

const RESOURCES: readonly PhysicsBlockEntityResources[] = [
  createResources("physics_block_break"),
  createResources("physics_block_selection")
];

const REMOVED_PATHS = [
  "packs/TreePhysics/TreePhysicsBP/entities/tree_physics/tree_break.json",
  "packs/TreePhysics/TreePhysicsBP/entities/tree_physics/tree_outline.json",
  "packs/TreePhysics/TreePhysicsRP/animations/tree_break.animation.json",
  "packs/TreePhysics/TreePhysicsRP/animations/tree_outline.animation.json",
  "packs/TreePhysics/TreePhysicsRP/entity/tree_physics/tree_break.json",
  "packs/TreePhysics/TreePhysicsRP/entity/tree_physics/tree_outline.json",
  "packs/TreePhysics/TreePhysicsRP/models/entity/tree_break.geo.json",
  "packs/TreePhysics/TreePhysicsRP/models/entity/tree_outline.geo.json",
  "packs/TreePhysics/TreePhysicsRP/render_controllers/tree_break.render_controllers.json",
  "packs/TreePhysics/TreePhysicsRP/render_controllers/tree_outline.render_controllers.json"
] as const;

describe("physics block entity resource names", () => {
  it.each(RESOURCES)("uses one canonical resource graph for $entityId", resources => {
    const behaviorSource = readFileSync(resources.behaviorPath, "utf8");
    const clientSource = readFileSync(resources.clientPath, "utf8");
    const animationSource = readFileSync(resources.animationPath, "utf8");
    const geometrySource = readFileSync(resources.geometryPath, "utf8");
    const controllerSource = readFileSync(resources.controllerPath, "utf8");
    const behavior = parse(behaviorSource)["minecraft:entity"].description;
    const client = JSON.parse(clientSource)["minecraft:client_entity"].description;
    const animation = JSON.parse(animationSource).animations;
    const geometry = JSON.parse(geometrySource)["minecraft:geometry"][0].description;
    const controllers = JSON.parse(controllerSource).render_controllers;

    expect(behavior.identifier).toBe(resources.entityId);
    expect(client.identifier).toBe(resources.entityId);
    expect(client.geometry.default).toBe(resources.geometryId);
    expect(client.animations.transform).toBe(resources.animationId);
    expect(client.render_controllers).toEqual(expect.arrayContaining([
      expect.objectContaining({ [resources.controllerId]: expect.any(String) })
    ]));
    expect(Object.keys(animation)).toContain(resources.animationId);
    expect(geometry.identifier).toBe(resources.geometryId);
    expect(Object.keys(controllers)).toContain(resources.controllerId);
    expect([
      behaviorSource,
      clientSource,
      animationSource,
      geometrySource,
      controllerSource
    ].join("\n")).not.toContain("physics_api");
  });

  it("does not retain the superseded tree-specific resource files", () => {
    for (const path of REMOVED_PATHS) expect(existsSync(path), path).toBe(false);
  });

  it("keeps the adaptive cube fragment protocol and resources at the same capacity", () => {
    const root = "packs/TreePhysics";
    const behavior = parse(readFileSync(
      `${root}/TreePhysicsBP/entities/tree_physics/cube_block_fragment_0.json`,
      "utf8"
    ))["minecraft:entity"];
    const client = JSON.parse(readFileSync(
      `${root}/TreePhysicsRP/entity/tree_physics/cube_block_fragment_0.json`,
      "utf8"
    ))["minecraft:client_entity"];
    const animations = JSON.parse(readFileSync(
      `${root}/TreePhysicsRP/animations/cube_block_fragment_0.animation.json`,
      "utf8"
    )).animations;
    const transform = animations["animation.tree_physics.cube_block_fragment_0.transform"];
    const lidPose = animations["animation.tree_physics.cube_block_fragment_0.lid_pose"];
    const geometries = JSON.parse(readFileSync(
      `${root}/TreePhysicsRP/models/entity/cube_block_fragment_0.geo.json`,
      "utf8"
    ))["minecraft:geometry"];
    const geometrySlots = Array.from({ length: 200 }, (_, index) => `slot_${index}`);
    const geometryLids = Array.from({ length: 200 }, (_, index) => `lid_${index}`);
    const geometryLocks = Array.from({ length: 200 }, (_, index) => `lock_${index}`);
    const properties = behavior.description.properties;

    expect(Object.keys(properties)).toEqual([
      "tree_physics:pitch",
      "tree_physics:yaw",
      "tree_physics:roll",
      "tree_physics:origin_xz",
      "tree_physics:origin_y",
      "tree_physics:modes",
      ...Array.from({ length: 26 }, (_, index) => `tree_physics:s${index}`)
    ]);
    expect(client.description.materials.default).toBe("entity_alphatest");
    expect(client.description.textures.default).toBe("textures/entity/chest/normal");
    expect(client.description.geometry.default)
      .toBe("geometry.tree_physics.cube_block_fragment_0");
    expect(client.description.render_controllers).toEqual(["controller.render.default"]);
    expect(client.description.animations.lid_pose)
      .toBe("animation.tree_physics.cube_block_fragment_0.lid_pose");
    expect(client.description.scripts.animate)
      .toContainEqual({ lid_pose: "v.lid_pose_enabled" });
    expect(Object.keys(transform.bones).filter(name => name.startsWith("slot_")))
      .toEqual(geometrySlots);
    expect(Object.keys(lidPose.bones)).toEqual(geometryLids);
    expect(transform.bones.slot_0.rotation[1]).toContain("180 +");
    const preAnimation = client.description.scripts.pre_animation.join("\n");
    expect(preAnimation).toContain(
      "v.c5 = v.sparse ? math.mod(v.s5, 64) : math.mod(math.floor(v.s0 / 1048576), 16);"
    );
    expect(preAnimation).toContain("v.c149 = v.sparse ?");
    expect(preAnimation).toContain("v.c150 = 0;");
    expect(preAnimation).toContain(
      "v.lid_149 = v.lids_initialized ? math.clamp(" +
      "v.lid_149 + (v.c149 > 4 ? 2 : -2) * q.delta_time, 0, 1) : (v.c149 > 4);"
    );
    expect(preAnimation).not.toContain("math.exp");
    expect(preAnimation).toContain("v.lids_initialized = 1;");
    expect(client.description.scripts.pre_animation.filter(
      (entry: string) => /^v\.lid_\d+ =/.test(entry)
    )).toHaveLength(150);
    expect(geometries).toHaveLength(1);

    const geometry = geometries[0];
    const bones = geometry.bones as Array<{
      cubes?: Array<{ origin: number[]; size: number[] }>;
      name: string;
      parent?: string;
      pivot: number[];
    }>;
    expect(geometry.description.identifier)
      .toBe("geometry.tree_physics.cube_block_fragment_0");
    expect(bones.filter(bone => bone.name.startsWith("slot_")).map(bone => bone.name))
      .toEqual(geometrySlots);
    expect(bones.filter(bone => bone.name.startsWith("lid_")).map(bone => bone.name))
      .toEqual(geometryLids);
    expect(bones.filter(bone => bone.name.startsWith("lock_")).map(bone => bone.name))
      .toEqual(geometryLocks);
    for (let index = 0; index < 200; index++) {
      const slot = bones.find(bone => bone.name === `slot_${index}`)!;
      const lid = bones.find(bone => bone.name === `lid_${index}`)!;
      const lock = bones.find(bone => bone.name === `lock_${index}`)!;
      expect(slot.pivot).toEqual([0, -16, 0]);
      expect(slot.cubes?.[0]).toMatchObject({ origin: [-7, -24, -7], size: [14, 10, 14] });
      expect(lid.parent).toBe(slot.name);
      expect(lid.pivot).toEqual([0, -15, 7]);
      expect(lid.cubes?.[0]).toMatchObject({ origin: [-7, -15, -7], size: [14, 5, 14] });
      expect(lock.parent).toBe(lid.name);
      expect(lock.cubes?.[0]).toMatchObject({ origin: [-1, -17, -8], size: [2, 4, 1] });
      expect(lidPose.bones[`lid_${index}`].rotation[0]).toBe(
        `-90 * (1 - (1 - v.lid_${index}) * ` +
        `(1 - v.lid_${index}) * (1 - v.lid_${index}))`
      );
    }
    expect(existsSync(
      `${root}/TreePhysicsRP/render_controllers/cube_block_fragment_0.render_controllers.json`
    )).toBe(false);
  });
});

function createResources(name: string): PhysicsBlockEntityResources {
  return {
    animationId: `animation.tree_physics.${name}.transform`,
    animationPath: `packs/TreePhysics/TreePhysicsRP/animations/${name}.animation.json`,
    behaviorPath: `packs/TreePhysics/TreePhysicsBP/entities/tree_physics/${name}.json`,
    clientPath: `packs/TreePhysics/TreePhysicsRP/entity/tree_physics/${name}.json`,
    controllerId: `controller.render.tree_physics.${name}`,
    controllerPath:
      `packs/TreePhysics/TreePhysicsRP/render_controllers/${name}.render_controllers.json`,
    entityId: `tree_physics:${name}`,
    geometryId: `geometry.tree_physics.${name}`,
    geometryPath: `packs/TreePhysics/TreePhysicsRP/models/entity/${name}.geo.json`
  };
}
