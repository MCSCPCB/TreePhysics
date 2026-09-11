import assert from "node:assert/strict";
import { test } from "node:test";
import { Body, Box, ContactMaterial, Material, NaiveBroadphase, Narrowphase,
  Quaternion, SAPBroadphase, Sphere, Vec3, World } from "cannon-es";
import { AabbSAPBroadphase, BoxNarrowphase } from "./load.mjs";

function random(seed = 0x5137abcd) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
}
function quaternion(rng) {
  return new Quaternion().setFromEuler((rng() - .5) * 6, (rng() - .5) * 6, (rng() - .5) * 6);
}
function vectorEqual(a, b, message, tolerance = 1e-7) {
  for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(a[axis] - b[axis]) <= tolerance,
    `${message}.${axis}: ${a[axis]} vs ${b[axis]}`);
}
function compareEquations(a, b, label, tolerance = 1e-7) {
  assert.equal(a.result.length, b.result.length, `${label} contact count`);
  assert.equal(a.frictionResult.length, b.frictionResult.length, `${label} friction count`);
  for (let i = 0; i < a.result.length; i++) {
    const left = a.result[i], right = b.result[i];
    for (const field of ["bi", "bj", "si", "sj", "enabled", "restitution"]) {
      assert.equal(left[field], right[field], `${label} contact ${i} ${field}`);
    }
    for (const field of ["ri", "rj", "ni"]) vectorEqual(left[field], right[field], `${label} contact ${i} ${field}`, tolerance);
  }
  for (let i = 0; i < a.frictionResult.length; i++) {
    const left = a.frictionResult[i], right = b.frictionResult[i];
    for (const field of ["bi", "bj", "enabled", "minForce", "maxForce"]) assert.equal(left[field], right[field]);
    for (const field of ["ri", "rj", "t"]) vectorEqual(left[field], right[field], `${label} friction ${i} ${field}`, tolerance);
  }
}
function reset(narrowphase) {
  narrowphase.contactPointPool.push(...narrowphase.result);
  narrowphase.frictionEquationPool.push(...narrowphase.frictionResult);
  narrowphase.result.length = 0;
  narrowphase.frictionResult.length = 0;
}

test("box contacts match Cannon: random shapes, orientations, boundaries, distant coordinates and materials", () => {
  const rng = random();
  const world = new World({ gravity: new Vec3(0, -11, 0) });
  world.dt = 1 / 60;
  const stock = new Narrowphase(world), optimized = new BoxNarrowphase(world);
  const material = new Material({ friction: .7, restitution: .25 });
  const sizes = [new Vec3(.5, .5, .5), new Vec3(.45, 6, .45), new Vec3(4, .25, 4), new Vec3(.5, .125, .25), new Vec3(.01, 10, .01)];
  for (let i = 0; i < 14000; i++) {
    const a = new Box(sizes[i % sizes.length]);
    const b = new Box(sizes[Math.floor(rng() * sizes.length)]);
    a.material = b.material = material;
    if (i % 7 === 0) a.collisionResponse = false;
    const far = i % 5 === 0 ? 29000000 : 0;
    const pa = new Vec3(far + (rng() - .5) * 16, (rng() - .5) * 10, -far + (rng() - .5) * 16);
    const pb = pa.vadd(new Vec3((rng() - .5) * 10, (rng() - .5) * 10, (rng() - .5) * 10));
    const qa = quaternion(rng), qb = quaternion(rng);
    if (i % 3 === 0) {
      qa.set(0, 0, 0, 1);
      qb.setFromEuler(0, [0, 1e-10, 1e-7, 1e-5][i % 4], 0);
      pb.set(pa.x + a.halfExtents.x + b.halfExtents.x + [-1e-8, 0, 1e-8][Math.floor(i / 3) % 3], pa.y, pa.z);
    }
    const ba = new Body({ mass: 1, position: pa }), bb = new Body({ mass: i % 2, position: pb });
    for (const n of [stock, optimized]) {
      reset(n);
      n.currentContactMaterial = world.defaultContactMaterial;
      n.enableFrictionReduction = i % 2 === 0;
      n.boxBox(a, b, pa, pb, qa, qb, ba, bb, b, a, false);
    }
    compareEquations(stock, optimized, `sample ${i}`, far ? 1e-6 : 1e-7);
    reset(stock); reset(optimized);
    assert.equal(stock.boxBox(a, b, pa, pb, qa, qb, ba, bb, a, b, true),
      optimized.boxBox(a, b, pa, pb, qa, qb, ba, bb, a, b, true), `sensor ${i}`);
  }
});

