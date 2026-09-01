import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const manifestPath = "packs/TreePhysics/TreePhysicsBP/manifest.json";
const mainScriptPath = "packs/TreePhysics/TreePhysicsBP/scripts/main.js";
const physicsScriptPath = "packs/TreePhysics/TreePhysicsBP/scripts/physics.js";

execFileSync(process.execPath, ["scripts/TreePhysics/build.mjs"], { stdio: "inherit" });

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const mainScript = await readFile(mainScriptPath, "utf8");
const physicsScript = await readFile(physicsScriptPath, "utf8");
const scripts = `${mainScript}\n${physicsScript}`;
const editConsoleCalls = scripts.match(/globalThis\.console\.error/g) ?? [];
if (
  editConsoleCalls.length !== 2
  || !scripts.includes("[tree_physics/stage0]")
  || !scripts.includes("[tree_physics/stage1]")
) {
  throw new Error(
    "Release bundle may contain only the explicit Stage 0 and Stage 1 callbacks."
  );
}
const scriptsWithoutEditConsole = scripts.replaceAll("globalThis.console.error", "edit_callback");

if (scripts.includes("physics_api")) {
  throw new Error("Built scripts must use the tree_physics pack namespace.");
}
if (manifest.dependencies.some(dependency => dependency.module_name === "@minecraft/debug-utilities")) {
  throw new Error("The release manifest must not depend on debug utilities.");
}
for (const forbidden of [
  "@minecraft/debug-utilities",
  "console.",
  "diagnostic",
  "profiler",
  "debugDraw",
  "[TP:",
  "TreePhysics:TPS",
  "TreePhysics:PhysicsPerf",
  "TreePhysics:LifecyclePerf",
  "lifecycle_perf",
  "tree_perf_debug",
  "tree_scan_debug",
  "domain_debug",
  "debug_colliders"
]) {
  if (scriptsWithoutEditConsole.includes(forbidden)) {
    throw new Error(`Release bundle contains forbidden diagnostics: ${forbidden}`);
  }
}
if (
  physicsScript.includes("var ENCODED_RGB")
  || physicsScript.includes("var BIOME_FOLIAGE_CLIMATES")
) {
  throw new Error("Physics bundle must not contain gameplay foliage lookup data.");
}
if (
  mainScript.includes("// node_modules/cannon-es")
  || mainScript.includes("// src/physics/cannon-kernel.ts")
) {
  throw new Error("Main bundle must consume physics.js instead of embedding the physics engine.");
}
if (!mainScript.includes('from "./physics.js"')) {
  throw new Error("Main bundle must keep physics.js as an external runtime dependency.");
}
