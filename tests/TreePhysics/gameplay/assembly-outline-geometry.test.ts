import { describe, expect, it } from "vitest";
import {
  createAssemblyOutlineShape,
  createAssemblyOutlineShapeFromTopology,
  createAssemblyOutlineTopology,
  createMergedVoxelOutline,
  isSolidCuboid
} from "@src/render/outline/AssemblyOutlineGeometry";
import type { PhysicsAssemblyBlock } from "@src/physics/core/PhysicsTypes";

const location = (x: number, y: number, z: number) => ({ x, y, z });
const block = (x: number, y: number, z: number, typeId = "minecraft:oak_log"): PhysicsAssemblyBlock => ({
  localLocation: location(x, y, z),
  typeId
});

describe("assembly outline geometry", () => {
  it("merges a solid line and cuboid to twelve edges", () => {
    expect(createMergedVoxelOutline([location(0, 0, 0)] )).toHaveLength(12);
    expect(createMergedVoxelOutline([
      location(0, 0, 0), location(1, 0, 0), location(2, 0, 0)
    ])).toHaveLength(12);
    expect(isSolidCuboid([
      location(0, 0, 0), location(1, 0, 0), location(0, 1, 0), location(1, 1, 0)
    ])).toBe(true);
  });

  it("excludes leaves from the complete outline", () => {
    const shape = createAssemblyOutlineShape([
      block(0, 0, 0),
      block(8, 8, 8, "minecraft:oak_leaves")
    ], location(0, 0, 0));
    expect(shape?.kind).toBe("complete");
    expect(shape?.edges).toHaveLength(12);
  });

  it("falls back to a capacity-bounded local topology", () => {
    const blocks: PhysicsAssemblyBlock[] = [];
    for (let x = 0; x < 8; x++) {
      blocks.push(block(x, 0, 0));
      if (x % 2 === 0) blocks.push(block(x, 1, 0));
    }
    const shape = createAssemblyOutlineShape(blocks, location(0, 0, 0), 12);
    expect(shape).toBeDefined();
    expect(shape!.edges.length).toBeLessThanOrEqual(12);
    expect(shape!.kind).not.toBe("complete");
  });

  it("reuses target-independent complete topology across selected blocks", () => {
    const blocks = [block(0, 0, 0), block(1, 0, 0), block(2, 0, 0)];
    const topology = createAssemblyOutlineTopology(blocks);
    const first = createAssemblyOutlineShapeFromTopology(topology, location(0, 0, 0));
    const last = createAssemblyOutlineShapeFromTopology(topology, location(2, 0, 0));

    expect(topology.completeEdges).toBeDefined();
    expect(first?.kind).toBe("complete");
    expect(last?.edges).toBe(topology.completeEdges);
  });
});
