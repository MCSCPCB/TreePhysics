// Persistence contract for contraptions: the SerializedContraption schema, its
// shape validators, edit-journal materialization, and tool (de)serialization.
// Split from contraption-lifecycle.ts so the save format lives apart from the
// runtime orchestration that produces and consumes it.
import { EnchantmentType, ItemStack, type Vector3 } from "@minecraft/server";
import type { PhysicsContraptionFoliageTint } from "@src/Physics";
import { rotateVectorByEulerDegreesYzx } from "@src/physics/motion/RotationContinuity";
import type { CapturedTreeBlock, TreeBlockMapColor } from "@src/content/tree/block/Blocks";
import { isContraptionFoliageTint } from "@src/render/foliage/TintCodec";
import type { TreeLeafPhysicsProfileId } from "@src/content/tree/foliage/PhysicsQuality";
import type { TreeLogBreakGroupKind } from "@src/content/tree/breakage/Plan";
import type { ContraptionChestStorageBinding } from "@src/content/contraption/interaction/ContainerInteraction";
import {
  blockKey as locationKey,
  parseBlockKey as parseLocationKey
} from "@src/utils/BlockKey";
import { add, subtract } from "@src/utils/Vector3Math";
import { FACE_OFFSETS } from "@src/utils/Neighborhood";

export const MAX_LEAF_DISTANCE = 7;

export interface SavedPose {
  location: Vector3;
  rotation: Vector3;
}

interface SerializedEnchantment {
  level: number;
  typeId: string;
}

interface SerializedTool {
  enchantments: SerializedEnchantment[];
  typeId: string;
}

export interface SerializedSnapshotEntry {
  localLocation: Vector3;
  snapshot: CapturedTreeBlock;
}

interface SerializedLeafEntry {
  distance: number;
  localLocation: Vector3;
}

export interface SerializedLeafPhysics {
  breakGroups?: Vector3[][];
  profileId: TreeLeafPhysicsProfileId;
}

interface SerializedLogBreakGroup {
  bandId?: number;
  keys: Vector3[];
  kind: TreeLogBreakGroupKind;
}

export interface SerializedLogBreakage {
  anchor?: Vector3;
  breakGroups?: SerializedLogBreakGroup[];
  maximumLever?: number;
  protectedKeys?: Vector3[];
  seed?: number;
}

export interface SerializedPendingLogBreak {
  generation: number;
  keys: string[];
  sleepTimeoutTicks: number;
}

export interface SerializedContraption {
  automaticLifecyclePaused: boolean;
  attachmentProbeCursor: number;
  angularVelocity: Vector3;
  blocks: import("@src/Physics").PhysicsContraptionBlock[];
  boundaryThreatTicks: number;
  chestStorages: ContraptionChestStorageBinding[];
  decayProgress: number;
  detachedAttachmentCursor: number;
  detachedAttachments: SerializedSnapshotEntry[];
  fragileProbeCursor: number;
  foliageTint?: PhysicsContraptionFoliageTint;
  dimensionId: string;
  editJournalSequence: number;
  id: string;
  lastSafePose: SavedPose;
  leafPhysics: SerializedLeafPhysics;
  leaves: SerializedLeafEntry[];
  lavaExposureTicks: number;
  location: Vector3;
  logBreakage: SerializedLogBreakage;
  logBreakDamage: number;
  logBreakGeneration: number;
  lootTool?: SerializedTool;
  nextDecayDelayTicks: number;
  pendingLavaDestruction?: boolean;
  pendingLogBreak?: SerializedPendingLogBreak;
  pendingSettlement?: boolean;
  playerEditRevision: number;
  probeCursor: number;
  rotation: Vector3;
  sourceCommitted: boolean;
  sleepTicks: number;
  sleepTicksPerLog: number;
  sleeping: boolean;
  sleepTimeoutTicks: number;
  snapshots: SerializedSnapshotEntry[];
  velocity: Vector3;
  visualEntityIds: string[];
  visualGeneration: number;
  worldLeafProbeCursor: number;
}

export interface ContraptionManifest {
  contraptionIds: string[];
}

export type SerializedContraptionStructure = Pick<SerializedContraption,
  | "blocks"
  | "chestStorages"
  | "detachedAttachments"
  | "dimensionId"
  | "foliageTint"
  | "id"
  | "leafPhysics"
  | "leaves"
  | "logBreakage"
  | "logBreakGeneration"
  | "lootTool"
  | "pendingLogBreak"
  | "sleepTicksPerLog"
  | "sleepTimeoutTicks"
  | "snapshots"
