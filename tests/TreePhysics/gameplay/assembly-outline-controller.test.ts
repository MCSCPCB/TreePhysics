import { describe, expect, it, vi } from "vitest";
import {
  canBreakAssemblyBlock,
  canPlaceAssemblyBlock,
  damageSelectedToolForAssemblyBreak
} from "@src/content/contraption/editing/AssemblyEditPermissions";
import {
  createBlockPreviewTransform,
  createEdgeWriteExpression,
  hasViewDirectionChanged,
  isPlayerHeadInsideAssemblyPlacement,
  breakOverlayLocation,
  resolvePlacementCardinalDirection,
  shouldEnterBlockPreview,
  shouldRefreshOutlineRay
} from "@src/render/outline/OutlineMolang";
import { GameMode } from "@minecraft/server";

describe("assembly outline controller primitives", () => {
  it("centers the break overlay geometry on the selected cell", () => {
    expect(breakOverlayLocation({ x: 4, y: 8, z: 12 })).toEqual({
      x: 4,
      y: 7.625,
      z: 12
    });
  });

  it("enters block preview after 2.5 stable seconds or an immediate view change", () => {
    expect(shouldEnterBlockPreview("assembly", 49, false)).toBe(false);
    expect(shouldEnterBlockPreview("assembly", 50, false)).toBe(true);
    expect(shouldEnterBlockPreview("assembly", 0, true)).toBe(true);
    expect(shouldEnterBlockPreview("block", 99, true)).toBe(false);
  });

  it("treats actual angular movement as a view change", () => {
    expect(hasViewDirectionChanged(
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 }
    )).toBe(false);
    expect(hasViewDirectionChanged(
      { x: 0, y: 0, z: 1 },
      { x: 0.001, y: 0, z: 0.9999995 }
    )).toBe(true);
  });

  it("refreshes block targets every tick while retaining the assembly refresh interval", () => {
    expect(shouldRefreshOutlineRay("assembly", 1, false)).toBe(false);
    expect(shouldRefreshOutlineRay("assembly", 2, false)).toBe(true);
    expect(shouldRefreshOutlineRay("assembly", 0, true)).toBe(true);
    expect(shouldRefreshOutlineRay("block", 0, false)).toBe(true);
  });

  it("places chest cardinal directions along the assembly-local view direction", () => {
    const assembly = {
      body: {
        worldPointToLocal: ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z })
      }
    };

    expect(resolvePlacementCardinalDirection(
      assembly as never,
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 }
    )).toBe("east");
    expect(resolvePlacementCardinalDirection(
      assembly as never,
      { x: 0, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 }
    )).toBe("west");
    expect(resolvePlacementCardinalDirection(
      assembly as never,
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 }
    )).toBe("south");
    expect(resolvePlacementCardinalDirection(
      assembly as never,
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 }
    )).toBe("north");
  });

  it("encodes single-cell and adjacent placement previews compactly", () => {
    expect(createBlockPreviewTransform(
      { x: 4, y: 3, z: 2 },
      undefined,
      { x: 1, y: 1, z: 1 }
    )).toEqual({ side: 0, x: 3, y: 2, z: 1 });
    expect(createBlockPreviewTransform(
      { x: 4, y: 3, z: 2 },
      { x: 4, y: 2, z: 2 },
      { x: 1, y: 1, z: 1 }
    )).toEqual({ side: -2, x: 3, y: 2, z: 1 });
  });

  it("rejects non-adjacent placement previews", () => {
    expect(() => createBlockPreviewTransform(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 0, z: 0 }
    )).toThrow(/must be adjacent/);
  });

  it("rejects only placements that contain the player's head", () => {
    const identity = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z });

    expect(isPlayerHeadInsideAssemblyPlacement(
      { x: 4, y: 3, z: 2 },
      { x: 4, y: 3, z: 2 },
      identity
    )).toBe(true);
    expect(isPlayerHeadInsideAssemblyPlacement(
      { x: 5, y: 3, z: 2 },
      { x: 4, y: 3, z: 2 },
      identity
    )).toBe(false);
    expect(isPlayerHeadInsideAssemblyPlacement(
      { x: 4, y: 2.4, z: 2 },
      { x: 4, y: 3, z: 2 },
      identity
    )).toBe(false);
    expect(isPlayerHeadInsideAssemblyPlacement(
      { x: 4.499, y: 3, z: 2 },
      { x: 4, y: 3, z: 2 },
      identity
    )).toBe(true);
  });

  it("tests containment in the assembly's rotated local space", () => {
    const worldPointToLocal = ({ x, y, z }: { x: number; y: number; z: number }) => ({
      x: z,
      y,
      z: -x
    });

    expect(isPlayerHeadInsideAssemblyPlacement(
      { x: -2, y: 3, z: 4 },
      { x: 4, y: 3, z: 2 },
      worldPointToLocal
    )).toBe(true);
  });

  it("encodes player-local edge transforms and clears unused slots", () => {
    const expression = createEdgeWriteExpression([{
      axis: "z",
      length: 2,
      start: { x: 3.5, y: 4.5, z: 5.5 }
    }], { x: 1, y: 2, z: 3 });
    expect(expression).toContain("v.e0_x=2.5");
    expect(expression).toContain("v.e0_y=2.5");
    expect(expression).toContain("v.e0_z=2.5");
    expect(expression).toContain("v.e0_l=2");
    expect(expression).toContain("v.e0_a=2");
    expect(expression).toContain("v.e27_l=0");
    expect(expression.endsWith(";return 1;")).toBe(true);
  });

  it("preserves vanilla sword breaking rules across game modes", () => {
    expect(canBreakAssemblyBlock(GameMode.Survival, "minecraft:oak_log", true, [])).toBe(true);
    expect(canBreakAssemblyBlock(GameMode.Creative, "minecraft:oak_log", true, [])).toBe(false);
    expect(canBreakAssemblyBlock(GameMode.Creative, "minecraft:oak_log", false, [])).toBe(true);
    expect(canBreakAssemblyBlock(GameMode.Spectator, "minecraft:oak_log", false, [])).toBe(false);
  });

  it("uses adventure destroy lists with the vanilla namespace default", () => {
    expect(canBreakAssemblyBlock(
      GameMode.Adventure,
      "minecraft:oak_log",
      false,
      ["oak_log"]
    )).toBe(true);
    expect(canBreakAssemblyBlock(
      GameMode.Adventure,
      "minecraft:oak_log",
      false,
      ["minecraft:spruce_log"]
    )).toBe(false);
  });

  it("uses adventure placement lists against the supporting assembly block", () => {
    expect(canPlaceAssemblyBlock(
      GameMode.Adventure,
      "minecraft:oak_log",
      ["oak_log"]
    )).toBe(true);
    expect(canPlaceAssemblyBlock(
      GameMode.Adventure,
      "minecraft:oak_log",
      ["minecraft:spruce_log"]
    )).toBe(false);
    expect(canPlaceAssemblyBlock(GameMode.Survival, "minecraft:oak_log", [])).toBe(true);
    expect(canPlaceAssemblyBlock(GameMode.Spectator, "minecraft:oak_log", [])).toBe(false);
  });

  it("damages the selected survival tool once after a successful block edit", () => {
    const fixture = createDurabilityFixture(GameMode.Survival, 12, 100, 100);

    expect(damageSelectedToolForAssemblyBreak(
      fixture.player,
      fixture.usedItem,
      () => 0
    )).toBe("damaged");

    expect(fixture.durability.damage).toBe(13);
    expect(fixture.container.setItem).toHaveBeenCalledWith(2, fixture.selectedItem);
    expect(fixture.player.playSound).not.toHaveBeenCalled();
  });

  it("honors Unbreaking and leaves the selected item unchanged when its roll succeeds", () => {
    const fixture = createDurabilityFixture(GameMode.Survival, 12, 100, 25, 3);

    expect(damageSelectedToolForAssemblyBreak(
      fixture.player,
      fixture.usedItem,
      () => 0.25
    )).toBe("unchanged");

    expect(fixture.durability.getDamageChance).toHaveBeenCalledWith(3);
    expect(fixture.durability.damage).toBe(12);
    expect(fixture.container.setItem).not.toHaveBeenCalled();
  });

  it("removes a tool on its final durability use and plays the vanilla break sound", () => {
    const fixture = createDurabilityFixture(GameMode.Survival, 99, 100, 100);

    expect(damageSelectedToolForAssemblyBreak(
      fixture.player,
      fixture.usedItem,
      () => 0
    )).toBe("broken");

    expect(fixture.container.setItem).toHaveBeenCalledWith(2, undefined);
    expect(fixture.player.playSound).toHaveBeenCalledWith(
      "random.break",
      { pitch: 0.9, volume: 1 }
    );
  });

  it("does not consume tool durability in Creative mode", () => {
    const fixture = createDurabilityFixture(GameMode.Creative, 12, 100, 100);

    expect(damageSelectedToolForAssemblyBreak(
      fixture.player,
      fixture.usedItem,
      () => 0
    )).toBe("unchanged");

    expect(fixture.container.getItem).not.toHaveBeenCalled();
    expect(fixture.container.setItem).not.toHaveBeenCalled();
  });

  it("does not write back items that have no usable durability component", () => {
    const nonDurable = createDurabilityFixture(GameMode.Survival, 0, 100, 100);
    nonDurable.selectedItem.getComponent.mockReturnValue(undefined);
    expect(damageSelectedToolForAssemblyBreak(
      nonDurable.player,
      nonDurable.usedItem,
      () => 0
    )).toBe("unchanged");

    const unbreakable = createDurabilityFixture(GameMode.Survival, 12, 100, 100);
    unbreakable.durability.unbreakable = true;
    expect(damageSelectedToolForAssemblyBreak(
      unbreakable.player,
      unbreakable.usedItem,
      () => 0
    )).toBe("unchanged");

    expect(nonDurable.container.setItem).not.toHaveBeenCalled();
    expect(unbreakable.container.setItem).not.toHaveBeenCalled();
  });
});

function createDurabilityFixture(
  gameMode: GameMode,
  damage: number,
  maxDurability: number,
  damageChance: number,
  unbreakingLevel = 0
) {
  const durability = {
    damage,
    getDamageChance: vi.fn(() => damageChance),
    maxDurability,
    unbreakable: false
  };
  const enchantable = {
    getEnchantment: vi.fn(() => (
      unbreakingLevel > 0 ? { level: unbreakingLevel } : undefined
    ))
  };
  const selectedItem = {
    getComponent: vi.fn((componentId: string) => (
      componentId === "minecraft:durability" ? durability : enchantable
    )),
    typeId: "minecraft:iron_axe"
  };
  const usedItem = { typeId: "minecraft:iron_axe" };
  const container = {
    getItem: vi.fn(() => selectedItem),
    setItem: vi.fn()
  };
  const player = {
    getComponent: vi.fn(() => ({ container })),
    getGameMode: vi.fn(() => gameMode),
    id: "player",
    playSound: vi.fn(),
    selectedSlotIndex: 2
  };
  return {
    container,
    durability,
    player: player as never,
    selectedItem,
    usedItem: usedItem as never
  };
}
