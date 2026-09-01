import {
  EntityDamageCause,
  ItemStack,
  MolangVariableMap,
  system,
  world,
  type Block,
  type Dimension,
  type Entity,
  type Player,
  type Vector3
} from "@minecraft/server";
import { DynamicPropertyJsonStore } from "@src/storage/DynamicPropertyJsonStore";
import { meshVoxels } from "@src/physics/contraption/Mesher";
import {
  resolveBlockCollisionShape,
  type PhysicsContraption,
  type PhysicsContraptionBlock,
  type PhysicsContraptionFoliageTint,
  type PhysicsContraptionSurfaceParticleAfterEvent,
  type PhysicsBodyAabb,
  type PhysicsCollisionAfterEvent,
  type PhysicsDimension,
  type PhysicsLavaEntryAfterEvent,
  type PhysicsWaterEntryAfterEvent
} from "@src/Physics";
import { BLOCK_PHYSICS_PROPERTIES } from "@src/data/BlockPhysicsProperties";
import {
  isFragilePlantTreeAttachment,
  isTreeLeaf,
  isTreeLog,
  isVanillaTypeId,
  isSupportedOrdinaryContraptionBlock,
  logFamily,
  playerEditableContraptionBlockKind,
  treeBlockKind,
  type CapturedTreeBlock
} from "@src/content/tree/block/Blocks";
import {
  resolveTreeAttachmentSupport,
  type TreeAttachmentStateUpdate,
  type TreeAttachmentSupportEntry,
  type TreeAttachmentSupportResolution
} from "@src/content/tree/block/AttachmentSupport";
import { createFragmentVisual } from "@src/render/contraption/fragment/FragmentVisual";
import { CONTRAPTION_RENDER_ENTITY_TYPE_IDS } from "@src/render/contraption/shared/Renderer";
import { selectContraptionVisualAnchor } from "@src/render/contraption/shared/VisualAnchor";
import {
  createContraptionBlock,
  resolveContraptionCollisionShape
} from "@src/content/tree/block/ContraptionBlock";
import {
  TREE_LEAF_PHYSICS_PROFILES,
  createTreeLeafPhysicsPlan,
  restoreTreeLeafPhysicsPlan,
  type TreeLeafPhysicsActiveBudget,
  type TreeLeafPhysicsPlan,
  type TreeLeafPhysicsProfileId
} from "@src/content/tree/foliage/PhysicsQuality";
import { createTreeLeafPhysicsRuntimeRepresentation } from "@src/content/tree/foliage/PhysicsRuntime";
import { captureTreeFoliageTint } from "@src/content/tree/foliage/TintSampling";
import {
  getTreeBreakSpeedMultiplier,
  shouldBreakTreeLogs,
  shouldCountTreeMotionTime
} from "@src/config/Settings";
import {
  resolveVanillaBlockBreakSound,
  resolveVanillaBlockHitSound,
  resolveVanillaBlockPlaceSound,
  selectDominantVanillaBlockBreakSound
} from "@src/data/BlockSound";
import {
  getIndexedWorldSensorHits,
  type IndexedWorldSensorHit
} from "@src/physics/world/sensor/Batch";
import {
  createTreeLogBreakagePlan,
  getTreeLogImpactDamage,
  pruneTreeLogBreakagePlan,
  resolveTreeLogBreakage,
  restoreTreeLogBreakagePlan,
  type TreeLogBreakagePlan
} from "@src/content/tree/breakage/Plan";
import { type PendingItemDrop } from "@src/content/tree/contraption/ItemDropBatching";
import { readWorldBlockProbeBatch } from "@src/utils/WorldBlockProbeBatch";
import {
  contraptionContainsNonTreeBlock,
  createTreeEditTopologyPlan,
  TreeEditTopologyIndex,
  type TreeEditTopologyAttachmentStateUpdate,
  type TreeEditTopologyComponent,
  type TreeEditTopologyPlan
} from "@src/content/tree/contraption/EditTopology";
import { allocateTreeEditSettlementTicks } from "@src/content/tree/contraption/EditSettlement";
import {
  blockKey as locationKey,
  parseBlockKey as parseLocationKey
} from "@src/utils/BlockKey";
import { add, subtract } from "@src/utils/Vector3Math";
import {
  hasNeighborKey as hasAdjacentKey,
  NEIGHBOR_OFFSETS as SUPPORT_OFFSETS
} from "@src/utils/Neighborhood";
import { safeGetBlock } from "@src/utils/WorldBlock";
import {
  areBoundsChunksReadable,
  createOutwardGuardBounds,
  createPredictedBounds,
  expandBounds,
  groupPlayersByDimension,
  vectorDistance,
  vectorSignature
} from "@src/content/tree/contraption/Bounds";
import {
  type ContraptionChestStorageBinding,
  type ContraptionChestStorageReplacement,
  type ContraptionContainerInteractionController
} from "@src/content/contraption/interaction/ContainerInteraction";
import {
  applySerializedContraptionEditJournal,
  cloneContraptionBlock,
  cloneChestStorageBinding,
  cloneSnapshot,
  computeLeafDistances,
  deserializeTool,
  isChestStorageBinding,
  isContraptionManifest,
  isSerializedContraption,
  isSerializedContraptionEditJournal,
  MAX_LEAF_DISTANCE,
  normalizeDetachedAttachmentCursor,
  savedLocalPointToWorld,
  savedContraptionSourceOrigin,
  serializeTool,
  splitSerializedContraption,
  type ContraptionManifest,
  type SavedPose,
  type SerializedContraption,
  type SerializedContraptionState,
  type SerializedContraptionStructure,
  type SerializedLeafPhysics,
  type SerializedLogBreakage,
  type SerializedPendingLogBreak,
  type SerializedSnapshotEntry,
  type SerializedContraptionEditJournal,
  type SerializedContraptionEditJournalAddition,
  type SerializedContraptionEditJournalEntry
} from "@src/storage/ContraptionSerialization";
import {
  describeError,
  producesDustOnImpact,
  spawnBlockParticle,
  BLOCK_BREAK_PARTICLE_PROFILE,
  BLOCK_HIT_PARTICLE_PROFILE
} from "@src/render/particle/BlockParticles";
import {
  appendDetachedAttachmentOperations,
  generatePermutationDrops,
  getSettlementTagsForOperations,
  isDeterministicParticleSample,
  resolveFinalSettlementDropAnchor,
  spawnBeeNestBees,
  spawnFinalSettlementBatch,
  spawnItemDropBatch,
  spawnPermutationDrops,
  spawnSettlementOperations,
  type PendingDropRuntime,
  type PendingSettlementOperation,
  type PendingSettlementRuntime
} from "@src/content/tree/contraption/SettlementEffects";
import {
  addDamageQueryProbe,
  canTreeReachDamageSpeed,
  findDamageLogContact,
  getTreeImpactDamage,
  getTreePoseVelocityAt,
  horizontalDirection,
  PHYSICS_TICKS_PER_SECOND,
  prepareDamageCandidates,
  vectorLengthSquared,
  type DamageCandidate,
  type DamageQueryCluster
} from "@src/content/tree/contraption/Damage";

const LOG_IMPACT_TRIGGER_SPEED = 2;
const DECAY_UPRIGHTNESS_THRESHOLD = 0.75;
// Leaves within this log distance never decay; farther rings ramp up quadratically.
const DECAY_IMMUNE_LEAF_DISTANCE = 2;
const DECAY_CHANCE_DISTANCE_DIVISOR = 25;
// World-space tolerance when mapping a contact point back to an contraption block.
const CONTRAPTION_BLOCK_LOOKUP_TOLERANCE = 1.25;
const CONTRAPTION_FRAGILE_PROBES_PER_TICK = 64;
const DAMAGE_RECHECK_INTERVAL_TICKS = 5;
const DAMAGE_STATE_PRUNE_INTERVAL_TICKS = 200;
const DAMAGE_KNOCKBACK_HORIZONTAL_SCALE = 1.6;
const DAMAGE_KNOCKBACK_MAX_STRENGTH = 1.3;
const LEAF_BUOYANCY_VOLUME = 0.125;
// Children of an edited tree restart their visual tag lineage at generation one.
const EDITED_TREE_VISUAL_GENERATION = 1;
// Offsets along the contact normal: 0 samples the block containing the contact
// point itself, the near pair straddles a shared face so a surface contact
// resolves on either side of the boundary, and the far pair reaches contacts
// reported slightly inside one of the bodies.
const WORLD_CONTACT_PROBE_SCALES: readonly number[] = [0, 0.08, -0.08, 0.25, -0.25];
// A splash renders when the contact block or the one above it is liquid.
const LIQUID_SURFACE_PROBE_Y_OFFSETS: readonly number[] = [0, 1];
const LAVA_DESTRUCTION_EXPOSURE_TICKS = PHYSICS_TICKS_PER_SECOND * 2;
const LAVA_EXPOSURE_COOLING_TICKS = 2;
const LAVA_ENTRY_MIN_PARTICLE_IMPULSE = 0.25;
const LAVA_ENTRY_MAX_SPARKS = 400;
const FLUID_ENTRY_SOUND_MAX_GAIN = 0.2;
const FLUID_ENTRY_SOUND_SATURATION = 0.5;
const LAVA_DESTRUCTION_MAX_ANCHORS = 8;
const LAVA_DESTRUCTION_MAX_SMOKE = 32;
const PERSISTENCE_INTERVAL_TICKS = 20;
const SETTLEMENT_MAX_TICKS = 20;
const RESTORE_HORIZONTAL_RADIUS = 96;
const RESTORE_VERTICAL_RADIUS = 96;
const CROSS_DOMAIN_CONFIRM_TICKS = 2;
const PAUSED_CROSS_DOMAIN_CHECK_INTERVAL_TICKS = 16;
const PLAYER_MOVING_AWAY_EPSILON = 0.2;
const SETTLEMENT_OPERATION_GROUP_SIZE = 64;
const TREE_LOG_BREAK_MAX_PARTICLES = 32;
const TREE_SPLASH_PARTICLE_ID = "treephysics:tree_splash_entry";
const TREE_LAVA_SPLASH_PARTICLE_ID = "treephysics:tree_lava_splash";
const TREE_LAVA_SMOKE_PARTICLE_ID = "treephysics:tree_lava_smoke";
const CONTRAPTION_VISUAL_TAG_PREFIX = "treephysics_contraption_";
const RESTORE_RETRY_TICKS = 20;
const VISUAL_INTEGRITY_CHECK_INTERVAL_TICKS = 20;

export function createContraptionVisualTag(id: string, generation: number): string {
  return `${CONTRAPTION_VISUAL_TAG_PREFIX}${id}_${Math.max(0, Math.floor(generation))}`;
}

type LavaExposureResult = "none" | "heated" | "pending" | "destroyed";

interface ActiveTreeTickEntry {
  readonly lavaExposure: "none" | "heated";
  readonly tree: ContraptionState;
}

interface ContraptionFragileProbeSample {
  readonly blockKey: string;
  readonly fragile: FallenFragileBlock;
  readonly physicsDimension: PhysicsDimension;
  readonly predictedKey?: string;
  readonly predictedLocation?: Vector3;
  readonly speed: number;
  readonly tree: ContraptionState;
  readonly worldLocation: Vector3;
}

interface ContraptionFragileProbeLocation extends Vector3 {
  additionalSampleIndices?: number[];
  firstSampleIndex: number;
}

interface ContraptionStores {
  readonly journal: DynamicPropertyJsonStore;
  readonly state: DynamicPropertyJsonStore;
  readonly structure: DynamicPropertyJsonStore;
}

interface PendingDetachedAttachmentRuntime extends PendingDropRuntime {
  readonly tree: ContraptionState;
}

interface PendingLogImpact {
  readonly damage: number;
  readonly localPoint: Vector3;
}

interface LavaDestructionAnchor {
  readonly location: Vector3;
  readonly localLocation: Vector3;
  readonly snapshot: CapturedTreeBlock;
}

interface WorldCollisionHit {
  readonly locationKey: string;
  readonly typeId: string;
}

interface FallenFragileBlock {
  /** Speed threshold at or above which a contact breaks this block. */
  fragileImpactSpeed: number;
  localLocation: Vector3;
  snapshot: CapturedTreeBlock;
}

interface FallenLeaf extends FallenFragileBlock {
  distance: number;
}

interface PlayerEditBreakEffect {
  readonly localLocation: Vector3;
  readonly position: Vector3;
  readonly snapshot: CapturedTreeBlock;
  readonly tool?: ItemStack;
}

interface StagedTreeTopologyComponent {
  readonly chestStorages: readonly ContraptionChestStorageBinding[];
  readonly component: TreeEditTopologyComponent;
  readonly logCount: number;
  readonly snapshots: readonly CapturedTreeBlock[];
}

export interface ContraptionState {
  contraption: PhysicsContraption;
  automaticLifecyclePaused: boolean;
  attachmentProbeCursor: number;
  attachmentProbeKeys: string[];
  boundaryThreatTicks: number;
  chestStorages: Map<string, ContraptionChestStorageBinding>;
  damagePose: SavedPose;
  decayProgress: number;
  detachedAttachmentCursor: number;
  detachedAttachments: SerializedSnapshotEntry[];
  editJournalSequence: number;
  /**
   * Save-format contract leftover: no probe loop consumes this cursor, but
   * SerializedContraption persists it, so it keeps round-tripping unchanged.
   */
  fragileProbeCursor: number;
  id: string;
  lastNearestPlayerDistance?: number;
  lastSafeBounds: PhysicsBodyAabb;
  lastSafePose: SavedPose;
  fragileAttachments: Map<string, FallenFragileBlock>;
  leaves: Map<string, FallenLeaf>;
  leavesByDistance: Map<number, Set<string>>;
  leafPhysicsPlan: TreeLeafPhysicsPlan;
  leafProbeKeys: string[];
  lavaExposureTicks: number;
  logBreakagePlan: TreeLogBreakagePlan;
  logBreakDamage: number;
  logBreakGeneration: number;
  logs: Map<string, Vector3>;
  lootTool?: ItemStack;
  nextDecayTick: number;
  pendingLogBreak?: SerializedPendingLogBreak;
  playerEditRevision: number;
  /** Cursor into leafProbeKeys; persisted under the legacy key "probeCursor". */
  leafProbeCursor: number;
  sleepTicks: number;
  sleepTicksPerLog: number;
  sleepTimeoutTicks: number;
  sourceCommitted: boolean;
  snapshots: Map<string, CapturedTreeBlock>;
  /** Created on the first edit/topology operation; ordinary trees do not need it. */
  topologyIndex?: TreeEditTopologyIndex;
  /**
   * Save-format contract leftover, like fragileProbeCursor: only serialization
   * reads it back out.
   */
  worldLeafProbeCursor: number;
  /**
   * Retained only to keep fragileProbeCursor modulo behavior identical for
   * existing saves; the legacy world probe itself is no longer active.
   */
  worldNonLeafProbeKeys: string[];
  visualGeneration: number;
}

export interface ContraptionRegistrationOptions {
  chestStorages?: readonly ContraptionChestStorageBinding[];
  deferPersistence?: boolean;
  detachedAttachments?: readonly CapturedTreeBlock[];
  initialSleepTicks?: number;
  persistenceId?: string;
  leafPhysicsPlan?: TreeLeafPhysicsPlan;
  lootTool?: ItemStack;
  playerEditRevision?: number;
  sleepTicksPerLog?: number;
  sleepTimeoutTicks: number;
  sourceCommitted?: boolean;
  visualGeneration?: number;
}

export interface ContraptionLifecycleOptions {
  canBreakWorldLeaf?: (block: Block) => boolean;
  chestStorage?: ContraptionContainerInteractionController;
  configureDimension?: (dimension: Dimension) => PhysicsDimension;
  crossDomain?: boolean;
  isDamageImmune?: (contraption: PhysicsContraption, entity: Entity) => boolean;
  onContraptionReplaced?: (
    source: PhysicsContraption,
    replacements: readonly PhysicsContraption[]
  ) => void;
  onWorldBlocksChanged?: (dimension: Dimension, locations: readonly Vector3[]) => void;
  store?: DynamicPropertyJsonStore;
}

