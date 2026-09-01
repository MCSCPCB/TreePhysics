import { system, type Entity, type Vector3 } from "@minecraft/server";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_FRAGMENT_INITIAL_POSE_READY_BIT,
  FRAGMENT_INITIAL_POSE_READY_BIT,
  encodeCubeFragmentModes,
  encodeFragmentFamily,
  encodeLogFragmentModes,
  getPackedFragmentOriginFromAnchor,
  packAttachmentOriginY
} from "@src/render/contraption/AssemblyVisualCodec";
import { selectAssemblyVisualAnchor } from "@src/render/contraption/AssemblyVisualAnchor";
import { tryCreateTreeFragmentVisualRenderer } from "@src/render/contraption/AssemblyVisualRenderer";
import { FRAGMENT_VISUAL_COLLECTOR_ENTITY_TYPE_ID } from "@src/render/contraption/TreeFragmentVisualRenderer";
import type { PhysicsAssemblyBlock } from "@src/physics/core/PhysicsTypes";
import {
  CUBE_BLOCK_FRAGMENT_ENTITY_TYPE_ID,
  CUBE_BLOCK_FRAGMENT_PROPERTY_WORD_COUNT,
  CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT,
  packTreeAssemblyVisuals,
  readCubeBlockFragmentSlot,
  tryCreateCubeBlockFragmentSlot
} from "@src/render/contraption/FragmentLayout";

