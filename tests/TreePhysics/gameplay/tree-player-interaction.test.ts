import { describe, expect, it } from "vitest";
import { EntitySwingSource, InputMode } from "@minecraft/server";
import {
  canEatFoodNow,
  resolveAssemblyEditAction,
  shouldSuppressTouchBreak
} from "@src/content/player/TreePlayerInteraction";

describe("assembly edit input semantics", () => {
  it("maps keyboard and mouse build and mining swings", () => {
    expect(resolveAssemblyEditAction(
      EntitySwingSource.Build,
      false,
      InputMode.KeyboardAndMouse
    )).toBe("place");
    expect(resolveAssemblyEditAction(
      EntitySwingSource.Attack,
      false,
      InputMode.KeyboardAndMouse
    )).toBe("break");
    expect(resolveAssemblyEditAction(
      EntitySwingSource.Mine,
      false,
      InputMode.KeyboardAndMouse
    )).toBe("break");
    expect(resolveAssemblyEditAction(
      EntitySwingSource.Interact,
      false,
      InputMode.KeyboardAndMouse
    )).toBeUndefined();
  });

  it("gives a cancellable native placement event priority over swing classification", () => {
    expect(resolveAssemblyEditAction(
      EntitySwingSource.Attack,
      true,
      InputMode.KeyboardAndMouse
    )).toBe("place");
    expect(resolveAssemblyEditAction(
      EntitySwingSource.Interact,
      true,
      InputMode.KeyboardAndMouse
    )).toBe("place");
    expect(resolveAssemblyEditAction(
      EntitySwingSource.UseItem,
      true,
      InputMode.KeyboardAndMouse
    )).toBe("place");
  });

  it("makes touch tap placement and hold mining mutually exclusive", () => {
    expect(resolveAssemblyEditAction(EntitySwingSource.Attack, false, InputMode.Touch, false, true))
      .toBe("place");
    expect(resolveAssemblyEditAction(EntitySwingSource.Attack, false, InputMode.Touch))
      .toBeUndefined();
    expect(resolveAssemblyEditAction(EntitySwingSource.Build, false, InputMode.Touch))
      .toBe("place");
    expect(resolveAssemblyEditAction(EntitySwingSource.Mine, true, InputMode.Touch))
      .toBe("place");
    expect(resolveAssemblyEditAction(EntitySwingSource.Mine, false, InputMode.Touch))
      .toBe("break");
    expect(resolveAssemblyEditAction(EntitySwingSource.Attack, true, InputMode.Touch, true, true))
      .toBe("place");
  });

  it("suppresses touch break signals adjacent to a native block interaction", () => {
    expect(shouldSuppressTouchBreak(40, 40, 40)).toBe(true);
    expect(shouldSuppressTouchBreak(40, 41, 41)).toBe(true);
    expect(shouldSuppressTouchBreak(41, 40, 41)).toBe(true);
    expect(shouldSuppressTouchBreak(40, 42, 42)).toBe(false);
    expect(shouldSuppressTouchBreak(undefined, 40, 41)).toBe(false);
  });

  it("prioritizes vanilla food use only when the food can currently be eaten", () => {
    expect(canEatFoodNow(false, 19, 20)).toBe(true);
    expect(canEatFoodNow(false, 20, 20)).toBe(false);
    expect(canEatFoodNow(true, 20, 20)).toBe(true);
  });
});
