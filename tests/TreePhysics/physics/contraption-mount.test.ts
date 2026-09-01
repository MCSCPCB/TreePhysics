import { world, type Dimension, type Entity, type Player, type Vector3 } from "@minecraft/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhysicsContraption } from "@src/Physics";
import {
  handleContraptionMountLoad,
  MountObb,
  removeStaleContraptionMounts,
  restoreStaleMountPlayerInput
} from "@src/physics/obb/Mount";

const MOUNT_PLAYER_INPUT_TAG = "treephysics_mount_rider";
const mounts: MountObb[] = [];

afterEach(() => {
  for (const mount of mounts) mount.dispose();
  mounts.length = 0;
  vi.restoreAllMocks();
});

describe("contraption Mount", () => {
  it("does not bind when the support surface is above the player's feet", () => {
    const fixture = createFixture();
    fixture.translation.y = -0.4;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("does not bind before the player's feet reach a lower support surface", () => {
    const fixture = createFixture();
    fixture.translation.y = -0.54;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("does not bind when only the edge of the player's footprint reaches the surface", () => {
    const fixture = createFixture();
    fixture.translation.x = 0.6;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("does not bind without an airborne landing approach", () => {
    const fixture = createFixture();
    fixture.landingFeetY.value = undefined;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("binds when the player's feet cross the support surface between ticks", () => {
    const fixture = createFixture();
    fixture.player.feetY = -0.08;
    fixture.landingFeetY.value = 0.04;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(false);
    const impulse = fixture.seat.applyImpulse.mock.calls[0]![0] as Vector3;
    expect(impulse.x).toBe(0);
    expect(impulse.y).toBeCloseTo(0.081, 6);
    expect(impulse.z).toBe(0);
    expect(fixture.seat.location.y).toBeCloseTo(fixture.player.feetY, 6);
    expect(fixture.seat.teleport).not.toHaveBeenCalled();
  });

  it("binds a grounded handoff without resolving a surface block", () => {
    const fixture = createFixture();
    fixture.translation.x = 2;

    fixture.mount.tick(true, true, new Map([
      [fixture.player.id, {
        contraptionId: fixture.candidates[0]!.id,
        supportLocal: { x: 0, y: 0.5, z: 0 }
      }]
    ]));

    expect(fixture.player.movementEnabled).toBe(false);
    expect(fixture.seat.location.y).toBe(0);
    expect(fixture.queries.raycasts).toBe(0);
  });

  it("keeps the input permission marker synchronized with the Mount binding", () => {
    const fixture = createFixture();

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(false);
    expect(fixture.player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(true);

    fixture.mount.tick(false, true);

    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(false);
  });

  it("does not bind to a sleeping contraption", () => {
    const fixture = createFixture();
    fixture.contraptionSleeping.value = true;

    fixture.mount.tick(true, true);

    expect(fixture.spawnCount.value).toBe(0);
    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("releases the Mount when its contraption goes to sleep", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.contraptionSleeping.value = true;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.seat.remove).toHaveBeenCalledOnce();
  });

  it("keeps one Mount owner for a player across physics dimensions", () => {
    const first = createFixture();
    const second = createFixture({ player: first.player });

    first.mount.tick(true, true);
    second.mount.tick(true, true);

    expect(first.spawnCount.value).toBe(1);
    expect(second.spawnCount.value).toBe(0);

    first.mount.dispose();
    second.mount.tick(true, true);

    expect(second.spawnCount.value).toBe(1);
    expect(first.player.movementEnabled).toBe(false);
  });

  it("restores Mount-owned input when the seat is killed", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.landingFeetY.value = undefined;
    fixture.seat.isValid = false;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(false);
  });

  it("restores a surviving input marker when the player respawns", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.landingFeetY.value = undefined;
    fixture.player.isValid = false;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(false);
    expect(fixture.player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(true);

    fixture.player.isValid = true;
    restoreStaleMountPlayerInput(fixture.player as unknown as Player);

    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(false);
  });

  it("removes a loaded orphan Mount and restores its rider input", () => {
    const player = new FakePlayer("minecraft:overworld");
    const seat = new FakeSeat({ x: 0, y: 0, z: 0 });
    player.addTag(MOUNT_PLAYER_INPUT_TAG);
    player.movementEnabled = false;
    seat.getComponent("minecraft:rideable")!.addRider(player as unknown as Entity);

    handleContraptionMountLoad(seat as unknown as Entity);

    expect(player.movementEnabled).toBe(true);
    expect(player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(false);
    expect(seat.remove).toHaveBeenCalledOnce();
  });

  it("scans loaded dimensions for Mounts left by an earlier runtime", () => {
    const player = new FakePlayer("minecraft:overworld");
    const seat = new FakeSeat({ x: 0, y: 0, z: 0 });
    player.addTag(MOUNT_PLAYER_INPUT_TAG);
    player.movementEnabled = false;
    seat.getComponent("minecraft:rideable")!.addRider(player as unknown as Entity);
    vi.spyOn(world, "getDimension").mockReturnValue({
      getEntities: () => [seat as unknown as Entity]
    } as unknown as Dimension);
    vi.spyOn(world, "getAllPlayers").mockReturnValue([player as unknown as Player]);

    removeStaleContraptionMounts();

    expect(player.movementEnabled).toBe(true);
    expect(player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(false);
    expect(seat.remove).toHaveBeenCalledOnce();
  });

  it("rolls back the rider and input lock when initial Mount motion fails", () => {
    const fixture = createFixture();
    fixture.seat.applyImpulse.mockImplementationOnce(() => {
      throw new Error("initial Mount impulse failed");
    });

    expect(() => fixture.mount.tick(true, true)).toThrow("initial Mount impulse failed");
    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.player.hasTag(MOUNT_PLAYER_INPUT_TAG)).toBe(false);
    expect(fixture.seat.remove).toHaveBeenCalledOnce();
  });

  it("does not bind when the player's body enters after their feet passed the surface", () => {
    const fixture = createFixture();
    fixture.player.feetY = -0.2;
    fixture.landingFeetY.value = -0.1;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("does not bind while native world collision supports the player", () => {
    const fixture = createFixture();
    fixture.player.isOnGround = true;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
  });

  it("applies player movement on the initial binding tick", () => {
    const fixture = createFixture();
    fixture.player.movement = { x: 0, y: 1 };

    fixture.mount.tick(true, true);

    expect(fixture.seat.applyImpulse).toHaveBeenCalledOnce();
    expect(fixture.seat.applyImpulse).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      z: 0.2158
    });
  });

  it("projects player input onto a walkable support plane", () => {
    const idle = createFixture({ slopeAngle: 15 });
    const moving = createFixture({ slopeAngle: 15 });
    moving.player.movement = { x: 1, y: 0 };

    idle.mount.tick(true, true);
    moving.mount.tick(true, true);

    const idleImpulse = idle.seat.applyImpulse.mock.calls[0]![0] as Vector3;
    const movingImpulse = moving.seat.applyImpulse.mock.calls[0]![0] as Vector3;
    const inputMovement = {
      x: movingImpulse.x - idleImpulse.x,
      y: movingImpulse.y - idleImpulse.y,
      z: movingImpulse.z - idleImpulse.z
    };
    const radians = 15 * Math.PI / 180;
    const normal = { x: -Math.sin(radians), y: Math.cos(radians), z: 0 };

    expect(inputMovement.x).toBeGreaterThan(0);
    expect(inputMovement.y).toBeGreaterThan(0);
    expect(
      inputMovement.x * normal.x + inputMovement.y * normal.y
    ).toBeCloseTo(0, 3);
    idle.mount.tick(false, true);
    moving.mount.tick(false, true);
  });

  it("follows a transported support point without colliding with its own wall", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.seat.applyImpulse.mockClear();
    fixture.seat.clearVelocity.mockClear();
    fixture.translation.x = 0.5;

    fixture.mount.tick(true, true);

    expect(fixture.seat.clearVelocity).toHaveBeenCalledOnce();
    expect(fixture.seat.applyImpulse).toHaveBeenCalledWith({ x: 0.5, y: 0, z: 0 });
    expect(fixture.player.movementEnabled).toBe(false);
    fixture.mount.tick(false, true);
  });

  it("keeps the stable per-player query budget", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    resetQueryCounts(fixture.queries);

    fixture.mount.tick(true, true);

    expect(fixture.queries.candidateQueries).toBe(0);
    expect(fixture.queries.localBoundsQueries).toBe(1);
    expect(fixture.queries.raycasts).toBe(5);
    fixture.mount.tick(false, true);
  });

  it("combines the vanilla jump velocity with horizontal player input", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.player.jumpPressed = true;
    fixture.player.movement = { x: 0, y: 1 };

    fixture.mount.tick(true, true);

    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.x).toBe(0);
    expect(impulse.y).toBeCloseTo(0.42);
    expect(impulse.z).toBeCloseTo(0.15);
    fixture.mount.tick(false, true);
  });

  it("enters pseudo sprint after double tapping forward", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.player.movement = { x: 0, y: 1 };
    fixture.mount.tick(true, true);
    fixture.player.movement = { x: 0, y: 0 };
    fixture.mount.tick(true, true);
    fixture.player.movement = { x: 0, y: 1 };
    fixture.mount.tick(true, true);
    fixture.mount.tick(true, true);

    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.x).toBe(0);
    expect(impulse.y).toBe(0);
    expect(impulse.z).toBeCloseTo(0.2158 * 1.3);
    expect(fixture.surfaceContacts.at(-1)?.sprinting).toBe(true);
    fixture.mount.tick(false, true);
  });

  it("keeps the vanilla gravity recurrence beyond the previous fall-speed cap", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;

    for (let tick = 0; tick < 30; tick++) fixture.mount.tick(true, true);

    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.y).toBeLessThan(-1.5);
  });

  it.each([
    { fluidTypeId: undefined, inWater: true, name: "water" },
    { fluidTypeId: "minecraft:lava", inWater: false, name: "lava" }
  ])("uses passive $name gravity and vertical drag while submerged", ({ fluidTypeId, inWater }) => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;
    fixture.player.isInWater = inWater;
    fixture.fluidTypeId.value = fluidTypeId;

    fixture.mount.tick(true, true);
    fixture.mount.tick(true, true);
    fixture.mount.tick(true, true);

    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.y).toBeCloseTo(-0.036);
  });

  it.each([
    { fluidTypeId: undefined, inWater: true, name: "water" },
    { fluidTypeId: "minecraft:lava", inWater: false, name: "lava" }
  ])("allows a jump while the mounted player is detached in $name", ({ fluidTypeId, inWater }) => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;
    fixture.player.isInWater = inWater;
    fixture.fluidTypeId.value = fluidTypeId;
    fixture.player.jumpPressed = true;

    fixture.mount.tick(true, true);

    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.y).toBeCloseTo(0.42);
  });

  it("resolves grounded rider lag through the unified movement impulse", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.player.feetY = -0.1;
    fixture.seat.location.y = -0.1;

    fixture.mount.tick(true, true);

    expect(fixture.seat.teleport).not.toHaveBeenCalled();
    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.y).toBeCloseTo(0.101);
  });

  it("releases the player after the existing world-support grace period", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;
    fixture.worldSupportEnabled.value = true;

    for (let tick = 0; tick < 9; tick++) fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.seat.remove).toHaveBeenCalledOnce();
  });

  it("keeps the player mounted after the supporting contraption becomes invalid", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.contraptionValidity.value = false;

    fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(false);
    expect(fixture.seat.remove).not.toHaveBeenCalled();

    fixture.worldSupportEnabled.value = true;
    for (let tick = 0; tick < 9; tick++) fixture.mount.tick(true, true);

    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.seat.remove).toHaveBeenCalledOnce();
  });

  it("transfers the existing Mount to another supporting contraption", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;
    const nextTranslation = { x: 0, y: -0.5, z: 0 };
    fixture.candidates.push(createContraption(
      2,
      nextTranslation,
      { value: true },
      { value: true },
      createQueryCounts(),
      { value: false }
    ));

    fixture.mount.tick(true, true);
    fixture.mount.tick(true, true);
    fixture.mount.tick(true, true);
    nextTranslation.x = 0.5;
    fixture.mount.tick(true, true);

    expect(fixture.spawnCount.value).toBe(1);
    expect(fixture.player.movementEnabled).toBe(false);
    expect(fixture.seat.applyImpulse).toHaveBeenLastCalledWith({ x: 0.5, y: 0, z: 0 });
    fixture.mount.tick(false, true);
  });

  it("transfers immediately when mounted feet cross a lower contraption", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;
    fixture.seat.location.y = -3.1;
    const candidateQueries = fixture.queries.candidateQueries;
    const nextTranslation = { x: 0, y: -3.5, z: 0 };
    fixture.candidates.push(createContraption(
      2,
      nextTranslation,
      { value: true },
      { value: true },
      createQueryCounts(),
      { value: false }
    ));

    fixture.mount.tick(true, true);

    expect(fixture.spawnCount.value).toBe(1);
    expect(fixture.player.movementEnabled).toBe(false);
    expect(fixture.queries.candidateQueries - candidateQueries).toBe(1);
    const impulse = fixture.seat.applyImpulse.mock.calls.at(-1)![0] as Vector3;
    expect(impulse.y).toBeCloseTo(0.101);
    expect(fixture.seat.teleport).not.toHaveBeenCalled();
  });

  it("releases the Mount when mounted feet cross a sleeping contraption", () => {
    const fixture = createFixture();
    fixture.mount.tick(true, true);
    fixture.supportEnabled.value = false;
    fixture.seat.location.y = -3.1;
    const candidateQueries = fixture.queries.candidateQueries;
    fixture.candidates.push(createContraption(
      2,
      { x: 0, y: -3.5, z: 0 },
      { value: true },
      { value: true },
      createQueryCounts(),
      { value: true }
    ));

    fixture.mount.tick(true, true);

    expect(fixture.queries.candidateQueries - candidateQueries).toBe(1);
    expect(fixture.player.movementEnabled).toBe(true);
    expect(fixture.seat.remove).toHaveBeenCalledOnce();
  });
});

