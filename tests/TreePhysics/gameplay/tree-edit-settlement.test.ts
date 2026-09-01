import { describe, expect, it } from "vitest";
import { allocateTreeEditSettlementTicks } from "@src/content/tree/fallenTree/TreeEditSettlement";

describe("tree edit settlement", () => {
  it("preserves elapsed time when one connected child remains", () => {
    expect(allocateTreeEditSettlementTicks(30, 20, [3])).toEqual([30]);
  });

  it("allocates elapsed ticks in proportion to child log counts", () => {
    const allocations = allocateTreeEditSettlementTicks(17, 20, [1, 2]);
    expect(allocations).toEqual([6, 11]);
    expect(allocations.reduce((sum, ticks) => sum + ticks, 0)).toBe(17);
  });

  it("splits equal shares deterministically at integer precision", () => {
    expect(allocateTreeEditSettlementTicks(15, 20, [2, 2])).toEqual([8, 7]);
  });

  it("caps elapsed time when every child has reached its new timeout", () => {
    expect(allocateTreeEditSettlementTicks(100, 20, [1, 2])).toEqual([20, 40]);
  });

  it("does not allocate settlement time to components without logs", () => {
    expect(allocateTreeEditSettlementTicks(15, 20, [0, 2, 1])).toEqual([0, 10, 5]);
  });
});
