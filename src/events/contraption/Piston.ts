import {
  system,
  world,
  type Block,
  type BlockPistonComponent,
  type Dimension,
  type Vector3
} from "@minecraft/server";
import type { PhysicsBodyAabb } from "@src/Physics";
import { ContraptionExternalEffectsController } from "@src/content/contraption/effects/Controller";
import {
  PISTON_PLAYER_IMPULSE_MULTIPLIER,
  SLIME_PISTON_PLAYER_IMPULSE_MULTIPLIER
} from "@src/content/contraption/effects/Math";

const PISTON_PUSH_BLOCK_LIMIT = 12;
const PISTON_CONTACT_MARGIN = 0.08;
const PISTON_FRONT_REACH = 0.16;
const PISTON_REAR_REACH = 0.08;
const SLIME_BLOCK_TYPE_ID = "minecraft:slime";
const PISTON_MECHANISM_BLOCK_TYPE_IDS = new Set([
  "minecraft:moving_block",
  "minecraft:moving_piston",
  "minecraft:piston_arm_collision",
  "minecraft:piston_head"
]);

interface AttachedBlockSnapshot {
  location: Vector3;
  typeId: string;
}
export function installPistonContraptionPhysics(
  effects: ContraptionExternalEffectsController,
  markMovedBlock: (block: Block) => void,
  onWorldBlocksChanged?: (dimension: Dimension, locations: readonly Vector3[]) => void,
  onWorldBlockMoved?: (
    dimension: Dimension,
    from: Vector3,
    to: Vector3,
    block: Block
  ) => void
): void {
  world.afterEvents.pistonActivate.subscribe(event => {
    const direction = getPistonDirection(event.block);
    if (!direction) return;
    // Location snapshots define force-transfer cells independently from the
    // block handles used for tree bookkeeping and material metadata.
    const attachedLocations = getAttachedBlockLocations(event.piston);
    const recordedMovingBlockKeys = new Set<string>();
    const recordMovedBlock = (block: Block): void => {
      const key = getLocationKey(block.location);
      if (recordedMovingBlockKeys.has(key)) return;
      recordedMovingBlockKeys.add(key);
      markMovedBlock(block);
    };
    const attachedBlocks: AttachedBlockSnapshot[] = [];
    for (const block of event.piston.getAttachedBlocks()) {
      attachedBlocks.push(getAttachedBlockSnapshot(block));
      recordMovedBlock(block);
    }
    const pistonLocation = clone(event.block.location);
    const movedBlockLocations: Vector3[] = [];
    const axisMovingLocations = event.isExpanding
      ? getPistonAxisMovingLocations(
        event.dimension,
        pistonLocation,
        direction,
        recordMovedBlock,
        movedBlockLocations
      )
      : [];
    if (event.isExpanding && onWorldBlockMoved) {
      movedBlockLocations.push(...attachedLocations);
      const movedLocations = deduplicateLocations(movedBlockLocations);
      system.run(() => synchronizeMovedBlocks(
        event.dimension,
        movedLocations,
        direction,
        onWorldBlockMoved
      ));
    }
    if (onWorldBlocksChanged) {
      const changedLocations = deduplicateLocations([
        pistonLocation,
        offset(pistonLocation, direction),
        ...axisMovingLocations,
        ...attachedLocations.flatMap(location => [
          location,
          offset(location, direction),
          offset(location, negate(direction))
        ])
      ]);
      notifyWorldBlocksChanged(onWorldBlocksChanged, event.dimension, changedLocations);
      system.run(() => {
        notifyWorldBlocksChanged(onWorldBlocksChanged, event.dimension, changedLocations);
      });
    }
    if (!event.isExpanding) return;
    const lateralAttachedLocations = attachedLocations.filter(location => (
      !isPistonAxisLocation(location, pistonLocation, direction)
    ));
    const movingLocations = deduplicateLocations([
      ...axisMovingLocations,
      ...lateralAttachedLocations
    ]);
    const frontLocations = findPistonFrontLocations(movingLocations, direction);
    const fronts = frontLocations.map(location => createPistonFrontBounds(location, direction));
    effects.queuePiston({
      dimension: event.dimension,
      direction,
      playerImpulseMultiplier: isPistonFrontSlime(frontLocations, attachedBlocks)
        ? SLIME_PISTON_PLAYER_IMPULSE_MULTIPLIER
        : PISTON_PLAYER_IMPULSE_MULTIPLIER,
      key: createPistonEventKey(pistonLocation, direction),
      separationPadding: PISTON_FRONT_REACH,
      fronts
    });
  });
}

