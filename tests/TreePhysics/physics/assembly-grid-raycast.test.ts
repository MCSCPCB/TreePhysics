import { describe, expect, it } from "vitest";
import { raycastAssemblyGrid } from "@src/physics/contraption/AssemblyGridRaycast";
import type { PhysicsAssemblyBlock } from "@src/physics/core/PhysicsTypes";

function block(x: number, y: number, z: number): PhysicsAssemblyBlock {
  return { localLocation: { x, y, z }, typeId: "minecraft:oak_log" };
}

describe("raycastAssemblyGrid", () => {
  it("returns the actual entry face without scanning unrelated cells", () => {
    const blocks = new Map([block(2, 0, 0)].map(value => ["2,0,0", value]));
    const hit = raycastAssemblyGrid(
      (x, y, z) => blocks.get(`${x},${y},${z}`),
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5
    );
    expect(hit).toMatchObject({ distance: 1.5, face: "west", localNormal: { x: -1, y: 0, z: 0 } });
  });

  it("handles negative directions and rejects hits beyond reach", () => {
    const target = block(-2, 1, 0);
    const lookup = (x: number, y: number, z: number) => (
      `${x},${y},${z}` === "-2,1,0" ? target : undefined
    );
    expect(raycastAssemblyGrid(lookup, { x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 2))
      .toMatchObject({ distance: 1.5, face: "east" });
    expect(raycastAssemblyGrid(lookup, { x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 1))
      .toBeUndefined();
  });

  it("can skip the block containing the ray origin and hit a block ahead", () => {
    const blocks = new Map([
      block(0, 0, 0),
      block(2, 0, 0)
    ].map(value => [
      `${value.localLocation.x},${value.localLocation.y},${value.localLocation.z}`,
      value
    ]));
    const hit = raycastAssemblyGrid(
      (x, y, z) => blocks.get(`${x},${y},${z}`),
      { x: 0.2, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5,
      { skipContainingCell: true }
    );

    expect(hit).toMatchObject({
      block: { localLocation: { x: 2, y: 0, z: 0 } },
      distance: 1.3,
      face: "west"
    });
  });

  it("returns no hit when only the containing block is present and skipped", () => {
    const containingBlock = block(0, 0, 0);
    const hit = raycastAssemblyGrid(
      (x, y, z) => `${x},${y},${z}` === "0,0,0" ? containingBlock : undefined,
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5,
      { skipContainingCell: true }
    );

    expect(hit).toBeUndefined();
  });

  it("preserves the zero-distance containing-block hit by default", () => {
    const containingBlock = block(0, 0, 0);
    const hit = raycastAssemblyGrid(
      (x, y, z) => `${x},${y},${z}` === "0,0,0" ? containingBlock : undefined,
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5
    );

    expect(hit).toMatchObject({
      block: containingBlock,
      distance: 0
    });
  });
});