export class ContraptionLifecycle {
  readonly #activeTreeTickBuffer: ActiveTreeTickEntry[] = [];
  readonly #chunkReadabilityCache = new Map<string, boolean>();
  readonly #collisionEffectKeys = new Set<string>();
  readonly #collisionWorldBlockCache = new Map<string, Block | undefined>();
  readonly #damageTreeBuffer: ContraptionState[] = [];
  readonly #damageCooldownUntilTick = new Map<string, number>();
  #fragileProbeCandidateMarks = new Uint8Array(0);
  readonly #fragileProbeLocationsByDimension = new Map<
    Dimension,
    Map<string, ContraptionFragileProbeLocation>
  >();
  readonly #fragileProbeSampleBuffer: ContraptionFragileProbeSample[] = [];
  readonly #pendingContraptionBlockBreaks = new Map<number, Set<string>>();
  readonly #pendingDetachedAttachments = new Map<string, PendingDetachedAttachmentRuntime>();
  readonly #pendingLeafGroupBreaks = new Map<number, Set<number>>();
  readonly #pendingLogImpacts = new Map<number, PendingLogImpact>();
  readonly #pendingSettlements = new Map<string, PendingSettlementRuntime>();
  readonly #pendingWorldBreaks = new Set<string>();
  readonly #persistenceSignatures = new Map<string, string>();
  readonly #managedVisualEntityIds = new Set<string>();
  readonly #managedVisualEntityIdsByContraption = new Map<number, Set<string>>();
  readonly #reportedRestoreFailures = new Set<string>();
  readonly #restoreRetryAfterTick = new Map<string, number>();
  readonly #dirtyContraptionStates = new Set<string>();
  readonly #dirtyContraptionStructures = new Set<string>();
  readonly #editJournals = new Map<string, SerializedContraptionEditJournal>();
  readonly #deletedContraptionIds = new Set<string>();
  readonly #persistedContraptionIds = new Set<string>();
  readonly #savedContraptions = new Map<string, SerializedContraption>();
  readonly #contraptionStores = new Map<string, ContraptionStores>();
  readonly #contraptions = new Map<number, ContraptionState>();
  readonly #canBreakWorldLeaf: (block: Block) => boolean;
  readonly #chestStorage?: ContraptionContainerInteractionController;
  readonly #configureDimension?: (dimension: Dimension) => PhysicsDimension;
  readonly #crossDomain: boolean;
  readonly #isDamageImmune: (contraption: PhysicsContraption, entity: Entity) => boolean;
  readonly #onContraptionReplaced?: (
    source: PhysicsContraption,
    replacements: readonly PhysicsContraption[]
  ) => void;
  readonly #onWorldBlocksChanged?: (dimension: Dimension, locations: readonly Vector3[]) => void;
  readonly #manifestStore: DynamicPropertyJsonStore;
  readonly #store: DynamicPropertyJsonStore;
  #initialized = false;
  readonly #loadedVisualReconciledDimensions = new Set<string>();
  readonly #loadedVisualReconcileRetryTick = new Map<string, number>();
  #collisionCacheTick = -1;
  #nextContraptionId = 1;

  constructor(options: ContraptionLifecycleOptions = {}) {
    this.#canBreakWorldLeaf = options.canBreakWorldLeaf ?? (() => true);
    this.#chestStorage = options.chestStorage;
    this.#configureDimension = options.configureDimension;
    this.#crossDomain = options.crossDomain ?? false;
    this.#isDamageImmune = options.isDamageImmune ?? (() => false);
    this.#onContraptionReplaced = options.onContraptionReplaced;
    this.#onWorldBlocksChanged = options.onWorldBlocksChanged;
    this.#store = options.store ?? new DynamicPropertyJsonStore("treephysics:contraptions");
    this.#manifestStore = new DynamicPropertyJsonStore(
      `${this.#store.prefix}_manifest`,
      this.#store.chunkSize,
      this.#store.target
    );
  }

  #ensureTopologyIndex(tree: ContraptionState): TreeEditTopologyIndex {
    // Most trees only need the live physics representation. Build the edit
    // index when an edit or topology split actually requires it.
    return tree.topologyIndex ??= new TreeEditTopologyIndex(
      tree.contraption.blocks,
      tree.playerEditRevision > 0
    );
  }

  initialize(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    const manifest = this.#manifestStore.load<ContraptionManifest>();
    if (!isContraptionManifest(manifest)) {
      this.#chestStorage?.completeSavedBindingRegistration();
      return;
    }
    for (const id of manifest.contraptionIds) {
      this.#persistedContraptionIds.add(id);
      const stores = this.#getTreeStores(id);
      const structure = stores.structure.load<SerializedContraptionStructure>();
      const state = stores.state.load<SerializedContraptionState>();
      if (!structure || !state || structure.id !== id) {
        this.#deletedContraptionIds.add(id);
        continue;
      }
      let tree = { ...structure, ...state };
      // Records written before edit journaling begin at sequence zero.
      if (tree.editJournalSequence === undefined) tree.editJournalSequence = 0;
      const journal = stores.journal.load<SerializedContraptionEditJournal>();
      if (journal) {
        if (!isSerializedContraptionEditJournal(journal) || journal.id !== id) {
          throw new Error(`Fallen tree ${id} has an invalid edit journal.`);
        }
        tree = applySerializedContraptionEditJournal(tree, journal);
        this.#editJournals.set(id, journal);
      }
      if (!isSerializedContraption(tree)) {
        this.#deletedContraptionIds.add(id);
        continue;
      }
      if (tree.pendingLavaDestruction) {
        this.#deletedContraptionIds.add(id);
        continue;
      }
      this.#savedContraptions.set(id, tree);
      this.#requireChestStorageController(tree.chestStorages);
      this.#chestStorage?.registerSavedBindings(id, tree.chestStorages);
    }
    this.#chestStorage?.completeSavedBindingRegistration();
    this.#writeSave();
  }

  #getTreeStores(id: string): ContraptionStores {
    let stores = this.#contraptionStores.get(id);
    if (stores) return stores;
    const prefix = `${this.#store.prefix}_tree_${id}`;
    stores = {
      journal: new DynamicPropertyJsonStore(
        `${prefix}_journal`,
        this.#store.chunkSize,
        this.#store.target
      ),
      state: new DynamicPropertyJsonStore(
        `${prefix}_state`,
        this.#store.chunkSize,
        this.#store.target
      ),
      structure: new DynamicPropertyJsonStore(
        `${prefix}_structure`,
        this.#store.chunkSize,
        this.#store.target
      )
    };
    this.#contraptionStores.set(id, stores);
    return stores;
  }

  prepareLeafPhysicsPlan(
    snapshots: readonly CapturedTreeBlock[],
    origin: Vector3
  ): TreeLeafPhysicsPlan {
    const leaves = createLeafPhysicsLeaves(snapshots, origin);
    if (leaves.length > TREE_LEAF_PHYSICS_PROFILES.medium.maximumLeafCount) {
      return createTreeLeafPhysicsPlan(leaves, {
        leafCount: leaves.length,
        profileId: "low"
      });
    }
    return createTreeLeafPhysicsPlan(leaves, {
      currentActiveBudget: this.#getActiveLeafPhysicsBudget(),
      exactLeafColliderBoxCount: meshVoxels(leaves.map(leaf => leaf.localLocation)).length,
      leafCount: leaves.length
    });
  }

  allocateContraptionId(): string {
    this.initialize();
    return this.#createContraptionId();
  }

  register(
    contraption: PhysicsContraption,
    snapshots: readonly CapturedTreeBlock[],
    origin: Vector3,
    options: ContraptionRegistrationOptions = { sleepTimeoutTicks: 60 }
  ): void {
    this.initialize();
    if (options.deferPersistence && options.sourceCommitted === false) {
      throw new Error("A deferred contraption registration must already own its source blocks.");
    }
    const leafPhysicsPlan = options.leafPhysicsPlan
      ?? createExactLeafPhysicsPlan(snapshots, origin);
    const detachedAttachments = (options.detachedAttachments ?? []).map(snapshot => ({
      localLocation: subtract(snapshot.location, origin),
      snapshot: cloneSnapshot(snapshot)
    }));
    const distances = computeLeafDistances(snapshots, origin);
    const fragileAttachments = new Map<string, FallenFragileBlock>();
    const leaves = new Map<string, FallenLeaf>();
    const logs = new Map<string, Vector3>();
    const snapshotsByLocation = new Map<string, CapturedTreeBlock>();
    for (const snapshot of snapshots) {
      const localLocation = subtract(snapshot.location, origin);
      const key = locationKey(localLocation);
      snapshotsByLocation.set(key, snapshot);
      if (snapshot.kind === "log") logs.set(key, localLocation);
      const fragileImpactSpeed = getContraptionFragileImpactSpeed(snapshot);
      if (fragileImpactSpeed === undefined) continue;
      if (snapshot.kind === "leaf") {
        const leaf: FallenLeaf = {
          distance: distances.get(key) ?? MAX_LEAF_DISTANCE,
          fragileImpactSpeed,
          localLocation,
          snapshot
        };
        leaves.set(key, leaf);
      } else {
        fragileAttachments.set(key, { fragileImpactSpeed, localLocation, snapshot });
      }
    }
    const persistenceId = options.persistenceId ?? this.#createContraptionId();
    if (this.#savedContraptions.has(persistenceId)) {
      throw new RangeError(`Fallen tree persistence id ${persistenceId} is already active.`);
    }
    const logBreakagePlan = createTreeLogBreakagePlan(
      [...logs].map(([key, localLocation]) => ({
        family: logFamily(snapshotsByLocation.get(key)!),
        key,
        localLocation
      })),
      {
        anchorLocation: selectContraptionVisualAnchor(contraption.blocks),
        inferFamilyFromStructure: snapshots.some(snapshot =>
          (snapshot.kind === "log" || snapshot.kind === "leaf")
          && !isVanillaTypeId(snapshot.typeId)
        ),
        seed: persistenceId
      }
    );
    const sleepTimeoutTicks = normalizeSleepTimeout(options.sleepTimeoutTicks);
    const initialSleepTicks = normalizeInitialSleepTicks(
      options.initialSleepTicks,
      sleepTimeoutTicks
    );
    const playerEditRevision = normalizePlayerEditRevision(options.playerEditRevision);
    const state: ContraptionState = {
      contraption,
      automaticLifecyclePaused: contraptionContainsNonTreeBlock(contraption.blocks),
      attachmentProbeCursor: 0,
      attachmentProbeKeys: [...fragileAttachments.keys()],
      boundaryThreatTicks: 0,
      chestStorages: createChestStorageMap(options.chestStorages ?? []),
      damagePose: getBodyPose(contraption),
      decayProgress: -1,
      detachedAttachmentCursor: 0,
      detachedAttachments,
      editJournalSequence: 0,
      fragileProbeCursor: 0,
      id: persistenceId,
      lastSafeBounds: contraption.body.getAabb(),
      lastSafePose: getBodyPose(contraption),
      fragileAttachments,
      leaves,
      leavesByDistance: createLeafDistanceBuckets(leaves),
      leafPhysicsPlan,
      leafProbeKeys: [...leaves.keys()],
      lavaExposureTicks: 0,
      logBreakagePlan,
      logBreakDamage: 0,
      logBreakGeneration: 0,
      logs,
      lootTool: options.lootTool,
      nextDecayTick: 0,
      pendingLogBreak: undefined,
      playerEditRevision,
      leafProbeCursor: 0,
      sleepTicks: initialSleepTicks,
      sleepTicksPerLog: normalizeSleepTicksPerLog(
        options.sleepTicksPerLog,
        sleepTimeoutTicks,
        logs.size
      ),
      sleepTimeoutTicks,
      sourceCommitted: options.sourceCommitted !== false,
      snapshots: snapshotsByLocation,
      topologyIndex: undefined,
      worldLeafProbeCursor: 0,
      worldNonLeafProbeKeys: [...logs.keys(), ...fragileAttachments.keys()],
      visualGeneration: normalizeVisualGeneration(options.visualGeneration)
    };
    this.#contraptions.set(contraption.id, state);
    this.#trackContraptionVisuals(contraption);
    if (!options.deferPersistence && state.chestStorages.size > 0) {
      this.#requireChestStorageController([...state.chestStorages.values()]);
      this.#chestStorage!.bindContraption(state.id, contraption, [...state.chestStorages.values()]);
    }
    this.#refreshTreeSnapshot(state, system.currentTick, true, true);
    if (options.deferPersistence) return;
    this.#writeSave();
    if (!state.sourceCommitted && !this.#persistedContraptionIds.has(state.id)) {
      this.#contraptions.delete(contraption.id);
      this.#untrackContraptionVisuals(contraption);
      this.#deleteTreeRecord(state.id);
      this.#writeSave();
      throw new Error("Could not persist the contraption preparation record.");
    }
  }

  commitRegistration(contraption: PhysicsContraption): void {
    const tree = this.#contraptions.get(contraption.id);
    if (!tree || tree.sourceCommitted) return;
    tree.sourceCommitted = true;
    this.#refreshTreeSnapshot(tree, system.currentTick, true);
    this.#writeSave();
    // Initial physicalization preserves the natural tree topology. Six-direction
    // replanning remains reserved for explicit non-tree topology changes.
  }

  cancelRegistration(contraption: PhysicsContraption): void {
    const tree = this.#contraptions.get(contraption.id);
    if (!tree) return;
    this.#cancelDetachedAttachmentSettlement(tree.id);
    this.#clearPendingCollisionState(contraption.id);
    this.#contraptions.delete(contraption.id);
    this.#untrackContraptionVisuals(contraption);
    this.#deleteTreeRecord(tree.id);
    this.#writeSave();
  }

  /** Drops every queued collision consequence for an contraption leaving the live set. */
  #clearPendingCollisionState(contraptionId: number): void {
    this.#pendingContraptionBlockBreaks.delete(contraptionId);
    this.#pendingLeafGroupBreaks.delete(contraptionId);
    this.#pendingLogImpacts.delete(contraptionId);
  }

  /** Emits one vanilla-style mining beat for a persisted contraption block. */
  emitBlockMiningEffects(
    contraption: PhysicsContraption,
    block: PhysicsContraptionBlock
  ): void {
    const snapshot = this.#requireBlockEffectSnapshot(contraption, block, "mining");
    const dimension = contraption.body.dimension.dimension;
    const position = contraption.body.localPointToWorld(block.localLocation);
    spawnBlockParticle(
      dimension,
      position,
      snapshot,
      block.localLocation,
      contraption.foliageTint,
      { kind: "destruct", profile: BLOCK_HIT_PARTICLE_PROFILE }
    );
    const sound = resolveVanillaBlockHitSound(snapshot.typeId);
    dimension.playSound(sound.sound, position, {
      pitch: sound.pitch,
      volume: sound.volume
    });
  }

  /** Emits the vanilla block-place sound after a persisted contraption edit commits. */
  emitBlockPlacementEffects(
    contraption: PhysicsContraption,
    block: PhysicsContraptionBlock
  ): void {
    const snapshot = this.#requireBlockEffectSnapshot(contraption, block, "placement");
    const dimension = contraption.body.dimension.dimension;
    const position = contraption.body.localPointToWorld(block.localLocation);
    const sound = resolveVanillaBlockPlaceSound(snapshot.typeId);
    dimension.playSound(sound.sound, position, {
      pitch: sound.pitch,
      volume: sound.volume
    });
  }

  #requireBlockEffectSnapshot(
    contraption: PhysicsContraption,
    block: PhysicsContraptionBlock,
    effect: "mining" | "placement"
  ): CapturedTreeBlock {
    const tree = this.#contraptions.get(contraption.id);
    if (!tree || tree.contraption !== contraption || !contraption.isValid) {
      throw new Error(
        `Physical tree contraption ${contraption.id} is not registered for ${effect}.`
      );
    }
    const key = locationKey(block.localLocation);
    const snapshot = tree.snapshots.get(key);
    if (!snapshot || snapshot.typeId !== block.typeId) {
      throw new Error(
        `Physical tree contraption ${contraption.id} has no matching ${effect} snapshot at ${key}.`
      );
    }
    return snapshot;
  }

  /** Retire inventory state already dropped by an externally killed storage entity. */
  handleChestStorageNativeDeath(
    ownerId: string,
    binding: ContraptionChestStorageBinding
  ): void {
    this.initialize();
    const key = locationKey(binding.localLocation);
    const tree = [...this.#contraptions.values()].find(candidate => candidate.id === ownerId);
    if (tree) {
      const current = tree.chestStorages.get(key);
      if (!current || current.storageId !== binding.storageId) {
        throw new Error(`Native death storage ${binding.storageId} does not match live tree ${ownerId}.`);
      }
      tree.chestStorages.delete(key);
      // Native death and its inventory drop are irreversible, so persist the
      // completed settlement instead of retaining a binding with no entity.
      this.#refreshTreeSnapshot(tree, system.currentTick, true, true);
      if (!this.#writeSave()) {
        throw new Error(`Could not persist native death of chest storage ${binding.storageId}.`);
      }
      return;
    }

    const saved = this.#savedContraptions.get(ownerId);
    if (!saved) {
      throw new Error(`Native death storage ${binding.storageId} has no owner ${ownerId}.`);
    }
    const index = saved.chestStorages.findIndex(candidate => (
      candidate.storageId === binding.storageId
      && locationKey(candidate.localLocation) === key
    ));
    if (index < 0) {
      throw new Error(`Native death storage ${binding.storageId} does not match saved tree ${ownerId}.`);
    }
    saved.chestStorages.splice(index, 1);
    this.#persistenceSignatures.delete(ownerId);
    this.#dirtyContraptionStructures.add(ownerId);
    if (!this.#writeSave()) {
      throw new Error(`Could not persist native death of chest storage ${binding.storageId}.`);
    }
  }

  /** Add one whitelisted ordinary block to an existing fragment contraption. */
  placeBlockForPlayerEdit(
    _player: Player,
    itemStack: ItemStack,
    contraption: PhysicsContraption,
    _supportBlock: PhysicsContraptionBlock,
    placement: Vector3,
    cardinalDirection: "north" | "east" | "south" | "west"
  ): boolean {
    this.initialize();
    if (!isSupportedOrdinaryContraptionBlock(itemStack.typeId)) return false;
    const tree = this.#contraptions.get(contraption.id);
    if (!tree || tree.contraption !== contraption || !contraption.isValid) return false;
    if (!tree.sourceCommitted || !this.#persistedContraptionIds.has(tree.id)) {
      throw new Error(`Fallen tree ${tree.id} is not durably committed for placement.`);
    }
    if (!Number.isInteger(placement.x) || !Number.isInteger(placement.y) || !Number.isInteger(placement.z)) {
      throw new RangeError("Contraption placement requires an integer local location.");
    }
    const key = locationKey(placement);
    if (contraption.getBlockAtLocalLocation(placement) || tree.snapshots.has(key)) return false;
    const sourceOrigin = getTreeSourceOrigin(tree);
    const snapshot: CapturedTreeBlock = {
      kind: "block",
      location: {
        x: sourceOrigin.x + placement.x,
        y: sourceOrigin.y + placement.y,
        z: sourceOrigin.z + placement.z
      },
      states: { "minecraft:cardinal_direction": cardinalDirection },
      typeId: itemStack.typeId
    };
    const block = createContraptionBlock(snapshot, sourceOrigin);
    if (!block.visual || block.visual.renderer !== "cube_block_fragment") return false;
    const previousSaved = this.#savedContraptions.get(tree.id);
    if (!previousSaved) throw new Error(`Fallen tree ${tree.id} has no persisted source record.`);
    const previousPaused = tree.automaticLifecyclePaused;
    let storageBinding: ContraptionChestStorageBinding | undefined;
    try {
      if (snapshot.typeId === "minecraft:chest") {
        if (!this.#chestStorage) throw new Error("Chest storage controller is not configured.");
        storageBinding = this.#chestStorage!.createStorage(tree.id, contraption, placement);
        tree.chestStorages.set(key, storageBinding);
      }
      const topologyIndex = this.#ensureTopologyIndex(tree);
      contraption.addBlocksAtLocalLocations([block]);
      topologyIndex.addBlocks([block]);
      this.#refreshContraptionVisualTracking(contraption);
      tree.snapshots.set(key, snapshot);
      tree.automaticLifecyclePaused = true;
      const stagedState = updateSerializedContraptionState(previousSaved, tree, system.currentTick);
      stagedState.automaticLifecyclePaused = true;
      this.#appendTreeEditJournal(tree, {
        additions: [{ block, chestStorage: storageBinding, snapshot }],
        sleepTimeoutTicks: tree.sleepTimeoutTicks,
        state: splitSerializedContraption(stagedState).state
      });
      return true;
    } catch (error) {
      if (contraption.isValid) {
        const removed = contraption.removeBlocksAtLocalLocations([placement]);
        if (removed.length > 0) tree.topologyIndex?.removeBlocks(removed);
      }
      tree.snapshots.delete(key);
      if (storageBinding) {
        tree.chestStorages.delete(key);
        this.#chestStorage!.discardStorage(storageBinding.storageId);
      }
      if (contraption.isValid) this.#refreshContraptionVisualTracking(contraption);
      tree.automaticLifecyclePaused = previousPaused;
      if (error instanceof Error && error.message.startsWith("Could not persist")) return false;
      throw error;
    }
  }

  /**
   * Applies an edit in place while the tree remains connected, or replaces it
   * with its face-connected components after a real split. Persistent records
   * become authoritative before the live body is changed.
   */
  breakBlockForPlayerEdit(
    _player: Player,
    itemStack: ItemStack | undefined,
    contraption: PhysicsContraption,
    block: PhysicsContraptionBlock
  ): boolean {
    this.initialize();
    const tree = this.#contraptions.get(contraption.id);
    if (!tree || tree.contraption !== contraption || !contraption.isValid) return false;
    if (!tree.sourceCommitted || !this.#persistedContraptionIds.has(tree.id)) {
      throw new Error(`Fallen tree ${tree.id} is not durably committed for editing.`);
    }

    const targetKey = locationKey(block.localLocation);
    const currentBlock = contraption.getBlockAtLocalLocation(block.localLocation);
    const targetSnapshot = tree.snapshots.get(targetKey);
    if (!currentBlock || currentBlock.typeId !== block.typeId || !targetSnapshot) return false;
    const editableKind = playerEditableContraptionBlockKind(targetSnapshot.typeId);
    if (editableKind === undefined || targetSnapshot.kind !== editableKind) return false;

    const topology = this.#ensureTopologyIndex(tree).createPlanAfterRemoving(
      [block.localLocation],
      tree.snapshots
    );
    const body = contraption.body;
    const dimension = body.dimension.dimension;
    const breakEffects: PlayerEditBreakEffect[] = [{
      localLocation: { ...block.localLocation },
      position: body.localPointToWorld(block.localLocation),
      snapshot: targetSnapshot,
      tool: itemStack
    }];
    for (const unsupported of topology.unsupportedTreeBlocks) {
      const key = locationKey(unsupported.localLocation);
      const snapshot = tree.snapshots.get(key);
      if (!snapshot) {
        throw new Error(`Tree-only edit fragment ${key} has no captured block snapshot.`);
      }
      breakEffects.push({
        localLocation: { ...unsupported.localLocation },
        position: body.localPointToWorld(unsupported.localLocation),
        snapshot
      });
    }

    const remainingDetachedAttachments = remainingDetachedAttachmentSnapshots(tree);
    if (topology.components.length === 0) {
      for (const entry of tree.detachedAttachments.slice(tree.detachedAttachmentCursor)) {
        breakEffects.push({
          localLocation: { ...entry.localLocation },
          position: body.localPointToWorld(entry.localLocation),
          snapshot: cloneSnapshot(entry.snapshot)
        });
      }
    }

    const stagedComponents = stageTreeTopologyComponents(
      tree,
      topology.components,
      topology.attachmentStateUpdates
    );
    const childSleepTicks = allocateTreeEditSettlementTicks(
      tree.sleepTicks,
      tree.sleepTicksPerLog,
      stagedComponents.map(component => component.logCount)
    );
    if (
      stagedComponents.length === 1
      && stagedComponents[0]!.component.blocks.some(block => (
        block.collidable !== false && block.collisionShape !== "none"
      ))
    ) {
      const staged = stagedComponents[0]!;
      const initialSleepTicks = childSleepTicks[0];
      if (initialSleepTicks === undefined) {
        throw new Error("Edited tree has no settlement-tick allocation.");
      }
      this.#applyPlayerEditInPlace(
        tree,
        staged.component,
        staged.logCount,
        initialSleepTicks,
        breakEffects,
        topology.attachmentStateUpdates
      );
      return true;
    }

    this.#replaceTreeWithTopologyComponents(
      tree,
      stagedComponents,
      childSleepTicks,
      remainingDetachedAttachments
    );

    this.#emitPlayerEditBreakEffects(dimension, contraption.foliageTint, breakEffects);
    return true;
  }

  /**
   * Atomically replaces one live tree with already-planned topology components.
   * Both player edits and automatic fragile-block breaks use this transaction so
   * physical children and chest-storage ownership cannot diverge.
   */
  #replaceTreeWithTopologyComponents(
    tree: ContraptionState,
    stagedComponents: readonly StagedTreeTopologyComponent[],
    childSleepTicks: readonly number[],
    remainingDetachedAttachments: readonly CapturedTreeBlock[]
  ): readonly ContraptionState[] {
    const contraption = tree.contraption;
    const body = contraption.body;
    const dimension = body.dimension.dimension;
    const sourceOrigin = getTreeSourceOrigin(tree);
    const bodyLocation = { ...body.location };
    const bodyRotation = body.getRotation();
    const bodyAngularVelocity = { ...body.angularVelocity };
    const stagedTrees: ContraptionState[] = [];
    try {
      for (let index = 0; index < stagedComponents.length; index++) {
        const {
          chestStorages,
          component,
          logCount,
          snapshots: componentSnapshots
        } = stagedComponents[index]!;
        const initialSleepTicks = childSleepTicks[index];
        if (initialSleepTicks === undefined) {
          throw new Error("Edited child has no settlement-tick allocation.");
        }
        const childId = this.#createContraptionId();
        const visualGeneration = EDITED_TREE_VISUAL_GENERATION;
        const leafPhysicsPlan = createEditedLeafPhysicsPlan(
          componentSnapshots,
          sourceOrigin,
          tree.leafPhysicsPlan.profile.id
        );
        const localCenter = getComponentCenterOfMass(component.blocks);
        const velocity = body.getVelocityAt(body.localPointToWorld(localCenter));
        let childContraption: PhysicsContraption | undefined;
        try {
          childContraption = body.dimension.createContraption({
            angularVelocity: bodyAngularVelocity,
            blocks: component.blocks.map(cloneLiveContraptionBlock),
            foliageTint: contraption.foliageTint,
            location: bodyLocation,
            name: "Edited physical tree",
            rotation: bodyRotation,
            runtimeRepresentation: createTreeLeafPhysicsRuntimeRepresentation(leafPhysicsPlan),
            velocity,
            visualEntityTags: [createContraptionVisualTag(childId, visualGeneration)]
          });
          this.register(childContraption, componentSnapshots, sourceOrigin, {
            chestStorages,
            deferPersistence: true,
            detachedAttachments: index === 0 ? remainingDetachedAttachments : undefined,
            initialSleepTicks,
            leafPhysicsPlan,
            lootTool: tree.lootTool,
            persistenceId: childId,
            playerEditRevision: tree.playerEditRevision + 1,
            sleepTicksPerLog: tree.sleepTicksPerLog,
            sleepTimeoutTicks: Math.max(
              tree.sleepTicksPerLog,
              logCount * tree.sleepTicksPerLog
            ),
            sourceCommitted: true,
            visualGeneration
          });
        } catch (error) {
          childContraption?.remove();
          throw error;
        }
        const child = this.#contraptions.get(childContraption.id);
        if (!child) throw new Error("Deferred edited-tree registration did not create state.");
        stagedTrees.push(child);
      }
    } catch (error) {
      for (const child of stagedTrees) this.#discardUncommittedTree(child);
      throw error;
    }

    const parentSaved = this.#savedContraptions.get(tree.id);
    if (!parentSaved) {
      for (const child of stagedTrees) this.#discardUncommittedTree(child);
      throw new Error(`Fallen tree ${tree.id} has no persisted source record.`);
    }
    const parentSignature = this.#persistenceSignatures.get(tree.id);
    const parentStateDirty = this.#dirtyContraptionStates.has(tree.id);
    const parentStructureDirty = this.#dirtyContraptionStructures.has(tree.id);
    this.#deleteTreeRecord(tree.id);
    const childIds = new Set(stagedTrees.map(child => child.id));
    if (!this.#writeSave(childIds)) {
      this.#restoreTreeRecordAfterFailedEdit(
        tree.id,
        parentSaved,
        parentSignature,
        parentStateDirty,
        parentStructureDirty
      );
      for (const child of stagedTrees) this.#discardUncommittedTree(child);
      throw new Error(`Could not commit edited contraption replacement for ${tree.id}.`);
    }

    this.#contraptions.delete(contraption.id);
    this.#clearPendingCollisionState(contraption.id);
    const storageReplacements: ContraptionChestStorageReplacement[] = stagedTrees.map(staged => ({
      contraption: staged.contraption,
      bindings: [...staged.chestStorages.values()],
      ownerId: staged.id
    }));
    const retainedStorageIds = new Set(
      storageReplacements.flatMap(replacement => replacement.bindings.map(binding => binding.storageId))
    );
    const removedChestStorages = [...tree.chestStorages.values()].filter(binding => (
      !retainedStorageIds.has(binding.storageId)
    ));
    if (tree.chestStorages.size > 0) {
      this.#requireChestStorageController([...tree.chestStorages.values()]);
      this.#chestStorage!.replaceContraptionStorages(tree.id, contraption, storageReplacements);
    }
    this.#settleChestStorages(
      tree.id,
      removedChestStorages,
      dimension,
      localLocation => body.localPointToWorld(localLocation)
    );
    this.#untrackContraptionVisuals(contraption);
    contraption.remove();
    this.#onContraptionReplaced?.(
      contraption,
      stagedTrees.map(staged => staged.contraption)
    );
    return stagedTrees;
  }

  /**
   * Commits a connected edit under the existing tree id, then removes only the
   * affected live blocks. This keeps the current fragment entities and pose.
   */
  #applyPlayerEditInPlace(
    tree: ContraptionState,
    component: TreeEditTopologyComponent,
    logCount: number,
    initialSleepTicks: number,
    breakEffects: readonly PlayerEditBreakEffect[],
    attachmentStateUpdates: readonly TreeEditTopologyAttachmentStateUpdate[]
  ): void {
    const currentTick = system.currentTick;
    const remainingKeys = new Set(
      component.blocks.map(block => locationKey(block.localLocation))
    );
    const removedChestStorages = [...tree.chestStorages]
      .filter(([key]) => !remainingKeys.has(key))
      .map(([, binding]) => binding);
    const remainingChestStorages = [...tree.chestStorages]
      .filter(([key]) => remainingKeys.has(key))
      .map(([, binding]) => cloneChestStorageBinding(binding));
    const updatedSnapshots = new Map(
      attachmentStateUpdates.map(update => [update.key, update.snapshot])
    );
    const remainingSnapshots = [...tree.snapshots]
      .filter(([key]) => remainingKeys.has(key))
      .map(([key, snapshot]) => updatedSnapshots.get(key) ?? snapshot);
    const leafDistances = computeLeafDistances(
      remainingSnapshots,
      getTreeSourceOrigin(tree)
    );
    const removalLocations = breakEffects.map(effect => effect.localLocation);
    const remainingDetachedAttachments = tree.detachedAttachments
      .slice(tree.detachedAttachmentCursor)
      .map(entry => ({
        localLocation: { ...entry.localLocation },
        snapshot: cloneSnapshot(entry.snapshot)
      }));
    const sleepTimeoutTicks = normalizeSleepTimeout(Math.max(
      tree.sleepTicksPerLog,
      logCount * tree.sleepTicksPerLog
    ));
    const nextPlayerEditRevision = normalizePlayerEditRevision(
      tree.playerEditRevision + 1
    );
    const currentPose = getBodyPose(tree.contraption);

    const previousSaved = this.#savedContraptions.get(tree.id);
    if (!previousSaved) {
      throw new Error(`Fallen tree ${tree.id} has no persisted source record.`);
    }
    const stagedState = updateSerializedContraptionState(previousSaved, tree, currentTick);
    stagedState.automaticLifecyclePaused = component.containsNonTreeBlock;
    stagedState.attachmentProbeCursor = 0;
    stagedState.boundaryThreatTicks = 0;
    stagedState.decayProgress = -1;
    stagedState.detachedAttachmentCursor = 0;
    stagedState.fragileProbeCursor = 0;
    stagedState.lastSafePose = currentPose;
    stagedState.lavaExposureTicks = 0;
    stagedState.logBreakDamage = 0;
    stagedState.nextDecayDelayTicks = 0;
    stagedState.pendingLavaDestruction = undefined;
    stagedState.pendingSettlement = undefined;
    stagedState.playerEditRevision = nextPlayerEditRevision;
    stagedState.probeCursor = 0;
    stagedState.sleeping = false;
    stagedState.sleepTicks = initialSleepTicks;
    stagedState.worldLeafProbeCursor = 0;
    this.#appendTreeEditJournal(tree, {
      additions: attachmentStateUpdates.map(update => ({
        block: update.block,
        snapshot: update.snapshot
      })),
      clearPendingLogBreak: true,
      detachedAttachments: remainingDetachedAttachments,
      removedKeys: [...new Set([
        ...removalLocations.map(locationKey),
        ...attachmentStateUpdates.map(update => update.key)
      ])],
      sleepTimeoutTicks,
      state: splitSerializedContraption(stagedState).state
    });

    this.#cancelDetachedAttachmentSettlement(tree.id);
    this.#clearPendingCollisionState(tree.contraption.id);
    const removed = tree.contraption.removeBlocksAtLocalLocations(removalLocations);
    if (removed.length !== removalLocations.length || !tree.contraption.isValid) {
      throw new Error(`Committed in-place contraption edit ${tree.id} could not update its body.`);
    }
    const topologyIndex = this.#ensureTopologyIndex(tree);
    topologyIndex.removeBlocks(removed);
    topologyIndex.markCanonicalSingleComponent();
    this.#refreshContraptionVisualTracking(tree.contraption);
    this.#applyTreeAttachmentStateUpdates(tree, attachmentStateUpdates);
    this.#settleChestStorages(
      tree.id,
      removedChestStorages,
      tree.contraption.body.dimension.dimension,
      localLocation => tree.contraption.body.localPointToWorld(localLocation)
    );
    tree.chestStorages = createChestStorageMap(remainingChestStorages);

    for (const removedBlock of removed) {
      const key = locationKey(removedBlock.localLocation);
      tree.logs.delete(key);
      tree.fragileAttachments.delete(key);
      const leaf = tree.leaves.get(key);
      if (leaf) {
        tree.leaves.delete(key);
        tree.leavesByDistance.get(leaf.distance)?.delete(key);
      }
      tree.snapshots.delete(key);
    }
    for (const [key, leaf] of tree.leaves) {
      leaf.distance = leafDistances.get(key) ?? MAX_LEAF_DISTANCE;
    }
    tree.automaticLifecyclePaused = component.containsNonTreeBlock;
    tree.attachmentProbeCursor = 0;
    tree.attachmentProbeKeys = [...tree.fragileAttachments.keys()];
    tree.boundaryThreatTicks = 0;
    tree.decayProgress = -1;
    tree.detachedAttachmentCursor = 0;
    tree.detachedAttachments = remainingDetachedAttachments;
    tree.fragileProbeCursor = 0;
    tree.lavaExposureTicks = 0;
    tree.leafProbeKeys = [...tree.leaves.keys()];
    tree.leavesByDistance = createLeafDistanceBuckets(tree.leaves);
    tree.logBreakagePlan = pruneTreeLogBreakagePlan(
      tree.logBreakagePlan,
      new Set(tree.logs.keys())
    );
    tree.logBreakDamage = 0;
    tree.nextDecayTick = 0;
    tree.pendingLogBreak = undefined;
    tree.playerEditRevision = nextPlayerEditRevision;
    tree.leafProbeCursor = 0;
    tree.sleepTicks = initialSleepTicks;
    tree.sleepTimeoutTicks = sleepTimeoutTicks;
    tree.worldLeafProbeCursor = 0;
    tree.worldNonLeafProbeKeys = [...tree.logs.keys(), ...tree.fragileAttachments.keys()];
    tree.lastNearestPlayerDistance = undefined;
    tree.contraption.body.wakeUp();
    tree.damagePose = getBodyPose(tree.contraption);
    tree.lastSafePose = getBodyPose(tree.contraption);
    tree.lastSafeBounds = tree.contraption.body.getAabb();

    this.#emitPlayerEditBreakEffects(
      tree.contraption.body.dimension.dimension,
      tree.contraption.foliageTint,
      breakEffects
    );
  }

  /** Applies captured attachment state without rebuilding its visual fragment. */
  #applyTreeAttachmentStateUpdates(
    tree: ContraptionState,
    updates: readonly TreeAttachmentStateUpdate[]
  ): void {
    const updatedBlocks: PhysicsContraptionBlock[] = [];
    for (const update of updates) {
      const location = parseLocationKey(update.key);
      const visual = createFragmentVisual(update.snapshot);
      if (!visual || visual.renderer !== "attachment_fragment") {
        throw new Error(`Updated tree attachment ${update.key} has no attachment visual state.`);
      }
      if (!tree.contraption.setAttachmentBlockVisualState(location, visual.state)) {
        throw new Error(`Could not update tree attachment visual state at ${update.key}.`);
      }
      const block = tree.contraption.getBlockAtLocalLocation(location);
      if (!block) throw new Error(`Updated tree attachment ${update.key} has no live block.`);
      updatedBlocks.push(block);
      const snapshot = cloneSnapshot(update.snapshot);
      tree.snapshots.set(update.key, snapshot);
      const fragile = tree.fragileAttachments.get(update.key);
      if (fragile) {
        tree.fragileAttachments.set(update.key, { ...fragile, snapshot });
      }
    }
    tree.topologyIndex?.updateBlocks(updatedBlocks);
  }

  #emitPlayerEditBreakEffects(
    dimension: Dimension,
    foliageTint: PhysicsContraptionFoliageTint | undefined,
    effects: readonly PlayerEditBreakEffect[]
  ): void {
    for (const effect of effects) {
      // The first effect is the mined target; every committed removal receives
      // exactly one final destruct burst in addition to its mining-hit bursts.
      spawnBlockParticle(
        dimension,
        effect.position,
        effect.snapshot,
        effect.localLocation,
        foliageTint,
        { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
      );
      spawnPermutationDrops(dimension, effect.snapshot, effect.position, effect.tool);
      spawnBeeNestBees(dimension, effect.snapshot, effect.position, undefined, new Set());
    }
    const target = effects[0];
    if (!target) return;
    const sound = resolveVanillaBlockBreakSound(target.snapshot.typeId);
    dimension.playSound(sound.sound, target.position, {
      pitch: sound.pitch,
      volume: sound.volume
    });
  }

  /** Renders player movement flecks from the contraption's authoritative block snapshot. */
  handleSurfaceParticle(event: PhysicsContraptionSurfaceParticleAfterEvent): void {
    const tree = this.#contraptions.get(event.contraptionId);
    if (!tree) return;
    const snapshot = tree.snapshots.get(locationKey(event.block.localLocation));
    if (!snapshot) {
      throw new Error(
        `Physical tree contraption ${event.contraptionId} has no surface particle snapshot at `
        + `${locationKey(event.block.localLocation)}.`
      );
    }
    spawnBlockParticle(
      event.dimension,
      event.location,
      snapshot,
      event.block.localLocation,
      tree.contraption.foliageTint,
      {
        kind: "destruct",
        profile: {
          direction: event.profile.direction,
          directionRandomness: event.profile.directionRandomness,
          offsetRadius: event.profile.offsetRadius,
          particleCount: event.profile.particleCount,
          radius: 0,
          speedMax: event.profile.speedMax,
          speedMin: event.profile.speedMin,
          velocityScalar: 1
        }
      }
    );
  }

  handleCollision(event: PhysicsCollisionAfterEvent): string | undefined {
    const indexedWorldSensorHits = getIndexedWorldSensorHits(event);
    if (indexedWorldSensorHits) {
      return this.#handleIndexedWorldSensorCollision(event, indexedWorldSensorHits);
    }
    this.#prepareCollisionCache(event.currentTick);
    const worldHit = this.#queueFragileWorldBlock(event);
    const tree = this.#contraptions.get(event.body.id);
    let treeHitBlock: PhysicsContraptionBlock | undefined;
    if (tree) {
      this.#queueTreeLogImpact(tree, event.impactSpeed, event.point);
      treeHitBlock = this.#queueCollidingContraptionBlock(
        tree,
        event.point,
        event.impactSpeed,
        event.collisionTag
      );
      this.#spawnCollisionParticles(tree, event, worldHit, treeHitBlock);
    }
    const otherTree = event.otherBody ? this.#contraptions.get(event.otherBody.id) : undefined;
    if (otherTree) {
      this.#queueTreeLogImpact(otherTree, event.impactSpeed, event.point);
      this.#queueCollidingContraptionBlock(
        otherTree,
        event.point,
        event.impactSpeed,
        event.otherCollisionTag
      );
    }
    const collisionTypeId = worldHit?.typeId ?? treeHitBlock?.typeId;
    if (!tree || tree.decayProgress >= 0 || event.impactSpeed < LOG_IMPACT_TRIGGER_SPEED) {
      return collisionTypeId;
    }
    const hitBlock = treeHitBlock ?? tree.contraption.getBlockAtWorldPoint(event.point, CONTRAPTION_BLOCK_LOOKUP_TOLERANCE);
    if (!hitBlock || !isTreeLog(hitBlock.typeId)) return collisionTypeId;
    if (getContraptionUprightness(tree.contraption) >= DECAY_UPRIGHTNESS_THRESHOLD) return collisionTypeId;
    tree.decayProgress = 0;
    tree.nextDecayTick = system.currentTick + 1;
    return collisionTypeId;
  }

  #handleIndexedWorldSensorCollision(
    event: PhysicsCollisionAfterEvent,
    hits: readonly IndexedWorldSensorHit[]
  ): string | undefined {
    this.#prepareCollisionCache(event.currentTick);
    if (hits.length === 0) return undefined;
    let representative = hits[0]!;
    const strongestByCollisionTag = new Map<
      IndexedWorldSensorHit["collisionTag"],
      IndexedWorldSensorHit
    >();
    for (const hit of hits) {
      if (hit.impactSpeed > representative.impactSpeed) representative = hit;
      const previous = strongestByCollisionTag.get(hit.collisionTag);
      if (!previous || hit.impactSpeed > previous.impactSpeed) {
        strongestByCollisionTag.set(hit.collisionTag, hit);
      }
    }

    const physicsDimension = event.body.dimension;
    let worldHit: WorldCollisionHit | undefined;
    for (const hit of hits) {
      const block = this.#getCollisionWorldBlock(
        physicsDimension.dimension,
        hit.worldBlockLocation
      );
      if (!block || block.isAir || block.isLiquid) continue;
      worldHit ??= { locationKey: locationKey(block.location), typeId: block.typeId };
      const threshold = getWorldFragileImpactSpeed(physicsDimension, block);
      if (!Number.isFinite(threshold) || hit.impactSpeed < threshold!) continue;
      this.#queueWorldBlockBreak(physicsDimension, block);
    }

    const tree = this.#contraptions.get(event.body.id);
    if (!tree) return worldHit?.typeId;
    this.#queueTreeLogImpact(tree, representative.impactSpeed, representative.point);
    let representativeTreeHit: PhysicsContraptionBlock | undefined;
    let decayHit: { block: PhysicsContraptionBlock; hit: IndexedWorldSensorHit } | undefined;
    for (const hit of strongestByCollisionTag.values()) {
      const treeHit = this.#queueCollidingContraptionBlock(
        tree,
        hit.point,
        hit.impactSpeed,
        hit.collisionTag
      );
      if (hit === representative) representativeTreeHit = treeHit;
      if (
        !decayHit
        && hit.impactSpeed >= LOG_IMPACT_TRIGGER_SPEED
        && treeHit
        && isTreeLog(treeHit.typeId)
      ) {
        decayHit = { block: treeHit, hit };
      }
    }

    const collisionTypeId = worldHit?.typeId ?? representativeTreeHit?.typeId;
    if (
      tree.decayProgress < 0
      && decayHit
      && getContraptionUprightness(tree.contraption) < DECAY_UPRIGHTNESS_THRESHOLD
    ) {
      tree.decayProgress = 0;
      tree.nextDecayTick = system.currentTick + 1;
    }
    return collisionTypeId;
  }

  handleWaterEntry(event: PhysicsWaterEntryAfterEvent): void {
    if (!this.#contraptions.has(event.body.id)) return;
    const { impulse, scaleX, scaleZ } = computeFluidEntryContact(event);
    const contactArea = scaleX * scaleZ;
    const soundVolume = computeFluidEntrySoundVolume(1, impulse, contactArea);
    const molang = new MolangVariableMap();
    molang.setFloat(
      "variable.water_impulse",
      impulse
    );
    molang.setFloat(
      "variable.water_scale_x",
      scaleX
    );
    molang.setFloat(
      "variable.water_scale_z",
      scaleZ
    );
    try {
      event.body.dimension.dimension.spawnParticle(TREE_SPLASH_PARTICLE_ID, event.point, molang);
    } catch {
      // Particle availability must not affect physics.
    }
    try {
      event.body.dimension.dimension.playSound("entity.generic.splash", event.point, {
        pitch: 0.6 + Math.random() * 0.8,
        volume: soundVolume
      });
    } catch {
      // Entry audio is cosmetic and must not affect physics.
    }
  }

  handleLavaEntry(event: PhysicsLavaEntryAfterEvent): void {
    if (!this.#contraptions.has(event.body.id)) return;
    const { impulse, scaleX, scaleZ } = computeFluidEntryContact(event);
    const area = scaleX * scaleZ;
    const contactScale = Math.sqrt(area);
    const baseVolume = 0.4 + Math.random() * 0.2;
    const soundVolume = computeFluidEntrySoundVolume(baseVolume, impulse, area);
    try {
      event.body.dimension.dimension.playSound("liquid.lavapop", event.point, {
        pitch: 0.9 + Math.random() * 0.15,
        volume: soundVolume
      });
    } catch {
      // Entry audio is cosmetic and must not affect physics.
    }
    if (!Number.isFinite(impulse) || impulse < LAVA_ENTRY_MIN_PARTICLE_IMPULSE) return;
    const count = Math.min(
      LAVA_ENTRY_MAX_SPARKS,
      Math.max(
        24,
        Math.floor(
          (8 + contactScale * 20)
          * (0.85 + Math.min(2, impulse) * 0.15)
        )
      )
    );
    const molang = new MolangVariableMap();
    molang.setFloat("variable.lava_count", count);
    molang.setFloat("variable.lava_impulse", impulse);
    molang.setFloat("variable.lava_radius_x", Math.min(32, scaleX * 0.5));
    molang.setFloat("variable.lava_radius_z", Math.min(32, scaleZ * 0.5));
    molang.setFloat("variable.lava_speed_scale", Math.min(1.6, 0.75 + impulse * 0.35));
    molang.setFloat("variable.lava_vertical_scale", Math.min(2, 0.85 + impulse * 0.6));
    try {
      event.body.dimension.dimension.spawnParticle(TREE_LAVA_SPLASH_PARTICLE_ID, event.point, molang);
    } catch {
      // Lava visuals must not affect physics or lifecycle state.
    }
  }

  handleVisualEntityLoad(entity: Entity): void {
    if (!isContraptionVisualEntity(entity)) return;
    system.run(() => {
      if (!entity.isValid || this.#managedVisualEntityIds.has(entity.id)) return;
      for (const tree of this.#contraptions.values()) {
        if (!tree.contraption.isValid || !tree.contraption.hasVisualEntity(entity.id)) continue;
        // Persistent storage carriers may be created after registration. The
        // live renderer is authoritative for their ownership, so include the
        // complete current entity set before orphan cleanup runs.
        this.#refreshContraptionVisualTracking(tree.contraption);
        return;
      }
      try {
        entity.remove();
      } catch {
        // A later load event or bounded recovery scan will retry cleanup.
      }
    });
  }

  tick(currentTick: number): void {
    this.initialize();
    const players = this.#crossDomain ? world.getAllPlayers() : [];
    if (this.#crossDomain) this.#reconcileLoadedVisuals(players, currentTick);
    this.#collisionEffectKeys.clear();
    this.#collisionWorldBlockCache.clear();
    if (
      this.#contraptions.size === 0
      && this.#savedContraptions.size === 0
      && this.#deletedContraptionIds.size === 0
      && this.#pendingDetachedAttachments.size === 0
      && this.#pendingSettlements.size === 0
    ) {
      this.#damageCooldownUntilTick.clear();
      return;
    }
    this.#chunkReadabilityCache.clear();
    const playersByDimension = this.#crossDomain
      && (this.#contraptions.size > 0 || this.#savedContraptions.size > 0)
      ? groupPlayersByDimension(players)
      : undefined;
    if (this.#crossDomain) this.#restoreAvailableTrees(players, currentTick);
    const damageTrees = this.#damageTreeBuffer;
    damageTrees.length = 0;
    const activeTrees = this.#activeTreeTickBuffer;
    activeTrees.length = 0;
    for (const [id, tree] of this.#contraptions) {
      if (!tree.contraption.isValid) {
        this.#untrackContraptionVisuals(tree.contraption);
        try {
          tree.contraption.remove();
        } catch {
          // The next bounded visual reconciliation remains the cleanup barrier.
        }
        this.#cancelDetachedAttachmentSettlement(tree.id);
        this.#clearPendingCollisionState(id);
        this.#contraptions.delete(id);
        this.#deleteTreeRecord(tree.id);
        continue;
      }
      let crossedDomain = false;
      // Edited sleeping assemblies cannot move toward an unloaded boundary, so
      // stagger their readability probes without changing settlement semantics.
      if (
        this.#crossDomain
        && (
          !tree.automaticLifecyclePaused
          || !tree.contraption.body.isSleeping
          || (currentTick + tree.contraption.id) % PAUSED_CROSS_DOMAIN_CHECK_INTERVAL_TICKS === 0
        )
      ) {
        crossedDomain = this.#tickCrossDomain(
          tree,
          playersByDimension?.get(tree.contraption.body.dimension.id) ?? [],
          currentTick
        );
      }
      if (crossedDomain) {
        this.#contraptions.delete(id);
        continue;
      }
      // Broken carriers or riding links are terminal visual corruption.
      // Missing native collision proxies follow the same terminal settlement path.
      // Use the normal break/drop transaction instead of rebuilding partial state.
      let integrityFailureReason: string | undefined;
      if (tree.contraption.hasKnownCollisionIntegrityFailure()) {
        integrityFailureReason = "known collision integrity failure";
      } else if (tree.contraption.hasKnownVisualIntegrityFailure()) {
        integrityFailureReason = "known visual integrity failure";
      } else if (
        (currentTick + id) % VISUAL_INTEGRITY_CHECK_INTERVAL_TICKS === 0
        && !tree.contraption.hasIntactVisualEntities()
      ) {
        integrityFailureReason = "periodic visual integrity mismatch";
      }
      if (integrityFailureReason) {
        this.#settleTree(tree);
        this.#contraptions.delete(id);
        throw new Error(
          `Contraption ${tree.id} (runtime ${id}) settled after ${integrityFailureReason}.`
        );
      }
      const lavaExposure = this.#tickLavaExposure(tree, currentTick);
      if (lavaExposure === "destroyed") {
        this.#contraptions.delete(id);
        continue;
      }
      if (lavaExposure === "pending") continue;
      activeTrees.push({ lavaExposure, tree });
    }

    // Resolve all active tree probes in one sparse native query per dimension.
    // Post-probe lifecycle work remains ordered exactly as it was before batching.
    this.#probeContraptionFragileContacts(activeTrees);
    for (const { lavaExposure, tree } of activeTrees) {
      const id = tree.contraption.id;
      this.#tickDecay(tree, currentTick);
      const removedByLogBreak = this.#flushCollidingContraptionBlocks(tree);
      if (removedByLogBreak) {
        this.#contraptions.delete(id);
        continue;
      }
      if (tree.contraption.body.isActive && tree.logs.size > 0) {
        damageTrees.push(tree);
      }
      if (lavaExposure !== "heated") {
        const settled = this.#tickSettlement(tree);
        if (settled) this.#contraptions.delete(id);
      }
    }
    activeTrees.length = 0;
    if (damageTrees.length > 0) this.#damageEntities(damageTrees, currentTick);
    damageTrees.length = 0;
    if (currentTick % DAMAGE_STATE_PRUNE_INTERVAL_TICKS === 0) this.#pruneDamageState(currentTick);
    this.#refreshPersistenceSlice(currentTick);
    this.#writeSave();
    this.#startReadyDetachedAttachmentJobs(currentTick);
    this.#startReadySettlementJobs();
  }

  #damageEntities(
    trees: readonly ContraptionState[],
    currentTick: number
  ): void {
    const clustersByDimension = new Map<Dimension, DamageQueryCluster[]>();
    for (let order = 0; order < trees.length; order++) {
      const tree = trees[order]!;
      const currentPose = getBodyPose(tree.contraption);
      const bodyBounds = tree.contraption.body.getAabb();
      if (!canTreeReachDamageSpeed(tree, currentPose, bodyBounds)) {
        tree.damagePose = currentPose;
        continue;
      }
      const dimension = tree.contraption.body.dimension.dimension;
      let clusters = clustersByDimension.get(dimension);
      if (!clusters) {
        clusters = [];
        clustersByDimension.set(dimension, clusters);
      }
      addDamageQueryProbe(clusters, {
        bounds: expandBounds(bodyBounds, 0.5),
        currentPose,
        order,
        tree
      });
    }

    for (const clusters of clustersByDimension.values()) {
      for (const cluster of clusters) {
        let entities: Entity[];
        try {
          const bounds = cluster.bounds;
          entities = cluster.dimension.getEntities({
            location: { ...bounds.min },
            volume: {
              x: bounds.max.x - bounds.min.x,
              y: bounds.max.y - bounds.min.y,
              z: bounds.max.z - bounds.min.z
            }
          });
        } catch {
          for (const probe of cluster.probes) probe.tree.damagePose = probe.currentPose;
          continue;
        }
        const candidates = prepareDamageCandidates(entities);
        cluster.probes.sort((left, right) => left.order - right.order);
        for (const probe of cluster.probes) {
          this.#damageTreeCandidates(probe.tree, candidates, currentTick);
          probe.tree.damagePose = probe.currentPose;
        }
      }
    }
  }

  #damageTreeCandidates(
    tree: ContraptionState,
    candidates: readonly DamageCandidate[],
    currentTick: number
  ): void {
    const body = tree.contraption.body;
    for (const candidate of candidates) {
      const { baseLocation, entity, headLocation } = candidate;
      const localBase = body.worldPointToLocal(baseLocation);
      const localHead = body.worldPointToLocal(headLocation);
      const contact = findDamageLogContact(tree.logs, localBase, localHead);
      if (!contact) continue;
      const { logLocation } = contact;
      try {
        if (this.#isDamageImmune(tree.contraption, entity)) continue;
      } catch {
        continue;
      }
      if ((this.#damageCooldownUntilTick.get(entity.id) ?? 0) > currentTick) continue;

      const worldLogCenter = body.localPointToWorld(logLocation);
      const instantaneousTreeVelocity = body.getVelocityAt(worldLogCenter);
      const sweptTreeVelocity = getTreePoseVelocityAt(
        tree.damagePose,
        worldLogCenter,
        logLocation
      );
      const treeVelocity = vectorLengthSquared(sweptTreeVelocity)
          > vectorLengthSquared(instantaneousTreeVelocity)
        ? sweptTreeVelocity
        : instantaneousTreeVelocity;
      const impactSpeed = Math.sqrt(vectorLengthSquared(treeVelocity));
      const damage = getTreeImpactDamage(impactSpeed);
      if (damage <= 0) continue;
      try {
        const damaged = entity.applyDamage(damage, { cause: EntityDamageCause.fallingBlock });
        if (!damaged) continue;
        const centerOfMass = body.localPointToWorld(body.getCenterOfMass());
        const direction = horizontalDirection(centerOfMass, entity.location, treeVelocity);
        entity.applyKnockback(
          {
            x: direction.x * DAMAGE_KNOCKBACK_HORIZONTAL_SCALE,
            z: direction.z * DAMAGE_KNOCKBACK_HORIZONTAL_SCALE
          },
          Math.min(DAMAGE_KNOCKBACK_MAX_STRENGTH, impactSpeed / PHYSICS_TICKS_PER_SECOND)
        );
        this.#damageCooldownUntilTick.set(
          entity.id,
          currentTick + DAMAGE_RECHECK_INTERVAL_TICKS
        );
      } catch {
        // Invalid or invulnerable entities do not interrupt the tree lifecycle.
      }
    }
  }

  #tickLavaExposure(tree: ContraptionState, currentTick: number): LavaExposureResult {
    const ratio = normalizeLavaSubmersionRatio(tree.contraption.body.lavaSubmersionRatio);
    if (ratio > 0) {
      tree.lavaExposureTicks = Math.min(
        LAVA_DESTRUCTION_EXPOSURE_TICKS,
        tree.lavaExposureTicks + ratio
      );
    } else {
      tree.lavaExposureTicks = Math.max(
        0,
        tree.lavaExposureTicks - LAVA_EXPOSURE_COOLING_TICKS
      );
    }
    if (tree.lavaExposureTicks < LAVA_DESTRUCTION_EXPOSURE_TICKS) {
      return tree.lavaExposureTicks > 0 ? "heated" : "none";
    }
    return this.#beginLavaDestruction(tree, currentTick) ? "destroyed" : "pending";
  }

  #beginLavaDestruction(tree: ContraptionState, currentTick: number): boolean {
    if (tree.detachedAttachments.length > 0) return false;
    const previous = this.#savedContraptions.get(tree.id);
    const saved = this.#serializeTree(tree, currentTick);
    saved.pendingLavaDestruction = true;
    saved.lavaExposureTicks = LAVA_DESTRUCTION_EXPOSURE_TICKS;
    this.#savedContraptions.set(tree.id, saved);
    this.#persistenceSignatures.delete(tree.id);
    this.#dirtyContraptionStates.add(tree.id);
    if (!previous) this.#dirtyContraptionStructures.add(tree.id);
    this.#writeSave();
    if (
      !this.#persistedContraptionIds.has(tree.id)
      || this.#dirtyContraptionStates.has(tree.id)
      || this.#dirtyContraptionStructures.has(tree.id)
    ) return false;

    const dimension = tree.contraption.body.dimension.dimension;
    const anchors = selectLavaDestructionAnchors(tree, LAVA_DESTRUCTION_MAX_ANCHORS);
    const aabb = tree.contraption.body.getAabb();
    const smokeLocation = {
      x: (aabb.min.x + aabb.max.x) / 2,
      y: (aabb.min.y + aabb.max.y) / 2,
      z: (aabb.min.z + aabb.max.z) / 2
    };
    const smokeScale = {
      x: Math.min(16, Math.max(0.5, (aabb.max.x - aabb.min.x) * 0.45)),
      y: Math.min(16, Math.max(0.5, (aabb.max.y - aabb.min.y) * 0.45)),
      z: Math.min(16, Math.max(0.5, (aabb.max.z - aabb.min.z) * 0.45))
    };
    const soundLocation = { ...tree.contraption.body.location };
    const blockCount = tree.contraption.blocks.length;
    const foliageTint = tree.contraption.foliageTint;
    this.#settleChestStorages(
      tree.id,
      [...tree.chestStorages.values()],
      dimension,
      localLocation => tree.contraption.body.localPointToWorld(localLocation)
    );
    tree.chestStorages.clear();
    this.#untrackContraptionVisuals(tree.contraption);
    try {
      tree.contraption.remove();
    } catch {
      // The durable terminal marker prevents restoration if removal was interrupted.
      return false;
    }
    this.#clearPendingCollisionState(tree.contraption.id);
    this.#deleteTreeRecord(tree.id);
    this.#writeSave();

    for (const anchor of anchors) {
      spawnBlockParticle(
        dimension,
        anchor.location,
        anchor.snapshot,
        anchor.localLocation,
        foliageTint,
        { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
      );
    }
    const smokeMolang = new MolangVariableMap();
    smokeMolang.setFloat(
      "variable.smoke_count",
      Math.min(
        LAVA_DESTRUCTION_MAX_SMOKE,
        Math.max(6, Math.ceil(Math.sqrt(Math.max(1, blockCount)) * 2))
      )
    );
    smokeMolang.setFloat("variable.smoke_scale_x", smokeScale.x);
    smokeMolang.setFloat("variable.smoke_scale_y", smokeScale.y);
    smokeMolang.setFloat("variable.smoke_scale_z", smokeScale.z);
    try {
      dimension.spawnParticle(TREE_LAVA_SMOKE_PARTICLE_ID, smokeLocation, smokeMolang);
    } catch {
      // Lava visuals must not affect the terminal state.
    }
    try {
      dimension.playSound("random.fizz", soundLocation, {
        pitch: 1.8 + Math.random() * 0.6,
        volume: 0.5
      });
    } catch {
      // The sound is cosmetic and must not affect persistence cleanup.
    }
    return true;
  }

  #tickSettlement(tree: ContraptionState): boolean {
    if (tree.automaticLifecyclePaused) return false;
    if (!tree.contraption.body.isSleeping && !shouldCountTreeMotionTime()) return false;
    // A zero breakdown rate pauses timed settlement without disabling impact or lava breakage.
    if (getTreeBreakSpeedMultiplier() === 0) return false;
    tree.sleepTicks++;
    if (tree.sleepTicks < tree.sleepTimeoutTicks) return false;
    return this.#settleTree(tree);
  }

  #settleTree(tree: ContraptionState): boolean {
    const dimension = tree.contraption.body.dimension.dimension;
    this.#cancelDetachedAttachmentSettlement(tree.id);
    const previous = this.#savedContraptions.get(tree.id);
    const operations: PendingSettlementOperation[] = [];
    appendDetachedAttachmentOperations(
      operations,
      tree.detachedAttachments,
      tree.detachedAttachmentCursor
    );
    for (let index = 0; index < tree.contraption.blocks.length; index++) {
      const block = tree.contraption.blocks[index]!;
      const snapshot = tree.snapshots.get(locationKey(block.localLocation));
      if (!snapshot) continue;
      operations.push({
        key: String(index),
        location: tree.contraption.body.localPointToWorld(block.localLocation),
        localLocation: { ...block.localLocation },
        spawnParticle: true,
        snapshot
      });
    }
    const soundLocation = tree.contraption.body.location;
    const saved = this.#serializeTree(tree, system.currentTick);
    saved.pendingSettlement = true;
    this.#savedContraptions.set(tree.id, saved);
    this.#dirtyContraptionStates.add(tree.id);
    if (!previous) this.#dirtyContraptionStructures.add(tree.id);
    this.#persistenceSignatures.delete(tree.id);
    if (!this.#writeSave()) {
      throw new Error(`Could not persist pending settlement for contraption ${tree.id}.`);
    }
    this.#settleChestStorages(
      tree.id,
      [...tree.chestStorages.values()],
      dimension,
      localLocation => tree.contraption.body.localPointToWorld(localLocation)
    );
    if (tree.chestStorages.size > 0) {
      tree.chestStorages.clear();
      saved.chestStorages = [];
      this.#dirtyContraptionStructures.add(tree.id);
      if (!this.#writeSave()) {
        throw new Error(`Could not persist chest settlement for contraption ${tree.id}.`);
      }
    }
    this.#pendingSettlements.set(tree.id, {
      completed: false,
      deduplicate: previous?.pendingSettlement === true,
      dimension,
      dropAnchor: resolveFinalSettlementDropAnchor(operations, soundLocation),
      id: tree.id,
      lootTool: tree.lootTool,
      operations,
      foliageTint: tree.contraption.foliageTint,
      soundLocation: { ...soundLocation }
    });
    this.#untrackContraptionVisuals(tree.contraption);
    tree.contraption.remove();
    this.#clearPendingCollisionState(tree.contraption.id);
    return true;
  }

  #tickCrossDomain(
    tree: ContraptionState,
    players: readonly Player[],
    currentTick: number
  ): boolean {
    const body = tree.contraption.body;
    const dimension = body.dimension.dimension;
    const aabb = body.getAabb();
    const currentReadable = areBoundsChunksReadable(dimension, aabb, this.#chunkReadabilityCache);
    if (currentReadable) {
      tree.lastSafeBounds = cloneBounds(aabb);
      tree.lastSafePose = getBodyPose(tree.contraption);
    }

    const nearestPlayer = nearestPlayerTo(body.location, players);
    const nearestDistance = nearestPlayer
      ? vectorDistance(body.location, nearestPlayer.location)
      : undefined;
    const playerMovingAway = nearestDistance !== undefined
      && tree.lastNearestPlayerDistance !== undefined
      && nearestDistance > tree.lastNearestPlayerDistance + PLAYER_MOVING_AWAY_EPSILON;
    tree.lastNearestPlayerDistance = nearestDistance;

    const predicted = createPredictedBounds(aabb, body.velocity);
    const predictedReadable = areBoundsChunksReadable(
      dimension,
      predicted,
      this.#chunkReadabilityCache
    );
    const guardReadable = !playerMovingAway || !nearestPlayer || areBoundsChunksReadable(
      dimension,
      createOutwardGuardBounds(aabb, body.location, nearestPlayer.location),
      this.#chunkReadabilityCache
    );
    const threatened = players.length === 0
      || !currentReadable
      || !predictedReadable
      || !guardReadable;
    tree.boundaryThreatTicks = threatened ? tree.boundaryThreatTicks + 1 : 0;

    const confirmations = players.length === 0 ? 1 : CROSS_DOMAIN_CONFIRM_TICKS;
    if (tree.boundaryThreatTicks < confirmations) return false;
    if (!currentReadable) {
      if (!areBoundsChunksReadable(dimension, tree.lastSafeBounds, this.#chunkReadabilityCache)) {
        this.#deferSettlement(tree, currentTick);
        return true;
      }
      body.teleport(tree.lastSafePose.location, {
        angularVelocity: { x: 0, y: 0, z: 0 },
        rotation: tree.lastSafePose.rotation,
        velocity: { x: 0, y: 0, z: 0 }
      });
      tree.contraption.syncVisuals(true);
    }
    return this.#settleTree(tree);
  }

  #deferSettlement(tree: ContraptionState, currentTick: number): void {
    this.#cancelDetachedAttachmentSettlement(tree.id);
    const saved = this.#serializeTree(tree, currentTick);
    saved.pendingSettlement = true;
    saved.location = { ...tree.lastSafePose.location };
    saved.rotation = { ...tree.lastSafePose.rotation };
    saved.velocity = { x: 0, y: 0, z: 0 };
    saved.angularVelocity = { x: 0, y: 0, z: 0 };
    this.#untrackContraptionVisuals(tree.contraption);
    tree.contraption.remove();
    this.#clearPendingCollisionState(tree.contraption.id);
    this.#savedContraptions.set(tree.id, saved);
    this.#dirtyContraptionStates.add(tree.id);
    this.#persistenceSignatures.delete(tree.id);
  }

  #restoreAvailableTrees(players: readonly Player[], currentTick: number): void {
    if (!this.#configureDimension || this.#savedContraptions.size === 0) return;
    const activeIds = new Set([...this.#contraptions.values()].map(tree => tree.id));
    for (const saved of this.#savedContraptions.values()) {
      if (
        activeIds.has(saved.id)
        || this.#pendingSettlements.has(saved.id)
        || currentTick < (this.#restoreRetryAfterTick.get(saved.id) ?? 0)
        || !hasNearbyPlayer(saved, players)
      ) continue;
      let dimension: Dimension;
      try {
        dimension = world.getDimension(saved.dimensionId);
      } catch {
        continue;
      }
      if (!areBoundsChunksReadable(
        dimension,
        createSavedTreeBounds(saved),
        this.#chunkReadabilityCache
      )) continue;
      if (!this.#reconcileSavedVisuals(saved, dimension)) {
        this.#restoreRetryAfterTick.set(saved.id, currentTick + RESTORE_RETRY_TICKS);
        continue;
      }
      this.#restoreRetryAfterTick.delete(saved.id);
      const preparedResolution = this.#resolvePreparedSource(saved, dimension);
      if (preparedResolution === "wait") {
        this.#restoreRetryAfterTick.set(saved.id, currentTick + RESTORE_RETRY_TICKS);
        continue;
      }
      if (preparedResolution === "cancel") {
        this.#deleteTreeRecord(saved.id);
        continue;
      }
      const pendingLogBreakResolution = this.#finishSavedPendingLogBreak(saved, dimension);
      if (pendingLogBreakResolution === "retry") {
        this.#restoreRetryAfterTick.set(saved.id, currentTick + RESTORE_RETRY_TICKS);
        continue;
      }
      if (pendingLogBreakResolution === "deleted") continue;
      if (preparedResolution === "settle" || saved.pendingSettlement) {
        this.#queueSavedSettlement(saved, dimension);
        continue;
      }

      let contraption: PhysicsContraption | undefined;
      try {
        const physicsDimension = this.#configureDimension(dimension);
        const blocks = restoreSerializedContraptionBlocks(saved.blocks, saved.snapshots);
        const leafPhysicsPlan = restoreSavedLeafPhysicsPlan(saved);
        const logBreakagePlan = restoreSavedLogBreakagePlan(saved);
        const visualGeneration = normalizeVisualGeneration(saved.visualGeneration) + 1;
        const foliageTint = saved.foliageTint ?? captureTreeFoliageTint(
          dimension,
          saved.snapshots.map(entry => entry.snapshot),
          savedContraptionSourceOrigin(saved)
        );
        contraption = physicsDimension.createContraption({
          angularVelocity: saved.angularVelocity,
          blocks,
          foliageTint,
          location: saved.location,
          name: "Felled tree",
          rotation: saved.rotation,
          runtimeRepresentation: createTreeLeafPhysicsRuntimeRepresentation(leafPhysicsPlan),
          velocity: saved.velocity,
          visualEntityTags: [createContraptionVisualTag(saved.id, visualGeneration)]
        });
        const state = this.#restoreState(
          contraption,
          saved,
          currentTick,
          leafPhysicsPlan,
          logBreakagePlan
        );
        state.sourceCommitted = true;
        state.visualGeneration = visualGeneration;
        this.#contraptions.set(contraption.id, state);
        this.#trackContraptionVisuals(contraption);
        if (state.chestStorages.size > 0) {
          this.#requireChestStorageController([...state.chestStorages.values()]);
          this.#chestStorage!.bindContraption(
            state.id,
            contraption,
            [...state.chestStorages.values()]
          );
        }
        activeIds.add(saved.id);
        if (saved.sleeping && normalizeLavaExposureTicks(saved.lavaExposureTicks) <= 0) {
          contraption.body.sleep();
        }
        this.#refreshTreeSnapshot(state, currentTick, true);
        this.#reportedRestoreFailures.delete(saved.id);
      } catch (error) {
        if (contraption) {
          this.#chestStorage?.rollbackContraptionBinding(saved.id, contraption);
          this.#contraptions.delete(contraption.id);
          this.#untrackContraptionVisuals(contraption);
          contraption.remove();
        }
        this.#savedContraptions.set(saved.id, saved);
        this.#persistenceSignatures.delete(saved.id);
        this.#restoreRetryAfterTick.set(saved.id, currentTick + RESTORE_RETRY_TICKS);
        if (!this.#reportedRestoreFailures.has(saved.id)) {
          this.#reportedRestoreFailures.add(saved.id);
          // The globalThis cast keeps this call alive through esbuild's
          // drop:["console"]; the release verifier counts exactly the two
          // surviving call sites (restore + particle), so do not merge them.
          (globalThis as unknown as { console: { error(message: string): void } }).console.error(
            `[treephysics/restore] contraption=${saved.id} failed: ${describeError(error)}`
          );
        }
      }
    }
  }

  #finishSavedPendingLogBreak(
    saved: SerializedContraption,
    dimension: Dimension
  ): "complete" | "deleted" | "retry" {
    const pending = saved.pendingLogBreak;
    if (!pending) return "complete";
    const tagPrefix = `treephysics_log_break_${saved.id}_${pending.generation}`;
    const snapshots = new Map(saved.snapshots.map(entry => [
      locationKey(entry.localLocation),
      entry.snapshot
    ]));
    const operations: PendingSettlementOperation[] = [];
    for (let index = 0; index < pending.keys.length; index++) {
      const key = pending.keys[index]!;
      const snapshot = snapshots.get(key);
      if (!snapshot) continue;
      const localLocation = parseLocationKey(key);
      operations.push({
        key: String(index),
        localLocation,
        location: savedLocalPointToWorld(saved, localLocation),
        snapshot,
        spawnParticle: true
      });
    }
    const existingTags = operations.length > 0
      ? getSettlementTagsForOperations(dimension, operations, tagPrefix)
      : new Set<string>();
    const lootTool = deserializeTool(saved.lootTool);
    const drops: PendingItemDrop[] = [];
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      for (const item of generatePermutationDrops(operation.snapshot, lootTool)) {
        drops.push({ item, location: operation.location });
      }
      if (
        existingTags.size === 0
        && isDeterministicParticleSample(index, operations.length, TREE_LOG_BREAK_MAX_PARTICLES)
      ) {
        spawnBlockParticle(
          dimension,
          operation.location,
          operation.snapshot,
          operation.localLocation,
          saved.foliageTint,
          { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
        );
      }
      spawnBeeNestBees(
        dimension,
        operation.snapshot,
        operation.location,
        `${tagPrefix}_operation_${operation.key}`,
        existingTags
      );
    }
    spawnItemDropBatch(dimension, drops, true, tagPrefix, existingTags);
    if (existingTags.size === 0 && operations.length > 0) {
      try {
        const sound = selectDominantVanillaBlockBreakSound(
          operations.map(operation => operation.snapshot.typeId)
        );
        dimension.playSound(sound.sound, operations[0]!.location, {
          pitch: sound.pitch,
          volume: sound.volume
        });
      } catch {
        // Recovery correctness does not depend on client sound availability.
      }
    }

    const previousBlocks = saved.blocks;
    const previousSnapshots = saved.snapshots;
    const previousLeaves = saved.leaves;
    const previousLeafBreakGroups = saved.leafPhysics.breakGroups;
    const previousLogBreakGroups = saved.logBreakage.breakGroups;
    const previousSleepTimeoutTicks = saved.sleepTimeoutTicks;
    const removedKeys = new Set(pending.keys);
    const remainingKeys = new Set(
      saved.blocks
        .map(block => locationKey(block.localLocation))
        .filter(key => !removedKeys.has(key))
    );
    saved.blocks = saved.blocks.filter(block => remainingKeys.has(locationKey(block.localLocation)));
    saved.snapshots = saved.snapshots.filter(entry =>
      remainingKeys.has(locationKey(entry.localLocation))
    );
    saved.leaves = saved.leaves.filter(entry =>
      remainingKeys.has(locationKey(entry.localLocation))
    );
    saved.leafPhysics.breakGroups = saved.leafPhysics.breakGroups
      ?.map(group => group.filter(location => remainingKeys.has(locationKey(location))))
      .filter(group => group.length > 0);
    saved.logBreakage.breakGroups = saved.logBreakage.breakGroups
      ?.map(group => ({
        ...group,
        keys: group.keys.filter(location => remainingKeys.has(locationKey(location)))
      }))
      .filter(group => group.keys.length > 0);
    saved.sleepTimeoutTicks = pending.sleepTimeoutTicks;
    saved.pendingLogBreak = undefined;

    const hasRemainingLogs = saved.snapshots.some(entry => entry.snapshot.kind === "log");
    if (saved.blocks.length === 0 || !hasRemainingLogs) {
      this.#deleteTreeRecord(saved.id);
      this.#writeSave();
      return "deleted";
    }

    this.#dirtyContraptionStructures.add(saved.id);
    this.#dirtyContraptionStates.add(saved.id);
    this.#persistenceSignatures.delete(saved.id);
    this.#writeSave();
    if (!this.#dirtyContraptionStructures.has(saved.id) && !this.#dirtyContraptionStates.has(saved.id)) {
      return "complete";
    }

    saved.blocks = previousBlocks;
    saved.snapshots = previousSnapshots;
    saved.leaves = previousLeaves;
    saved.leafPhysics.breakGroups = previousLeafBreakGroups;
    saved.logBreakage.breakGroups = previousLogBreakGroups;
    saved.sleepTimeoutTicks = previousSleepTimeoutTicks;
    saved.pendingLogBreak = pending;
    return "retry";
  }

  #resolvePreparedSource(
    saved: SerializedContraption,
    dimension: Dimension
  ): "cancel" | "restore" | "settle" | "wait" {
    if (saved.sourceCommitted) return "restore";
    const sourceEntries = [...saved.snapshots, ...saved.detachedAttachments];
    if (sourceEntries.length === 0) return "settle";
    const matchingKeys = new Set<string>();
    const airKeys = new Set<string>();
    const conflictingKeys = new Set<string>();
    try {
      for (const entry of sourceEntries) {
        const block = dimension.getBlock(entry.snapshot.location);
        if (!block) return "wait";
        const key = locationKey(entry.localLocation);
        if (block.typeId === entry.snapshot.typeId) matchingKeys.add(key);
        else if (block.isAir) airKeys.add(key);
        else conflictingKeys.add(key);
      }
    } catch {
      return "wait";
    }

    // No air means the world removal transaction did not make progress. Keeping
    // the source world is safer than settling a record over blocks that may have
    // changed independently while the game was offline.
    if (airKeys.size === 0) return "cancel";

    const recoverableKeys = new Set<string>();
    const changedLocations: Vector3[] = [];
    try {
      for (const entry of sourceEntries) {
        const block = dimension.getBlock(entry.snapshot.location);
        if (!block) {
          this.#notifyWorldBlocksChanged(dimension, changedLocations);
          return "wait";
        }
        const key = locationKey(entry.localLocation);
        if (matchingKeys.has(key)) {
          block.setType("minecraft:air");
          recoverableKeys.add(key);
          changedLocations.push({ ...entry.snapshot.location });
        } else if (airKeys.has(key)) recoverableKeys.add(key);
      }
    } catch {
      this.#notifyWorldBlocksChanged(dimension, changedLocations);
      return "wait";
    }
    this.#notifyWorldBlocksChanged(dimension, changedLocations);
    saved.sourceCommitted = true;
    this.#dirtyContraptionStates.add(saved.id);
    if (conflictingKeys.size === 0) return "restore";

    saved.blocks = saved.blocks.filter(block => recoverableKeys.has(locationKey(block.localLocation)));
    saved.snapshots = saved.snapshots.filter(entry =>
      recoverableKeys.has(locationKey(entry.localLocation))
    );
    saved.detachedAttachments = saved.detachedAttachments.filter(entry =>
      recoverableKeys.has(locationKey(entry.localLocation))
    );
    saved.detachedAttachmentCursor = 0;
    saved.leaves = saved.leaves.filter(entry => recoverableKeys.has(locationKey(entry.localLocation)));
    saved.pendingSettlement = true;
    this.#dirtyContraptionStructures.add(saved.id);
    return "settle";
  }

  #queueSavedSettlement(
    saved: SerializedContraption,
    dimension: Dimension
  ): void {
    if (this.#pendingSettlements.has(saved.id)) return;
    const wasPending = saved.pendingSettlement === true;
    if (saved.chestStorages.length > 0) {
      this.#settleChestStorages(
        saved.id,
        saved.chestStorages,
        dimension,
        localLocation => savedLocalPointToWorld(saved, localLocation)
      );
      saved.chestStorages = [];
      this.#dirtyContraptionStructures.add(saved.id);
      if (!this.#writeSave()) {
        throw new Error(`Could not persist restored chest settlement for ${saved.id}.`);
      }
    }
    const snapshots = new Map(saved.snapshots.map(entry => [
      locationKey(entry.localLocation),
      entry.snapshot
    ]));
    const operations: PendingSettlementOperation[] = [];
    appendDetachedAttachmentOperations(
      operations,
      saved.detachedAttachments,
      normalizeDetachedAttachmentCursor(saved)
    );
    for (let index = 0; index < saved.blocks.length; index++) {
      const block = saved.blocks[index]!;
      const snapshot = snapshots.get(locationKey(block.localLocation));
      if (!snapshot) continue;
      operations.push({
        key: String(index),
        location: savedLocalPointToWorld(saved, block.localLocation),
        localLocation: { ...block.localLocation },
        spawnParticle: true,
        snapshot
      });
    }
    saved.pendingSettlement = true;
    this.#pendingSettlements.set(saved.id, {
      completed: false,
      deduplicate: wasPending,
      dimension,
      dropAnchor: resolveFinalSettlementDropAnchor(operations, saved.location),
      id: saved.id,
      lootTool: deserializeTool(saved.lootTool),
      operations,
      foliageTint: saved.foliageTint,
      soundLocation: { ...saved.location }
    });
    if (!wasPending) this.#dirtyContraptionStates.add(saved.id);
  }

  #restoreState(
    contraption: PhysicsContraption,
    saved: SerializedContraption,
    currentTick: number,
    leafPhysicsPlan: TreeLeafPhysicsPlan,
    logBreakagePlan: TreeLogBreakagePlan
  ): ContraptionState {
    const snapshots = new Map<string, CapturedTreeBlock>();
    for (const entry of saved.snapshots) {
      snapshots.set(locationKey(entry.localLocation), cloneSnapshot(entry.snapshot));
    }
    const leaves = new Map<string, FallenLeaf>();
    for (const entry of saved.leaves) {
      const key = locationKey(entry.localLocation);
      const snapshot = snapshots.get(key);
      if (!snapshot) continue;
      leaves.set(key, {
        distance: entry.distance,
        fragileImpactSpeed: 0,
        localLocation: { ...entry.localLocation },
        snapshot
      });
    }
    const logs = new Map<string, Vector3>();
    for (const [key, snapshot] of snapshots) {
      if (snapshot.kind === "log") logs.set(key, parseLocationKey(key));
    }
    const fragileAttachments = new Map<string, FallenFragileBlock>();
    for (const [key, snapshot] of snapshots) {
      const impactSpeed = getContraptionFragileImpactSpeed(snapshot);
      if (impactSpeed === undefined || snapshot.kind === "leaf") continue;
      fragileAttachments.set(key, {
        fragileImpactSpeed: impactSpeed,
        localLocation: parseLocationKey(key),
        snapshot
      });
    }
    return {
      contraption,
      automaticLifecyclePaused: saved.automaticLifecyclePaused,
      attachmentProbeCursor: Math.max(0, Math.floor(saved.attachmentProbeCursor)),
      attachmentProbeKeys: [...fragileAttachments.keys()],
      boundaryThreatTicks: saved.boundaryThreatTicks,
      chestStorages: createChestStorageMap(saved.chestStorages),
      damagePose: getBodyPose(contraption),
      decayProgress: saved.decayProgress,
      detachedAttachmentCursor: normalizeDetachedAttachmentCursor(saved),
      detachedAttachments: saved.detachedAttachments.map(entry => ({
        localLocation: { ...entry.localLocation },
        snapshot: cloneSnapshot(entry.snapshot)
      })),
      editJournalSequence: saved.editJournalSequence,
      fragileAttachments,
      fragileProbeCursor: Math.max(0, Math.floor(saved.fragileProbeCursor)),
      id: saved.id,
      lastSafeBounds: contraption.body.getAabb(),
      lastSafePose: clonePose(saved.lastSafePose),
      leaves,
      leavesByDistance: createLeafDistanceBuckets(leaves),
      leafPhysicsPlan,
      leafProbeKeys: [...leaves.keys()],
      lavaExposureTicks: normalizeLavaExposureTicks(saved.lavaExposureTicks),
      logBreakagePlan,
      logBreakDamage: normalizeLogBreakDamage(saved.logBreakDamage),
      logBreakGeneration: saved.logBreakGeneration,
      logs,
      lootTool: deserializeTool(saved.lootTool),
      nextDecayTick: currentTick + Math.max(0, saved.nextDecayDelayTicks),
      pendingLogBreak: saved.pendingLogBreak,
      playerEditRevision: saved.playerEditRevision,
      leafProbeCursor: saved.probeCursor,
      sleepTicks: Math.max(0, Math.floor(saved.sleepTicks)),
      sleepTicksPerLog: normalizeSleepTicksPerLog(
        saved.sleepTicksPerLog,
        saved.sleepTimeoutTicks,
        logs.size
      ),
      sleepTimeoutTicks: normalizeSleepTimeout(saved.sleepTimeoutTicks),
      sourceCommitted: saved.sourceCommitted,
      snapshots,
      topologyIndex: undefined,
      worldLeafProbeCursor: Math.max(0, Math.floor(saved.worldLeafProbeCursor)),
      worldNonLeafProbeKeys: [...logs.keys(), ...fragileAttachments.keys()],
      visualGeneration: normalizeVisualGeneration(saved.visualGeneration)
    };
  }

  #serializeTree(tree: ContraptionState, currentTick: number): SerializedContraption {
    const body = tree.contraption.body;
    const remainingKeys = new Set(tree.contraption.blocks.map(block => locationKey(block.localLocation)));
    return {
      automaticLifecyclePaused: tree.automaticLifecyclePaused,
      attachmentProbeCursor: tree.attachmentProbeCursor,
      angularVelocity: { ...body.angularVelocity },
      blocks: tree.contraption.blocks.map(block => cloneContraptionBlock(block)),
      boundaryThreatTicks: tree.boundaryThreatTicks,
      chestStorages: [...tree.chestStorages.values()].map(cloneChestStorageBinding),
      decayProgress: tree.decayProgress,
      detachedAttachmentCursor: Math.min(
        tree.detachedAttachments.length,
        Math.max(0, Math.floor(tree.detachedAttachmentCursor))
      ),
      detachedAttachments: tree.detachedAttachments.map(entry => ({
        localLocation: { ...entry.localLocation },
        snapshot: cloneSnapshot(entry.snapshot)
      })),
      editJournalSequence: tree.editJournalSequence,
      fragileProbeCursor: tree.fragileProbeCursor,
      foliageTint: tree.contraption.foliageTint
        ? { ...tree.contraption.foliageTint }
        : undefined,
      dimensionId: body.dimension.id,
      id: tree.id,
      lastSafePose: clonePose(tree.lastSafePose),
      leafPhysics: serializeLeafPhysics(tree, remainingKeys),
      leaves: [...tree.leaves.values()].map(leaf => ({
        distance: leaf.distance,
        localLocation: { ...leaf.localLocation }
      })),
      lavaExposureTicks: tree.lavaExposureTicks,
      logBreakage: serializeLogBreakage(tree, remainingKeys),
      logBreakDamage: tree.logBreakDamage,
      logBreakGeneration: tree.logBreakGeneration,
      lootTool: serializeTool(tree.lootTool),
      location: { ...body.location },
      nextDecayDelayTicks: Math.max(0, tree.nextDecayTick - currentTick),
      pendingLavaDestruction: undefined,
      pendingLogBreak: tree.pendingLogBreak,
      playerEditRevision: tree.playerEditRevision,
      probeCursor: tree.leafProbeCursor,
      rotation: body.getRotation(),
      sleepTicks: tree.sleepTicks,
      sleepTicksPerLog: tree.sleepTicksPerLog,
      sleeping: body.isSleeping,
      sleepTimeoutTicks: tree.sleepTimeoutTicks,
      sourceCommitted: tree.sourceCommitted,
      snapshots: [...tree.snapshots.entries()]
        .filter(([key]) => remainingKeys.has(key))
        .map(([key, snapshot]) => ({
          localLocation: parseLocationKey(key),
          snapshot: cloneSnapshot(snapshot)
        })),
      velocity: { ...body.velocity },
      visualEntityIds: [...tree.contraption.visualEntityIds],
      visualGeneration: tree.visualGeneration,
      worldLeafProbeCursor: tree.worldLeafProbeCursor
    };
  }

  #refreshPersistenceSlice(currentTick: number): void {
    for (const tree of this.#contraptions.values()) {
      if (
        !tree.contraption.isValid
        || tree.lavaExposureTicks >= LAVA_DESTRUCTION_EXPOSURE_TICKS
        || (tree.contraption.id + currentTick) % PERSISTENCE_INTERVAL_TICKS !== 0
      ) continue;
      const compactJournal = this.#editJournals.has(tree.id);
      this.#refreshTreeSnapshot(tree, currentTick, compactJournal, compactJournal);
    }
  }

  #appendTreeEditJournal(
    tree: ContraptionState,
    edit: {
      readonly additions?: readonly SerializedContraptionEditJournalAddition[];
      readonly clearPendingLogBreak?: boolean;
      readonly detachedAttachments?: readonly SerializedSnapshotEntry[];
      readonly removedKeys?: readonly string[];
      readonly sleepTimeoutTicks: number;
      readonly state: SerializedContraptionState;
    }
  ): void {
    const saved = this.#savedContraptions.get(tree.id);
    if (!saved) throw new Error(`Fallen tree ${tree.id} has no journal base record.`);
    const previous = this.#editJournals.get(tree.id);
    const previousSequence = previous?.entries[previous.entries.length - 1]?.sequence;
    if (previousSequence !== undefined && previousSequence !== tree.editJournalSequence) {
      throw new Error(`Fallen tree ${tree.id} edit journal sequence diverged from runtime state.`);
    }
    const sequence = tree.editJournalSequence + 1;
    const entry: SerializedContraptionEditJournalEntry = {
      additions: (edit.additions ?? []).map(addition => ({
        block: cloneContraptionBlock(addition.block),
        chestStorage: addition.chestStorage
          ? cloneChestStorageBinding(addition.chestStorage)
          : undefined,
        snapshot: cloneSnapshot(addition.snapshot)
      })),
      clearPendingLogBreak: edit.clearPendingLogBreak === true,
      detachedAttachments: edit.detachedAttachments?.map(entry => ({
        localLocation: { ...entry.localLocation },
        snapshot: cloneSnapshot(entry.snapshot)
      })),
      removedKeys: [...(edit.removedKeys ?? [])],
      sequence,
      sleepTimeoutTicks: edit.sleepTimeoutTicks,
      state: { ...edit.state, editJournalSequence: sequence }
    };
    const journal: SerializedContraptionEditJournal = {
      entries: [...(previous?.entries ?? []), entry],
      id: tree.id
    };
    const result = this.#getTreeStores(tree.id).journal.saveWithResult(journal);
    if (result === "failed") {
      throw new Error(`Could not persist edit journal for contraption ${tree.id}.`);
    }
    this.#editJournals.set(tree.id, journal);
    // Keep the saved record as the journal base. The full live structure is
    // materialized once during the next scheduled compaction, instead of on
    // every edit entry.
    tree.editJournalSequence = sequence;
    this.#persistenceSignatures.delete(tree.id);
  }

  #refreshTreeSnapshot(
    tree: ContraptionState,
    currentTick: number,
    force = false,
    structureChanged = false
  ): void {
    if (this.#editJournals.has(tree.id)) structureChanged = true;
    const signature = createTreePersistenceSignature(tree, currentTick);
    if (!force && this.#persistenceSignatures.get(tree.id) === signature) return;
    const existing = this.#savedContraptions.get(tree.id);
    const saved = !existing || structureChanged
      ? this.#serializeTree(tree, currentTick)
      : updateSerializedContraptionState(existing, tree, currentTick);
    this.#savedContraptions.set(tree.id, saved);
    this.#persistenceSignatures.set(tree.id, signature);
    this.#dirtyContraptionStates.add(tree.id);
    if (!existing || structureChanged) this.#dirtyContraptionStructures.add(tree.id);
  }

  #materializeJournaledTree(tree: ContraptionState): SerializedContraption | undefined {
    const saved = this.#savedContraptions.get(tree.id);
    if (
      !saved
      || !this.#editJournals.has(tree.id)
      || saved.editJournalSequence >= tree.editJournalSequence
      || !tree.contraption.isValid
    ) return saved;
    const materialized = this.#serializeTree(tree, system.currentTick);
    this.#savedContraptions.set(tree.id, materialized);
    this.#persistenceSignatures.delete(tree.id);
    return materialized;
  }

  #writeSave(requiredNewIds?: ReadonlySet<string>): boolean {
    // A journaled state revision cannot overtake its base structure. Any caller
    // that needs a state write also compacts the materialized structure first.
    for (const id of this.#dirtyContraptionStates) {
      if (this.#editJournals.has(id)) this.#dirtyContraptionStructures.add(id);
    }
    if (
      this.#dirtyContraptionStates.size === 0
      && this.#dirtyContraptionStructures.size === 0
      && this.#deletedContraptionIds.size === 0
    ) return true;
    // Journal appends keep the persisted base untouched. If a later operation
    // actually requests a save, materialize the live tree once before the
    // structure write so compaction cannot publish that stale base.
    for (const id of this.#dirtyContraptionStructures) {
      if (!this.#editJournals.has(id)) continue;
      const tree = [...this.#contraptions.values()].find(candidate => candidate.id === id);
      if (tree) this.#materializeJournaledTree(tree);
    }
    const dirtyIds = new Set([...this.#dirtyContraptionStructures, ...this.#dirtyContraptionStates]);
    const durableIds = new Set<string>();
    for (const id of dirtyIds) {
      const saved = this.#savedContraptions.get(id);
      if (!saved) continue;
      const stores = this.#getTreeStores(id);
      const records = splitSerializedContraption(saved);
      const structureResult = this.#dirtyContraptionStructures.has(id)
        ? stores.structure.saveWithResult(records.structure)
        : "unchanged";
      const stateResult = this.#dirtyContraptionStates.has(id) && structureResult !== "failed"
        ? stores.state.saveWithResult(records.state)
        : this.#dirtyContraptionStates.has(id) ? "failed" : "unchanged";
      if (structureResult !== "failed" && stateResult !== "failed") {
        durableIds.add(id);
        if (this.#dirtyContraptionStructures.has(id) && this.#editJournals.has(id)) {
          if (stores.journal.clear()) this.#editJournals.delete(id);
        }
      }
    }

    // The manifest is the transaction commit point. A structural replacement
    // cannot publish only a subset of its required child records.
    if (
      requiredNewIds
      && [...requiredNewIds].some(id => !durableIds.has(id) && !this.#persistedContraptionIds.has(id))
    ) return false;

    const nextPersistedIds = new Set(this.#persistedContraptionIds);
    for (const id of durableIds) nextPersistedIds.add(id);
    for (const id of this.#deletedContraptionIds) nextPersistedIds.delete(id);
    const manifestChanged = !setsEqual(nextPersistedIds, this.#persistedContraptionIds);
    if (manifestChanged) {
      const result = this.#manifestStore.saveWithResult<ContraptionManifest>({
        contraptionIds: [...nextPersistedIds].sort()
      });
      if (result === "failed") {
        for (const id of durableIds) {
          if (this.#persistedContraptionIds.has(id)) this.#clearTreeDirtyState(id);
        }
        return false;
      }
      this.#persistedContraptionIds.clear();
      for (const id of nextPersistedIds) this.#persistedContraptionIds.add(id);
    }
    for (const id of durableIds) this.#clearTreeDirtyState(id);
    for (const id of [...this.#deletedContraptionIds]) {
      if (this.#persistedContraptionIds.has(id)) continue;
      const stores = this.#getTreeStores(id);
      stores.state.clear();
      stores.structure.clear();
      stores.journal.clear();
      this.#contraptionStores.delete(id);
      this.#editJournals.delete(id);
      this.#deletedContraptionIds.delete(id);
    }
    return !requiredNewIds || [...requiredNewIds].every(id => this.#persistedContraptionIds.has(id));
  }

  #clearTreeDirtyState(id: string): void {
    this.#dirtyContraptionStates.delete(id);
    this.#dirtyContraptionStructures.delete(id);
  }

  #deleteTreeRecord(id: string): void {
    this.#cancelDetachedAttachmentSettlement(id);
    this.#savedContraptions.delete(id);
    this.#reportedRestoreFailures.delete(id);
    this.#restoreRetryAfterTick.delete(id);
    this.#persistenceSignatures.delete(id);
    this.#clearTreeDirtyState(id);
    this.#deletedContraptionIds.add(id);
  }

  #restoreTreeRecordAfterFailedEdit(
    id: string,
    saved: SerializedContraption,
    signature: string | undefined,
    stateDirty: boolean,
    structureDirty: boolean
  ): void {
    this.#deletedContraptionIds.delete(id);
    this.#savedContraptions.set(id, saved);
    if (signature === undefined) this.#persistenceSignatures.delete(id);
    else this.#persistenceSignatures.set(id, signature);
    if (stateDirty) this.#dirtyContraptionStates.add(id);
    else this.#dirtyContraptionStates.delete(id);
    if (structureDirty) this.#dirtyContraptionStructures.add(id);
    else this.#dirtyContraptionStructures.delete(id);
  }

  #discardUncommittedTree(tree: ContraptionState): void {
    if (this.#persistedContraptionIds.has(tree.id)) {
      throw new Error(`Cannot discard committed edited-tree child ${tree.id}.`);
    }
    this.#clearPendingCollisionState(tree.contraption.id);
    this.#contraptions.delete(tree.contraption.id);
    this.#untrackContraptionVisuals(tree.contraption);
    if (tree.contraption.isValid) tree.contraption.remove();
    this.#savedContraptions.delete(tree.id);
    this.#editJournals.delete(tree.id);
    this.#persistenceSignatures.delete(tree.id);
    this.#dirtyContraptionStates.delete(tree.id);
    this.#dirtyContraptionStructures.delete(tree.id);
    this.#deletedContraptionIds.delete(tree.id);
    const stores = this.#contraptionStores.get(tree.id);
    if (stores) {
      stores.state.clear();
      stores.structure.clear();
      stores.journal.clear();
      this.#contraptionStores.delete(tree.id);
    }
  }

  #startReadyDetachedAttachmentJobs(currentTick: number): void {
    for (const tree of this.#contraptions.values()) {
      if (!tree.sourceCommitted || tree.detachedAttachments.length === 0) continue;
      let pending = this.#pendingDetachedAttachments.get(tree.id);
      if (!pending) {
        const operations: PendingSettlementOperation[] = [];
        appendDetachedAttachmentOperations(operations, tree.detachedAttachments, 0);
        pending = {
          cursor: Math.min(tree.detachedAttachmentCursor, operations.length),
          deadlineTick: currentTick + SETTLEMENT_MAX_TICKS,
          deduplicate: true,
          dimension: tree.contraption.body.dimension.dimension,
          foliageTint: tree.contraption.foliageTint,
          id: tree.id,
          lootTool: tree.lootTool,
          mergeDrops: true,
          operations,
          soundLocation: { ...tree.contraption.body.location },
          started: false,
          tree
        };
        this.#pendingDetachedAttachments.set(tree.id, pending);
      }
      if (
        pending.started
        || this.#dirtyContraptionStates.has(tree.id)
        || this.#dirtyContraptionStructures.has(tree.id)
        || !this.#persistedContraptionIds.has(tree.id)
      ) continue;
      if (pending.cursor >= pending.operations.length) {
        this.#finishDetachedAttachmentSettlement(pending);
        continue;
      }
      pending.started = true;
      try {
        system.runJob(this.#runDetachedAttachmentJob(pending));
      } catch {
        this.#runDetachedAttachmentSynchronously(pending);
      }
    }
  }

  *#runDetachedAttachmentJob(
    pending: PendingDetachedAttachmentRuntime
  ): Generator<void, void, void> {
    let lastWorkTick = -1;
    while (pending.cursor < pending.operations.length) {
      if (this.#pendingDetachedAttachments.get(pending.id) !== pending) return;
      const currentTick = system.currentTick;
      if (currentTick === lastWorkTick) {
        yield;
        continue;
      }
      lastWorkTick = currentTick;
      const remainingTicks = Math.max(1, pending.deadlineTick - currentTick + 1);
      const batchSize = Math.max(
        1,
        Math.ceil((pending.operations.length - pending.cursor) / remainingTicks)
      );
      const end = Math.min(pending.operations.length, pending.cursor + batchSize);
      while (pending.cursor < end) {
        const groupEnd = Math.min(
          pending.operations.length,
          pending.cursor + SETTLEMENT_OPERATION_GROUP_SIZE
        );
        spawnSettlementOperations(
          pending,
          pending.operations.slice(pending.cursor, groupEnd)
        );
        pending.cursor = groupEnd;
      }
      this.#persistDetachedAttachmentCursor(pending);
      if (
        pending.cursor < pending.operations.length
        || this.#dirtyContraptionStates.has(pending.id)
      ) yield;
    }
    if (this.#pendingDetachedAttachments.get(pending.id) !== pending) return;
    if (this.#dirtyContraptionStates.has(pending.id)) {
      this.#writeSave();
      if (this.#dirtyContraptionStates.has(pending.id)) {
        pending.started = false;
        return;
      }
    }
    this.#finishDetachedAttachmentSettlement(pending);
  }

  #runDetachedAttachmentSynchronously(pending: PendingDetachedAttachmentRuntime): void {
    while (pending.cursor < pending.operations.length) {
      const groupEnd = Math.min(
        pending.operations.length,
        pending.cursor + SETTLEMENT_OPERATION_GROUP_SIZE
      );
      spawnSettlementOperations(
        pending,
        pending.operations.slice(pending.cursor, groupEnd)
      );
      pending.cursor = groupEnd;
    }
    this.#persistDetachedAttachmentCursor(pending);
    if (this.#dirtyContraptionStates.has(pending.id)) {
      pending.started = false;
      return;
    }
    this.#finishDetachedAttachmentSettlement(pending);
  }

  #persistDetachedAttachmentCursor(pending: PendingDetachedAttachmentRuntime): void {
    pending.tree.detachedAttachmentCursor = pending.cursor;
    const saved = this.#materializeJournaledTree(pending.tree);
    if (!saved) return;
    saved.detachedAttachmentCursor = pending.cursor;
    this.#dirtyContraptionStates.add(pending.id);
    this.#writeSave();
  }

  #finishDetachedAttachmentSettlement(pending: PendingDetachedAttachmentRuntime): void {
    if (
      this.#dirtyContraptionStates.has(pending.id)
      || this.#dirtyContraptionStructures.has(pending.id)
    ) {
      pending.started = false;
      return;
    }
    const saved = this.#materializeJournaledTree(pending.tree);
    if (!saved) {
      this.#pendingDetachedAttachments.delete(pending.id);
      return;
    }
    if (pending.tree.detachedAttachments.length > 0 || saved.detachedAttachments.length > 0) {
      saved.detachedAttachments = [];
      this.#dirtyContraptionStructures.add(pending.id);
      this.#persistenceSignatures.delete(pending.id);
      this.#writeSave();
      if (this.#dirtyContraptionStructures.has(pending.id)) {
        pending.started = false;
        return;
      }
      pending.tree.detachedAttachments = [];
    }
    pending.tree.detachedAttachmentCursor = 0;
    this.#pendingDetachedAttachments.delete(pending.id);
  }

  #cancelDetachedAttachmentSettlement(id: string): void {
    this.#pendingDetachedAttachments.delete(id);
  }

  #startReadySettlementJobs(): void {
    for (const pending of this.#pendingSettlements.values()) {
      if (
        this.#dirtyContraptionStates.has(pending.id)
        || this.#dirtyContraptionStructures.has(pending.id)
        || !this.#persistedContraptionIds.has(pending.id)
      ) continue;
      if (!pending.completed) {
        spawnFinalSettlementBatch(pending);
        pending.completed = true;
      }
      this.#finishPendingSettlement(pending);
    }
  }

  #finishPendingSettlement(pending: PendingSettlementRuntime): void {
    this.#deleteTreeRecord(pending.id);
    this.#writeSave();
    if (this.#persistedContraptionIds.has(pending.id)) return;
    this.#pendingSettlements.delete(pending.id);
    try {
      pending.dimension.playSound("random.pop", pending.soundLocation, {
        pitch: 0.6 + Math.random() * 1.6,
        volume: 0.25
      });
    } catch {
      // Completed drops do not depend on client sound availability.
    }
  }

  #trackContraptionVisuals(contraption: PhysicsContraption): void {
    const ids = new Set(contraption.visualEntityIds);
    this.#managedVisualEntityIdsByContraption.set(contraption.id, ids);
    for (const id of ids) this.#managedVisualEntityIds.add(id);
  }

  #refreshContraptionVisualTracking(contraption: PhysicsContraption): void {
    const previous = this.#managedVisualEntityIdsByContraption.get(contraption.id) ?? new Set<string>();
    const current = new Set(contraption.visualEntityIds);
    for (const id of previous) {
      if (!current.has(id)) this.#managedVisualEntityIds.delete(id);
    }
    for (const id of current) this.#managedVisualEntityIds.add(id);
    this.#managedVisualEntityIdsByContraption.set(contraption.id, current);
  }

  #untrackContraptionVisuals(contraption: PhysicsContraption): void {
    const ids = this.#managedVisualEntityIdsByContraption.get(contraption.id)
      ?? new Set(contraption.visualEntityIds);
    this.#managedVisualEntityIdsByContraption.delete(contraption.id);
    for (const id of ids) this.#managedVisualEntityIds.delete(id);
  }

  #reconcileLoadedVisuals(players: readonly Player[], currentTick: number): void {
    if (players.length === 0) return;
    for (const player of players) {
      const dimensionId = player.dimension.id;
      if (
        this.#loadedVisualReconciledDimensions.has(dimensionId)
        || currentTick < (this.#loadedVisualReconcileRetryTick.get(dimensionId) ?? 0)
      ) continue;
      try {
        for (const query of [
          { families: ["treephysics_visual"] },
          { type: "treephysics:block" }
        ]) {
          for (const entity of player.dimension.getEntities(query)) {
            if (
              !isContraptionVisualEntity(entity)
              || this.#managedVisualEntityIds.has(entity.id)
            ) continue;
            if (entity.isValid) entity.remove();
          }
        }
        this.#loadedVisualReconciledDimensions.add(dimensionId);
        this.#loadedVisualReconcileRetryTick.delete(dimensionId);
      } catch {
        this.#loadedVisualReconcileRetryTick.set(
          dimensionId,
          currentTick + RESTORE_RETRY_TICKS
        );
      }
    }
  }

  #reconcileSavedVisuals(saved: SerializedContraption, dimension: Dimension): boolean {
    try {
      for (const entityId of saved.visualEntityIds) {
        try {
          const entity = world.getEntity(entityId);
          if (entity?.isValid && !this.#managedVisualEntityIds.has(entity.id)) entity.remove();
        } catch {
          // The bounded family scan below is the authoritative cleanup barrier.
        }
      }
      const bounds = createSavedTreeBounds(saved);
      const center = {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2
      };
      const radius = Math.max(
        bounds.max.x - center.x,
        bounds.max.y - center.y,
        bounds.max.z - center.z
      ) + 2;
      for (const query of [
        {
          families: ["treephysics_visual"],
          location: center,
          maxDistance: radius
        },
        {
          type: "treephysics:block",
          location: center,
          maxDistance: radius
        }
      ]) {
        for (const entity of dimension.getEntities(query)) {
          if (
            !isContraptionVisualEntity(entity)
            || this.#managedVisualEntityIds.has(entity.id)
          ) continue;
          if (entity.isValid) entity.remove();
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  #createContraptionId(): string {
    let id: string;
    do {
      id = `${Date.now().toString(36)}_${system.currentTick.toString(36)}_${(this.#nextContraptionId++).toString(36)}`;
    } while (this.#savedContraptions.has(id));
    return id;
  }

  #getActiveLeafPhysicsBudget(): TreeLeafPhysicsActiveBudget {
    const budget: TreeLeafPhysicsActiveBudget = {
      buoyancyPointCount: 0,
      contactProbeCount: 0,
      leafCount: 0
    };
    for (const tree of this.#contraptions.values()) {
      budget.buoyancyPointCount += tree.leafPhysicsPlan.allocatedBuoyancyPointCount;
      budget.contactProbeCount += tree.leafPhysicsPlan.allocatedContactProbeCount;
      budget.leafCount += tree.leaves.size;
    }
    return budget;
  }

  #pruneDamageState(currentTick: number): void {
    for (const [entityId, untilTick] of this.#damageCooldownUntilTick) {
      if (untilTick <= currentTick) this.#damageCooldownUntilTick.delete(entityId);
    }
  }

  #queueCollidingContraptionBlock(
    tree: ContraptionState,
    point: Vector3,
    impactSpeed: number,
    collisionTag?: number | string
  ): PhysicsContraptionBlock | undefined {
    if (typeof collisionTag === "number" && Number.isInteger(collisionTag)) {
      const group = tree.leafPhysicsPlan.breakGroups[collisionTag];
      if (group?.keys.some(key => tree.leaves.has(key))) {
        this.#queueLeafGroup(tree, collisionTag);
        return undefined;
      }
    }
    const block = tree.contraption.getBlockAtWorldPoint(point, CONTRAPTION_BLOCK_LOOKUP_TOLERANCE);
    if (!block) return undefined;
    const key = locationKey(block.localLocation);
    const fragile = getTreeFragileBlock(tree, key);
    if (!fragile || impactSpeed < fragile.fragileImpactSpeed) return block;
    this.#queueContraptionBlock(tree, key);
    return block;
  }

  #queueContraptionBlock(tree: ContraptionState, key: string): void {
    const leafGroup = tree.leafPhysicsPlan.breakGroupByKey.get(key);
    if (leafGroup !== undefined && tree.leaves.has(key)) {
      this.#queueLeafGroup(tree, leafGroup);
      return;
    }
    let pending = this.#pendingContraptionBlockBreaks.get(tree.contraption.id);
    if (!pending) {
      pending = new Set();
      this.#pendingContraptionBlockBreaks.set(tree.contraption.id, pending);
    }
    pending.add(key);
  }

  #queueLeafGroup(tree: ContraptionState, groupId: number): void {
    let pending = this.#pendingLeafGroupBreaks.get(tree.contraption.id);
    if (!pending) {
      pending = new Set();
      this.#pendingLeafGroupBreaks.set(tree.contraption.id, pending);
    }
    pending.add(groupId);
  }

  #queueTreeLogImpact(
    tree: ContraptionState,
    impactSpeed: number,
    point: Vector3
  ): void {
    if (!shouldBreakTreeLogs()) {
      this.#pendingLogImpacts.delete(tree.contraption.id);
      return;
    }
    if (!tree.logBreakagePlan.eligible || tree.pendingLogBreak) return;
    const localPoint = tree.contraption.body.worldPointToLocal(point);
    const damage = getTreeLogImpactDamage(
      tree.logBreakagePlan,
      tree.contraption.body.getMass(),
      impactSpeed,
      localPoint
    );
    if (damage <= 0) return;
    const pending = this.#pendingLogImpacts.get(tree.contraption.id);
    if (pending && pending.damage >= damage) return;
    this.#pendingLogImpacts.set(tree.contraption.id, { damage, localPoint });
  }

  #spawnCollisionParticles(
    tree: ContraptionState,
    event: PhysicsCollisionAfterEvent,
    worldHit: WorldCollisionHit | undefined,
    resolvedBlock?: PhysicsContraptionBlock
  ): void {
    if (
      event.otherBody
      || event.impactSpeed < LOG_IMPACT_TRIGGER_SPEED
      || !worldHit
      || !producesDustOnImpact(worldHit.typeId)
    ) return;
    const block = resolvedBlock ?? tree.contraption.getBlockAtWorldPoint(event.point, CONTRAPTION_BLOCK_LOOKUP_TOLERANCE);
    if (!block || (block.typeId !== "minecraft:chest" && !isTreeLog(block.typeId))) return;
    const snapshot = tree.snapshots.get(locationKey(block.localLocation));
    if (!snapshot) return;
    const contactKey = `${event.body.id}|${locationKey(block.localLocation)}|`
      + `${worldHit.locationKey}|`
      + `${quantizeCollisionCoordinate(event.point.x)},`
      + `${quantizeCollisionCoordinate(event.point.y)},`
      + `${quantizeCollisionCoordinate(event.point.z)}`;
    if (this.#collisionEffectKeys.has(contactKey)) return;
    this.#collisionEffectKeys.add(contactKey);
    const inLiquid = this.#isLiquidParticleLocation(
      tree.contraption.body.dimension.dimension,
      event.point
    );
    spawnBlockParticle(
      tree.contraption.body.dimension.dimension,
      event.point,
      snapshot,
      block.localLocation,
      tree.contraption.foliageTint,
      { includeDust: true, inLiquid, kind: "collision" }
    );
  }

  #isLiquidParticleLocation(dimension: Dimension, location: Vector3): boolean {
    const base = {
      x: Math.floor(location.x),
      y: Math.floor(location.y),
      z: Math.floor(location.z)
    };
    for (const yOffset of LIQUID_SURFACE_PROBE_Y_OFFSETS) {
      if (this.#getCollisionWorldBlock(dimension, {
        ...base,
        y: base.y + yOffset
      })?.isLiquid) return true;
    }
    return false;
  }

  #prepareCollisionCache(currentTick: number): void {
    if (this.#collisionCacheTick === currentTick) return;
    this.#collisionCacheTick = currentTick;
    this.#collisionEffectKeys.clear();
    this.#collisionWorldBlockCache.clear();
  }

  #getCollisionWorldBlock(
    dimension: Dimension,
    location: Vector3
  ): Block | undefined {
    const key = `${dimension.id}|${locationKey(location)}`;
    if (this.#collisionWorldBlockCache.has(key)) {
      return this.#collisionWorldBlockCache.get(key);
    }
    const block = safeGetBlock(dimension, location);
    this.#collisionWorldBlockCache.set(key, block);
    return block;
  }

  #flushCollidingContraptionBlocks(tree: ContraptionState): boolean {
    const pending = this.#pendingContraptionBlockBreaks.get(tree.contraption.id);
    const pendingGroups = this.#pendingLeafGroupBreaks.get(tree.contraption.id);
    const queuedLogImpact = this.#pendingLogImpacts.get(tree.contraption.id);
    const pendingLogImpact = shouldBreakTreeLogs() ? queuedLogImpact : undefined;
    if (queuedLogImpact && !pendingLogImpact) {
      this.#pendingLogImpacts.delete(tree.contraption.id);
    }
    if (!pending && !pendingGroups && !pendingLogImpact) return false;

    // A durable log-break transaction must finish with exactly its saved key set. Keep
    // collisions received during a retry queued for the following physics batch.
    if (tree.pendingLogBreak) {
      const transactionKeys = new Set(tree.pendingLogBreak.keys);
      const deferredKeys = new Set(
        [...(pending ?? [])].filter(key => !transactionKeys.has(key))
      );
      if (deferredKeys.size > 0) {
        this.#pendingContraptionBlockBreaks.set(tree.contraption.id, deferredKeys);
      } else {
        this.#pendingContraptionBlockBreaks.delete(tree.contraption.id);
      }
      const blocks = tree.pendingLogBreak.keys
        .map(key => getTreeBreakableBlock(tree, key))
        .filter((block): block is FallenFragileBlock => block !== undefined);
      return this.#breakContraptionBlocks(tree, blocks);
    }

    this.#clearPendingCollisionState(tree.contraption.id);
    const blocks: FallenFragileBlock[] = [];
    const keys = new Set(pending);
    for (const groupId of pendingGroups ?? []) {
      for (const key of tree.leafPhysicsPlan.breakGroups[groupId]?.keys ?? []) keys.add(key);
    }
    if (pendingLogImpact) {
      tree.logBreakDamage += pendingLogImpact.damage;
      const resolution = resolveTreeLogBreakage(
        tree.logBreakagePlan,
        new Set(tree.logs.keys()),
        tree.logBreakDamage,
        tree.logBreakGeneration + 1,
        pendingLogImpact.localPoint
      );
      if (resolution) {
        tree.logBreakDamage = Math.max(0, tree.logBreakDamage - resolution.cost);
        for (const key of resolution.removedKeys) keys.add(key);
      }
    }
    for (const key of keys) {
      const block = getTreeBreakableBlock(tree, key);
      if (block) blocks.push(block);
    }
    return this.#breakContraptionBlocks(tree, blocks);
  }

  #prepareLogBreakTransaction(
    tree: ContraptionState,
    breakingKeys: ReadonlySet<string>,
    currentTick: number
  ): boolean {
    if (tree.pendingLogBreak) return true;
    const keys = tree.contraption.blocks
      .map(block => locationKey(block.localLocation))
      .filter(key => breakingKeys.has(key) && tree.snapshots.has(key));
    if (keys.length === 0) return false;

    const previousSaved = this.#savedContraptions.get(tree.id);
    const previousSignature = this.#persistenceSignatures.get(tree.id);
    const wasStateDirty = this.#dirtyContraptionStates.has(tree.id);
    const wasStructureDirty = this.#dirtyContraptionStructures.has(tree.id);
    const previousGeneration = tree.logBreakGeneration;
    const generation = previousGeneration + 1;
    let brokenLogCount = 0;
    for (const key of keys) if (tree.logs.has(key)) brokenLogCount++;
    const pendingLogBreak: SerializedPendingLogBreak = {
      generation,
      keys,
      sleepTimeoutTicks: reduceSleepTimeoutForBrokenLogs(
        tree.sleepTimeoutTicks,
        tree.sleepTicksPerLog,
        brokenLogCount
      )
    };
    tree.logBreakGeneration = generation;
    tree.pendingLogBreak = pendingLogBreak;
    const saved = this.#serializeTree(tree, currentTick);
    saved.logBreakGeneration = generation;
    saved.pendingLogBreak = pendingLogBreak;
    this.#savedContraptions.set(tree.id, saved);
    this.#dirtyContraptionStructures.add(tree.id);
    this.#dirtyContraptionStates.add(tree.id);
    this.#persistenceSignatures.delete(tree.id);
    this.#writeSave();
    if (!this.#dirtyContraptionStructures.has(tree.id) && !this.#dirtyContraptionStates.has(tree.id)) return true;

    tree.logBreakGeneration = previousGeneration;
    tree.pendingLogBreak = undefined;
    if (previousSaved) this.#savedContraptions.set(tree.id, previousSaved);
    else this.#savedContraptions.delete(tree.id);
    if (previousSignature !== undefined) this.#persistenceSignatures.set(tree.id, previousSignature);
    else this.#persistenceSignatures.delete(tree.id);
    if (!wasStructureDirty) this.#dirtyContraptionStructures.delete(tree.id);
    if (wasStateDirty) this.#dirtyContraptionStates.add(tree.id);
    else this.#dirtyContraptionStates.delete(tree.id);
    return false;
  }

  #retryLogBreak(tree: ContraptionState, keys: Iterable<string>): void {
    let pending = this.#pendingContraptionBlockBreaks.get(tree.contraption.id);
    if (!pending) {
      pending = new Set();
      this.#pendingContraptionBlockBreaks.set(tree.contraption.id, pending);
    }
    for (const key of keys) pending.add(key);
  }

  #probeContraptionFragileContacts(entries: readonly ActiveTreeTickEntry[]): void {
    const samples = this.#fragileProbeSampleBuffer;
    samples.length = 0;
    this.#fragileProbeLocationsByDimension.clear();
    for (const { tree } of entries) {
      if (
        !tree.contraption.body.isActive
        || (tree.leaves.size === 0 && tree.fragileAttachments.size === 0)
      ) continue;
      tree.attachmentProbeCursor = this.#collectContraptionFragileProbes(
        tree,
        tree.attachmentProbeKeys,
        tree.attachmentProbeCursor,
        CONTRAPTION_FRAGILE_PROBES_PER_TICK,
        samples
      );
      tree.leafProbeCursor = this.#collectContraptionFragileProbes(
        tree,
        tree.leafProbeKeys,
        tree.leafProbeCursor,
        tree.leafPhysicsPlan.allocatedContactProbeCount,
        samples
      );
    }

    const blocksByDimension = new Map<Dimension, Map<string, Block>>();
    // The native non-air result is a conservative first level: samples absent
    // from it cannot satisfy either the solid-contact or world-sensor checks.
    // Candidate marks retain original sample order before the unchanged exact
    // shape, speed, current-position and predicted-position decisions run.
    if (this.#fragileProbeCandidateMarks.length < samples.length) {
      this.#fragileProbeCandidateMarks = new Uint8Array(samples.length);
    } else {
      this.#fragileProbeCandidateMarks.fill(0, 0, samples.length);
    }
    const candidateMarks = this.#fragileProbeCandidateMarks;
    let firstCandidateIndex = samples.length;
    let lastCandidateIndex = -1;
    for (const [dimension, locations] of this.#fragileProbeLocationsByDimension) {
      const blocks = readWorldBlockProbeBatch(dimension, [...locations.values()]);
      blocksByDimension.set(dimension, blocks);
      for (const key of blocks.keys()) {
        const location = locations.get(key);
        if (!location) continue;
        candidateMarks[location.firstSampleIndex] = 1;
        firstCandidateIndex = Math.min(firstCandidateIndex, location.firstSampleIndex);
        lastCandidateIndex = Math.max(lastCandidateIndex, location.firstSampleIndex);
        for (const index of location.additionalSampleIndices ?? []) {
          candidateMarks[index] = 1;
          firstCandidateIndex = Math.min(firstCandidateIndex, index);
          lastCandidateIndex = Math.max(lastCandidateIndex, index);
        }
      }
    }
    for (let index = firstCandidateIndex; index <= lastCandidateIndex; index++) {
      if (!candidateMarks[index]) continue;
      const sample = samples[index]!;
      const blocks = blocksByDimension.get(sample.physicsDimension.dimension);
      const block = blocks?.get(sample.blockKey);
      if (block && isSolidWorldBlockPoint(sample.physicsDimension, sample.worldLocation, block)) {
        this.#queueContraptionBlock(sample.tree, locationKey(sample.fragile.localLocation));
      }
      this.#queueFragileWorldBlockAtPoint(sample.physicsDimension, block, sample.speed);
      if (sample.predictedLocation && sample.predictedKey) {
        this.#queueFragileWorldBlockAtPoint(
          sample.physicsDimension,
          blocks?.get(sample.predictedKey),
          sample.speed
        );
      }
    }
    samples.length = 0;
    this.#fragileProbeLocationsByDimension.clear();
  }

  #collectContraptionFragileProbes(
    tree: ContraptionState,
    keys: readonly string[],
    cursor: number,
    budget: number,
    samples: ContraptionFragileProbeSample[]
  ): number {
    const count = Math.min(budget, keys.length);
    for (let offset = 0; offset < count; offset++) {
      const index = (cursor + offset) % keys.length;
      const fragile = getTreeFragileBlock(tree, keys[index]!);
      if (!fragile) continue;
      const worldLocation = tree.contraption.body.localPointToWorld(fragile.localLocation);
      const physicsDimension = tree.contraption.body.dimension;
      const blockLocation = {
        x: Math.floor(worldLocation.x),
        y: Math.floor(worldLocation.y),
        z: Math.floor(worldLocation.z)
      };
      const velocity = tree.contraption.body.getVelocityAt(worldLocation);
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      if (fragile.fragileImpactSpeed > 0) {
        if (speed < fragile.fragileImpactSpeed) continue;
      }
      const predictedLocation = {
        x: Math.floor(worldLocation.x + velocity.x / PHYSICS_TICKS_PER_SECOND),
        y: Math.floor(worldLocation.y + velocity.y / PHYSICS_TICKS_PER_SECOND),
        z: Math.floor(worldLocation.z + velocity.z / PHYSICS_TICKS_PER_SECOND)
      };
      const movedToPredictedBlock = (
        predictedLocation.x !== blockLocation.x
        || predictedLocation.y !== blockLocation.y
        || predictedLocation.z !== blockLocation.z
      );
      let locations = this.#fragileProbeLocationsByDimension.get(physicsDimension.dimension);
      if (!locations) {
        locations = new Map();
        this.#fragileProbeLocationsByDimension.set(physicsDimension.dimension, locations);
      }
      const blockKey = locationKey(blockLocation);
      const predictedKey = movedToPredictedBlock ? locationKey(predictedLocation) : undefined;
      const sampleIndex = samples.length;
      addContraptionFragileProbeLocation(locations, blockKey, blockLocation, sampleIndex);
      if (predictedKey) {
        addContraptionFragileProbeLocation(
          locations,
          predictedKey,
          predictedLocation,
          sampleIndex
        );
      }
      samples.push({
        blockKey,
        fragile,
        physicsDimension,
        predictedKey,
        predictedLocation: movedToPredictedBlock ? predictedLocation : undefined,
        speed,
        tree,
        worldLocation
      });
    }
    return keys.length === 0 ? 0 : (cursor + count) % keys.length;
  }

  #tickDecay(tree: ContraptionState, currentTick: number): void {
    if (
      tree.automaticLifecyclePaused
      || tree.decayProgress < 0
      || tree.decayProgress > MAX_LEAF_DISTANCE
      || currentTick < tree.nextDecayTick
      || tree.leaves.size === 0
    ) return;
    // Decay eats inward from the outermost leaf ring: leaves far from any log
    // fall almost surely, while leaves hugging the trunk never decay.
    const distance = MAX_LEAF_DISTANCE - tree.decayProgress;
    const chance = distance < DECAY_IMMUNE_LEAF_DISTANCE
      ? 0
      : Math.min(1, distance * distance / DECAY_CHANCE_DISTANCE_DIVISOR);
    const bucket = tree.leavesByDistance.get(distance);
    if (bucket) {
      for (const key of bucket) {
        if (tree.leaves.has(key) && Math.random() <= chance) {
          this.#queueContraptionBlock(tree, key);
        }
      }
    }
    tree.decayProgress++;
    tree.nextDecayTick = currentTick + 2;
  }

  #breakContraptionBlocks(
    tree: ContraptionState,
    blocks: readonly FallenFragileBlock[]
  ): boolean {
    if (blocks.length === 0) return false;
    const breaking = new Map<string, FallenFragileBlock>();
    for (const block of blocks) breaking.set(locationKey(block.localLocation), block);
    let attachmentSupport: TreeAttachmentSupportResolution =
      EMPTY_TREE_ATTACHMENT_SUPPORT_RESOLUTION;
    let attachmentsChanged = true;
    // Close leaf support first, then resolve attachment chains. A newly
    // unsupported attachment can expose another leaf boundary, so only that
    // actual change starts another closure pass.
    while (attachmentsChanged) {
      let changed = true;
      while (changed) {
        const previousSize = breaking.size;
        for (const key of [...breaking.keys()]) {
          const groupId = tree.leafPhysicsPlan.breakGroupByKey.get(key);
          if (groupId === undefined) continue;
          for (const groupKey of tree.leafPhysicsPlan.breakGroups[groupId]?.keys ?? []) {
            const leaf = tree.leaves.get(groupKey);
            if (leaf) breaking.set(groupKey, leaf);
          }
        }
        const breakingKeys = new Set(breaking.keys());
        const remainingLogs = new Set(
          [...tree.logs.keys()].filter(key => !breakingKeys.has(key))
        );
        for (const orphan of collectUnsupportedFragileBlocks(
          tree,
          breakingKeys,
          remainingLogs
        )) {
          breaking.set(locationKey(orphan.localLocation), orphan);
        }
        changed = breaking.size !== previousSize;
      }
      attachmentSupport = resolveTreeAttachmentSupportForTree(
        tree,
        new Set(breaking.keys())
      );
      attachmentsChanged = false;
      for (const key of attachmentSupport.unsupportedKeys) {
        if (breaking.has(key)) continue;
        const attachment = getTreeBreakableBlock(tree, key);
        if (!attachment) {
          throw new Error(`Unsupported tree attachment ${key} has no captured block.`);
        }
        breaking.set(key, attachment);
        attachmentsChanged = true;
      }
    }
    const attachmentStateUpdates = [...attachmentSupport.stateUpdates.values()];
    const fracturedLogs = [...breaking.keys()].some(key => tree.logs.has(key));
    if (fracturedLogs && [...tree.logs.keys()].every(key => breaking.has(key))) {
      for (const block of tree.contraption.blocks) {
        const key = locationKey(block.localLocation);
        const breakable = getTreeBreakableBlock(tree, key);
        if (breakable) breaking.set(key, breakable);
      }
    }
    if (
      fracturedLogs
      && !this.#prepareLogBreakTransaction(tree, new Set(breaking.keys()), system.currentTick)
    ) {
      this.#retryLogBreak(tree, breaking.keys());
      return false;
    }
    const dimension = tree.contraption.body.dimension.dimension;
    const positions = new Map<string, Vector3>();
    for (const [key, block] of breaking) {
      positions.set(key, tree.contraption.body.localPointToWorld(block.localLocation));
    }
    const topologyAfterRemoval = tree.automaticLifecyclePaused
      ? this.#ensureTopologyIndex(tree).createPlanAfterRemoving(
        [...breaking.values()].map(block => block.localLocation),
        tree.snapshots
      )
      : undefined;
    const removed = tree.contraption.removeBlocksAtLocalLocations(
      [...breaking.values()].map(block => block.localLocation)
    );
    if (removed.length === 0) {
      if (tree.pendingLogBreak) this.#retryLogBreak(tree, tree.pendingLogBreak.keys);
      return false;
    }
    tree.topologyIndex?.removeBlocks(removed);
    if (tree.contraption.isValid) this.#refreshContraptionVisualTracking(tree.contraption);
    if (tree.contraption.isValid) {
      this.#applyTreeAttachmentStateUpdates(tree, attachmentStateUpdates);
    }
    const mergeDrops = fracturedLogs || tree.leafPhysicsPlan.profile.id === "low";
    const pendingLogBreak = fracturedLogs ? tree.pendingLogBreak : undefined;
    const logBreakTagPrefix = pendingLogBreak
      ? `treephysics_log_break_${tree.id}_${pendingLogBreak.generation}`
      : undefined;
    const logBreakOperationIndex = new Map(
      pendingLogBreak?.keys.map((key, index) => [key, index]) ?? []
    );
    const pendingDrops: PendingItemDrop[] = [];
    const breakSoundTypeIds: string[] = [];
    for (let removedIndex = 0; removedIndex < removed.length; removedIndex++) {
      const removedBlock = removed[removedIndex]!;
      const key = locationKey(removedBlock.localLocation);
      const fragile = breaking.get(key);
      const position = positions.get(key);
      if (!fragile || !position) continue;
      breakSoundTypeIds.push(fragile.snapshot.typeId);
      if (fragile.snapshot.kind === "log") tree.logs.delete(key);
      tree.fragileAttachments.delete(key);
      const leaf = tree.leaves.get(key);
      if (leaf) {
        tree.leaves.delete(key);
        tree.leavesByDistance.get(leaf.distance)?.delete(key);
      }
      if (
        !fracturedLogs
        || isDeterministicParticleSample(removedIndex, removed.length, TREE_LOG_BREAK_MAX_PARTICLES)
      ) {
        spawnBlockParticle(
          dimension,
          position,
          fragile.snapshot,
          fragile.localLocation,
          tree.contraption.foliageTint,
          { kind: "destruct", profile: BLOCK_BREAK_PARTICLE_PROFILE }
        );
      }
      if (mergeDrops) {
        for (const item of generatePermutationDrops(
          fragile.snapshot,
          fracturedLogs ? tree.lootTool : undefined
        )) {
          pendingDrops.push({ item, location: position });
        }
      } else {
        spawnPermutationDrops(dimension, fragile.snapshot, position);
      }
      const operationIndex = logBreakOperationIndex.get(key);
      const operationTagPrefix = logBreakTagPrefix !== undefined && operationIndex !== undefined
        ? `${logBreakTagPrefix}_operation_${operationIndex}`
        : undefined;
      spawnBeeNestBees(
        dimension,
        fragile.snapshot,
        position,
        operationTagPrefix,
        new Set()
      );
      tree.snapshots.delete(key);
    }
    if (fracturedLogs) {
      tree.logBreakagePlan = pruneTreeLogBreakagePlan(
        tree.logBreakagePlan,
        new Set(tree.logs.keys())
      );
      if (!tree.logBreakagePlan.eligible) tree.logBreakDamage = 0;
    }
    if (mergeDrops) {
      spawnItemDropBatch(
        dimension,
        pendingDrops,
        true,
        logBreakTagPrefix,
        new Set()
      );
    }
    if (pendingLogBreak) {
      tree.sleepTimeoutTicks = pendingLogBreak.sleepTimeoutTicks;
      tree.pendingLogBreak = undefined;
    }
    tree.attachmentProbeKeys = [...tree.fragileAttachments.keys()];
    tree.leafProbeKeys = [...tree.leaves.keys()];
    tree.leafProbeCursor = tree.leafProbeKeys.length === 0
      ? 0
      : tree.leafProbeCursor % tree.leafProbeKeys.length;
    tree.attachmentProbeCursor = tree.attachmentProbeKeys.length === 0
      ? 0
      : tree.attachmentProbeCursor % tree.attachmentProbeKeys.length;
    tree.fragileProbeCursor = tree.worldNonLeafProbeKeys.length === 0
      ? 0
      : tree.fragileProbeCursor % tree.worldNonLeafProbeKeys.length;
    tree.worldLeafProbeCursor = tree.leafProbeKeys.length === 0
      ? 0
      : tree.worldLeafProbeCursor % tree.leafProbeKeys.length;
    let contraptionReplaced = false;
    let contraptionTerminated = false;
    const hasRemainingNonTreeBlocks = contraptionContainsNonTreeBlock(tree.contraption.blocks);
    tree.automaticLifecyclePaused = hasRemainingNonTreeBlocks;
    if (tree.logs.size === 0 && !hasRemainingNonTreeBlocks) {
      this.#settleChestStorages(
        tree.id,
        [...tree.chestStorages.values()],
        dimension,
        localLocation => tree.contraption.body.localPointToWorld(localLocation)
      );
      tree.chestStorages.clear();
      this.#untrackContraptionVisuals(tree.contraption);
      tree.contraption.remove();
      this.#clearPendingCollisionState(tree.contraption.id);
      this.#deleteTreeRecord(tree.id);
      this.#writeSave();
      contraptionTerminated = true;
    } else if (hasRemainingNonTreeBlocks) {
      const topology = topologyAfterRemoval
        ?? createTreeEditTopologyPlan(tree.contraption.blocks, tree.snapshots);
      const automaticComponents = mergeAutomaticTreeTopologyComponents(topology);
      if (automaticComponents.length > 1) {
        const stagedComponents = stageTreeTopologyComponents(tree, automaticComponents);
        const childSleepTicks = allocateTreeEditSettlementTicks(
          tree.sleepTicks,
          tree.sleepTicksPerLog,
          stagedComponents.map(component => component.logCount)
        );
        const remainingDetachedAttachments = tree.detachedAttachments
          .slice(tree.detachedAttachmentCursor)
          .map(entry => cloneSnapshot(entry.snapshot));
        this.#replaceTreeWithTopologyComponents(
          tree,
          stagedComponents,
          childSleepTicks,
          remainingDetachedAttachments
        );
        contraptionReplaced = true;
      } else {
        if (
          topology.components.length === 1
          && topology.unsupportedTreeBlocks.length === 0
        ) this.#ensureTopologyIndex(tree).markCanonicalSingleComponent();
      }
    }
    if (!contraptionReplaced && !contraptionTerminated) {
      const saved = this.#savedContraptions.get(tree.id);
      if (!saved) throw new Error(`Fallen tree ${tree.id} has no persisted source record.`);
      const state = splitSerializedContraption(
        updateSerializedContraptionState(saved, tree, system.currentTick)
      ).state;
      this.#appendTreeEditJournal(tree, {
        additions: attachmentStateUpdates.map(update => {
          const block = tree.contraption.getBlockAtLocalLocation(parseLocationKey(update.key));
          if (!block) throw new Error(`Updated tree attachment ${update.key} has no live block.`);
          return { block, snapshot: update.snapshot };
        }),
        clearPendingLogBreak: true,
        removedKeys: [...new Set([
          ...removed.map(block => locationKey(block.localLocation)),
          ...attachmentStateUpdates.map(update => update.key)
        ])],
        sleepTimeoutTicks: tree.sleepTimeoutTicks,
        state
      });
    }
    const soundLocation = positions.values().next().value as Vector3 | undefined;
    if (soundLocation && breakSoundTypeIds.length > 0) {
      try {
        const sound = selectDominantVanillaBlockBreakSound(breakSoundTypeIds);
        dimension.playSound(sound.sound, soundLocation, {
          pitch: sound.pitch,
          volume: sound.volume
        });
      } catch {
        // Fragile block removal and drops do not depend on client sound availability.
      }
    }
    return contraptionTerminated || contraptionReplaced;
  }

  #queueFragileWorldBlock(event: PhysicsCollisionAfterEvent): WorldCollisionHit | undefined {
    if (event.otherBody) return undefined;
    const physicsDimension = event.body.dimension;
    const dimension = physicsDimension.dimension;
    let worldHit: WorldCollisionHit | undefined;
    const candidates = worldContactCandidates(event.point, event.normal);
    for (const location of candidates) {
      const block = this.#getCollisionWorldBlock(dimension, location);
      if (!block) continue;
      if (!worldHit && !block.isAir && !block.isLiquid) {
        worldHit = { locationKey: locationKey(block.location), typeId: block.typeId };
      }
      const threshold = getWorldFragileImpactSpeed(physicsDimension, block);
      if (!Number.isFinite(threshold) || event.impactSpeed < threshold!) continue;
      this.#queueWorldBlockBreak(physicsDimension, block);
      return worldHit;
    }
    return worldHit;
  }

  #queueWorldBlockBreak(physicsDimension: PhysicsDimension, block: Block): void {
    if (!this.#canBreakWorldBlock(block)) return;
    const dimension = physicsDimension.dimension;
    const location = { ...block.location };
    const key = `${dimension.id}|${locationKey(location)}`;
    if (this.#pendingWorldBreaks.has(key)) return;
    this.#pendingWorldBreaks.add(key);
    const expectedTypeId = block.typeId;
    system.run(() => {
      this.#pendingWorldBreaks.delete(key);
      const current = safeGetBlock(dimension, location);
      if (
        !current
        || current.typeId !== expectedTypeId
        || !this.#canBreakWorldBlock(current)
      ) return;
      if (breakWorldBlock(current)) {
        this.#notifyWorldBlocksChanged(dimension, [location]);
      }
    });
  }

  #notifyWorldBlocksChanged(dimension: Dimension, locations: readonly Vector3[]): void {
    if (!this.#onWorldBlocksChanged || locations.length === 0) return;
    try {
      this.#onWorldBlocksChanged(dimension, locations);
    } catch {
      // Cache invalidation must not change lifecycle transactions.
    }
  }

  #queueFragileWorldBlockAtPoint(
    physicsDimension: PhysicsDimension,
    block: Block | undefined,
    impactSpeed: number
  ): void {
    if (
      !block
      || block.isAir
      || block.isLiquid
      || !physicsDimension.isWorldBlockSensor(block)
    ) return;
    const threshold = getWorldFragileImpactSpeed(physicsDimension, block);
    if (!Number.isFinite(threshold) || impactSpeed < threshold!) return;
    this.#queueWorldBlockBreak(physicsDimension, block);
  }

  #canBreakWorldBlock(block: Block): boolean {
    if (!isTreeLeaf(block.typeId)) return true;
    if (isPersistentWorldLeaf(block)) return false;
    try {
      return this.#canBreakWorldLeaf(block);
    } catch {
      return false;
    }
  }

  #requireChestStorageController(bindings: readonly ContraptionChestStorageBinding[]): void {
    if (bindings.length > 0 && !this.#chestStorage) {
      throw new Error("Persisted chest storage exists without a configured storage controller.");
    }
  }

  #settleChestStorages(
    ownerId: string,
    bindings: readonly ContraptionChestStorageBinding[],
    dimension: Dimension,
    resolveLocation: (localLocation: Vector3) => Vector3
  ): void {
    if (bindings.length === 0) return;
    this.#requireChestStorageController(bindings);
    this.#chestStorage!.settleStorages(ownerId, bindings, dimension, resolveLocation);
  }
}

