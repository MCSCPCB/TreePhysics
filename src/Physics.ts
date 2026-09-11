import {
  InputButton,
  system,
  world,
  type Block,
  type Dimension,
  type Entity,
  type Player,
  type Vector3
} from "@minecraft/server";
import { ContraptionColliderIndex } from "@src/physics/contraption/ColliderIndex";
import { raycastContraptionGrid } from "@src/physics/contraption/GridRaycast";
import { ContraptionSpatialIndex } from "@src/physics/contraption/SpatialIndex";
import {
  isContraptionBlockCollidable,
  isContraptionBlockRaySolid,
  normalizeContraptionBlocks,
  normalizeContraptionFoliageTint,
  normalizeVisualEntityTags
} from "@src/physics/contraption/Normalization";
import {
  computeContraptionInertia,
  computeContraptionMassProperties,
  createDefaultContraptionBuoyancyPoints
} from "@src/physics/contraption/Mass";
export { createDefaultContraptionBuoyancyPoints } from "@src/physics/contraption/Mass";
import {
  blockKey as contraptionBlockKey,
  packLocalBlockKey
} from "@src/utils/BlockKey";
import { EPSILON_1E8, isFiniteVector } from "@src/utils/Vector3Math";
import { DEFAULT_CONTRAPTION_FOLIAGE_TINT } from "@src/render/foliage/TintCodec";
import { attachIndexedWorldSensorHits } from "@src/physics/world/sensor/Batch";
import { ContraptionCollisionSnapshotIndex } from "@src/physics/collision/ContraptionColliderIndex";
import {
  createContraptionCollisionEntitySnapshots,
  handleBlockColliderLoad,
  removeStaleContraptionColliders,
  ContraptionCollider
} from "@src/physics/collision/ContraptionCollider";
import {
  handleContraptionMountLoad,
  MountObb,
  removeStaleContraptionMounts,
  restoreStaleMountPlayerInput
} from "@src/physics/obb/Mount";
import {
  resolveVanillaBlockFallSound,
  resolveVanillaBlockJumpSound,
  resolveVanillaBlockLandSound,
  resolveVanillaBlockStepSound,
  type VanillaBlockSoundEvent
} from "@src/data/BlockSound";
import type { ObbCollisionShell, ObbEntitySnapshot } from "@src/physics/obb";
import {
  assertBlockVisualItems,
  createBlockRenderer,
  BLOCK_CARRIER_CAPACITY,
  BLOCK_CARRIER_ENTITY_TYPE_ID,
  BLOCK_SLOTS_PER_ENTITY,
  tryCreateFragmentRenderer,
  type ContraptionRenderer,
  type BlockAssignment
} from "@src/render/contraption/shared/Renderer";
import { selectContraptionVisualAnchor } from "@src/render/contraption/shared/VisualAnchor";
import {
  CannonKernelRuntime,
  isCannonWorldMeshAuditCandidatePreferred,
  type CannonKernelBody,
  type CannonKernelCollisionAfterEvent,
  type CannonKernelLavaEntryAfterEvent,
  type CannonKernelWaterEntryAfterEvent,
  type CannonWorldMeshAuditCandidate,
  type CannonWorldMeshAuditCoordinator
} from "@src/physics/simulation/CannonKernel";
import type {
  PhysicsContraptionBlock,
  PhysicsContraptionFoliageTint,
  PhysicsContraptionOptions,
  PhysicsContraptionRaycastOptions,
  PhysicsContraptionRaycastHit,
  PhysicsContraptionRuntimeRepresentation,
  PhysicsContraptionRuntimeRepresentationFactory,
  PhysicsContraptionRuntimeRepresentationState,
  PhysicsBlockProperties,
  PhysicsBodyAabb,
  PhysicsBodyBuoyancyPoint,
  PhysicsBodyCollider,
  PhysicsBodyForceOptions,
  PhysicsBodyOptions,
  PhysicsBodyTeleportOptions,
  PhysicsCollisionAfterEvent,
  PhysicsContactMaterialProperties,
  PhysicsInertiaTensor,
  PhysicsLavaEntryAfterEvent,
  PhysicsWorldOptions,
  PhysicsWorldStats,
  PhysicsWorldStepAfterEvent,
  PhysicsWaterEntryAfterEvent
} from "@src/physics/core/Types";
import {
  getTreePhysicsPerformanceLevel,
  TREE_PHYSICS_PERFORMANCE_HIGH,
  TREE_PHYSICS_PERFORMANCE_LOW,
  type TreePhysicsPerformanceLevel
} from "@src/config/Settings";

export type {
  PhysicsContraptionBlock,
  PhysicsContraptionFoliageTint,
  PhysicsContraptionOptions,
  PhysicsContraptionRaycastOptions,
  PhysicsContraptionRaycastHit,
  PhysicsContraptionRuntimeRepresentation,
  PhysicsContraptionRuntimeRepresentationFactory,
  PhysicsContraptionRuntimeRepresentationState,
  PhysicsBlockProperties,
  PhysicsBodyAabb,
  PhysicsBodyBuoyancyPoint,
  PhysicsBodyCollider,
  PhysicsBodyForceOptions,
  PhysicsBodyOptions,
  PhysicsBodyTeleportOptions,
  PhysicsCollisionAfterEvent,
  PhysicsContactMaterialProperties,
  PhysicsInertiaTensor,
  PhysicsLavaEntryAfterEvent,
  PhysicsWorldOptions,
  PhysicsWorldStats,
  PhysicsWorldStepAfterEvent,
  PhysicsWaterEntryAfterEvent
} from "@src/physics/core/Types";
export { resolveBlockCollisionShape } from "@src/physics/collision/BlockShapeResolver";
export { handleBlockColliderLoad, handleContraptionMountLoad };

const GET_SIMULATION_OPTIONS = Symbol("getSimulationOptions");
const GET_COLLISION_SHELL = Symbol("getCollisionShell");
const GET_PLAYER_COLLISION_ENABLED = Symbol("getPlayerCollisionEnabled");
const GET_PLAYER_CARRYING_ENABLED = Symbol("getPlayerCarryingEnabled");
const GET_PLAYER_MOUNT_ENABLED = Symbol("getPlayerMountEnabled");
const CONFIGURE_SIMULATION = Symbol("configureSimulation");
const GET_WORLD_MESH_AUDIT_CANDIDATE = Symbol("getWorldMeshAuditCandidate");
const HAS_PENDING_WORLD_MESH_BUILDS = Symbol("hasPendingWorldMeshBuilds");
const UPDATE_CONTRAPTION_SPATIAL_INDEX = Symbol("updateContraptionSpatialIndex");
const REMOVE_CONTRAPTION_FROM_SPATIAL_INDEX = Symbol("removeContraptionFromSpatialIndex");
const DEFAULT_VISUAL_ENTITY_TYPE_ID = "treephysics:block";
const BLOCK_OFFHAND_ITEM_OFFSET_PROPERTY = "treephysics:left_item_offset";
const ADDON_BLOCK_OFFHAND_ITEM_OFFSET = 0.00;
const MINECRAFT_BLOCK_OFFHAND_ITEM_OFFSET = 2.00;
const DEFAULT_OTHER_BLOCK_MASS = 0.25;
const WORLD_MESH_AUDIT_INTERVAL_TICKS = 20;
const FLOWING_FLUID_COLLISION_RECOVERY_TICKS = 8;
const FOOTSTEP_DISTANCE = 1.6;
const FOOTSTEP_MAX_DELTA = 1.5;
const FOOTSTEP_CONTACT_RETENTION_TICKS = 4;
const SPRINT_PARTICLE_INTERVAL_TICKS = 3;
const SPRINT_PARTICLE_COUNT = 3;
const SPRINT_PARTICLE_HORIZONTAL_RADIUS = 0.3;
const SPRINT_PARTICLE_VERTICAL_RADIUS = 0.02;
const SPRINT_PARTICLE_SPEED_MIN = 1.2;
const SPRINT_PARTICLE_SPEED_MAX = 3.6;
const SPRINT_PARTICLE_MIN_RELATIVE_SPEED = 0.01;
// Kickback bursts fly against the sprint direction, scaled up from the
// per-tick relative velocity so they remain visible at walking speeds.
const SPRINT_PARTICLE_VELOCITY_SCALE = -4;
const SPRINT_PARTICLE_UPWARD_DIRECTION = 1.5;
const SPRINT_PARTICLE_DIRECTION_RANDOMNESS = 0.4;
const SPRINT_PARTICLE_SURFACE_OFFSET_Y = 0.1;
const PLAYER_GRAVITY_PER_TICK = 0.08;
const PLAYER_VERTICAL_DRAG_PER_TICK = 0.98;
const PLAYER_TERMINAL_DOWNWARD_SPEED =
  PLAYER_GRAVITY_PER_TICK * PLAYER_VERTICAL_DRAG_PER_TICK
  / (1 - PLAYER_VERTICAL_DRAG_PER_TICK);
const SAFE_FALL_DISTANCE = 3;
const LANDING_APPROACH_RETENTION_TICKS = 2;
const MAX_LANDING_PARTICLES = 96;
const LANDING_PARTICLE_SURFACE_OFFSET_Y = 0.02;
const LANDING_PARTICLE_UPWARD_DIRECTION = 0.8;
// Burst strength ramps with blocks fallen beyond the safe distance and is
// capped so terminal-velocity landings do not flood the client.
const LANDING_STRENGTH_BASE = 0.2;
const LANDING_STRENGTH_EXCESS_DIVISOR = 15;
const LANDING_STRENGTH_MAX = 2.5;
const LANDING_PARTICLES_PER_STRENGTH = 150;
// A cell scan visits O(distance^3) packed keys, so far lookups fall back to
// one linear pass over the block list instead.
const BLOCK_LOOKUP_CELL_SCAN_MAX_DISTANCE = 4;
const DEFAULT_BLOCK_LOOKUP_DISTANCE = 0.9;
const JUMP_INPUT = InputButton.Jump;

interface FootstepContact {
  readonly block: PhysicsContraptionBlock | undefined;
  readonly blockTypeId: string | undefined;
  readonly distanceSquared: number;
  readonly entity: Entity;
  readonly grounded: boolean;
  readonly jumped: boolean;
  readonly landingDownwardSpeed?: number;
  readonly location: Vector3;
  readonly mountContact: boolean;
  readonly playerVelocity: Vector3;
  readonly relativePosition: Vector3;
  readonly sprinting?: boolean;
  readonly supportLocal: Vector3;
  readonly surfaceVelocity: Vector3;
  readonly contraptionId: number;
}

interface FootstepState {
  distance: number;
  lastContactTick: number;
  lastJumpPressed: boolean;
  lastPosition: Vector3;
  lastSprintParticleTick: number;
  contraptionId: number;
}