describe("fragment initial pose readiness", () => {
  it("leaves each carrier's ready bit clear before the first pose is published", () => {
    expect(encodeLogFragmentModes(15, false)).toBe(15);
    expect(encodeFragmentFamily(10, false)).toBe(10);
    expect(packAttachmentOriginY(2047, 511, false)).toBe(1048575);
  });

  it("adds the ready bit after the synchronized pose has survived one tick", () => {
    expect(encodeLogFragmentModes(1, true)).toBe(1 + FRAGMENT_INITIAL_POSE_READY_BIT);
    expect(encodeLogFragmentModes(15, true)).toBe(31);
    expect(encodeFragmentFamily(10, true)).toBe(26);
    expect(packAttachmentOriginY(2047, 511, true)).toBe(
      1048575 + ATTACHMENT_FRAGMENT_INITIAL_POSE_READY_BIT
    );
    expect(encodeLogFragmentModes(15, false)).toBe(15);
    expect(encodeFragmentFamily(10, false)).toBe(10);
    expect(packAttachmentOriginY(2047, 511, false)).toBe(1048575);
  });

  it("moves the visual anchor onto a remaining log after the previous anchor is removed", () => {
    expect(selectAssemblyVisualAnchor([
      {
        collidable: true,
        collisionResponse: false,
        localLocation: { x: 0, y: 4, z: 1 },
        runtimeCollidable: false,
        typeId: "minecraft:spruce_leaves"
      },
      {
        collidable: true,
        collisionResponse: true,
        localLocation: { x: 0, y: 8, z: 0 },
        runtimeCollidable: true,
        typeId: "minecraft:spruce_log"
      }
    ])).toEqual({ x: 0, y: 8, z: 0 });
  });

  it("anchors a component without logs to one of its real collidable blocks", () => {
    expect(selectAssemblyVisualAnchor([
      {
        collidable: false,
        collisionShape: "none",
        localLocation: { x: 0, y: 1, z: 0 },
        typeId: "minecraft:spruce_leaves"
      },
      chestBlock({ x: 7, y: -2, z: 4 }, 1)
    ])).toEqual({ x: 7, y: -2, z: 4 });
  });

  it("packs adjacent ordinary cubes into slots of one fragment", () => {
    const fragments = packTreeAssemblyVisuals([
      chestBlock({ x: 0, y: 0, z: 0 }, 0),
      chestBlock({ x: 1, y: 0, z: 0 }, 3)
    ]);
    expect(fragments).toHaveLength(1);
    const fragment = fragments![0]!;
    expect(fragment.entityTypeId).toBe(CUBE_BLOCK_FRAGMENT_ENTITY_TYPE_ID);
    expect(fragment.blockCount).toBe(2);
    expect(fragment.assignments).toHaveLength(2);
    expect(readCubeBlockFragmentSlot(fragment.words, fragment.assignments[0]!)).toBe(1);
    expect(readCubeBlockFragmentSlot(fragment.words, fragment.assignments[1]!)).toBe(4);
  });

  it("packs a long non-tree row into one adaptive dense fragment", () => {
    const fragments = packTreeAssemblyVisuals(
      Array.from({ length: 16 }, (_, x) => chestBlock({ x, y: 0, z: 0 }, x % 4))
    );
    expect(fragments).toHaveLength(1);
    expect(fragments![0]!.cubeLayout?.format).toBe("dense");
    expect(fragments![0]!.blockCount).toBe(16);
  });

  it("uses all 150 four-bit dense slots before allocating a second cube fragment", () => {
    const blocks = Array.from(
      { length: 151 },
      (_, x) => chestBlock({ x, y: 0, z: 0 }, x % 4)
    );
    const full = packTreeAssemblyVisuals(blocks.slice(0, 150));
    const overflow = packTreeAssemblyVisuals(blocks);

    expect(full).toHaveLength(1);
    expect(full![0]!.cubeLayout).toEqual({
      depth: 1,
      format: "dense",
      height: 1,
      width: 150
    });
    expect(full![0]!.assignments).toHaveLength(150);
    expect(overflow).toHaveLength(2);
  });

  it("does not split a non-tree box that fits within the 150-slot budget", () => {
    const blocks = Array.from({ length: 10 * 5 * 3 }, (_, index) => chestBlock({
      x: index % 10,
      y: Math.floor(index / (10 * 3)),
      z: Math.floor(index / 10) % 3
    }, index % 4));
    const fragments = packTreeAssemblyVisuals(blocks);

    expect(fragments).toHaveLength(1);
    expect(fragments![0]!.cubeLayout).toEqual({
      depth: 3,
      format: "dense",
      height: 5,
      width: 10
    });
  });

  it("uses one sparse fragment for irregular cubes whose dense span is too large", () => {
    const fragments = packTreeAssemblyVisuals([
      chestBlock({ x: 0, y: 0, z: 0 }, 0),
      chestBlock({ x: 31, y: 17, z: 23 }, 1),
      chestBlock({ x: 63, y: 63, z: 63 }, 2)
    ]);
    expect(fragments).toHaveLength(1);
    const fragment = fragments![0]!;
    expect(fragment.cubeLayout?.format).toBe("sparse");
    expect(fragment.words).toHaveLength(CUBE_BLOCK_SPARSE_FRAGMENT_SLOT_COUNT);
    expect(fragment.assignments.map(assignment => assignment.bitCount))
      .toEqual([24, 24, 24]);
    const next = tryCreateCubeBlockFragmentSlot(
      chestBlock({ x: 1, y: 0, z: 0 }, 3),
      fragment.anchorLocalLocation,
      fragment.cubeLayout!,
      fragment.words,
      new Set([3])
    );
    expect(next?.assignment.slot).toBe(4);
  });

  it("encodes cube layout and readiness in the existing modes property", () => {
    const dense = { depth: 5, format: "dense", height: 5, width: 8 } as const;
    const sparse = { depth: 64, format: "sparse", height: 64, width: 64 } as const;
    expect(encodeCubeFragmentModes(dense, false)).toBe(8 * 4 + 5 * 1024);
    expect(encodeCubeFragmentModes(dense, true)).toBe(8 * 4 + 5 * 1024 + 1);
    expect(encodeCubeFragmentModes(sparse, true) % 4).toBe(3);
  });

  it("counter-translates a fragment origin when its collector anchor is rebased", () => {
    const fragmentAnchor = { x: 0, y: 4, z: 0 };
    expect(getPackedFragmentOriginFromAnchor(
      fragmentAnchor,
      { x: 0, y: 4, z: 0 }
    )).toEqual({ xz: 2098176, y: 1025 });
    expect(getPackedFragmentOriginFromAnchor(
      fragmentAnchor,
      { x: 0, y: 8, z: 0 }
    )).toEqual({ xz: 2098176, y: 1021 });
  });

  it("replaces a rebased collector without teleporting an existing visible entity", () => {
    const callbacks: Array<() => void> = [];
    const originalRun = system.run;
    system.run = callback => { callbacks.push(callback); };
    try {
      const entities: FakeEntity[] = [];
      const addedEntityIds: string[] = [];
      const removedEntityIds: string[] = [];
      const blocks = [1, 2, 3].map(y => logBlock(y));
      const renderer = tryCreateTreeFragmentVisualRenderer(
        {
          isValid: true,
          getRotation: () => ({ x: 0, y: 0, z: 0 }),
          localPointToWorld: location => ({ x: 10 + location.x, y: 20 + location.y, z: 30 + location.z })
        },
        blocks,
        (typeId, location) => {
          const entity = new FakeEntity(typeId, location);
          entities.push(entity);
          return entity as unknown as Entity;
        },
        undefined,
        entityId => { removedEntityIds.push(entityId); },
        undefined,
        entityId => { addedEntityIds.push(entityId); }
      );
      expect(renderer).toBeDefined();
      renderer!.sync(true);
      renderer!.releaseInitialPose();

      const collector = entities.find(entity => (
        entity.typeId === FRAGMENT_VISUAL_COLLECTOR_ENTITY_TYPE_ID
      ))!;
      const fragment = entities.find(entity => entity !== collector)!;
      const outline = new FakeEntity("physics_api:physics_block_selection", collector.location);
      expect(renderer!.attachAuxiliaryRider(outline as unknown as Entity)).toBe(true);
      const initialEntityCount = entities.length;

      renderer!.removeBlocks(new Set(["0,1,0"]));
      renderer!.rebaseVisualAnchor(blocks.slice(1));

      const liveEntities = entities.filter(entity => entity.isValid);
      const replacementCollector = liveEntities.find(entity => (
        entity.typeId === FRAGMENT_VISUAL_COLLECTOR_ENTITY_TYPE_ID
      ))!;
      const replacementFragment = liveEntities.find(entity => entity !== replacementCollector)!;

      expect(entities).toHaveLength(initialEntityCount * 2);
      expect(liveEntities).toHaveLength(initialEntityCount);
      expect(collector.isValid).toBe(false);
      expect(fragment.isValid).toBe(false);
      expect(outline.isValid).toBe(false);
      expect(collector.location).toEqual({ x: 10, y: 21, z: 30 });
      expect(collector.teleportLocations).not.toContainEqual({ x: 10, y: 22, z: 30 });
      expect(replacementCollector.location).toEqual({ x: 10, y: 22, z: 30 });
      expect(replacementCollector.teleportLocations).toEqual([
        { x: 10, y: 22, z: 30 }
      ]);
      expect(replacementFragment.properties.get("physics_api:modes")).toBeLessThan(
        FRAGMENT_INITIAL_POSE_READY_BIT
      );
      expect(callbacks).toHaveLength(1);
      expect(addedEntityIds).toHaveLength(initialEntityCount * 2);
      expect(removedEntityIds).toEqual(expect.arrayContaining([collector.id, fragment.id]));

      runNext(callbacks);
      expect(replacementFragment.properties.get("physics_api:modes")).toBeGreaterThanOrEqual(
        FRAGMENT_INITIAL_POSE_READY_BIT
      );
      expect(callbacks).toHaveLength(0);
    } finally {
      system.run = originalRun;
    }
  });

  it("does not query native riders while no auxiliary outline is attached", () => {
    const entities: FakeEntity[] = [];
    const renderer = tryCreateTreeFragmentVisualRenderer(
      {
        isValid: true,
        getRotation: () => ({ x: 10, y: 20, z: 30 }),
        localPointToWorld: location => ({ ...location })
      },
      [logBlock(0)],
      (typeId, location) => {
        const entity = new FakeEntity(typeId, location);
        entities.push(entity);
        return entity as unknown as Entity;
      }
    );
    const collector = entities.find(entity => (
      entity.typeId === FRAGMENT_VISUAL_COLLECTOR_ENTITY_TYPE_ID
    ))!;

    renderer!.sync(true);
    expect(collector.getRidersCount).toBe(0);

    const outline = new FakeEntity("physics_api:physics_block_selection", collector.location);
    expect(renderer!.attachAuxiliaryRider(outline as unknown as Entity)).toBe(true);
    renderer!.sync(true);
    expect(collector.getRidersCount).toBe(1);
  });

  it("appends a placed cube without replacing the existing visual chain", () => {
    const callbacks: Array<() => void> = [];
    const originalRun = system.run;
    system.run = callback => { callbacks.push(callback); };
    try {
      const entities: FakeEntity[] = [];
      const addedEntityIds: string[] = [];
      const removedEntityIds: string[] = [];
      const renderer = tryCreateTreeFragmentVisualRenderer(
        {
          isValid: true,
          getRotation: () => ({ x: 14, y: 25, z: -9 }),
          localPointToWorld: location => ({
            x: 10 + location.x,
            y: 20 + location.y,
            z: 30 + location.z
          })
        },
        [logBlock(1)],
        (typeId, location) => {
          const entity = new FakeEntity(typeId, location);
          entities.push(entity);
          return entity as unknown as Entity;
        },
        undefined,
        entityId => { removedEntityIds.push(entityId); },
        undefined,
        entityId => { addedEntityIds.push(entityId); }
      );
      renderer!.sync(true);
      renderer!.releaseInitialPose();

      const collector = entities.find(entity => (
        entity.typeId === FRAGMENT_VISUAL_COLLECTOR_ENTITY_TYPE_ID
      ))!;
      const existingFragment = entities.find(entity => entity !== collector)!;
      const existingModes = existingFragment.properties.get("physics_api:modes");

      const firstChestBlock = chestBlock({ x: 2, y: 1, z: 0 }, 2);
      const firstPacked = packTreeAssemblyVisuals([firstChestBlock])![0]!;
      renderer!.addBlocks([firstChestBlock]);

      const chest = entities.find(entity => (
        entity.typeId === CUBE_BLOCK_FRAGMENT_ENTITY_TYPE_ID
      ))!;
      expect(entities).toHaveLength(3);
      expect(collector.isValid).toBe(true);
      expect(existingFragment.isValid).toBe(true);
      expect(collector.riders).toContain(chest);
      expect(removedEntityIds).toEqual([]);
      expect(addedEntityIds).toHaveLength(3);
      expect(existingFragment.properties.get("physics_api:modes")).toBe(existingModes);
      expect(Number(chest.properties.get("physics_api:modes")) % 4).toBe(0);
      const firstWords = cubeWords(chest);
      expect(readCubeBlockFragmentSlot(firstWords, firstPacked.assignments[0]!)).toBe(3);
      expect(callbacks).toHaveLength(1);

      expect(renderer!.setCubeBlockOpenState("2,1,0", true)).toBe(true);
      expect(readCubeBlockFragmentSlot(
        cubeWords(chest),
        firstPacked.assignments[0]!
      )).toBe(7);
      expect(renderer!.setCubeBlockOpenState("2,1,0", false)).toBe(true);
      expect(readCubeBlockFragmentSlot(
        cubeWords(chest),
        firstPacked.assignments[0]!
      )).toBe(3);

      runNext(callbacks);
      expect(Number(chest.properties.get("physics_api:modes")) % 4).toBe(1);
      expect(callbacks).toHaveLength(0);

      renderer!.addBlocks([chestBlock({ x: 3, y: 1, z: 0 }, 0)]);
      expect(entities).toHaveLength(3);
      expect(collector.riders.filter(entity => (
        entity.typeId === CUBE_BLOCK_FRAGMENT_ENTITY_TYPE_ID
      ))).toEqual([chest]);
      const mergedWords = cubeWords(chest);
      expect(mergedWords).not.toEqual(firstWords);
      expect(callbacks).toHaveLength(0);

      renderer!.removeBlocks(new Set(["3,1,0"]));
      expect(chest.isValid).toBe(true);
      expect(cubeWords(chest)).toEqual(firstWords);

      renderer!.removeBlocks(new Set(["2,1,0"]));
      expect(chest.isValid).toBe(false);
      expect(collector.isValid).toBe(true);
    } finally {
      system.run = originalRun;
    }
  });
});