function remainingDetachedAttachmentSnapshots(tree: ContraptionState): CapturedTreeBlock[] {
  return tree.detachedAttachments
    .slice(tree.detachedAttachmentCursor)
    .map(entry => cloneSnapshot(entry.snapshot));
}
function computeFluidEntryContact(
  event: PhysicsWaterEntryAfterEvent | PhysicsLavaEntryAfterEvent
): { readonly impulse: number; readonly scaleX: number; readonly scaleZ: number } {
  return {
    impulse: Math.max(0, -event.fastestContactVelocityY) * event.timeStep,
    scaleX: Math.max(1, event.maxContactX - event.minContactX + 1, event.bodyAabbSizeX),
    scaleZ: Math.max(1, event.maxContactZ - event.minContactZ + 1, event.bodyAabbSizeZ)
  };
}

function createChestStorageMap(
  bindings: readonly ContraptionChestStorageBinding[]
): Map<string, ContraptionChestStorageBinding> {
  const result = new Map<string, ContraptionChestStorageBinding>();
  const storageIds = new Set<string>();
  for (const binding of bindings) {
    if (!isChestStorageBinding(binding)) {
      throw new TypeError("Chest storage binding is invalid.");
    }
    const key = locationKey(binding.localLocation);
    if (result.has(key)) throw new RangeError(`Duplicate chest storage location ${key}.`);
    if (!storageIds.add(binding.storageId)) {
      throw new RangeError(`Duplicate chest storage ID ${binding.storageId}.`);
    }
    result.set(key, cloneChestStorageBinding(binding));
  }
  return result;
}

