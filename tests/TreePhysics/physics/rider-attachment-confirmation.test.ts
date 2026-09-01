import { system, type Entity, type Vector3 } from "@minecraft/server";
import { afterEach, describe, expect, it } from "vitest";
import { BlockRenderer } from "@src/render/contraption/block/BlockRenderer";
import { FragmentRenderer } from "@src/render/contraption/fragment/FragmentRenderer";
import { packFragments } from "@src/render/contraption/fragment/FragmentLayout";
import { DEFAULT_CONTRAPTION_FOLIAGE_TINT } from "@src/render/foliage/TintCodec";

const originalRun = system.run;
const originalCurrentTick = system.currentTick;

afterEach(() => {
  system.run = originalRun;
  system.currentTick = originalCurrentTick;
});

describe("contraption rider attachment confirmation", () => {
  it("retries a visual rider relationship dropped after a successful add", () => {
    const callbacks: Array<() => void> = [];
    system.run = callback => callbacks.push(callback);
    system.currentTick = 50;
    const carrier = new FakeCarrier("carrier", 2);
    const fragment = new FakeRider("fragment");
    let spawnIndex = 0;
    const renderer = new FragmentRenderer(
      {
        getRotation: () => ({ x: 0, y: 0, z: 0 }),
        isValid: true,
        localPointToWorld: (location: Vector3) => ({ ...location })
      },
      packFragments([{
        collisionShape: "full",
        localLocation: { x: 0, y: 0, z: 0 },
        typeId: "minecraft:chest",
        visual: { renderer: "cube_block_fragment", state: 0 }
      }])!,
      () => spawnIndex++ === 0 ? carrier.value : fragment.value,
      DEFAULT_CONTRAPTION_FOLIAGE_TINT,
      undefined,
      { x: 0, y: 0, z: 0 },
      undefined
    );

    expect(renderer.hasIntactEntities()).toBe(true);
    system.currentTick++;
    callbacks.shift()!();
    expect(carrier.addRiderCount).toBe(2);
    expect(renderer.hasIntactEntities()).toBe(true);

    system.currentTick++;
    callbacks.shift()!();
    expect(callbacks).toHaveLength(0);
    expect(renderer.hasIntactEntities()).toBe(true);
    expect(renderer.hasKnownIntegrityFailure()).toBe(false);
  });

  it("keeps a delayed native rider relationship pending", () => {
    const callbacks: Array<() => void> = [];
    system.run = callback => callbacks.push(callback);
    system.currentTick = 100;
    const carrier = new FakeCarrier("carrier");
    const rider = new FakeRider("storage");
    const renderer = createRenderer(carrier);

    expect(renderer.attachPersistentRider(rider.value)).toBe(true);
    system.currentTick++;
    expect(() => callbacks.shift()!()).not.toThrow();
    expect(callbacks).toHaveLength(1);
    expect(carrier.addRiderCount).toBe(2);
    expect(renderer.hasKnownIntegrityFailure()).toBe(false);

    carrier.riders.push(rider.value);
    system.currentTick++;
    expect(() => callbacks.shift()!()).not.toThrow();
    expect(callbacks).toHaveLength(0);
    expect(renderer.hasKnownIntegrityFailure()).toBe(false);
  });

  it("reports a native rider relationship that misses the timeout", () => {
    const callbacks: Array<() => void> = [];
    system.run = callback => callbacks.push(callback);
    system.currentTick = 200;
    const carrier = new FakeCarrier("carrier");
    const rider = new FakeRider("storage");
    const renderer = createRenderer(carrier);

    expect(renderer.attachPersistentRider(rider.value)).toBe(true);
    system.currentTick += 20;
    expect(() => callbacks.shift()!()).toThrow(
      "Persistent contraption entity storage did not attach to carrier carrier within 20 ticks; current vehicle=none."
    );
    expect(renderer.hasKnownIntegrityFailure()).toBe(true);
  });
});

function createRenderer(carrier: FakeCarrier): BlockRenderer {
  return new BlockRenderer(
    {
      getRotation: () => ({ x: 0, y: 0, z: 0 }),
      isValid: true,
      localPointToWorld: (location: Vector3) => ({ ...location })
    },
    [],
    [],
    undefined,
    { x: 0, y: 0, z: 0 },
    () => carrier.value
  );
}

class FakeCarrier {
  readonly riders: Entity[] = [];
  readonly value: Entity;
  addRiderCount = 0;

  constructor(id: string, attachAfterCount = Number.POSITIVE_INFINITY) {
    const riders = this.riders;
    const owner = this;
    this.value = {
      getComponent: (componentId: string) => componentId === "minecraft:rideable"
        ? {
          addRider: (rider: Entity) => {
            owner.addRiderCount++;
            if (
              owner.addRiderCount >= attachAfterCount
              && !riders.some(value => value.id === rider.id)
            ) riders.push(rider);
            return true;
          },
          getRiders: () => [...riders]
        }
        : undefined,
      id,
      isValid: true
    } as unknown as Entity;
  }
}

class FakeRider {
  readonly value: Entity;

  constructor(id: string) {
    this.value = {
      getComponent: () => undefined,
      id,
      isValid: true,
      setProperty: () => undefined
    } as unknown as Entity;
  }
}
