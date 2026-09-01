import { describe, expect, it, vi } from "vitest";
import { MolangVariableMap, type Player, type Vector3 } from "@minecraft/server";
import { FallenTreeLifecycle } from "@src/content/tree/fallenTree/FallenTreeLifecycle";
import type { SerializedFallenTree } from "@src/storage/FallenTreeSerialization";
import { DynamicPropertyJsonStore, type DynamicPropertyTarget } from "@src/storage/DynamicPropertyJsonStore";
import type {
  PhysicsAssembly,
  PhysicsAssemblyBlock,
  PhysicsAssemblyOptions,
  PhysicsDimension
} from "@src/Physics";
import type { CapturedTreeBlock } from "@src/content/tree/block/Blocks";

type PropertyValue = boolean | number | string | object | undefined;

class MemoryTarget implements DynamicPropertyTarget {
  readonly values = new Map<string, Exclude<PropertyValue, undefined>>();
  shouldFail: ((identifier: string, value: PropertyValue) => boolean) | undefined;

  getDynamicProperty(identifier: string): PropertyValue {
    return this.values.get(identifier);
  }

  setDynamicProperty(
    identifier: string,
    value?: Exclude<PropertyValue, undefined>
  ): void {
    if (this.shouldFail?.(identifier, value)) {
      throw new Error("Synthetic dynamic property failure.");
    }
    if (value === undefined) this.values.delete(identifier);
    else this.values.set(identifier, value);
  }
}

interface FakeAssemblyRuntime {
  readonly assembly: PhysicsAssembly;
  readonly remove: ReturnType<typeof vi.fn>;
  readonly removeBlocks: ReturnType<typeof vi.fn>;
  readonly wakeUp: ReturnType<typeof vi.fn>;
}

