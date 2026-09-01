import { system, type Player, type Vector3 } from "@minecraft/server";
import { afterEach, describe, expect, it } from "vitest";
import { testEvents } from "../mocks/minecraft-server";
import type { PhysicsAssembly, PhysicsAssemblyBlock } from "@src/Physics";
import {
  AssemblyContainerInteractionController,
  CHEST_STORAGE_ENTITY_TYPE_ID
} from "@src/content/contraption/interaction/AssemblyContainerInteraction";

const ACTIVE_EVENT = "tree_physics:activate";
const INACTIVE_EVENT = "tree_physics:deactivate";

describe("physical chest storage entities", () => {
  afterEach(() => testEvents.resetContainerEvents());

  it("accepts only chests rendered by the fragment protocol", () => {
    const controller = new AssemblyContainerInteractionController();
    const assembly = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);
    const unsupported = {
      ...assembly.chest(),
      visual: undefined
    };

    expect(controller.canInteract(assembly.value, assembly.chest())).toBe(true);
    expect(controller.canInteract(assembly.value, unsupported)).toBe(false);
  });

  it("parks a created storage on the assembly collector until it is previewed", () => {
    const controller = new AssemblyContainerInteractionController();
    const assembly = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);

    const binding = controller.createStorage("tree", assembly.value, { x: 0, y: 0, z: 0 });
    const entity = assembly.spawnedEntities[0]!;
    expect(binding.storageId).toBe(entity.id);
    expect(assembly.attachedEntityIds.has(entity.id)).toBe(true);

    controller.syncTarget(player("a"), assembly.value, assembly.chest());
    expect(assembly.attachedEntityIds.has(entity.id)).toBe(false);
    expect(entity.triggeredEvents).toContain(ACTIVE_EVENT);
    expect(entity.teleports.at(-1)).toEqual({ x: 0, y: -0.4375, z: 0 });
    expect(controller.interact(player("a"), assembly.value, assembly.chest())).toBe(true);

    controller.syncTarget(player("a"), undefined, undefined);
    expect(entity.triggeredEvents).toContain(INACTIVE_EVENT);
    expect(assembly.attachedEntityIds.has(entity.id)).toBe(true);
  });

  it("activates the storage for a click that outruns the per-tick preview sync", () => {
    const controller = new AssemblyContainerInteractionController();
    const assembly = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);
    controller.createStorage("tree", assembly.value, { x: 0, y: 0, z: 0 });
    const entity = assembly.spawnedEntities[0]!;

    // The gesture must be consumed on the very first click, or it would fall
    // through to the drag handler and grab the tree instead.
    expect(controller.interact(player("a"), assembly.value, assembly.chest())).toBe(true);
    expect(entity.triggeredEvents).toContain(ACTIVE_EVENT);

    // The click registered the player as a previewer, so looking away releases it.
    controller.syncTarget(player("a"), undefined, undefined);
    expect(entity.triggeredEvents).toContain(INACTIVE_EVENT);
    expect(assembly.attachedEntityIds.has(entity.id)).toBe(true);
  });

  it("keeps one chest open until its last native viewer closes", () => {
    const controller = new AssemblyContainerInteractionController();
    controller.start();
    const assembly = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);
    controller.createStorage("tree", assembly.value, { x: 0, y: 0, z: 0 });
    const entity = assembly.spawnedEntities[0]!;
    controller.syncTarget(player("a"), assembly.value, assembly.chest());

    testEvents.entityContainerOpened(containerEvent(entity, player("a")));
    testEvents.entityContainerOpened(containerEvent(entity, player("b")));
    expect(assembly.openWrites).toEqual([true]);

    testEvents.entityContainerClosed(containerEvent(entity, player("a")));
    expect(assembly.openWrites).toEqual([true]);
    testEvents.entityContainerClosed(containerEvent(entity, player("b")));
    expect(assembly.openWrites).toEqual([true, false]);
    // The previewing player is still targeting the chest, so it stays active.
    expect(controller.interact(player("a"), assembly.value, assembly.chest())).toBe(true);
  });

  it("cancels native interaction with an inactive storage without a global error", () => {
    const controller = new AssemblyContainerInteractionController();
    controller.start();
    const assembly = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);
    controller.createStorage("tree", assembly.value, { x: 0, y: 0, z: 0 });
    const entity = assembly.spawnedEntities[0]!;

    const blocked = { cancel: false, target: entity };
    expect(() => testEvents.playerInteractWithEntity(blocked)).not.toThrow();
    expect(blocked.cancel).toBe(true);

    controller.syncTarget(player("a"), assembly.value, assembly.chest());
    const allowed = { cancel: false, target: entity };
    testEvents.playerInteractWithEntity(allowed);
    expect(allowed.cancel).toBe(false);
  });

  it("rejects a truly unbound storage entity loudly", () => {
    const controller = new AssemblyContainerInteractionController();
    controller.start();
    const orphan = new FakeStorageEntity();

    const event = { cancel: false, target: orphan };
    // The mock system.run executes synchronously, so the deferred error surfaces here.
    expect(() => testEvents.playerInteractWithEntity(event)).toThrow(/Unbound chest storage/);
    expect(event.cancel).toBe(true);
  });

  it("transfers a live storage to the split child that keeps the chest", () => {
    const controller = new AssemblyContainerInteractionController();
    controller.start();
    const source = new FakeAssembly(1, [{ x: 3, y: 2, z: 1 }]);
    const child = new FakeAssembly(2, [{ x: 3, y: 2, z: 1 }]);
    const binding = controller.createStorage("parent", source.value, { x: 3, y: 2, z: 1 });
    const entity = source.spawnedEntities[0]!;
    controller.syncTarget(player("a"), source.value, source.chest());
    testEvents.entityContainerOpened(containerEvent(entity, player("a")));
    expect(source.openWrites).toEqual([true]);

    controller.replaceAssemblyStorages("parent", source.value, [{
      assembly: child.value,
      bindings: [{ localLocation: { x: 3, y: 2, z: 1 }, storageId: binding.storageId }],
      ownerId: "child"
    }]);

    // The open lid follows the storage onto the replacement assembly.
    expect(child.openWrites).toEqual([true]);
    expect(entity.properties.get("tree_physics:storage_owner")).toBe("child");
    expect(controller.interact(player("a"), child.value, child.chest())).toBe(true);
  });

  it("defers an inactive storage attachment until the replacement assembly is stable", () => {
    const originalRun = system.run;
    const callbacks: Array<() => void> = [];
    system.run = callback => {
      callbacks.push(callback);
    };
    try {
      const controller = new AssemblyContainerInteractionController();
      const source = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);
      const child = new FakeAssembly(2, [{ x: 0, y: 0, z: 0 }]);
      const binding = controller.createStorage("parent", source.value, { x: 0, y: 0, z: 0 });
      const entity = source.spawnedEntities[0]!;

      controller.replaceAssemblyStorages("parent", source.value, [{
        assembly: child.value,
        bindings: [{ localLocation: { x: 0, y: 0, z: 0 }, storageId: binding.storageId }],
        ownerId: "child"
      }]);

      // The old collector is detached immediately, but the new native rider
      // relationship must wait until the caller has removed the source assembly.
      expect(source.attachedEntityIds.has(entity.id)).toBe(false);
      expect(child.attachedEntityIds.has(entity.id)).toBe(false);
      source.isValid = false;
      expect(callbacks).toHaveLength(1);
      callbacks.shift()!();
      expect(child.attachedEntityIds.has(entity.id)).toBe(true);
    } finally {
      system.run = originalRun;
    }
  });

  it("settles storage inventory through a native kill", () => {
    const controller = new AssemblyContainerInteractionController();
    const assembly = new FakeAssembly(1, [{ x: 0, y: 0, z: 0 }]);
    const binding = controller.createStorage("tree", assembly.value, { x: 0, y: 0, z: 0 });
    const entity = assembly.spawnedEntities[0]!;

    controller.settleStorages(
      "tree",
      [binding],
      assembly.value.body.dimension.dimension as never,
      localLocation => ({ x: localLocation.x, y: localLocation.y + 10, z: localLocation.z })
    );

    expect(entity.killed).toBe(true);
    expect(entity.triggeredEvents).toContain(ACTIVE_EVENT);
    // The record is gone, so the same binding cannot settle twice.
    expect(() => controller.settleStorages(
      "tree",
      [binding],
      assembly.value.body.dimension.dimension as never,
      localLocation => localLocation
    )).toThrow(/not registered/);
  });
});