function updateSerializedContraptionState(
  saved: SerializedContraption,
  tree: ContraptionState,
  currentTick: number
): SerializedContraption {
  const body = tree.contraption.body;
  return {
    ...saved,
    automaticLifecyclePaused: tree.automaticLifecyclePaused,
    attachmentProbeCursor: tree.attachmentProbeCursor,
    angularVelocity: { ...body.angularVelocity },
    boundaryThreatTicks: tree.boundaryThreatTicks,
    decayProgress: tree.decayProgress,
    detachedAttachmentCursor: tree.detachedAttachmentCursor,
    editJournalSequence: tree.editJournalSequence,
    logBreakDamage: tree.logBreakDamage,
    lavaExposureTicks: tree.lavaExposureTicks,
    fragileProbeCursor: tree.fragileProbeCursor,
    lastSafePose: clonePose(tree.lastSafePose),
    location: { ...body.location },
    nextDecayDelayTicks: Math.max(0, tree.nextDecayTick - currentTick),
    pendingLavaDestruction: saved.pendingLavaDestruction,
    pendingSettlement: undefined,
    playerEditRevision: tree.playerEditRevision,
      probeCursor: tree.leafProbeCursor,
    rotation: body.getRotation(),
    sleepTicks: tree.sleepTicks,
    sleeping: body.isSleeping,
    sourceCommitted: tree.sourceCommitted,
    velocity: { ...body.velocity },
    visualEntityIds: [...tree.contraption.visualEntityIds],
    visualGeneration: tree.visualGeneration,
    worldLeafProbeCursor: tree.worldLeafProbeCursor
  };
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function createLeafPhysicsLeaves(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3
) {
  return snapshots
    .filter(snapshot => snapshot.kind === "leaf")
    .map(snapshot => {
      const localLocation = subtract(snapshot.location, origin);
      return {
        buoyancyVolume: LEAF_BUOYANCY_VOLUME,
        key: locationKey(localLocation),
        localLocation
      };
    });
}

function createExactLeafPhysicsPlan(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3
): TreeLeafPhysicsPlan {
  const leaves = createLeafPhysicsLeaves(snapshots, origin);
  return createTreeLeafPhysicsPlan(leaves, {
    leafCount: leaves.length,
    profileId: "exact"
  });
}

function restoreSavedLeafPhysicsPlan(saved: SerializedContraption): TreeLeafPhysicsPlan {
  const leaves = saved.snapshots
    .filter(entry => entry.snapshot.kind === "leaf")
    .map(entry => ({
      buoyancyVolume: 0.125,
      key: locationKey(entry.localLocation),
      localLocation: { ...entry.localLocation }
    }));
  const serialized = saved.leafPhysics;
  try {
    return restoreTreeLeafPhysicsPlan(leaves, {
      breakGroups: serialized.breakGroups?.map(group => group.map(locationKey)),
      profileId: serialized.profileId
    });
  } catch {
    return createTreeLeafPhysicsPlan(leaves, {
      leafCount: leaves.length,
      profileId: "exact"
    });
  }
}

function restoreSavedLogBreakagePlan(saved: SerializedContraption): TreeLogBreakagePlan {
  const logs = saved.snapshots
    .filter(entry => entry.snapshot.kind === "log")
    .map(entry => ({
      family: logFamily(entry.snapshot),
      key: locationKey(entry.localLocation),
      localLocation: { ...entry.localLocation }
    }));
  try {
    return restoreTreeLogBreakagePlan(logs, {
      anchorKey: saved.logBreakage.anchor
        ? locationKey(saved.logBreakage.anchor)
        : undefined,
      breakGroups: saved.logBreakage.breakGroups?.map(group => ({
        bandId: group.bandId,
        keys: group.keys.map(locationKey),
        kind: group.kind
      })),
      maximumLever: saved.logBreakage.maximumLever,
      protectedKeys: saved.logBreakage.protectedKeys?.map(locationKey),
      seed: saved.logBreakage.seed
    });
  } catch {
    return restoreTreeLogBreakagePlan(logs, {});
  }
}

function serializeLeafPhysics(
  tree: ContraptionState,
  remainingKeys: ReadonlySet<string>
): SerializedLeafPhysics {
  const plan = tree.leafPhysicsPlan;
  const breakGroups = plan.profile.groupsLeafBreakage
    ? plan.breakGroups
      .map(group => group.keys.filter(key => remainingKeys.has(key)).map(parseLocationKey))
      .filter(group => group.length > 0)
    : undefined;
  return {
    breakGroups,
    profileId: plan.profile.id
  };
}

function serializeLogBreakage(
  tree: ContraptionState,
  remainingKeys: ReadonlySet<string>
): SerializedLogBreakage {
  const plan = tree.logBreakagePlan;
  if (!plan.anchorKey || !remainingKeys.has(plan.anchorKey)) return {};
  const breakGroups = plan.breakGroups
    .map(group => ({
      bandId: group.bandId,
      keys: group.keys.filter(key => remainingKeys.has(key)).map(parseLocationKey),
      kind: group.kind
    }))
    .filter(group => group.keys.length > 0);
  return {
    anchor: parseLocationKey(plan.anchorKey),
    breakGroups,
    maximumLever: plan.maximumLever,
    protectedKeys: [...plan.protectedKeys]
      .filter(key => remainingKeys.has(key))
      .map(parseLocationKey),
    seed: plan.seed
  };
}

function getBodyPose(contraption: PhysicsContraption): SavedPose {
  return {
    location: { ...contraption.body.location },
    rotation: contraption.body.getRotation()
  };
}

function clonePose(pose: SavedPose): SavedPose {
  return { location: { ...pose.location }, rotation: { ...pose.rotation } };
}

function cloneBounds(bounds: PhysicsBodyAabb): PhysicsBodyAabb {
  return { min: { ...bounds.min }, max: { ...bounds.max } };
}

function createTreePersistenceSignature(tree: ContraptionState, currentTick: number): string {
  const body = tree.contraption.body;
  const rotation = body.getRotation();
  return [
    tree.automaticLifecyclePaused ? 1 : 0,
    tree.playerEditRevision,
    vectorSignature(body.location),
    vectorSignature(rotation),
    vectorSignature(body.velocity),
    vectorSignature(body.angularVelocity),
    body.isSleeping ? 1 : 0,
    tree.sleepTicks,
    tree.lavaExposureTicks,
    tree.boundaryThreatTicks,
    tree.decayProgress,
    tree.logBreakDamage.toFixed(4),
    Math.max(0, tree.nextDecayTick - currentTick),
    tree.leafProbeCursor,
    tree.fragileProbeCursor,
    tree.contraption.blocks.length,
    tree.leaves.size,
    vectorSignature(tree.lastSafePose.location),
    vectorSignature(tree.lastSafePose.rotation)
  ].join("|");
}

function createSavedTreeBounds(saved: SerializedContraption): PhysicsBodyAabb {
  let radius = 1;
  for (const block of saved.blocks) {
    radius = Math.max(radius, Math.hypot(
      block.localLocation.x,
      block.localLocation.y,
      block.localLocation.z
    ) + 1);
  }
  return {
    min: {
      x: saved.location.x - radius,
      y: saved.location.y - radius,
      z: saved.location.z - radius
    },
    max: {
      x: saved.location.x + radius,
      y: saved.location.y + radius,
      z: saved.location.z + radius
    }
  };
}

function hasNearbyPlayer(saved: SerializedContraption, players: readonly Player[]): boolean {
  return players.some(player => {
    if (player.dimension.id !== saved.dimensionId) return false;
    const dx = player.location.x - saved.location.x;
    const dy = Math.abs(player.location.y - saved.location.y);
    const dz = player.location.z - saved.location.z;
    return Math.hypot(dx, dz) <= RESTORE_HORIZONTAL_RADIUS
      && dy <= RESTORE_VERTICAL_RADIUS;
  });
}

function nearestPlayerTo(location: Vector3, players: readonly Player[]): Player | undefined {
  let nearest: Player | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const player of players) {
    const candidate = vectorDistance(location, player.location);
    if (candidate >= distance) continue;
    nearest = player;
    distance = candidate;
  }
  return nearest;
}