describe("fallen-tree in-place player edits", () => {
  it("emits a tinted destruct particle and matching hit sound while mining", () => {
    const fixture = createFixture([
      treeBlock("minecraft:oak_log", "log", 1, 2, 3, { pillar_axis: "y" })
    ]);

    fixture.lifecycle.emitBlockMiningEffects(
      fixture.runtime.assembly,
      fixture.runtime.assembly.blocks[0]!
    );

    expect(fixture.nativeDimension.spawnParticle).toHaveBeenCalledOnce();
    expect(fixture.nativeDimension.spawnParticle).toHaveBeenCalledWith(
      "physics_api:tree_block_destruct_oak_log",
      { x: 1, y: 2, z: 3 },
      expect.anything()
    );
    expectSpawnedDestructProfile(fixture.nativeDimension.spawnParticle, {
      particleCount: 27,
      radius: 0.45,
      velocityScalar: 1.1
    });
    expect(fixture.nativeDimension.playSound).toHaveBeenCalledWith(
      "hit.wood",
      { x: 1, y: 2, z: 3 },
      { pitch: 0.5, volume: 0.23 }
    );
  });

  it("keeps the current assembly and fragment ownership for a connected edit", () => {
    const fixture = createFixture([
      treeBlock("minecraft:oak_log", "log", 0, 0, 0),
      treeBlock("minecraft:oak_log", "log", 0, 1, 0),
      treeBlock("minecraft:oak_leaves", "leaf", 1, 1, 0)
    ]);
    const target = fixture.runtime.assembly.blocks[2]!;

    expect(fixture.lifecycle.breakBlockForPlayerEdit(
      {} as Player,
      undefined,
      fixture.runtime.assembly,
      target
    )).toBe(true);

    expect(fixture.createdAssemblies).toHaveLength(0);
    expect(fixture.runtime.remove).not.toHaveBeenCalled();
    expect(fixture.runtime.removeBlocks).toHaveBeenCalledOnce();
    expect(fixture.runtime.wakeUp).toHaveBeenCalledOnce();
    expect(fixture.runtime.assembly.blocks.map(block => block.typeId)).toEqual([
      "minecraft:oak_log",
      "minecraft:oak_log"
    ]);
    expect(fixture.nativeDimension.playSound).toHaveBeenCalledWith(
      "dig.grass",
      { x: 1, y: 1, z: 0 },
      { pitch: expect.any(Number), volume: 0.7 }
    );
    expect(fixture.nativeDimension.spawnParticle).toHaveBeenCalledOnce();
    expect(fixture.nativeDimension.spawnParticle).toHaveBeenCalledWith(
      "physics_api:tree_block_destruct_oak_leaves",
      { x: 1, y: 1, z: 0 },
      expect.anything()
    );
    expectSpawnedDestructProfile(fixture.nativeDimension.spawnParticle, {
      particleCount: 64,
      radius: 0.5,
      velocityScalar: 1
    });
    expect(loadTreeStructure(fixture.target).blocks).toHaveLength(2);
  });

  it("removes a chest through the shared mining and in-place edit transaction", () => {
    const fixture = createFixture([
      treeBlock("minecraft:oak_log", "log", 0, 0, 0),
      treeBlock(
        "minecraft:chest",
        "block",
        1,
        0,
        0,
        { "minecraft:cardinal_direction": "south" }
      )
    ]);
    const target = fixture.runtime.assembly.blocks[1]!;

    fixture.lifecycle.emitBlockMiningEffects(fixture.runtime.assembly, target);
    expect(fixture.nativeDimension.spawnParticle).toHaveBeenCalledWith(
      "physics_api:tree_block_destruct_chest",
      { x: 1, y: 0, z: 0 },
      expect.anything()
    );
    expect(fixture.nativeDimension.playSound).toHaveBeenCalledWith(
      "hit.wood",
      { x: 1, y: 0, z: 0 },
      { pitch: 0.5, volume: 0.23 }
    );

    fixture.nativeDimension.spawnParticle.mockClear();
    fixture.nativeDimension.playSound.mockClear();
    expect(fixture.lifecycle.breakBlockForPlayerEdit(
      {} as Player,
      undefined,
      fixture.runtime.assembly,
      target
    )).toBe(true);

    expect(fixture.createdAssemblies).toHaveLength(0);
    expect(fixture.runtime.removeBlocks).toHaveBeenCalledOnce();
    expect(fixture.runtime.assembly.blocks.map(block => block.typeId)).toEqual([
      "minecraft:oak_log"
    ]);
    expect(loadTreeStructure(fixture.target).blocks.map(block => block.typeId)).toEqual([
      "minecraft:oak_log"
    ]);
    expect(fixture.nativeDimension.spawnParticle).toHaveBeenCalledWith(
      "physics_api:tree_block_destruct_chest",
      { x: 1, y: 0, z: 0 },
      expect.anything()
    );
    expect(fixture.nativeDimension.playSound).toHaveBeenCalledWith(
      "dig.wood",
      { x: 1, y: 0, z: 0 },
      { pitch: expect.any(Number), volume: 1 }
    );
  });

  it("retains the replacement path when an edit really splits the trunk", () => {
    const fixture = createFixture([
      treeBlock("minecraft:oak_log", "log", 0, 0, 0),
      treeBlock("minecraft:oak_log", "log", 0, 1, 0),
      treeBlock("minecraft:oak_log", "log", 0, 2, 0)
    ]);
    const target = fixture.runtime.assembly.blocks[1]!;

    expect(fixture.lifecycle.breakBlockForPlayerEdit(
      {} as Player,
      undefined,
      fixture.runtime.assembly,
      target
    )).toBe(true);

    expect(fixture.createdAssemblies).toHaveLength(2);
    expect(fixture.runtime.removeBlocks).not.toHaveBeenCalled();
    expect(fixture.runtime.remove).toHaveBeenCalledOnce();
  });

  it("does not touch the live assembly when the same-id commit fails", () => {
    const fixture = createFixture([
      treeBlock("minecraft:oak_log", "log", 0, 0, 0),
      treeBlock("minecraft:oak_log", "log", 0, 1, 0),
      treeBlock("minecraft:oak_leaves", "leaf", 1, 1, 0)
    ]);
    let failed = false;
    fixture.target.shouldFail = identifier => {
      if (failed || identifier !== "tree_test_tree_tree_structure_active") return false;
      failed = true;
      return true;
    };
    const target = fixture.runtime.assembly.blocks[2]!;

    expect(() => fixture.lifecycle.breakBlockForPlayerEdit(
      {} as Player,
      undefined,
      fixture.runtime.assembly,
      target
    )).toThrow("Could not commit in-place fallen-tree edit");

    expect(fixture.runtime.removeBlocks).not.toHaveBeenCalled();
    expect(fixture.runtime.remove).not.toHaveBeenCalled();
    expect(fixture.runtime.assembly.blocks).toHaveLength(3);
    expect(loadTreeStructure(fixture.target).blocks).toHaveLength(3);
  });
});