class FakeStorageEntity {
  static nextId = 1;
  readonly id = `storage_entity_${FakeStorageEntity.nextId++}`;
  readonly typeId = CHEST_STORAGE_ENTITY_TYPE_ID;
  readonly dimension = { id: "minecraft:overworld" };
  readonly properties = new Map<string, unknown>();
  readonly teleports: Vector3[] = [];
  readonly triggeredEvents: string[] = [];
  isValid = true;
  killed = false;
  nameTag = "";

  getComponent(id: string): unknown {
    return id === "minecraft:inventory" ? { container: { size: 27 } } : undefined;
  }

  getDynamicProperty(id: string): unknown {
    return this.properties.get(id);
  }

  setDynamicProperty(id: string, value: unknown): void {
    this.properties.set(id, value);
  }

  teleport(location: Vector3): void {
    this.teleports.push({ ...location });
  }

  triggerEvent(event: string): void {
    this.triggeredEvents.push(event);
  }

  kill(): boolean {
    this.killed = true;
    this.isValid = false;
    return true;
  }

  remove(): void {
    this.isValid = false;
  }
}

class FakeAssembly {
  readonly attachedEntityIds = new Set<string>();
  readonly blocks = new Map<string, PhysicsAssemblyBlock>();
  readonly openWrites: boolean[] = [];
  readonly spawnedEntities: FakeStorageEntity[] = [];
  readonly value: PhysicsAssembly;
  isValid = true;

