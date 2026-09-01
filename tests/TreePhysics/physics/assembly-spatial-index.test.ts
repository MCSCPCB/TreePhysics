import { describe, expect, it } from "vitest";
import { AssemblySpatialIndex } from "@src/physics/contraption/AssemblySpatialIndex";
import type { PhysicsBodyAabb } from "@src/physics/core/PhysicsTypes";

class FakeAssembly {
  isValid = true;
  readonly body = {
    getAabb: (): PhysicsBodyAabb => this.bounds
  };

  constructor(
    readonly id: number,
    public bounds: PhysicsBodyAabb
  ) {}
}

describe("assembly spatial index", () => {
  it("returns only assemblies intersected by the finite interaction ray", () => {
    const index = new AssemblySpatialIndex<FakeAssembly>();
    const hit = assembly(2, 3, 0, 0);
    const missed = assembly(1, 3, 5, 0);
    const distant = assembly(3, 40, 0, 0);
    index.update(hit);
    index.update(missed);
    index.update(distant);

    expect(index.queryRay(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5
    )).toEqual([hit]);
  });

  it("moves an assembly between coarse cells without leaving stale candidates", () => {
    const index = new AssemblySpatialIndex<FakeAssembly>();
    const moving = assembly(1, 3, 0, 0);
    index.update(moving);
    moving.bounds = box(35, 0, 0);
    index.update(moving);

    expect(index.queryRay(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5
    )).toEqual([]);
    expect(index.queryRay(
      { x: 32, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5
    )).toEqual([moving]);
  });

  it("deduplicates large assemblies and preserves body-id ordering", () => {
    const index = new AssemblySpatialIndex<FakeAssembly>();
    const later = new FakeAssembly(7, {
      min: { x: -1, y: -1, z: -1 },
      max: { x: 33, y: 1, z: 1 }
    });
    const earlier = assembly(2, 2, 0, 0);
    index.update(later);
    index.update(earlier);

    expect(index.queryRay(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      5
    )).toEqual([earlier, later]);
  });
});

function assembly(id: number, x: number, y: number, z: number): FakeAssembly {
  return new FakeAssembly(id, box(x, y, z));
}

function box(x: number, y: number, z: number): PhysicsBodyAabb {
  return {
    min: { x: x - 0.5, y: y - 0.5, z: z - 0.5 },
    max: { x: x + 0.5, y: y + 0.5, z: z + 0.5 }
  };
}
