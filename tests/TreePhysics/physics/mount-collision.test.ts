import type { Vector3 } from "@minecraft/server";
import { describe, expect, it } from "vitest";
import type {
  PhysicsContraption,
  PhysicsContraptionBlock
} from "@src/Physics";
import {
  isMountSupportNormal,
  resolveMountCollision
} from "@src/physics/obb/internal/MountCollision";

describe("Mount local collision", () => {
  it("blocks a player body at a stationary wall", () => {
    const contraption = createContraption([
      ...createFloor(0, 2),
      ...createWall(1)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 2, y: 0, z: 0 },
      true
    );

    expect(result.movement.x).toBeGreaterThan(0.19);
    expect(result.movement.x).toBeLessThan(0.2);
    expect(result.grounded).toBe(true);
  });

  it("preserves unblocked movement while sliding along a wall", () => {
    const contraption = createContraption([
      ...createFloor(0, 2),
      ...createWall(1)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 2, y: 0, z: 1 },
      true
    );

    expect(result.movement.x).toBeLessThan(0.2);
    expect(result.movement.z).toBeCloseTo(1, 3);
  });

  it("blocks upward movement at the player's head", () => {
    const contraption = createContraption([
      ...createFloor(0, 0),
      block(0, 3, 0)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 0, y: 1, z: 0 },
      false
    );

    expect(result.movement.y).toBeGreaterThan(0.19);
    expect(result.movement.y).toBeLessThan(0.2);
    expect(result.hitCeiling).toBe(true);
    expect(result.grounded).toBe(false);
  });

  it("recovers penetration and still allows movement away from the wall", () => {
    const contraption = createContraption([
      ...createFloor(-1, 1),
      ...createWall(1)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0.35, y: 0.5, z: 0 },
      { x: -0.4, y: 0, z: 0.2 },
      true
    );

    expect(result.movement.x).toBeLessThan(-0.54);
    expect(result.movement.z).toBeCloseTo(0.2, 3);
  });

  it("does not tunnel through a one-block-thick wall at high speed", () => {
    const contraption = createContraption([
      ...createFloor(0, 10),
      ...createWall(1)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 10, y: 0, z: 0 },
      true
    );

    expect(result.movement.x).toBeGreaterThan(0.19);
    expect(result.movement.x).toBeLessThan(0.2);
  });

  it("steps onto a half-block collision shape", () => {
    const contraption = createContraption([
      ...createFloor(0, 2),
      partialBlock(1, 1, 0, 0.5)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 },
      true
    );

    expect(result.movement.x).toBeCloseTo(1, 3);
    expect(result.movement.y).toBeCloseTo(0.5, 2);
    expect(result.grounded).toBe(true);
  });

  it("does not step onto a full block", () => {
    const contraption = createContraption([
      ...createFloor(0, 2),
      block(1, 1, 0)
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 },
      true
    );

    expect(result.movement.x).toBeLessThan(0.2);
    expect(result.movement.y).toBeLessThan(0.002);
  });

  it("does not step above the configured maximum step height", () => {
    const ledge = partialBlock(1, 1, 0, 0.65);
    const contraption = createContraption([
      ...createFloor(0, 2),
      ledge
    ]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 },
      true
    );

    expect(result.movement.y).toBeLessThan(0.002);
    expect(result.support?.block).not.toBe(ledge);
  });

  it("keeps continuous support while the upward face remains standable", () => {
    for (const angle of [15, 33, 45, 75]) {
      const yaw = 35;
      const contraption = createTiltedContraption(createFloor(-2, 2), angle, yaw);
      const feet = getTiltedSurfaceFeet(angle, yaw);
      const normal = getTiltedNormal(angle, yaw);
      const horizontalLength = Math.hypot(normal.x, normal.z);
      const rawUphill = {
        x: -0.2 * normal.x / horizontalLength,
        y: 0,
        z: -0.2 * normal.z / horizontalLength
      };
      const normalAmount = rawUphill.x * normal.x + rawUphill.z * normal.z;
      const uphillMovement = {
        x: rawUphill.x - normal.x * normalAmount,
        y: -normal.y * normalAmount,
        z: rawUphill.z - normal.z * normalAmount
      };
      const uphill = resolveMountCollision(
        contraption,
        feet,
        uphillMovement,
        true
      );
      const downhill = resolveMountCollision(
        contraption,
        feet,
        {
          x: -uphillMovement.x,
          y: -uphillMovement.y,
          z: -uphillMovement.z
        },
        true
      );

      expect(uphill.grounded, `${angle} degree uphill`).toBe(true);
      expect(uphill.movement.y, `${angle} degree uphill`).toBeGreaterThan(0);
      expect(downhill.grounded, `${angle} degree downhill`).toBe(true);
      expect(downhill.movement.y, `${angle} degree downhill`).toBeLessThan(0);
      expect(uphill.support?.normal.y, `${angle} degree normal`)
        .toBeCloseTo(normal.y, 3);
    }
  });

  it("naturally loses uphill movement near a vertical support face", () => {
    const angle = 89;
    const contraption = createTiltedContraption(createFloor(-2, 2), angle);
    const feet = getTiltedSurfaceFeet(angle);
    const normal = getTiltedNormal(angle);
    const normalAmount = 0.2 * normal.x;
    const result = resolveMountCollision(
      contraption,
      feet,
      {
        x: 0.2 - normal.x * normalAmount,
        y: -normal.y * normalAmount,
        z: 0
      },
      true
    );

    expect(result.grounded).toBe(true);
    expect(result.movement.y).toBeLessThanOrEqual(0);
    expect(result.support?.normal.y).toBeCloseTo(normal.y, 3);
    expect(isMountSupportNormal(normal)).toBe(true);
    expect(isMountSupportNormal({ x: -1, y: 0, z: 0 })).toBe(false);
  });

  it("drops support after moving beyond an edge", () => {
    const contraption = createContraption([block(0, 0, 0)]);

    const result = resolveMountCollision(
      contraption,
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 },
      true
    );

    expect(result.movement.x).toBeCloseTo(1, 3);
    expect(result.grounded).toBe(false);
    expect(result.support).toBeUndefined();
  });
});