test("compound shape filtering preserves contact order, sensors, materials and non-box dispatch", () => {
  const rng = random(91231), world = new World({ gravity: new Vec3(0, -11, 0) });
  world.dt = 1 / 20;
  const materials = [new Material({ friction: .2, restitution: .1 }), new Material({ friction: .8, restitution: .3 })];
  world.addContactMaterial(new ContactMaterial(materials[0], materials[1], { friction: .35, restitution: .2 }));
  const bodies = [];
  for (let i = 0; i < 16; i++) {
    const body = new Body({ mass: i % 3 === 0 ? 0 : 2, material: materials[i % 2] });
    if (i % 5 === 0) body.type = Body.KINEMATIC;
    for (let j = 0; j < 12; j++) {
      const shape = new Box(new Vec3(.2 + rng(), .2 + rng(), .2 + rng()));
      shape.material = materials[j % 2];
      shape.collisionResponse = j % 6 !== 0;
      if (j % 3 === 0) shape.collisionFilterMask = 2;
      body.addShape(shape, new Vec3((rng() - .5) * 8, (rng() - .5) * 8, (rng() - .5) * 8), quaternion(rng));
    }
    if (i === 1) body.addShape(new Sphere(.75));
    bodies.push(body);
  }
  const p1 = [], p2 = [];
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) { p1.push(bodies[i]); p2.push(bodies[j]); }
  const a = new Narrowphase(world), b = new BoxNarrowphase(world);
  for (let frame = 0; frame < 25; frame++) {
    for (const body of bodies) { body.position.set(rng(), rng(), rng()); body.quaternion.copy(quaternion(rng)); }
    bodies[2].shapeOffsets[0].x += .1;
    if (frame === 10) bodies[2].removeShape(bodies[2].shapes[0]);
    for (const n of [a, b]) {
      reset(n);
      n.enableFrictionReduction = frame % 2 === 0;
      n.getContacts(p1, p2, world, n.result, n.contactPointPool, n.frictionResult, n.frictionEquationPool);
    }
    compareEquations(a, b, `compound frame ${frame}`);
  }
});

test("AABB sweep returns the exhaustive pair set on all axes, including touching and offset compounds", () => {
  const rng = random(41283), world = new World();
  for (let i = 0; i < 160; i++) {
    const body = new Body({ mass: i % 3 ? 1 : 0, position: new Vec3((rng() - .5) * 30, (rng() - .5) * 30, (rng() - .5) * 30) });
    body.addShape(new Box(new Vec3(.1 + rng() * 10, .1 + rng(), .1 + rng() * 3)), new Vec3(rng() * 3, 0, 0), quaternion(rng));
    if (i % 7 === 0) body.sleep();
    if (i % 11 === 0) body.collisionFilterMask = 0;
    world.addBody(body);
  }
  const left = new Body({ mass: 1, shape: new Box(new Vec3(.5, .5, .5)) });
  const right = new Body({ mass: 1, shape: new Box(new Vec3(.5, .5, .5)), position: new Vec3(1, 0, 0) });
  world.addBody(left); world.addBody(right);
  const exhaustive = new NaiveBroadphase(); exhaustive.useBoundingBoxes = true;
  const sap = new AabbSAPBroadphase(world); sap.useBoundingBoxes = true;
  const keys = (p1, p2) => p1.map((body, i) => [body.id, p2[i].id].sort((a, b) => a - b).join(":")).sort();
  for (const axis of [0, 1, 2]) {
    sap.axisIndex = axis; sap.dirty = true;
    const a = [], b = [], c = [], d = [];
    exhaustive.collisionPairs(world, a, b); sap.collisionPairs(world, c, d);
    assert.deepEqual(keys(c, d), keys(a, b));
    assert.ok(keys(c, d).includes(`${left.id}:${right.id}`));
  }
});

test("full 20 Hz and 60 Hz worlds retain falling, rolling, stacking and sleep behavior", () => {
  function create(optimized) {
    const world = new World({ gravity: new Vec3(0, -11, 0), allowSleep: true });
    world.solver.iterations = 8;
    world.broadphase = optimized ? new AabbSAPBroadphase(world) : new SAPBroadphase(world);
    world.broadphase.useBoundingBoxes = true;
    if (optimized) world.narrowphase = new BoxNarrowphase(world);
    world.addBody(new Body({ shape: new Box(new Vec3(12, .5, 12)), position: new Vec3(0, -.5, 0) }));
    for (let i = 0; i < 6; i++) {
      const body = new Body({ mass: 1, shape: new Box(new Vec3(.45, .45, 1.2)), position: new Vec3((i % 2) * 3, 1 + i * 1.2, 0),
        sleepSpeedLimit: .14, sleepTimeLimit: 1.1, linearDamping: .09, angularDamping: .09 });
      body.quaternion.setFromEuler(.07 * i, .04 * i, .03 * i);
      world.addBody(body);
    }
    return world;
  }
  for (const substeps of [1, 3]) {
    const a = create(false), b = create(true);
    for (let tick = 0; tick < 180; tick++) {
      for (let step = 0; step < substeps; step++) {
        a.step(1 / (20 * substeps)); b.step(1 / (20 * substeps));
      }
      for (let i = 1; i < a.bodies.length; i++) {
        vectorEqual(a.bodies[i].position, b.bodies[i].position, `world ${substeps}/${tick}/${i}`, 1e-5);
        vectorEqual(a.bodies[i].velocity, b.bodies[i].velocity, `velocity ${substeps}/${tick}/${i}`, 1e-4);
        assert.equal(a.bodies[i].sleepState, b.bodies[i].sleepState);
        assert.ok(b.bodies[i].position.y > -.1);
      }
    }
  }
});
