import assert from "node:assert/strict";
import { test } from "node:test";
import { kernel } from "./load-kernel.mjs";

function dimensionWithLoadSwitch() {
  let loaded = false;
  const dimension = {
    id: "test:overworld",
    get loaded() { return loaded; },
    set loaded(value) { loaded = value; },
    getBlock(location) {
      if (!loaded) throw new Error("chunk unavailable");
      return {
        isAir: location.y >= 0,
        typeId: location.y >= 0 ? "minecraft:air" : "minecraft:stone"
      };
    }
  };
  return dimension;
}

function createBody(runtime, dimension) {
  return runtime.createBody(dimension, {
    collider: { halfExtents: { x: .4, y: .4, z: .4 }, type: "box" },
    location: { x: .5, y: 3, z: .5 },
    mass: 1,
    visual: false,
    velocity: { x: 0, y: 0, z: 0 }
  });
}

test("low quality waits without losing velocity, then resumes when all chunks build", () => {
  const runtime = new kernel.CannonKernelRuntime({
    fixedTimeStep: 1 / 20,
    tickSteps: 1,
    worldMeshCache: true,
    worldMeshWaitForMissingChunks: true
  });
  const dimension = dimensionWithLoadSwitch();
  const body = createBody(runtime, dimension);
  const start = body.location;
  body.setVelocity({ x: 1.25, y: -2, z: .5 });
  body.setAngularVelocity({ x: .2, y: 0, z: -.1 });
  runtime.step();
  assert.equal(body.isSleeping, false, "a cache wait must remain active to gameplay");
  assert.deepEqual(body.location, start, "waiting body must not integrate");
  assert.deepEqual(body.velocity, { x: 1.25, y: -2, z: .5 });
  assert.deepEqual(body.angularVelocity, { x: .2, y: 0, z: -.1 });

  dimension.loaded = true;
  runtime.step();
  assert.ok(body.location.x > start.x, "velocity must resume after chunk build");
  assert.ok(body.location.y < start.y, "gravity must resume after chunk build");
  assert.ok(body.isActive);
});

test("switching from low to high quality releases a cache wait", () => {
  const runtime = new kernel.CannonKernelRuntime({
    fixedTimeStep: 1 / 20,
    tickSteps: 1,
    worldMeshCache: true,
    worldMeshWaitForMissingChunks: true
  });
  const dimension = dimensionWithLoadSwitch();
  const body = createBody(runtime, dimension);
  const start = body.location;
  body.setVelocity({ x: 0, y: -1, z: 0 });
  runtime.step();
  assert.deepEqual(body.location, start);

  runtime.configure({
    fixedTimeStep: 1 / 60,
    tickSteps: 3,
    worldMeshWaitForMissingChunks: false
  });
  runtime.step();
  assert.ok(body.location.y < start.y, "high quality must resume while cache is missing");
  assert.equal(body.isSleeping, false);
});

test("high quality keeps moving while a missing cache build is pending", () => {
  const runtime = new kernel.CannonKernelRuntime({
    fixedTimeStep: 1 / 60,
    tickSteps: 3,
    worldMeshCache: true,
    worldMeshWaitForMissingChunks: false
  });
  const dimension = dimensionWithLoadSwitch();
  const body = createBody(runtime, dimension);
  const start = body.location;
  runtime.step();
  assert.ok(body.location.y < start.y, "high quality uses the agreed delayed-cache path");
});

test("high quality event invalidation rebuilds referenced cache chunks", () => {
  const runtime = new kernel.CannonKernelRuntime({
    fixedTimeStep: 1 / 60,
    tickSteps: 3,
    worldMeshCache: true,
    worldMeshWaitForMissingChunks: false
  });
  const dimension = dimensionWithLoadSwitch();
  dimension.loaded = true;
  createBody(runtime, dimension);

  // The first step populates the active chunk set for the body.
  runtime.step();
  assert.equal(runtime.hasPendingWorldMeshBuilds(), false);

  // Event driven invalidation must immediately enqueue the referenced chunks
  // at high priority instead of waiting for the periodic audit.
  runtime.invalidateWorldMeshBatch(dimension, [{ x: .5, y: 0, z: .5 }]);
  assert.equal(runtime.hasPendingWorldMeshBuilds(), true);
  runtime.step();
  assert.equal(runtime.hasPendingWorldMeshBuilds(), false);
});