interface MountFixture {
  readonly candidates: PhysicsContraption[];
  readonly contraptionSleeping: { value: boolean };
  readonly contraptionValidity: { value: boolean };
  readonly fluidTypeId: { value: string | undefined };
  readonly landingFeetY: { value: number | undefined };
  readonly mount: MountObb;
  readonly player: FakePlayer;
  readonly queries: MountQueryCounts;
  readonly seat: FakeSeat;
  readonly spawnCount: { value: number };
  readonly surfaceContacts: MountSurfaceContactRecord[];
  readonly supportEnabled: { value: boolean };
  readonly translation: Vector3;
  readonly worldSupportEnabled: { value: boolean };
}

interface MountFixtureOptions {
  readonly player?: FakePlayer;
  readonly slopeAngle?: number;
}

interface MountQueryCounts {
  candidateQueries: number;
  localBoundsQueries: number;
  raycasts: number;
}

interface MountSurfaceContactRecord {
  readonly sprinting?: boolean;
}

let nextPlayerId = 1;

class FakePlayer {
  readonly id: string;
  readonly typeId = "minecraft:player";
  isValid = true;
  readonly dimension: { readonly id: string };
  feetY = 0;
  isInWater = false;
  isOnGround = false;
  jumpPressed = false;
  movement: { x: number; y: number } = { x: 0, y: 0 };
  movementEnabled = true;
  readonly inputInfo = {
    getButtonState: () => this.jumpPressed ? "Pressed" : "Released",
    getMovementVector: () => ({ ...this.movement })
  };
  readonly inputPermissions = {
    setPermissionCategory: (_category: string, enabled: boolean) => {
      this.movementEnabled = enabled;
    }
  };
  readonly #tags = new Set<string>();