>;

export type SerializedContraptionState = Omit<SerializedContraption, keyof SerializedContraptionStructure>;

export interface SerializedContraptionEditJournalAddition {
  readonly block: import("@src/Physics").PhysicsContraptionBlock;
  readonly chestStorage?: ContraptionChestStorageBinding;
  readonly snapshot: CapturedTreeBlock;
}

export interface SerializedContraptionEditJournalEntry {
  readonly additions: readonly SerializedContraptionEditJournalAddition[];
  readonly clearPendingLogBreak: boolean;
  readonly detachedAttachments?: readonly SerializedSnapshotEntry[];
  readonly removedKeys: readonly string[];
  readonly sequence: number;
  readonly sleepTimeoutTicks: number;
  readonly state: SerializedContraptionState;
}

export interface SerializedContraptionEditJournal {
  readonly entries: readonly SerializedContraptionEditJournalEntry[];
  readonly id: string;
}

export function isContraptionManifest(value: unknown): value is ContraptionManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ContraptionManifest>;
  return hasOnlyKeys(manifest, ["contraptionIds"])
    && Array.isArray(manifest.contraptionIds)
    && manifest.contraptionIds.every(id => typeof id === "string" && id.length > 0)
    && new Set(manifest.contraptionIds).size === manifest.contraptionIds.length;
}

export function cloneChestStorageBinding(
  binding: ContraptionChestStorageBinding
): ContraptionChestStorageBinding {
  return {
    localLocation: { ...binding.localLocation },
    storageId: binding.storageId
  };
}

export function isChestStorageBinding(value: unknown): value is ContraptionChestStorageBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ContraptionChestStorageBinding>;
  return hasOnlyKeys(binding, ["localLocation", "storageId"])
    && isVector(binding.localLocation)
    && Number.isInteger(binding.localLocation.x)
    && Number.isInteger(binding.localLocation.y)
    && Number.isInteger(binding.localLocation.z)
    && typeof binding.storageId === "string"
    && binding.storageId.length > 0;
}

export function splitSerializedContraption(tree: SerializedContraption): {
  readonly state: SerializedContraptionState;
  readonly structure: SerializedContraptionStructure;
} {
  const {
    blocks,
    chestStorages,
    detachedAttachments,
    dimensionId,
    id,
    leafPhysics,
    leaves,
    logBreakage,
    logBreakGeneration,
    lootTool,
    pendingLogBreak,
    sleepTicksPerLog,
    sleepTimeoutTicks,
    snapshots,
    ...state
  } = tree;
  return {
    state,
    structure: {
      blocks,
      chestStorages,
      detachedAttachments,
      dimensionId,
      id,
      leafPhysics,
      leaves,
      logBreakage,
      logBreakGeneration,
      lootTool,
      pendingLogBreak,
      sleepTicksPerLog,
      sleepTimeoutTicks,
      snapshots
    }
  };
}

