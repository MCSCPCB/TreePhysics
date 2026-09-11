import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = new URL("../../.tmp/physics-tests/", import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/physics/simulation/BoxNarrowphase.ts", "src/physics/simulation/AabbSAPBroadphase.ts"],
  outdir: fileURLToPath(output),
  bundle: true, format: "esm", platform: "node", packages: "external",
  outExtension: { ".js": ".mjs" }, logLevel: "silent"
});
export const { BoxNarrowphase } = await import(new URL("BoxNarrowphase.mjs", output));
export const { AabbSAPBroadphase } = await import(new URL("AabbSAPBroadphase.mjs", output));