  constructor(dimensionId: string) {
    this.id = `player-${nextPlayerId++}`;
    this.dimension = { id: dimensionId };
  }

  getAABB() {
    return {
      center: { x: 0, y: this.feetY + 0.9, z: 0 },
      extent: { x: 0.3, y: 0.9, z: 0.3 }
    };
  }

  getRotation(): Vector3 {
    return { x: 0, y: 0, z: 0 };
  }

  getVelocity(): Vector3 {
    return { x: 0, y: 0, z: 0 };
  }

  addTag(tag: string): boolean {
    if (this.#tags.has(tag)) return false;
    this.#tags.add(tag);
    return true;
  }

  hasTag(tag: string): boolean {
    return this.#tags.has(tag);
  }

  removeTag(tag: string): boolean {
    return this.#tags.delete(tag);
  }

}

let nextSeatId = 1;

class FakeSeat {
  readonly id: string;
  readonly typeId = "treephysics:contraption_mount";
  isValid = true;
  location: Vector3;
  readonly applyImpulse = vi.fn();
  readonly clearVelocity = vi.fn();
  readonly teleport = vi.fn((location: Vector3) => {
    this.location = { ...location };
  });
  readonly remove = vi.fn(() => {
    this.isValid = false;
  });
  readonly #riders: Entity[] = [];
  readonly #rideable = {
    addRider: (rider: Entity) => {
      this.#riders.push(rider);
      return true;
    },
    ejectRiders: () => {
      this.#riders.length = 0;
    },
    getRiders: () => [...this.#riders]
  };

