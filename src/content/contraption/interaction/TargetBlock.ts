import {
  BlockPermutation,
  system,
  type Block,
  type Dimension,
  type Vector3
} from "@minecraft/server";
import { EPSILON_1E8, vectorsEqual } from "@src/utils/Vector3Math";

// Intentionally re-declared as a local constant in physics/world/BlockClassification.ts:
// the physics bundle must not import gameplay modules, so each side of the
// runtime bundle boundary keeps its own copy of this block id.
export const INTERACTION_TARGET_BLOCK_TYPE_ID = "treephysics:interaction_target";
const INTERACTION_TARGET_COMPONENT_ID = "treephysics:interaction_target_cleanup";

const WATER_KIND_STATE = "treephysics:water_kind";
const WATER_DEPTH_STATE = "treephysics:water_depth";
const TARGET_OFFSET_AXIS_STEPS = 4;
const TARGET_LOCATION_EPSILON = 1e-7;
// These existing four values keep the proxy search finite while the proxy
// itself stays in a regular world cell.
const TARGET_OFFSET_VALUES: readonly number[] = [-1, -1 / 3, 1 / 3, 1];
// Source liquid type ids indexed by the persisted water-kind state value
// (0 = air); the same table drives encoding, decoding, and source matching.
const WATER_KIND_TYPE_IDS: readonly (string | undefined)[] = [
  undefined,
  "minecraft:water",
  "minecraft:flowing_water"
];
interface ActiveTargetCell {
  readonly dimension: Dimension;
  readonly holders: Set<string>;
  readonly sourceLocation: Vector3;
  readonly proxyLocation: Vector3;
  readonly originalPermutation: BlockPermutation;
  readonly targetBlockTypeId: string;
  readonly waterDepth: number;
  readonly waterKind: number;
}

interface TargetCandidate {
  readonly block: Block;
  readonly location: Vector3;
}

interface TargetSyncState {
  readonly dimensionId: string;
  readonly sourceLocation: Vector3;
  readonly proxyLocation: Vector3;
  readonly direction: Vector3;
}

/**
 * Owns the temporary real blocks that expose moving contraption cells to native
 * block interaction. Contraption targeting and edit semantics remain in the
 * outline and player-interaction controllers.
 */
export class InteractionTargetBlockController {
  readonly #activeCells = new Map<string, ActiveTargetCell>();
  readonly #cellByPlayer = new Map<string, string>();
  readonly #syncStateByPlayer = new Map<string, TargetSyncState>();
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    system.beforeEvents.startup.subscribe(event => {
      event.blockComponentRegistry.registerCustomComponent(
        INTERACTION_TARGET_COMPONENT_ID,
        {
          onTick: tickEvent => {
            const key = targetCellKey(
              tickEvent.dimension.id,
              tickEvent.block.location
            );
            if (!this.#activeCells.has(key)) restoreOrphanInteractionTargetBlock(tickEvent.block);
          }
        }
      );
    });
  }

  isManagedBlock(dimension: Dimension, block: Block): boolean {
    const record = this.#activeCells.get(targetCellKey(dimension.id, block.location));
    return record?.targetBlockTypeId === block.typeId;
  }