function notifyWorldBlocksChanged(
  callback: ((dimension: Dimension, locations: readonly Vector3[]) => void) | undefined,
  dimension: Dimension,
  locations: readonly Vector3[]
): void {
  if (!callback || locations.length === 0) return;
  try {
    callback(dimension, locations);
  } catch {
    // Cache invalidation must not suppress piston impulses.
  }
}

// Unit push directions indexed by the piston facing_direction state value (0-5).
const PISTON_FACING_DIRECTIONS: readonly Vector3[] = [
  { x: 0, y: -1, z: 0 }, // down
  { x: 0, y: 1, z: 0 },  // up
  { x: 0, y: 0, z: 1 },  // south
  { x: 0, y: 0, z: -1 }, // north
  { x: 1, y: 0, z: 0 },  // east
  { x: -1, y: 0, z: 0 }  // west
];

function getPistonDirection(block: Block): Vector3 | undefined {
  const state = block.permutation.getState("facing_direction");
  if (typeof state !== "number") return undefined;
  const direction = PISTON_FACING_DIRECTIONS[state];
  // Copy so every caller keeps getting its own fresh vector.
  return direction ? { ...direction } : undefined;
}

function createPistonFrontBounds(
  location: Vector3,
  direction: Vector3
): PhysicsBodyAabb {
  const min = {
    x: location.x - PISTON_CONTACT_MARGIN,
    y: location.y - PISTON_CONTACT_MARGIN,
    z: location.z - PISTON_CONTACT_MARGIN
  };
  const max = {
    x: location.x + 1 + PISTON_CONTACT_MARGIN,
    y: location.y + 1 + PISTON_CONTACT_MARGIN,
    z: location.z + 1 + PISTON_CONTACT_MARGIN
  };
  if (direction.x > 0) {
    min.x = location.x + 1 - PISTON_REAR_REACH;
    max.x = location.x + 1 + PISTON_FRONT_REACH;
  } else if (direction.x < 0) {
    min.x = location.x - PISTON_FRONT_REACH;
    max.x = location.x + PISTON_REAR_REACH;
  } else if (direction.y > 0) {
    min.y = location.y + 1 - PISTON_REAR_REACH;
    max.y = location.y + 1 + PISTON_FRONT_REACH;
  } else if (direction.y < 0) {
    min.y = location.y - PISTON_FRONT_REACH;
    max.y = location.y + PISTON_REAR_REACH;
  } else if (direction.z > 0) {
    min.z = location.z + 1 - PISTON_REAR_REACH;
    max.z = location.z + 1 + PISTON_FRONT_REACH;
  } else {
    min.z = location.z - PISTON_FRONT_REACH;
    max.z = location.z + PISTON_REAR_REACH;
  }
  return { min, max };
}

function findPistonFrontLocations(
  movingLocations: readonly Vector3[],
  direction: Vector3
): Vector3[] {
  // A moving cell contributes force only when no other moving cell covers its
  // forward face. This keeps straight chains and slime branches on one path.
  const movingLocationKeys = new Set(movingLocations.map(getLocationKey));
  return movingLocations.filter(location => (
    !movingLocationKeys.has(getLocationKey(offset(location, direction)))
  ));
}

