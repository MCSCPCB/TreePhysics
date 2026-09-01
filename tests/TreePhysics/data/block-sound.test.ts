import { describe, expect, it } from "vitest";
import {
  resolveVanillaBlockBreakSound,
  resolveVanillaBlockHitSound,
  resolveVanillaBlockStepSound
} from "@src/data/BlockSound";

describe("tree block mining-hit sounds", () => {
  it.each([
    ["minecraft:oak_log", "hit.wood", 0.23],
    ["oak_leaves", "hit.grass", 0.3],
    ["minecraft:hanging_roots", "hit.hanging_roots", 0.35],
    ["minecraft:pale_hanging_moss", "hit.moss", 1],
    ["minecraft:vine", "hit.vines", 0.3]
  ])("maps %s to %s with its vanilla volume", (typeId, sound, volume) => {
    expect(resolveVanillaBlockHitSound(typeId, () => 0)).toEqual({
      pitch: expect.any(Number),
      sound,
      volume
    });
  });

  it("uses leaf and wood defaults for unknown Add-On blocks", () => {
    expect(resolveVanillaBlockHitSound("example:unknown_leaves", () => 0)).toEqual({
      pitch: 0.5,
      sound: "hit.grass",
      volume: 0.3
    });
    expect(resolveVanillaBlockHitSound("example:unknown_log", () => 0)).toEqual({
      pitch: 0.5,
      sound: "hit.wood",
      volume: 0.23
    });
    expect(resolveVanillaBlockHitSound(undefined, () => 0)).toEqual({
      pitch: 0.5,
      sound: "hit.wood",
      volume: 0.23
    });
  });

  it("preserves vanilla break and step volume instead of applying a fixed gain", () => {
    expect(resolveVanillaBlockBreakSound("minecraft:oak_leaves", () => 0)).toEqual({
      pitch: 0.8,
      sound: "dig.grass",
      volume: 0.7
    });
    expect(resolveVanillaBlockBreakSound("minecraft:oak_log", () => 1)).toEqual({
      pitch: 1,
      sound: "dig.wood",
      volume: 1
    });
    expect(resolveVanillaBlockStepSound("minecraft:oak_log", () => 0)).toEqual({
      pitch: 1,
      sound: "step.wood",
      volume: 0.3
    });
    expect(resolveVanillaBlockStepSound("minecraft:pale_hanging_moss", () => 0)).toEqual({
      pitch: 1,
      sound: "step.moss",
      volume: 0.2
    });
  });
});