  constructor(readonly id: number, locations: readonly Vector3[]) {
    for (const localLocation of locations) {
      this.blocks.set(key(localLocation), {
        localLocation: { ...localLocation },
        typeId: "minecraft:chest",
        visual: { family: 0, renderer: "cube_block_fragment", state: 0 }
      });
    }
    const owner = this;
    const dimension = {
      id: "minecraft:overworld",
      playSound: () => undefined,
      spawnEntity: (_typeId: string, location: Vector3) => {
        const entity = new FakeStorageEntity();
        entity.teleports.push({ ...location });
        owner.spawnedEntities.push(entity);
        return entity;
      }
    };
    // The controller compares assembly references, so expose one stable value.
    this.value = {
      get id() { return owner.id; },
      get isValid() { return owner.isValid; },
      attachPersistentEntity: (entity: FakeStorageEntity) => {
        owner.attachedEntityIds.add(entity.id);
        return true;
      },
      detachPersistentEntity: (entity: FakeStorageEntity) => {
        owner.attachedEntityIds.delete(entity.id);
      },
      removeEmptyPersistentEntityCollectors: () => undefined,
      getBlockAtLocalLocation: (location: Vector3) => owner.blocks.get(key(location)),
      setCubeBlockOpenState: (_location: Vector3, open: boolean) => {
        owner.openWrites.push(open);
        return true;
      },
      body: {
        dimension: { id: "minecraft:overworld", dimension },
        localPointToWorld: (location: Vector3) => ({ ...location })
      }
    } as unknown as PhysicsAssembly;
  }

  chest(): PhysicsAssemblyBlock {
    return this.blocks.values().next().value!;
  }
}

function containerEvent(entity: FakeStorageEntity, source: Player): {
  readonly closeSource: { entity: Player };
  readonly entity: FakeStorageEntity;
  readonly openSource: { entity: Player };
} {
  return {
    closeSource: { entity: source },
    entity,
    openSource: { entity: source }
  };
}

function player(id: string): Player {
  return { id, isValid: true, typeId: "minecraft:player" } as unknown as Player;
}

function key(location: Vector3): string {
  return `${location.x},${location.y},${location.z}`;
}
