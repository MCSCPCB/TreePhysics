import { describe, expect, it } from "vitest";
import { BlockPermutation, type Block, type Dimension, type Vector3 } from "@minecraft/server";
import type { PhysicsAssembly } from "@src/Physics";
import {
  TREE_INTERACTION_AIR_PROXY_BLOCK_TYPE_ID,
  TREE_INTERACTION_PROXY_BLOCK_TYPE_ID,
  TreeInteractionProxyBlockController,
  restoreOrphanInteractionProxyBlock
} from "@src/content/contraption/interaction/TreeInteractionProxyBlock";

class FakeBlock {
  isWaterlogged = false;
  permutation: ReturnType<typeof BlockPermutation.resolve>;
  setCount = 0;
  typeId: string;

  constructor(
    readonly location: Vector3,
    typeId: string,
    states: Record<string, boolean | number | string> = {}
  ) {
    this.typeId = typeId;
    this.permutation = BlockPermutation.resolve(typeId, states);
  }

  get isAir(): boolean {
    return this.typeId === "minecraft:air";
  }

  setPermutation(permutation: ReturnType<typeof BlockPermutation.resolve>): void {
    this.setCount++;
    this.permutation = permutation;
    this.typeId = permutation.type.id;
    this.isWaterlogged = false;
  }

  setType(typeId: string): void {
    this.setPermutation(BlockPermutation.resolve(typeId));
  }

  setWaterlogged(waterlogged: boolean): void {
    this.isWaterlogged = waterlogged;
  }
}

class FakeDimension {
  readonly blocks = new Map<string, FakeBlock>();
  getBlockCount = 0;

  constructor(readonly id: string) {}

  add(block: FakeBlock): void {
    this.blocks.set(locationKey(block.location), block);
  }

  getBlock(location: Vector3): FakeBlock | undefined {
    this.getBlockCount++;
    return this.blocks.get(locationKey(location));
  }
}

class FakeAssembly {
  readonly body: { localPointToWorld(location: Vector3): Vector3 };

  constructor(
    readonly worldOrigin: Vector3,
    rotationYDegrees = 0
  ) {
    const radians = rotationYDegrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    this.body = {
      localPointToWorld: location => ({
        x: this.worldOrigin.x + location.x * cosine - location.z * sine,
        y: this.worldOrigin.y + location.y,
        z: this.worldOrigin.z + location.x * sine + location.z * cosine
      })
    };
  }
}

