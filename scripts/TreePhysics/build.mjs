import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

const runtimePhysicsBoundaryPlugin = {
  name: "runtime-physics-boundary",
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^(?:\.\/Physics(?:\.js)?|@src\/Physics)$/ },
      () => ({ path: "./physics.js", external: true })
    );
  }
};
const targets = [
  {
    entryPoint: "src/Physics.ts",
    outfile: "packs/TreePhysics/TreePhysicsBP/scripts/physics.js",
    external: ["@minecraft/server"]
  },
  {
    entryPoint: "src/Main.ts",
    outfile: "packs/TreePhysics/TreePhysicsBP/scripts/main.js",
    external: ["@minecraft/server", "@minecraft/server-ui"]
  }
];

for (const target of targets) {
  await mkdir(dirname(target.outfile), { recursive: true });
  await build({
    bundle: true,
    drop: ["console"],
    entryPoints: [target.entryPoint],
    external: target.external,
    format: "esm",
    logLevel: "info",
    minify: false,
    outfile: target.outfile,
    plugins: [runtimePhysicsBoundaryPlugin],
    sourcemap: false,
    target: "es2020"
  });
}
