import { describe, expect, it } from "vitest";
import { createTreeAssemblyBlock } from "@src/content/tree/block/AssemblyBlock";
import {
  playerEditableAssemblyBlockKind,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";

describe("Stage 2 ordinary assembly block physics", () => {
  it("uses the vanilla chest body as one inset collision box", () => {
    const origin = { x: 4, y: 70, z: -3 };
    const log = createTreeAssemblyBlock(capturedLog(origin), origin);
    const chest = createTreeAssemblyBlock(capturedChest(origin), origin);

    expect(chest.mass).toBe(1);
    expect(chest.mass).toBe(log.mass);
    expect(chest.buoyancyVolume).toBe(1);
    expect(chest.buoyancyVolume).toBe(log.buoyancyVolume);
    expect(chest.collisionShape).toEqual([{
      min: { x: 1 / 16, y: 0, z: 1 / 16 },
      max: { x: 15 / 16, y: 14 / 16, z: 15 / 16 }
    }]);
    expect(chest.collidable).toBe(log.collidable);
    expect(chest.collisionResponse).toBe(log.collisionResponse);
    expect(chest.runtimeCollidable).toBe(log.runtimeCollidable);
  });

  it("admits only supported ordinary blocks to the shared mining transaction", () => {
    expect(playerEditableAssemblyBlockKind("minecraft:chest")).toBe("block");
    expect(playerEditableAssemblyBlockKind("minecraft:stone")).toBeUndefined();
  });
});

function capturedLog(location: CapturedTreeBlock["location"]): CapturedTreeBlock {
  return {
    kind: "log",
    location,
    states: { pillar_axis: "y" },
    typeId: "minecraft:oak_log"
  };
}

function capturedChest(location: CapturedTreeBlock["location"]): CapturedTreeBlock {
  return {
    kind: "block",
    location,
    states: { "minecraft:cardinal_direction": "south" },
    typeId: "minecraft:chest"
  };
}
