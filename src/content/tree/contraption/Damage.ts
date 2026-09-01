// Entity damage math for moving contraptions: impact damage curve, swept-pose
// speed gating, voxel DDA log-contact search, and damage query clustering.
// Split from contraption-lifecycle.ts because these are pure computations the
// lifecycle only orchestrates; ContraptionState is imported as a type only.
import type { Dimension, Entity, Vector3 } from "@minecraft/server";
import type { PhysicsBodyAabb } from "@src/Physics";
import { CONTRAPTION_RENDER_ENTITY_TYPE_IDS } from "@src/render/contraption/shared/Renderer";
import { rotateVectorByEulerDegreesYzx } from "@src/physics/motion/RotationContinuity";
import { boundsOverlap, mergeBounds } from "@src/content/tree/contraption/Bounds";
import { subtract } from "@src/utils/Vector3Math";
import { isVector, type SavedPose } from "@src/storage/ContraptionSerialization";
import type { ContraptionState } from "@src/content/tree/contraption/Lifecycle";

const TREE_IMPACT_REFERENCE_GRAVITY = 11;
const TREE_IMPACT_SAFE_FALL_DISTANCE = 3;
const TREE_IMPACT_MIN_SPEED = Math.sqrt(
  2 * TREE_IMPACT_REFERENCE_GRAVITY * TREE_IMPACT_SAFE_FALL_DISTANCE
);
const MAX_TREE_IMPACT_DAMAGE = 50;
export const PHYSICS_TICKS_PER_SECOND = 20;

export interface DamageTreeProbe {
  bounds: PhysicsBodyAabb;
  currentPose: SavedPose;
  order: number;
  tree: ContraptionState;
}

export interface DamageQueryCluster {
  bounds: PhysicsBodyAabb;
  dimension: Dimension;
  probes: DamageTreeProbe[];
}

export interface DamageCandidate {
  baseLocation: Vector3;
  entity: Entity;
  headLocation: Vector3;
}

interface DamageLogContact {
  logLocation: Vector3;
}

export function addDamageQueryProbe(clusters: DamageQueryCluster[], probe: DamageTreeProbe): void {
  let bounds = probe.bounds;
  const probes = [probe];
  for (let index = clusters.length - 1; index >= 0; index--) {
    const cluster = clusters[index]!;
    if (!boundsOverlap(bounds, cluster.bounds)) continue;
    bounds = mergeBounds(bounds, cluster.bounds);
    probes.push(...cluster.probes);
    clusters.splice(index, 1);
    index = clusters.length;
  }
  clusters.push({
    bounds,
    dimension: probe.tree.contraption.body.dimension.dimension,
    probes
  });
}

export function prepareDamageCandidates(entities: readonly Entity[]): DamageCandidate[] {
  const candidates: DamageCandidate[] = [];
  for (const entity of entities) {
    if (!isDamageableTreeTarget(entity)) continue;
    try {
      candidates.push({
        baseLocation: { ...entity.location },
        entity,
        headLocation: entity.getHeadLocation()
      });
    } catch {
      // The entity can invalidate between the query and head-location read.
    }
  }
  return candidates;
}

export function getTreeImpactDamage(treeSpeedBlocksPerSecond: number): number {
  if (
    !Number.isFinite(treeSpeedBlocksPerSecond)
    || treeSpeedBlocksPerSecond <= 0
  ) return 0;
  const equivalentFallDistance = treeSpeedBlocksPerSecond
    * treeSpeedBlocksPerSecond
    / (2 * TREE_IMPACT_REFERENCE_GRAVITY);
  const damage = equivalentFallDistance - TREE_IMPACT_SAFE_FALL_DISTANCE;
  if (damage <= 0) return 0;
  return Math.min(MAX_TREE_IMPACT_DAMAGE, damage);
}

export function canTreeReachDamageSpeed(
  tree: ContraptionState,
  currentPose: SavedPose,
  bounds: PhysicsBodyAabb
): boolean {
  const body = tree.contraption.body;
  const centerOfMass = body.localPointToWorld(body.getCenterOfMass());
  const instantaneousRadius = Math.hypot(
    Math.max(
      Math.abs(bounds.min.x - centerOfMass.x),
      Math.abs(bounds.max.x - centerOfMass.x)
    ),
    Math.max(
      Math.abs(bounds.min.y - centerOfMass.y),
      Math.abs(bounds.max.y - centerOfMass.y)
    ),
    Math.max(
      Math.abs(bounds.min.z - centerOfMass.z),
      Math.abs(bounds.max.z - centerOfMass.z)
    )
  );
  const linearVelocity = body.getVelocityAt(centerOfMass);
  const linearSpeed = Math.hypot(linearVelocity.x, linearVelocity.y, linearVelocity.z);
  const angularSpeed = Math.hypot(
    body.angularVelocity.x,
    body.angularVelocity.y,
    body.angularVelocity.z
  );
  if (linearSpeed + angularSpeed * instantaneousRadius > TREE_IMPACT_MIN_SPEED) return true;

  const sweptRadius = Math.hypot(
    Math.max(
      Math.abs(bounds.min.x - currentPose.location.x),
      Math.abs(bounds.max.x - currentPose.location.x)
    ),
    Math.max(
      Math.abs(bounds.min.y - currentPose.location.y),
      Math.abs(bounds.max.y - currentPose.location.y)
    ),
    Math.max(
      Math.abs(bounds.min.z - currentPose.location.z),
      Math.abs(bounds.max.z - currentPose.location.z)
    )
  );
  const translationSpeed = Math.hypot(
    currentPose.location.x - tree.damagePose.location.x,
    currentPose.location.y - tree.damagePose.location.y,
    currentPose.location.z - tree.damagePose.location.z
  ) * PHYSICS_TICKS_PER_SECOND;
  const sweptAngularSpeed = (
    Math.abs(currentPose.rotation.x - tree.damagePose.rotation.x)
    + Math.abs(currentPose.rotation.y - tree.damagePose.rotation.y)
    + Math.abs(currentPose.rotation.z - tree.damagePose.rotation.z)
  ) * Math.PI / 180 * PHYSICS_TICKS_PER_SECOND;
  return translationSpeed + sweptAngularSpeed * sweptRadius > TREE_IMPACT_MIN_SPEED;
}