function createFixture(snapshots: readonly CapturedTreeBlock[]): {
  readonly createdAssemblies: FakeAssemblyRuntime[];
  readonly lifecycle: FallenTreeLifecycle;
  readonly nativeDimension: {
    readonly playSound: ReturnType<typeof vi.fn>;
    readonly spawnItem: ReturnType<typeof vi.fn>;
    readonly spawnParticle: ReturnType<typeof vi.fn>;
  };
  readonly runtime: FakeAssemblyRuntime;
  readonly target: MemoryTarget;
} {
  const target = new MemoryTarget();
  const createdAssemblies: FakeAssemblyRuntime[] = [];
  const nativeDimension = {
    id: "minecraft:overworld",
    playSound: vi.fn(),
    spawnItem: vi.fn(),
    spawnParticle: vi.fn()
  };
  let nextAssemblyId = 2;
  const physicsDimension = {
    dimension: nativeDimension,
    id: nativeDimension.id,
    createAssembly(options: PhysicsAssemblyOptions): PhysicsAssembly {
      const child = createFakeAssembly(nextAssemblyId++, options.blocks, physicsDimension);
      createdAssemblies.push(child);
      return child.assembly;
    }
  } as unknown as PhysicsDimension;
  const blocks = snapshots.map(snapshot => ({
    collidable: true,
    localLocation: { ...snapshot.location },
    mass: 1,
    typeId: snapshot.typeId,
    visual: { entityTypeId: "physics_api:test_fragment" }
  })) satisfies PhysicsAssemblyBlock[];
  const runtime = createFakeAssembly(1, blocks, physicsDimension);
  const lifecycle = new FallenTreeLifecycle({
    store: new DynamicPropertyJsonStore("tree_test", 30_000, target)
  });
  lifecycle.register(runtime.assembly, snapshots, { x: 0, y: 0, z: 0 }, {
    persistenceId: "tree",
    sleepTicksPerLog: 20,
    sleepTimeoutTicks: 60
  });
  return { createdAssemblies, lifecycle, nativeDimension, runtime, target };
}

function createFakeAssembly(
  id: number,
  initialBlocks: readonly PhysicsAssemblyBlock[],
  dimension: PhysicsDimension
): FakeAssemblyRuntime {
  const blocks = initialBlocks.map(block => ({
    ...block,
    localLocation: { ...block.localLocation }
  }));
  let valid = true;
  const wakeUp = vi.fn();
  const remove = vi.fn(() => {
    valid = false;
  });
  const body = {
    angularVelocity: { x: 0, y: 0, z: 0 },
    dimension,
    getAabb: () => ({
      min: { x: -1, y: -1, z: -1 },
      max: { x: 2, y: 4, z: 2 }
    }),
    getRotation: () => ({ x: 0, y: 0, z: 0 }),
    getVelocityAt: () => ({ x: 0, y: 0, z: 0 }),
    isSleeping: true,
    localPointToWorld: (location: Vector3) => ({ ...location }),
    location: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    wakeUp
  };
  const removeBlocks = vi.fn((locations: readonly Vector3[]) => {
    const keys = new Set(locations.map(locationKey));
    const removed = blocks.filter(block => keys.has(locationKey(block.localLocation)));
    for (let index = blocks.length - 1; index >= 0; index--) {
      if (keys.has(locationKey(blocks[index]!.localLocation))) blocks.splice(index, 1);
    }
    return removed;
  });
  const assembly = {
    blocks,
    body,
    foliageTint: undefined,
    get isValid() { return valid; },
    getBlockAtLocalLocation: (location: Vector3) => (
      blocks.find(block => locationKey(block.localLocation) === locationKey(location))
    ),
    id,
    remove,
    removeBlocksAtLocalLocations: removeBlocks,
    visualEntityIds: [`visual_${id}`]
  } as unknown as PhysicsAssembly;
  return { assembly, remove, removeBlocks, wakeUp };
}

function treeBlock(
  typeId: string,
  kind: CapturedTreeBlock["kind"],
  x: number,
  y: number,
  z: number,
  states: CapturedTreeBlock["states"] = {}
): CapturedTreeBlock {
  return { kind, location: { x, y, z }, states, typeId };
}

function loadTreeStructure(
  target: MemoryTarget
): Pick<SerializedFallenTree, "blocks"> {
  const structure = new DynamicPropertyJsonStore(
    "tree_test_tree_tree_structure",
    30_000,
    target
  ).load<Pick<SerializedFallenTree, "blocks">>();
  if (!structure) throw new Error("Tree structure was not persisted.");
  return structure;
}

function locationKey(location: Vector3): string {
  return `${location.x},${location.y},${location.z}`;
}

function expectSpawnedDestructProfile(
  spawnParticle: ReturnType<typeof vi.fn>,
  expected: {
    readonly particleCount: number;
    readonly radius: number;
    readonly velocityScalar: number;
  }
): void {
  const molang = spawnParticle.mock.calls[0]?.[2];
  expect(molang).toBeInstanceOf(MolangVariableMap);
  const floats = (molang as MolangVariableMap).floats;
  expect(floats.get("variable.emitter_particles_count")).toBe(expected.particleCount);
  expect(floats.get("variable.emitter_radius")).toBe(expected.radius);
  expect(floats.get("variable.velocity_scalar")).toBe(expected.velocityScalar);
}