class FakeEntity {
  static #nextId = 1;

  readonly id = `fake_${FakeEntity.#nextId++}`;
  readonly properties = new Map<string, boolean | number | string>();
  readonly riders: FakeEntity[] = [];
  readonly teleportLocations: Vector3[] = [];
  getRidersCount = 0;
  isValid = true;

  constructor(
    readonly typeId: string,
    public location: Vector3
  ) {
    this.location = { ...location };
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
      getRiders: (): Entity[] => {
        this.getRidersCount++;
        return this.riders as unknown as Entity[];
      }
    };
  }

  remove(): void {
    this.isValid = false;
  }

  setProperty(identifier: string, value: boolean | number | string): void {
    this.properties.set(identifier, value);
  }

  teleport(location: Vector3): void {
    this.location = { ...location };
    this.teleportLocations.push({ ...location });
  }
}

function logBlock(y: number): PhysicsAssemblyBlock {
  return {
    localLocation: { x: 0, y, z: 0 },
    typeId: "minecraft:spruce_log",
    visual: {
      allBark: false,
      family: 1,
      renderer: "tree_log_fragment",
      state: 2
    }
  };
}

function chestBlock(localLocation: Vector3, state: number): PhysicsAssemblyBlock {
  return {
    collisionShape: "full",
    localLocation: { ...localLocation },
    typeId: "minecraft:chest",
    visual: {
      renderer: "cube_block_fragment",
      state
    }
  };
}

function cubeWords(entity: FakeEntity): number[] {
  return Array.from({ length: CUBE_BLOCK_FRAGMENT_PROPERTY_WORD_COUNT }, (_, index) => (
    Number(entity.properties.get(`physics_api:s${index}`) ?? 0)
  ));
}

function runNext(callbacks: Array<() => void>): void {
  const callback = callbacks.shift();
  if (!callback) throw new Error("Expected a scheduled visual transition callback.");
  callback();
}
