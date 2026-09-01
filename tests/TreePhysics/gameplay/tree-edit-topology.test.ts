import { describe, expect, it } from "vitest";
import type { PhysicsAssemblyBlock } from "@src/Physics";
import { createTreeEditTopologyPlan } from "@src/content/tree/fallenTree/TreeEditTopology";

function block(typeId: string, x: number, y: number, z: number): PhysicsAssemblyBlock {
  return { localLocation: { x, y, z }, typeId };
}

describe("tree edit topology", () => {
  it("splits a log column when its middle block is absent", () => {
    const plan = createTreeEditTopologyPlan([
      block("minecraft:oak_log", 0, 0, 0),
      block("minecraft:oak_log", 0, 2, 0)
    ]);
    expect(plan.components.map(component => component.blocks.length)).toEqual([1, 1]);
    expect(plan.unsupportedTreeBlocks).toHaveLength(0);
  });

  it("keeps face-connected leaves with a supported log component", () => {
    const plan = createTreeEditTopologyPlan([
      block("minecraft:oak_log", 0, 0, 0),
      block("minecraft:oak_leaves", 1, 0, 0),
      block("minecraft:oak_leaves", 2, 0, 0)
    ]);
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]!.blocks).toHaveLength(3);
    expect(plan.unsupportedTreeBlocks).toHaveLength(0);
  });

  it("retains diagonal leaf support without joining separate log components", () => {
    const plan = createTreeEditTopologyPlan([
      block("minecraft:oak_log", 0, 0, 0),
      block("minecraft:oak_leaves", 1, 1, 0),
      block("minecraft:oak_log", 2, 2, 0)
    ]);
    expect(plan.components).toHaveLength(2);
    expect(plan.components.reduce((sum, component) => sum + component.blocks.length, 0)).toBe(3);
    expect(plan.unsupportedTreeBlocks).toHaveLength(0);
  });

  it("breaks unsupported tree fragments but retains non-tree components", () => {
    const leaf = block("minecraft:oak_leaves", 4, 0, 0);
    const custom = block("example:machine", 8, 0, 0);
    const plan = createTreeEditTopologyPlan([leaf, custom]);
    expect(plan.unsupportedTreeBlocks).toEqual([leaf]);
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]!.containsLog).toBe(false);
    expect(plan.components[0]!.containsNonTreeBlock).toBe(true);
  });

  it("separates a non-tree island when its leaf bridge is removed", () => {
    const plan = createTreeEditTopologyPlan([
      block("minecraft:oak_log", 0, 0, 0),
      block("example:machine", 2, 0, 0)
    ]);
    expect(plan.components).toHaveLength(2);
    expect(plan.components.some(component => component.containsLog)).toBe(true);
    expect(plan.components.some(component => component.containsNonTreeBlock)).toBe(true);
  });

  it("marks a tree component with an attached non-tree block as mixed", () => {
    const plan = createTreeEditTopologyPlan([
      block("minecraft:oak_log", 0, 0, 0),
      block("example:machine", 1, 0, 0)
    ]);
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]!.containsLog).toBe(true);
    expect(plan.components[0]!.containsNonTreeBlock).toBe(true);
  });
});