export function isSerializedContraption(value: unknown): value is SerializedContraption {
  if (!value || typeof value !== "object") return false;
  const tree = value as Partial<SerializedContraption>;
  return typeof tree.id === "string"
    && typeof tree.automaticLifecyclePaused === "boolean"
    && typeof tree.dimensionId === "string"
    && Number.isInteger(tree.editJournalSequence)
    && tree.editJournalSequence! >= 0
    && isVector(tree.location)
    && isVector(tree.rotation)
    && isVector(tree.velocity)
    && isVector(tree.angularVelocity)
    && Array.isArray(tree.blocks)
    && tree.blocks.length > 0
    && Array.isArray(tree.chestStorages)
    && tree.chestStorages.every(isChestStorageBinding)
    && Array.isArray(tree.detachedAttachments)
    && tree.detachedAttachments.every(isSerializedSnapshotEntry)
    && Number.isInteger(tree.detachedAttachmentCursor)
    && tree.detachedAttachmentCursor! >= 0
    && Array.isArray(tree.snapshots)
    && Array.isArray(tree.leaves)
    && Array.isArray(tree.visualEntityIds)
    && typeof tree.sleepTicks === "number"
    && Number.isInteger(tree.sleepTicksPerLog)
    && tree.sleepTicksPerLog! > 0
    && typeof tree.sleepTimeoutTicks === "number"
    && tree.sleepTicksPerLog! <= tree.sleepTimeoutTicks!
    && typeof tree.sleeping === "boolean"
    && typeof tree.sourceCommitted === "boolean"
    && (tree.pendingLavaDestruction === undefined || typeof tree.pendingLavaDestruction === "boolean")
    && typeof tree.lavaExposureTicks === "number"
    && Number.isFinite(tree.lavaExposureTicks)
    && typeof tree.decayProgress === "number"
    && typeof tree.attachmentProbeCursor === "number"
    && typeof tree.fragileProbeCursor === "number"
    && typeof tree.worldLeafProbeCursor === "number"
    && isSerializedLeafPhysics(tree.leafPhysics)
    && isSerializedLogBreakage(tree.logBreakage)
    && typeof tree.logBreakDamage === "number"
    && Number.isFinite(tree.logBreakDamage)
    && tree.logBreakDamage >= 0
    && Number.isInteger(tree.logBreakGeneration)
    && tree.logBreakGeneration! >= 0
    && (tree.pendingLogBreak === undefined || isSerializedPendingLogBreak(tree.pendingLogBreak))
    && (tree.pendingLogBreak === undefined
      || tree.pendingLogBreak.generation === tree.logBreakGeneration)
    && Number.isInteger(tree.playerEditRevision)
    && tree.playerEditRevision! >= 0
    && (tree.foliageTint === undefined || isContraptionFoliageTint(tree.foliageTint))
    && typeof tree.nextDecayDelayTicks === "number"
    && typeof tree.probeCursor === "number"
    && typeof tree.boundaryThreatTicks === "number"
    && Number.isInteger(tree.visualGeneration)
    && tree.visualGeneration! >= 0
    && !!tree.lastSafePose
    && isVector(tree.lastSafePose.location)
    && isVector(tree.lastSafePose.rotation);
}

function isSerializedLeafPhysics(value: unknown): value is SerializedLeafPhysics {
  if (!value || typeof value !== "object") return false;
  const serialized = value as Partial<SerializedLeafPhysics>;
  return hasOnlyKeys(serialized, ["breakGroups", "profileId"])
    && isTreeLeafPhysicsProfileId(serialized.profileId)
    && (serialized.breakGroups === undefined
      || (Array.isArray(serialized.breakGroups)
        && serialized.breakGroups.every(group =>
          Array.isArray(group) && group.every(isVector)
        )));
}

function isSerializedLogBreakage(value: unknown): value is SerializedLogBreakage {
  if (!value || typeof value !== "object") return false;
  const serialized = value as Partial<SerializedLogBreakage>;
  if (!hasOnlyKeys(serialized, [
    "anchor",
    "breakGroups",
    "maximumLever",
    "protectedKeys",
    "seed"
  ])) return false;
  const disabled = serialized.anchor === undefined
    && serialized.breakGroups === undefined
    && serialized.maximumLever === undefined
    && serialized.protectedKeys === undefined
    && serialized.seed === undefined;
  if (disabled) return true;
  return isVector(serialized.anchor)
    && Array.isArray(serialized.breakGroups)
    && serialized.breakGroups.every(isSerializedLogBreakGroup)
    && typeof serialized.maximumLever === "number"
    && Number.isFinite(serialized.maximumLever)
    && serialized.maximumLever >= 1
    && Array.isArray(serialized.protectedKeys)
    && serialized.protectedKeys.length > 0
    && serialized.protectedKeys.every(isVector)
    && Number.isInteger(serialized.seed)
    && serialized.seed! >= 0
    && serialized.seed! <= 0xffffffff;
}

function isSerializedLogBreakGroup(value: unknown): value is SerializedLogBreakGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<SerializedLogBreakGroup>;
  return hasOnlyKeys(group, ["bandId", "keys", "kind"])
    && (group.kind === "branch" || group.kind === "crosscut" || group.kind === "trunk")
    && (group.kind === "branch"
      ? group.bandId === undefined
      : Number.isInteger(group.bandId) && group.bandId! >= 0)
    && Array.isArray(group.keys)
    && group.keys.length > 0
    && group.keys.every(isVector);
}