interface LandingApproachState {
  readonly downwardSpeed: number;
  readonly feetY: number;
  readonly lastSampleTick: number;
}

interface PhysicsSurfaceContactState {
  readonly grounded?: boolean;
  readonly jumped?: boolean;
  readonly landingDownwardSpeed?: number;
  readonly sprinting?: boolean;
}

export interface PhysicsContraptionSurfaceParticleProfile {
  readonly direction: Vector3;
  readonly directionRandomness: Vector3;
  readonly offsetRadius: Vector3;
  readonly particleCount: number;
  readonly speedMax: number;
  readonly speedMin: number;
}

export interface PhysicsContraptionSurfaceParticleAfterEvent {
  readonly contraptionId: number;
  readonly block: PhysicsContraptionBlock;
  readonly dimension: Dimension;
  readonly location: Vector3;
  readonly profile: PhysicsContraptionSurfaceParticleProfile;
}

type PhysicsSurfaceContactCallback = (
  entity: Entity,
  location: Vector3,
  relativePosition: Vector3,
  playerPosition: Vector3,
  contraptionId: number,
  block: PhysicsContraptionBlock | undefined,
  playerVelocity: Vector3,
  surfaceVelocity: Vector3,
  state?: PhysicsSurfaceContactState
) => void;

type Callback<T> = (event: T) => void;

class EventSignal<T> {
  readonly #callbacks = new Set<Callback<T>>();

  subscribe(callback: Callback<T>): Callback<T> {
    this.#callbacks.add(callback);
    return callback;
  }

  unsubscribe(callback: Callback<T>): void {
    this.#callbacks.delete(callback);
  }

  emit(event: T): void {
    for (const callback of this.#callbacks) callback(event);
  }
}

class PhysicsWorldAfterEvents {
  readonly collision = new EventSignal<PhysicsCollisionAfterEvent>();
  readonly lavaEntry = new EventSignal<PhysicsLavaEntryAfterEvent>();
  readonly surfaceParticle = new EventSignal<PhysicsContraptionSurfaceParticleAfterEvent>();
  readonly step = new EventSignal<PhysicsWorldStepAfterEvent>();
  readonly waterEntry = new EventSignal<PhysicsWaterEntryAfterEvent>();
}

export class PhysicsBody {
  readonly id: number;
  readonly dimension: PhysicsDimension;
  readonly name?: string;
  readonly #kernelBody: CannonKernelBody;
  readonly #onBoundsChanged: () => void;
  readonly #onRemoved: () => void;

  constructor(
    dimension: PhysicsDimension,
    kernelBody: CannonKernelBody,
    name?: string,
    onBoundsChanged: () => void = () => undefined,
    onRemoved: () => void = () => undefined
  ) {
    this.dimension = dimension;
    this.#kernelBody = kernelBody;
    this.id = kernelBody.id;
    this.name = name;
    this.#onBoundsChanged = onBoundsChanged;
    this.#onRemoved = onRemoved;
  }

