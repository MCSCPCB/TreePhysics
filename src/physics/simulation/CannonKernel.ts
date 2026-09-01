import type { Block, Dimension, Entity, Vector3 } from "@minecraft/server";
import {
  Body,
  Box,
  type ContactEquation,
  ContactMaterial,
  GSSolver,
  Material,
  type Quaternion,
  SAPBroadphase,
  type Shape,
  Vec3,
  World
} from "cannon-es";
import type {
  PhysicsBodyAabb,
  PhysicsBodyBuoyancyPoint,
  PhysicsBodyCollider,
  PhysicsCollisionTag,
  PhysicsBodyOptions,
  PhysicsBodyTeleportOptions,
  PhysicsBodyVisualOptions,
  PhysicsBlockProperties,
  PhysicsContactMaterialProperties,
  PhysicsInertiaTensor,
  PhysicsWorldStats
} from "@src/physics/core/Types";
import { quaternionToContinuousEulerDegreesYzx } from "@src/physics/motion/RotationContinuity";
import { getIndexedWorldSensorCandidateChunkKeys } from "@src/physics/world/sensor/ChunkIndex";
import {
  EPSILON_1E8,
  isFiniteVector as isFiniteVector3
} from "@src/utils/Vector3Math";
import { safeGetBlock } from "@src/utils/WorldBlock";
import { type GreedyBox } from "@src/physics/core/GreedyBoxMesher";
import {
  RADIANS_TO_DEGREES,
  compareStrings,
  integerBoundsOverlap,
  integerBoundsVolume,
  lerp,
  mergeIntegerBounds,
  multiplyInvInertiaWorld,
  predictBodyRotation,
  toCannonQuaternion,
  transformAxisAlignedBounds,
  type IntegerBounds
} from "@src/physics/motion/KernelMath";
import {
  DEFAULT_BODY_BOX_HALF_EXTENT,
  createCannonShape,
  normalizeBodyCollider,
  normalizeHalfExtent,
  normalizedColliderShapeSignature,
  type NormalizedBodyCollider,
  type NormalizedBoxColliderShape,
  type NormalizedColliderShape
} from "@src/physics/core/ColliderNormalization";
import {
  DEFAULT_SOLID_BLOCK_FRICTION,
  DEFAULT_SOLID_BLOCK_RESTITUTION,
  createFluidSurface,
  getWorldBlockMaterialIdFromProperties,
  isLavaFluidType,
  isPhysicsFluidBlock,
  isWaterFluidType,
  matchesWorldBlockSensorPredicate,
  normalizeContactFriction,
  normalizeContactRestitution,
  sampleTouchesNativeFlowingFluid,
  type FluidSurface
} from "@src/physics/world/BlockClassification";
import {
  addScanBoundsCluster,
  addScanBoundsClusterToList,
  createWorldColliderKeys,
  createWorldScanCoverage,
  findWorldSupportInBounds,
  greedyBoxLayoutsEqual,
  isCoveredByAppliedShadowScans,
  isCoveredByWorldScans,
  scanSleepingEnvironment,
  scanWorldSolidBlocks,
  sortGreedyBoxes,
  worldScanCoverageVolume,
  type AppliedShadowScan,
  type ScanBoundsCluster,
  type ShadowScanShape,
  type WorldScanCoverage
} from "@src/physics/world/BlockScan";
import {
  EMPTY_WORLD_MESH_CHUNKS,
  WORLD_MESH_CACHE_CHUNK_SIZE,
  addWorldMeshChunkRequest,
  getMissingWorldMeshScanClusters,
  getWorldMeshChunkRequests,
  scanWorldMeshChunk,
  worldMeshChunkOrigin,
  worldMeshChunkRegionSignature,
  worldMeshChunkRequest,
  worldMeshChunkRequestKey,
  worldSensorBinCoordinate,
  worldSensorBinIndex,
  type CachedWorldMeshChunk,
  type WorldMeshChunkRequest
} from "@src/physics/world/MeshCache";
import {
  createIndexedWorldSensorSweep,
  findIndexedWorldSensorContact,
  getIndexedWorldSensorShapes,
  integerBoundsOverlapGreedyBox
} from "@src/physics/world/sensor/Scan";
import {
  CannonKernelAfterEvents,
  type CannonKernelCollisionAfterEvent,
  type CannonKernelIndexedWorldSensorHit
} from "@src/physics/simulation/CannonKernelEvents";
// physics.ts consumes these event payload types through the kernel module.
export type {
  CannonKernelCollisionAfterEvent,
  CannonKernelLavaEntryAfterEvent,
  CannonKernelWaterEntryAfterEvent
} from "@src/physics/simulation/CannonKernelEvents";

const DEFAULT_FIXED_TIME_STEP = 1 / 60;
const DEFAULT_TICK_STEPS = 3;
const DEFAULT_GRAVITY = { x: 0, y: -11, z: 0 } as const;
const DEFAULT_SOLVER_ITERATIONS = 8;
const DEFAULT_SOLVER_TOLERANCE = 0.0001;
const DEFAULT_SLEEP_SPEED_LIMIT = 0.14;
const DEFAULT_SLEEP_TIME_LIMIT_SECONDS = 1.1;
const DEFAULT_CONTACT_STIFFNESS = 10_000_000;
const DEFAULT_CONTACT_RELAXATION = 3;
const TRANSFORM_POSITION_WRITE_THRESHOLD = 1 / 1024;
const TRANSFORM_ROTATION_WRITE_THRESHOLD_DEGREES = 0.05;
const DEFAULT_VISUAL_ENTITY_TYPE_ID = "treephysics:block";
const DEFAULT_VISUAL_ITEM_TYPE_ID = "minecraft:stone";
const DEFAULT_VISUAL_ENTITY_Y_OFFSET = 0.5;
// The treephysics-prefixed strings are rewritten to treephysics by the build
// script and are entity-property persistence contracts; never split or rewrite them.
const DEFAULT_VISUAL_PROPERTY_MAP: NonNullable<PhysicsBodyVisualOptions["propertyMap"]> = {
  pitch: "treephysics:pitch",
  roll: "treephysics:roll",
  scale: "treephysics:scale",
  yaw: "treephysics:yaw"
};
const SABLE_DEFAULT_UNIVERSAL_DRAG = 0.09;
// Sable's dynamic level collider uses 0.525 before block friction multipliers.
const SABLE_BASE_CONTACT_FRICTION = 0.525;
const DEFAULT_WORLD_BLOCK_SCAN_MARGIN = 1;
const DEFAULT_WORLD_BLOCK_SCAN_MAX_VELOCITY_MARGIN = 3;
const WORLD_BLOCK_SLEEP_SUPPORT_SCAN_INTERVAL_TICKS = 10;
const WORLD_BLOCK_SLEEP_ENVIRONMENT_SCAN_INTERVAL_TICKS = 20;
const DEFAULT_FLUID_DENSITY = 1.05;
const DEFAULT_FLUID_DRAG = 1.7;
const LAVA_ENTRY_REARM_TICKS = 4;
const SHAPE_UNION_SCAN_MEMBER_OVERHEAD = 8;
const WORLD_BLOCK_SHADOW_MAX_SHAPES = 4;
const WORLD_BLOCK_SHADOW_MIN_SCAN_VOLUME = 256;
const WORLD_MESH_CACHE_HIGH_PRIORITY_BUILDS_PER_TICK = 4;
const WORLD_MESH_CACHE_NORMAL_PRIORITY_BUILDS_PER_TICK = 2;
const WORLD_MESH_CACHE_AUDIT_MIN_AGE_TICKS = 200;
const WORLD_MESH_CACHE_AUDIT_INTERVAL_TICKS = 20;
const WORLD_MESH_CACHE_UNUSED_TICKS = 400;
const WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN = 1;

export interface CannonKernelOptions {
  angularDamping?: number;
  fixedTimeStep?: number;
  gravity?: Vector3;
  linearDamping?: number;
  solverIterations?: number;
  tickSteps?: number;
  worldMeshAuditCoordinator?: CannonWorldMeshAuditCoordinator;
  worldMeshCache?: boolean;
}

export interface CannonWorldMeshAuditCoordinator {
  currentTick: number;
  lastAuditTick: number;
  nextSelectionTick: number;
  targetChunkKey?: string;
  targetDimensionId?: string;
  playerPositionsByDimension?: ReadonlyMap<string, readonly Vector3[]>;
}

export interface CannonWorldMeshAuditCandidate {
  readonly ageTicks: number;
  readonly auditCycle: number;
  readonly chunkKey: string;
  readonly dimensionId: string;
  readonly playerDistanceSquared: number;
  readonly scannedAgeTicks: number;
  readonly sleepingSupport: boolean;
}

export function isCannonWorldMeshAuditCandidatePreferred(
  candidate: CannonWorldMeshAuditCandidate,
  current: CannonWorldMeshAuditCandidate
): boolean {
  if (candidate.auditCycle !== current.auditCycle) {
    return candidate.auditCycle > current.auditCycle;
  }
  if (candidate.sleepingSupport !== current.sleepingSupport) {
    return candidate.sleepingSupport;
  }
  if (candidate.playerDistanceSquared !== current.playerDistanceSquared) {
    return candidate.playerDistanceSquared < current.playerDistanceSquared;
  }
  if (candidate.ageTicks !== current.ageTicks) return candidate.ageTicks > current.ageTicks;
  return candidate.scannedAgeTicks > current.scannedAgeTicks;
}

interface CannonBodyRecord {
  buoyancyPoints: PhysicsBodyBuoyancyPoint[];
  buoyancyRelativeLocations: Vector3[];
  buoyancyVolume: number;
  collider: NormalizedBodyCollider;
  colliderLocalCenter: Vector3;
  readonly dimension: Dimension;
  readonly entity?: Entity;
  environmentCollider: NormalizedBodyCollider;
  halfExtents: Vector3;
  readonly gravityScale: number;
  inLava: boolean;
  inNativeFlowingFluid: boolean;
  inWater: boolean;
  indexedWorldSensorShapes?: readonly NormalizedBoxColliderShape[];
  lavaEntryRearmTicks: number;
  lavaSubmersionRatio: number;
  localCenterOfMass: Vector3;
  materialId: string;
  sleepEnvironmentSignature?: string;
  worldFluidMeshChunks?: ReadonlyMap<string, WorldMeshChunkRequest>;
  worldFluidMeshRegionSignature?: string;
  worldMeshChunks?: ReadonlyMap<string, WorldMeshChunkRequest>;
  worldMeshChunksActive?: boolean;
  worldMeshRegionSignature?: string;
  readonly worldSensorSweepStartAngularVelocity: Vec3;
  readonly worldSensorSweepStartPosition: Vec3;
  readonly worldSensorSweepStartQuaternion: Quaternion;
  readonly worldSensorSweepStartVelocity: Vec3;
  worldSensorSweepPending: boolean;
  readonly visualLocalOffset: Vector3;
  lastWrittenPitch: number;
  lastWrittenRoll: number;
  lastWrittenVisualX: number;
  lastWrittenVisualY: number;
  lastWrittenVisualZ: number;
  lastWrittenYaw: number;
}

interface WorldMeshAuditCandidateEntry {
  readonly candidate: CannonWorldMeshAuditCandidate;
  readonly chunk: CachedWorldMeshChunk;
  readonly key: string;
}

interface WorldMeshAuditSelectionContext {
  readonly playerPositionsByDimension?: ReadonlyMap<string, readonly Vector3[]>;
  readonly sleepingSupportKeys?: ReadonlySet<string>;
}

interface CannonCollideEvent {
  readonly body: Body;
  readonly contact: ContactEquation;
}

const DEFAULT_CONTACT_PROPERTIES = { friction: 1, restitution: 0 } as const;

export class CannonKernelBody {
  readonly id: number;
  readonly name?: string;
  readonly #body: Body;
  readonly #runtime: CannonKernelRuntime;

  constructor(id: number, runtime: CannonKernelRuntime, body: Body, name?: string) {
    this.id = id;
    this.#runtime = runtime;
    this.#body = body;
    this.name = name;
  }

  get isSleeping(): boolean {
    return this.#body.sleepState === Body.SLEEPING;
  }

  get isDynamic(): boolean {
    return this.#body.type === Body.DYNAMIC;
  }

  get isInNativeFlowingFluid(): boolean {
    return this.#runtime.getBodyIsInNativeFlowingFluid(this.id);
  }

  get isActive(): boolean {
    return this.isValid && this.#body.type !== Body.STATIC && !this.isSleeping;
  }

  get isValid(): boolean {
    return this.#runtime.hasBody(this.id);
  }

  get location(): Vector3 {
    return this.#runtime.getBodyLocation(this.id);
  }

  get angularVelocity(): Vector3 {
    return {
      x: this.#body.angularVelocity.x,
      y: this.#body.angularVelocity.y,
      z: this.#body.angularVelocity.z
    };
  }

  get velocity(): Vector3 {
    return {
      x: this.#body.velocity.x,
      y: this.#body.velocity.y,
      z: this.#body.velocity.z
    };
  }

