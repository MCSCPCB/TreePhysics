import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_COLLISION_SOURCE_DIRECTORY = ".tmp/collision-source";

const SOURCE_FILES = [
  {
    name: "blocks.json",
    sha256: "5ddba441f329c0ed641c904a43e0b8e36d2926110b209c069d395f1b7622f825",
    url: "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/edfc78fe849b0203672a7fe1f533971ab56732d6/data/bedrock/1.21.111/blocks.json"
  },
  {
    name: "blockStates.json",
    sha256: "634ac4230df9b664c61d85eda793f103700408f0fac81bf4405292605fd2ad50",
    url: "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/edfc78fe849b0203672a7fe1f533971ab56732d6/data/bedrock/1.21.111/blockStates.json"
  },
  {
    name: "blockCollisionShapes.json",
    sha256: "a6f20074bf399bde786fde6bf980ba3f6f521ea4a8be77f2d85d2a500324c420",
    url: "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/edfc78fe849b0203672a7fe1f533971ab56732d6/data/bedrock/1.21.111/blockCollisionShapes.json"
  },
  {
    name: "pc-blocks.json",
    sha256: "16a26f1dba3e8ae7a5a05a7e25f724ba924b0bacbd17481992d027fbaf70e3e8",
    url: "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/d7c753a903c5cfee967db04b7f4b146ba8f8d375/data/pc/1.21.4/blocks.json"
  },
  {
    name: "pc-blockCollisionShapes.json",
    sha256: "f2d07593c4188ff05109b62481e5644713e8f3349a7a6a3f63c04dc93b4bc555",
    url: "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/d7c753a903c5cfee967db04b7f4b146ba8f8d375/data/pc/1.21.4/blockCollisionShapes.json"
  }
];

export async function ensureCollisionSourceFiles(
  sourceDirectory = DEFAULT_COLLISION_SOURCE_DIRECTORY
) {
  await mkdir(sourceDirectory, { recursive: true });
  for (const source of SOURCE_FILES) {
    const target = path.join(sourceDirectory, source.name);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      bytes = await downloadSource(source.url);
      assertSourceHash(target, bytes, source.sha256);
      const temporaryTarget = `${target}.${process.pid}.download`;
      try {
        await writeFile(temporaryTarget, bytes);
        await rename(temporaryTarget, target);
      } finally {
        await rm(temporaryTarget, { force: true });
      }
    }
    assertSourceHash(target, bytes, source.sha256);
  }
  return sourceDirectory;
}

async function downloadSource(url) {
  let fetchFailure;
  if (process.platform !== "win32") {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      fetchFailure = error;
    }
  }

  const curlArguments = [
    ...(process.platform === "win32" ? ["--ssl-no-revoke"] : []),
    "-fsSL",
    "--retry",
    "4",
    "--retry-all-errors",
    "--retry-delay",
    "1",
    url
  ];
  const result = spawnSync(process.platform === "win32" ? "curl.exe" : "curl", curlArguments, {
    encoding: null,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status === 0 && result.stdout) return result.stdout;
  throw new Error(
    `Unable to download ${url} with fetch or curl: ${fetchFailure?.message ?? "fetch unavailable"}; ${result.stderr?.toString().trim() || "curl failed"}`
  );
}

function assertSourceHash(target, bytes, expectedHash) {
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `${target} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDirectory = process.argv[2] ?? DEFAULT_COLLISION_SOURCE_DIRECTORY;
  await ensureCollisionSourceFiles(sourceDirectory);
  console.log(`[collision-source-cache] verified ${SOURCE_FILES.length} files in ${sourceDirectory}`);
}