  get isActive(): boolean { return this.#kernelBody.isActive; }
  get isInNativeFlowingFluid(): boolean { return this.#kernelBody.isInNativeFlowingFluid; }
  get isSleeping(): boolean { return this.#kernelBody.isSleeping; }
  get isValid(): boolean { return this.#kernelBody.isValid; }
  get lavaSubmersionRatio(): number { return this.#kernelBody.lavaSubmersionRatio; }
  get location(): Vector3 { return this.#kernelBody.location; }
  get velocity(): Vector3 { return this.#kernelBody.velocity; }
  get angularVelocity(): Vector3 { return this.#kernelBody.angularVelocity; }

  getAabb(): PhysicsBodyAabb { return this.#kernelBody.getAabb(); }
  getAngularVelocity(): Vector3 { return this.#kernelBody.getAngularVelocity(); }
  getCenterOfMass(): Vector3 { return this.#kernelBody.getCenterOfMass(); }
  getEffectiveInertia(direction: Vector3): number {
    return this.#kernelBody.getEffectiveInertia(direction);
  }
  getInertia(): Vector3 { return this.#kernelBody.getInertia(); }
  getInertiaTensor(): PhysicsInertiaTensor { return this.#kernelBody.getInertiaTensor(); }
  getEffectiveMassAt(location: Vector3, direction: Vector3): number {
    return this.#kernelBody.getEffectiveMassAt(location, direction);
  }
  getMass(): number { return this.#kernelBody.getMass(); }
  getShapeCount(): number { return this.#kernelBody.getShapeCount(); }
  getRotation(): Vector3 { return this.#kernelBody.getRotation(); }
  getVisualRotation(reference?: Vector3): Vector3 {
    return this.#kernelBody.getVisualRotation(reference);
  }
  getVelocity(): Vector3 { return this.#kernelBody.getVelocity(); }
  getVelocityAt(location: Vector3): Vector3 { return this.#kernelBody.getVelocityAt(location); }
  localPointToWorld(location: Vector3): Vector3 {
    return this.#kernelBody.localPointToWorld(location);
  }
  worldPointToLocal(location: Vector3): Vector3 {
    return this.#kernelBody.worldPointToLocal(location);
  }

  clearVelocity(): void {
    this.setVelocity({ x: 0, y: 0, z: 0 });
    this.setAngularVelocity({ x: 0, y: 0, z: 0 });
  }

  setAngularVelocity(velocity: Vector3): void { this.#kernelBody.setAngularVelocity(velocity); }
  setCenterOfMass(centerOfMass: Vector3): void {
    this.#kernelBody.setCenterOfMass(centerOfMass);
    this.#onBoundsChanged();
  }
  setInertia(inertia: Vector3): void { this.#kernelBody.setInertia(inertia); }
  setInertiaTensor(inertia: PhysicsInertiaTensor): void { this.#kernelBody.setInertiaTensor(inertia); }
  setMass(mass: number): void { this.#kernelBody.setMass(mass); }
  setBuoyancyPoints(points: readonly PhysicsBodyBuoyancyPoint[]): void {
    this.#kernelBody.setBuoyancyPoints(points);
  }
  setCollider(collider: PhysicsBodyCollider): void {
    this.#kernelBody.setCollider(collider);
    this.#onBoundsChanged();
  }
  setColliderIncrementally(collider: PhysicsBodyCollider): void {
    this.#kernelBody.setColliderIncrementally(collider);
    this.#onBoundsChanged();
  }
  setEnvironmentCollider(collider: PhysicsBodyCollider): void {
    this.#kernelBody.setEnvironmentCollider(collider);
  }
  setRotation(rotation: Vector3): void {
    this.#kernelBody.setRotation(rotation);
    this.#onBoundsChanged();
  }
  setVelocity(velocity: Vector3): void { this.#kernelBody.setVelocity(velocity); }
  sleep(): void { this.#kernelBody.sleep(); }
  wakeUp(): void { this.#kernelBody.wakeUp(); }

  applyForce(force: Vector3, options?: PhysicsBodyForceOptions): void {
    this.#kernelBody.applyForce(force, options?.coordinateSpace ?? "world");
  }

  applyForceAt(location: Vector3, force: Vector3, options?: PhysicsBodyForceOptions): void {
    this.#kernelBody.applyForceAt(location, force, options?.coordinateSpace ?? "world");
  }

  applyImpulse(impulse: Vector3): void { this.#kernelBody.applyImpulse(impulse); }
  applyImpulseAt(location: Vector3, impulse: Vector3): void {
    this.#kernelBody.applyImpulseAt(location, impulse);
  }
  applyTorque(torque: Vector3, options?: PhysicsBodyForceOptions): void {
    this.#kernelBody.applyTorque(torque, options?.coordinateSpace ?? "world");
  }
  applyTorqueImpulse(torque: Vector3): void { this.#kernelBody.applyTorqueImpulse(torque); }
  teleport(location: Vector3, options?: PhysicsBodyTeleportOptions): void {
    this.#kernelBody.teleport(location, options);
    this.#onBoundsChanged();
  }
  remove(): void {
    this.#onRemoved();
    this.#kernelBody.remove();
  }
}

export class PhysicsContraption {
  readonly body: PhysicsBody;
  readonly foliageTint?: PhysicsContraptionFoliageTint;
  readonly #blocks: PhysicsContraptionBlock[];
  readonly #blocksByKey = new Map<string, PhysicsContraptionBlock>();
  // Parallel integer-keyed index for the collision, raycast, and footstep hot
  // paths, which otherwise build one template string per probed cell.
  readonly #blocksByPackedKey = new Map<number, PhysicsContraptionBlock>();
  readonly #blockOrderByPackedKey = new Map<number, number>();
  readonly #logicalColliderIndex: ContraptionColliderIndex;
  readonly #collisionProxy: ContraptionCollider;
  readonly #visuals: ContraptionRenderer;
  readonly #openCubeBlockKeys = new Set<string>();
  readonly #runtimeRepresentation?: PhysicsContraptionRuntimeRepresentationFactory;
  readonly #runtimeRepresentationState?: PhysicsContraptionRuntimeRepresentationState;
  #flowingFluidDryTicks = FLOWING_FLUID_COLLISION_RECOVERY_TICKS;
  #contentRevision = 0;
  #massMoment: Vector3;
  #totalMass: number;

  constructor(
    body: PhysicsBody,
    blocks: readonly PhysicsContraptionBlock[],
    visuals: ContraptionRenderer,
    logicalColliderIndex: ContraptionColliderIndex,
    collisionProxy: ContraptionCollider,
    massMoment: Vector3,
    totalMass: number,
    runtimeRepresentation?: PhysicsContraptionRuntimeRepresentationFactory,
    runtimeRepresentationState?: PhysicsContraptionRuntimeRepresentationState,
    foliageTint?: PhysicsContraptionFoliageTint
  ) {
    this.body = body;
    this.foliageTint = foliageTint ? { ...foliageTint } : undefined;
    this.#blocks = [...blocks];
    this.#logicalColliderIndex = logicalColliderIndex;
    this.#collisionProxy = collisionProxy;
    this.#visuals = visuals;
    this.#runtimeRepresentation = runtimeRepresentation;
    this.#runtimeRepresentationState = runtimeRepresentationState;
    this.#totalMass = totalMass;
    this.#massMoment = { ...massMoment };
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      const key = contraptionBlockKey(block.localLocation);
      const packed = packLocalBlockKey(
        block.localLocation.x,
        block.localLocation.y,
        block.localLocation.z
      );
      this.#blocksByKey.set(key, block);
      this.#blocksByPackedKey.set(packed, block);
      this.#blockOrderByPackedKey.set(packed, index);
    }
    this.syncVisuals(true);
    if (this.#visuals.initialPoseDeferred) {
      system.run(() => {
        if (!this.isValid) return;
        // Publish readiness only after a full server tick has carried the real
        // transform to the client, so its first visible pose needs no interpolation.
        this.syncVisuals(true);
        this.#visuals.releaseInitialPose();
      });
    }
  }

  get blocks(): readonly PhysicsContraptionBlock[] { return this.#blocks; }
  get contentRevision(): number { return this.#contentRevision; }
  get id(): number { return this.body.id; }
  get isValid(): boolean { return this.body.isValid; }
  get visualEntityCount(): number {
    return this.#visuals.entityCount;
  }
  get supportsFragmentBlockPlacement(): boolean {
    return this.#visuals.supportsBlockAddition;
  }
  get visualEntityIds(): readonly string[] {
    return this.#visuals.entityIds;
  }
  get visualEntityLocations(): readonly Vector3[] {
    return this.#visuals.entityLocations;
  }
  get visualEntityLocation(): Vector3 | undefined {
    return this.#visuals.firstEntityLocation;
  }
  get visualRotation(): Readonly<Vector3> {
    return this.#visuals.visualRotation;
  }
  get outlineAnchorLocation(): Vector3 {
    return this.body.localPointToWorld(this.#visuals.visualAnchorLocal);
  }
  get outlineAnchorLocal(): Vector3 {
    return this.#visuals.visualAnchorLocal;
  }
  attachOutlineEntity(entity: Entity): boolean {
    return this.#visuals.attachAuxiliaryRider(entity);
  }
  detachOutlineEntity(entity: Entity): void {
    this.#visuals.detachAuxiliaryRider(entity);
  }
  attachPersistentEntity(entity: Entity): boolean {
    return this.#visuals.attachPersistentRider(entity);
  }
  detachPersistentEntity(entity: Entity, preserveEmptyCarrier = false): void {
    this.#visuals.detachPersistentRider(entity, preserveEmptyCarrier);
  }
  removeEmptyPersistentEntityCarriers(): void {
    this.#visuals.removeEmptyPersistentRiderCarriers();
  }
  setCubeBlockOpenState(location: Vector3, open: boolean): boolean {
    const key = contraptionBlockKey(location);
    const block = this.#blocksByKey.get(key);
    if (block?.visual?.renderer !== "cube_block_fragment") return false;
    if (!this.#visuals.setCubeBlockOpenState(key, open)) return false;
    if (open) this.#openCubeBlockKeys.add(key);
    else this.#openCubeBlockKeys.delete(key);
    return true;
  }
  setAttachmentBlockVisualState(location: Vector3, state: number): boolean {
    if (!Number.isInteger(state) || state < 0 || state > 15) {
      throw new RangeError(`Invalid attachment block visual state ${state}.`);
    }
    const key = contraptionBlockKey(location);
    const current = this.#blocksByKey.get(key);
    if (current?.visual?.renderer !== "attachment_fragment") return false;
    if (!this.#visuals.setAttachmentBlockVisualState(key, state)) return false;
    // All contraption indexes share this normalized block object, so changing
    // its visual descriptor keeps the array and both lookup maps coherent.
    current.visual.state = state;
    this.#contentRevision++;
    return true;
  }
  getBlockAtLocalLocation(location: Vector3): PhysicsContraptionBlock | undefined {
    if (!Number.isInteger(location.x) || !Number.isInteger(location.y) || !Number.isInteger(location.z)) {
      return undefined;
    }
    return this.#blocksByPackedKey.get(
      packLocalBlockKey(location.x, location.y, location.z)
    );
  }
  hasVisualEntity(entityId: string): boolean {
    return this.#visuals.hasEntity(entityId);
  }
  hasIntactVisualEntities(): boolean {
    return this.#visuals.hasIntactEntities();
  }
  hasKnownVisualIntegrityFailure(): boolean {
    return this.#visuals.hasKnownIntegrityFailure();
  }
  hasKnownCollisionIntegrityFailure(): boolean {
    return this.#collisionProxy.hasKnownIntegrityFailure;
  }

  getBlockAtWorldPoint(
    point: Vector3,
    maximumDistance = DEFAULT_BLOCK_LOOKUP_DISTANCE
  ): PhysicsContraptionBlock | undefined {
    const local = this.body.worldPointToLocal(point);
    if (
      !Number.isFinite(maximumDistance)
      || maximumDistance < 0
      || maximumDistance > BLOCK_LOOKUP_CELL_SCAN_MAX_DISTANCE
    ) {
      return findClosestContraptionBlock(this.#blocks, local, maximumDistance);
    }
    let closest: PhysicsContraptionBlock | undefined;
    let closestDistanceSquared = maximumDistance * maximumDistance;
    let closestOrder = -1;
    for (let y = Math.ceil(local.y - maximumDistance); y <= Math.floor(local.y + maximumDistance); y++) {
      for (let z = Math.ceil(local.z - maximumDistance); z <= Math.floor(local.z + maximumDistance); z++) {
        for (let x = Math.ceil(local.x - maximumDistance); x <= Math.floor(local.x + maximumDistance); x++) {
          const key = packLocalBlockKey(x, y, z);
          const block = this.#blocksByPackedKey.get(key);
          if (!block) continue;
          const dx = x - local.x;
          const dy = y - local.y;
          const dz = z - local.z;
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          // Both packed maps are populated and pruned together, so a block hit
          // guarantees an order entry.
          const order = this.#blockOrderByPackedKey.get(key)!;
          if (
            distanceSquared < closestDistanceSquared
            || (distanceSquared === closestDistanceSquared && order >= closestOrder)
          ) {
            closest = block;
            closestDistanceSquared = distanceSquared;
            closestOrder = order;
          }
        }
      }
    }
    return closest;
  }

  getBlocksInLocalBounds(min: Vector3, max: Vector3): readonly PhysicsContraptionBlock[] {
    if (!isFiniteVector(min) || !isFiniteVector(max)) return [];
    const startX = Math.ceil(Math.min(min.x, max.x) - 0.5);
    const startY = Math.ceil(Math.min(min.y, max.y) - 0.5);
    const startZ = Math.ceil(Math.min(min.z, max.z) - 0.5);
    const endX = Math.floor(Math.max(min.x, max.x) + 0.5);
    const endY = Math.floor(Math.max(min.y, max.y) + 0.5);
    const endZ = Math.floor(Math.max(min.z, max.z) + 0.5);
    if (startX > endX || startY > endY || startZ > endZ) return [];

    const spanX = endX - startX + 1;
    const spanY = endY - startY + 1;
    const spanZ = endZ - startZ + 1;
    const cellCount = spanX * spanY * spanZ;
    if (!Number.isSafeInteger(cellCount) || cellCount > 65_536) {
      return this.#blocks.filter(block => (
        block.localLocation.x >= startX
        && block.localLocation.x <= endX
        && block.localLocation.y >= startY
        && block.localLocation.y <= endY
        && block.localLocation.z >= startZ
        && block.localLocation.z <= endZ
      ));
    }

    const blocks: PhysicsContraptionBlock[] = [];
    for (let y = startY; y <= endY; y++) {
      for (let z = startZ; z <= endZ; z++) {
        for (let x = startX; x <= endX; x++) {
          const block = this.#blocksByPackedKey.get(packLocalBlockKey(x, y, z));
          if (block) blocks.push(block);
        }
      }
    }
    return blocks;
  }

  raycast(
    origin: Vector3,
    direction: Vector3,
    maximumDistance = Number.POSITIVE_INFINITY,
    options?: PhysicsContraptionRaycastOptions
  ): PhysicsContraptionRaycastHit | undefined {
    if (!this.body.isValid || !isFiniteVector(origin) || !isFiniteVector(direction)) {
      return undefined;
    }
    // Known inconsistency: this guard admits the Infinity default, but
    // raycastContraptionGrid below rejects non-finite distances, so an unbounded
    // ray always misses. Callers must pass a finite maximumDistance.
    if (Number.isNaN(maximumDistance) || maximumDistance < 0) return undefined;
    const directionLength = Math.hypot(direction.x, direction.y, direction.z);
    if (!Number.isFinite(directionLength) || directionLength < EPSILON_1E8) return undefined;
    const unitDirection = {
      x: direction.x / directionLength,
      y: direction.y / directionLength,
      z: direction.z / directionLength
    };
    const localOrigin = this.body.worldPointToLocal(origin);
    const localEnd = this.body.worldPointToLocal({
      x: origin.x + unitDirection.x,
      y: origin.y + unitDirection.y,
      z: origin.z + unitDirection.z
    });
    const localDirection = {
      x: localEnd.x - localOrigin.x,
      y: localEnd.y - localOrigin.y,
      z: localEnd.z - localOrigin.z
    };
    const blockAt = options?.ignorePassableBlocks
      ? (x: number, y: number, z: number) => {
          const block = this.#blocksByPackedKey.get(packLocalBlockKey(x, y, z));
        return block && isContraptionBlockRaySolid(block) ? block : undefined;
      }
      : (x: number, y: number, z: number) =>
        this.#blocksByPackedKey.get(packLocalBlockKey(x, y, z));
    const closest = raycastContraptionGrid(
      blockAt,
      localOrigin,
      localDirection,
      maximumDistance,
      { skipContainingCell: options?.skipContainingBlock }
    );
    if (!closest) return undefined;
    const location = {
      x: origin.x + unitDirection.x * closest.distance,
      y: origin.y + unitDirection.y * closest.distance,
      z: origin.z + unitDirection.z * closest.distance
    };
    const localLocation = {
      x: localOrigin.x + localDirection.x * closest.distance,
      y: localOrigin.y + localDirection.y * closest.distance,
      z: localOrigin.z + localDirection.z * closest.distance
    };
    const localZero = this.body.localPointToWorld({ x: 0, y: 0, z: 0 });
    const rotatedNormal = this.body.localPointToWorld(closest.localNormal);
    const normal = normalizeVector({
      x: rotatedNormal.x - localZero.x,
      y: rotatedNormal.y - localZero.y,
      z: rotatedNormal.z - localZero.z
    });
    return {
      block: closest.block,
      distance: closest.distance,
      face: closest.face,
      localLocation,
      localNormal: closest.localNormal,
      location,
      normal
    };
  }

  removeBlockAtLocalLocation(location: Vector3): PhysicsContraptionBlock | undefined {
    return this.removeBlocksAtLocalLocations([location])[0];
  }

  removeBlocksAtLocalLocations(locations: readonly Vector3[]): PhysicsContraptionBlock[] {
    const keys = new Set(locations.map(contraptionBlockKey));
    const removed = this.#blocks.filter(block => keys.has(contraptionBlockKey(block.localLocation)));
    if (removed.length === 0) return [];
    const removedKeys = new Set(removed.map(block => contraptionBlockKey(block.localLocation)));
    for (let index = this.#blocks.length - 1; index >= 0; index--) {
      if (removedKeys.has(contraptionBlockKey(this.#blocks[index]!.localLocation))) {
        this.#blocks.splice(index, 1);
      }
    }
    for (const key of removedKeys) {
      this.#blocksByKey.delete(key);
      this.#openCubeBlockKeys.delete(key);
    }
    for (const block of removed) {
      const packed = packLocalBlockKey(
        block.localLocation.x,
        block.localLocation.y,
        block.localLocation.z
      );
      this.#blocksByPackedKey.delete(packed);
      this.#blockOrderByPackedKey.delete(packed);
    }
    this.#contentRevision++;
    this.#visuals.removeBlocks(removedKeys);
    this.#visuals.rebaseVisualAnchor(this.#blocks);
    for (const key of this.#openCubeBlockKeys) {
      if (!this.#visuals.setCubeBlockOpenState(key, true)) {
        throw new Error(`Could not restore open cube state at ${key} after visual rebasing.`);
      }
    }
    if (this.#blocks.length === 0) {
      this.remove();
      return removed;
    }
    if (!this.#blocks.some(isContraptionBlockCollidable)) {
      this.remove();
      return removed;
    }
    this.#rebuildPhysicsRepresentation(
      removed,
      removed.some(block => block.runtimeCollidable !== false)
    );
    return removed;
  }

  /** Add ordinary Stage 2 blocks without changing the body's world transform. */
  addBlocksAtLocalLocations(blocks: readonly PhysicsContraptionBlock[]): void {
    if (!this.isValid || blocks.length === 0) return;
    if (!this.#visuals.supportsBlockAddition) {
      throw new Error("Stage 2 placement requires a fragment visual contraption.");
    }
    const normalized = normalizeContraptionBlocks(blocks);
    for (const block of normalized) {
      if (this.#blocksByKey.has(contraptionBlockKey(block.localLocation))) {
        throw new RangeError(
          `Contraption block location ${contraptionBlockKey(block.localLocation)} is already occupied.`
        );
      }
    }
    const previousCenterOfMass = this.body.getCenterOfMass();
    for (const block of normalized) {
      const packed = packLocalBlockKey(
        block.localLocation.x,
        block.localLocation.y,
        block.localLocation.z
      );
      this.#blocksByKey.set(contraptionBlockKey(block.localLocation), block);
      this.#blockOrderByPackedKey.set(packed, this.#blocks.length);
      this.#blocksByPackedKey.set(packed, block);
      this.#blocks.push(block);
      const mass = block.mass ?? DEFAULT_OTHER_BLOCK_MASS;
      this.#totalMass += mass;
      this.#massMoment.x += block.localLocation.x * mass;
      this.#massMoment.y += block.localLocation.y * mass;
      this.#massMoment.z += block.localLocation.z * mass;
    }
    const centerUpdate = this.#computeCenterOfMassUpdate(previousCenterOfMass);
    this.#contentRevision++;
    this.#logicalColliderIndex.addBlocks(normalized);
    const logicalCollider = this.#logicalColliderIndex.collider;
    const representation = this.#runtimeRepresentationState?.addBlocks?.(normalized)
      ?? this.#runtimeRepresentation?.(this.#blocks);
    this.#applyMassAndColliderUpdate(logicalCollider, representation, centerUpdate, true);
    this.#visuals.addBlocks(normalized);
    this.body.wakeUp();
  }

  /**
   * A rigid body's linear velocity belongs to its center of mass. Preserve
   * the old motion at the new center when an in-place edit moves that center.
   */
  #computeCenterOfMassUpdate(previousCenterOfMass: Vector3): {
    readonly nextCenterOfMass: Vector3;
    readonly nextCenterVelocity: Vector3 | undefined;
  } {
    const nextCenterOfMass = {
      x: this.#massMoment.x / this.#totalMass,
      y: this.#massMoment.y / this.#totalMass,
      z: this.#massMoment.z / this.#totalMass
    };
    const centerOfMassChanged = (
      nextCenterOfMass.x !== previousCenterOfMass.x
      || nextCenterOfMass.y !== previousCenterOfMass.y
      || nextCenterOfMass.z !== previousCenterOfMass.z
    );
    const nextCenterVelocity = centerOfMassChanged
      ? this.body.getVelocityAt(this.body.localPointToWorld(nextCenterOfMass))
      : undefined;
    return { nextCenterOfMass, nextCenterVelocity };
  }

  /** Shared block add/remove tail; the call order is load-bearing. */
  #applyMassAndColliderUpdate(
    logicalCollider: Extract<PhysicsBodyCollider, { type: "compound" }>,
    representation: PhysicsContraptionRuntimeRepresentation | undefined,
    centerUpdate: Readonly<{
      nextCenterOfMass: Vector3;
      nextCenterVelocity: Vector3 | undefined;
    }>,
    updateRuntimeCollider: boolean
  ): void {
    this.body.setEnvironmentCollider(logicalCollider);
    this.#collisionProxy.setCollider(logicalCollider);
    if (updateRuntimeCollider) {
      this.body.setColliderIncrementally(representation?.collider ?? logicalCollider);
    }
    this.body.setMass(this.#totalMass);
    this.body.setCenterOfMass(centerUpdate.nextCenterOfMass);
    if (centerUpdate.nextCenterVelocity) this.body.setVelocity(centerUpdate.nextCenterVelocity);
    this.body.setInertia(computeContraptionInertia(logicalCollider, this.#totalMass));
    this.body.setBuoyancyPoints(
      representation?.buoyancyPoints ?? createDefaultContraptionBuoyancyPoints(this.#blocks)
    );
  }

  #rebuildPhysicsRepresentation(
    removed: readonly PhysicsContraptionBlock[],
    runtimeColliderChanged: boolean
  ): void {
    this.#logicalColliderIndex.removeBlocks(removed);
    const logicalCollider = this.#logicalColliderIndex.collider;
    for (const block of removed) {
      const mass = block.mass ?? DEFAULT_OTHER_BLOCK_MASS;
      this.#totalMass -= mass;
      this.#massMoment.x -= block.localLocation.x * mass;
      this.#massMoment.y -= block.localLocation.y * mass;
      this.#massMoment.z -= block.localLocation.z * mass;
    }
    const previousCenterOfMass = this.body.getCenterOfMass();
    const centerUpdate = this.#computeCenterOfMassUpdate(previousCenterOfMass);
    const representation = this.#runtimeRepresentationState?.removeBlocks(removed)
      ?? this.#runtimeRepresentation?.(this.#blocks);
    this.#applyMassAndColliderUpdate(
      logicalCollider,
      representation,
      centerUpdate,
      !this.#runtimeRepresentation || runtimeColliderChanged
    );
  }

  remove(): void {
    this.#collisionProxy.dispose();
    this.#visuals.remove();
    this.#blocksByKey.clear();
    this.#blocksByPackedKey.clear();
    this.#blockOrderByPackedKey.clear();
    this.#openCubeBlockKeys.clear();
    this.#blocks.length = 0;
    if (this.body.isValid) this.body.remove();
  }

  syncVisuals(force = false): number {
    return this.#visuals.sync(force);
  }

  syncCollision(
    snapshotIndex: ContraptionCollisionSnapshotIndex,
    collisionShell: ObbCollisionShell,
    enabled: boolean,
    surfaceMotionEnabled: boolean,
    surfaceContactCallback?: PhysicsSurfaceContactCallback
  ): void {
    if (this.body.isInNativeFlowingFluid) {
      this.#flowingFluidDryTicks = 0;
    } else if (this.#flowingFluidDryTicks < FLOWING_FLUID_COLLISION_RECOVERY_TICKS) {
      this.#flowingFluidDryTicks++;
    }
    // Flowing native fluids can move collidable entities independently of the rigid body.
    // Disable the whole tree immediately, then require a stable dry interval before rebuilding it.
    const flowingFluidCollisionAllowed = this.#flowingFluidDryTicks
      >= FLOWING_FLUID_COLLISION_RECOVERY_TICKS;
    this.#collisionProxy.sync(
      snapshotIndex,
      collisionShell,
      enabled && flowingFluidCollisionAllowed,
      surfaceMotionEnabled,
      surfaceContactCallback
        ? (
          entity,
          location,
          relativePosition,
          playerPosition,
          playerVelocity,
          surfaceVelocity
        ) => {
          const block = this.getBlockAtWorldPoint(location);
          surfaceContactCallback(
            entity,
            location,
            relativePosition,
            playerPosition,
            this.id,
            block,
            playerVelocity,
            surfaceVelocity
          );
        }
        : undefined
    );
  }
}

export class PhysicsDimension {
  readonly dimension: Dimension;
  readonly id: string;
  readonly #assemblies = new Map<number, PhysicsContraption>();
  readonly #contraptionSpatialIndex = new ContraptionSpatialIndex<PhysicsContraption>();
  readonly #contraptionByVisualEntityId = new Map<string, PhysicsContraption>();
  readonly #bodies = new Map<number, PhysicsBody>();
  readonly #footstepContacts = new Map<string, FootstepContact>();
  readonly #footstepStates = new Map<string, FootstepState>();
  readonly #landingApproaches = new Map<string, LandingApproachState>();
  readonly #mountObb: MountObb;
  readonly #spatiallyActiveContraptionIds = new Set<number>();
  #contraptionRaycastRevision = 0;
  readonly #recordSurfaceContact: PhysicsSurfaceContactCallback = (
    entity,
    location,
    relativePosition,
    playerPosition,
    contraptionId,
    block,
    playerVelocity,
    surfaceVelocity,
    surfaceState
  ) => {
    if (!entity.isValid) return;
    const contraption = this.#assemblies.get(contraptionId);
    if (!contraption) {
      throw new Error(`Surface contact references unknown contraption ${contraptionId}.`);
    }
    const grounded = surfaceState?.grounded ?? entity.isOnGround;
    const dx = location.x - playerPosition.x;
    const dy = location.y - playerPosition.y;
    const dz = location.z - playerPosition.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const existing = this.#footstepContacts.get(entity.id);
    if (!existing || distanceSquared < existing.distanceSquared) {
      this.#footstepContacts.set(entity.id, {
        block,
        blockTypeId: block?.typeId,
        distanceSquared,
        entity,
        grounded,
        jumped: surfaceState?.jumped ?? false,
        landingDownwardSpeed: surfaceState?.landingDownwardSpeed,
        location: { ...location },
        mountContact: surfaceState !== undefined,
        playerVelocity: { ...playerVelocity },
        relativePosition: { ...relativePosition },
        sprinting: surfaceState?.sprinting,
        supportLocal: contraption.body.worldPointToLocal(location),
        surfaceVelocity: { ...surfaceVelocity },
        contraptionId
      });
    }
  };
  readonly #runtime: CannonKernelRuntime;
  readonly #world: PhysicsWorld;

  constructor(worldInstance: PhysicsWorld, dimension: Dimension | string) {
    this.#world = worldInstance;
    this.dimension = typeof dimension === "string" ? world.getDimension(dimension) : dimension;
    this.#mountObb = new MountObb(
      this.dimension,
      (location, radius) => this.getContraptionCandidatesNear(location, radius),
      block => this.getBlockProperties(block),
      playerId => this.#landingApproaches.get(playerId)?.feetY,
      this.#recordSurfaceContact
    );
    this.id = this.dimension.id;
    this.#runtime = new CannonKernelRuntime(worldInstance[GET_SIMULATION_OPTIONS]());
    this.#runtime.afterEvents.collision.subscribe(event => this.#emitCollision(event));
    this.#runtime.afterEvents.lavaEntry.subscribe(event =>
      this.#emitFluidEntry(event, payload => this.#world.emitLavaEntry(payload))
    );
    this.#runtime.afterEvents.waterEntry.subscribe(event =>
      this.#emitFluidEntry(event, payload => this.#world.emitWaterEntry(payload))
    );
  }

  get fixedTimeStep(): number {
    return this.#runtime.fixedTimeStep;
  }

  get contraptionRaycastRevision(): number {
    return this.#contraptionRaycastRevision;
  }

  [CONFIGURE_SIMULATION](): void {
    this.#runtime.configure(this.#world[GET_SIMULATION_OPTIONS]());
  }

  createBody(options: PhysicsBodyOptions): PhysicsBody {
    const kernelBody = this.#runtime.createBody(this.dimension, options, this.#world.nextBodyId());
    const body = new PhysicsBody(
      this,
      kernelBody,
      options.name,
      () => this[UPDATE_CONTRAPTION_SPATIAL_INDEX](kernelBody.id),
      () => this[REMOVE_CONTRAPTION_FROM_SPATIAL_INDEX](kernelBody.id)
    );
    this.#bodies.set(body.id, body);
    return body;
  }

  createContraption(options: PhysicsContraptionOptions): PhysicsContraption {
    const blocks = normalizeContraptionBlocks(options.blocks);
    const foliageTint = normalizeContraptionFoliageTint(options.foliageTint);
    const visualEntityTags = normalizeVisualEntityTags(options.visualEntityTags);
    const logicalColliderIndex = new ContraptionColliderIndex(blocks);
    const logicalCollider = logicalColliderIndex.collider;
    const runtimeRepresentationState = options.runtimeRepresentation
      ?.createIncrementalState?.(blocks);
    const runtimeRepresentation = runtimeRepresentationState?.representation
      ?? options.runtimeRepresentation?.(blocks);
    const massProperties = computeContraptionMassProperties(blocks);
    const mass = massProperties.mass;

    const body = this.createBody({
      allowSleep: options.allowSleep,
      angularDamping: options.angularDamping,
      angularVelocity: options.angularVelocity,
      buoyancyPoints: runtimeRepresentation?.buoyancyPoints
        ?? createDefaultContraptionBuoyancyPoints(blocks),
      collider: runtimeRepresentation?.collider ?? logicalCollider,
      environmentCollider: logicalCollider,
      linearDamping: options.linearDamping,
      location: options.location,
      mass,
      name: options.name,
      rotation: options.rotation,
      velocity: options.velocity,
      visual: false
    });
    body.setCenterOfMass({
      x: massProperties.moment.x / mass,
      y: massProperties.moment.y / mass,
      z: massProperties.moment.z / mass
    });
    body.setInertia(computeContraptionInertia(logicalCollider, mass));
    const visualAnchor = selectContraptionVisualAnchor(blocks);

    let contraption: PhysicsContraption | undefined;
    let visuals: ContraptionRenderer | undefined;
    let collisionProxy: ContraptionCollider | undefined;
    try {
      collisionProxy = new ContraptionCollider(
        body,
        logicalCollider,
        this.#world[GET_PLAYER_COLLISION_ENABLED]()
          && (!this.#world[GET_PLAYER_MOUNT_ENABLED]() || body.isSleeping)
      );
      visuals = tryCreateFragmentRenderer(
        body,
        blocks,
        (typeId, location) => spawnTaggedVisualEntity(
          this.dimension,
          typeId,
          location,
          visualEntityTags
        ),
        foliageTint,
        entityId => this.#contraptionByVisualEntityId.delete(entityId),
        visualAnchor,
        entityId => {
          if (contraption) this.#contraptionByVisualEntityId.set(entityId, contraption);
        }
      );
      if (!visuals) {
        // A mixed renderer keeps unsupported blocks on hand-item entities and
        // routes known cube blocks through their packed animated fragment.
        const cubeFragmentBlocks = blocks.filter(
          block => block.visual?.renderer === "cube_block_fragment"
        );
        const blockVisualBlocks = blocks.filter(
          block => block.visual?.renderer !== "cube_block_fragment"
        );
        assertBlockVisualItems(blockVisualBlocks);
        const entities: Entity[] = [];
        const assignments: BlockAssignment[] = [];
        const carriers: Array<{ entity: Entity; riderIds: string[] }> = [];
        try {
          // Each rider displays two independently transformed hand items. One
          // seat remains reserved for the shared contraption outline rider.
          const visualEntityCount = Math.ceil(
            blockVisualBlocks.length / BLOCK_SLOTS_PER_ENTITY
          );
          for (
            let start = 0;
            start < visualEntityCount;
            start += BLOCK_CARRIER_CAPACITY
          ) {
            const carrierEntity = spawnTaggedVisualEntity(
              this.dimension,
              BLOCK_CARRIER_ENTITY_TYPE_ID,
              body.localPointToWorld(visualAnchor),
              visualEntityTags
            );
            const rideable = carrierEntity.getComponent("minecraft:rideable");
            if (!rideable) {
              throw new Error("Per-block visual carrier does not expose minecraft:rideable.");
            }
            const carrier = { entity: carrierEntity, riderIds: [] as string[] };
            carriers.push(carrier);
            const end = Math.min(
              visualEntityCount,
              start + BLOCK_CARRIER_CAPACITY
            );
            for (let visualIndex = start; visualIndex < end; visualIndex++) {
              const blockIndex = visualIndex * BLOCK_SLOTS_PER_ENTITY;
              const mainhandBlock = blockVisualBlocks[blockIndex]!;
              const offhandBlock = blockVisualBlocks[blockIndex + 1];
              const entity = createBlockVisualPair(
                this.dimension,
                body,
                visualAnchor,
                mainhandBlock,
                offhandBlock,
                visualEntityTags
              );
              entities.push(entity);
              assignments.push({ block: mainhandBlock, entity, slot: "mainhand" });
              if (offhandBlock) {
                assignments.push({ block: offhandBlock, entity, slot: "offhand" });
              }
              if (!rideable.addRider(entity)) {
                throw new Error(
                  `Could not mount block visual ${entity.id} on carrier ${carrierEntity.id}.`
                );
              }
              carrier.riderIds.push(entity.id);
            }
          }
        } catch (error) {
          for (const entity of entities) {
            if (entity.isValid) entity.remove();
          }
          for (const carrier of carriers) {
            if (carrier.entity.isValid) carrier.entity.remove();
          }
          throw error;
        }
        visuals = createBlockRenderer(
          body,
          assignments,
          carriers,
          entityId => this.#contraptionByVisualEntityId.delete(entityId),
          visualAnchor,
          (typeId, location) => spawnTaggedVisualEntity(
            this.dimension,
            typeId,
            location,
            visualEntityTags
          ),
          foliageTint ?? DEFAULT_CONTRAPTION_FOLIAGE_TINT,
          entityId => {
            if (contraption) this.#contraptionByVisualEntityId.set(entityId, contraption);
          },
          cubeFragmentBlocks
        );
      }
      contraption = new PhysicsContraption(
        body,
        blocks,
        visuals,
        logicalColliderIndex,
        collisionProxy,
        massProperties.moment,
        mass,
        options.runtimeRepresentation,
        runtimeRepresentationState,
        foliageTint
      );
      this.#assemblies.set(contraption.id, contraption);
      this.#contraptionSpatialIndex.update(contraption);
      this.#contraptionRaycastRevision++;
      if (contraption.body.isActive) this.#spatiallyActiveContraptionIds.add(contraption.id);
      for (const entityId of contraption.visualEntityIds) {
        this.#contraptionByVisualEntityId.set(entityId, contraption);
      }
      return contraption;
    } catch (error) {
      collisionProxy?.dispose();
      visuals?.remove();
      body.remove();
      throw error;
    }
  }

  getAssemblies(): readonly PhysicsContraption[] {
    this.#pruneInvalid();
    return [...this.#assemblies.values()];
  }

  getContraptionRaycastCandidates(
    origin: Vector3,
    direction: Vector3,
    maximumDistance: number
  ): readonly PhysicsContraption[] {
    this.#pruneInvalid();
    return this.#contraptionSpatialIndex.queryRay(origin, direction, maximumDistance);
  }

  getContraptionCandidatesNear(
    location: Vector3,
    radius: number
  ): readonly PhysicsContraption[] {
    return this.#contraptionSpatialIndex.queryAabb({
      min: {
        x: location.x - radius,
        y: location.y - radius,
        z: location.z - radius
      },
      max: {
        x: location.x + radius,
        y: location.y + radius,
        z: location.z + radius
      }
    });
  }

  hasAssemblies(): boolean {
    this.#pruneInvalid();
    return this.#assemblies.size > 0;
  }

  getContraptionById(id: number): PhysicsContraption | undefined {
    this.#pruneInvalid();
    return this.#assemblies.get(id);
  }

  getContraptionByVisualEntityId(entityId: string): PhysicsContraption | undefined {
    const contraption = this.#contraptionByVisualEntityId.get(entityId);
    if (!contraption || !contraption.isValid || !contraption.hasVisualEntity(entityId)) {
      this.#contraptionByVisualEntityId.delete(entityId);
      return undefined;
    }
    return contraption;
  }

  getBodies(): readonly PhysicsBody[] {
    this.#pruneInvalid();
    return [...this.#bodies.values()];
  }

  getBodyById(id: number): PhysicsBody | undefined {
    const body = this.#bodies.get(id);
    if (body && !body.isValid) {
      this.#bodies.delete(id);
      return undefined;
    }
    return body;
  }

  getBlockProperties(block: { typeId?: string } | string): PhysicsBlockProperties {
    return this.#runtime.getBlockProperties(block);
  }

  setBlockProperties(block: { typeId?: string } | string, properties: PhysicsBlockProperties): void {
    this.#runtime.setBlockProperties(block, properties);
  }

  setBlockPropertiesBatch(
    entries: readonly (readonly [block: { typeId?: string } | string, properties: PhysicsBlockProperties])[]
  ): void {
    this.#runtime.setBlockPropertiesBatch(entries);
  }

  isWorldBlockSensor(block: Block): boolean {
    return this.#runtime.isWorldBlockSensor(block);
  }

  setWorldBlockSensorPredicate(predicate?: (block: Block) => boolean): void {
    this.#runtime.setWorldBlockSensorPredicate(predicate);
  }

  addBeforeSubstepCallback(callback: () => void): () => void {
    return this.#runtime.addBeforeSubstepCallback(callback);
  }

  getMaterialProperties(material: string): PhysicsContactMaterialProperties {
    return this.#runtime.getMaterialProperties(material);
  }

  setMaterialProperties(material: string, properties: PhysicsContactMaterialProperties): void {
    this.#runtime.setMaterialProperties(material, properties);
  }

  wakeBodiesNear(location: Vector3, radius = 1): number {
    return this.#runtime.wakeBodiesNear(this.dimension, location, radius);
  }

  invalidateWorldMesh(location: Vector3, radius = 0): void {
    this.#runtime.invalidateWorldMesh(this.dimension, location, radius);
  }

  invalidateWorldMeshBatch(locations: readonly Vector3[]): void {
    this.#runtime.invalidateWorldMeshBatch(this.dimension, locations);
  }

  [GET_WORLD_MESH_AUDIT_CANDIDATE](): CannonWorldMeshAuditCandidate | undefined {
    return this.#runtime.getWorldMeshAuditCandidate();
  }

  [HAS_PENDING_WORLD_MESH_BUILDS](): boolean {
    return this.#runtime.hasPendingWorldMeshBuilds();
  }

  step(): void {
    this.#runtime.step();
    this.#pruneInvalid();
    const playerCollisionEnabled = this.#world[GET_PLAYER_COLLISION_ENABLED]();
    const playerMountEnabled = this.#world[GET_PLAYER_MOUNT_ENABLED]();
    const playerSnapshots = (playerCollisionEnabled || playerMountEnabled)
      && this.#assemblies.size > 0
      ? createContraptionCollisionEntitySnapshots(this.dimension.getPlayers())
      : [];
    const groundedHandOffs = playerMountEnabled
      ? new Map(
        Array.from(this.#footstepContacts)
          .flatMap(([entityId, contact]) => contact.grounded
            && !contact.mountContact
            && this.#assemblies.get(contact.contraptionId)?.body.isSleeping === false
            ? [[entityId, {
              contraptionId: contact.contraptionId,
              supportLocal: contact.supportLocal
            }] as const]
            : [])
      )
      : undefined;
    const collisionSnapshotIndex = new ContraptionCollisionSnapshotIndex(
      playerCollisionEnabled ? playerSnapshots : []
    );
    const collisionShell = this.#world[GET_COLLISION_SHELL]();
    // Both OBB implementations share the gameplay carrying setting: Solid uses
    // surface motion while Mount adds the transported support-point displacement.
    const playerCarryingEnabled = this.#world[GET_PLAYER_CARRYING_ENABLED]();
    let contraptionTransformChanged = false;
    this.#footstepContacts.clear();
    for (const contraption of this.#assemblies.values()) {
      const wasSpatiallyActive = this.#spatiallyActiveContraptionIds.has(contraption.id);
      const isSpatiallyActive = contraption.body.isActive;
      if (isSpatiallyActive) this.#spatiallyActiveContraptionIds.add(contraption.id);
      else this.#spatiallyActiveContraptionIds.delete(contraption.id);
      if (isSpatiallyActive || wasSpatiallyActive) {
        this.#contraptionSpatialIndex.update(contraption);
        contraptionTransformChanged = true;
      }
      // Smooth moving collision replaces only non-sleeping structures; sleeping
      // structures retain the selected low- or high-quality Solid shell.
      const solidCollisionEnabled = playerCollisionEnabled
        && (!playerMountEnabled || contraption.body.isSleeping);
      contraption.syncCollision(
        collisionSnapshotIndex,
        collisionShell,
        solidCollisionEnabled,
        playerCarryingEnabled,
        solidCollisionEnabled && playerSnapshots.length > 0
          ? this.#recordSurfaceContact
          : undefined
      );
      contraption.syncVisuals();
    }
    this.#mountObb.tick(
      playerMountEnabled && this.#assemblies.size > 0,
      playerCarryingEnabled,
      groundedHandOffs
    );
    // Ray results depend on precise transforms, not only coarse spatial-cell
    // membership. Collapse all motion during this physics step into one revision.
    if (contraptionTransformChanged) this.#contraptionRaycastRevision++;
    this.#emitSurfaceContactEffects();
    this.#recordLandingApproaches(playerSnapshots);
  }

  releasePlayerMount(playerId: string): void {
    this.#mountObb.releasePlayer(playerId);
  }

  disposePlayerMounts(): void {
    this.#mountObb.dispose();
  }

  /** Plays sparse surface events from the existing player-support contact pass. */
  #emitSurfaceContactEffects(): void {
    const currentTick = system.currentTick;
    for (const contact of this.#footstepContacts.values()) {
      if (!contact.entity.isValid) continue;
      const previous = this.#footstepStates.get(contact.entity.id);
      const state = previous
        && previous.contraptionId === contact.contraptionId
        && currentTick - previous.lastContactTick <= FOOTSTEP_CONTACT_RETENTION_TICKS
        ? previous
        : {
          distance: 0,
          lastContactTick: currentTick,
          lastJumpPressed: false,
          lastPosition: { ...contact.relativePosition },
          lastSprintParticleTick: currentTick - SPRINT_PARTICLE_INTERVAL_TICKS,
          contraptionId: contact.contraptionId
        };
      const beganContact = state !== previous;
      if (beganContact) {
        this.#footstepStates.set(contact.entity.id, state);
      } else {
        const delta = Math.hypot(
          contact.relativePosition.x - state.lastPosition.x,
          contact.relativePosition.y - state.lastPosition.y,
          contact.relativePosition.z - state.lastPosition.z
        );
        if (Number.isFinite(delta) && delta <= FOOTSTEP_MAX_DELTA) {
          state.distance += delta;
        } else {
          state.distance = 0;
        }
      }
      state.lastPosition = { ...contact.relativePosition };
      state.lastContactTick = currentTick;
      const jumpPressed = isJumpPressed(contact.entity);
      if (contact.jumped
        || (!beganContact && contact.grounded && jumpPressed && !state.lastJumpPressed)) {
        this.#emitSurfaceSound(contact, resolveVanillaBlockJumpSound(contact.blockTypeId));
      }
      state.lastJumpPressed = jumpPressed;
      const landingApproach = this.#landingApproaches.get(contact.entity.id);
      const landingDownwardSpeed = landingApproach?.downwardSpeed
        ?? contact.landingDownwardSpeed;
      if (landingDownwardSpeed !== undefined && contact.grounded) {
        this.#landingApproaches.delete(contact.entity.id);
        this.#emitLandingEffects(contact, landingDownwardSpeed);
      }
      this.#emitSprintingParticle(contact, state, currentTick);
      if (beganContact) continue;
      if (state.distance < FOOTSTEP_DISTANCE) continue;
      state.distance -= FOOTSTEP_DISTANCE;
      this.#emitSurfaceSound(contact, resolveVanillaBlockStepSound(contact.blockTypeId));
    }
    for (const [entityId, state] of this.#footstepStates) {
      if (currentTick - state.lastContactTick > FOOTSTEP_CONTACT_RETENTION_TICKS) {
        this.#footstepStates.delete(entityId);
      }
    }
    for (const [entityId, state] of this.#landingApproaches) {
      if (currentTick - state.lastSampleTick > LANDING_APPROACH_RETENTION_TICKS) {
        this.#landingApproaches.delete(entityId);
      }
    }
  }

  /** Retains the last airborne speed until the following grounded contact pass. */
  #recordLandingApproaches(snapshots: readonly ObbEntitySnapshot[]): void {
    const currentTick = system.currentTick;
    for (const snapshot of snapshots) {
      if (this.#footstepContacts.get(snapshot.entity.id)?.grounded) {
        this.#landingApproaches.delete(snapshot.entity.id);
        continue;
      }
      if (!snapshot.entity.isOnGround && snapshot.velocity.y < 0) {
        this.#landingApproaches.set(snapshot.entity.id, {
          downwardSpeed: -snapshot.velocity.y,
          feetY: snapshot.aabb.center.y - snapshot.aabb.extent.y,
          lastSampleTick: currentTick
        });
      } else {
        this.#landingApproaches.delete(snapshot.entity.id);
      }
    }
  }

  #emitSurfaceSound(contact: FootstepContact, sound: VanillaBlockSoundEvent): void {
    if (contact.entity.typeId !== "minecraft:player") return;
    this.dimension.playSound(sound.sound, contact.location, {
      pitch: sound.pitch,
      volume: sound.volume
    });
  }

  /** Plays the vanilla land event, or fall plus particles for hard landings. */
  #emitLandingEffects(contact: FootstepContact, downwardSpeed: number): void {
    const fallDistance = estimatePlayerFallDistance(downwardSpeed);
    if (fallDistance > SAFE_FALL_DISTANCE) {
      this.#emitSurfaceSound(contact, resolveVanillaBlockFallSound(contact.blockTypeId));
      this.#emitLandingParticles(contact, fallDistance);
      return;
    }
    this.#emitSurfaceSound(contact, resolveVanillaBlockLandSound(contact.blockTypeId));
  }

  /** Emits a compensated burst every three supported sprinting ticks. */
  #emitSprintingParticle(
    contact: FootstepContact,
    state: FootstepState,
    currentTick: number
  ): void {
    if (!contact.block || contact.entity.typeId !== "minecraft:player") return;
    const player = contact.entity as Player;
    const sprinting = contact.sprinting ?? player.isSprinting;
    if (!contact.grounded || !sprinting || player.isSneaking || player.isInWater) return;
    const relativeVelocity = {
      x: contact.playerVelocity.x - contact.surfaceVelocity.x,
      y: contact.playerVelocity.y - contact.surfaceVelocity.y,
      z: contact.playerVelocity.z - contact.surfaceVelocity.z
    };
    if (
      Math.hypot(relativeVelocity.x, relativeVelocity.z) <= SPRINT_PARTICLE_MIN_RELATIVE_SPEED
    ) return;
    if (currentTick - state.lastSprintParticleTick < SPRINT_PARTICLE_INTERVAL_TICKS) return;
    state.lastSprintParticleTick = currentTick;
    this.#world.emitSurfaceParticle({
      contraptionId: contact.contraptionId,
      block: contact.block,
      dimension: this.dimension,
      location: {
        x: contact.location.x,
        y: contact.location.y + SPRINT_PARTICLE_SURFACE_OFFSET_Y,
        z: contact.location.z
      },
      profile: {
        direction: {
          x: relativeVelocity.x * SPRINT_PARTICLE_VELOCITY_SCALE,
          y: SPRINT_PARTICLE_UPWARD_DIRECTION,
          z: relativeVelocity.z * SPRINT_PARTICLE_VELOCITY_SCALE
        },
        directionRandomness: {
          x: SPRINT_PARTICLE_DIRECTION_RANDOMNESS,
          y: SPRINT_PARTICLE_DIRECTION_RANDOMNESS,
          z: SPRINT_PARTICLE_DIRECTION_RANDOMNESS
        },
        offsetRadius: {
          x: SPRINT_PARTICLE_HORIZONTAL_RADIUS,
          y: SPRINT_PARTICLE_VERTICAL_RADIUS,
          z: SPRINT_PARTICLE_HORIZONTAL_RADIUS
        },
        particleCount: SPRINT_PARTICLE_COUNT,
        speedMax: SPRINT_PARTICLE_SPEED_MAX,
        speedMin: SPRINT_PARTICLE_SPEED_MIN
      }
    });
  }

  /** Emits one bounded burst when a player first lands hard on a contraption. */
  #emitLandingParticles(contact: FootstepContact, fallDistance: number): void {
    if (!contact.block || contact.entity.typeId !== "minecraft:player") return;
    const excess = Math.ceil(fallDistance - SAFE_FALL_DISTANCE);
    const strength = Math.min(
      LANDING_STRENGTH_BASE + excess / LANDING_STRENGTH_EXCESS_DIVISOR,
      LANDING_STRENGTH_MAX
    );
    const particleCount = Math.min(
      MAX_LANDING_PARTICLES,
      Math.floor(LANDING_PARTICLES_PER_STRENGTH * strength)
    );
    this.#world.emitSurfaceParticle({
      contraptionId: contact.contraptionId,
      block: contact.block,
      dimension: this.dimension,
      location: {
        x: contact.location.x,
        y: contact.location.y + LANDING_PARTICLE_SURFACE_OFFSET_Y,
        z: contact.location.z
      },
      profile: {
        direction: { x: 0, y: LANDING_PARTICLE_UPWARD_DIRECTION, z: 0 },
        directionRandomness: { x: 1, y: 1, z: 1 },
        offsetRadius: { x: 0, y: 0, z: 0 },
        particleCount,
        speedMax: SPRINT_PARTICLE_SPEED_MAX,
        speedMin: SPRINT_PARTICLE_SPEED_MIN
      }
    });
  }

  #emitCollision(event: CannonKernelCollisionAfterEvent): void {
    const body = this.getBodyById(event.body.id);
    if (!body) return;
    const physicsEvent: PhysicsCollisionAfterEvent = {
      body,
      collisionTag: event.collisionTag,
      currentTick: event.currentTick,
      impactSpeed: event.impactSpeed,
      normal: event.normal,
      otherBody: event.otherBody ? this.getBodyById(event.otherBody.id) : undefined,
      otherCollisionTag: event.otherCollisionTag,
      point: event.point
    };
    if (event.indexedWorldSensorHits) {
      attachIndexedWorldSensorHits(physicsEvent, event.indexedWorldSensorHits);
    }
    this.#world.emitCollision(physicsEvent);
  }

  // Water and lava entries share one payload shape; only the emit target differs.
  #emitFluidEntry(
    event: CannonKernelWaterEntryAfterEvent | CannonKernelLavaEntryAfterEvent,
    emit: (event: PhysicsWaterEntryAfterEvent) => void
  ): void {
    const body = this.getBodyById(event.body.id);
    if (!body) return;
    emit({
      body,
      bodyAabbSizeX: event.bodyAabbSizeX,
      bodyAabbSizeZ: event.bodyAabbSizeZ,
      fastestContactVelocityY: event.fastestContactVelocityY,
      maxContactX: event.maxContactX,
      maxContactZ: event.maxContactZ,
      minContactX: event.minContactX,
      minContactZ: event.minContactZ,
      point: event.point,
      timeStep: event.timeStep
    });
  }

  #pruneInvalid(): void {
    for (const [id, contraption] of this.#assemblies) {
      if (!contraption.isValid) {
        contraption.remove();
        this.#assemblies.delete(id);
        this.#contraptionSpatialIndex.remove(id);
        this.#spatiallyActiveContraptionIds.delete(id);
      }
    }
    for (const [id, body] of this.#bodies) {
      if (!body.isValid) this.#bodies.delete(id);
    }
  }

  [UPDATE_CONTRAPTION_SPATIAL_INDEX](bodyId: number): void {
    const contraption = this.#assemblies.get(bodyId);
    if (!contraption?.isValid) return;
    this.#contraptionSpatialIndex.update(contraption);
    this.#contraptionRaycastRevision++;
  }

  [REMOVE_CONTRAPTION_FROM_SPATIAL_INDEX](bodyId: number): void {
    if (this.#assemblies.has(bodyId)) this.#contraptionRaycastRevision++;
    this.#contraptionSpatialIndex.remove(bodyId);
    this.#spatiallyActiveContraptionIds.delete(bodyId);
  }
}

export class PhysicsWorld {
  readonly afterEvents = new PhysicsWorldAfterEvents();
  readonly #dimensions = new Map<string, PhysicsDimension>();
  #angularDamping = 0.09;
  #fixedTimeStep = 1 / 20;
  #gravity: Vector3 = { x: 0, y: -11, z: 0 };
  #linearDamping = 0.09;
  #nextBodyId = 1;
  #performanceLevel: TreePhysicsPerformanceLevel | undefined;
  #performanceLevelProvider: (() => TreePhysicsPerformanceLevel) | undefined;
  #collisionShellProvider: (() => ObbCollisionShell) | undefined;
  #playerCollisionEnabledProvider: (() => boolean) | undefined;
  #playerCarryingEnabledProvider: (() => boolean) | undefined;
  #playerMountEnabledProvider: (() => boolean) | undefined;
  #runId: number | undefined;
  #running = false;
  #stepCount = 0;
  #worldMeshAuditDimensionCursor = 0;
  readonly #worldMeshAuditCoordinator: CannonWorldMeshAuditCoordinator = {
    currentTick: 0,
    lastAuditTick: -WORLD_MESH_AUDIT_INTERVAL_TICKS,
    nextSelectionTick: 0
  };

  [GET_SIMULATION_OPTIONS]() {
    const highPerformance = (this.#performanceLevel ?? this.#readPerformanceLevel())
      === TREE_PHYSICS_PERFORMANCE_HIGH;
    return {
      angularDamping: this.#angularDamping,
      fixedTimeStep: highPerformance ? this.#fixedTimeStep / 3 : this.#fixedTimeStep,
      gravity: this.#gravity,
      linearDamping: this.#linearDamping,
      tickSteps: highPerformance ? 3 : 1,
      worldMeshAuditCoordinator: this.#worldMeshAuditCoordinator,
      worldMeshCache: true,
      worldMeshWaitForMissingChunks: !highPerformance
    };
  }

  getDimension(dimension: Dimension | string): PhysicsDimension {
    const id = typeof dimension === "string" ? dimension : dimension.id;
    let result = this.#dimensions.get(id);
    if (!result) {
      result = new PhysicsDimension(this, dimension);
      this.#dimensions.set(id, result);
    }
    return result;
  }

  getExistingDimension(dimension: Dimension | string): PhysicsDimension | undefined {
    const id = typeof dimension === "string" ? dimension : dimension.id;
    return this.#dimensions.get(id);
  }

  getDimensions(): readonly PhysicsDimension[] { return [...this.#dimensions.values()]; }
  nextBodyId(): number { return this.#nextBodyId++; }

  getStats(): PhysicsWorldStats {
    const bodies = this.getDimensions().flatMap(dimension => dimension.getBodies());
    return {
      activeBodyCount: bodies.filter(body => body.isActive).length,
      bodyCount: bodies.length,
      fixedTimeStep: this.#fixedTimeStep,
      running: this.#running,
      sleepingBodyCount: bodies.filter(body => body.isSleeping).length,
      stepCount: this.#stepCount
    };
  }

  start(options?: PhysicsWorldOptions): void {
    if (this.#running) return;
    this.#fixedTimeStep = options?.fixedTimeStep ?? this.#fixedTimeStep;
    this.#gravity = options?.gravity ?? this.#gravity;
    this.#linearDamping = options?.linearDamping ?? this.#linearDamping;
    this.#angularDamping = options?.angularDamping ?? this.#angularDamping;
    this.#applyPerformanceLevel(true);
    this.#running = true;
    // Dimension access is unavailable during early-execution. Defer cleanup
    // until the first ordinary script tick without delaying physics startup.
    system.run(() => {
      if (!this.#running) return;
      removeStaleContraptionColliders();
      removeStaleContraptionMounts();
    });
    this.#runId = system.runInterval(() => this.step(), 1);
  }

  [GET_COLLISION_SHELL](): ObbCollisionShell {
    return this.#collisionShellProvider?.() ?? "solid";
  }

  [GET_PLAYER_COLLISION_ENABLED](): boolean {
    return this.#playerCollisionEnabledProvider?.() ?? true;
  }

  [GET_PLAYER_CARRYING_ENABLED](): boolean {
    return this.#playerCarryingEnabledProvider?.() ?? true;
  }

  [GET_PLAYER_MOUNT_ENABLED](): boolean {
    return this.#playerMountEnabledProvider?.() ?? false;
  }

  stop(): void {
    if (this.#runId !== undefined) system.clearRun(this.#runId);
    this.#runId = undefined;
    this.#running = false;
    for (const dimension of this.#dimensions.values()) dimension.disposePlayerMounts();
  }

  handleMountPlayerSpawn(player: Player): void {
    for (const dimension of this.#dimensions.values()) {
      dimension.releasePlayerMount(player.id);
    }
    restoreStaleMountPlayerInput(player);
  }

  step(): void {
    this.#applyPerformanceLevel();
    this.#worldMeshAuditCoordinator.currentTick = this.#stepCount;
    const target = this.#selectWorldMeshAuditTarget();
    this.#worldMeshAuditCoordinator.targetDimensionId = target?.dimensionId;
    this.#worldMeshAuditCoordinator.targetChunkKey = target?.chunkKey;
    for (const dimension of this.#dimensions.values()) dimension.step();
    this.#stepCount++;
    this.afterEvents.step.emit({
      currentTick: system.currentTick,
      fixedTimeStep: this.#fixedTimeStep
    });
  }

  emitCollision(event: PhysicsCollisionAfterEvent): void {
    this.afterEvents.collision.emit(event);
  }

  emitSurfaceParticle(event: PhysicsContraptionSurfaceParticleAfterEvent): void {
    this.afterEvents.surfaceParticle.emit(event);
  }

  emitWaterEntry(event: PhysicsWaterEntryAfterEvent): void {
    this.afterEvents.waterEntry.emit(event);
  }

  emitLavaEntry(event: PhysicsLavaEntryAfterEvent): void {
    this.afterEvents.lavaEntry.emit(event);
  }

  invalidateWorldMesh(dimension: Dimension | string, location: Vector3, radius = 0): void {
    this.getExistingDimension(dimension)?.invalidateWorldMesh(location, radius);
  }

  invalidateWorldMeshBatch(
    dimension: Dimension | string,
    locations: readonly Vector3[]
  ): void {
    this.getExistingDimension(dimension)?.invalidateWorldMeshBatch(locations);
  }

  setPerformanceLevelProvider(
    provider: (() => TreePhysicsPerformanceLevel) | undefined
  ): void {
    this.#performanceLevelProvider = provider;
    this.#applyPerformanceLevel(true);
  }

  setCollisionShellProvider(provider: (() => ObbCollisionShell) | undefined): void {
    this.#collisionShellProvider = provider;
  }

  setPlayerCollisionEnabledProvider(provider: (() => boolean) | undefined): void {
    this.#playerCollisionEnabledProvider = provider;
  }

  setPlayerCarryingEnabledProvider(provider: (() => boolean) | undefined): void {
    this.#playerCarryingEnabledProvider = provider;
  }

  setPlayerMountEnabledProvider(provider: (() => boolean) | undefined): void {
    this.#playerMountEnabledProvider = provider;
  }

  /**
   * Picks one audit chunk across all dimensions per interval. Candidates are
   * ranked by isCannonWorldMeshAuditCandidatePreferred; among candidates that
   * tie on every preference field, the dimension cursor round-robins so a busy
   * dimension cannot starve the others. The field-by-field tie check mirrors
   * the preference predicate because "not preferred" alone cannot distinguish
   * "worse" from "equal".
   */
  #selectWorldMeshAuditTarget(): CannonWorldMeshAuditCandidate | undefined {
    if (
      this.#worldMeshAuditCoordinator.currentTick
        < this.#worldMeshAuditCoordinator.nextSelectionTick
      ||
      this.#worldMeshAuditCoordinator.currentTick
        - this.#worldMeshAuditCoordinator.lastAuditTick < WORLD_MESH_AUDIT_INTERVAL_TICKS
    ) return undefined;
    for (const dimension of this.#dimensions.values()) {
      if (dimension[HAS_PENDING_WORLD_MESH_BUILDS]()) return undefined;
    }
    this.#worldMeshAuditCoordinator.playerPositionsByDimension =
      this.#getPlayerPositionsByDimension();
    const dimensions = [...this.#dimensions.values()];
    let selected: CannonWorldMeshAuditCandidate | undefined;
    let selectedIndex = -1;
    let selectedRank = Number.POSITIVE_INFINITY;
    for (let index = 0; index < dimensions.length; index++) {
      const dimension = dimensions[index]!;
      const candidate = dimension[GET_WORLD_MESH_AUDIT_CANDIDATE]();
      const rank = dimensions.length > 0
        ? (index - this.#worldMeshAuditDimensionCursor + dimensions.length) % dimensions.length
        : 0;
      if (!candidate) continue;
      if (
        selected
        && !isCannonWorldMeshAuditCandidatePreferred(candidate, selected)
        && (
          candidate.auditCycle !== selected.auditCycle
          || candidate.sleepingSupport !== selected.sleepingSupport
          || candidate.playerDistanceSquared !== selected.playerDistanceSquared
          || candidate.ageTicks !== selected.ageTicks
          || candidate.scannedAgeTicks !== selected.scannedAgeTicks
          || rank >= selectedRank
        )
      ) continue;
      selected = candidate;
      selectedIndex = index;
      selectedRank = rank;
    }
    if (selectedIndex >= 0 && dimensions.length > 0) {
      this.#worldMeshAuditDimensionCursor = (selectedIndex + 1) % dimensions.length;
    }
    if (!selected) return undefined;
    this.#worldMeshAuditCoordinator.nextSelectionTick =
      this.#worldMeshAuditCoordinator.currentTick + WORLD_MESH_AUDIT_INTERVAL_TICKS;
    return selected;
  }

  #getPlayerPositionsByDimension(): ReadonlyMap<string, readonly Vector3[]> {
    const positions = new Map<string, Vector3[]>();
    let players: readonly Entity[];
    try {
      players = world.getAllPlayers();
    } catch {
      // Player enumeration is unavailable in some script lifecycle windows
      // (cf. the early-execution guard in start). The audit then proceeds
      // without player-distance weighting for this interval.
      return positions;
    }
    for (const player of players) {
      const dimensionId = player.dimension.id;
      let dimensionPositions = positions.get(dimensionId);
      if (!dimensionPositions) {
        dimensionPositions = [];
        positions.set(dimensionId, dimensionPositions);
      }
      dimensionPositions.push({ ...player.location });
    }
    return positions;
  }

  #applyPerformanceLevel(force = false): void {
    const next = this.#readPerformanceLevel();
    if (!force && next === this.#performanceLevel) return;
    this.#performanceLevel = next;
    for (const dimension of this.#dimensions.values()) dimension[CONFIGURE_SIMULATION]();
  }

  #readPerformanceLevel(): TreePhysicsPerformanceLevel {
    try {
      const provided = this.#performanceLevelProvider?.();
      if (provided !== undefined) {
        return provided === TREE_PHYSICS_PERFORMANCE_HIGH
          ? TREE_PHYSICS_PERFORMANCE_HIGH
          : TREE_PHYSICS_PERFORMANCE_LOW;
      }
    } catch {
      // A failing host provider falls back to the durable world setting.
    }
    return getTreePhysicsPerformanceLevel();
  }
}

export function createDefaultContraptionCollider(
  blocks: readonly PhysicsContraptionBlock[]
): Extract<PhysicsBodyCollider, { type: "compound" }> {
  return new ContraptionColliderIndex(blocks).collider;
}

/** Converts Bedrock's discrete, drag-damped falling speed back to distance. */
function estimatePlayerFallDistance(downwardSpeed: number): number {
  if (!Number.isFinite(downwardSpeed) || downwardSpeed <= 0) return 0;
  if (downwardSpeed >= PLAYER_TERMINAL_DOWNWARD_SPEED) {
    return Number.POSITIVE_INFINITY;
  }
  const fallTicks = Math.log1p(
    -downwardSpeed / PLAYER_TERMINAL_DOWNWARD_SPEED
  ) / Math.log(PLAYER_VERTICAL_DRAG_PER_TICK);
  return PLAYER_TERMINAL_DOWNWARD_SPEED * fallTicks
    - downwardSpeed * PLAYER_VERTICAL_DRAG_PER_TICK
    / (1 - PLAYER_VERTICAL_DRAG_PER_TICK);
}

function isJumpPressed(entity: Entity): boolean {
  return entity.typeId === "minecraft:player"
    && (entity as Player).inputInfo.getButtonState(JUMP_INPUT) === "Pressed";
}

function findClosestContraptionBlock(
  blocks: readonly PhysicsContraptionBlock[],
  local: Vector3,
  maximumDistance: number
): PhysicsContraptionBlock | undefined {
  let closest: PhysicsContraptionBlock | undefined;
  let closestDistanceSquared = maximumDistance * maximumDistance;
  for (const block of blocks) {
    const dx = block.localLocation.x - local.x;
    const dy = block.localLocation.y - local.y;
    const dz = block.localLocation.z - local.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared <= closestDistanceSquared) {
      closest = block;
      closestDistanceSquared = distanceSquared;
    }
  }
  return closest;
}

function createBlockVisualPair(
  dimension: Dimension,
  body: PhysicsBody,
  visualAnchor: Vector3,
  mainhandBlock: PhysicsContraptionBlock,
  offhandBlock: PhysicsContraptionBlock | undefined,
  visualEntityTags: readonly string[]
): Entity {
  const entity = spawnTaggedVisualEntity(
    dimension,
    DEFAULT_VISUAL_ENTITY_TYPE_ID,
    body.localPointToWorld(visualAnchor),
    visualEntityTags
  );
  try {
    entity.runCommand(
      `replaceitem entity @s slot.weapon.mainhand 0 ${mainhandBlock.itemTypeId ?? mainhandBlock.typeId}`
    );
    if (offhandBlock) {
      entity.runCommand(
        `replaceitem entity @s slot.weapon.offhand 0 ${offhandBlock.itemTypeId ?? offhandBlock.typeId}`
      );
    }
    setBlockVisualTransform(entity, mainhandBlock, visualAnchor, "");
    if (offhandBlock) setBlockVisualTransform(entity, offhandBlock, visualAnchor, "left_");
    return entity;
  } catch (error) {
    if (entity.isValid) entity.remove();
    throw error;
  }
}

function setBlockVisualTransform(
  entity: Entity,
  block: PhysicsContraptionBlock,
  visualAnchor: Vector3,
  prefix: "" | "left_"
): void {
  entity.setProperty(
    `treephysics:${prefix}local_x`,
    block.localLocation.x - visualAnchor.x
  );
  entity.setProperty(
    `treephysics:${prefix}local_y`,
    block.localLocation.y - visualAnchor.y
  );
  entity.setProperty(
    `treephysics:${prefix}local_z`,
    block.localLocation.z - visualAnchor.z
  );
  entity.setProperty(`treephysics:${prefix}local_pitch`, block.rotation?.x ?? 0);
  entity.setProperty(`treephysics:${prefix}local_yaw`, block.rotation?.y ?? 0);
  entity.setProperty(`treephysics:${prefix}local_roll`, block.rotation?.z ?? 0);
  if (prefix === "left_") {
    // Minecraft and addon block items use different offhand display origins.
    entity.setProperty(
      BLOCK_OFFHAND_ITEM_OFFSET_PROPERTY,
      block.typeId.startsWith("minecraft:")
        ? MINECRAFT_BLOCK_OFFHAND_ITEM_OFFSET
        : ADDON_BLOCK_OFFHAND_ITEM_OFFSET
    );
  }
}

function spawnTaggedVisualEntity(
  dimension: Dimension,
  typeId: string,
  location: Vector3,
  tags: readonly string[]
): Entity {
  const entity = dimension.spawnEntity(typeId, location);
  try {
    for (const tag of tags) {
      if (!entity.addTag(tag)) {
        throw new Error(`Could not assign visual entity tag ${tag}.`);
      }
    }
    return entity;
  } catch (error) {
    if (entity.isValid) entity.remove();
    throw error;
  }
}

// The only caller (raycast) normalizes a rotated unit normal whose length is
// always ~1; the zero return covers a non-finite body transform, letting the
// hit report a zero normal instead of NaN components.
function normalizeVector(value: Vector3): Vector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length < EPSILON_1E8) return { x: 0, y: 0, z: 0 };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

export const physicsWorld = new PhysicsWorld();