  syncPlayer(
    playerId: string,
    dimension: Dimension,
    playerHead: Vector3,
    hitLocation: Vector3,
    direction: Vector3,
    useHeadAnchor: boolean
  ): void {
    // Keep the physical hit cell as the source. Desktop places the native
    // interaction proxy in the first world cell crossed after leaving it,
    // while touch anchors the proxy to the player's head cell.
    const sourceLocation = blockLocation({
      x: hitLocation.x - direction.x * TARGET_LOCATION_EPSILON,
      y: hitLocation.y - direction.y * TARGET_LOCATION_EPSILON,
      z: hitLocation.z - direction.z * TARGET_LOCATION_EPSILON
    });
    const proxyLocation = useHeadAnchor
      ? blockLocation(playerHead)
      : findRayTargetOffset(playerHead, direction, sourceLocation);
    if (!proxyLocation) {
      this.releasePlayer(playerId);
      return;
    }
    const syncState: TargetSyncState = {
      dimensionId: dimension.id,
      sourceLocation,
      proxyLocation,
      direction: { ...direction }
    };
    const currentKey = this.#cellByPlayer.get(playerId);
    const current = currentKey ? this.#activeCells.get(currentKey) : undefined;
    if (
      current
      && targetSyncStatesEqual(this.#syncStateByPlayer.get(playerId), syncState)
      && dimension.getBlock(current.proxyLocation)?.typeId === current.targetBlockTypeId
    ) return;

    const candidate = this.#findAvailableCandidate(dimension, proxyLocation);
    const candidateLocation = candidate?.location;
    const nextKey = candidateLocation
      ? targetCellKey(dimension.id, candidateLocation)
      : undefined;
    if (
      currentKey === nextKey
      && current
      && vectorsEqual(current.sourceLocation, sourceLocation)
    ) {
      if (!nextKey || candidate?.block.typeId === current?.targetBlockTypeId) {
        this.#syncStateByPlayer.set(playerId, syncState);
        return;
      }
    }

    this.releasePlayer(playerId);
    if (!candidate || !candidateLocation || !nextKey) return;

    let shared = this.#activeCells.get(nextKey);
    if (shared && candidate.block.typeId !== shared.targetBlockTypeId) {
      this.#discardOwnership(nextKey, shared);
      shared = undefined;
    }
    if (shared) {
      if (!vectorsEqual(shared.sourceLocation, sourceLocation)) return;
      shared.holders.add(playerId);
      this.#cellByPlayer.set(playerId, nextKey);
      this.#syncStateByPlayer.set(playerId, syncState);
      return;
    }

    const block = candidate.block;
    if (!isReplaceableTargetSource(block)) return;
    // Kind 0 routes air through the same custom target-block path as water.
    const water = block.isAir
      ? { depth: 0, kind: 0 }
      : getSourceWaterState(block);
    const record: ActiveTargetCell = {
      dimension,
      holders: new Set([playerId]),
      sourceLocation: { ...sourceLocation },
      proxyLocation: { ...candidateLocation },
      originalPermutation: block.permutation,
      targetBlockTypeId: INTERACTION_TARGET_BLOCK_TYPE_ID,
      waterDepth: water.depth,
      waterKind: water.kind
    };

    setInteractionTargetPermutation(block, water);
    this.#activeCells.set(nextKey, record);
    this.#cellByPlayer.set(playerId, nextKey);
    this.#syncStateByPlayer.set(playerId, syncState);
  }

  releasePlayer(playerId: string): void {
    this.#syncStateByPlayer.delete(playerId);
    const key = this.#cellByPlayer.get(playerId);
    if (!key) return;
    this.#cellByPlayer.delete(playerId);
    const record = this.#activeCells.get(key);
    if (!record) {
      throw new Error(`Missing active interaction-target cell for player ${playerId}.`);
    }
    record.holders.delete(playerId);
    if (record.holders.size !== 0) return;

    this.#activeCells.delete(key);
    const block = record.dimension.getBlock(record.proxyLocation);
    // Never overwrite a world change made by another system after ownership was lost.
    if (block?.typeId !== record.targetBlockTypeId) return;
    block.setPermutation(record.originalPermutation);
  }

  /** Resolve exactly one requested cell; occupied cells do not search their neighbors. */
  #findAvailableCandidate(dimension: Dimension, location: Vector3): TargetCandidate | undefined {
    const block = dimension.getBlock(location);
    if (!block) return undefined;
    const key = targetCellKey(dimension.id, location);
    let active = this.#activeCells.get(key);
    if (active && active.targetBlockTypeId !== block.typeId) {
      this.#discardOwnership(key, active);
      active = undefined;
    }
    if (!isReplaceableTargetSource(block) && active?.targetBlockTypeId !== block.typeId) {
      return undefined;
    }
    return { block, location };
  }

  #discardOwnership(key: string, record: ActiveTargetCell): void {
    this.#activeCells.delete(key);
    for (const playerId of record.holders) {
      if (this.#cellByPlayer.get(playerId) === key) this.#cellByPlayer.delete(playerId);
      this.#syncStateByPlayer.delete(playerId);
    }
  }
}

function targetSyncStatesEqual(
  left: TargetSyncState | undefined,
  right: TargetSyncState
): boolean {
  return left !== undefined
    && left.dimensionId === right.dimensionId
    && vectorsEqual(left.sourceLocation, right.sourceLocation)
    && vectorsEqual(left.proxyLocation, right.proxyLocation)
    && vectorsEqual(left.direction, right.direction);
}

function blockLocation(point: Vector3): Vector3 {
  return {
    x: Math.floor(point.x),
    y: Math.floor(point.y),
    z: Math.floor(point.z)
  };
}

export function restoreOrphanInteractionTargetBlock(block: Block): void {
  if (block.typeId !== INTERACTION_TARGET_BLOCK_TYPE_ID) return;
  const states = block.permutation.getAllStates();
  const kind = states[WATER_KIND_STATE];
  const depth = states[WATER_DEPTH_STATE];
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 2) {
    throw new Error(`Invalid interaction-target water kind: ${String(kind)}.`);
  }
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 15) {
    throw new Error(`Invalid interaction-target water depth: ${String(depth)}.`);
  }
  const typeId = WATER_KIND_TYPE_IDS[kind];
  if (typeId === undefined) {
    block.setType("minecraft:air");
    return;
  }
  block.setPermutation(BlockPermutation.resolve(typeId, { liquid_depth: depth }));
}

function isReplaceableTargetSource(block: Block): boolean {
  return block.isAir || WATER_KIND_TYPE_IDS.includes(block.typeId);
}

