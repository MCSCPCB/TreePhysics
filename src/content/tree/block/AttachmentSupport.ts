import type { Vector3 } from "@minecraft/server";
import type { CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import { blockKey as locationKey } from "@src/utils/BlockKey";
import { add } from "@src/utils/Vector3Math";

export interface TreeAttachmentSupportEntry {
  readonly key: string;
  readonly localLocation: Vector3;
  readonly snapshot: CapturedTreeBlock;
}

export interface TreeAttachmentStateUpdate {
  readonly key: string;
  readonly snapshot: CapturedTreeBlock;
}

export interface TreeAttachmentSupportResolution {
  readonly stateUpdates: ReadonlyMap<string, TreeAttachmentStateUpdate>;
  readonly supportKeysByAttachment: ReadonlyMap<string, readonly string[]>;
  readonly unsupportedKeys: ReadonlySet<string>;
}

const ABOVE_OFFSET: Vector3 = { x: 0, y: 1, z: 0 };
const BELOW_OFFSET: Vector3 = { x: 0, y: -1, z: 0 };

// Bedrock's cocoa direction and vine-direction bits use the same quarter-turn
// order: south, west, north, east.
const HORIZONTAL_SUPPORTS = [
  { bit: 1, offset: { x: 0, y: 0, z: 1 } },
  { bit: 2, offset: { x: -1, y: 0, z: 0 } },
  { bit: 4, offset: { x: 0, y: 0, z: -1 } },
  { bit: 8, offset: { x: 1, y: 0, z: 0 } }
] as const;

/**
 * Resolves native attachment support after a structural edit. Attachment
 * dependencies only point to a side host or the block above, so a top-down
 * pass resolves an entire hanging chain without repeated full scans.
 */
export function resolveTreeAttachmentSupport(
  entries: readonly TreeAttachmentSupportEntry[],
  removedKeys: ReadonlySet<string> = new Set()
): TreeAttachmentSupportResolution {
  const entriesByKey = new Map<string, TreeAttachmentSupportEntry>();
  for (const entry of entries) {
    if (entry.key !== locationKey(entry.localLocation)) {
      throw new Error(`Tree attachment support entry ${entry.key} has a mismatched location.`);
    }
    if (entriesByKey.has(entry.key)) {
      throw new RangeError(`Duplicate tree attachment support entry ${entry.key}.`);
    }
    entriesByKey.set(entry.key, entry);
  }

  const unsupportedKeys = new Set<string>();
  const stateUpdates = new Map<string, TreeAttachmentStateUpdate>();
  const supportKeysByAttachment = new Map<string, readonly string[]>();
  const attachments = entries
    .filter(entry => entry.snapshot.kind === "attachment" && !removedKeys.has(entry.key))
    .sort((left, right) => right.localLocation.y - left.localLocation.y);
  for (const entry of attachments) {
    if (
      removedKeys.has(entry.key)
      || unsupportedKeys.has(entry.key)
    ) continue;
    const snapshot = entry.snapshot;
    const result = resolveAttachment(
      entry.localLocation,
      snapshot,
      entriesByKey,
      removedKeys,
      unsupportedKeys,
      stateUpdates
    );
    if (!result.supported) {
      unsupportedKeys.add(entry.key);
      continue;
    }
    if (result.states && !statesEqual(snapshot.states, result.states)) {
      stateUpdates.set(entry.key, {
        key: entry.key,
        snapshot: { ...snapshot, states: result.states }
      });
    }
    supportKeysByAttachment.set(entry.key, result.supportKeys);
  }
  return { stateUpdates, supportKeysByAttachment, unsupportedKeys };
}

interface AttachmentResolution {
  readonly states?: CapturedTreeBlock["states"];
  readonly supported: boolean;
  readonly supportKeys: readonly string[];
}

function resolveAttachment(
  location: Vector3,
  snapshot: CapturedTreeBlock,
  entriesByKey: ReadonlyMap<string, TreeAttachmentSupportEntry>,
  removedKeys: ReadonlySet<string>,
  unsupportedKeys: ReadonlySet<string>,
  stateUpdates: ReadonlyMap<string, TreeAttachmentStateUpdate>
): AttachmentResolution {
  const read = (key: string): CapturedTreeBlock | undefined => {
    if (removedKeys.has(key) || unsupportedKeys.has(key)) return undefined;
    return stateUpdates.get(key)?.snapshot ?? entriesByKey.get(key)?.snapshot;
  };
  const keyAt = (offset: Vector3): string => locationKey(add(location, offset));
  switch (snapshot.typeId) {
    case "minecraft:bee_nest":
      return { supported: true, supportKeys: [] };
    case "minecraft:cocoa": {
      const direction = integerState(snapshot, "direction", 0, 3);
      const supportKey = keyAt(HORIZONTAL_SUPPORTS[direction]!.offset);
      return {
        supported: read(supportKey)?.kind === "log",
        supportKeys: [supportKey]
      };
    }
    case "minecraft:hanging_roots": {
      const supportKey = keyAt(ABOVE_OFFSET);
      return {
        supported: isSolidAttachmentHost(read(supportKey)),
        supportKeys: [supportKey]
      };
    }
    case "minecraft:mangrove_propagule": {
      const hanging = stateValue(snapshot, "hanging");
      if (hanging !== true && hanging !== 1) {
        return { supported: true, supportKeys: [] };
      }
      const supportKey = keyAt(ABOVE_OFFSET);
      return {
        supported: read(supportKey)?.kind === "leaf",
        supportKeys: [supportKey]
      };
    }
    case "minecraft:pale_hanging_moss": {
      const supportKey = keyAt(ABOVE_OFFSET);
      const support = read(supportKey);
      const supported = support?.typeId === "minecraft:pale_hanging_moss"
        || isSolidAttachmentHost(support);
      const below = read(keyAt(BELOW_OFFSET));
      const tip = below?.typeId !== "minecraft:pale_hanging_moss";
      return {
        states: replaceState(snapshot, "tip", tip),
        supported,
        supportKeys: [supportKey]
      };
    }
    case "minecraft:vine": {
      const currentBits = integerState(snapshot, "vine_direction_bits", 0, 15);
      const aboveKey = keyAt(ABOVE_OFFSET);
      const above = read(aboveKey);
      const aboveBits = above?.typeId === "minecraft:vine"
        ? integerState(above, "vine_direction_bits", 0, 15)
        : 0;
      let retainedBits = 0;
      const supportKeys: string[] = [];
      for (const direction of HORIZONTAL_SUPPORTS) {
        if ((currentBits & direction.bit) === 0) continue;
        const sideKey = keyAt(direction.offset);
        if (isSolidAttachmentHost(read(sideKey))) {
          retainedBits |= direction.bit;
          supportKeys.push(sideKey);
        } else if ((aboveBits & direction.bit) !== 0) {
          retainedBits |= direction.bit;
          supportKeys.push(aboveKey);
        }
      }
      return {
        states: replaceState(snapshot, "vine_direction_bits", retainedBits),
        supported: retainedBits !== 0,
        supportKeys
      };
    }
    default:
      throw new Error(`Unsupported captured tree attachment type ${snapshot.typeId}.`);
  }
}

function isSolidAttachmentHost(snapshot: CapturedTreeBlock | undefined): boolean {
  return snapshot !== undefined && snapshot.kind !== "attachment";
}

function integerState(
  snapshot: CapturedTreeBlock,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = stateValue(snapshot, name);
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(
      `Tree attachment ${snapshot.typeId} has invalid ${name} state ${String(value)}.`
    );
  }
  return value as number;
}

function stateValue(
  snapshot: CapturedTreeBlock,
  name: string
): boolean | number | string | undefined {
  return snapshot.states[name] ?? snapshot.states[`minecraft:${name}`];
}

function replaceState(
  snapshot: CapturedTreeBlock,
  name: string,
  value: boolean | number | string
): CapturedTreeBlock["states"] {
  const key = snapshot.states[name] !== undefined ? name : `minecraft:${name}`;
  if (snapshot.states[key] === undefined) {
    throw new Error(`Tree attachment ${snapshot.typeId} has no ${name} state.`);
  }
  return { ...snapshot.states, [key]: value };
}

function statesEqual(
  left: CapturedTreeBlock["states"],
  right: CapturedTreeBlock["states"]
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => left[key] === right[key]);
}
