import {
  InputButton,
  system,
  world,
  type Player
} from "@minecraft/server";

/** Tracks connected players and the small subset currently using crouch editing. */
export class ActivePlayerRegistry {
  readonly #players = new Map<string, Player>();
  readonly #sneakingPlayers = new Map<string, Player>();
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    world.afterEvents.playerSpawn.subscribe(event => this.#syncPlayer(event.player));
    world.afterEvents.playerDimensionChange.subscribe(event => this.#syncPlayer(event.player));
    world.afterEvents.playerButtonInput.subscribe(
      event => this.#syncPlayer(event.player),
      { buttons: [InputButton.Sneak] }
    );
    world.beforeEvents.playerLeave.subscribe(event => this.remove(event.player.id));

    // World player queries are unavailable in early execution. Bootstrap once
    // on the first normal tick, then keep the registry entirely event-driven.
    system.run(() => {
      for (const player of world.getPlayers()) this.#syncPlayer(player);
    });
  }

  get(playerId: string): Player | undefined {
    const player = this.#players.get(playerId);
    if (!player) return undefined;
    if (player.isValid) return player;
    this.remove(playerId);
    return undefined;
  }

  hasSneakingPlayer(playerId: string): boolean {
    return this.#sneakingPlayers.has(playerId);
  }

  *players(): IterableIterator<Player> {
    for (const [playerId, player] of this.#players) {
      if (!player.isValid) {
        this.remove(playerId);
        continue;
      }
      yield player;
    }
  }

  *sneakingPlayers(): IterableIterator<Player> {
    for (const [playerId, player] of this.#sneakingPlayers) {
      if (!isActivelySneaking(player)) {
        this.#sneakingPlayers.delete(playerId);
        continue;
      }
      yield player;
    }
  }

  remove(playerId: string): void {
    this.#players.delete(playerId);
    this.#sneakingPlayers.delete(playerId);
  }

  #syncPlayer(player: Player): void {
    if (!player.isValid) {
      this.remove(player.id);
      return;
    }
    this.#players.set(player.id, player);
    if (isActivelySneaking(player)) this.#sneakingPlayers.set(player.id, player);
    else this.#sneakingPlayers.delete(player.id);
  }
}

function isActivelySneaking(player: Player): boolean {
  try {
    return player.isValid && player.isSneaking;
  } catch {
    return false;
  }
}
