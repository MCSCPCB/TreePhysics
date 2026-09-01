import type { Vector3 } from "@minecraft/server";
import { blockKey } from "@src/utils/BlockKey";
import {
  createDefaultContraptionBuoyancyPoints,
  createDefaultContraptionCollider
} from "@src/Physics";
import { ContraptionColliderIndex } from "@src/physics/contraption/ColliderIndex";
import type {
  PhysicsContraptionBlock,
  PhysicsContraptionRuntimeRepresentation,
  PhysicsContraptionRuntimeRepresentationFactory,
  PhysicsContraptionRuntimeRepresentationState
} from "@src/physics/core/Types";
import type { TreeLeafPhysicsPlan } from "@src/content/tree/foliage/PhysicsQuality";

export function createTreeLeafPhysicsRuntimeRepresentation(
  plan: TreeLeafPhysicsPlan
): PhysicsContraptionRuntimeRepresentationFactory {
  const leafIndexByKey = new Map(plan.leaves.map((leaf, index) => [leaf.key, index]));

  const factory: PhysicsContraptionRuntimeRepresentationFactory = blocks => {
    const remainingLeafIndices = new Uint8Array(plan.leaves.length);
    const nonLeafBlocks: PhysicsContraptionBlock[] = [];
    for (const block of blocks) {
      const index = block.runtimeCollidable === false
        ? leafIndexByKey.get(blockKey(block.localLocation))
        : undefined;
      if (index !== undefined) remainingLeafIndices[index] = 1;
      else if (block.runtimeCollidable !== false) nonLeafBlocks.push(block);
    }

    const baseCollider = createDefaultContraptionCollider(nonLeafBlocks);
    const buoyancyPoints = createDefaultContraptionBuoyancyPoints(nonLeafBlocks);
    for (const point of plan.buoyancyPoints) {
      let volume = 0;
      const center = { x: 0, y: 0, z: 0 };
      for (const index of point.leafIndices) {
        if (!remainingLeafIndices[index]) continue;
        const leaf = plan.leaves[index]!;
        volume += leaf.buoyancyVolume;
        center.x += leaf.localLocation.x * leaf.buoyancyVolume;
        center.y += leaf.localLocation.y * leaf.buoyancyVolume;
        center.z += leaf.localLocation.z * leaf.buoyancyVolume;
      }
      if (volume <= 0) continue;
      buoyancyPoints.push({
        localLocation: {
          x: center.x / volume,
          y: center.y / volume,
          z: center.z / volume
        },
        volume
      });
    }

    return {
      buoyancyPoints,
      collider: baseCollider
    };
  };
  factory.createIncrementalState = blocks => new TreeLeafRuntimeRepresentationState(
    plan,
    leafIndexByKey,
    blocks
  );
  return factory;
}
interface LeafBuoyancyAccumulator {
  count: number;
  momentX: number;
  momentY: number;
  momentZ: number;
  volume: number;
}