function isSerializedPendingLogBreak(value: unknown): value is SerializedPendingLogBreak {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<SerializedPendingLogBreak>;
  return hasOnlyKeys(pending, ["generation", "keys", "sleepTimeoutTicks"])
    && Number.isInteger(pending.generation)
    && pending.generation! > 0
    && Array.isArray(pending.keys)
    && pending.keys.length > 0
    && pending.keys.every(key => typeof key === "string")
    && new Set(pending.keys).size === pending.keys.length
    && Number.isInteger(pending.sleepTimeoutTicks)
    && pending.sleepTimeoutTicks! > 0;
}

function isSerializedSnapshotEntry(value: unknown): value is SerializedSnapshotEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SerializedSnapshotEntry>;
  if (!isVector(entry.localLocation) || !entry.snapshot || typeof entry.snapshot !== "object") {
    return false;
  }
  const snapshot = entry.snapshot as Partial<CapturedTreeBlock>;
  return isVector(snapshot.location)
    && typeof snapshot.typeId === "string"
    && (snapshot.kind === "attachment"
      || snapshot.kind === "block"
      || snapshot.kind === "leaf"
      || snapshot.kind === "log"
      || snapshot.kind === "root")
    && !!snapshot.states
    && typeof snapshot.states === "object"
    && (snapshot.mapColor === undefined || isTreeBlockMapColor(snapshot.mapColor));
}

export function normalizeDetachedAttachmentCursor(saved: SerializedContraption): number {
  return Math.min(
    saved.detachedAttachments.length,
    Math.max(0, Math.floor(saved.detachedAttachmentCursor))
  );
}

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every(key => allowed.has(key));
}

function isTreeLeafPhysicsProfileId(value: unknown): value is TreeLeafPhysicsProfileId {
  return value === "exact" || value === "high" || value === "medium" || value === "low";
}

export function cloneContraptionBlock(
  block: import("@src/Physics").PhysicsContraptionBlock
): import("@src/Physics").PhysicsContraptionBlock {
  const cloned: import("@src/Physics").PhysicsContraptionBlock = {
    ...block,
    collisionShape: Array.isArray(block.collisionShape)
      ? block.collisionShape.map(box => ({ min: { ...box.min }, max: { ...box.max } }))
      : block.collisionShape,
    localLocation: { ...block.localLocation },
    rotation: block.rotation ? { ...block.rotation } : undefined
  };
  delete cloned.visual;
  return cloned;
}

export function isSerializedContraptionEditJournal(value: unknown): value is SerializedContraptionEditJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Partial<SerializedContraptionEditJournal>;
  if (
    !hasOnlyKeys(journal, ["entries", "id"])
    || typeof journal.id !== "string"
    || journal.id.length === 0
    || !Array.isArray(journal.entries)
    || journal.entries.length === 0
  ) return false;
  let previousSequence: number | undefined;
  for (const value of journal.entries) {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<SerializedContraptionEditJournalEntry>;
    if (
      !hasOnlyKeys(entry, [
        "additions",
        "clearPendingLogBreak",
        "detachedAttachments",
        "removedKeys",
        "sequence",
        "sleepTimeoutTicks",
        "state"
      ])
      || !Number.isInteger(entry.sequence)
      || entry.sequence! <= 0
      || (previousSequence !== undefined && entry.sequence !== previousSequence + 1)
      || !Number.isInteger(entry.sleepTimeoutTicks)
      || entry.sleepTimeoutTicks! <= 0
      || typeof entry.clearPendingLogBreak !== "boolean"
      || !entry.state
      || typeof entry.state !== "object"
      || !Array.isArray(entry.removedKeys)
      || entry.removedKeys.some(key => typeof key !== "string")
      || new Set(entry.removedKeys).size !== entry.removedKeys.length
      || !Array.isArray(entry.additions)
      || !entry.additions.every(isSerializedContraptionEditJournalAddition)
      || (entry.detachedAttachments !== undefined && (
        !Array.isArray(entry.detachedAttachments)
        || !entry.detachedAttachments.every(isSerializedSnapshotEntry)
      ))
    ) return false;
    previousSequence = entry.sequence;
  }
  return true;
}

