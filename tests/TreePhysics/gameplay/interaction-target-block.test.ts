import { describe, expect, it } from "vitest";
import {
  BlockPermutation,
  GameMode,
  InputMode,
  type Dimension,
  type Player,
  type Vector3
} from "@minecraft/server";
import type {
  PhysicsContraption,
  PhysicsContraptionBlock,
  PhysicsDimension,
  PhysicsWorld
} from "@src/Physics";
import { ContraptionOutlineController } from "@src/content/contraption/interaction/OutlineController";
import { INTERACTION_TARGET_BLOCK_TYPE_ID } from "@src/content/contraption/interaction/TargetBlock";
import type { ActivePlayerRegistry } from "@src/service/ActivePlayerRegistry";

class FakeBlock {
  isWaterlogged = false;
  permutation: ReturnType<typeof BlockPermutation.resolve>;

  constructor(
    readonly location: Vector3,
    public typeId: string
  ) {
    this.permutation = BlockPermutation.resolve(typeId);
  }

  get isAir(): boolean {
    return this.typeId === "minecraft:air";
  }

  setPermutation(permutation: ReturnType<typeof BlockPermutation.resolve>): void {
    this.permutation = permutation;
    this.typeId = permutation.type.id;
    this.isWaterlogged = false;
  }

  setWaterlogged(waterlogged: boolean): void {
    this.isWaterlogged = waterlogged;
  }
}

class FakeDimension {
  readonly blocks = new Map<string, FakeBlock>();

  constructor(readonly id: string) {}

  add(block: FakeBlock): void {
    this.blocks.set(locationKey(block.location), block);
  }

  getBlock(location: Vector3): FakeBlock | undefined {
    return this.blocks.get(locationKey(location));
  }
}

describe("contraption interaction target suppression", () => {
  it("restores and suppresses the proxy for a standing keyboard container target", () => {
    const dimension = new FakeDimension("minecraft:overworld");
    const proxy = new FakeBlock({ x: 2, y: 0, z: 0 }, "minecraft:air");
    dimension.add(proxy);
    const block = {
      localLocation: { x: 0, y: 0, z: 0 },
      typeId: "minecraft:chest"
    } as PhysicsContraptionBlock;
    const contraption = {
      body: { isActive: false },
      id: 1,
      isValid: true,
      raycast: () => ({
        block,
        distance: 2,
        face: "west",
        localLocation: { x: 0, y: 0.5, z: 0.5 },
        localNormal: { x: -1, y: 0, z: 0 },
        location: { x: 2.5, y: 0.5, z: 0.5 }
      })
    } as unknown as PhysicsContraption;
    const physicsDimension = {
      contraptionRaycastRevision: 0,
      getContraptionRaycastCandidates: () => [contraption],
      hasAssemblies: () => true
    } as unknown as PhysicsDimension;
    const physicsWorld = {
      getExistingDimension: () => physicsDimension
    } as unknown as PhysicsWorld;
    const player = {
      dimension: dimension as unknown as Dimension,
      getBlockFromViewDirection: () => undefined,
      getGameMode: () => GameMode.Survival,
      getHeadLocation: () => ({ x: 0.5, y: 0.5, z: 0.5 }),
      getViewDirection: () => ({ x: 1, y: 0, z: 0 }),
      id: "player",
      inputInfo: { lastInputModeUsed: InputMode.KeyboardAndMouse },
      isSneaking: false,
      isValid: true
    } as unknown as Player;
    const players = {
      get: () => player,
      hasSneakingPlayer: () => false,
      players: function* () { yield player; },
      sneakingPlayers: function* () {}
    } as unknown as ActivePlayerRegistry;
    const controller = new ContraptionOutlineController(physicsWorld, players);
    controller.start();
    controller.captureActionTarget(player);
    controller.tick(0);

    expect(proxy.typeId).toBe(INTERACTION_TARGET_BLOCK_TYPE_ID);

    controller.setInteractionTargetSuppressor(
      (_contraption, target) => target.typeId === "minecraft:chest"
    );
    controller.tick(1);

    expect(proxy.typeId).toBe("minecraft:air");

    controller.tick(2);

    expect(proxy.typeId).toBe("minecraft:air");
  });
});

function locationKey(location: Vector3): string {
  return `${location.x},${location.y},${location.z}`;
}