export function vectorLengthSquared(value: Vector3): number {
  return value.x * value.x + value.y * value.y + value.z * value.z;
}

function isDamageableTreeTarget(entity: Entity): boolean {
  if (!entity.isValid) return false;
  if (entity.typeId === "minecraft:item" || CONTRAPTION_RENDER_ENTITY_TYPE_IDS.has(entity.typeId)) {
    return false;
  }
  try {
    return entity.getComponent("minecraft:health") !== undefined;
  } catch {
    return false;
  }
}

export function findDamageLogContact(
  logs: ReadonlyMap<string, Vector3>,
  localStart: Vector3,
  localEnd: Vector3
): DamageLogContact | undefined {
  if (!isVector(localStart) || !isVector(localEnd)) return undefined;
  const start = {
    x: localStart.x + 0.5,
    y: localStart.y + 0.5,
    z: localStart.z + 0.5
  };
  const end = {
    x: localEnd.x + 0.5,
    y: localEnd.y + 0.5,
    z: localEnd.z + 0.5
  };
  const delta = subtract(end, start);
  let x = Math.floor(start.x);
  let y = Math.floor(start.y);
  let z = Math.floor(start.z);
  const endX = Math.floor(end.x);
  const endY = Math.floor(end.y);
  const endZ = Math.floor(end.z);
  const stepX = Math.sign(delta.x);
  const stepY = Math.sign(delta.y);
  const stepZ = Math.sign(delta.z);
  const deltaTX = stepX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / delta.x);
  const deltaTY = stepY === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / delta.y);
  const deltaTZ = stepZ === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / delta.z);
  let maxTX = firstVoxelBoundaryTime(start.x, x, delta.x, stepX);
  let maxTY = firstVoxelBoundaryTime(start.y, y, delta.y, stepY);
  let maxTZ = firstVoxelBoundaryTime(start.z, z, delta.z, stepZ);
  const maximumVisits = Math.abs(endX - x) + Math.abs(endY - y) + Math.abs(endZ - z) + 1;

  for (let visit = 0; visit < maximumVisits; visit++) {
    const logLocation = logs.get(`${x},${y},${z}`);
    if (logLocation) return { logLocation };
    if (x === endX && y === endY && z === endZ) break;
    const nextTime = Math.min(maxTX, maxTY, maxTZ);
    if (maxTX <= nextTime + 1e-12) {
      x += stepX;
      maxTX += deltaTX;
    }
    if (maxTY <= nextTime + 1e-12) {
      y += stepY;
      maxTY += deltaTY;
    }
    if (maxTZ <= nextTime + 1e-12) {
      z += stepZ;
      maxTZ += deltaTZ;
    }
  }
  return undefined;
}

function firstVoxelBoundaryTime(
  coordinate: number,
  voxel: number,
  delta: number,
  step: number
): number {
  if (step === 0) return Number.POSITIVE_INFINITY;
  const boundary = step > 0 ? voxel + 1 : voxel;
  return (boundary - coordinate) / delta;
}

export function horizontalDirection(from: Vector3, to: Vector3, velocity: Vector3): Vector3 {
  let x = to.x - from.x;
  let z = to.z - from.z;
  let length = Math.hypot(x, z);
  if (length < 0.0001) {
    x = velocity.x;
    z = velocity.z;
    length = Math.hypot(x, z);
  }
  return length < 0.0001
    ? { x: 0, y: 0, z: 0 }
    : { x: x / length, y: 0, z: z / length };
}

export function getTreePoseVelocityAt(
  previousPose: SavedPose,
  currentWorldLocation: Vector3,
  localLocation: Vector3
): Vector3 {
  const previousOffset = rotateVectorByEulerDegreesYzx(
    localLocation,
    previousPose.rotation
  );
  return {
    x: (currentWorldLocation.x - previousPose.location.x - previousOffset.x)
      * PHYSICS_TICKS_PER_SECOND,
    y: (currentWorldLocation.y - previousPose.location.y - previousOffset.y)
      * PHYSICS_TICKS_PER_SECOND,
    z: (currentWorldLocation.z - previousPose.location.z - previousOffset.z)
      * PHYSICS_TICKS_PER_SECOND
  };
}
