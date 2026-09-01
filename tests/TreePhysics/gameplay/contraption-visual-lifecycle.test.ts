import type { Entity } from "@minecraft/server";
import { describe, expect, it, vi } from "vitest";
import type { PhysicsContraption } from "@src/Physics";
import type { CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import { ContraptionLifecycle } from "@src/content/tree/contraption/Lifecycle";
import {
  DynamicPropertyJsonStore,
  type DynamicPropertyTarget
} from "@src/storage/DynamicPropertyJsonStore";

describe("contraption visual lifecycle", () => {
  it("claims a visual carrier created after contraption registration", () => {
    const visualEntityIds = new Set(["initial_visual"]);
    const contraption = createContraption(visualEntityIds);
    const lifecycle = new ContraptionLifecycle({
      store: new DynamicPropertyJsonStore("visual_lifecycle", 30_000, new MemoryTarget())
    });
    lifecycle.register(contraption, [LOG_SNAPSHOT], { x: 0, y: 0, z: 0 }, {
      deferPersistence: true,
      persistenceId: "tree",
      sleepTimeoutTicks: 60
    });

    visualEntityIds.add("storage_carrier");
    const carrier = createVisualEntity("storage_carrier");
    lifecycle.handleVisualEntityLoad(carrier.entity);

    expect(carrier.remove).not.toHaveBeenCalled();
  });

  it("removes a visual carrier that no live contraption owns", () => {
    const lifecycle = new ContraptionLifecycle();
    const carrier = createVisualEntity("orphan_carrier");

    lifecycle.handleVisualEntityLoad(carrier.entity);

    expect(carrier.remove).toHaveBeenCalledOnce();
  });
});

const LOG_SNAPSHOT: CapturedTreeBlock = {
  kind: "log",
  location: { x: 0, y: 0, z: 0 },
  states: { pillar_axis: "y" },
  typeId: "minecraft:oak_log"
};

class MemoryTarget implements DynamicPropertyTarget {
  readonly values = new Map<string, boolean | number | string | object>();

  getDynamicProperty(identifier: string): boolean | number | string | object | undefined {
    return this.values.get(identifier);
  }

  setDynamicProperty(identifier: string, value?: boolean | number | string | object): void {
    if (value === undefined) this.values.delete(identifier);
    else this.values.set(identifier, value);
  }
}

function createContraption(visualEntityIds: ReadonlySet<string>): PhysicsContraption {
  const dimension = {
    id: "minecraft:overworld",
    dimension: { id: "minecraft:overworld" }
  };
  const body = {
    angularVelocity: { x: 0, y: 0, z: 0 },
    dimension,
    getAabb: () => ({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    }),
    getRotation: () => ({ x: 0, y: 0, z: 0 }),
    isSleeping: true,
    location: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 }
  };
  return {
    blocks: [{
      collidable: true,
      localLocation: { x: 0, y: 0, z: 0 },
      mass: 1,
      typeId: "minecraft:oak_log"
    }],
    body,
    foliageTint: undefined,
    hasVisualEntity: (entityId: string) => visualEntityIds.has(entityId),
    id: 1,
    isValid: true,
    get visualEntityIds() { return [...visualEntityIds]; }
  } as unknown as PhysicsContraption;
}

function createVisualEntity(id: string): {
  readonly entity: Entity;
  readonly remove: ReturnType<typeof vi.fn>;
} {
  const remove = vi.fn();
  return {
    entity: {
      id,
      isValid: true,
      remove,
      typeId: "treephysics:fragment_carrier"
    } as unknown as Entity,
    remove
  };
}