  getAabb(): PhysicsBodyAabb {
    const record = this.#runtime.getBodyRecord(this.id);
    if (record) return getColliderWorldAabb(this.#body, record, record.environmentCollider);
    this.#body.updateAABB();
    return cannonAabbToPhysicsAabb(this.#body);
  }

  getAngularVelocity(): Vector3 {
    return this.angularVelocity;
  }

  getMass(): number {
    return this.#body.mass;
  }

  getEffectiveMassAt(location: Vector3, direction: Vector3): number {
    if (
      this.#body.type !== Body.DYNAMIC
      || !isFiniteVector3(location)
      || !isFiniteVector3(direction)
    ) return 0;
    const directionLength = Math.hypot(direction.x, direction.y, direction.z);
      if (!Number.isFinite(directionLength) || directionLength < EPSILON_1E8) return 0;

    const normal = new Vec3(
      direction.x / directionLength,
      direction.y / directionLength,
      direction.z / directionLength
    );
    const relative = new Vec3(
      location.x - this.#body.position.x,
      location.y - this.#body.position.y,
      location.z - this.#body.position.z
    );
    const rotationalAxis = relative.cross(normal, new Vec3());
    this.#body.updateInertiaWorld(true);
    const inverseInertiaAxis = multiplyInvInertiaWorld(this.#body, rotationalAxis);
    const inverseEffectiveMass = this.#body.invMass
      + rotationalAxis.dot(inverseInertiaAxis);
    return Number.isFinite(inverseEffectiveMass) && inverseEffectiveMass > 1e-12
      ? 1 / inverseEffectiveMass
      : 0;
  }

  getEffectiveInertia(direction: Vector3): number {
    if (this.#body.type !== Body.DYNAMIC || !isFiniteVector3(direction)) return 0;
    const directionLength = Math.hypot(direction.x, direction.y, direction.z);
    if (!Number.isFinite(directionLength) || directionLength < EPSILON_1E8) return 0;

    const axis = new Vec3(
      direction.x / directionLength,
      direction.y / directionLength,
      direction.z / directionLength
    );
    this.#body.updateInertiaWorld(true);
    const inverseInertiaAxis = multiplyInvInertiaWorld(this.#body, axis);
    const inverseEffectiveInertia = axis.dot(inverseInertiaAxis);
    return Number.isFinite(inverseEffectiveInertia) && inverseEffectiveInertia > 1e-12
      ? 1 / inverseEffectiveInertia
      : 0;
  }

  getShapeCount(): number {
    return this.#body.shapes.length;
  }

  getCenterOfMass(): Vector3 {
    return this.#runtime.getBodyLocalCenterOfMass(this.id);
  }

  getInertia(): Vector3 {
    return {
      x: this.#body.inertia.x,
      y: this.#body.inertia.y,
      z: this.#body.inertia.z
    };
  }

  getInertiaTensor(): PhysicsInertiaTensor {
    return {
      m00: this.#body.inertia.x,
      m01: 0,
      m02: 0,
      m10: 0,
      m11: this.#body.inertia.y,
      m12: 0,
      m20: 0,
      m21: 0,
      m22: this.#body.inertia.z
    };
  }

  getRotation(): Vector3 {
    const euler = new Vec3();
    this.#body.quaternion.toEuler(euler, "YZX");
    return {
      x: euler.x * RADIANS_TO_DEGREES,
      y: euler.y * RADIANS_TO_DEGREES,
      z: euler.z * RADIANS_TO_DEGREES
    };
  }

  get lavaSubmersionRatio(): number {
    return this.#runtime.getBodyLavaSubmersionRatio(this.id);
  }

  getVisualRotation(reference?: Vector3): Vector3 {
    return quaternionToContinuousEulerDegreesYzx(this.#body.quaternion, reference);
  }

  getVelocity(): Vector3 {
    return this.velocity;
  }

  setVelocity(velocity: Vector3): void {
    if (this.#body.type === Body.STATIC) return;
    this.#body.velocity.set(velocity.x, velocity.y, velocity.z);
    if (velocity.x !== 0 || velocity.y !== 0 || velocity.z !== 0) this.wakeUp();
  }

  setAngularVelocity(angularVelocity: Vector3): void {
    if (this.#body.type === Body.STATIC) return;
    this.#body.angularVelocity.set(angularVelocity.x, angularVelocity.y, angularVelocity.z);
    if (angularVelocity.x !== 0 || angularVelocity.y !== 0 || angularVelocity.z !== 0) {
      this.wakeUp();
    }
  }

  setRotation(rotation: Vector3): void {
    if (!isFiniteVector3(rotation)) return;
    this.#body.quaternion.copy(toCannonQuaternion(rotation));
    this.#body.aabbNeedsUpdate = true;
    this.wakeUp();
    this.writeTransform();
  }

  applyForce(force: Vector3, coordinateSpace: "world" | "local" = "world"): void {
    if (this.#body.type !== Body.DYNAMIC || !isFiniteVector3(force)) return;
    const value = new Vec3(force.x, force.y, force.z);
    if (coordinateSpace === "local") this.#body.applyLocalForce(value);
    else this.#body.applyForce(value);
    if (force.x !== 0 || force.y !== 0 || force.z !== 0) this.wakeUp();
  }

  applyForceAt(
    location: Vector3,
    force: Vector3,
    coordinateSpace: "world" | "local" = "world"
  ): void {
    if (
      this.#body.type !== Body.DYNAMIC
      || !isFiniteVector3(location)
      || !isFiniteVector3(force)
    ) return;
    const value = new Vec3(force.x, force.y, force.z);
    if (coordinateSpace === "local") {
      const centerOfMass = this.#runtime.getBodyLocalCenterOfMass(this.id);
      this.#body.applyLocalForce(value, new Vec3(
        location.x - centerOfMass.x,
        location.y - centerOfMass.y,
        location.z - centerOfMass.z
      ));
    } else {
      const relative = new Vec3(
        location.x - this.#body.position.x,
        location.y - this.#body.position.y,
        location.z - this.#body.position.z
      );
      this.#body.applyForce(value, relative);
    }
    if (force.x !== 0 || force.y !== 0 || force.z !== 0) this.wakeUp();
  }

  applyImpulse(impulse: Vector3): void {
    if (this.#body.type !== Body.DYNAMIC || !isFiniteVector3(impulse)) return;
    this.#body.applyImpulse(new Vec3(impulse.x, impulse.y, impulse.z));
    if (impulse.x !== 0 || impulse.y !== 0 || impulse.z !== 0) this.wakeUp();
  }

  applyImpulseAt(location: Vector3, impulse: Vector3): void {
    if (
      this.#body.type !== Body.DYNAMIC
      || !isFiniteVector3(location)
      || !isFiniteVector3(impulse)
    ) return;
    const relative = new Vec3(
      location.x - this.#body.position.x,
      location.y - this.#body.position.y,
      location.z - this.#body.position.z
    );
    this.#body.applyImpulse(new Vec3(impulse.x, impulse.y, impulse.z), relative);
    if (impulse.x !== 0 || impulse.y !== 0 || impulse.z !== 0) this.wakeUp();
  }

  applyTorque(torque: Vector3, coordinateSpace: "world" | "local" = "world"): void {
    if (this.#body.type !== Body.DYNAMIC || !isFiniteVector3(torque)) return;
    const value = new Vec3(torque.x, torque.y, torque.z);
    if (coordinateSpace === "local") this.#body.quaternion.vmult(value, value);
    this.#body.applyTorque(value);
    if (torque.x !== 0 || torque.y !== 0 || torque.z !== 0) this.wakeUp();
  }

  applyTorqueImpulse(torque: Vector3): void {
    if (this.#body.type !== Body.DYNAMIC || !isFiniteVector3(torque)) return;
    const angularVelocityChange = multiplyInvInertiaWorld(this.#body, torque);
    this.#body.angularVelocity.vadd(angularVelocityChange, this.#body.angularVelocity);
    if (torque.x !== 0 || torque.y !== 0 || torque.z !== 0) this.wakeUp();
  }

  getVelocityAt(location: Vector3): Vector3 {
    const result = new Vec3();
    this.#body.getVelocityAtWorldPoint(new Vec3(location.x, location.y, location.z), result);
    return { x: result.x, y: result.y, z: result.z };
  }

  localPointToWorld(location: Vector3): Vector3 {
    const result = new Vec3(location.x, location.y, location.z);
    this.#body.quaternion.vmult(result, result);
    const origin = this.location;
    return {
      x: origin.x + result.x,
      y: origin.y + result.y,
      z: origin.z + result.z
    };
  }

  worldPointToLocal(location: Vector3): Vector3 {
    const origin = this.location;
    const result = new Vec3(
      location.x - origin.x,
      location.y - origin.y,
      location.z - origin.z
    );
    this.#body.quaternion.conjugate().vmult(result, result);
    return { x: result.x, y: result.y, z: result.z };
  }

  setMass(mass: number): void {
    if (this.#body.type !== Body.DYNAMIC || !Number.isFinite(mass) || mass <= 0) return;
    this.#body.mass = mass;
    updateDynamicBodyMassProperties(this.#body);
    this.wakeUp();
  }

  setBuoyancyPoints(points: readonly PhysicsBodyBuoyancyPoint[]): void {
    this.#runtime.setBodyBuoyancyPoints(this.id, points);
  }

  setCollider(collider: PhysicsBodyCollider): void {
    this.#runtime.setBodyCollider(this.id, collider);
  }

  setColliderIncrementally(collider: PhysicsBodyCollider): void {
    this.#runtime.setBodyColliderIncrementally(this.id, collider);
  }

  setEnvironmentCollider(collider: PhysicsBodyCollider): void {
    this.#runtime.setBodyEnvironmentCollider(this.id, collider);
  }

  setCenterOfMass(centerOfMass: Vector3): void {
    if (!isFiniteVector3(centerOfMass)) return;
    const record = this.#runtime.getBodyRecord(this.id);
    if (!record) return;
    const location = this.location;
    record.localCenterOfMass.x = centerOfMass.x;
    record.localCenterOfMass.y = centerOfMass.y;
    record.localCenterOfMass.z = centerOfMass.z;
    record.buoyancyRelativeLocations = getBuoyancyRelativeLocations(
      record.buoyancyPoints,
      record.localCenterOfMass
    );
    const worldOffset = new Vec3(centerOfMass.x, centerOfMass.y, centerOfMass.z);
    this.#body.quaternion.vmult(worldOffset, worldOffset);
    this.#body.position.set(
      location.x + worldOffset.x,
      location.y + worldOffset.y,
      location.z + worldOffset.z
    );
    this.#runtime.updateBodyShapeOffset(this.id);
    this.#body.aabbNeedsUpdate = true;
    this.wakeUp();
    this.writeTransform();
  }

  setInertia(inertia: Vector3): void {
    if (this.#body.type !== Body.DYNAMIC) return;
    this.#body.inertia.set(
      Math.max(0, inertia.x),
      Math.max(0, inertia.y),
      Math.max(0, inertia.z)
    );
    this.#body.invInertia.set(
      inertia.x > 0 ? 1 / inertia.x : 0,
      inertia.y > 0 ? 1 / inertia.y : 0,
      inertia.z > 0 ? 1 / inertia.z : 0
    );
    this.#body.updateInertiaWorld(true);
    this.wakeUp();
  }

  setInertiaTensor(inertia: PhysicsInertiaTensor): void {
    this.setInertia({ x: inertia.m00, y: inertia.m11, z: inertia.m22 });
  }

  remove(): void {
    this.#runtime.removeBody(this.id);
  }

  teleport(location: Vector3, options?: PhysicsBodyTeleportOptions): void {
    if (options?.rotation) this.#body.quaternion.copy(toCannonQuaternion(options.rotation));
    const centerOfMass = this.#runtime.getBodyLocalCenterOfMass(this.id);
    const worldOffset = new Vec3(centerOfMass.x, centerOfMass.y, centerOfMass.z);
    this.#body.quaternion.vmult(worldOffset, worldOffset);
    this.#body.position.set(
      location.x + worldOffset.x,
      location.y + worldOffset.y,
      location.z + worldOffset.z
    );
    if (options?.velocity && this.#body.type !== Body.STATIC) {
      this.#body.velocity.set(options.velocity.x, options.velocity.y, options.velocity.z);
    }
    if (options?.angularVelocity && this.#body.type !== Body.STATIC) {
      this.#body.angularVelocity.set(
        options.angularVelocity.x,
        options.angularVelocity.y,
        options.angularVelocity.z
      );
    }
    this.#body.aabbNeedsUpdate = true;
    this.wakeUp();
    this.writeTransform();
  }

  sleep(): void {
    if (this.#body.type === Body.DYNAMIC) this.#body.sleep();
  }

  wakeUp(): void {
    if (this.#body.type !== Body.STATIC) this.#body.wakeUp();
  }

  writeTransform(): boolean {
    return this.#runtime.writeBodyTransform(this.id);
  }
}

export class CannonKernelRuntime {
  readonly afterEvents = new CannonKernelAfterEvents();
  readonly #beforeSubstepCallbacks = new Set<() => void>();
  readonly #bodies = new Map<number, CannonKernelBody>();
  readonly #collisionTagsByShape = new WeakMap<Shape, PhysicsCollisionTag>();
  readonly #bodyRecords = new Map<number, CannonBodyRecord>();
  readonly #blockProperties = new Map<string, PhysicsBlockProperties>();
  readonly #buoyancyForce = new Vec3();
  readonly #buoyancyPoint = new Vec3();
  readonly #buoyancyPointVelocity = new Vec3();
  readonly #buoyancyRelative = new Vec3();
  readonly #cannonBodies = new Map<number, Body>();
  readonly #handlesByCannonBody = new Map<Body, CannonKernelBody>();
  readonly #materialProperties = new Map<string, PhysicsContactMaterialProperties>();
  readonly #materials = new Map<string, Material>();
  readonly #contactMaterials = new Set<string>();
  readonly #contactMaterialIds = new Set<string>();
  readonly #fluidSurfacesByDimension = new Map<Dimension, Map<string, FluidSurface>>();
  readonly #activeWorldMeshChunkKeys = new Set<string>();
  readonly #activeWorldMeshChunkReferenceCounts = new Map<string, number>();
  readonly #worldMeshChunkReferenceCounts = new Map<string, number>();
  readonly #worldMeshHighPriorityQueue = new Map<string, WorldMeshChunkRequest>();
  readonly #worldMeshNormalPriorityQueue = new Map<string, WorldMeshChunkRequest>();
  readonly #worldColliderBodies = new Map<string, Body>();
  #indexedWorldSensorsEnabled = false;
  #indexedWorldSensorVisitMark = 0;
  #worldMeshCache: Map<string, CachedWorldMeshChunk> | undefined;
  #worldMeshAuditCoordinator: CannonWorldMeshAuditCoordinator | undefined;
  #worldBlockSensorPredicate: ((block: Block) => boolean) | undefined;
  #worldColliderLayout: GreedyBox[] = [];
  readonly #world = new World();
  #fixedTimeStep = DEFAULT_FIXED_TIME_STEP;
  #angularDamping = SABLE_DEFAULT_UNIVERSAL_DRAG;
  #linearDamping = SABLE_DEFAULT_UNIVERSAL_DRAG;
  #lastWorldMeshPruneTick = 0;
  #nextBodyId = 1;
  #stepCount = 0;
  #tickSteps = DEFAULT_TICK_STEPS;
  #worldMeshAuditScansThisTick = 0;
  #worldMeshCacheEnabled = false;

  constructor(options: CannonKernelOptions = {}) {
    this.configure(options);
  }

  get fixedTimeStep(): number {
    return this.#fixedTimeStep;
  }

  configure(options: CannonKernelOptions = {}): void {
    this.#fixedTimeStep = options.fixedTimeStep ?? this.#fixedTimeStep;
    this.#tickSteps = normalizeTickSteps(options.tickSteps ?? this.#tickSteps);
    const worldMeshCacheEnabled = options.worldMeshCache ?? this.#worldMeshCacheEnabled;
    if (worldMeshCacheEnabled !== this.#worldMeshCacheEnabled) {
      this.clearWorldMeshCache();
      this.clearWorldBlockColliders();
      this.#worldColliderLayout = [];
      this.#fluidSurfacesByDimension.clear();
      this.#worldMeshCache = worldMeshCacheEnabled ? new Map() : undefined;
    }
    this.#worldMeshCacheEnabled = worldMeshCacheEnabled;
    this.#worldMeshAuditCoordinator = options.worldMeshAuditCoordinator
      ?? this.#worldMeshAuditCoordinator;
    const gravity = options.gravity ?? DEFAULT_GRAVITY;
    this.#world.gravity.set(gravity.x, gravity.y, gravity.z);
    this.#world.allowSleep = true;
    this.#world.defaultContactMaterial.friction = SABLE_BASE_CONTACT_FRICTION;
    this.#world.defaultContactMaterial.restitution = DEFAULT_SOLID_BLOCK_RESTITUTION;
    this.#world.defaultContactMaterial.contactEquationStiffness = DEFAULT_CONTACT_STIFFNESS;
    this.#world.defaultContactMaterial.contactEquationRelaxation = DEFAULT_CONTACT_RELAXATION;
    this.#world.defaultContactMaterial.frictionEquationStiffness = DEFAULT_CONTACT_STIFFNESS;
    this.#world.defaultContactMaterial.frictionEquationRelaxation = DEFAULT_CONTACT_RELAXATION;
    this.#world.narrowphase.enableFrictionReduction = false;
    const broadphase = new SAPBroadphase(this.#world);
    broadphase.useBoundingBoxes = true;
    broadphase.autoDetectAxis();
    this.#world.broadphase = broadphase;
    if (this.#world.solver instanceof GSSolver) {
      this.#world.solver.iterations = options.solverIterations ?? DEFAULT_SOLVER_ITERATIONS;
      this.#world.solver.tolerance = DEFAULT_SOLVER_TOLERANCE;
    }
    this.#linearDamping = options.linearDamping ?? this.#linearDamping;
    this.#angularDamping = options.angularDamping ?? this.#angularDamping;
    for (const body of this.#world.bodies) {
      body.linearDamping = this.#linearDamping;
      body.angularDamping = this.#angularDamping;
    }
  }

  addBeforeSubstepCallback(callback: () => void): () => void {
    this.#beforeSubstepCallbacks.add(callback);
    return () => this.#beforeSubstepCallbacks.delete(callback);
  }

  createBody(dimension: Dimension, options: PhysicsBodyOptions, requestedId?: number): CannonKernelBody {
    const collider = normalizeBodyCollider(options);
    const id = requestedId ?? this.#nextBodyId++;
    this.#nextBodyId = Math.max(this.#nextBodyId, id + 1);
    const visual = options.visual === false ? undefined : options.visual;
    const visualEntityTypeId =
      visual?.entityTypeId
      ?? options.visualEntityTypeId
      ?? DEFAULT_VISUAL_ENTITY_TYPE_ID;
    const entity = options.visual === false
      ? undefined
      : dimension.spawnEntity(visualEntityTypeId, options.location);
    if (entity) entity.nameTag = options.name ?? `CannonKernelBody ${id}`;
    const itemTypeId =
      visual?.itemTypeId
      ?? options.itemTypeId
      ?? (visualEntityTypeId === DEFAULT_VISUAL_ENTITY_TYPE_ID ? DEFAULT_VISUAL_ITEM_TYPE_ID : undefined);
    if (itemTypeId && entity) {
      entity.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${itemTypeId}`);
    }
    // Contraption hand-item visuals intentionally retain the entity default of
    // zero until their complete pose is published. Standalone kernel visuals
    // have no deferred renderer, so make them visible during normal creation.
    if (entity && visualEntityTypeId === DEFAULT_VISUAL_ENTITY_TYPE_ID) {
      entity.setProperty(DEFAULT_VISUAL_PROPERTY_MAP.scale, 1);
    }

    const halfExtents = collider.boundingHalfExtents;
    const localCenterOfMass = { ...collider.localCenter };
    const mass = normalizeMass(options.mass);
    const materialId = options.material ?? "default";
    const materialAlreadyRepresented = this.#contactMaterialIds.has(materialId);
    const material = this.getOrCreateMaterial(materialId);
    const motionType = options.motionType ?? "dynamic";
    const body = new Body({
      angularDamping: options.angularDamping ?? this.#angularDamping,
      linearDamping: options.linearDamping ?? this.#linearDamping,
      mass: motionType === "dynamic" ? mass : 0,
      material,
      position: new Vec3(options.location.x, options.location.y, options.location.z),
      quaternion: toCannonQuaternion(options.rotation),
      type:
        motionType === "static"
          ? Body.STATIC
          : motionType === "kinematic"
            ? Body.KINEMATIC
            : Body.DYNAMIC,
      velocity: options.velocity
        ? new Vec3(options.velocity.x, options.velocity.y, options.velocity.z)
        : new Vec3()
    });
    for (const shapeDefinition of collider.shapes) {
      const shape = createCannonShape(shapeDefinition.primitive);
      shape.material = material;
      shape.collisionResponse = shapeDefinition.collisionResponse !== false;
      if (shapeDefinition.collisionTag !== undefined) {
        this.#collisionTagsByShape.set(shape, shapeDefinition.collisionTag);
      }
      body.addShape(
        shape,
        new Vec3(
          shapeDefinition.location.x - localCenterOfMass.x,
          shapeDefinition.location.y - localCenterOfMass.y,
          shapeDefinition.location.z - localCenterOfMass.z
        ),
        toCannonQuaternion(shapeDefinition.rotation)
      );
    }
    const initialCenterOfMassOffset = new Vec3(
      localCenterOfMass.x,
      localCenterOfMass.y,
      localCenterOfMass.z
    );
    body.quaternion.vmult(initialCenterOfMassOffset, initialCenterOfMassOffset);
    body.position.set(
      options.location.x + initialCenterOfMassOffset.x,
      options.location.y + initialCenterOfMassOffset.y,
      options.location.z + initialCenterOfMassOffset.z
    );
    body.allowSleep = motionType === "dynamic" && (options.allowSleep ?? true);
    body.sleepSpeedLimit = DEFAULT_SLEEP_SPEED_LIMIT;
    body.sleepTimeLimit = DEFAULT_SLEEP_TIME_LIMIT_SECONDS;
    if (options.angularVelocity) {
      body.angularVelocity.set(
        options.angularVelocity.x,
        options.angularVelocity.y,
        options.angularVelocity.z
      );
    }
    updateDynamicBodyMassProperties(body);
    this.#world.addBody(body);
    const handle = new CannonKernelBody(id, this, body, options.name);
    this.#bodies.set(id, handle);
    this.#cannonBodies.set(id, body);
    this.#handlesByCannonBody.set(body, handle);
    const environmentCollider = options.environmentCollider
      ? normalizeBodyCollider({ collider: options.environmentCollider, location: options.location })
      : collider;
    const buoyancyPoints = normalizeBuoyancyPoints(options.buoyancyPoints);
    this.#bodyRecords.set(id, {
      buoyancyPoints,
      buoyancyRelativeLocations: getBuoyancyRelativeLocations(
        buoyancyPoints,
        localCenterOfMass
      ),
      buoyancyVolume: totalBuoyancyVolume(buoyancyPoints),
      collider,
      colliderLocalCenter: { ...collider.localCenter },
      dimension,
      entity,
      environmentCollider,
      halfExtents,
      gravityScale: Number.isFinite(options.gravityScale) ? options.gravityScale ?? 1 : 1,
      inLava: false,
      inNativeFlowingFluid: false,
      inWater: false,
      indexedWorldSensorShapes: getIndexedWorldSensorShapes(collider),
      lavaEntryRearmTicks: 0,
      lavaSubmersionRatio: 0,
      localCenterOfMass,
      materialId,
      worldSensorSweepPending: false,
      worldSensorSweepStartAngularVelocity: new Vec3(),
      worldSensorSweepStartPosition: body.position.clone(),
      worldSensorSweepStartQuaternion: body.quaternion.clone(),
      worldSensorSweepStartVelocity: new Vec3(),
      visualLocalOffset: {
        x: 0,
        y: entity && visualEntityTypeId === DEFAULT_VISUAL_ENTITY_TYPE_ID
          ? DEFAULT_VISUAL_ENTITY_Y_OFFSET
          : 0,
        z: 0
      },
      lastWrittenPitch: Number.NaN,
      lastWrittenRoll: Number.NaN,
      lastWrittenVisualX: Number.NaN,
      lastWrittenVisualY: Number.NaN,
      lastWrittenVisualZ: Number.NaN,
      lastWrittenYaw: Number.NaN
    });
    body.addEventListener("collide", (event: CannonCollideEvent) => {
      this.emitCollision(handle, body, event);
    });
    if (!materialAlreadyRepresented) this.rebuildContactMaterials();
    handle.writeTransform();
    return handle;
  }

  getBodies(): readonly CannonKernelBody[] {
    return Array.from(this.#bodies.values());
  }

  getStats(): PhysicsWorldStats {
    let activeBodyCount = 0;
    let sleepingBodyCount = 0;
    for (const body of this.#world.bodies) {
      if (body.type !== Body.DYNAMIC) continue;
      if (body.sleepState === Body.SLEEPING) sleepingBodyCount++;
      else activeBodyCount++;
    }
    return {
      activeBodyCount,
      bodyCount: this.#bodies.size,
      fixedTimeStep: this.#fixedTimeStep,
      running: false,
      sleepingBodyCount,
      stepCount: this.#stepCount
    };
  }

  hasBody(id: number): boolean {
    return this.#bodies.has(id);
  }

  addStaticBox(location: Vector3, size: Vector3, materialId = "default"): void {
    const halfExtents = new Vec3(
      normalizeHalfExtent(size.x / 2),
      normalizeHalfExtent(size.y / 2),
      normalizeHalfExtent(size.z / 2)
    );
    const body = new Body({
      mass: 0,
      material: this.getOrCreateMaterial(materialId),
      position: new Vec3(
        location.x + halfExtents.x,
        location.y + halfExtents.y,
        location.z + halfExtents.z
      ),
      type: Body.STATIC
    });
    body.addShape(new Box(halfExtents));
    body.updateMassProperties();
    this.#world.addBody(body);
  }

  getBodyHalfExtents(id: number): Vector3 {
    const record = this.#bodyRecords.get(id);
    return record?.halfExtents ?? {
      x: DEFAULT_BODY_BOX_HALF_EXTENT,
      y: DEFAULT_BODY_BOX_HALF_EXTENT,
      z: DEFAULT_BODY_BOX_HALF_EXTENT
    };
  }

  getBodyRecord(id: number): CannonBodyRecord | undefined {
    return this.#bodyRecords.get(id);
  }

  getBodyLocalCenterOfMass(id: number): Vector3 {
    const center = this.#bodyRecords.get(id)?.localCenterOfMass;
    return center ? { x: center.x, y: center.y, z: center.z } : { x: 0, y: 0, z: 0 };
  }

  getBodyLocation(id: number): Vector3 {
    const body = this.#cannonBodies.get(id);
    const record = this.#bodyRecords.get(id);
    if (!body || !record) return { x: 0, y: 0, z: 0 };
    const worldOffset = new Vec3(
      record.localCenterOfMass.x,
      record.localCenterOfMass.y,
      record.localCenterOfMass.z
    );
    body.quaternion.vmult(worldOffset, worldOffset);
    return {
      x: body.position.x - worldOffset.x,
      y: body.position.y - worldOffset.y,
      z: body.position.z - worldOffset.z
    };
  }

  getBodyLavaSubmersionRatio(id: number): number {
    return this.#bodyRecords.get(id)?.lavaSubmersionRatio ?? 0;
  }

  getBodyIsInNativeFlowingFluid(id: number): boolean {
    return this.#bodyRecords.get(id)?.inNativeFlowingFluid === true;
  }

  setBodyBuoyancyPoints(id: number, points: readonly PhysicsBodyBuoyancyPoint[]): void {
    const record = this.#bodyRecords.get(id);
    if (!record) return;
    record.buoyancyPoints = normalizeBuoyancyPoints(points);
    record.buoyancyRelativeLocations = getBuoyancyRelativeLocations(
      record.buoyancyPoints,
      record.localCenterOfMass
    );
    record.buoyancyVolume = totalBuoyancyVolume(record.buoyancyPoints);
    record.lavaSubmersionRatio = 0;
  }

  setBodyCollider(id: number, colliderDefinition: PhysicsBodyCollider): void {
    const body = this.#cannonBodies.get(id);
    const record = this.#bodyRecords.get(id);
    if (!body || !record) return;
    const collider = normalizeBodyCollider({
      collider: colliderDefinition,
      location: this.getBodyLocation(id)
    });
    for (const shape of [...body.shapes]) body.removeShape(shape);
    for (const shapeDefinition of collider.shapes) {
      const shape = createCannonShape(shapeDefinition.primitive);
      shape.material = body.material;
      shape.collisionResponse = shapeDefinition.collisionResponse !== false;
      if (shapeDefinition.collisionTag !== undefined) {
        this.#collisionTagsByShape.set(shape, shapeDefinition.collisionTag);
      }
      body.addShape(
        shape,
        new Vec3(
          shapeDefinition.location.x - record.localCenterOfMass.x,
          shapeDefinition.location.y - record.localCenterOfMass.y,
          shapeDefinition.location.z - record.localCenterOfMass.z
        ),
        toCannonQuaternion(shapeDefinition.rotation)
      );
    }
    record.collider = collider;
    record.colliderLocalCenter = { ...collider.localCenter };
    record.halfExtents = { ...collider.boundingHalfExtents };
    record.indexedWorldSensorShapes = getIndexedWorldSensorShapes(collider);
    updateDynamicBodyMassProperties(body);
    body.aabbNeedsUpdate = true;
    body.wakeUp();
  }

  setBodyColliderIncrementally(id: number, colliderDefinition: PhysicsBodyCollider): void {
    const body = this.#cannonBodies.get(id);
    const record = this.#bodyRecords.get(id);
    if (!body || !record) return;
    if (
      body.shapes.length !== record.collider.shapes.length
      || body.shapeOffsets.length !== body.shapes.length
      || body.shapeOrientations.length !== body.shapes.length
    ) {
      throw new Error(`Body ${id} collider shape state is inconsistent.`);
    }

    const collider = normalizeBodyCollider({
      collider: colliderDefinition,
      location: this.getBodyLocation(id)
    });
    const existingIndicesBySignature = new Map<string, number[]>();
    for (let index = 0; index < record.collider.shapes.length; index++) {
      const signature = normalizedColliderShapeSignature(record.collider.shapes[index]!);
      let indices = existingIndicesBySignature.get(signature);
      if (!indices) {
        indices = [];
        existingIndicesBySignature.set(signature, indices);
      }
      indices.push(index);
    }

    const retainedIndices = new Set<number>();
    const nextDefinitions: NormalizedColliderShape[] = [];
    const nextShapes = [] as typeof body.shapes;
    const nextOffsets = [] as typeof body.shapeOffsets;
    const nextOrientations = [] as typeof body.shapeOrientations;
    for (const definition of collider.shapes) {
      const indices = existingIndicesBySignature.get(normalizedColliderShapeSignature(definition));
      const existingIndex = indices?.shift();
      if (existingIndex !== undefined) {
        retainedIndices.add(existingIndex);
        nextDefinitions.push(record.collider.shapes[existingIndex]!);
        nextShapes.push(body.shapes[existingIndex]!);
        nextOffsets.push(body.shapeOffsets[existingIndex]!);
        nextOrientations.push(body.shapeOrientations[existingIndex]!);
        continue;
      }

      const shape = createCannonShape(definition.primitive);
      shape.material = body.material;
      shape.collisionResponse = definition.collisionResponse !== false;
      if (definition.collisionTag !== undefined) {
        this.#collisionTagsByShape.set(shape, definition.collisionTag);
      }
      shape.body = body;
      nextDefinitions.push(definition);
      nextShapes.push(shape);
      nextOffsets.push(new Vec3(
        definition.location.x - record.localCenterOfMass.x,
        definition.location.y - record.localCenterOfMass.y,
        definition.location.z - record.localCenterOfMass.z
      ));
      nextOrientations.push(toCannonQuaternion(definition.rotation));
    }
    for (let index = 0; index < body.shapes.length; index++) {
      if (retainedIndices.has(index)) continue;
      const shape = body.shapes[index]!;
      this.#collisionTagsByShape.delete(shape);
      shape.body = null;
    }

    body.shapes.splice(0, body.shapes.length, ...nextShapes);
    body.shapeOffsets.splice(0, body.shapeOffsets.length, ...nextOffsets);
    body.shapeOrientations.splice(0, body.shapeOrientations.length, ...nextOrientations);
    record.collider = { ...collider, shapes: nextDefinitions };
    record.colliderLocalCenter = { ...collider.localCenter };
    record.halfExtents = { ...collider.boundingHalfExtents };
    record.indexedWorldSensorShapes = getIndexedWorldSensorShapes(record.collider);
    updateDynamicBodyMassProperties(body);
    body.updateBoundingRadius();
    body.aabbNeedsUpdate = true;
    body.wakeUp();
  }

  setBodyEnvironmentCollider(id: number, colliderDefinition: PhysicsBodyCollider): void {
    const record = this.#bodyRecords.get(id);
    if (!record) return;
    record.environmentCollider = normalizeBodyCollider({
      collider: colliderDefinition,
      location: this.getBodyLocation(id)
    });
    record.sleepEnvironmentSignature = undefined;
  }

  wakeBodiesNear(dimension: Dimension, location: Vector3, radius: number): number {
    const margin = Number.isFinite(radius) ? Math.max(0, radius) : 1;
    let count = 0;
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (!record || record.dimension.id !== dimension.id || body.sleepState !== Body.SLEEPING) {
        continue;
      }
      const bounds = getColliderWorldAabb(body, record, record.environmentCollider);
      if (
        location.x < bounds.min.x - margin
        || location.x > bounds.max.x + margin
        || location.y < bounds.min.y - margin
        || location.y > bounds.max.y + margin
        || location.z < bounds.min.z - margin
        || location.z > bounds.max.z + margin
      ) continue;
      body.wakeUp();
      count++;
    }
    return count;
  }

  invalidateWorldMesh(dimension: Dimension, location: Vector3, radius = 0): void {
    if (!this.#worldMeshCacheEnabled || !this.#worldMeshCache) return;
    const requestedMargin = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    if (requestedMargin === 0) {
      this.invalidateWorldMeshBatch(dimension, [location]);
      return;
    }
    const margin = requestedMargin + WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN;
    const minX = worldMeshChunkOrigin(location.x - margin);
    const maxX = worldMeshChunkOrigin(location.x + margin);
    const minY = worldMeshChunkOrigin(location.y - margin);
    const maxY = worldMeshChunkOrigin(location.y + margin);
    const minZ = worldMeshChunkOrigin(location.z - margin);
    const maxZ = worldMeshChunkOrigin(location.z + margin);
    for (let y = minY; y <= maxY; y += WORLD_MESH_CACHE_CHUNK_SIZE) {
      for (let z = minZ; z <= maxZ; z += WORLD_MESH_CACHE_CHUNK_SIZE) {
        for (let x = minX; x <= maxX; x += WORLD_MESH_CACHE_CHUNK_SIZE) {
          this.invalidateWorldMeshChunk(dimension, x, y, z);
        }
      }
    }
  }

  invalidateWorldMeshBatch(dimension: Dimension, locations: readonly Vector3[]): void {
    if (!this.#worldMeshCacheEnabled || !this.#worldMeshCache) return;
    const chunks = new Map<string, WorldMeshChunkRequest>();
    for (const location of locations) {
      if (!isFiniteVector3(location)) continue;
      const originX = worldMeshChunkOrigin(location.x);
      const originY = worldMeshChunkOrigin(location.y);
      const originZ = worldMeshChunkOrigin(location.z);
      addWorldMeshChunkRequest(chunks, dimension, originX, originY, originZ);
      addWorldMeshChunkRequest(
        chunks,
        dimension,
        worldMeshChunkOrigin(location.x - WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN),
        originY,
        originZ
      );
      addWorldMeshChunkRequest(
        chunks,
        dimension,
        worldMeshChunkOrigin(location.x + WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN),
        originY,
        originZ
      );
      addWorldMeshChunkRequest(
        chunks,
        dimension,
        originX,
        worldMeshChunkOrigin(location.y - WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN),
        originZ
      );
      addWorldMeshChunkRequest(
        chunks,
        dimension,
        originX,
        worldMeshChunkOrigin(location.y + WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN),
        originZ
      );
      addWorldMeshChunkRequest(
        chunks,
        dimension,
        originX,
        originY,
        worldMeshChunkOrigin(location.z - WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN)
      );
      addWorldMeshChunkRequest(
        chunks,
        dimension,
        originX,
        originY,
        worldMeshChunkOrigin(location.z + WORLD_MESH_CACHE_NEIGHBOR_DEPENDENCY_MARGIN)
      );
    }
    for (const request of chunks.values()) {
      this.invalidateWorldMeshChunk(
        request.dimension,
        request.originX,
        request.originY,
        request.originZ
      );
    }
  }

  getWorldMeshAuditCandidate(): CannonWorldMeshAuditCandidate | undefined {
    const candidate = this.findWorldMeshAuditCandidate(undefined, {
      playerPositionsByDimension: this.#worldMeshAuditCoordinator?.playerPositionsByDimension,
      sleepingSupportKeys: this.getSleepingSupportChunkKeys()
    });
    if (!candidate) return undefined;
    return candidate.candidate;
  }

  hasPendingWorldMeshBuilds(): boolean {
    return this.#worldMeshCacheEnabled
      && (
        this.#worldMeshHighPriorityQueue.size > 0
        || this.#worldMeshNormalPriorityQueue.size > 0
      );
  }

  updateBodyShapeOffset(id: number): void {
    const body = this.#cannonBodies.get(id);
    const record = this.#bodyRecords.get(id);
    if (!body || !record) return;
    for (let index = 0; index < record.collider.shapes.length; index++) {
      const shape = record.collider.shapes[index]!;
      body.shapeOffsets[index]?.set(
        shape.location.x - record.localCenterOfMass.x,
        shape.location.y - record.localCenterOfMass.y,
        shape.location.z - record.localCenterOfMass.z
      );
    }
    updateDynamicBodyMassProperties(body);
    body.updateBoundingRadius();
    body.aabbNeedsUpdate = true;
  }

  removeBody(id: number): void {
    const body = this.#cannonBodies.get(id);
    const record = this.#bodyRecords.get(id);
    if (record) this.clearBodyWorldMeshReferences(record);
    if (body) {
      // Removing a support does not wake sleeping bodies in Cannon. Preserve the
      // current contact set so directly supported bodies can resume simulation.
      const sleepingContacts = new Set<Body>();
      for (const contact of this.#world.contacts) {
        if (!contact.enabled) continue;
        const other = contact.bi === body
          ? contact.bj
          : contact.bj === body
            ? contact.bi
            : undefined;
        if (other?.type === Body.DYNAMIC && other.sleepState === Body.SLEEPING) {
          sleepingContacts.add(other);
        }
      }
      this.#world.removeBody(body);
      this.#handlesByCannonBody.delete(body);
      for (const other of sleepingContacts) {
        if (this.#handlesByCannonBody.has(other)) other.wakeUp();
      }
    }
    record?.entity?.remove();
    this.#bodies.delete(id);
    this.#cannonBodies.delete(id);
    this.#bodyRecords.delete(id);
  }

  setMaterialProperties(materialId: string, properties: PhysicsContactMaterialProperties): void {
    if (!materialId) return;
    const previous = this.#materialProperties.get(materialId) ?? DEFAULT_CONTACT_PROPERTIES;
    this.#materialProperties.set(materialId, {
      friction: normalizeContactFriction(properties.friction, previous.friction ?? 1),
      restitution: normalizeContactRestitution(properties.restitution, previous.restitution ?? 0)
    });
    this.rebuildContactMaterials();
  }

  getMaterialProperties(materialId: string): PhysicsContactMaterialProperties {
    return { ...(this.#materialProperties.get(materialId) ?? DEFAULT_CONTACT_PROPERTIES) };
  }

  getBlockProperties(block: { typeId?: string } | string): PhysicsBlockProperties {
    const typeId = typeof block === "string" ? block : block.typeId;
    if (!typeId) return {};
    return { ...(this.#blockProperties.get(typeId) ?? {}) };
  }

  isWorldBlockSensor(block: Block): boolean {
    return matchesWorldBlockSensorPredicate(block, this.#worldBlockSensorPredicate);
  }

  setWorldBlockSensorPredicate(predicate?: (block: Block) => boolean): void {
    this.#worldBlockSensorPredicate = predicate;
    this.clearWorldMeshCache();
    this.clearWorldBlockColliders();
    this.#worldColliderLayout = [];
  }

  setBlockProperties(block: { typeId?: string } | string, properties: PhysicsBlockProperties): void {
    this.setBlockPropertiesBatch([[block, properties]]);
  }

  setBlockPropertiesBatch(
    entries: readonly (readonly [block: { typeId?: string } | string, properties: PhysicsBlockProperties])[]
  ): void {
    let changed = false;
    for (const [block, properties] of entries) {
      const typeId = typeof block === "string" ? block : block.typeId;
      if (!typeId) continue;
      const mergedProperties = {
        ...(this.#blockProperties.get(typeId) ?? {}),
        ...properties
      };
      this.#blockProperties.set(typeId, mergedProperties);
      this.ensureWorldBlockMaterial(mergedProperties);
      changed = true;
    }
    if (changed) {
      this.clearWorldMeshCache();
      this.rebuildContactMaterials();
    }
  }

  step(): void {
    if (this.needsWorldColliderSync()) this.syncWorldBlockColliders();
    const shouldStepWorld = this.#beforeSubstepCallbacks.size > 0
      || this.hasAwakeDynamicBody();
    if (shouldStepWorld) {
      for (let index = 0; index < this.#tickSteps; index++) {
        for (const callback of this.#beforeSubstepCallbacks) callback();
        this.applyGravityScaleForces();
        this.applyBuoyancyForces();
        if (this.#indexedWorldSensorsEnabled) this.captureIndexedWorldSensorSweepStarts();
        this.#world.step(this.#fixedTimeStep, undefined, 1);
        if (this.#indexedWorldSensorsEnabled) this.emitIndexedWorldSensorCollisions();
      }
    }
    for (const body of this.#bodies.values()) body.writeTransform();
    this.#stepCount++;
    this.afterEvents.step.emit({
      currentTick: this.#stepCount,
      fixedTimeStep: this.#fixedTimeStep,
      runtime: this
    });
  }

  private hasAwakeDynamicBody(): boolean {
    for (const body of this.#cannonBodies.values()) {
      if (body.type === Body.DYNAMIC && body.sleepState !== Body.SLEEPING) return true;
    }
    return false;
  }

  private needsWorldColliderSync(): boolean {
    if (this.#worldColliderLayout.length > 0) return true;
    if (this.#worldMeshCacheEnabled) {
      if (this.#activeWorldMeshChunkKeys.size > 0) return true;
      if (
        this.#worldMeshHighPriorityQueue.size > 0
        || this.#worldMeshNormalPriorityQueue.size > 0
      ) return true;
      const audit = this.#worldMeshAuditCoordinator;
      if (
        audit
        && audit.targetDimensionId !== undefined
        && audit.targetChunkKey !== undefined
        && audit.currentTick - audit.lastAuditTick >= WORLD_MESH_CACHE_AUDIT_INTERVAL_TICKS
        && this.#worldMeshCache?.has(audit.targetChunkKey)
      ) return true;
      for (const [id, body] of this.#cannonBodies) {
        if (body.type !== Body.DYNAMIC) continue;
        if (body.sleepState !== Body.SLEEPING) return true;
        if (this.#bodyRecords.get(id)?.worldMeshChunks === undefined) return true;
      }
      return false;
    }
    for (const [id, body] of this.#cannonBodies) {
      if (body.type !== Body.DYNAMIC) continue;
      if (body.sleepState !== Body.SLEEPING) return true;
      const record = this.#bodyRecords.get(id);
      if (!record || record.sleepEnvironmentSignature === undefined) return true;
      if (
        (this.#stepCount + id) % WORLD_BLOCK_SLEEP_ENVIRONMENT_SCAN_INTERVAL_TICKS === 0
        || (this.#stepCount + id) % WORLD_BLOCK_SLEEP_SUPPORT_SCAN_INTERVAL_TICKS === 0
      ) return true;
    }
    return false;
  }

  writeBodyTransform(id: number): boolean {
    const body = this.#cannonBodies.get(id);
    const record = this.#bodyRecords.get(id);
    if (!body || !record || !record.entity?.isValid) return false;
    const location = this.getBodyLocation(id);
    const visualOffset = new Vec3(
      record.visualLocalOffset.x,
      record.visualLocalOffset.y,
      record.visualLocalOffset.z
    );
    body.quaternion.vmult(visualOffset, visualOffset);
    const visualX = location.x + visualOffset.x;
    const visualY = location.y + visualOffset.y;
    const visualZ = location.z + visualOffset.z;
    let wrote = false;
    if (
      !Number.isFinite(record.lastWrittenVisualX)
      || Math.abs(visualX - record.lastWrittenVisualX) >= TRANSFORM_POSITION_WRITE_THRESHOLD
      || Math.abs(visualY - record.lastWrittenVisualY) >= TRANSFORM_POSITION_WRITE_THRESHOLD
      || Math.abs(visualZ - record.lastWrittenVisualZ) >= TRANSFORM_POSITION_WRITE_THRESHOLD
    ) {
      record.entity.teleport({ x: visualX, y: visualY, z: visualZ });
      record.lastWrittenVisualX = visualX;
      record.lastWrittenVisualY = visualY;
      record.lastWrittenVisualZ = visualZ;
      wrote = true;
    }
    const reference = Number.isFinite(record.lastWrittenPitch)
      && Number.isFinite(record.lastWrittenYaw)
      && Number.isFinite(record.lastWrittenRoll)
      ? {
          x: record.lastWrittenPitch,
          y: record.lastWrittenYaw,
          z: record.lastWrittenRoll
        }
      : undefined;
    const rotation = quaternionToContinuousEulerDegreesYzx(body.quaternion, reference);
    const pitch = rotation.x;
    const yaw = rotation.y;
    const roll = rotation.z;
    const propertyMap = DEFAULT_VISUAL_PROPERTY_MAP;
    if (
      !Number.isFinite(record.lastWrittenPitch)
      || Math.abs(pitch - record.lastWrittenPitch) >= TRANSFORM_ROTATION_WRITE_THRESHOLD_DEGREES
    ) {
      record.entity.setProperty(propertyMap.pitch, pitch);
      record.lastWrittenPitch = pitch;
      wrote = true;
    }
    if (
      !Number.isFinite(record.lastWrittenYaw)
      || Math.abs(yaw - record.lastWrittenYaw) >= TRANSFORM_ROTATION_WRITE_THRESHOLD_DEGREES
    ) {
      record.entity.setProperty(propertyMap.yaw, yaw);
      record.lastWrittenYaw = yaw;
      wrote = true;
    }
    if (
      !Number.isFinite(record.lastWrittenRoll)
      || Math.abs(roll - record.lastWrittenRoll) >= TRANSFORM_ROTATION_WRITE_THRESHOLD_DEGREES
    ) {
      record.entity.setProperty(propertyMap.roll, roll);
      record.lastWrittenRoll = roll;
      wrote = true;
    }
    return wrote;
  }

  private emitCollision(
    handle: CannonKernelBody,
    body: Body,
    event: CannonCollideEvent
  ): void {
    const contact = event.contact;
    const bodyIsA = contact.bi === body;
    const contactBody = bodyIsA ? contact.bi : contact.bj;
    const offset = bodyIsA ? contact.ri : contact.rj;
    const normalScale = bodyIsA ? 1 : -1;
    const ownShape = bodyIsA ? contact.si : contact.sj;
    const otherShape = bodyIsA ? contact.sj : contact.si;
    this.emitCollisionAfterEvent({
      body: handle,
      collisionTag: this.#collisionTagsByShape.get(ownShape),
      currentTick: this.#stepCount + 1,
      impactSpeed: Math.abs(contact.getImpactVelocityAlongNormal()),
      normal: {
        x: contact.ni.x * normalScale,
        y: contact.ni.y * normalScale,
        z: contact.ni.z * normalScale
      },
      otherBody: this.#handlesByCannonBody.get(event.body),
      otherCollisionTag: this.#collisionTagsByShape.get(otherShape),
      point: {
        x: contactBody.position.x + offset.x,
        y: contactBody.position.y + offset.y,
        z: contactBody.position.z + offset.z
      }
    });
  }

  private emitCollisionAfterEvent(event: CannonKernelCollisionAfterEvent): void {
    this.afterEvents.collision.emit(event);
  }

  private captureIndexedWorldSensorSweepStarts(): void {
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (
        !record
        || body.type !== Body.DYNAMIC
        || body.sleepState === Body.SLEEPING
        || record.worldMeshChunksActive !== true
      ) {
        if (record) record.worldSensorSweepPending = false;
        continue;
      }
      record.worldSensorSweepStartPosition.copy(body.position);
      record.worldSensorSweepStartQuaternion.copy(body.quaternion);
      record.worldSensorSweepStartVelocity.copy(body.velocity);
      record.worldSensorSweepStartAngularVelocity.copy(body.angularVelocity);
      record.worldSensorSweepPending = true;
    }
  }

  private emitIndexedWorldSensorCollisions(): void {
    const cache = this.#worldMeshCache;
    if (!cache) return;
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (!record?.worldSensorSweepPending) continue;
      record.worldSensorSweepPending = false;
      const handle = this.#bodies.get(id);
      const sensorShapes = record.indexedWorldSensorShapes;
      const retainedChunkKeys = record.worldMeshChunks;
      if (!handle || !sensorShapes || !retainedChunkKeys) continue;
      let hits: CannonKernelIndexedWorldSensorHit[] | undefined;
      for (let shapeIndex = 0; shapeIndex < sensorShapes.length; shapeIndex++) {
        const shape = sensorShapes[shapeIndex]!;
        const sweep = createIndexedWorldSensorSweep(
          shape,
          record.localCenterOfMass,
          record.worldSensorSweepStartPosition,
          record.worldSensorSweepStartQuaternion,
          body.position,
          body.quaternion
        );
        for (const key of getIndexedWorldSensorCandidateChunkKeys(
          record.dimension.id,
          sweep.bounds,
          retainedChunkKeys
        )) {
          const chunk = cache.get(key);
          if (!chunk || !integerBoundsOverlap(sweep.bounds, chunk.bounds)) continue;
          const visitMark = ++this.#indexedWorldSensorVisitMark;
          const minBinX = worldSensorBinCoordinate(sweep.bounds.minX, chunk.bounds.minX);
          const minBinY = worldSensorBinCoordinate(sweep.bounds.minY, chunk.bounds.minY);
          const minBinZ = worldSensorBinCoordinate(sweep.bounds.minZ, chunk.bounds.minZ);
          const maxBinX = worldSensorBinCoordinate(sweep.bounds.maxX, chunk.bounds.minX);
          const maxBinY = worldSensorBinCoordinate(sweep.bounds.maxY, chunk.bounds.minY);
          const maxBinZ = worldSensorBinCoordinate(sweep.bounds.maxZ, chunk.bounds.minZ);
          for (let binY = minBinY; binY <= maxBinY; binY++) {
            for (let binZ = minBinZ; binZ <= maxBinZ; binZ++) {
              for (let binX = minBinX; binX <= maxBinX; binX++) {
                const candidates = chunk.indexedSensorBoxBins[
                  worldSensorBinIndex(binX, binY, binZ)
                ];
                if (!candidates) continue;
                for (const sensorBoxIndex of candidates) {
                  if (chunk.indexedSensorBoxVisitMarks[sensorBoxIndex] === visitMark) continue;
                  chunk.indexedSensorBoxVisitMarks[sensorBoxIndex] = visitMark;
                  const sensorBox = chunk.indexedSensorBoxes[sensorBoxIndex]!;
                  if (!integerBoundsOverlapGreedyBox(sweep.bounds, sensorBox)) continue;
                  const contact = findIndexedWorldSensorContact(sweep.samples, sensorBox);
                  if (!contact) continue;
                  const time = contact.time;
                  const velocityX = lerp(
                    record.worldSensorSweepStartVelocity.x,
                    body.velocity.x,
                    time
                  );
                  const velocityY = lerp(
                    record.worldSensorSweepStartVelocity.y,
                    body.velocity.y,
                    time
                  );
                  const velocityZ = lerp(
                    record.worldSensorSweepStartVelocity.z,
                    body.velocity.z,
                    time
                  );
                  const angularX = lerp(
                    record.worldSensorSweepStartAngularVelocity.x,
                    body.angularVelocity.x,
                    time
                  );
                  const angularY = lerp(
                    record.worldSensorSweepStartAngularVelocity.y,
                    body.angularVelocity.y,
                    time
                  );
                  const angularZ = lerp(
                    record.worldSensorSweepStartAngularVelocity.z,
                    body.angularVelocity.z,
                    time
                  );
                  const relativeX = contact.pointX - contact.bodyX;
                  const relativeY = contact.pointY - contact.bodyY;
                  const relativeZ = contact.pointZ - contact.bodyZ;
                  const pointVelocityX = velocityX
                    + angularY * relativeZ - angularZ * relativeY;
                  const pointVelocityY = velocityY
                    + angularZ * relativeX - angularX * relativeZ;
                  const pointVelocityZ = velocityZ
                    + angularX * relativeY - angularY * relativeX;
                  const point = {
                    x: contact.pointX,
                    y: contact.pointY,
                    z: contact.pointZ
                  };
                  (hits ??= []).push({
                    collisionTag: shape.collisionTag,
                    impactSpeed: Math.abs(
                      pointVelocityX * contact.normalX
                      + pointVelocityY * contact.normalY
                      + pointVelocityZ * contact.normalZ
                    ),
                    normal: {
                      x: contact.normalX,
                      y: contact.normalY,
                      z: contact.normalZ
                    },
                    point,
                    worldBlockLocation: {
                      x: Math.floor(point.x),
                      y: Math.floor(point.y),
                      z: Math.floor(point.z)
                    }
                  });
                }
              }
            }
          }
        }
      }
      if (!hits) continue;
      let representative = hits[0]!;
      for (let index = 1; index < hits.length; index++) {
        const candidate = hits[index]!;
        if (candidate.impactSpeed > representative.impactSpeed) representative = candidate;
      }
      this.emitCollisionAfterEvent({
        body: handle,
        collisionTag: representative.collisionTag,
        currentTick: this.#stepCount + 1,
        impactSpeed: representative.impactSpeed,
        indexedWorldSensorHits: hits,
        normal: representative.normal,
        point: representative.point
      });
      if (!handle.isValid) return;
    }
  }

  private getOrCreateMaterial(materialId: string): Material {
    let material = this.#materials.get(materialId);
    if (!material) {
      material = new Material(materialId);
      this.#materials.set(materialId, material);
    }
    return material;
  }

  private applyGravityScaleForces(): void {
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (!record || body.type !== Body.DYNAMIC || record.gravityScale === 1) continue;
      const scale = record.gravityScale - 1;
      body.force.x += body.mass * this.#world.gravity.x * scale;
      body.force.y += body.mass * this.#world.gravity.y * scale;
      body.force.z += body.mass * this.#world.gravity.z * scale;
    }
  }

  private applyBuoyancyForces(): void {
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (
        !record
        || body.type !== Body.DYNAMIC
        || body.sleepState === Body.SLEEPING
      ) continue;
      if (record.buoyancyPoints.length === 0) {
        clearActiveBodyFluidState(record);
        continue;
      }
      const surfaces = this.#fluidSurfacesByDimension.get(record.dimension);
      if (!surfaces || surfaces.size === 0) {
        clearActiveBodyFluidState(record);
        continue;
      }

      const collectWaterEntry = !record.inWater;
      const collectLavaEntry = !record.inLava && record.lavaEntryRearmTicks === 0;
      let inWater = false;
      let inLava = false;
      let inNativeFlowingFluid = false;
      let lavaSubmergedVolume = 0;
      let waterContactCount = 0;
      let waterFastestContactVelocityY = Number.POSITIVE_INFINITY;
      let waterMaxContactX = Number.NEGATIVE_INFINITY;
      let waterMaxContactZ = Number.NEGATIVE_INFINITY;
      let waterMinContactX = Number.POSITIVE_INFINITY;
      let waterMinContactZ = Number.POSITIVE_INFINITY;
      let waterContactX = 0;
      let waterContactZ = 0;
      let waterContactSurfaceY = 0;
      let lavaContactCount = 0;
      let lavaFastestContactVelocityY = Number.POSITIVE_INFINITY;
      let lavaMaxContactX = Number.NEGATIVE_INFINITY;
      let lavaMaxContactZ = Number.NEGATIVE_INFINITY;
      let lavaMinContactX = Number.POSITIVE_INFINITY;
      let lavaMinContactZ = Number.POSITIVE_INFINITY;
      let lavaContactX = 0;
      let lavaContactZ = 0;
      let lavaContactSurfaceY = 0;

      for (let sampleIndex = 0; sampleIndex < record.buoyancyPoints.length; sampleIndex++) {
        const sample = record.buoyancyPoints[sampleIndex]!;
        const cachedRelative = record.buoyancyRelativeLocations[sampleIndex]!;
        const relative = this.#buoyancyRelative;
        relative.set(cachedRelative.x, cachedRelative.y, cachedRelative.z);
        body.quaternion.vmult(relative, relative);
        const point = this.#buoyancyPoint;
        point.set(
          body.position.x + relative.x,
          body.position.y + relative.y,
          body.position.z + relative.z
        );
        const blockX = Math.floor(point.x);
        const blockY = Math.floor(point.y);
        const blockZ = Math.floor(point.z);
        // Each buoyancy sample spans a half block below its point, so submersion
        // is measured against [pointY - 0.5, pointY] and both straddled blocks
        // are probed.
        const lowerBlockY = Math.floor(point.y - 0.5);
        const upperSurface = surfaces.get(`${blockX},${blockY},${blockZ}`);
        const lowerSurface = surfaces.get(`${blockX},${lowerBlockY},${blockZ}`);
        inNativeFlowingFluid ||= sampleTouchesNativeFlowingFluid(point.y, upperSurface)
          || sampleTouchesNativeFlowingFluid(point.y, lowerSurface);
        const surface = !upperSurface
          ? lowerSurface
          : !lowerSurface || upperSurface.surfaceY >= lowerSurface.surfaceY
            ? upperSurface
            : lowerSurface;
        if (!surface) continue;
        const submergedFraction = Math.min(
          1,
          Math.max(0, surface.surfaceY - (point.y - 0.5))
        );
        if (submergedFraction <= 0) continue;
        const displacedVolume = sample.volume * submergedFraction;
        const pointVelocity = this.#buoyancyPointVelocity;
        body.getVelocityAtWorldPoint(point, pointVelocity);
        if (isWaterFluidType(surface.typeId)) {
          inWater = true;
          if (collectWaterEntry) {
            waterContactCount++;
            waterFastestContactVelocityY = Math.min(
              waterFastestContactVelocityY,
              pointVelocity.y
            );
            waterMaxContactX = Math.max(waterMaxContactX, point.x);
            waterMaxContactZ = Math.max(waterMaxContactZ, point.z);
            waterMinContactX = Math.min(waterMinContactX, point.x);
            waterMinContactZ = Math.min(waterMinContactZ, point.z);
            waterContactX += point.x;
            waterContactZ += point.z;
            waterContactSurfaceY += surface.surfaceY;
          }
        } else if (isLavaFluidType(surface.typeId)) {
          inLava = true;
          lavaSubmergedVolume += displacedVolume;
          if (collectLavaEntry) {
            lavaContactCount++;
            lavaFastestContactVelocityY = Math.min(
              lavaFastestContactVelocityY,
              pointVelocity.y
            );
            lavaMaxContactX = Math.max(lavaMaxContactX, point.x);
            lavaMaxContactZ = Math.max(lavaMaxContactZ, point.z);
            lavaMinContactX = Math.min(lavaMinContactX, point.x);
            lavaMinContactZ = Math.min(lavaMinContactZ, point.z);
            lavaContactX += point.x;
            lavaContactZ += point.z;
            lavaContactSurfaceY += surface.surfaceY;
          }
        }
        const force = this.#buoyancyForce;
        force.set(
          -this.#world.gravity.x * displacedVolume * DEFAULT_FLUID_DENSITY
            - pointVelocity.x * DEFAULT_FLUID_DRAG * displacedVolume,
          -this.#world.gravity.y * displacedVolume * DEFAULT_FLUID_DENSITY
            - pointVelocity.y * DEFAULT_FLUID_DRAG * displacedVolume,
          -this.#world.gravity.z * displacedVolume * DEFAULT_FLUID_DENSITY
            - pointVelocity.z * DEFAULT_FLUID_DRAG * displacedVolume
        );
        body.applyForce(force, relative);
      }
      record.inWater = inWater;
      record.inLava = inLava;
      record.inNativeFlowingFluid = inNativeFlowingFluid;
      record.lavaEntryRearmTicks = inLava
        ? LAVA_ENTRY_REARM_TICKS
        : Math.max(0, record.lavaEntryRearmTicks - 1);
      record.lavaSubmersionRatio = record.buoyancyVolume > 0
        ? Math.min(1, lavaSubmergedVolume / record.buoyancyVolume)
        : 0;
      if (
        (collectWaterEntry && inWater && waterContactCount > 0)
        || (collectLavaEntry && inLava && lavaContactCount > 0)
      ) {
        const handle = this.#bodies.get(id);
        if (!handle) continue;
        if (collectWaterEntry && inWater && waterContactCount > 0) {
          this.afterEvents.waterEntry.emit({
            body: handle,
            fastestContactVelocityY: waterFastestContactVelocityY,
            maxContactX: waterMaxContactX,
            maxContactZ: waterMaxContactZ,
            minContactX: waterMinContactX,
            minContactZ: waterMinContactZ,
            point: {
              x: waterContactX / waterContactCount,
              // Splash point is lifted just above the averaged fluid surface.
              y: waterContactSurfaceY / waterContactCount + 0.02,
              z: waterContactZ / waterContactCount
            },
            timeStep: this.#fixedTimeStep * this.#tickSteps,
            bodyAabbSizeX: body.aabb.upperBound.x - body.aabb.lowerBound.x,
            bodyAabbSizeZ: body.aabb.upperBound.z - body.aabb.lowerBound.z,
          });
        }
        if (collectLavaEntry && inLava && lavaContactCount > 0) {
          this.afterEvents.lavaEntry.emit({
            body: handle,
            fastestContactVelocityY: lavaFastestContactVelocityY,
            maxContactX: lavaMaxContactX,
            maxContactZ: lavaMaxContactZ,
            minContactX: lavaMinContactX,
            minContactZ: lavaMinContactZ,
            point: {
              x: lavaContactX / lavaContactCount,
              // Splash point is lifted just above the averaged fluid surface.
              y: lavaContactSurfaceY / lavaContactCount + 0.02,
              z: lavaContactZ / lavaContactCount
            },
            timeStep: this.#fixedTimeStep * this.#tickSteps,
            bodyAabbSizeX: body.aabb.upperBound.x - body.aabb.lowerBound.x,
            bodyAabbSizeZ: body.aabb.upperBound.z - body.aabb.lowerBound.z,
          });
        }
      }
    }
  }

  private addWorldColliderBox(key: string, box: GreedyBox): void {
    const halfExtents = new Vec3(
      normalizeHalfExtent(box.sizeX / 2),
      normalizeHalfExtent(box.sizeY / 2),
      normalizeHalfExtent(box.sizeZ / 2)
    );
    const body = new Body({
      mass: 0,
      material: this.getOrCreateMaterial(box.materialId),
      position: new Vec3(
        box.minX + halfExtents.x,
        box.minY + halfExtents.y,
        box.minZ + halfExtents.z
      ),
      type: Body.STATIC
    });
    const shape = new Box(halfExtents);
    shape.collisionResponse = box.collisionResponse;
    body.addShape(shape);
    body.updateMassProperties();
    this.#world.addBody(body);
    this.#worldColliderBodies.set(key, body);
  }

  private clearWorldBlockColliders(): void {
    for (const body of this.#worldColliderBodies.values()) {
      this.#world.removeBody(body);
    }
    this.#worldColliderBodies.clear();
  }

  private clearWorldMeshCache(): void {
    const cache = this.#worldMeshCache;
    if (cache) {
      for (const key of this.#activeWorldMeshChunkKeys) {
        const chunk = cache.get(key);
        if (chunk) this.detachWorldMeshChunk(chunk);
      }
      cache.clear();
    }
    this.#activeWorldMeshChunkKeys.clear();
    this.#activeWorldMeshChunkReferenceCounts.clear();
    this.#worldMeshChunkReferenceCounts.clear();
    this.#worldMeshHighPriorityQueue.clear();
    this.#worldMeshNormalPriorityQueue.clear();
    this.#indexedWorldSensorsEnabled = false;
    this.#indexedWorldSensorVisitMark = 0;
    this.#lastWorldMeshPruneTick = this.#stepCount;
    for (const record of this.#bodyRecords.values()) {
      record.worldFluidMeshChunks = undefined;
      record.worldFluidMeshRegionSignature = undefined;
      record.worldMeshChunks = undefined;
      record.worldMeshChunksActive = undefined;
      record.worldMeshRegionSignature = undefined;
    }
  }

  private detachWorldMeshChunk(chunk: CachedWorldMeshChunk): void {
    if (chunk.body) {
      this.#world.removeBody(chunk.body);
    }
    this.detachWorldMeshChunkSensorBody(chunk);
  }

  private rebuildContactMaterials(): void {
    for (const contactMaterial of [...this.#world.contactmaterials]) {
      this.#world.removeContactMaterial(contactMaterial);
    }
    this.#contactMaterials.clear();
    this.#contactMaterialIds.clear();
    const materialIds = [
      "default",
      "world_block",
      ...this.#materialProperties.keys(),
      ...Array.from(this.#bodyRecords.values(), (record) => record.materialId),
      ...Array.from(this.#blockProperties.values(), (properties) =>
        this.ensureWorldBlockMaterial(properties)
      )
    ];
    const uniqueIds = [...new Set(materialIds)];
    for (const materialId of uniqueIds) this.#contactMaterialIds.add(materialId);
    for (let leftIndex = 0; leftIndex < uniqueIds.length; leftIndex++) {
      for (let rightIndex = leftIndex; rightIndex < uniqueIds.length; rightIndex++) {
        const leftId = uniqueIds[leftIndex]!;
        const rightId = uniqueIds[rightIndex]!;
        const left = this.#materialProperties.get(leftId) ?? DEFAULT_CONTACT_PROPERTIES;
        const right = this.#materialProperties.get(rightId) ?? DEFAULT_CONTACT_PROPERTIES;
        this.#world.addContactMaterial(new ContactMaterial(
          this.getOrCreateMaterial(leftId),
          this.getOrCreateMaterial(rightId),
          {
            contactEquationRelaxation: DEFAULT_CONTACT_RELAXATION,
            contactEquationStiffness: DEFAULT_CONTACT_STIFFNESS,
            friction: SABLE_BASE_CONTACT_FRICTION
              * (left.friction ?? 1)
              * (right.friction ?? 1),
            frictionEquationRelaxation: DEFAULT_CONTACT_RELAXATION,
            frictionEquationStiffness: DEFAULT_CONTACT_STIFFNESS,
            restitution: Math.max(left.restitution ?? 0, right.restitution ?? 0)
          }
        ));
        this.#contactMaterials.add(makeContactMaterialKey(leftId, rightId));
      }
    }
  }

  private ensureWorldBlockMaterial(properties: PhysicsBlockProperties): string {
    const materialId = getWorldBlockMaterialIdFromProperties(properties);
    if (materialId === "world_block") return materialId;
    if (!this.#materialProperties.has(materialId)) {
      this.#materialProperties.set(materialId, {
        friction: normalizeContactFriction(
          properties.friction,
          DEFAULT_SOLID_BLOCK_FRICTION
        ),
        restitution: normalizeContactRestitution(
          properties.restitution,
          DEFAULT_SOLID_BLOCK_RESTITUTION
        )
      });
    }
    return materialId;
  }

  private syncWorldBlockColliders(): void {
    if (this.#worldMeshCacheEnabled) {
      this.syncCachedWorldBlockColliders();
      return;
    }
    this.#worldMeshAuditScansThisTick = 0;
    this.#fluidSurfacesByDimension.clear();
    const clustersByDimension = new Map<Dimension, ScanBoundsCluster[]>();
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (!record) continue;
      if (body.type !== Body.DYNAMIC) continue;
      if (body.sleepState === Body.SLEEPING) {
        record.worldFluidMeshChunks = undefined;
        record.worldMeshChunks = undefined;
        const shouldScanEnvironment = record.sleepEnvironmentSignature === undefined
          || (this.#stepCount + id) % WORLD_BLOCK_SLEEP_ENVIRONMENT_SCAN_INTERVAL_TICKS === 0;
        if (shouldScanEnvironment) {
          const environment = scanSleepingEnvironment(
            record.dimension,
            getSleepingEnvironmentScanCluster(body, record),
            this.#blockProperties,
            this.#worldBlockSensorPredicate
          );
          if (
            record.sleepEnvironmentSignature !== undefined
            && record.sleepEnvironmentSignature !== environment.signature
          ) {
            record.sleepEnvironmentSignature = undefined;
            body.wakeUp();
            body.updateAABB();
            addPredictedShapeScanClusters(
              clustersByDimension,
              record.dimension,
              body,
              record,
              this.#fixedTimeStep,
              this.#tickSteps
            );
            continue;
          }
          record.sleepEnvironmentSignature = environment.signature;
        }
        if (
          (this.#stepCount + id) % WORLD_BLOCK_SLEEP_SUPPORT_SCAN_INTERVAL_TICKS === 0
        ) {
          const supportBounds = getSleepingSupportBlockScanBounds(body);
          const hasSupport = findWorldSupportInBounds(
            record.dimension,
            supportBounds,
            this.#blockProperties,
            this.#worldBlockSensorPredicate
          );
          if (!hasSupport) {
            record.sleepEnvironmentSignature = undefined;
            body.wakeUp();
            addScanBoundsCluster(clustersByDimension, record.dimension, supportBounds);
          }
        }
        continue;
      }
      record.sleepEnvironmentSignature = undefined;
      body.updateAABB();
      record.worldFluidMeshChunks = undefined;
      record.worldMeshChunks = undefined;
      addPredictedShapeScanClusters(
        clustersByDimension,
        record.dimension,
        body,
        record,
        this.#fixedTimeStep,
        this.#tickSteps
      );
    }
    const fullyScannedCoverageByDimension = new Map<Dimension, WorldScanCoverage[]>();
    let shadowFilteredScansByDimension: Map<Dimension, AppliedShadowScan[]> | undefined;
    const nextColliderLayout: GreedyBox[] = [];
    for (const [dimension, clusters] of clustersByDimension) {
      const coverages: WorldScanCoverage[] = [];
      fullyScannedCoverageByDimension.set(dimension, coverages);
      for (const cluster of clusters) {
        const scan = scanWorldSolidBlocks(
          dimension,
          cluster,
          this.#blockProperties,
          this.#worldBlockSensorPredicate
        );
        if (scan.shadowApplied && cluster.shadowShapes) {
          shadowFilteredScansByDimension ??= new Map();
          let filteredScans = shadowFilteredScansByDimension.get(dimension);
          if (!filteredScans) {
            filteredScans = [];
            shadowFilteredScansByDimension.set(dimension, filteredScans);
          }
          filteredScans.push({ coverage: scan.coverage, shapes: cluster.shadowShapes });
        } else {
          coverages.push(scan.coverage);
        }
        let fluidSurfaces = this.#fluidSurfacesByDimension.get(dimension);
        if (!fluidSurfaces) {
          fluidSurfaces = new Map();
          this.#fluidSurfacesByDimension.set(dimension, fluidSurfaces);
        }
        for (const fluid of scan.fluids) {
          fluidSurfaces.set(`${fluid.x},${fluid.y},${fluid.z}`, fluid);
        }
        nextColliderLayout.push(...scan.boxes);
      }
    }
    sortGreedyBoxes(nextColliderLayout);
    if (!greedyBoxLayoutsEqual(this.#worldColliderLayout, nextColliderLayout)) {
      const nextColliderKeys = createWorldColliderKeys(nextColliderLayout);
      const retainedKeys = new Set(nextColliderKeys);
      for (const [key, body] of this.#worldColliderBodies) {
        if (retainedKeys.has(key)) continue;
        this.#world.removeBody(body);
        this.#worldColliderBodies.delete(key);
      }
      for (let index = 0; index < nextColliderLayout.length; index++) {
        const key = nextColliderKeys[index]!;
        if (this.#worldColliderBodies.has(key)) continue;
        this.addWorldColliderBox(key, nextColliderLayout[index]!);
      }
      this.#worldColliderLayout = nextColliderLayout;
    }
    const buoyancyQueriesByDimension = new Map<Dimension, Set<string>>();
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (
        !record
        || body.type !== Body.DYNAMIC
        || body.sleepState === Body.SLEEPING
        || record.buoyancyPoints.length === 0
      ) continue;
      let fluidSurfaces = this.#fluidSurfacesByDimension.get(record.dimension);
      if (!fluidSurfaces) {
        fluidSurfaces = new Map();
        this.#fluidSurfacesByDimension.set(record.dimension, fluidSurfaces);
      }
      let queried = buoyancyQueriesByDimension.get(record.dimension);
      if (!queried) {
        queried = new Set();
        buoyancyQueriesByDimension.set(record.dimension, queried);
      }
      for (const cachedRelative of record.buoyancyRelativeLocations) {
        const relative = this.#buoyancyRelative;
        relative.set(cachedRelative.x, cachedRelative.y, cachedRelative.z);
        body.quaternion.vmult(relative, relative);
        const pointX = body.position.x + relative.x;
        const pointY = body.position.y + relative.y;
        const pointZ = body.position.z + relative.z;
        const blockX = Math.floor(pointX);
        const blockZ = Math.floor(pointZ);
        const upperY = Math.floor(pointY);
        const lowerY = Math.floor(pointY - 0.5);
        const location = { x: blockX, y: upperY, z: blockZ };
        const sampleCount = upperY === lowerY ? 1 : 2;
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
          location.y = sampleIndex === 0 ? upperY : lowerY;
          const key = `${location.x},${location.y},${location.z}`;
          if (
            fluidSurfaces.has(key)
            || queried.has(key)
            || isCoveredByWorldScans(
              fullyScannedCoverageByDimension.get(record.dimension),
              location
            )
            || isCoveredByAppliedShadowScans(
              shadowFilteredScansByDimension?.get(record.dimension),
              location
            )
          ) continue;
          queried.add(key);
          const block = safeGetBlock(record.dimension, location);
          if (block && isPhysicsFluidBlock(block)) {
            fluidSurfaces.set(key, createFluidSurface(block, location.y));
          }
        }
      }
    }
  }

  private updateIndexedWorldSensorMode(): void {
    let nextEnabled = true;
    for (const [id, body] of this.#cannonBodies) {
      if (body.type === Body.STATIC || body.sleepState === Body.SLEEPING) continue;
      const record = this.#bodyRecords.get(id);
      if (record?.indexedWorldSensorShapes === undefined) {
        nextEnabled = false;
        break;
      }
    }
    if (nextEnabled === this.#indexedWorldSensorsEnabled) return;
    this.#indexedWorldSensorsEnabled = nextEnabled;
    for (const key of this.#activeWorldMeshChunkKeys) {
      const chunk = this.#worldMeshCache?.get(key);
      if (!chunk) continue;
      if (nextEnabled) this.detachWorldMeshChunkSensorBody(chunk);
      else this.attachWorldMeshChunkSensorBody(chunk);
    }
  }

  private syncCachedWorldBlockColliders(): void {
    this.#worldMeshAuditScansThisTick = 0;
    this.updateIndexedWorldSensorMode();
    if (this.#stepCount - this.#lastWorldMeshPruneTick >= 20) {
      this.pruneWorldMeshCache();
      this.#lastWorldMeshPruneTick = this.#stepCount;
    }
    this.#fluidSurfacesByDimension.clear();

    const clustersByDimension = new Map<Dimension, ScanBoundsCluster[]>();
    const fluidSampleLocationsByBody = new Map<number, readonly Vector3[]>();
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (!record || body.type !== Body.DYNAMIC) continue;
      if (body.sleepState === Body.SLEEPING) {
        record.sleepEnvironmentSignature = undefined;
        this.updateBodyWorldFluidMeshRegion(record, EMPTY_WORLD_MESH_CHUNKS);
        this.updateBodyWorldMeshRegion(
          record,
          getSleepingEnvironmentScanCluster(body, record).bounds,
          false
        );
        continue;
      }

      record.sleepEnvironmentSignature = undefined;
      body.updateAABB();
      const predictedBounds = getPredictedWorldMeshBounds(
        body,
        record,
        this.#fixedTimeStep,
        this.#tickSteps
      );
      this.updateBodyWorldMeshRegion(record, predictedBounds, true);
      const fluidSampleLocations = this.getBodyFluidSampleLocations(body, record);
      fluidSampleLocationsByBody.set(id, fluidSampleLocations);
      const fluidRequests = new Map<string, WorldMeshChunkRequest>();
      for (const location of fluidSampleLocations) {
        const request = worldMeshChunkRequest(record.dimension, location);
        fluidRequests.set(worldMeshChunkRequestKey(request), request);
      }
      this.updateBodyWorldFluidMeshRegion(record, fluidRequests);
      if (this.bodyHasMissingWorldMeshChunks(record)) {
        addPredictedShapeScanClusters(
          clustersByDimension,
          record.dimension,
          body,
          record,
          this.#fixedTimeStep,
          this.#tickSteps
        );
      }
    }

    this.processWorldMeshBuildQueues();
    if (!this.hasPendingWorldMeshBuilds()) {
      this.auditWorldMeshCache();
    }

    const fullyScannedCoverageByDimension = new Map<Dimension, WorldScanCoverage[]>();
    let shadowFilteredScansByDimension: Map<Dimension, AppliedShadowScan[]> | undefined;
    const nextColliderLayout: GreedyBox[] = [];
    const cache = this.#worldMeshCache!;
    for (const [dimension, clusters] of clustersByDimension) {
      const coverages: WorldScanCoverage[] = [];
      fullyScannedCoverageByDimension.set(dimension, coverages);
      const missingClusters = getMissingWorldMeshScanClusters(dimension, clusters, cache);
      for (const cluster of missingClusters) {
        const scan = scanWorldSolidBlocks(
          dimension,
          cluster,
          this.#blockProperties,
          this.#worldBlockSensorPredicate
        );
        if (scan.shadowApplied && cluster.shadowShapes) {
          shadowFilteredScansByDimension ??= new Map();
          let filteredScans = shadowFilteredScansByDimension.get(dimension);
          if (!filteredScans) {
            filteredScans = [];
            shadowFilteredScansByDimension.set(dimension, filteredScans);
          }
          filteredScans.push({ coverage: scan.coverage, shapes: cluster.shadowShapes });
        } else {
          coverages.push(scan.coverage);
        }
        let fluidSurfaces = this.#fluidSurfacesByDimension.get(dimension);
        if (!fluidSurfaces) {
          fluidSurfaces = new Map();
          this.#fluidSurfacesByDimension.set(dimension, fluidSurfaces);
        }
        for (const fluid of scan.fluids) {
          fluidSurfaces.set(`${fluid.x},${fluid.y},${fluid.z}`, fluid);
        }
        nextColliderLayout.push(...scan.boxes);
      }
    }

    sortGreedyBoxes(nextColliderLayout);
    if (!greedyBoxLayoutsEqual(this.#worldColliderLayout, nextColliderLayout)) {
      const nextColliderKeys = createWorldColliderKeys(nextColliderLayout);
      const retainedKeys = new Set(nextColliderKeys);
      for (const [key, body] of this.#worldColliderBodies) {
        if (retainedKeys.has(key)) continue;
        this.#world.removeBody(body);
        this.#worldColliderBodies.delete(key);
      }
      for (let index = 0; index < nextColliderLayout.length; index++) {
        const key = nextColliderKeys[index]!;
        if (this.#worldColliderBodies.has(key)) continue;
        this.addWorldColliderBox(key, nextColliderLayout[index]!);
      }
      this.#worldColliderLayout = nextColliderLayout;
    }

    const buoyancyQueriesByDimension = new Map<Dimension, Set<string>>();
    for (const [id, body] of this.#cannonBodies) {
      const record = this.#bodyRecords.get(id);
      if (
        !record
        || body.type !== Body.DYNAMIC
        || body.sleepState === Body.SLEEPING
      ) continue;
      if (record.buoyancyPoints.length === 0) {
        continue;
      }

      let fluidSurfaces = this.#fluidSurfacesByDimension.get(record.dimension);
      if (!fluidSurfaces) {
        fluidSurfaces = new Map();
        this.#fluidSurfacesByDimension.set(record.dimension, fluidSurfaces);
      }
      let queried = buoyancyQueriesByDimension.get(record.dimension);
      if (!queried) {
        queried = new Set();
        buoyancyQueriesByDimension.set(record.dimension, queried);
      }
      for (const location of fluidSampleLocationsByBody.get(id) ?? []) {
        const key = `${location.x},${location.y},${location.z}`;
        if (fluidSurfaces.has(key) || queried.has(key)) continue;
        queried.add(key);
        if (
          isCoveredByWorldScans(
            fullyScannedCoverageByDimension.get(record.dimension),
            location
          )
          || isCoveredByAppliedShadowScans(
            shadowFilteredScansByDimension?.get(record.dimension),
            location
          )
        ) continue;
        const cachedSurface = this.getCachedFluidSurface(record.dimension, location);
        if (cachedSurface !== undefined) {
          if (cachedSurface) fluidSurfaces.set(key, cachedSurface);
          continue;
        }
        const block = safeGetBlock(record.dimension, location);
        if (block && isPhysicsFluidBlock(block)) {
          fluidSurfaces.set(key, createFluidSurface(block, location.y));
        }
      }
    }
  }

  private getBodyFluidSampleLocations(
    body: Body,
    record: CannonBodyRecord
  ): readonly Vector3[] {
    if (record.buoyancyPoints.length === 0) return [];
    const locations = new Map<string, Vector3>();
    for (let sampleIndex = 0; sampleIndex < record.buoyancyPoints.length; sampleIndex++) {
      const cachedRelative = record.buoyancyRelativeLocations[sampleIndex]!;
      const relative = this.#buoyancyRelative;
      relative.set(cachedRelative.x, cachedRelative.y, cachedRelative.z);
      body.quaternion.vmult(relative, relative);
      const x = Math.floor(body.position.x + relative.x);
      const pointY = body.position.y + relative.y;
      const z = Math.floor(body.position.z + relative.z);
      const upperY = Math.floor(pointY);
      const lowerY = Math.floor(pointY - 0.5);
      const upper = { x, y: upperY, z };
      locations.set(`${x},${upperY},${z}`, upper);
      if (lowerY !== upperY) {
        locations.set(`${x},${lowerY},${z}`, { x, y: lowerY, z });
      }
    }
    return [...locations.values()];
  }

  private updateBodyWorldMeshRegion(
    record: CannonBodyRecord,
    bounds: IntegerBounds,
    active: boolean
  ): void {
    const signature = worldMeshChunkRegionSignature(bounds);
    if (record.worldMeshRegionSignature !== signature) {
      const previous = record.worldMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS;
      const nextRequests = getWorldMeshChunkRequests(record.dimension, bounds);
      const next = new Map<string, WorldMeshChunkRequest>();
      for (const request of nextRequests) next.set(worldMeshChunkRequestKey(request), request);
      const nextMap: ReadonlyMap<string, WorldMeshChunkRequest> = next.size === 0 ? EMPTY_WORLD_MESH_CHUNKS : next;
      if (record.worldMeshChunksActive) {
        this.updateActiveWorldMeshReferences(previous, active ? nextMap : EMPTY_WORLD_MESH_CHUNKS);
      }
      this.updateWorldMeshReferences(previous, nextMap);
      record.worldMeshChunks = nextMap;
      record.worldMeshChunksActive = record.worldMeshChunksActive === true && active;
      record.worldMeshRegionSignature = signature;
    }
    const chunks = record.worldMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS;
    if (record.worldMeshChunksActive !== active) {
      this.updateActiveWorldMeshReferences(
        active ? EMPTY_WORLD_MESH_CHUNKS : chunks,
        active ? chunks : EMPTY_WORLD_MESH_CHUNKS
      );
      record.worldMeshChunksActive = active;
    }
    for (const [key, request] of chunks) {
      if (!this.#worldMeshCache?.has(key)) this.queueWorldMeshChunk(request, active, key);
    }
  }

  private updateBodyWorldFluidMeshRegion(
    record: CannonBodyRecord,
    requests: ReadonlyMap<string, WorldMeshChunkRequest>
  ): void {
    let next: ReadonlyMap<string, WorldMeshChunkRequest> = requests;
    if (requests.size > 1) {
      next = new Map([...requests].sort(([left], [right]) => compareStrings(left, right)));
    } else if (requests.size === 0) {
      next = EMPTY_WORLD_MESH_CHUNKS;
    }
    const signature = [...next.keys()].join(";");
    if (record.worldFluidMeshRegionSignature !== signature) {
      this.updateWorldMeshReferences(record.worldFluidMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS, next);
      record.worldFluidMeshChunks = next;
      record.worldFluidMeshRegionSignature = signature;
    }
    for (const [key, request] of (record.worldFluidMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS)) {
      if (!this.#worldMeshCache?.has(key)) this.queueWorldMeshChunk(request, false, key);
    }
  }

  private updateWorldMeshReferences(
    previous: ReadonlyMap<string, WorldMeshChunkRequest>,
    next: ReadonlyMap<string, WorldMeshChunkRequest>
  ): void {
    for (const key of previous.keys()) {
      if (!next.has(key)) this.releaseWorldMeshReference(key);
    }
    for (const key of next.keys()) {
      if (previous.has(key)) continue;
      this.#worldMeshChunkReferenceCounts.set(key, (this.#worldMeshChunkReferenceCounts.get(key) ?? 0) + 1);
    }
  }

  private updateActiveWorldMeshReferences(
    previous: ReadonlyMap<string, WorldMeshChunkRequest>,
    next: ReadonlyMap<string, WorldMeshChunkRequest>
  ): void {
    for (const key of previous.keys()) {
      if (next.has(key)) continue;
      const count = this.#activeWorldMeshChunkReferenceCounts.get(key) ?? 0;
      if (count > 1) {
        this.#activeWorldMeshChunkReferenceCounts.set(key, count - 1);
        continue;
      }
      this.#activeWorldMeshChunkReferenceCounts.delete(key);
      const chunk = this.#worldMeshCache?.get(key);
      if (chunk && this.#activeWorldMeshChunkKeys.delete(key)) {
        this.detachWorldMeshChunk(chunk);
      }
      const queued = this.#worldMeshHighPriorityQueue.get(key);
      if (queued) {
        this.#worldMeshHighPriorityQueue.delete(key);
        if ((this.#worldMeshChunkReferenceCounts.get(key) ?? 0) > 0) {
          this.#worldMeshNormalPriorityQueue.set(key, queued);
        }
      }
    }
    for (const [key, request] of next) {
      if (previous.has(key)) continue;
      const count = this.#activeWorldMeshChunkReferenceCounts.get(key) ?? 0;
      this.#activeWorldMeshChunkReferenceCounts.set(key, count + 1);
      if (count > 0) continue;
      const chunk = this.#worldMeshCache?.get(key);
      if (chunk) this.attachWorldMeshChunk(key, chunk);
      else this.queueWorldMeshChunk(request, true, key);
    }
  }

  private releaseWorldMeshReference(key: string): void {
    const count = this.#worldMeshChunkReferenceCounts.get(key) ?? 0;
    if (count > 1) {
      this.#worldMeshChunkReferenceCounts.set(key, count - 1);
      return;
    }
    this.#worldMeshChunkReferenceCounts.delete(key);
    this.#worldMeshHighPriorityQueue.delete(key);
    this.#worldMeshNormalPriorityQueue.delete(key);
    const chunk = this.#worldMeshCache?.get(key);
    if (chunk) chunk.lastUsedTick = this.#stepCount;
  }

  private clearBodyWorldMeshReferences(record: CannonBodyRecord): void {
    const chunks = record.worldMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS;
    const fluidChunks = record.worldFluidMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS;
    if (record.worldMeshChunksActive) {
      this.updateActiveWorldMeshReferences(chunks, EMPTY_WORLD_MESH_CHUNKS);
    }
    this.updateWorldMeshReferences(chunks, EMPTY_WORLD_MESH_CHUNKS);
    this.updateWorldMeshReferences(fluidChunks, EMPTY_WORLD_MESH_CHUNKS);
    record.worldFluidMeshChunks = undefined;
    record.worldFluidMeshRegionSignature = undefined;
    record.worldMeshChunks = undefined;
    record.worldMeshChunksActive = undefined;
    record.worldMeshRegionSignature = undefined;
  }

  private bodyHasMissingWorldMeshChunks(record: CannonBodyRecord): boolean {
    const cache = this.#worldMeshCache;
    if (!cache) return true;
    for (const key of (record.worldMeshChunks ?? EMPTY_WORLD_MESH_CHUNKS).keys()) {
      if (!cache.has(key)) return true;
    }
    return false;
  }

  private queueWorldMeshChunk(
    request: WorldMeshChunkRequest,
    highPriority: boolean,
    precomputedKey?: string
  ): void {
    const key = precomputedKey ?? worldMeshChunkRequestKey(request);
    if (this.#worldMeshCache?.has(key)) return;
    if (highPriority) {
      this.#worldMeshNormalPriorityQueue.delete(key);
      this.#worldMeshHighPriorityQueue.set(key, request);
    } else if (!this.#worldMeshHighPriorityQueue.has(key)) {
      this.#worldMeshNormalPriorityQueue.set(key, request);
    }
  }

  private processWorldMeshBuildQueues(): void {
    this.processWorldMeshBuildQueue(
      this.#worldMeshHighPriorityQueue,
      WORLD_MESH_CACHE_HIGH_PRIORITY_BUILDS_PER_TICK
    );
    this.processWorldMeshBuildQueue(
      this.#worldMeshNormalPriorityQueue,
      Math.max(
        0,
        WORLD_MESH_CACHE_NORMAL_PRIORITY_BUILDS_PER_TICK
          - this.#worldMeshAuditScansThisTick
      )
    );
  }

  private processWorldMeshBuildQueue(
    queue: Map<string, WorldMeshChunkRequest>,
    budget: number
  ): void {
    const cache = this.#worldMeshCache;
    if (!cache || budget <= 0) return;
    let built = 0;
    for (const [key, request] of queue) {
      queue.delete(key);
      if (cache.has(key)) continue;
      const chunk = scanWorldMeshChunk(
        request.dimension,
        request.originX,
        request.originY,
        request.originZ,
        this.#stepCount,
        this.#blockProperties,
        this.#worldBlockSensorPredicate
      );
      if (chunk) {
        cache.set(key, chunk);
        if ((this.#activeWorldMeshChunkReferenceCounts.get(key) ?? 0) > 0) {
          this.attachWorldMeshChunk(key, chunk);
        }
      }
      built++;
      if (built >= budget) break;
    }
  }

  private attachWorldMeshChunk(key: string, chunk: CachedWorldMeshChunk): void {
    if (this.#activeWorldMeshChunkKeys.has(key)) return;
    if (chunk.groups.some(group => group.boxes.length > 0)) {
      chunk.body ??= this.createWorldMeshChunkBody(chunk);
      this.#world.addBody(chunk.body);
    }
    if (!this.#indexedWorldSensorsEnabled) this.attachWorldMeshChunkSensorBody(chunk);
    this.#activeWorldMeshChunkKeys.add(key);
  }

  private attachWorldMeshChunkSensorBody(chunk: CachedWorldMeshChunk): void {
    if (chunk.sensorBodyAttached || chunk.indexedSensorBoxes.length === 0) return;
    chunk.sensorBody ??= this.createWorldMeshChunkSensorBody(chunk);
    this.#world.addBody(chunk.sensorBody);
    chunk.sensorBodyAttached = true;
  }

  private detachWorldMeshChunkSensorBody(chunk: CachedWorldMeshChunk): void {
    if (!chunk.sensorBodyAttached || !chunk.sensorBody) return;
    this.#world.removeBody(chunk.sensorBody);
    chunk.sensorBodyAttached = false;
  }

  private createWorldMeshChunkBody(chunk: CachedWorldMeshChunk): Body {
    const position = new Vec3(
      chunk.bounds.minX + WORLD_MESH_CACHE_CHUNK_SIZE / 2,
      chunk.bounds.minY + WORLD_MESH_CACHE_CHUNK_SIZE / 2,
      chunk.bounds.minZ + WORLD_MESH_CACHE_CHUNK_SIZE / 2
    );
    const body = new Body({
      mass: 0,
      material: this.getOrCreateMaterial("world_block"),
      position,
      type: Body.STATIC
    });
    for (const group of chunk.groups) {
      const material = this.getOrCreateMaterial(group.materialId);
      for (const box of group.boxes) {
        const halfExtents = new Vec3(
          normalizeHalfExtent(box.sizeX / 2),
          normalizeHalfExtent(box.sizeY / 2),
          normalizeHalfExtent(box.sizeZ / 2)
        );
        const shape = new Box(halfExtents);
        shape.material = material;
        shape.collisionResponse = group.collisionResponse;
        body.addShape(shape, new Vec3(
          box.minX + halfExtents.x - position.x,
          box.minY + halfExtents.y - position.y,
          box.minZ + halfExtents.z - position.z
        ));
      }
    }
    body.updateMassProperties();
    body.updateBoundingRadius();
    body.aabbNeedsUpdate = true;
    return body;
  }

  private createWorldMeshChunkSensorBody(chunk: CachedWorldMeshChunk): Body {
    const position = new Vec3(
      chunk.bounds.minX + WORLD_MESH_CACHE_CHUNK_SIZE / 2,
      chunk.bounds.minY + WORLD_MESH_CACHE_CHUNK_SIZE / 2,
      chunk.bounds.minZ + WORLD_MESH_CACHE_CHUNK_SIZE / 2
    );
    const body = new Body({
      mass: 0,
      material: this.getOrCreateMaterial("world_block"),
      position,
      type: Body.STATIC
    });
    for (const box of chunk.indexedSensorBoxes) {
      const halfExtents = new Vec3(
        normalizeHalfExtent(box.sizeX / 2),
        normalizeHalfExtent(box.sizeY / 2),
        normalizeHalfExtent(box.sizeZ / 2)
      );
      const shape = new Box(halfExtents);
      shape.collisionResponse = false;
      body.addShape(shape, new Vec3(
        box.minX + halfExtents.x - position.x,
        box.minY + halfExtents.y - position.y,
        box.minZ + halfExtents.z - position.z
      ));
    }
    body.updateMassProperties();
    body.updateBoundingRadius();
    body.aabbNeedsUpdate = true;
    return body;
  }

  private getCachedFluidSurface(
    dimension: Dimension,
    location: Vector3
  ): FluidSurface | null | undefined {
    const cache = this.#worldMeshCache;
    if (!this.#worldMeshCacheEnabled || !cache) return undefined;
    const request = worldMeshChunkRequest(dimension, location);
    const chunk = cache.get(worldMeshChunkRequestKey(request));
    if (!chunk) {
      this.queueWorldMeshChunk(request, false);
      return undefined;
    }
    chunk.lastUsedTick = this.#stepCount;
    return chunk.fluidSurfaces.get(`${location.x},${location.y},${location.z}`) ?? null;
  }

  private auditWorldMeshCache(): void {
    const cache = this.#worldMeshCache;
    const coordinator = this.#worldMeshAuditCoordinator;
    if (
      !cache
      || !coordinator
      || coordinator.currentTick - coordinator.lastAuditTick
        < WORLD_MESH_CACHE_AUDIT_INTERVAL_TICKS
    ) return;
    if (this.hasPendingWorldMeshBuilds()) return;
    const targetKey = coordinator.targetChunkKey;
    if (!targetKey) return;
    if ((this.#worldMeshChunkReferenceCounts.get(targetKey) ?? 0) <= 0) return;
    const candidate = cache.get(targetKey);
    if (
      !candidate
      || candidate.dimension.id !== coordinator.targetDimensionId
      || this.#stepCount - candidate.lastAuditedTick
        < WORLD_MESH_CACHE_AUDIT_MIN_AGE_TICKS
    ) return;
    const candidateKey = targetKey;
    this.#worldMeshAuditScansThisTick = 1;
    const scanned = scanWorldMeshChunk(
      candidate.dimension,
      candidate.bounds.minX,
      candidate.bounds.minY,
      candidate.bounds.minZ,
      this.#stepCount,
      this.#blockProperties,
      this.#worldBlockSensorPredicate
    );
    if (!scanned) return;
    coordinator.lastAuditTick = coordinator.currentTick;
    if (scanned.signature === candidate.signature) {
      candidate.lastAuditedTick = this.#stepCount;
      return;
    }
    if (this.#activeWorldMeshChunkKeys.delete(candidateKey)) {
      this.detachWorldMeshChunk(candidate);
    }
    cache.set(candidateKey, scanned);
    if ((this.#activeWorldMeshChunkReferenceCounts.get(candidateKey) ?? 0) > 0) {
      this.attachWorldMeshChunk(candidateKey, scanned);
    }
    this.wakeBodiesUsingWorldMeshChunk(candidateKey);
  }

  private findWorldMeshAuditCandidate(
    referencedKeys?: Iterable<string>,
    context?: WorldMeshAuditSelectionContext
  ): WorldMeshAuditCandidateEntry | undefined {
    const cache = this.#worldMeshCache;
    if (!cache) return undefined;
    const keys = referencedKeys ?? this.#worldMeshChunkReferenceCounts.keys();
    let candidate: WorldMeshAuditCandidateEntry | undefined;
    for (const key of keys) {
      const chunk = cache.get(key);
      if (
        !chunk
        || this.#stepCount - chunk.lastAuditedTick < WORLD_MESH_CACHE_AUDIT_MIN_AGE_TICKS
      ) continue;
      const candidateMetadata = this.createWorldMeshAuditCandidate(key, chunk, context);
      if (!candidate || isCannonWorldMeshAuditCandidatePreferred(
        candidateMetadata,
        candidate.candidate
      )) candidate = { key, chunk, candidate: candidateMetadata };
    }
    return candidate;
  }

  private createWorldMeshAuditCandidate(
    key: string,
    chunk: CachedWorldMeshChunk,
    context?: WorldMeshAuditSelectionContext
  ): CannonWorldMeshAuditCandidate {
    const ageTicks = this.#stepCount - chunk.lastAuditedTick;
    return {
      ageTicks,
      auditCycle: Math.floor(ageTicks / WORLD_MESH_CACHE_AUDIT_MIN_AGE_TICKS),
      chunkKey: key,
      dimensionId: chunk.dimension.id,
      playerDistanceSquared: this.getWorldMeshChunkPlayerDistanceSquared(
        chunk,
        context?.playerPositionsByDimension
      ),
      scannedAgeTicks: this.#stepCount - chunk.scannedTick,
      sleepingSupport: context?.sleepingSupportKeys?.has(key) ?? false
    };
  }

  private getWorldMeshChunkPlayerDistanceSquared(
    chunk: CachedWorldMeshChunk,
    playerPositionsByDimension?: ReadonlyMap<string, readonly Vector3[]>
  ): number {
    const positions = playerPositionsByDimension?.get(chunk.dimension.id);
    if (!positions || positions.length === 0) return Number.POSITIVE_INFINITY;
    const centerX = chunk.bounds.minX + WORLD_MESH_CACHE_CHUNK_SIZE / 2;
    const centerY = chunk.bounds.minY + WORLD_MESH_CACHE_CHUNK_SIZE / 2;
    const centerZ = chunk.bounds.minZ + WORLD_MESH_CACHE_CHUNK_SIZE / 2;
    let best = Number.POSITIVE_INFINITY;
    for (const position of positions) {
      const dx = position.x - centerX;
      const dy = position.y - centerY;
      const dz = position.z - centerZ;
      best = Math.min(best, dx * dx + dy * dy + dz * dz);
    }
    return best;
  }

  private getSleepingSupportChunkKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const [id, body] of this.#cannonBodies) {
      if (body.type !== Body.DYNAMIC || body.sleepState !== Body.SLEEPING) continue;
      const record = this.#bodyRecords.get(id);
      if (!record) continue;
      for (const request of getWorldMeshChunkRequests(
        record.dimension,
        getSleepingSupportBlockScanBounds(body)
      )) keys.add(worldMeshChunkRequestKey(request));
    }
    return keys;
  }

  private invalidateWorldMeshChunk(
    dimension: Dimension,
    originX: number,
    originY: number,
    originZ: number
  ): void {
    const cache = this.#worldMeshCache;
    if (!cache) return;
    const request = { dimension, originX, originY, originZ };
    const key = worldMeshChunkRequestKey(request);
    const chunk = cache.get(key);
    if (chunk && this.#activeWorldMeshChunkKeys.delete(key)) {
      this.detachWorldMeshChunk(chunk);
    }
    cache.delete(key);
    this.#worldMeshNormalPriorityQueue.delete(key);
    const referenced = this.wakeBodiesUsingWorldMeshChunk(key);
    if (referenced) this.queueWorldMeshChunk(request, true);
    if (this.#worldColliderBodies.size > 0) {
      this.clearWorldBlockColliders();
      this.#worldColliderLayout = [];
    }
  }

  private wakeBodiesUsingWorldMeshChunk(key: string): boolean {
    let referenced = false;
    for (const [id, record] of this.#bodyRecords) {
      if (
        !record.worldMeshChunks?.has(key)
        && !record.worldFluidMeshChunks?.has(key)
      ) continue;
      referenced = true;
      record.sleepEnvironmentSignature = undefined;
      this.#cannonBodies.get(id)?.wakeUp();
    }
    return referenced;
  }

  private pruneWorldMeshCache(): void {
    const cache = this.#worldMeshCache;
    if (!cache) return;
    for (const [key, chunk] of cache) {
      if (this.#worldMeshChunkReferenceCounts.has(key)) continue;
      if (this.#stepCount - chunk.lastUsedTick > WORLD_MESH_CACHE_UNUSED_TICKS) {
        if (this.#activeWorldMeshChunkKeys.delete(key)) this.detachWorldMeshChunk(chunk);
        cache.delete(key);
      }
    }
  }
}

function normalizeTickSteps(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_TICK_STEPS;
}

function normalizeMass(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 1;
}

function normalizeBuoyancyPoints(
  points: readonly PhysicsBodyBuoyancyPoint[] | undefined
): PhysicsBodyBuoyancyPoint[] {
  if (!points) return [];
  return points
    .filter(point => isFiniteVector3(point.localLocation) && Number.isFinite(point.volume) && point.volume > 0)
    .map(point => ({
      localLocation: { ...point.localLocation },
      volume: point.volume
    }));
}

function getBuoyancyRelativeLocations(
  points: readonly PhysicsBodyBuoyancyPoint[],
  localCenterOfMass: Vector3
): Vector3[] {
  return points.map(point => ({
    x: point.localLocation.x - localCenterOfMass.x,
    y: point.localLocation.y - localCenterOfMass.y,
    z: point.localLocation.z - localCenterOfMass.z
  }));
}

function totalBuoyancyVolume(points: readonly PhysicsBodyBuoyancyPoint[]): number {
  return points.reduce((total, point) => total + point.volume, 0);
}

function clearActiveBodyFluidState(record: CannonBodyRecord): void {
  record.inWater = false;
  record.inLava = false;
  record.inNativeFlowingFluid = false;
  record.lavaEntryRearmTicks = Math.max(0, record.lavaEntryRearmTicks - 1);
  record.lavaSubmersionRatio = 0;
}

function updateDynamicBodyMassProperties(body: Body): void {
  const rotation = body.quaternion.clone();
  body.quaternion.set(0, 0, 0, 1);
  body.updateMassProperties();
  body.quaternion.copy(rotation);
  body.updateInertiaWorld(true);
  body.aabbNeedsUpdate = true;
}

function makeContactMaterialKey(left: string, right: string): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function getPredictedShapeScanBounds(
  body: Body,
  record: CannonBodyRecord,
  fixedTimeStep: number,
  tickSteps: number
): IntegerBounds[] {
  const marginX = getVelocityMargin(body.velocity.x, fixedTimeStep, tickSteps);
  const marginY = getVelocityMargin(body.velocity.y, fixedTimeStep, tickSteps);
  const marginZ = getVelocityMargin(body.velocity.z, fixedTimeStep, tickSteps);
  const time = fixedTimeStep * tickSteps;
  const angularTravel = Math.hypot(
    body.angularVelocity.x,
    body.angularVelocity.y,
    body.angularVelocity.z
  ) * time;
  const predictedRotation = angularTravel > 1e-12 && angularTravel < Math.PI
    ? predictBodyRotation(body.quaternion, body.angularVelocity, time, angularTravel)
    : undefined;
  return record.collider.shapes.map(shape => {
    const minX = shape.localBoundsMin.x - record.localCenterOfMass.x;
    const minY = shape.localBoundsMin.y - record.localCenterOfMass.y;
    const minZ = shape.localBoundsMin.z - record.localCenterOfMass.z;
    const maxX = shape.localBoundsMax.x - record.localCenterOfMass.x;
    const maxY = shape.localBoundsMax.y - record.localCenterOfMass.y;
    const maxZ = shape.localBoundsMax.z - record.localCenterOfMass.z;
    const currentBounds = transformAxisAlignedBounds(
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      body.quaternion,
      body.position
    );
    const radius = Math.hypot(
      Math.max(Math.abs(minX), Math.abs(maxX)),
      Math.max(Math.abs(minY), Math.abs(maxY)),
      Math.max(Math.abs(minZ), Math.abs(maxZ))
    );
    let sweptMinX: number;
    let sweptMinY: number;
    let sweptMinZ: number;
    let sweptMaxX: number;
    let sweptMaxY: number;
    let sweptMaxZ: number;
    if (angularTravel >= Math.PI) {
      sweptMinX = body.position.x - radius;
      sweptMinY = body.position.y - radius;
      sweptMinZ = body.position.z - radius;
      sweptMaxX = body.position.x + radius;
      sweptMaxY = body.position.y + radius;
      sweptMaxZ = body.position.z + radius;
    } else if (!predictedRotation) {
      sweptMinX = currentBounds.min.x;
      sweptMinY = currentBounds.min.y;
      sweptMinZ = currentBounds.min.z;
      sweptMaxX = currentBounds.max.x;
      sweptMaxY = currentBounds.max.y;
      sweptMaxZ = currentBounds.max.z;
    } else {
      const predictedBounds = transformAxisAlignedBounds(
        minX,
        minY,
        minZ,
        maxX,
        maxY,
        maxZ,
        predictedRotation,
        body.position
      );
      const sagitta = radius * (1 - Math.cos(angularTravel / 2));
      sweptMinX = Math.min(currentBounds.min.x, predictedBounds.min.x) - sagitta;
      sweptMinY = Math.min(currentBounds.min.y, predictedBounds.min.y) - sagitta;
      sweptMinZ = Math.min(currentBounds.min.z, predictedBounds.min.z) - sagitta;
      sweptMaxX = Math.max(currentBounds.max.x, predictedBounds.max.x) + sagitta;
      sweptMaxY = Math.max(currentBounds.max.y, predictedBounds.max.y) + sagitta;
      sweptMaxZ = Math.max(currentBounds.max.z, predictedBounds.max.z) + sagitta;
    }
    return {
      maxX: Math.floor(sweptMaxX + marginX),
      maxY: Math.floor(sweptMaxY + marginY),
      maxZ: Math.floor(sweptMaxZ + marginZ),
      minX: Math.floor(sweptMinX - marginX),
      minY: Math.floor(sweptMinY - marginY),
      minZ: Math.floor(sweptMinZ - marginZ)
    };
  });
}

function getShadowScanShapes(
  body: Body,
  record: CannonBodyRecord,
  fixedTimeStep: number,
  tickSteps: number
): ShadowScanShape[] {
  const x = body.quaternion.x;
  const y = body.quaternion.y;
  const z = body.quaternion.z;
  const w = body.quaternion.w;
  const rotation00 = 1 - 2 * (y * y + z * z);
  const rotation01 = 2 * (x * y - z * w);
  const rotation02 = 2 * (x * z + y * w);
  const rotation10 = 2 * (x * y + z * w);
  const rotation11 = 1 - 2 * (x * x + z * z);
  const rotation12 = 2 * (y * z - x * w);
  const rotation20 = 2 * (x * z - y * w);
  const rotation21 = 2 * (y * z + x * w);
  const rotation22 = 1 - 2 * (x * x + y * y);
  const time = fixedTimeStep * tickSteps;
  const linearTravel = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z) * time;
  const angularTravel = Math.hypot(
    body.angularVelocity.x,
    body.angularVelocity.y,
    body.angularVelocity.z
  ) * time;
  const localHalfX = 0.5 * (
    Math.abs(rotation00) + Math.abs(rotation10) + Math.abs(rotation20)
  );
  const localHalfY = 0.5 * (
    Math.abs(rotation01) + Math.abs(rotation11) + Math.abs(rotation21)
  );
  const localHalfZ = 0.5 * (
    Math.abs(rotation02) + Math.abs(rotation12) + Math.abs(rotation22)
  );

  return record.collider.shapes.map(shape => {
    const minX = shape.localBoundsMin.x - record.localCenterOfMass.x;
    const minY = shape.localBoundsMin.y - record.localCenterOfMass.y;
    const minZ = shape.localBoundsMin.z - record.localCenterOfMass.z;
    const maxX = shape.localBoundsMax.x - record.localCenterOfMass.x;
    const maxY = shape.localBoundsMax.y - record.localCenterOfMass.y;
    const maxZ = shape.localBoundsMax.z - record.localCenterOfMass.z;
    const radius = Math.hypot(
      Math.max(Math.abs(minX), Math.abs(maxX)),
      Math.max(Math.abs(minY), Math.abs(maxY)),
      Math.max(Math.abs(minZ), Math.abs(maxZ))
    );
    const angularDisplacement = angularTravel >= Math.PI
      ? radius * 2
      : radius * angularTravel;
    const expansion = DEFAULT_WORLD_BLOCK_SCAN_MARGIN
      + linearTravel
      + angularDisplacement
      + 1e-6;
    return {
      localHalfX,
      localHalfY,
      localHalfZ,
      localMaxX: maxX + expansion,
      localMaxY: maxY + expansion,
      localMaxZ: maxZ + expansion,
      localMinX: minX - expansion,
      localMinY: minY - expansion,
      localMinZ: minZ - expansion,
      positionX: body.position.x,
      positionY: body.position.y,
      positionZ: body.position.z,
      rotation00,
      rotation01,
      rotation02,
      rotation10,
      rotation11,
      rotation12,
      rotation20,
      rotation21,
      rotation22
    };
  });
}

function getPredictedBodyScanBounds(
  body: Body,
  fixedTimeStep: number,
  tickSteps: number
): IntegerBounds {
  const marginX = getVelocityMargin(body.velocity.x, fixedTimeStep, tickSteps);
  const marginY = getVelocityMargin(body.velocity.y, fixedTimeStep, tickSteps);
  const marginZ = getVelocityMargin(body.velocity.z, fixedTimeStep, tickSteps);
  return {
    maxX: Math.floor(body.aabb.upperBound.x + marginX),
    maxY: Math.floor(body.aabb.upperBound.y + marginY),
    maxZ: Math.floor(body.aabb.upperBound.z + marginZ),
    minX: Math.floor(body.aabb.lowerBound.x - marginX),
    minY: Math.floor(body.aabb.lowerBound.y - marginY),
    minZ: Math.floor(body.aabb.lowerBound.z - marginZ)
  };
}

function getPredictedWorldMeshBounds(
  body: Body,
  record: CannonBodyRecord,
  fixedTimeStep: number,
  tickSteps: number
): IntegerBounds {
  const shapeBounds = getPredictedShapeScanBounds(body, record, fixedTimeStep, tickSteps);
  if (shapeBounds.length === 0) {
    return getPredictedBodyScanBounds(body, fixedTimeStep, tickSteps);
  }
  return shapeBounds.slice(1).reduce(mergeIntegerBounds, shapeBounds[0]!);
}

function cannonAabbToPhysicsAabb(body: Body): PhysicsBodyAabb {
  return {
    max: {
      x: body.aabb.upperBound.x,
      y: body.aabb.upperBound.y,
      z: body.aabb.upperBound.z
    },
    min: {
      x: body.aabb.lowerBound.x,
      y: body.aabb.lowerBound.y,
      z: body.aabb.lowerBound.z
    }
  };
}

function getColliderWorldAabb(
  body: Body,
  record: CannonBodyRecord,
  collider: NormalizedBodyCollider
): PhysicsBodyAabb {
  const result: PhysicsBodyAabb = {
    max: { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY },
    min: { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY }
  };
  for (const shape of collider.shapes) {
    const transformed = transformAxisAlignedBounds(
      shape.localBoundsMin.x - record.localCenterOfMass.x,
      shape.localBoundsMin.y - record.localCenterOfMass.y,
      shape.localBoundsMin.z - record.localCenterOfMass.z,
      shape.localBoundsMax.x - record.localCenterOfMass.x,
      shape.localBoundsMax.y - record.localCenterOfMass.y,
      shape.localBoundsMax.z - record.localCenterOfMass.z,
      body.quaternion,
      body.position
    );
    result.min.x = Math.min(result.min.x, transformed.min.x);
    result.min.y = Math.min(result.min.y, transformed.min.y);
    result.min.z = Math.min(result.min.z, transformed.min.z);
    result.max.x = Math.max(result.max.x, transformed.max.x);
    result.max.y = Math.max(result.max.y, transformed.max.y);
    result.max.z = Math.max(result.max.z, transformed.max.z);
  }
  if (Number.isFinite(result.min.x)) return result;
  body.updateAABB();
  return cannonAabbToPhysicsAabb(body);
}

function getSleepingSupportBlockScanBounds(body: Body): IntegerBounds {
  body.updateAABB();
  return {
    maxX: Math.floor(body.aabb.upperBound.x + DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
    maxY: Math.floor(body.aabb.lowerBound.y),
    maxZ: Math.floor(body.aabb.upperBound.z + DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
    minX: Math.floor(body.aabb.lowerBound.x - DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
    minY: Math.floor(body.aabb.lowerBound.y - DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
    minZ: Math.floor(body.aabb.lowerBound.z - DEFAULT_WORLD_BLOCK_SCAN_MARGIN)
  };
}

function getSleepingEnvironmentScanCluster(
  body: Body,
  record: CannonBodyRecord
): ScanBoundsCluster {
  const members = record.environmentCollider.shapes.map(shape => {
    const transformed = transformAxisAlignedBounds(
      shape.localBoundsMin.x - record.localCenterOfMass.x,
      shape.localBoundsMin.y - record.localCenterOfMass.y,
      shape.localBoundsMin.z - record.localCenterOfMass.z,
      shape.localBoundsMax.x - record.localCenterOfMass.x,
      shape.localBoundsMax.y - record.localCenterOfMass.y,
      shape.localBoundsMax.z - record.localCenterOfMass.z,
      body.quaternion,
      body.position
    );
    return {
      maxX: Math.floor(transformed.max.x + DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
      maxY: Math.floor(transformed.max.y + DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
      maxZ: Math.floor(transformed.max.z + DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
      minX: Math.floor(transformed.min.x - DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
      minY: Math.floor(transformed.min.y - DEFAULT_WORLD_BLOCK_SCAN_MARGIN),
      minZ: Math.floor(transformed.min.z - DEFAULT_WORLD_BLOCK_SCAN_MARGIN)
    };
  });
  const bounds = members.slice(1).reduce(mergeIntegerBounds, members[0]!);
  return { bounds, members, shadowFilterEligible: false, sparse: members.length > 1 };
}

function getVelocityMargin(velocity: number, fixedTimeStep: number, tickSteps: number): number {
  return Math.min(
    DEFAULT_WORLD_BLOCK_SCAN_MAX_VELOCITY_MARGIN,
    DEFAULT_WORLD_BLOCK_SCAN_MARGIN + Math.abs(velocity) * fixedTimeStep * tickSteps
  );
}

function addPredictedShapeScanClusters(
  clustersByDimension: Map<Dimension, ScanBoundsCluster[]>,
  dimension: Dimension,
  body: Body,
  record: CannonBodyRecord,
  fixedTimeStep: number,
  tickSteps: number
): void {
  const bodyBounds = getPredictedBodyScanBounds(body, fixedTimeStep, tickSteps);
  const shadowFilterEligible = record.collider.shapes.length <= WORLD_BLOCK_SHADOW_MAX_SHAPES
    && integerBoundsVolume(bodyBounds) >= WORLD_BLOCK_SHADOW_MIN_SCAN_VOLUME;
  const shadowShapes = shadowFilterEligible
    ? getShadowScanShapes(body, record, fixedTimeStep, tickSteps)
    : undefined;
  if (record.collider.shapes.length <= 1) {
    addScanBoundsCluster(
      clustersByDimension,
      dimension,
      bodyBounds,
      false,
      shadowShapes,
      shadowFilterEligible
    );
    return;
  }
  const shapeBounds = getPredictedShapeScanBounds(body, record, fixedTimeStep, tickSteps);
  const shapeClusters: ScanBoundsCluster[] = [];
  for (let index = 0; index < shapeBounds.length; index++) {
    const bounds = shapeBounds[index]!;
    addScanBoundsClusterToList(shapeClusters, {
      bounds,
      members: [bounds],
      shadowFilterEligible,
      shadowShapes: shadowShapes ? [shadowShapes[index]!] : undefined,
      sparse: true
    });
  }
  const bodyScanCost = integerBoundsVolume(bodyBounds);
  const shapeScanCost = shapeClusters.reduce((total, cluster) => {
    const sizeX = cluster.bounds.maxX - cluster.bounds.minX + 1;
    const sizeY = cluster.bounds.maxY - cluster.bounds.minY + 1;
    const sizeZ = cluster.bounds.maxZ - cluster.bounds.minZ + 1;
    const coverage = createWorldScanCoverage(cluster, sizeY, sizeZ);
    return total + worldScanCoverageVolume(coverage, sizeX, sizeY, sizeZ);
  }, shapeBounds.length * SHAPE_UNION_SCAN_MEMBER_OVERHEAD);
  if (shapeScanCost >= bodyScanCost) {
    addScanBoundsCluster(
      clustersByDimension,
      dimension,
      bodyBounds,
      false,
      shadowShapes,
      shadowFilterEligible
    );
    return;
  }
  let dimensionClusters = clustersByDimension.get(dimension);
  if (!dimensionClusters) {
    dimensionClusters = [];
    clustersByDimension.set(dimension, dimensionClusters);
  }
  for (const cluster of shapeClusters) {
    addScanBoundsClusterToList(dimensionClusters, cluster);
  }
}
