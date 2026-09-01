import { world, type Block, type Dimension, type Entity, type Vector3 } from "@minecraft/server";
import { ContraptionExternalEffectsController } from "@src/content/contraption/effects/Controller";
import { clamp } from "@src/utils/Vector3Math";

const EXPLOSION_MIN_RADIUS = 2.5;
const EXPLOSION_DEFAULT_RADIUS = 4.25;
const EXPLOSION_RADIUS_MARGIN = 1.25;
const EXPLOSION_MAX_RADIUS = 8;

export function installExplosionContraptionPhysics(
  effects: ContraptionExternalEffectsController,
  onWorldBlocksChanged?: (dimension: Dimension, locations: readonly Vector3[]) => void
): void {
  world.afterEvents.explosion.subscribe(event => {
    const impactedLocations: Vector3[] = [];
    for (const block of event.getImpactedBlocks()) {
      const location = tryGetBlockLocation(block);
      if (location) impactedLocations.push(location);
    }
    notifyWorldBlocksChanged(onWorldBlocksChanged, event.dimension, impactedLocations);
    const sourceLocation = tryGetEntityLocation(event.source);
    if (!sourceLocation && impactedLocations.length === 0) return;
    const center = sourceLocation ?? getImpactedBlockCentroid(impactedLocations);
    if (!center) return;
    effects.queueExplosion({
      center,
      dimension: event.dimension,
      radius: getExplosionRadius(center, impactedLocations)
    });
  });
}

function notifyWorldBlocksChanged(
  callback: ((dimension: Dimension, locations: readonly Vector3[]) => void) | undefined,
  dimension: Dimension,
  locations: readonly Vector3[]
): void {
  if (!callback) return;
  try {
    callback(dimension, locations);
  } catch {
    // Cache invalidation must not suppress the physical explosion effect.
  }
}

function tryGetBlockLocation(block: Block): Vector3 | undefined {
  try {
    return { ...block.location };
  } catch {
    return undefined;
  }
}

function getExplosionRadius(center: Vector3, impactedLocations: readonly Vector3[]): number {
  if (impactedLocations.length === 0) return EXPLOSION_DEFAULT_RADIUS;
  let maximumDistanceSquared = 0;
  for (const location of impactedLocations) {
    const dx = location.x + 0.5 - center.x;
    const dy = location.y + 0.5 - center.y;
    const dz = location.z + 0.5 - center.z;
    maximumDistanceSquared = Math.max(maximumDistanceSquared, dx * dx + dy * dy + dz * dz);
  }
  return clamp(
    Math.sqrt(maximumDistanceSquared) + EXPLOSION_RADIUS_MARGIN,
    EXPLOSION_MIN_RADIUS,
    EXPLOSION_MAX_RADIUS
  );
}

function tryGetEntityLocation(source: Entity | undefined): Vector3 | undefined {
  if (!source) return undefined;
  try {
    const location = source.location;
    return Number.isFinite(location.x) && Number.isFinite(location.y) && Number.isFinite(location.z)
      ? { ...location }
      : undefined;
  } catch {
    return undefined;
  }
}

function getImpactedBlockCentroid(locations: readonly Vector3[]): Vector3 | undefined {
  if (locations.length === 0) return undefined;
  const sum = { x: 0, y: 0, z: 0 };
  for (const location of locations) {
    sum.x += location.x + 0.5;
    sum.y += location.y + 0.5;
    sum.z += location.z + 0.5;
  }
  return {
    x: sum.x / locations.length,
    y: sum.y / locations.length,
    z: sum.z / locations.length
  };
}
