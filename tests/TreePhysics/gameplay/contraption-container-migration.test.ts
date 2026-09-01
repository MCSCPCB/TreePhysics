import { system, type Entity, type Vector3 } from "@minecraft/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PhysicsContraption } from "@src/Physics";
import {
  CHEST_ENTITY_TYPE_ID,
  ContraptionContainerInteractionController
} from "@src/content/contraption/interaction/ContainerInteraction";

const originalRun = system.run;
const originalCurrentTick = system.currentTick;

afterEach(() => {
  system.run = originalRun;
  system.currentTick = originalCurrentTick;
});

describe("contraption chest migration", () => {
  it("waits for the source riding relationship before attaching to the child", () => {
    const callbacks: Array<() => void> = [];
    system.run = callback => callbacks.push(callback);
    system.currentTick = 100;
    const storage = new FakeStorageEntity();
    const source = new FakeContraption(1, storage);
    const child = new FakeContraption(2, storage);
    const controller = new ContraptionContainerInteractionController();
    const binding = controller.createStorage("parent", source.value, { x: 0, y: 0, z: 0 });

    controller.replaceContraptionStorages("parent", source.value, [{
      bindings: [binding],
      contraption: child.value,
      ownerId: "child"
    }]);

    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    expect(child.attachCount).toBe(0);
    expect(callbacks).toHaveLength(1);

    storage.ridingOn = undefined;
    system.currentTick++;
    callbacks.shift()!();
    expect(child.attachCount).toBe(1);
    expect(storage.ridingOn).toBe(child.carrier);
  });

  it("reports a source relationship that never detaches", () => {
    const callbacks: Array<() => void> = [];
    system.run = callback => callbacks.push(callback);
    system.currentTick = 200;
    const storage = new FakeStorageEntity();
    const source = new FakeContraption(11, storage);
    const child = new FakeContraption(12, storage);
    const controller = new ContraptionContainerInteractionController();
    const binding = controller.createStorage("parent", source.value, { x: 0, y: 0, z: 0 });

    controller.replaceContraptionStorages("parent", source.value, [{
      bindings: [binding],
      contraption: child.value,
      ownerId: "child"
    }]);
    system.currentTick += 20;

    expect(() => callbacks.shift()!()).toThrow(
      `Storage ${storage.id} did not detach from carrier ${source.carrier.id} before attaching to contraption 12.`
    );
    expect(child.attachCount).toBe(0);
  });
});

class FakeStorageEntity {
  readonly dimension = { id: "minecraft:overworld" };
  readonly id = "storage_entity";
  readonly properties = new Map<string, unknown>();
  readonly typeId = CHEST_ENTITY_TYPE_ID;
  isValid = true;
  nameTag = "";
  ridingOn: FakeCarrier | undefined;

  getComponent(id: string): unknown {
    if (id === "minecraft:inventory") return { container: { size: 27 } };
    if (id === "minecraft:riding" && this.ridingOn) {
      return { entityRidingOn: this.ridingOn };
    }
    return undefined;
  }

  setDynamicProperty(id: string, value: unknown): void {
    this.properties.set(id, value);
  }

  teleport(_location: Vector3): void {}
  triggerEvent(_eventId: string): void {}
}

interface FakeCarrier {
  readonly id: string;
  readonly isValid: boolean;
}

class FakeContraption {
  readonly carrier: FakeCarrier;
  readonly value: PhysicsContraption;
  attachCount = 0;

  constructor(id: number, storage: FakeStorageEntity) {
    this.carrier = { id: `carrier_${id}`, isValid: true };
    const dimension = {
      id: "minecraft:overworld",
      dimension: {
        id: "minecraft:overworld",
        spawnEntity: () => storage
      }
    };
    this.value = {
      attachPersistentEntity: (entity: Entity) => {
        this.attachCount++;
        (entity as unknown as FakeStorageEntity).ridingOn = this.carrier;
        return true;
      },
      body: {
        dimension,
        localPointToWorld: (location: Vector3) => ({ ...location })
      },
      detachPersistentEntity: () => undefined,
      id,
      isValid: true,
      setCubeBlockOpenState: () => true
    } as unknown as PhysicsContraption;
  }
}