describe("tree interaction proxy placement", () => {
  it("shares one stable maximum-coverage proxy and restores it once", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const targetCenter = { x: 1.5, y: 0.5, z: 0.5 };
    const assembly = fakeAssembly(targetCenter);
    const target = new FakeBlock({ x: 1, y: 0, z: 0 }, "minecraft:air");
    dimension.add(target);

    const sync = (playerId: string): void => controller.syncPlayer(
      playerId,
      dimension as unknown as Dimension,
      assembly,
      { x: 0.5, y: 0.5, z: 0.5 },
      targetCenter
    );
    sync("first");
    sync("first");
    sync("second");

    expect(target.typeId).toBe(TREE_INTERACTION_AIR_PROXY_BLOCK_TYPE_ID);
    expect(target.setCount).toBe(1);
    expect(controller.isManagedBlock(
      dimension as unknown as Dimension,
      target as unknown as Block
    )).toBe(true);

    controller.releasePlayer("first");
    expect(target.typeId).toBe(TREE_INTERACTION_AIR_PROXY_BLOCK_TYPE_ID);
    controller.releasePlayer("second");
    expect(target.typeId).toBe("minecraft:air");
    expect(target.setCount).toBe(2);
  });

  it("reuses the proxy when selection, pose, and head cell are unchanged", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const targetCenter = { x: 1.5, y: 0.5, z: 0.5 };
    const assembly = fakeAssembly(targetCenter);
    dimension.add(new FakeBlock({ x: 1, y: 0, z: 0 }, "minecraft:air"));

    const sync = (): void => controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      assembly,
      { x: 0.5, y: 0.5, z: 0.5 },
      targetCenter
    );
    sync();
    const firstReadCount = dimension.getBlockCount;
    sync();
    expect(dimension.getBlockCount).toBe(firstReadCount + 1);
  });

  it("selects the world cell with the greatest overlap for a rotated target block", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const targetCenter = { x: 2.2, y: 0.5, z: 0.8 };
    const assembly = fakeAssembly(targetCenter, 45);
    const lesserOverlap = new FakeBlock({ x: 1, y: 0, z: 0 }, "minecraft:air");
    const greatestOverlap = new FakeBlock({ x: 2, y: 0, z: 0 }, "minecraft:air");
    dimension.add(lesserOverlap);
    dimension.add(greatestOverlap);

    controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      assembly,
      { x: 0.5, y: 0.5, z: 0.5 },
      targetCenter
    );

    expect(lesserOverlap.typeId).toBe("minecraft:air");
    expect(greatestOverlap.typeId).toBe(TREE_INTERACTION_AIR_PROXY_BLOCK_TYPE_ID);
  });

  it("falls directly back to the head when the maximum-coverage cell is occupied", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const targetCenter = { x: 1.8, y: 0.5, z: 0.8 };
    const assembly = fakeAssembly(targetCenter, 45);
    const occupiedTarget = new FakeBlock({ x: 1, y: 0, z: 0 }, "minecraft:stone");
    const lesserOverlap = new FakeBlock({ x: 2, y: 0, z: 0 }, "minecraft:air");
    const head = new FakeBlock({ x: 0, y: 1, z: 0 }, "minecraft:air");
    dimension.add(occupiedTarget);
    dimension.add(lesserOverlap);
    dimension.add(head);

    controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      assembly,
      { x: 0.5, y: 1.62, z: 0.5 },
      targetCenter
    );

    expect(occupiedTarget.typeId).toBe("minecraft:stone");
    expect(lesserOverlap.typeId).toBe("minecraft:air");
    expect(head.typeId).toBe(TREE_INTERACTION_AIR_PROXY_BLOCK_TYPE_ID);
  });

  it("gives up when the maximum-coverage cell and head cell are occupied", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const targetCenter = { x: 1.5, y: 0.5, z: 0.5 };
    const assembly = fakeAssembly(targetCenter);
    const occupiedTarget = new FakeBlock({ x: 1, y: 0, z: 0 }, "minecraft:stone");
    const occupiedHead = new FakeBlock({ x: 0, y: 1, z: 0 }, "minecraft:stone");
    dimension.add(occupiedTarget);
    dimension.add(occupiedHead);

    controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      assembly,
      { x: 0.5, y: 1.62, z: 0.5 },
      targetCenter
    );

    expect(occupiedTarget.typeId).toBe("minecraft:stone");
    expect(occupiedHead.typeId).toBe("minecraft:stone");
    expect(controller.isManagedBlock(
      dimension as unknown as Dimension,
      occupiedTarget as unknown as Block
    )).toBe(false);
  });

  it("moves directly between selection-derived cells and restores the old cell", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const first = new FakeBlock({ x: 1, y: 0, z: 0 }, "minecraft:air");
    const second = new FakeBlock({ x: 2, y: 0, z: 0 }, "minecraft:air");
    dimension.add(first);
    dimension.add(second);

    controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      fakeAssembly({ x: 1.5, y: 0.5, z: 0.5 }),
      { x: 0.5, y: 0.5, z: 0.5 },
      { x: 1.5, y: 0.5, z: 0.5 }
    );
    controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      fakeAssembly({ x: 2.5, y: 0.5, z: 0.5 }),
      { x: 0.5, y: 0.5, z: 0.5 },
      { x: 2.5, y: 0.5, z: 0.5 }
    );

    expect(first.typeId).toBe("minecraft:air");
    expect(second.typeId).toBe(TREE_INTERACTION_AIR_PROXY_BLOCK_TYPE_ID);
  });

  it("preserves and restores water in the maximum-coverage cell", () => {
    const controller = new TreeInteractionProxyBlockController();
    const dimension = new FakeDimension("minecraft:overworld");
    const targetCenter = { x: 1.5, y: 0.5, z: 0.5 };
    const target = new FakeBlock(
      { x: 1, y: 0, z: 0 },
      "minecraft:flowing_water",
      { liquid_depth: 7 }
    );
    dimension.add(target);

    controller.syncPlayer(
      "player",
      dimension as unknown as Dimension,
      fakeAssembly(targetCenter),
      { x: 0.5, y: 0.5, z: 0.5 },
      targetCenter
    );
    expect(target.typeId).toBe(TREE_INTERACTION_PROXY_BLOCK_TYPE_ID);
    expect(target.isWaterlogged).toBe(true);

    controller.releasePlayer("player");
    expect(target.typeId).toBe("minecraft:flowing_water");
    expect(target.permutation.getAllStates()).toEqual({ liquid_depth: 7 });
  });

  it("restores a water source encoded in a reload-orphaned proxy", () => {
    const orphan = new FakeBlock(
      { x: 1, y: 0, z: 0 },
      TREE_INTERACTION_PROXY_BLOCK_TYPE_ID,
      {
        "physics_api:water_depth": 0,
        "physics_api:water_kind": 1
      }
    );
    restoreOrphanInteractionProxyBlock(orphan as unknown as Block);
    expect(orphan.typeId).toBe("minecraft:water");
    expect(orphan.permutation.getAllStates()).toEqual({ liquid_depth: 0 });
  });
});

function fakeAssembly(worldOrigin: Vector3, rotationYDegrees = 0): PhysicsAssembly {
  return new FakeAssembly(worldOrigin, rotationYDegrees) as unknown as PhysicsAssembly;
}

function locationKey(location: Vector3): string {
  return `${location.x},${location.y},${location.z}`;
}
