import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

const output = new URL("../../.tmp/physics-tests/", import.meta.url);
const outputPath = fileURLToPath(output);
await mkdir(output, { recursive: true });
const minecraftMock = resolve(outputPath, "minecraft-server.mjs");
await writeFile(minecraftMock, "export class BlockVolume { constructor(min, max) { this.min = min; this.max = max; } }\n");
await build({
  entryPoints: ["src/physics/simulation/CannonKernel.ts"],
  outfile: resolve(outputPath, "CannonKernel.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
  plugins: [{
    name: "tree-physics-test-aliases",
    setup(context) {
      context.onResolve({ filter: /^@src\// }, args => ({
        path: resolve("src", `${args.path.slice(5)}.ts`)
      }));
      context.onResolve({ filter: /^@minecraft\/server$/ }, () => ({ path: minecraftMock }));
    }
  }]
});
export const kernel = await import(new URL("CannonKernel.mjs", output));