function isSerializedContraptionEditJournalAddition(
  value: unknown
): value is SerializedContraptionEditJournalAddition {
  if (!value || typeof value !== "object") return false;
  const addition = value as Partial<SerializedContraptionEditJournalAddition>;
  if (
    !hasOnlyKeys(addition, ["block", "chestStorage", "snapshot"])
    || !addition.block
    || typeof addition.block !== "object"
    || !addition.snapshot
    || typeof addition.snapshot !== "object"
  ) return false;
  const block = addition.block as Partial<import("@src/Physics").PhysicsContraptionBlock>;
  return typeof block.typeId === "string"
    && block.typeId.length > 0
    && isIntegerLocation(block.localLocation)
    && isSerializedSnapshotEntry({
      localLocation: block.localLocation,
      snapshot: addition.snapshot
    })
    && (addition.chestStorage === undefined || isChestStorageBinding(addition.chestStorage));
}

function isIntegerLocation(value: unknown): value is Vector3 {
  return isVector(value)
    && Number.isInteger(value.x)
    && Number.isInteger(value.y)
    && Number.isInteger(value.z);
}

export function applySerializedContraptionEditJournal(
  base: SerializedContraption,
  journal: SerializedContraptionEditJournal
): SerializedContraption {
  let tree = base;
  for (const entry of journal.entries) {
    if (tree.editJournalSequence >= entry.sequence) continue;
    const removedKeys = new Set(entry.removedKeys);
    const blocks = new Map(tree.blocks.map(block => [locationKey(block.localLocation), block]));
    const snapshots = new Map(tree.snapshots.map(value => [locationKey(value.localLocation), value]));
    const chestStorages = new Map(
      tree.chestStorages.map(binding => [locationKey(binding.localLocation), binding])
    );
    for (const key of removedKeys) {
      blocks.delete(key);
      snapshots.delete(key);
      chestStorages.delete(key);
    }
    for (const addition of entry.additions) {
      const key = locationKey(addition.block.localLocation);
      blocks.set(key, cloneContraptionBlock(addition.block));
      snapshots.set(key, {
        localLocation: { ...addition.block.localLocation },
        snapshot: cloneSnapshot(addition.snapshot)
      });
      if (addition.chestStorage) {
        chestStorages.set(key, cloneChestStorageBinding(addition.chestStorage));
      } else {
        chestStorages.delete(key);
      }
    }
    const nextSnapshots = [...snapshots.values()];
    const sourceOrigin = nextSnapshots.length > 0
      ? subtract(nextSnapshots[0]!.snapshot.location, nextSnapshots[0]!.localLocation)
      : savedContraptionSourceOrigin(tree);
    const leafDistances = computeLeafDistances(
      nextSnapshots.map(value => value.snapshot),
      sourceOrigin
    );
    const remainingKeys = new Set(blocks.keys());
    const breakGroups = tree.leafPhysics.breakGroups
      ?.map(group => group.filter(location => remainingKeys.has(locationKey(location))))
      .filter(group => group.length > 0);
    tree = {
      ...tree,
      ...entry.state,
      blocks: [...blocks.values()],
      chestStorages: [...chestStorages.values()],
      detachedAttachments: entry.detachedAttachments
        ? entry.detachedAttachments.map(value => ({
          localLocation: { ...value.localLocation },
          snapshot: cloneSnapshot(value.snapshot)
        }))
        : tree.detachedAttachments,
      leafPhysics: {
        breakGroups,
        profileId: tree.leafPhysics.profileId
      },
      leaves: nextSnapshots
        .filter(value => value.snapshot.kind === "leaf")
        .map(value => ({
          distance: leafDistances.get(locationKey(value.localLocation)) ?? MAX_LEAF_DISTANCE,
          localLocation: { ...value.localLocation }
        })),
      logBreakage: pruneSerializedLogBreakage(tree.logBreakage, remainingKeys),
      pendingLogBreak: entry.clearPendingLogBreak ? undefined : tree.pendingLogBreak,
      sleepTimeoutTicks: entry.sleepTimeoutTicks,
      snapshots: nextSnapshots
    };
  }
  if (!isSerializedContraption(tree)) {
    throw new Error(`Edit journal for contraption ${journal.id} produced an invalid record.`);
  }
  return tree;
}