class TreeLeafRuntimeRepresentationState implements PhysicsContraptionRuntimeRepresentationState {
  readonly #colliderIndex: ContraptionColliderIndex;
  readonly #leafGroups: LeafBuoyancyAccumulator[];
  readonly #leafGroupIndicesByLeaf: readonly number[][];
  readonly #leafIndexByKey: ReadonlyMap<string, number>;
  readonly #nonLeafBuoyancyPoints = new Map<string, {
    readonly localLocation: Vector3;
    readonly volume: number;
  }>();
  readonly #plan: TreeLeafPhysicsPlan;
  readonly #remainingLeafIndices: Uint8Array;

  constructor(
    plan: TreeLeafPhysicsPlan,
    leafIndexByKey: ReadonlyMap<string, number>,
    blocks: readonly PhysicsContraptionBlock[]
  ) {
    this.#plan = plan;
    this.#leafIndexByKey = leafIndexByKey;
    this.#remainingLeafIndices = new Uint8Array(plan.leaves.length);
    this.#leafGroups = plan.buoyancyPoints.map(() => ({
      count: 0,
      momentX: 0,
      momentY: 0,
      momentZ: 0,
      volume: 0
    }));
    const groupIndicesByLeaf = Array.from(
      { length: plan.leaves.length },
      () => [] as number[]
    );
    for (let groupIndex = 0; groupIndex < plan.buoyancyPoints.length; groupIndex++) {
      for (const leafIndex of plan.buoyancyPoints[groupIndex]!.leafIndices) {
        groupIndicesByLeaf[leafIndex]!.push(groupIndex);
      }
    }
    this.#leafGroupIndicesByLeaf = groupIndicesByLeaf;

    const nonLeafBlocks: PhysicsContraptionBlock[] = [];
    for (const block of blocks) {
      const leafIndex = block.runtimeCollidable === false
        ? leafIndexByKey.get(blockKey(block.localLocation))
        : undefined;
      if (leafIndex !== undefined) {
        if (this.#remainingLeafIndices[leafIndex]) continue;
        this.#remainingLeafIndices[leafIndex] = 1;
        this.addLeafToGroups(leafIndex);
      } else if (block.runtimeCollidable !== false) {
        nonLeafBlocks.push(block);
      }
    }
    this.#colliderIndex = new ContraptionColliderIndex(nonLeafBlocks);
    for (const point of createDefaultContraptionBuoyancyPoints(nonLeafBlocks)) {
      this.#nonLeafBuoyancyPoints.set(blockKey(point.localLocation), point);
    }
  }

  get representation(): PhysicsContraptionRuntimeRepresentation {
    const buoyancyPoints = [...this.#nonLeafBuoyancyPoints.values()];
    for (const group of this.#leafGroups) {
      if (group.count === 0) continue;
      buoyancyPoints.push({
        localLocation: {
          x: group.momentX / group.volume,
          y: group.momentY / group.volume,
          z: group.momentZ / group.volume
        },
        volume: group.volume
      });
    }
    return { buoyancyPoints, collider: this.#colliderIndex.collider };
  }

  addBlocks(blocks: readonly PhysicsContraptionBlock[]): PhysicsContraptionRuntimeRepresentation {
    const addedColliderBlocks: PhysicsContraptionBlock[] = [];
    for (const block of blocks) {
      const key = blockKey(block.localLocation);
      const leafIndex = block.runtimeCollidable === false
        ? this.#leafIndexByKey.get(key)
        : undefined;
      if (leafIndex !== undefined) {
        if (!this.#remainingLeafIndices[leafIndex]) {
          this.#remainingLeafIndices[leafIndex] = 1;
          this.addLeafToGroups(leafIndex);
        }
        continue;
      }
      if (block.runtimeCollidable === false) continue;
      addedColliderBlocks.push(block);
      this.#nonLeafBuoyancyPoints.set(key, {
        localLocation: { ...block.localLocation },
        volume: block.buoyancyVolume ?? 0.25
      });
    }
    this.#colliderIndex.addBlocks(addedColliderBlocks);
    return this.representation;
  }

  removeBlocks(blocks: readonly PhysicsContraptionBlock[]): PhysicsContraptionRuntimeRepresentation {
    const removedColliderBlocks: PhysicsContraptionBlock[] = [];
    for (const block of blocks) {
      const key = blockKey(block.localLocation);
      const leafIndex = block.runtimeCollidable === false
        ? this.#leafIndexByKey.get(key)
        : undefined;
      if (leafIndex !== undefined) {
        if (!this.#remainingLeafIndices[leafIndex]) continue;
        this.#remainingLeafIndices[leafIndex] = 0;
        this.removeLeafFromGroups(leafIndex);
      } else if (block.runtimeCollidable !== false) {
        removedColliderBlocks.push(block);
        this.#nonLeafBuoyancyPoints.delete(key);
      }
    }
    this.#colliderIndex.removeBlocks(removedColliderBlocks);
    return this.representation;
  }

  private addLeafToGroups(leafIndex: number): void {
    const leaf = this.#plan.leaves[leafIndex]!;
    for (const groupIndex of this.#leafGroupIndicesByLeaf[leafIndex]!) {
      const group = this.#leafGroups[groupIndex]!;
      group.count++;
      group.volume += leaf.buoyancyVolume;
      group.momentX += leaf.localLocation.x * leaf.buoyancyVolume;
      group.momentY += leaf.localLocation.y * leaf.buoyancyVolume;
      group.momentZ += leaf.localLocation.z * leaf.buoyancyVolume;
    }
  }

  private removeLeafFromGroups(leafIndex: number): void {
    const leaf = this.#plan.leaves[leafIndex]!;
    for (const groupIndex of this.#leafGroupIndicesByLeaf[leafIndex]!) {
      const group = this.#leafGroups[groupIndex]!;
      group.count--;
      if (group.count === 0) {
        group.volume = 0;
        group.momentX = 0;
        group.momentY = 0;
        group.momentZ = 0;
        continue;
      }
      group.volume -= leaf.buoyancyVolume;
      group.momentX -= leaf.localLocation.x * leaf.buoyancyVolume;
      group.momentY -= leaf.localLocation.y * leaf.buoyancyVolume;
      group.momentZ -= leaf.localLocation.z * leaf.buoyancyVolume;
    }
  }
}
