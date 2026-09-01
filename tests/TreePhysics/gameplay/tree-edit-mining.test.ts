import type { ItemStack } from "@minecraft/server";
import { describe, expect, it } from "vitest";
import {
  PLAYER_EDIT_MINING_RESET_TICKS,
  TreeEditMiningProgress
} from "@src/content/tree/felling/TreeEditMiningProgress";
import {
  IRON_GOLEM_REFERENCE_BREAK_TICKS,
  PC_ATTACK_EQUIVALENT_TICKS,
  getTreeMiningTargetTicks,
  getTreeMiningRequiredHits
} from "@src/content/tree/felling/TreeEditMiningTime";

describe("tree edit mining", () => {
  it("uses a fixed four-iron-block-and-pumpkin reference", () => {
    expect(IRON_GOLEM_REFERENCE_BREAK_TICKS).toBe(630);
    expect(PC_ATTACK_EQUIVALENT_TICKS).toBe(6.3);
    expect(getTreeMiningRequiredHits("log", "minecraft:oak_log")).toBe(10);
    expect(getTreeMiningRequiredHits("leaf", "minecraft:oak_leaves")).toBe(1);
  });

  it.each([
    ["minecraft:wooden_axe", 5],
    ["minecraft:stone_axe", 3],
    ["minecraft:copper_axe", 2],
    ["minecraft:iron_axe", 2],
    ["minecraft:diamond_axe", 2],
    ["minecraft:netherite_axe", 2],
    ["minecraft:golden_axe", 1]
  ])("applies %s only to the target block", (typeId, requiredHits) => {
    expect(getTreeMiningRequiredHits("log", "minecraft:oak_log", item(typeId)))
      .toBe(requiredHits);
  });

  it("uses vanilla chest hardness and the existing axe speed model", () => {
    expect(getTreeMiningTargetTicks("block", "minecraft:chest")).toBe(75);
    expect(getTreeMiningTargetTicks(
      "block",
      "minecraft:chest",
      item("minecraft:iron_axe")
    )).toBe(13);
  });

  it("counts every PC attack, including attacks in the same tick", () => {
    const mining = new TreeEditMiningProgress();
    expect(mining.advance("7|0,0,0", 20, 20, { type: "attack" })?.progress)
      .toBeCloseTo(0.315);
    expect(mining.advance("7|0,0,0", 20, 20, { type: "attack" })?.progress)
      .toBeCloseTo(0.63);
    expect(mining.advance("7|0,0,0", 20, 20, { type: "attack" })?.completed)
      .toBe(false);
    expect(mining.advance("7|0,0,0", 20, 20, { type: "attack" })?.completed)
      .toBe(true);
  });

  it("coalesces a touch event storm and measures elapsed signal time", () => {
    const mining = new TreeEditMiningProgress();
    const first = mining.advance(
      "7|0,0,0",
      20,
      4,
      { playerId: "alice", type: "touch" }
    );
    expect(first?.progress).toBe(0);
    expect(mining.advance(
      "7|0,0,0",
      20,
      4,
      { playerId: "alice", type: "touch" }
    )).toBeUndefined();
    expect(mining.advance(
      "7|0,0,0",
      20,
      4,
      { playerId: "bob", type: "touch" }
    )?.progress).toBe(0);
    expect(mining.advance(
      "7|0,0,0",
      21,
      4,
      { playerId: "alice", type: "touch" }
    )?.progress).toBe(0.25);
    expect(mining.advance(
      "7|0,0,0",
      24,
      4,
      { playerId: "alice", type: "touch" }
    )?.completed).toBe(true);
  });

  it("completes a one-second target after exactly 20 elapsed touch ticks", () => {
    const mining = new TreeEditMiningProgress();
    for (let tick = 0; tick < 20; tick++) {
      expect(mining.advance(
        "7|0,0,0",
        tick,
        20,
        { playerId: "alice", type: "touch" }
      )?.completed).toBe(false);
    }
    expect(mining.advance(
      "7|0,0,0",
      20,
      20,
      { playerId: "alice", type: "touch" }
    )?.completed).toBe(true);
  });

  it("preserves vanilla time across sparse continuous touch signals", () => {
    const mining = new TreeEditMiningProgress();
    for (let tick = 0; tick < 60; tick += 5) {
      expect(mining.advance(
        "7|0,0,0",
        tick,
        60,
        { playerId: "alice", type: "touch" }
      )?.completed).toBe(false);
    }
    expect(mining.advance(
      "7|0,0,0",
      60,
      60,
      { playerId: "alice", type: "touch" }
    )?.completed).toBe(true);
  });

  it("shares normalized work across tools and resets it after inactivity", () => {
    const mining = new TreeEditMiningProgress();
    expect(mining.advance("7|0,0,0", 20, 60, { type: "attack" })?.progress)
      .toBeCloseTo(0.105);
    expect(mining.advance(
      "7|0,0,0",
      21,
      10,
      { playerId: "alice", type: "touch" }
    )?.progress).toBeCloseTo(0.105);
    expect(mining.advance(
      "7|0,0,0",
      21 + PLAYER_EDIT_MINING_RESET_TICKS + 1,
      10,
      { playerId: "alice", type: "touch" }
    )?.progress).toBe(0);
  });

  it("reports mining effects only when the visible crack stage changes", () => {
    const mining = new TreeEditMiningProgress();
    const first = mining.advance("7|0,0,0", 20, 200, { type: "attack" });
    const sameStage = mining.advance("7|0,0,0", 21, 200, { type: "attack" });
    mining.advance("7|0,0,0", 22, 200, { type: "attack" });
    const nextStage = mining.advance("7|0,0,0", 23, 200, { type: "attack" });

    expect(first).toMatchObject({ stage: 0, stageChanged: true });
    expect(sameStage).toMatchObject({ stage: 0, stageChanged: false });
    expect(nextStage).toMatchObject({ stage: 1, stageChanged: true });
  });

  it("starts mining effects from the first crack stage after progress resets", () => {
    const mining = new TreeEditMiningProgress();
    expect(mining.advance("7|0,0,0", 20, 100, { type: "attack" }))
      .toMatchObject({ stage: 0, stageChanged: true });
    expect(mining.advance(
      "7|0,0,0",
      20 + PLAYER_EDIT_MINING_RESET_TICKS + 1,
      100,
      { type: "attack" }
    )).toMatchObject({ stage: 0, stageChanged: true });
  });
});

function item(typeId: string): ItemStack {
  return {
    getComponent: () => undefined,
    typeId
  } as unknown as ItemStack;
}