/** Clone a live block while retaining its runtime visual descriptor. */
function cloneLiveContraptionBlock(block: PhysicsContraptionBlock): PhysicsContraptionBlock {
  return {
    ...block,
    collisionShape: Array.isArray(block.collisionShape)
      ? block.collisionShape.map(box => ({ min: { ...box.min }, max: { ...box.max } }))
      : block.collisionShape,
    localLocation: { ...block.localLocation },
    rotation: block.rotation ? { ...block.rotation } : undefined,
    visual: block.visual ? { ...block.visual } : undefined
  };
}

function getTreeSourceOrigin(tree: ContraptionState): Vector3 {
  const first = tree.snapshots.entries().next().value as
    | [string, CapturedTreeBlock]
    | undefined;
  if (!first) throw new Error(`Fallen tree ${tree.id} has no source snapshot origin.`);
  return subtract(first[1].location, parseLocationKey(first[0]));
}

function getComponentSnapshots(
  tree: ContraptionState,
  component: TreeEditTopologyComponent,
  attachmentStateUpdates: ReadonlyMap<string, CapturedTreeBlock>
): CapturedTreeBlock[] {
  const snapshots: CapturedTreeBlock[] = [];
  for (const block of component.blocks) {
    const key = locationKey(block.localLocation);
    const snapshot = attachmentStateUpdates.get(key) ?? tree.snapshots.get(key);
    if (snapshot) snapshots.push(cloneSnapshot(snapshot));
    else if (treeBlockKind(block.typeId) !== undefined) {
      throw new Error(
        `Edited tree block ${key} has no captured snapshot.`
      );
    }
  }
  return snapshots;
}