function getSourceWaterState(block: Block): { depth: number; kind: number } {
  const depth = block.permutation.getAllStates().liquid_depth;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 15) {
    throw new Error(`${block.typeId} has an invalid liquid_depth state: ${String(depth)}.`);
  }
  return {
    depth,
    // The single caller filters through isReplaceableTargetSource first, so the
    // type id is always present in the table (kind 1 or 2).
    kind: WATER_KIND_TYPE_IDS.indexOf(block.typeId)
  };
}

function findInteractionProxyLocation(
  origin: Vector3,
  direction: Vector3,
  sourceLocation: Vector3
): Vector3 {
  // Move the proxy across the first source-cell boundary reached by the ray.
  const exitDistance = raySelectionLength(
    origin,
    direction,
    sourceLocation,
    0,
    0,
    0
  );
  return blockLocation({
    x: origin.x + direction.x * (exitDistance + TARGET_LOCATION_EPSILON),
    y: origin.y + direction.y * (exitDistance + TARGET_LOCATION_EPSILON),
    z: origin.z + direction.z * (exitDistance + TARGET_LOCATION_EPSILON)
  });
}

function findRayTargetOffset(
  origin: Vector3,
  direction: Vector3,
  location: Vector3
): Vector3 | undefined {
  const originInsideSource = isTargetBoxContainingPoint(origin, location, 0, 0, 0);
  if (
    !originInsideSource
    && raySelectionLength(origin, direction, location, 0, 0, 0) >= 0
  ) return { ...location };

  let bestLength = -1;
  for (let z = 0; z < TARGET_OFFSET_AXIS_STEPS; z++) {
    for (let y = 0; y < TARGET_OFFSET_AXIS_STEPS; y++) {
      for (let x = 0; x < TARGET_OFFSET_AXIS_STEPS; x++) {
        const offsetX = TARGET_OFFSET_VALUES[x]!;
        const offsetY = TARGET_OFFSET_VALUES[y]!;
        const offsetZ = TARGET_OFFSET_VALUES[z]!;
        if (isTargetBoxContainingPoint(origin, location, offsetX, offsetY, offsetZ)) continue;
        const length = raySelectionLength(
          origin,
          direction,
          location,
          offsetX,
          offsetY,
          offsetZ
        );
        if (length > bestLength) {
          bestLength = length;
        }
      }
    }
  }
  if (bestLength < 0) return undefined;
  return originInsideSource
    ? findInteractionProxyLocation(origin, direction, location)
    : { ...location };
}

function isTargetBoxContainingPoint(
  point: Vector3,
  location: Vector3,
  offsetX: number,
  offsetY: number,
  offsetZ: number
): boolean {
  return point.x > location.x + offsetX
    && point.x < location.x + offsetX + 1
    && point.y > location.y + offsetY
    && point.y < location.y + offsetY + 1
    && point.z > location.z + offsetZ
    && point.z < location.z + offsetZ + 1;
}

function raySelectionLength(
  origin: Vector3,
  direction: Vector3,
  location: Vector3,
  offsetX: number,
  offsetY: number,
  offsetZ: number
): number {
  let entry = Number.NEGATIVE_INFINITY;
  let exit = Number.POSITIVE_INFINITY;

  const minimumX = location.x + offsetX;
  const maximumX = minimumX + 1;
  if (Math.abs(direction.x) < EPSILON_1E8) {
    if (origin.x < minimumX || origin.x > maximumX) return -1;
  } else {
    const first = (minimumX - origin.x) / direction.x;
    const second = (maximumX - origin.x) / direction.x;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (exit < entry) return -1;
  }

  const minimumY = location.y + offsetY;
  const maximumY = minimumY + 1;
  if (Math.abs(direction.y) < EPSILON_1E8) {
    if (origin.y < minimumY || origin.y > maximumY) return -1;
  } else {
    const first = (minimumY - origin.y) / direction.y;
    const second = (maximumY - origin.y) / direction.y;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (exit < entry) return -1;
  }

  const minimumZ = location.z + offsetZ;
  const maximumZ = minimumZ + 1;
  if (Math.abs(direction.z) < EPSILON_1E8) {
    if (origin.z < minimumZ || origin.z > maximumZ) return -1;
  } else {
    const first = (minimumZ - origin.z) / direction.z;
    const second = (maximumZ - origin.z) / direction.z;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (exit < entry) return -1;
  }

  const forwardEntry = Math.max(entry, 0);
  return exit <= forwardEntry + EPSILON_1E8 ? -1 : exit - forwardEntry;
}

function setInteractionTargetPermutation(
  block: Block,
  water: { depth: number; kind: number }
): void {
  block.setPermutation(BlockPermutation.resolve(INTERACTION_TARGET_BLOCK_TYPE_ID, {
    [WATER_DEPTH_STATE]: water.depth,
    [WATER_KIND_STATE]: water.kind
  }));
  if (water.kind !== 0) block.setWaterlogged(true);
}

function targetCellKey(dimensionId: string, location: Vector3): string {
  return `${dimensionId}|${location.x},${location.y},${location.z}`;
}