  constructor(location: Vector3) {
    this.id = `seat-${nextSeatId++}`;
    this.location = { ...location };
  }

  getComponent(componentId: string) {
    return componentId === "minecraft:rideable" ? this.#rideable : undefined;
  }
}

function createFixture(options: MountFixtureOptions = {}): MountFixture {
  const dimensionId = "minecraft:overworld";
  const player = options.player ?? new FakePlayer(dimensionId);
  const seat = new FakeSeat({ x: 0, y: 0, z: 0 });
  const spawnCount = { value: 0 };
  const worldSupportEnabled = { value: false };
  const translation = { x: 0, y: -0.5, z: 0 };
  const supportEnabled = { value: true };
  const contraptionSleeping = { value: false };
  const contraptionValidity = { value: true };
  const fluidTypeId: { value: string | undefined } = { value: undefined };
  const queries = createQueryCounts();
  const surfaceY = options.slopeAngle === undefined
    ? undefined
    : translation.y + 0.5 / Math.cos(options.slopeAngle * Math.PI / 180);
  if (surfaceY !== undefined) player.feetY = surfaceY - 0.08;
  const dimension = {
    getBlock: () => {
      if (fluidTypeId.value) {
        return {
          isAir: false,
          isLiquid: true,
          location: { x: 0, y: 0, z: 0 },
          permutation: { getAllStates: () => ({ liquid_depth: 0 }) },
          typeId: fluidTypeId.value
        };
      }
      if (options.slopeAngle === undefined && worldSupportEnabled.value) {
        return {
          isAir: false,
          isLiquid: false,
          location: { x: 0, y: -1, z: 0 },
          typeId: "minecraft:stone"
        };
      }
      return undefined;
    },
    id: dimensionId,
    getPlayers: () => [player],
    spawnEntity: (_typeId: string, location: Vector3) => {
      spawnCount.value++;
      seat.location = { ...location };
      seat.isValid = true;
      return seat;
    }
  };
  const contraption = options.slopeAngle === undefined
    ? createContraption(
      1,
      translation,
      supportEnabled,
      contraptionValidity,
      queries,
      contraptionSleeping
    )
    : createSlopedContraption(
      translation,
      options.slopeAngle,
      supportEnabled,
      contraptionValidity,
      queries,
      contraptionSleeping
    );
  const candidates = [contraption];
  const landingFeetY: { value: number | undefined } = {
    value: surfaceY === undefined ? 0.08 : surfaceY + 0.04
  };
  const surfaceContacts: MountSurfaceContactRecord[] = [];
  const mount = new MountObb(
    dimension as unknown as Dimension,
    () => {
      queries.candidateQueries++;
      return candidates.filter(candidate => candidate.isValid);
    },
    () => ({ collisionShape: "full" }),
    () => landingFeetY.value,
    (_entity, _location, _relativePosition, _playerPosition,
      _contraptionId, _block, _playerVelocity, _surfaceVelocity, state) => {
      surfaceContacts.push({ sprinting: state?.sprinting });
    }
  );
  mounts.push(mount);
  return {
    candidates,
    contraptionSleeping,
    contraptionValidity,
    fluidTypeId,
    landingFeetY,
    mount,
    player,
    queries,
    seat,
    spawnCount,
    surfaceContacts,
    supportEnabled,
    translation,
    worldSupportEnabled
  };
}

function createContraption(
  id: number,
  translation: Vector3,
  supportEnabled: { readonly value: boolean },
  validity: { readonly value: boolean },
  queries: MountQueryCounts,
  sleeping: { readonly value: boolean }
): PhysicsContraption {
  const block = {
    localLocation: { x: 0, y: 0, z: 0 },
    typeId: "minecraft:oak_log"
  };
  const blocks = [
    block,
    { localLocation: { x: 1, y: 1, z: 0 }, typeId: "minecraft:oak_log" },
    { localLocation: { x: 1, y: 2, z: 0 }, typeId: "minecraft:oak_log" }
  ];
  const contraption = {
    body: {
      get isSleeping() { return sleeping.value; },
      getAabb: () => ({
        min: {
          x: translation.x - 0.5,
          y: translation.y - 0.5,
          z: translation.z - 0.5
        },
        max: {
          x: translation.x + 0.5,
          y: translation.y + 0.5,
          z: translation.z + 0.5
        }
      }),
      localPointToWorld: (location: Vector3) => ({
        x: location.x + translation.x,
        y: location.y + translation.y,
        z: location.z + translation.z
      }),
      worldPointToLocal: (location: Vector3) => ({
        x: location.x - translation.x,
        y: location.y - translation.y,
        z: location.z - translation.z
      })
    },
    id,
    get isValid() { return validity.value; },
    getBlocksInLocalBounds: () => {
      queries.localBoundsQueries++;
      return supportEnabled.value ? blocks : [];
    },
    raycast: (origin: Vector3) => {
      queries.raycasts++;
      return supportEnabled.value ? {
        block,
        distance: origin.y - (translation.y + 0.5),
        face: "up",
        localLocation: {
          x: origin.x - translation.x,
          y: 0.5,
          z: origin.z - translation.z
        },
        localNormal: { x: 0, y: 1, z: 0 },
        location: {
          x: origin.x,
          y: translation.y + 0.5,
          z: origin.z
        },
        normal: { x: 0, y: 1, z: 0 }
      } : undefined;
    }
  } as unknown as PhysicsContraption;
  return contraption;
}

function createSlopedContraption(
  translation: Vector3,
  angle: number,
  supportEnabled: { readonly value: boolean },
  validity: { readonly value: boolean },
  queries: MountQueryCounts,
  sleeping: { readonly value: boolean }
): PhysicsContraption {
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const block = {
    localLocation: { x: 0, y: 0, z: 0 },
    typeId: "minecraft:oak_log"
  };
  const localPointToWorld = (location: Vector3): Vector3 => ({
    x: translation.x + location.x * cosine - location.y * sine,
    y: translation.y + location.x * sine + location.y * cosine,
    z: translation.z + location.z
  });
  const worldPointToLocal = (location: Vector3): Vector3 => {
    const x = location.x - translation.x;
    const y = location.y - translation.y;
    return {
      x: x * cosine + y * sine,
      y: -x * sine + y * cosine,
      z: location.z - translation.z
    };
  };
  const normal = { x: -sine, y: cosine, z: 0 };
  const planePoint = localPointToWorld({ x: 0, y: 0.5, z: 0 });
  return {
    body: {
      get isSleeping() { return sleeping.value; },
      getAabb: () => ({
        min: { x: translation.x - 2, y: translation.y - 2, z: translation.z - 2 },
        max: { x: translation.x + 2, y: translation.y + 2, z: translation.z + 2 }
      }),
      localPointToWorld,
      worldPointToLocal
    },
    id: 1,
    get isValid() { return validity.value; },
    getBlocksInLocalBounds: () => {
      queries.localBoundsQueries++;
      return supportEnabled.value ? [block] : [];
    },
    raycast: (origin: Vector3) => {
      queries.raycasts++;
      if (!supportEnabled.value) return undefined;
      const distance = (
        (planePoint.x - origin.x) * normal.x
        + (planePoint.y - origin.y) * normal.y
      ) / -normal.y;
      const location = { x: origin.x, y: origin.y - distance, z: origin.z };
      return {
        block,
        distance,
        face: "up",
        localLocation: worldPointToLocal(location),
        localNormal: { x: 0, y: 1, z: 0 },
        location,
        normal
      };
    }
  } as unknown as PhysicsContraption;
}

function createQueryCounts(): MountQueryCounts {
  return {
    candidateQueries: 0,
    localBoundsQueries: 0,
    raycasts: 0
  };
}

function resetQueryCounts(counts: MountQueryCounts): void {
  counts.candidateQueries = 0;
  counts.localBoundsQueries = 0;
  counts.raycasts = 0;
}
