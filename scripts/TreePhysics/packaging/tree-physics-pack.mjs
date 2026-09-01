import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PACK_ROOT = "packs/TreePhysics";
const SOURCE_NAMESPACE = "physics_api";
const PACK_NAMESPACE = "tree_physics";
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".json",
  ".lang",
  ".material",
  ".mcfunction",
  ".txt"
]);

export async function finalizeTreePhysicsPack(packRoot = DEFAULT_PACK_ROOT) {
  const files = await collectPackFiles(packRoot);
  let changedFileCount = 0;
  for (const path of files) {
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const source = await readFile(path, "utf8");
    const finalized = source.replaceAll(SOURCE_NAMESPACE, PACK_NAMESPACE);
    if (finalized === source) continue;
    await writeFile(path, finalized);
    changedFileCount++;
  }
  return { changedFileCount, fileCount: files.length };
}

async function collectPackFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.includes(SOURCE_NAMESPACE)) {
      throw new Error(`Source namespace is not allowed in a pack path: ${join(directory, entry.name)}`);
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectPackFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await finalizeTreePhysicsPack();
  console.warn(
    `[pack:finalize] ${result.fileCount} files checked, ${result.changedFileCount} updated`
  );
}
