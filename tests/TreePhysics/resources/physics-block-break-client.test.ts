import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

const BEHAVIOR_ENTITY_PATH =
  "packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_block_break.json";
const CLIENT_ENTITY_PATH =
  "packs/TreePhysics/TreePhysicsRP/entity/tree_physics/physics_block_break.json";
const MATERIAL_PATH =
  "packs/TreePhysics/TreePhysicsRP/materials/entity.material";
const RENDER_CONTROLLER_PATH =
  "packs/TreePhysics/TreePhysicsRP/render_controllers/physics_block_break.render_controllers.json";

describe("physics block break overlay resources", () => {
  it("synchronizes the target break stage through the entity property", () => {
    const definition = parse(readFileSync(BEHAVIOR_ENTITY_PATH, "utf8"));
    const property = definition["minecraft:entity"].description.properties[
      "tree_physics:break_stage"
    ];

    expect(property).toMatchObject({
      client_sync: true,
      default: -1,
      range: [-1, 9],
      type: "int"
    });
  });

  it("advances the visible texture one stage at a time toward the synchronized target", () => {
    const definition = JSON.parse(readFileSync(CLIENT_ENTITY_PATH, "utf8"));
    const preAnimation = definition["minecraft:client_entity"].description.scripts
      .pre_animation as string[];
    const expression = preAnimation.join("");

    expect(expression).toContain(
      "v.break_stage_target=q.property('tree_physics:break_stage')"
    );
    expect(expression).toContain("v.break_stage=v.break_stage+1");
    expect(expression).not.toContain(
      "v.break_stage=q.property('tree_physics:break_stage')"
    );
  });

  it("multiplies the break texture by the rendered block color without relighting it", () => {
    const clientEntity = JSON.parse(readFileSync(CLIENT_ENTITY_PATH, "utf8"));
    const materials = parse(readFileSync(MATERIAL_PATH, "utf8")).materials;
    const renderController = JSON.parse(readFileSync(RENDER_CONTROLLER_PATH, "utf8"))
      .render_controllers["controller.render.tree_physics.physics_block_break"];

    expect(clientEntity["minecraft:client_entity"].description.materials.default)
      .toBe("block_break_multiply");
    expect(materials["block_break_multiply:alpha_block_color"]).toMatchObject({
      "+states": expect.arrayContaining([
        "Blending",
        "DisableDepthWrite",
        "DisableAlphaWrite"
      ]),
      blendDst: "Zero",
      blendSrc: "DestColor",
      depthFunc: "LessEqual"
    });
    expect(renderController.ignore_lighting).toBe(true);
    expect(renderController.light_color_multiplier).toBeUndefined();
  });
});
