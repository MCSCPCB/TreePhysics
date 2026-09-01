import type { Entity, Vector3 } from "@minecraft/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPerBlockAssemblyVisualRenderer,
  PER_BLOCK_VISUAL_COLLECTOR_CAPACITY
} from "@src/render/contraption/AssemblyVisualRenderer";
import type { PhysicsAssemblyBlock } from "@src/physics/core/PhysicsTypes";

describe("per-block assembly outline rider", () => {
  it("declares the selection entity as an allowed rider for both collector types", () => {
    const blockCollector = readBehaviorEntity(
      "packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_block_collector.json"
    );
    const fragmentCollector = readBehaviorEntity(
      "packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_fragment_collector.json"
    );
    const selection = readBehaviorEntity(
      "packs/TreePhysics/TreePhysicsBP/entities/tree_physics/physics_block_selection.json"
    );
    const blockFamilies = blockCollector.components["minecraft:rideable"]?.family_types ?? [];
    const fragmentFamilies = fragmentCollector.components["minecraft:rideable"]?.family_types ?? [];
    const selectionFamilies = selection.components["minecraft:type_family"]?.family ?? [];

    expect(blockFamilies).toEqual(["physics_block"]);
    expect(fragmentFamilies).toEqual(["tree_physics_fragment"]);
    expect(selectionFamilies).toContain("physics_block");
    expect(selectionFamilies).toContain("tree_physics_fragment");
  });

  it("reserves one collector seat and synchronizes one shared outline", () => {
    const rotation = { x: 10, y: 20, z: 30 };
    const collector = new FakeEntity("physics_api:physics_block_collector");
    const visual = new FakeEntity("physics_api:physics_block");
    collector.addRider(visual);
    const renderer = createRenderer(collector, visual, rotation);

    expect(PER_BLOCK_VISUAL_COLLECTOR_CAPACITY).toBe(511);
    expect(renderer.hasIntactEntities()).toBe(true);

    renderer.sync(true);
    const outline = new FakeEntity("tree_physics:physics_block_selection");
    expect(renderer.attachAuxiliaryRider(outline as unknown as Entity)).toBe(true);
    expect(outline.properties).toMatchObject({
      "physics_api:pitch": 10,
      "physics_api:yaw": 20,
      "physics_api:roll": 30
    });
    expect(renderer.attachAuxiliaryRider(
      new FakeEntity("tree_physics:physics_block_selection") as unknown as Entity
    )).toBe(false);
    expect(renderer.hasIntactEntities()).toBe(true);

    rotation.x = 40;
    rotation.y = 50;
    rotation.z = 60;
    renderer.sync(true);
    expect(outline.properties).toMatchObject({
      "physics_api:pitch": 40,
      "physics_api:yaw": 50,
      "physics_api:roll": 60
    });
  });

  it("keeps an empty collector only while it carries the outline", () => {
    const collector = new FakeEntity("physics_api:physics_block_collector");
    const visual = new FakeEntity("physics_api:physics_block");
    collector.addRider(visual);
    const renderer = createRenderer(collector, visual, { x: 0, y: 0, z: 0 });
    renderer.sync(true);
    const outline = new FakeEntity("tree_physics:physics_block_selection");
    expect(renderer.attachAuxiliaryRider(outline as unknown as Entity)).toBe(true);

    renderer.removeBlocks(new Set(["0,0,0"]));
    expect(visual.isValid).toBe(false);
    expect(collector.isValid).toBe(true);

    renderer.detachAuxiliaryRider(outline as unknown as Entity);
    expect(collector.isValid).toBe(false);
    expect(outline.isValid).toBe(true);
  });

  it("removes the attached outline with the renderer", () => {
    const collector = new FakeEntity("physics_api:physics_block_collector");
    const visual = new FakeEntity("physics_api:physics_block");
    collector.addRider(visual);
    const renderer = createRenderer(collector, visual, { x: 0, y: 0, z: 0 });
    renderer.sync(true);
    const outline = new FakeEntity("tree_physics:physics_block_selection");
    expect(renderer.attachAuxiliaryRider(outline as unknown as Entity)).toBe(true);

    renderer.remove();
    expect(visual.isValid).toBe(false);
    expect(outline.isValid).toBe(false);
    expect(collector.isValid).toBe(false);
  });
});

class FakeEntity {
  static #nextId = 1;

  readonly id = `per_block_fake_${FakeEntity.#nextId++}`;
  readonly properties: Record<string, boolean | number | string> = {};
  readonly riders: FakeEntity[] = [];
  isValid = true;
  location: Vector3 = { x: 0, y: 0, z: 0 };

  constructor(readonly typeId: string) {}

  addRider(entity: FakeEntity): void {
    this.riders.push(entity);
  }

  getComponent(identifier: string): unknown {
    if (identifier !== "minecraft:rideable") return undefined;
    return {
      addRider: (entity: Entity): boolean => {
        this.riders.push(entity as unknown as FakeEntity);
        return true;
      },
      ejectRider: (entity: Entity): void => {
        const index = this.riders.findIndex(rider => rider.id === entity.id);
        if (index >= 0) this.riders.splice(index, 1);
      },
      getRiders: (): Entity[] => this.riders as unknown as Entity[]
    };
  }

  remove(): void {
    this.isValid = false;
  }

  runCommand(_command: string): void {}

  setProperty(identifier: string, value: boolean | number | string): void {
    this.properties[identifier] = value;
  }

  teleport(location: Vector3): void {
    this.location = { ...location };
  }
}

function createRenderer(
  collector: FakeEntity,
  visual: FakeEntity,
  rotation: Vector3
) {
  return createPerBlockAssemblyVisualRenderer(
    {
      isValid: true,
      getRotation: () => ({ ...rotation }),
      localPointToWorld: location => ({ ...location })
    },
    [{ block: perBlock(), entity: visual as unknown as Entity, slot: "mainhand" }],
    [{ entity: collector as unknown as Entity, riderIds: [visual.id] }]
  );
}

function perBlock(): PhysicsAssemblyBlock {
  return {
    localLocation: { x: 0, y: 0, z: 0 },
    typeId: "example:custom_block"
  };
}

interface BehaviorEntityDefinition {
  readonly "minecraft:entity": {
    readonly components: {
      readonly "minecraft:rideable"?: { readonly family_types?: readonly string[] };
      readonly "minecraft:type_family"?: { readonly family?: readonly string[] };
    };
  };
}

function readBehaviorEntity(path: string): BehaviorEntityDefinition["minecraft:entity"] {
  const definition = JSON.parse(readFileSync(path, "utf8")) as BehaviorEntityDefinition;
  return definition["minecraft:entity"];
}
