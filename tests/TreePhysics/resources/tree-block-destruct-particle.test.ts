import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PARTICLE_DIRECTORY =
  "packs/TreePhysics/TreePhysicsRP/particles/tree_block_destruct";
const PARTICLE_PATHS = readdirSync(PARTICLE_DIRECTORY)
  .filter(name => name.endsWith(".particle.json"))
  .map(name => join(PARTICLE_DIRECTORY, name));

describe("tree block destruct particles", () => {
  it("uses the caller-provided vanilla destruct intensity for every block texture", () => {
    expect(PARTICLE_PATHS.length).toBeGreaterThan(0);
    for (const path of PARTICLE_PATHS) {
      const definition = JSON.parse(readFileSync(path, "utf8"));
      const components = definition.particle_effect.components;

      expect(
        components["minecraft:emitter_rate_instant"].num_particles,
        path
      ).toBe("variable.emitter_particles_count");
      expect(
        components["minecraft:emitter_shape_point"].offset,
        path
      ).toEqual([
        "Math.random(-variable.emitter_radius,variable.emitter_radius)",
        "Math.random(-variable.emitter_radius,variable.emitter_radius)",
        "Math.random(-variable.emitter_radius,variable.emitter_radius)"
      ]);
      expect(components["minecraft:particle_initial_speed"], path)
        .toBe("Math.random(0,4)*variable.velocity_scalar");
    }
  });
});
