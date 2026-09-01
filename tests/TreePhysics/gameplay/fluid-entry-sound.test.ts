import { describe, expect, it } from "vitest";
import { computeFluidEntrySoundVolume } from "@src/content/tree/fallenTree/FallenTreeLifecycle";

describe("fluid entry sound volume", () => {
  it("gets louder with entry impulse and contact area from the vanilla-volume floor", () => {
    const stationary = computeFluidEntrySoundVolume(1, 0, 1);
    const slow = computeFluidEntrySoundVolume(1, 0.25, 1);
    const fast = computeFluidEntrySoundVolume(1, 1, 1);
    const broad = computeFluidEntrySoundVolume(1, 1, 16);

    expect(stationary).toBe(1);
    expect(slow).toBeGreaterThan(stationary);
    expect(fast).toBeGreaterThan(slow);
    expect(broad).toBeGreaterThan(fast);
    expect(broad).toBeLessThan(1.2);
  });

  it("caps gain below twenty percent above the selected vanilla event volume", () => {
    expect(computeFluidEntrySoundVolume(0.5, 1_000, 32)).toBeLessThan(0.6);
    expect(computeFluidEntrySoundVolume(0.5, 1_000, 32)).toBeGreaterThan(0.59);
  });

  it("rejects invalid physics inputs instead of hiding them", () => {
    expect(() => computeFluidEntrySoundVolume(1, Number.NaN, 1)).toThrow(RangeError);
    expect(() => computeFluidEntrySoundVolume(1, -1, 1)).toThrow(RangeError);
    expect(() => computeFluidEntrySoundVolume(1, 1, 0)).toThrow(RangeError);
  });
});