function getPistonAxisMovingLocations(
  dimension: Dimension,
  pistonLocation: Vector3,
  direction: Vector3,
  markMovedBlock: (block: Block) => void,
  movedBlockLocations: Vector3[]
): Vector3[] {
  const locations = [offset(pistonLocation, direction)];
  const firstBlock = dimension.getBlock(locations[0]!);
  if (!firstBlock) {
    throw new Error(`Piston axis block ${getLocationKey(locations[0]!)} is unavailable.`);
  }
  if (
    !firstBlock.isAir
    && !firstBlock.isLiquid
    && !PISTON_MECHANISM_BLOCK_TYPE_IDS.has(firstBlock.typeId)
  ) {
    markMovedBlock(firstBlock);
    movedBlockLocations.push(locations[0]!);
  }
  // The first cell is occupied by either the extending head or the first block
  // before movement. Scan the remaining vanilla push distance from the world.
  for (let distance = 2; distance <= PISTON_PUSH_BLOCK_LIMIT + 1; distance++) {
    const location = offsetByDistance(pistonLocation, direction, distance);
    const block = dimension.getBlock(location);
    if (!block) {
      throw new Error(`Piston axis block ${getLocationKey(location)} is unavailable.`);
    }
    if (block.isAir || block.isLiquid) break;
    locations.push(location);
    if (!PISTON_MECHANISM_BLOCK_TYPE_IDS.has(block.typeId)) {
      markMovedBlock(block);
      movedBlockLocations.push(location);
    }
  }
  return locations;
}

function synchronizeMovedBlocks(
  dimension: Dimension,
  fromLocations: readonly Vector3[],
  direction: Vector3,
  onWorldBlockMoved: (
    dimension: Dimension,
    from: Vector3,
    to: Vector3,
    block: Block
  ) => void
): void {
  for (const from of fromLocations) {
    const to = offset(from, direction);
    const block = dimension.getBlock(to);
    if (!block) {
      throw new Error(`Moved piston block ${getLocationKey(to)} is unavailable.`);
    }
    onWorldBlockMoved(dimension, from, to, block);
  }
}

function isPistonAxisLocation(
  location: Vector3,
  pistonLocation: Vector3,
  direction: Vector3
): boolean {
  if (direction.x !== 0) {
    return location.y === pistonLocation.y && location.z === pistonLocation.z;
  }
  if (direction.y !== 0) {
    return location.x === pistonLocation.x && location.z === pistonLocation.z;
  }
  return location.x === pistonLocation.x && location.y === pistonLocation.y;
}

function getAttachedBlockLocations(piston: BlockPistonComponent): Vector3[] {
  return piston.getAttachedBlocksLocations().map(clone);
}

function getAttachedBlockSnapshot(block: Block): AttachedBlockSnapshot {
  return { location: clone(block.location), typeId: block.typeId };
}

function isPistonFrontSlime(
  frontLocations: readonly Vector3[],
  blocks: readonly AttachedBlockSnapshot[]
): boolean {
  const frontLocationKeys = new Set(frontLocations.map(getLocationKey));
  return blocks.some(block => (
    frontLocationKeys.has(getLocationKey(block.location))
    && isSlimeBlockTypeId(block.typeId)
  ));
}

function isSlimeBlockTypeId(typeId: string): boolean {
  return typeId === SLIME_BLOCK_TYPE_ID;
}

function createPistonEventKey(
  location: Vector3,
  direction: Vector3
): string {
  return `${location.x},${location.y},${location.z}|${direction.x},${direction.y},${direction.z}`;
}

function deduplicateLocations(locations: readonly Vector3[]): Vector3[] {
  const byKey = new Map<string, Vector3>();
  for (const location of locations) {
    byKey.set(getLocationKey(location), location);
  }
  return [...byKey.values()];
}

function getLocationKey(location: Vector3): string {
  return `${location.x},${location.y},${location.z}`;
}

function offset(location: Vector3, direction: Vector3): Vector3 {
  return offsetByDistance(location, direction, 1);
}

function offsetByDistance(
  location: Vector3,
  direction: Vector3,
  distance: number
): Vector3 {
  return {
    x: location.x + direction.x * distance,
    y: location.y + direction.y * distance,
    z: location.z + direction.z * distance
  };
}

function negate(value: Vector3): Vector3 {
  return { x: -value.x, y: -value.y, z: -value.z };
}

function clone(location: Vector3): Vector3 {
  return { x: location.x, y: location.y, z: location.z };
}