function stageTreeTopologyComponents(
  tree: ContraptionState,
  components: readonly TreeEditTopologyComponent[],
  attachmentStateUpdates: readonly TreeEditTopologyAttachmentStateUpdate[] = []
): StagedTreeTopologyComponent[] {
  const updatedSnapshots = new Map(
    attachmentStateUpdates.map(update => [update.key, update.snapshot])
  );
  return components.map(component => {
    const snapshots = getComponentSnapshots(tree, component, updatedSnapshots);
    const componentKeys = new Set(
      component.blocks.map(block => locationKey(block.localLocation))
    );
    const chestStorages = [...tree.chestStorages]
      .filter(([key]) => componentKeys.has(key))
      .map(([, binding]) => cloneChestStorageBinding(binding));
    const logCount = snapshots.reduce(
      (count, snapshot) => count + (snapshot.kind === "log" ? 1 : 0),
      0
    );
    if (component.containsLog && logCount === 0) {
      throw new Error("Edited log component has no matching captured log snapshot.");
    }
    return { chestStorages, component, logCount, snapshots };
  });
}

/**
 * Automatic structural damage already resolves tree connectivity with its
 * feature-specific 26-neighbor log plan. Preserve that result as one tree body
 * and use the edit topology only to separate detached non-tree islands.
 */