function createContraption(
  blocks: readonly PhysicsContraptionBlock[]
): PhysicsContraption {
  return {
    body: {
      getAabb: () => ({
        min: { x: -16, y: -16, z: -16 },
        max: { x: 16, y: 16, z: 16 }
      }),
      localPointToWorld: (point: Vector3) => ({ ...point }),
      worldPointToLocal: (point: Vector3) => ({ ...point })
    },
    getBlocksInLocalBounds: () => blocks,
    get isValid() { return true; },
    id: 1
  } as unknown as PhysicsContraption;
}

function createTiltedContraption(
  blocks: readonly PhysicsContraptionBlock[],
  angle: number,
  yaw = 0
): PhysicsContraption {
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const yawRadians = yaw * Math.PI / 180;
  const yawCosine = Math.cos(yawRadians);
  const yawSine = Math.sin(yawRadians);
  return {
    body: {
      getAabb: () => ({
        min: { x: -16, y: -16, z: -16 },
        max: { x: 16, y: 16, z: 16 }
      }),
      localPointToWorld: (point: Vector3) => {
        const tiltedX = point.x * cosine - point.y * sine;
        return {
          x: tiltedX * yawCosine + point.z * yawSine,
          y: point.x * sine + point.y * cosine,
          z: -tiltedX * yawSine + point.z * yawCosine
        };
      },
      worldPointToLocal: (point: Vector3) => {
        const tiltedX = point.x * yawCosine - point.z * yawSine;
        return {
          x: tiltedX * cosine + point.y * sine,
          y: -tiltedX * sine + point.y * cosine,
          z: point.x * yawSine + point.z * yawCosine
        };
      }
    },
    getBlocksInLocalBounds: () => blocks,
    get isValid() { return true; },
    id: 1
  } as unknown as PhysicsContraption;
}

function getTiltedSurfaceFeet(angle: number, yaw = 0): Vector3 {
  const normal = getTiltedNormal(angle, yaw);
  const clearance = 0.3 * (1 - normal.y) + 0.001;
  return {
    x: normal.x * (0.5 + clearance),
    y: normal.y * (0.5 + clearance),
    z: normal.z * (0.5 + clearance)
  };
}

function getTiltedNormal(angle: number, yaw = 0): Vector3 {
  const radians = angle * Math.PI / 180;
  const yawRadians = yaw * Math.PI / 180;
  const sine = Math.sin(radians);
  return {
    x: -sine * Math.cos(yawRadians),
    y: Math.cos(radians),
    z: sine * Math.sin(yawRadians)
  };
}

function createFloor(minimumX: number, maximumX: number): PhysicsContraptionBlock[] {
  const blocks: PhysicsContraptionBlock[] = [];
  for (let x = minimumX; x <= maximumX; x++) {
    for (let z = -2; z <= 2; z++) blocks.push(block(x, 0, z));
  }
  return blocks;
}

function createWall(x: number): PhysicsContraptionBlock[] {
  const blocks: PhysicsContraptionBlock[] = [];
  for (let y = 1; y <= 2; y++) {
    for (let z = -2; z <= 2; z++) blocks.push(block(x, y, z));
  }
  return blocks;
}

function block(x: number, y: number, z: number): PhysicsContraptionBlock {
  return {
    localLocation: { x, y, z },
    typeId: "minecraft:stone"
  } as PhysicsContraptionBlock;
}

function partialBlock(
  x: number,
  y: number,
  z: number,
  height: number
): PhysicsContraptionBlock {
  return {
    collisionShape: [{
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: height, z: 1 }
    }],
    localLocation: { x, y, z },
    typeId: "minecraft:stone_slab"
  } as PhysicsContraptionBlock;
}
