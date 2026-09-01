import { describe, expect, it } from "vitest";
import { testEvents } from "@minecraft/server";
import { ActivePlayerRegistry } from "@src/service/ActivePlayerRegistry";

describe("active player registry", () => {
  it("tracks crouch state from input events without polling all players", () => {
    const registry = new ActivePlayerRegistry();
    const player = {
      id: "player",
      isSneaking: false,
      isValid: true
    };
    registry.start();
    testEvents.playerSpawn(player);
    expect(registry.get(player.id)).toBe(player);
    expect([...registry.sneakingPlayers()]).toEqual([]);

    player.isSneaking = true;
    testEvents.playerButtonInput(player);
    expect([...registry.sneakingPlayers()]).toEqual([player]);

    // Touch can report an immediate release while toggle-crouch remains active.
    testEvents.playerButtonInput(player);
    expect([...registry.sneakingPlayers()]).toEqual([player]);

    player.isSneaking = false;
    testEvents.playerButtonInput(player);
    expect([...registry.sneakingPlayers()]).toEqual([]);
    testEvents.playerLeave(player);
    expect(registry.get(player.id)).toBeUndefined();
  });
});
