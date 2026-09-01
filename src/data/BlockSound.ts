import {
  VANILLA_BLOCK_BREAK_SOUND_EVENT_INDICES,
  VANILLA_BLOCK_BREAK_SOUND_EVENTS,
  VANILLA_BLOCK_PLACE_SOUND_EVENT_INDICES,
  VANILLA_BLOCK_PLACE_SOUND_EVENTS,
  VANILLA_TREE_FALL_SOUND_EVENT_INDICES,
  VANILLA_TREE_FALL_SOUND_EVENTS,
  VANILLA_TREE_HIT_SOUND_EVENT_INDICES,
  VANILLA_TREE_HIT_SOUND_EVENTS,
  VANILLA_TREE_JUMP_SOUND_EVENT_INDICES,
  VANILLA_TREE_JUMP_SOUND_EVENTS,
  VANILLA_TREE_LAND_SOUND_EVENT_INDICES,
  VANILLA_TREE_LAND_SOUND_EVENTS,
  VANILLA_TREE_STEP_SOUND_EVENT_INDICES,
  VANILLA_TREE_STEP_SOUND_EVENTS,
  type GeneratedBlockSoundEvent
} from "@src/data/BlockSoundEvent";
import { isTreeLeaf } from "@src/content/tree/block/Blocks";

const DEFAULT_BLOCK_BREAK_EVENT = ["dig.wood", 0.8, 1, 1, 1] as const;
const DEFAULT_BLOCK_HIT_EVENT = ["hit.wood", 0.5, 0.5, 0.23, 0.23] as const;
const DEFAULT_BLOCK_PLACE_EVENT = ["place.wood", 0.8, 0.8, 1, 1] as const;
const DEFAULT_FALL_EVENT = ["fall.wood", 1, 1, 0.4, 0.4] as const;
const DEFAULT_JUMP_EVENT = ["jump.wood", 1, 1, 0.12, 0.12] as const;
const DEFAULT_LAND_EVENT = ["land.wood", 1, 1, 0.18, 0.18] as const;
const DEFAULT_LEAF_BREAK_EVENT = ["dig.grass", 0.8, 1, 0.7, 0.7] as const;
const DEFAULT_LEAF_HIT_EVENT = ["hit.grass", 0.5, 0.5, 0.3, 0.3] as const;
const DEFAULT_STEP_EVENT = ["step.wood", 1, 1, 0.3, 0.3] as const;

export interface VanillaBlockSoundEvent {
  readonly pitch: number;
  readonly sound: string;
  readonly volume: number;
}

/** Resolves the complete vanilla block-break event, including sounds.json gain and pitch. */
export function resolveVanillaBlockBreakSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  return sampleSoundEvent(resolveBreakTemplate(typeId), random);
}

/** Resolves the complete vanilla block-place event, including sounds.json gain and pitch. */
export function resolveVanillaBlockPlaceSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  const normalized = normalizeTypeId(typeId);
  return sampleSoundEvent(
    lookupGeneratedEvent(
      VANILLA_BLOCK_PLACE_SOUND_EVENTS,
      VANILLA_BLOCK_PLACE_SOUND_EVENT_INDICES,
      normalized
    ) ?? DEFAULT_BLOCK_PLACE_EVENT,
    random
  );
}

export function selectDominantVanillaBlockBreakSound(
  typeIds: readonly string[],
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  if (typeIds.length === 0) return sampleSoundEvent(DEFAULT_BLOCK_BREAK_EVENT, random);
  const counts = new Map<string, number>();
  // The non-empty guard above ensures the first iteration's count (1) beats
  // selectedCount (0) and overwrites this initializer, which exists only to
  // satisfy definite assignment.
  let selected: GeneratedBlockSoundEvent = DEFAULT_BLOCK_BREAK_EVENT;
  let selectedCount = 0;
  for (const typeId of typeIds) {
    const event = resolveBreakTemplate(typeId);
    const key = event.join("|");
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > selectedCount) {
      selected = event;
      selectedCount = count;
    }
  }
  return sampleSoundEvent(selected, random);
}

/** Resolves the vanilla mining-hit event for a captured block; unknown leaves use grass, other unknown blocks use wood. */
export function resolveVanillaBlockHitSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  const normalized = normalizeTypeId(typeId);
  const event = lookupGeneratedEvent(
    VANILLA_TREE_HIT_SOUND_EVENTS,
    VANILLA_TREE_HIT_SOUND_EVENT_INDICES,
    normalized
  );
  return sampleSoundEvent(
    event ?? leafAwareDefault(normalized, DEFAULT_LEAF_HIT_EVENT, DEFAULT_BLOCK_HIT_EVENT),
    random
  );
}