function mergeAutomaticTreeTopologyComponents(
  topology: TreeEditTopologyPlan
): TreeEditTopologyComponent[] {
  const logComponents = topology.components.filter(component => component.containsLog);
  if (logComponents.length === 0) return [...topology.components];
  const mergedTreeComponent: TreeEditTopologyComponent = {
    blocks: [
      ...logComponents.flatMap(component => component.blocks),
      ...topology.unsupportedTreeBlocks
    ],
    containsLog: true,
    containsNonTreeBlock: logComponents.some(component => component.containsNonTreeBlock)
  };
  return [
    mergedTreeComponent,
    ...topology.components.filter(component => !component.containsLog)
  ];
}

function createEditedLeafPhysicsPlan(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3,
  profileId: TreeLeafPhysicsProfileId
): TreeLeafPhysicsPlan {
  const leaves = createLeafPhysicsLeaves(snapshots, origin);
  return createTreeLeafPhysicsPlan(leaves, { leafCount: leaves.length, profileId });
}

function getComponentCenterOfMass(blocks: readonly PhysicsContraptionBlock[]): Vector3 {
  let mass = 0;
  const moment = { x: 0, y: 0, z: 0 };
  for (const block of blocks) {
    const blockMass = block.mass;
    if (!Number.isFinite(blockMass) || blockMass! <= 0) {
      throw new RangeError(
        `Edited contraption block ${locationKey(block.localLocation)} has invalid mass.`
      );
    }
    mass += blockMass!;
    moment.x += block.localLocation.x * blockMass!;
    moment.y += block.localLocation.y * blockMass!;
    moment.z += block.localLocation.z * blockMass!;
  }
  if (mass <= 0) throw new RangeError("Edited contraption component has no positive mass.");
  return { x: moment.x / mass, y: moment.y / mass, z: moment.z / mass };
}