function pruneSerializedLogBreakage(
  serialized: SerializedLogBreakage,
  remainingKeys: ReadonlySet<string>
): SerializedLogBreakage {
  if (!serialized.anchor || !remainingKeys.has(locationKey(serialized.anchor))) return {};
  const breakGroups = serialized.breakGroups
    ?.map(group => ({
      ...group,
      keys: group.keys.filter(location => remainingKeys.has(locationKey(location)))
    }))
    .filter(group => group.keys.length > 0);
  const protectedKeys = serialized.protectedKeys
    ?.filter(location => remainingKeys.has(locationKey(location)));
  if (!breakGroups || !protectedKeys || protectedKeys.length === 0) return {};
  return {
    anchor: { ...serialized.anchor },
    breakGroups,
    maximumLever: serialized.maximumLever,
    protectedKeys,
    seed: serialized.seed
  };
}

export function cloneSnapshot(snapshot: CapturedTreeBlock): CapturedTreeBlock {
  return {
    kind: snapshot.kind,
    location: { ...snapshot.location },
    mapColor: snapshot.mapColor ? { ...snapshot.mapColor } : undefined,
    states: { ...snapshot.states },
    typeId: snapshot.typeId
  };
}

export function savedContraptionSourceOrigin(saved: SerializedContraption): Vector3 {
  const entry = saved.snapshots[0];
  if (!entry) {
    return {
      x: Math.floor(saved.location.x),
      y: Math.floor(saved.location.y),
      z: Math.floor(saved.location.z)
    };
  }
  return subtract(entry.snapshot.location, entry.localLocation);
}

export function savedLocalPointToWorld(saved: SerializedContraption, local: Vector3): Vector3 {
  const transformed = rotateVectorByEulerDegreesYzx(local, saved.rotation);
  return {
    x: saved.location.x + transformed.x,
    y: saved.location.y + transformed.y,
    z: saved.location.z + transformed.z
  };
}

export function serializeTool(tool: ItemStack | undefined): SerializedTool | undefined {
  if (!tool) return undefined;
  let enchantments: SerializedEnchantment[] = [];
  try {
    enchantments = tool.getComponent("minecraft:enchantable")?.getEnchantments().map(entry => ({
      level: entry.level,
      typeId: entry.type.id
    })) ?? [];
  } catch {
    // Tool type alone still preserves vanilla mining behavior.
  }
  return { enchantments, typeId: tool.typeId };
}

export function deserializeTool(tool: SerializedTool | undefined): ItemStack | undefined {
  if (!tool) return undefined;
  try {
    const item = new ItemStack(tool.typeId);
    const enchantable = item.getComponent("minecraft:enchantable");
    if (enchantable) {
      for (const enchantment of tool.enchantments) {
        try {
          enchantable.addEnchantment({
            level: enchantment.level,
            type: new EnchantmentType(enchantment.typeId)
          });
        } catch {
          // Unknown or newly incompatible enchantments are ignored independently.
        }
      }
    }
    return item;
  } catch {
    return undefined;
  }
}

export function isVector(value: unknown): value is Vector3 {
  if (!value || typeof value !== "object") return false;
  const vector = value as Partial<Vector3>;
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isTreeBlockMapColor(value: unknown): value is TreeBlockMapColor {
  if (!value || typeof value !== "object") return false;
  const color = value as { blue?: number; green?: number; red?: number };
  return isNormalizedColorChannel(color.red)
    && isNormalizedColorChannel(color.green)
    && isNormalizedColorChannel(color.blue);
}

function isNormalizedColorChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function computeLeafDistances(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3
): Map<string, number> {
  const logs = new Set<string>();
  const leaves = new Set<string>();
  for (const snapshot of snapshots) {
    const key = locationKey(subtract(snapshot.location, origin));
    if (snapshot.kind === "log") logs.add(key);
    else if (snapshot.kind === "leaf") leaves.add(key);
  }
  const distances = new Map<string, number>();
  const queue: { key: string; location: Vector3; distance: number }[] = [];
  for (const logKey of logs) {
    const log = parseLocationKey(logKey);
    for (const offset of FACE_OFFSETS) {
      const location = add(log, offset);
      const key = locationKey(location);
      if (!leaves.has(key) || distances.has(key)) continue;
      distances.set(key, 1);
      queue.push({ key, location, distance: 1 });
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    if (current.distance >= MAX_LEAF_DISTANCE) continue;
    for (const offset of FACE_OFFSETS) {
      const location = add(current.location, offset);
      const key = locationKey(location);
      if (!leaves.has(key) || distances.has(key)) continue;
      const distance = current.distance + 1;
      distances.set(key, distance);
      queue.push({ key, location, distance });
    }
  }
  return distances;
}