/** Resolves the vanilla player-step event for a captured block; unknown blocks use wood. */
export function resolveVanillaBlockStepSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  return resolveTreeInteractiveSound(
    typeId,
    VANILLA_TREE_STEP_SOUND_EVENTS,
    VANILLA_TREE_STEP_SOUND_EVENT_INDICES,
    DEFAULT_STEP_EVENT,
    random
  );
}

/** Resolves the vanilla player-jump event for a captured block; unknown blocks use wood. */
export function resolveVanillaBlockJumpSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  return resolveTreeInteractiveSound(
    typeId,
    VANILLA_TREE_JUMP_SOUND_EVENTS,
    VANILLA_TREE_JUMP_SOUND_EVENT_INDICES,
    DEFAULT_JUMP_EVENT,
    random
  );
}

/** Resolves the vanilla player-land event for a captured block; unknown blocks use wood. */
export function resolveVanillaBlockLandSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  return resolveTreeInteractiveSound(
    typeId,
    VANILLA_TREE_LAND_SOUND_EVENTS,
    VANILLA_TREE_LAND_SOUND_EVENT_INDICES,
    DEFAULT_LAND_EVENT,
    random
  );
}

/** Resolves the vanilla player-fall-on-block event for a captured block; unknown blocks use wood. */
export function resolveVanillaBlockFallSound(
  typeId: string | undefined,
  random: () => number = Math.random
): VanillaBlockSoundEvent {
  return resolveTreeInteractiveSound(
    typeId,
    VANILLA_TREE_FALL_SOUND_EVENTS,
    VANILLA_TREE_FALL_SOUND_EVENT_INDICES,
    DEFAULT_FALL_EVENT,
    random
  );
}

function resolveTreeInteractiveSound(
  typeId: string | undefined,
  events: readonly GeneratedBlockSoundEvent[],
  indices: Readonly<Record<string, number>>,
  defaultEvent: GeneratedBlockSoundEvent,
  random: () => number
): VanillaBlockSoundEvent {
  const normalized = normalizeTypeId(typeId);
  return sampleSoundEvent(
    lookupGeneratedEvent(
      events,
      indices,
      normalized
    ) ?? defaultEvent,
    random
  );
}

function resolveBreakTemplate(typeId: string | undefined): GeneratedBlockSoundEvent {
  const normalized = normalizeTypeId(typeId);
  return lookupGeneratedEvent(
    VANILLA_BLOCK_BREAK_SOUND_EVENTS,
    VANILLA_BLOCK_BREAK_SOUND_EVENT_INDICES,
    normalized
  ) ?? leafAwareDefault(normalized, DEFAULT_LEAF_BREAK_EVENT, DEFAULT_BLOCK_BREAK_EVENT);
}

/** Looks up the sounds.json-derived event for a normalized type id, if the generated tables cover it. */
function lookupGeneratedEvent(
  events: readonly GeneratedBlockSoundEvent[],
  indices: Readonly<Record<string, number>>,
  normalized: string | undefined
): GeneratedBlockSoundEvent | undefined {
  if (normalized === undefined) return undefined;
  const index = indices[normalized];
  return index === undefined ? undefined : events[index];
}

/** Unknown leaves use the leaf default; every other unknown block uses the wood default. */
function leafAwareDefault(
  normalized: string | undefined,
  leafEvent: GeneratedBlockSoundEvent,
  blockEvent: GeneratedBlockSoundEvent
): GeneratedBlockSoundEvent {
  return normalized !== undefined && isTreeLeaf(normalized) ? leafEvent : blockEvent;
}

function sampleSoundEvent(
  event: GeneratedBlockSoundEvent,
  random: () => number
): VanillaBlockSoundEvent {
  return {
    sound: event[0],
    pitch: sampleRange(event[1], event[2], random),
    volume: sampleRange(event[3], event[4], random)
  };
}

function sampleRange(minimum: number, maximum: number, random: () => number): number {
  return minimum === maximum ? minimum : minimum + (maximum - minimum) * random();
}

function normalizeTypeId(typeId: string | undefined): string | undefined {
  if (!typeId) return undefined;
  return typeId.includes(":") ? typeId : `minecraft:${typeId}`;
}