function restoreSerializedContraptionBlocks(
  blocks: readonly import("@src/Physics").PhysicsContraptionBlock[],
  snapshots: readonly SerializedSnapshotEntry[]
): import("@src/Physics").PhysicsContraptionBlock[] {
  const snapshotsByLocation = new Map(
    snapshots.map(entry => [locationKey(entry.localLocation), entry.snapshot])
  );
  return blocks.map(block => restoreSerializedContraptionBlock(
    block,
    snapshotsByLocation.get(locationKey(block.localLocation))
  ));
}

function restoreSerializedContraptionBlock(
  block: import("@src/Physics").PhysicsContraptionBlock,
  snapshot: CapturedTreeBlock | undefined
): import("@src/Physics").PhysicsContraptionBlock {
  const cloned = cloneContraptionBlock(block);
  if (snapshot) cloned.visual = createFragmentVisual(snapshot);
  if (isTreeLeaf(cloned.typeId)) {
    return {
      ...cloned,
      collidable: true,
      collisionResponse: false,
      collisionShape: "full",
      runtimeCollidable: false
    };
  }
  if (snapshot?.kind !== "attachment") return cloned;
  const collisionShape = resolveContraptionCollisionShape(snapshot);
  return { ...cloned, collidable: collisionShape !== "none", collisionShape };
}

function isSolidWorldBlockPoint(
  physicsDimension: PhysicsDimension,
  point: Vector3,
  block: Block
): boolean {
  if (block.isAir || block.isLiquid) return false;
  const location = block.location;
  const configured = physicsDimension.getBlockProperties(block).collisionShape;
  if (configured === "none") return false;
  if (configured === "full") return true;
  const local = { x: point.x - location.x, y: point.y - location.y, z: point.z - location.z };
  if (configured) {
    return configured.some(box => pointInBox(local, box.min, box.max));
  }
  const shape = resolveBlockCollisionShape(block);
  if (shape.kind === "none") return false;
  if (shape.kind === "full") return true;
  return shape.shapes.some(box => pointInBox(
    local,
    { x: box.minX, y: box.minY, z: box.minZ },
    { x: box.maxX, y: box.maxY, z: box.maxZ }
  ));
}

function isPersistentWorldLeaf(block: Block): boolean {
  if (!isTreeLeaf(block.typeId)) return false;
  try {
    const state = block.permutation.getState("persistent_bit");
    return state === true || Number(state) === 1;
  } catch {
    return false;
  }
}

function breakWorldBlock(block: Block): boolean {
  const { x, y, z } = block.location;
  try {
    block.dimension.runCommand(`setblock ${x} ${y} ${z} minecraft:air destroy`);
    return true;
  } catch {
    // A failed native destroy leaves the world unchanged.
    return false;
  }
}

/** Adds at most 20% gain to vanilla volume from existing entry impulse and contact area. */
export function computeFluidEntrySoundVolume(
  baseVolume: number,
  impulse: number,
  contactArea: number
): number {
  if (
    !Number.isFinite(baseVolume)
    || !Number.isFinite(impulse)
    || !Number.isFinite(contactArea)
    || baseVolume < 0
    || impulse < 0
    || contactArea < 1
  ) {
    throw new RangeError("Fluid entry sound parameters must be finite and non-negative.");
  }
  const strength = impulse * contactArea;
  const response = strength / (strength + FLUID_ENTRY_SOUND_SATURATION);
  return baseVolume * (1 + FLUID_ENTRY_SOUND_MAX_GAIN * response);
}

function normalizeSleepTimeout(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 60;
}

function normalizeInitialSleepTicks(value: unknown, sleepTimeoutTicks: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Initial settlement ticks must be a non-negative safe integer.");
  }
  if (value > sleepTimeoutTicks) {
    throw new RangeError("Initial settlement ticks cannot exceed the settlement timeout.");
  }
  return value;
}

function normalizeSleepTicksPerLog(
  value: unknown,
  sleepTimeoutTicks: number,
  logCount: number
): number {
  const timeout = normalizeSleepTimeout(sleepTimeoutTicks);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(timeout, Math.max(1, Math.floor(value)));
  }
  return Math.min(
    timeout,
    Math.max(1, Math.round(timeout / Math.max(1, Math.floor(logCount))))
  );
}

function reduceSleepTimeoutForBrokenLogs(
  sleepTimeoutTicks: number,
  sleepTicksPerLog: number,
  brokenLogCount: number
): number {
  return Math.max(
    sleepTicksPerLog,
    normalizeSleepTimeout(sleepTimeoutTicks)
      - Math.max(0, Math.floor(brokenLogCount)) * sleepTicksPerLog
  );
}

function normalizeLavaExposureTicks(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(LAVA_DESTRUCTION_EXPOSURE_TICKS, Math.max(0, value))
    : 0;
}

function normalizeLavaSubmersionRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function selectLavaDestructionAnchors(
  tree: ContraptionState,
  maximum: number
): LavaDestructionAnchor[] {
  const body = tree.contraption.body;
  const aabb = body.getAabb();
  const center = {
    x: (aabb.min.x + aabb.max.x) / 2,
    y: (aabb.min.y + aabb.max.y) / 2,
    z: (aabb.min.z + aabb.max.z) / 2
  };
  // One representative block per occupied octant keeps the terminal burst bounded and distributed.
  const anchors: Array<LavaDestructionAnchor | undefined> = [];
  let anchorCount = 0;
  for (const block of tree.contraption.blocks) {
    const snapshot = tree.snapshots.get(locationKey(block.localLocation));
    if (!snapshot) continue;
    const location = body.localPointToWorld(block.localLocation);
    const octant = (location.x >= center.x ? 1 : 0)
      | (location.y >= center.y ? 2 : 0)
      | (location.z >= center.z ? 4 : 0);
    if (anchors[octant]) continue;
    anchors[octant] = {
      location: { ...location },
      localLocation: { ...block.localLocation },
      snapshot
    };
    anchorCount++;
    if (anchorCount >= maximum) break;
  }
  return anchors.filter((anchor): anchor is LavaDestructionAnchor => anchor !== undefined);
}

function normalizeVisualGeneration(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

function normalizePlayerEditRevision(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Player edit revision must be a non-negative integer.");
  }
  return value;
}

function isContraptionVisualEntity(entity: Entity): boolean {
  if (!CONTRAPTION_RENDER_ENTITY_TYPE_IDS.has(entity.typeId)) return false;
  if (entity.typeId !== "treephysics:block") return true;
  try {
    return entity.getTags().some(tag => tag.startsWith(CONTRAPTION_VISUAL_TAG_PREFIX));
  } catch {
    return false;
  }
}

function getContraptionUprightness(contraption: PhysicsContraption): number {
  const origin = contraption.body.localPointToWorld({ x: 0, y: 0, z: 0 });
  const up = contraption.body.localPointToWorld({ x: 0, y: 1, z: 0 });
  return Math.max(0, Math.min(1, up.y - origin.y));
}

function worldContactCandidates(point: Vector3, normal: Vector3): Vector3[] {
  const candidates = new Map<string, Vector3>();
  for (const scale of WORLD_CONTACT_PROBE_SCALES) {
    const location = {
      x: Math.floor(point.x + normal.x * scale),
      y: Math.floor(point.y + normal.y * scale),
      z: Math.floor(point.z + normal.z * scale)
    };
    candidates.set(locationKey(location), location);
  }
  return [...candidates.values()];
}

function quantizeCollisionCoordinate(value: number): number {
  return Math.round(value * 16);
}

function getContraptionFragileImpactSpeed(snapshot: CapturedTreeBlock): number | undefined {
  if (snapshot.kind === "leaf" || isFragilePlantTreeAttachment(snapshot.typeId)) return 0;
  if (snapshot.kind !== "attachment") return undefined;
  const threshold = BLOCK_PHYSICS_PROPERTIES[snapshot.typeId]?.fragileImpactSpeed;
  return Number.isFinite(threshold) ? Math.max(0, threshold!) : undefined;
}

function getWorldFragileImpactSpeed(
  physicsDimension: PhysicsDimension,
  block: Block
): number | undefined {
  const configured = physicsDimension.getBlockProperties(block).fragileImpactSpeed;
  if (Number.isFinite(configured)) return configured;
  return isTreeLeaf(block.typeId) && physicsDimension.isWorldBlockSensor(block) ? 0 : undefined;
}

function getTreeFragileBlock(
  tree: ContraptionState,
  key: string
): FallenFragileBlock | undefined {
  return tree.leaves.get(key) ?? tree.fragileAttachments.get(key);
}

function normalizeLogBreakDamage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function getTreeBreakableBlock(
  tree: ContraptionState,
  key: string
): FallenFragileBlock | undefined {
  const fragile = getTreeFragileBlock(tree, key);
  if (fragile) return fragile;
  const snapshot = tree.snapshots.get(key);
  if (!snapshot) return undefined;
  return {
    fragileImpactSpeed: 0,
    localLocation: parseLocationKey(key),
    snapshot
  };
}

function createLeafDistanceBuckets(
  leaves: ReadonlyMap<string, FallenLeaf>
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  for (const [key, leaf] of leaves) {
    let bucket = result.get(leaf.distance);
    if (!bucket) {
      bucket = new Set();
      result.set(leaf.distance, bucket);
    }
    bucket.add(key);
  }
  return result;
}

function collectUnsupportedFragileBlocks(
  tree: ContraptionState,
  breakingKeys: ReadonlySet<string>,
  remainingLogs: ReadonlyMap<string, unknown> | ReadonlySet<string> = tree.logs
): FallenFragileBlock[] {
  const affectedSeeds = new Set<string>();
  for (const key of breakingKeys) {
    const breaking = getTreeBreakableBlock(tree, key);
    if (!breaking) continue;
    for (const offset of SUPPORT_OFFSETS) {
      const neighborKey = locationKey(add(breaking.localLocation, offset));
      if (!breakingKeys.has(neighborKey) && tree.leaves.has(neighborKey)) {
        affectedSeeds.add(neighborKey);
      }
    }
  }
  const visited = new Set<string>();
  const unsupported: FallenFragileBlock[] = [];
  for (const seed of affectedSeeds) {
    if (visited.has(seed)) continue;
    const componentKeys: string[] = [];
    const queue = [seed];
    visited.add(seed);
    let supported = false;
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      const leaf = tree.leaves.get(key);
      if (!leaf || breakingKeys.has(key)) continue;
      componentKeys.push(key);
      supported ||= hasAdjacentKey(leaf.localLocation, remainingLogs);
      for (const offset of SUPPORT_OFFSETS) {
        const neighborKey = locationKey(add(leaf.localLocation, offset));
        if (
          visited.has(neighborKey)
          || breakingKeys.has(neighborKey)
          || !tree.leaves.has(neighborKey)
        ) continue;
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }
    if (supported) continue;
    for (const key of componentKeys) {
      unsupported.push(tree.leaves.get(key)!);
    }
  }
  return unsupported;
}

function createTreeAttachmentSupportEntries(
  snapshots: ReadonlyMap<string, CapturedTreeBlock>
): TreeAttachmentSupportEntry[] {
  return [...snapshots].map(([key, snapshot]) => ({
    key,
    localLocation: parseLocationKey(key),
    snapshot
  }));
}

const EMPTY_TREE_ATTACHMENT_SUPPORT_RESOLUTION: TreeAttachmentSupportResolution = {
  stateUpdates: new Map(),
  supportKeysByAttachment: new Map(),
  unsupportedKeys: new Set()
};

function resolveTreeAttachmentSupportForTree(
  tree: ContraptionState,
  removedKeys: ReadonlySet<string>
): TreeAttachmentSupportResolution {
  if (tree.fragileAttachments.size === 0) {
    return EMPTY_TREE_ATTACHMENT_SUPPORT_RESOLUTION;
  }
  return resolveTreeAttachmentSupport(
    createTreeAttachmentSupportEntries(tree.snapshots),
    removedKeys
  );
}

function pointInBox(point: Vector3, min: Vector3, max: Vector3): boolean {
  return point.x >= min.x && point.x <= max.x
    && point.y >= min.y && point.y <= max.y
    && point.z >= min.z && point.z <= max.z;
}

function addContraptionFragileProbeLocation(
  locations: Map<string, ContraptionFragileProbeLocation>,
  key: string,
  location: Vector3,
  sampleIndex: number
): void {
  const existing = locations.get(key);
  if (existing) {
    (existing.additionalSampleIndices ??= []).push(sampleIndex);
    return;
  }
  locations.set(key, { ...location, firstSampleIndex: sampleIndex });
}
