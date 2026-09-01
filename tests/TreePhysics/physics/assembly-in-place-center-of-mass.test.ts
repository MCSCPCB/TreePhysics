import type { Dimension, Vector3 } from "@minecraft/server";
import { describe, expect, it } from "vitest";
import {
  PhysicsAssembly,
  PhysicsBody,
  type PhysicsDimension
} from "@src/Physics";
import { AssemblyColliderIndex } from "@src/physics/contraption/AssemblyColliderIndex";
import type { AssemblyVisualRenderer } from "@src/render/contraption/AssemblyVisualRenderer";
import { CannonKernelRuntime } from "@src/physics/simulation/CannonKernel";
import type { TreeCollisionProxy } from "@src/physics/collision/TreeCollisionProxy";
import type { PhysicsAssemblyBlock } from "@src/physics/core/PhysicsTypes";

const INITIAL_VELOCITY = { x: 1.25, y: -0.5, z: 0.75 };
const INITIAL_ANGULAR_VELOCITY = { x: 0.4, y: -0.7, z: 1.6 };

describe("PhysicsAssembly in-place center-of-mass updates", () => {
  it.each([
    { expectedCenter: { x: 0, y: 1.5, z: 0 }, removedY: 0 },
    { expectedCenter: { x: 0, y: 0.5, z: 0 }, removedY: 2 }
  ])(
    "preserves rigid-body motion when removing endpoint y=$removedY",
    ({ expectedCenter, removedY }) => {
      const assembly = createThreeLogAssembly();
      const originBefore = assembly.body.localPointToWorld({ x: 0, y: 0, z: 0 });
      const remainingLocations = assembly.blocks
        .filter(block => block.localLocation.y !== removedY)
        .map(block => assembly.body.localPointToWorld(block.localLocation));
      const expectedVelocity = assembly.body.getVelocityAt(
        assembly.body.localPointToWorld(expectedCenter)
      );

      assembly.removeBlockAtLocalLocation({ x: 0, y: removedY, z: 0 });

      expectVectorClose(assembly.body.getCenterOfMass(), expectedCenter);
      expectVectorClose(
        assembly.body.localPointToWorld({ x: 0, y: 0, z: 0 }),
        originBefore
      );
      assembly.blocks.forEach((block, index) => {
        expectVectorClose(
          assembly.body.localPointToWorld(block.localLocation),
          remainingLocations[index]!
        );
      });
      expectVectorClose(assembly.body.getVelocity(), expectedVelocity);
    }
  );

  it("greedily merges adjacent chest collision boxes", () => {
    const blocks = Array.from({ length: 16 }, (_, x) => createChestBlock({ x, y: 0, z: 0 }));
    const colliderIndex = new AssemblyColliderIndex(blocks);

    expect(colliderIndex.collider.children).toHaveLength(1);
    expect(colliderIndex.collider.children[0]?.collider).toEqual({
      size: { x: 15.875, y: 0.875, z: 0.875 },
      type: "box"
    });

    colliderIndex.removeBlocks([blocks[7]!]);
    expect(colliderIndex.collider.children).toHaveLength(2);

    colliderIndex.addBlocks([blocks[7]!]);
    expect(colliderIndex.collider.children).toHaveLength(1);
  });
});

function createThreeLogAssembly(): PhysicsAssembly {
  const blocks: PhysicsAssemblyBlock[] = [0, 1, 2].map(y => ({
    localLocation: { x: 0, y, z: 0 },
    mass: 1,
    typeId: "minecraft:oak_log"
  }));
  const colliderIndex = new AssemblyColliderIndex(blocks);
  const runtime = new CannonKernelRuntime({ gravity: { x: 0, y: 0, z: 0 } });
  const kernelBody = runtime.createBody(
    { id: "minecraft:overworld" } as Dimension,
    {
      angularVelocity: INITIAL_ANGULAR_VELOCITY,
      collider: colliderIndex.collider,
      location: { x: 12, y: 64, z: -8 },
      mass: 3,
      rotation: { x: 17, y: 29, z: -13 },
      velocity: INITIAL_VELOCITY,
      visual: false
    },
    1
  );
  const body = new PhysicsBody({} as PhysicsDimension, kernelBody);
  body.setCenterOfMass({ x: 0, y: 1, z: 0 });

  const visuals: AssemblyVisualRenderer = {
    addBlocks: () => undefined,
    attachAuxiliaryRider: () => false,
    detachAuxiliaryRider: () => undefined,
    entityCount: 0,
    entityIds: [],
    entityLocations: [],
    firstEntityLocation: undefined,
    hasEntity: () => false,
    hasIntactEntities: () => true,
    hasKnownIntegrityFailure: () => false,
    initialPoseDeferred: false,
    releaseInitialPose: () => undefined,
    rebaseVisualAnchor: () => undefined,
    remove: () => undefined,
    removeBlocks: () => undefined,
    supportsBlockAddition: false,
    sync: () => 0,
    visualAnchorLocal: { x: 0, y: 0, z: 0 }
  };
  const collisionProxy = {
    dispose: () => undefined,
    hasKnownIntegrityFailure: false,
    setCollider: () => undefined
  } as unknown as TreeCollisionProxy;

  return new PhysicsAssembly(
    body,
    blocks,
    visuals,
    colliderIndex,
    collisionProxy,
    { x: 0, y: 3, z: 0 },
    3
  );
}

function createChestBlock(localLocation: Vector3): PhysicsAssemblyBlock {
  return {
    collidable: true,
    collisionResponse: true,
    collisionShape: [{
      min: { x: 1 / 16, y: 0, z: 1 / 16 },
      max: { x: 15 / 16, y: 14 / 16, z: 15 / 16 }
    }],
    localLocation,
    typeId: "minecraft:chest"
  };
}

function expectVectorClose(actual: Vector3, expected: Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.z).toBeCloseTo(expected.z, 10);
}
