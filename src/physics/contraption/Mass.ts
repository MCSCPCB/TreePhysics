import type { Vector3 } from "@minecraft/server";
import type {
  PhysicsContraptionBlock,
  PhysicsBodyBuoyancyPoint,
  PhysicsBodyCollider
} from "@src/physics/core/Types";

const DEFAULT_LEAF_BUOYANCY_VOLUME = 0.125;
const DEFAULT_LOG_BUOYANCY_VOLUME = 1;
const DEFAULT_OTHER_BLOCK_MASS = 0.25;
const DEFAULT_OTHER_BLOCK_BUOYANCY_VOLUME = 0.25;

function normalizeBlockBuoyancyVolume(block: PhysicsContraptionBlock): number {
  if (Number.isFinite(block.buoyancyVolume) && block.buoyancyVolume! >= 0) {
    return block.buoyancyVolume!;
  }
  switch (classifyBlockPhysicsDefaults(block.typeId)) {
    case "leaf": return DEFAULT_LEAF_BUOYANCY_VOLUME;
    case "log": return DEFAULT_LOG_BUOYANCY_VOLUME;
    case "other": return DEFAULT_OTHER_BLOCK_BUOYANCY_VOLUME;
  }
}

export function createDefaultContraptionBuoyancyPoints(
  blocks: readonly PhysicsContraptionBlock[]
): PhysicsBodyBuoyancyPoint[] {
  return blocks
    .map(block => ({
      localLocation: { ...block.localLocation },
      volume: normalizeBlockBuoyancyVolume(block)
    }))
    .filter(point => point.volume > 0);
}

export function computeContraptionMassProperties(
  blocks: readonly PhysicsContraptionBlock[]
): { readonly mass: number; readonly moment: Vector3 } {
  let mass = 0;
  const moment = { x: 0, y: 0, z: 0 };
  for (const block of blocks) {
    const blockMass = block.mass ?? DEFAULT_OTHER_BLOCK_MASS;
    mass += blockMass;
    moment.x += block.localLocation.x * blockMass;
    moment.y += block.localLocation.y * blockMass;
    moment.z += block.localLocation.z * blockMass;
  }
  return { mass, moment };
}

export function computeContraptionInertia(
  collider: Extract<PhysicsBodyCollider, { type: "compound" }>,
  mass: number
): Vector3 {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  // Compound children use a bottom-center origin: location marks the box's
  // bottom face center, so Y spans [y, y + size.y] while X/Z span +-size/2.
  for (const child of collider.children) {
    if (child.collider.type !== "box") continue;
    const size = child.collider.size ?? {
      x: (child.collider.halfExtents?.x ?? 0.5) * 2,
      y: (child.collider.halfExtents?.y ?? 0.5) * 2,
      z: (child.collider.halfExtents?.z ?? 0.5) * 2
    };
    const location = child.location ?? { x: 0, y: 0, z: 0 };
    minX = Math.min(minX, location.x - size.x / 2);
    minY = Math.min(minY, location.y);
    minZ = Math.min(minZ, location.z - size.z / 2);
    maxX = Math.max(maxX, location.x + size.x / 2);
    maxY = Math.max(maxY, location.y + size.y);
    maxZ = Math.max(maxZ, location.z + size.z / 2);
  }
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  return {
    x: mass * (sizeY * sizeY + sizeZ * sizeZ) / 12,
    y: mass * (sizeX * sizeX + sizeZ * sizeZ) / 12,
    z: mass * (sizeY * sizeY + sizeX * sizeX) / 12
  };
}

function classifyBlockPhysicsDefaults(typeId: string): "leaf" | "log" | "other" {
  const name = typeId.slice(typeId.indexOf(":") + 1);
  if (name.endsWith("_leaves") || name === "leaves" || name === "leaves2") return "leaf";
  if (name.endsWith("_log") || name.endsWith("_wood") || name.endsWith("_stem") || name.endsWith("_hyphae")) {
    return "log";
  }
  return "other";
}
