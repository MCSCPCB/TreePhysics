import {
  system,
  world,
  type AABB,
  type Entity,
  type InputButton,
  type Player,
  type Vector3
} from "@minecraft/server";
import type { PhysicsBody } from "@src/Physics";
import {
  DEFAULT_OBB_SETTINGS,
  DEFAULT_OBB_SUPPORT_PRESET_CATALOG,
  SolidObb,
  type ObbEntitySnapshot,
  type ObbCollisionShell,
  type ObbSurfaceContact,
  type ObbTransform
} from "@src/physics/obb";
import { calculateSurfaceMotionImpulse } from "@src/physics/obb/internal/Motion";
import type { PhysicsBodyCollider } from "@src/physics/core/Types";
import { EPSILON_1E6, add, scale, subtract } from "@src/utils/Vector3Math";
import { VANILLA_DIMENSION_IDS } from "@src/utils/WorldBlock";
import { rotateVectorByEulerDegreesYzx } from "@src/physics/motion/RotationContinuity";
import {
  COLLISION_DOWNWARD_PRELOAD_MARGIN,
  COLLISION_PREDICTION_TICKS,
  HORIZONTAL_BROAD_PHASE_MARGIN,
  LocalCollisionBoxIndex,
  ContraptionCollisionSnapshotIndex,
  createContraptionRotationSweepBounds as createIndexedContraptionRotationSweepBounds,
  getDescriptorBounds as getIndexedDescriptorBounds
} from "@src/physics/collision/ContraptionColliderIndex";
import {
  assertAabb,
  collisionBoxKey,
  createBodyFrame,
  getSweptAabbObbHitTime,
  getContraptionCollisionBoxDescriptors,
  getContraptionCollisionBoxTransformFromFrame,
  isFiniteVector,
  lerp,
  type BodyFrame,
  type ContraptionCollisionBoxDescriptor,
  worldToLocal
} from "@src/physics/collision/ContraptionColliderMath";

const BLOCK_COLLIDER_ENTITY_TYPE_ID = "treephysics:block_collider";

const COLLISION_REGION_RETENTION_TICKS = 6;
const COLLISION_INTEGRITY_CHECK_INTERVAL_TICKS = 20;
const FRICTION_CONTACT_DISTANCE = 0.25;
const FRICTION_HISTORY_GRACE_TICKS = 1;
const JUMP_INPUT = "Jump" as InputButton;
const allManagedProxyIds = new Set<string>();

export type ContraptionSurfaceContactCallback = (
  entity: Entity,
  location: Vector3,
  relativePosition: Vector3,
  playerPosition: Vector3,
  playerVelocity: Vector3,
  surfaceVelocity: Vector3
) => void;

export interface CollisionBoxState {
  readonly descriptor: ContraptionCollisionBoxDescriptor;
  readonly key: string;
  readonly managedProxyIds: Set<string>;
  readonly obb: SolidObb;
  /** Creation pose used once when a remesh adds a box between physics ticks. */
  previousFrameOverride?: BodyFrame;
  transform: ObbTransform;
}

interface SurfaceOwner {
  readonly box: CollisionBoxState;
  readonly contact: ObbSurfaceContact;
  readonly snapshot: ObbEntitySnapshot;
  surfaceVelocity?: Vector3;
}

interface FrictionSurfaceState {
  missedTicks: number;
  readonly velocity: Vector3;
}

export interface WorldBounds {
  readonly max: Vector3;
  readonly min: Vector3;
}

/**
 * Owns the native Minecraft collision surface for one physics contraption.
 * Logical response boxes are kept independent from quality-specific runtime
 * colliders. High quality keeps the complete solid layout while low quality
 * uses a walking-priority outer shell around nearby players.
 */
export class ContraptionCollider {
  readonly #body: PhysicsBody;
  #boxes: CollisionBoxState[] = [];
  #collider: PhysicsBodyCollider;
  #enabled: boolean;
  #integrityFailure = false;
  #localBounds?: WorldBounds;
  readonly #managedProxyIds = new Set<string>();
  #localIndex = new LocalCollisionBoxIndex();
  #activeBoxes = new Set<CollisionBoxState>();
  #bodyFrame?: BodyFrame;
  readonly #frictionSurfaceStates = new Map<string, FrictionSurfaceState>();

  constructor(body: PhysicsBody, collider: PhysicsBodyCollider, enabled = true) {
    this.#body = body;
    this.#collider = collider;
    this.#enabled = enabled;
    if (enabled) this.#replaceCollider(collider);
  }

  get hasKnownIntegrityFailure(): boolean {
    return this.#integrityFailure;
  }

  /** Reuses unchanged OBBs while replacing only remeshed response boxes. */
  setCollider(collider: PhysicsBodyCollider): void {
    this.#collider = collider;
    if (!this.#enabled) return;
    this.#replaceCollider(collider);
  }

  #replaceCollider(collider: PhysicsBodyCollider): void {
    if (this.#integrityFailure) return;
    const descriptors = getContraptionCollisionBoxDescriptors(collider);
    const frame = createBodyFrame(this.#body);
    const previousBodyFrame = this.#bodyFrame;
    const available = new Map<string, CollisionBoxState[]>();
    for (const box of this.#boxes) {
      const matching = available.get(box.key);
      if (matching) matching.push(box);
      else available.set(box.key, [box]);
    }

    const next: CollisionBoxState[] = [];
    const created: CollisionBoxState[] = [];
    try {
      for (const descriptor of descriptors) {
        const key = collisionBoxKey(descriptor);
        const reusable = available.get(key)?.pop();
        if (reusable) {
          next.push(reusable);
          continue;
        }
        const transform = getContraptionCollisionBoxTransformFromFrame(frame, descriptor);
        const state = {
          descriptor,
          key,
          managedProxyIds: new Set<string>(),
          transform,
          previousFrameOverride: frame,
          obb: new SolidObb({
            box: {
              ...transform,
              size: {
                depth: descriptor.size.z,
                height: descriptor.size.y,
                width: descriptor.size.x
              }
            },
            dimension: this.#body.dimension.dimension,
            // Contraption creation never performs a separate native actor query.
            entitySnapshots: [],
            settings: {
              collisionRegionRetentionTicks: COLLISION_REGION_RETENTION_TICKS,
              fullCollisionColumnLimit: 0
            },
            supportEntityTypeId: BLOCK_COLLIDER_ENTITY_TYPE_ID,
            supportPresets: DEFAULT_OBB_SUPPORT_PRESET_CATALOG
          })
        };
        created.push(state);
        next.push(state);
      }
    } catch (error) {
      disposeCollisionBoxes(created);
      throw error;
    }

    for (const remaining of available.values()) {
      for (const box of remaining) this.#unregisterBoxProxyIds(box);
      disposeCollisionBoxes(remaining);
    }
    this.#boxes = next;
    this.#localIndex.rebuild(next);
    this.#localBounds = getIndexedDescriptorBounds(next, rotateVectorByEulerDegreesYzx);
    this.#activeBoxes = new Set(next.filter(box => box.obb.supportCount > 0));
    // Reused OBBs still need the preceding physics-tick frame for exact
    // one-tick motion; newly created boxes carry their own creation override.
    this.#bodyFrame = previousBodyFrame ?? frame;
    this.#refreshManagedProxyIds();
  }

  /** Synchronizes actor-activated collision after the Cannon step completes. */
  sync(
    snapshotIndex: ContraptionCollisionSnapshotIndex,
    collisionShell: ObbCollisionShell,
    enabled = true,
    surfaceMotionEnabled = true,
    surfaceContactCallback?: ContraptionSurfaceContactCallback
  ): void {
    this.#setEnabled(enabled);
    if (!this.#enabled) return;
    if (this.#integrityFailure || this.#boxes.length === 0) return;
    if (system.currentTick % COLLISION_INTEGRITY_CHECK_INTERVAL_TICKS === 0
      && !this.#hasIntactProxies()) {
      this.#integrityFailure = true;
      this.dispose();
      return;
    }

    const previousFrame = this.#bodyFrame ?? createBodyFrame(this.#body);
    const frame = this.#body.isSleeping
      ? previousFrame
      : createBodyFrame(this.#body);
    const localBounds = this.#localBounds;
    if (!localBounds) throw new Error("Contraption collider has no local bounds.");
    const snapshots = snapshotIndex.query(
      createIndexedContraptionRotationSweepBounds(previousFrame, frame, localBounds),
      this.#body.velocity
    );
    const candidates = this.#selectCandidateBoxes(snapshots, frame);
    const preparedBoxes = new Set<CollisionBoxState>();
    for (const box of candidates.nearby) preparedBoxes.add(box);
    for (const box of candidates.landingSearch) preparedBoxes.add(box);
    const prepared = new Map<CollisionBoxState, ObbTransform>();
    for (const box of preparedBoxes) {
      prepared.set(box, this.#prepareBoxTransform(box, previousFrame, frame));
    }
    const landingTargets = this.#selectLandingTargets(
      snapshots,
      candidates.landingSearch,
      candidates.nearby
    );
    const updateBoxes = new Set<CollisionBoxState>();
    for (const box of candidates.nearby) updateBoxes.add(box);
    for (const box of landingTargets.keys()) updateBoxes.add(box);
    for (const box of this.#activeBoxes) updateBoxes.add(box);
    const updates = Array.from(updateBoxes, box => {
      const transform = prepared.get(box)
        ?? this.#prepareBoxTransform(box, previousFrame, frame);
      return { box, transform };
    });
    this.#bodyFrame = frame;
    const surfaceOwners = surfaceMotionEnabled || surfaceContactCallback
      ? assignSurfaceOwners(snapshots, updates)
      : [];
    // Airborne descending players are sampled so the gameplay layer can detect
    // the first landing contact, but surface motion must remain grounded-only.
    const frictionOwners = surfaceMotionEnabled
      ? surfaceOwners.filter(owner => owner.snapshot.entity.isOnGround)
      : [];
    for (const owner of surfaceOwners) {
      owner.surfaceVelocity = owner.box.obb.getSurfaceVelocity(
        prepared.get(owner.box) ?? owner.box.transform,
        owner.contact
      );
      if (surfaceContactCallback) {
        surfaceContactCallback(
          owner.snapshot.entity,
          owner.contact.surfacePoint,
          worldToLocal(frame, owner.snapshot.aabb.center),
          owner.snapshot.aabb.center,
          owner.snapshot.velocity,
          owner.surfaceVelocity
        );
      }
    }
    let proxyLayoutChanged = false;
    for (const update of updates) {
      try {
        const result = update.box.obb.update(update.transform, {
          collisionShell,
          collisionActivationAabbs: landingTargets.get(update.box),
          entitySnapshots: snapshots,
          friction: false
        });
        if (result.collision.changed) {
          proxyLayoutChanged = true;
          this.#applyProxyIdChanges(update.box, result.collision);
          if (update.box.obb.supportCount > 0) this.#activeBoxes.add(update.box);
          else this.#activeBoxes.delete(update.box);
        }
      } catch (error) {
        if (!isSupportProxyIntegrityError(error)) throw error;
        this.#integrityFailure = true;
        this.dispose();
        return;
      }
    }
    if (surfaceMotionEnabled) this.#applySurfaceMotion(frictionOwners, snapshots);
    else this.#frictionSurfaceStates.clear();
    if (proxyLayoutChanged) this.#assertProxyLedgerMatchesActiveBoxes();
  }

  /** Applies a runtime setting change without retaining dormant proxy entities. */
  #setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.dispose();
      return;
    }
    this.#replaceCollider(this.#collider);
  }

  /** Applies one combined carrier-inheritance and slip-friction impulse. */
  #applySurfaceMotion(
    owners: readonly SurfaceOwner[],
    snapshots: readonly ObbEntitySnapshot[]
  ): void {
    for (const state of this.#frictionSurfaceStates.values()) {
      state.missedTicks += 1;
    }
    for (const snapshot of snapshots) {
      if (isJumpPressed(snapshot.entity)) {
        this.#frictionSurfaceStates.delete(snapshot.entity.id);
      }
    }
    for (const owner of owners) {
      const { contact, snapshot } = owner;
      const surfaceVelocity = owner.surfaceVelocity!;
      if (!snapshot.entity.isValid || isJumpPressed(snapshot.entity)) continue;
      const previous = this.#frictionSurfaceStates.get(snapshot.entity.id);
      const result = calculateSurfaceMotionImpulse({
        applyFriction: !hasMovementInput(snapshot.entity),
        entityVelocity: snapshot.velocity,
        normal: contact.normal,
        previousSurfaceVelocity: previous?.velocity,
        settings: DEFAULT_OBB_SETTINGS.friction,
        surfaceVelocity
      });
      if (result.magnitude > EPSILON_1E6) {
        snapshot.entity.applyImpulse(result.impulse);
      }
      this.#frictionSurfaceStates.set(snapshot.entity.id, {
        missedTicks: 0,
        velocity: { ...surfaceVelocity }
      });
    }
    for (const [entityId, state] of this.#frictionSurfaceStates) {
      if (state.missedTicks > FRICTION_HISTORY_GRACE_TICKS) {
        this.#frictionSurfaceStates.delete(entityId);
      }
    }
  }

  /** Reconstructs an exact one-tick pose pair for a lazily selected box. */
  #prepareBoxTransform(
    box: CollisionBoxState,
    previousFrame: BodyFrame,
    frame: BodyFrame
  ): ObbTransform {
    const boxPreviousFrame = box.previousFrameOverride ?? previousFrame;
    const previousTransform = this.#body.isSleeping
      ? box.transform
      : getContraptionCollisionBoxTransformFromFrame(
        boxPreviousFrame,
        box.descriptor,
        box.transform
      );
    const transform = this.#body.isSleeping
      ? previousTransform
      : getContraptionCollisionBoxTransformFromFrame(
        frame,
        box.descriptor,
        previousTransform
      );
    box.obb.updateTransformOnly(previousTransform);
    box.previousFrameOverride = undefined;
    box.transform = transform;
    return transform;
  }

  #selectCandidateBoxes(
    snapshots: readonly ObbEntitySnapshot[],
    frame: BodyFrame
  ): Readonly<{
    landingSearch: ReadonlySet<CollisionBoxState>;
    nearby: ReadonlySet<CollisionBoxState>;
  }> {
    const landingSearch = new Set<CollisionBoxState>();
    const nearby = new Set<CollisionBoxState>();
    for (const snapshot of snapshots) {
      if (!snapshot.entity.isValid) continue;
      const localCenter = worldToLocal(frame, snapshot.aabb.center);
      const localEnd = worldToLocal(frame, add(
        snapshot.aabb.center,
        snapshot.velocity
      ));
      const relativeVelocity = subtract(snapshot.velocity, this.#body.velocity);
      const localPredictedEnd = worldToLocal(frame, add(
        snapshot.aabb.center,
        scale(relativeVelocity, COLLISION_PREDICTION_TICKS)
      ));
      const localLandingPreload = worldToLocal(frame, {
        x: snapshot.aabb.center.x,
        y: snapshot.aabb.center.y - COLLISION_DOWNWARD_PRELOAD_MARGIN,
        z: snapshot.aabb.center.z
      });
      const actorRadius = Math.hypot(
        snapshot.aabb.extent.x,
        snapshot.aabb.extent.y,
        snapshot.aabb.extent.z
      );
      const horizontalRadius = actorRadius + HORIZONTAL_BROAD_PHASE_MARGIN;
      this.#localIndex.query({
        min: {
          x: Math.min(localCenter.x, localEnd.x) - horizontalRadius,
          y: Math.min(localCenter.y, localEnd.y) - horizontalRadius,
          z: Math.min(localCenter.z, localEnd.z) - horizontalRadius
        },
        max: {
          x: Math.max(localCenter.x, localEnd.x) + horizontalRadius,
          y: Math.max(localCenter.y, localEnd.y) + horizontalRadius,
          z: Math.max(localCenter.z, localEnd.z) + horizontalRadius
        }
      }, nearby);
      this.#localIndex.query({
        min: {
          x: Math.min(localCenter.x, localPredictedEnd.x, localLandingPreload.x)
            - horizontalRadius,
          y: Math.min(localCenter.y, localPredictedEnd.y, localLandingPreload.y)
            - horizontalRadius,
          z: Math.min(localCenter.z, localPredictedEnd.z, localLandingPreload.z)
            - horizontalRadius
        },
        max: {
          x: Math.max(localCenter.x, localPredictedEnd.x, localLandingPreload.x)
            + horizontalRadius,
          y: Math.max(localCenter.y, localPredictedEnd.y, localLandingPreload.y)
            + horizontalRadius,
          z: Math.max(localCenter.z, localPredictedEnd.z, localLandingPreload.z)
            + horizontalRadius
        }
      }, landingSearch);
    }
    return {
      landingSearch,
      nearby
    };
  }

  /** Selects at most one imminent landing OBB for each player. */
  #selectLandingTargets(
    snapshots: readonly ObbEntitySnapshot[],
    candidates: ReadonlySet<CollisionBoxState>,
    nearby: ReadonlySet<CollisionBoxState>
  ): Map<CollisionBoxState, ReadonlyMap<string, AABB>> {
    const targets = new Map<CollisionBoxState, Map<string, AABB>>();
    for (const snapshot of snapshots) {
      if (!snapshot.entity.isValid) continue;
      const start = snapshot.aabb.center;
      const relativeVelocity = subtract(snapshot.velocity, this.#body.velocity);
      const predictedEnd = add(start, scale(
        relativeVelocity,
        COLLISION_PREDICTION_TICKS
      ));
      const preloadEnd = {
        x: predictedEnd.x,
        y: Math.min(predictedEnd.y, start.y - COLLISION_DOWNWARD_PRELOAD_MARGIN),
        z: predictedEnd.z
      };
      let nearestBox: CollisionBoxState | undefined;
      let nearestTime = Number.POSITIVE_INFINITY;
      for (const box of candidates) {
        if (nearby.has(box)) continue;
        const hitTime = getSweptAabbObbHitTime(
          start,
          preloadEnd,
          snapshot.aabb.extent,
          box
        );
        if (hitTime === undefined || hitTime >= nearestTime) continue;
        nearestBox = box;
        nearestTime = hitTime;
      }
      if (!nearestBox) continue;
      const center = lerp(start, preloadEnd, nearestTime);
      let boxTargets = targets.get(nearestBox);
      if (!boxTargets) {
        boxTargets = new Map<string, AABB>();
        targets.set(nearestBox, boxTargets);
      }
      boxTargets.set(snapshot.entity.id, {
        center,
        extent: { ...snapshot.aabb.extent }
      });
    }
    return targets;
  }

  dispose(): void {
    for (const entityId of this.#managedProxyIds) allManagedProxyIds.delete(entityId);
    this.#managedProxyIds.clear();
    disposeCollisionBoxes(this.#boxes);
    this.#boxes = [];
    this.#activeBoxes.clear();
    this.#localIndex.clear();
    this.#localBounds = undefined;
    this.#bodyFrame = undefined;
    this.#frictionSurfaceStates.clear();
  }

  #hasIntactProxies(): boolean {
    try {
      for (const box of this.#boxes) box.obb.assertValid();
      return true;
    } catch {
      return false;
    }
  }

  #refreshManagedProxyIds(): void {
    for (const entityId of this.#managedProxyIds) allManagedProxyIds.delete(entityId);
    this.#managedProxyIds.clear();
    for (const box of this.#boxes) {
      box.managedProxyIds.clear();
      for (const entityId of box.obb.supportEntityIds) {
        box.managedProxyIds.add(entityId);
        this.#managedProxyIds.add(entityId);
        allManagedProxyIds.add(entityId);
      }
    }
    this.#activeBoxes = new Set(this.#boxes.filter(box => box.obb.supportCount > 0));
  }

  #applyProxyIdChanges(
    box: CollisionBoxState,
    update: Readonly<{
      addedEntityIds: readonly string[];
      removedEntityIds: readonly string[];
    }>
  ): void {
    for (const entityId of update.removedEntityIds) {
      box.managedProxyIds.delete(entityId);
      this.#managedProxyIds.delete(entityId);
      allManagedProxyIds.delete(entityId);
    }
    for (const entityId of update.addedEntityIds) {
      box.managedProxyIds.add(entityId);
      this.#managedProxyIds.add(entityId);
      allManagedProxyIds.add(entityId);
    }
  }

  #unregisterBoxProxyIds(box: CollisionBoxState): void {
    for (const entityId of box.managedProxyIds) {
      this.#managedProxyIds.delete(entityId);
      allManagedProxyIds.delete(entityId);
    }
    box.managedProxyIds.clear();
    this.#activeBoxes.delete(box);
  }

  /** Keeps ledger corruption visible without re-enumerating every proxy. */
  #assertProxyLedgerMatchesActiveBoxes(): void {
    let expectedCount = 0;
    for (const box of this.#activeBoxes) expectedCount += box.obb.supportCount;
    if (expectedCount !== this.#managedProxyIds.size) {
      throw new Error("Contraption collider ledger does not match active OBB support counts.");
    }
  }
}

/** Assigns each grounded or descending player to at most one OBB support surface. */
function assignSurfaceOwners(
  snapshots: readonly ObbEntitySnapshot[],
  updates: readonly {
    readonly box: CollisionBoxState;
    readonly transform: ObbTransform;
  }[]
): SurfaceOwner[] {
  const owners: SurfaceOwner[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.entity.isValid
      || (!snapshot.entity.isOnGround && snapshot.velocity.y >= 0)) continue;
    const feet = {
      x: snapshot.aabb.center.x,
      y: snapshot.aabb.center.y - snapshot.aabb.extent.y,
      z: snapshot.aabb.center.z
    };
    const playerHeight = snapshot.aabb.extent.y * 2;
    let owner: CollisionBoxState | undefined;
    let ownerDistance = Number.POSITIVE_INFINITY;
    let ownerContact: ObbSurfaceContact | undefined;
    for (const update of updates) {
      const contact = update.box.obb.sampleStandableSurfaceContact(
        feet,
        playerHeight
      );
      if (!contact
        || !contact.withinSurface
        || contact.normal.y <= EPSILON_1E6
        || contact.distance < -FRICTION_CONTACT_DISTANCE
        || contact.distance > FRICTION_CONTACT_DISTANCE) continue;
      const distance = Math.abs(contact.distance);
      if (distance >= ownerDistance) continue;
      owner = update.box;
      ownerDistance = distance;
      ownerContact = contact;
    }
    if (!owner || !ownerContact) continue;
    owners.push({ box: owner, contact: ownerContact, snapshot });
  }
  return owners;
}

function isJumpPressed(entity: Entity): boolean {
  return entity.typeId === "minecraft:player"
    && (entity as Player).inputInfo.getButtonState(JUMP_INPUT) === "Pressed";
}

function hasMovementInput(entity: Entity): boolean {
  if (entity.typeId !== "minecraft:player") return false;
  const movement = (entity as Player).inputInfo.getMovementVector();
  return Math.hypot(movement.x, movement.y) > 0.01;
}

/** Samples each player once for reuse by every contraption and OBB this tick. */
export function createContraptionCollisionEntitySnapshots(
  entities: readonly Entity[]
): ObbEntitySnapshot[] {
  const snapshots: ObbEntitySnapshot[] = [];
  for (const entity of entities) {
    if (!entity.isValid) continue;
    const aabb = entity.getAABB();
    const velocity = entity.getVelocity();
    assertAabb(aabb);
    if (!isFiniteVector(velocity)) {
      throw new TypeError("Collision entity velocity must be a finite vector.");
    }
    snapshots.push({ aabb, entity, velocity });
  }
  return snapshots;
}

/** Removes loaded proxies left behind by a previous script runtime. */
export function removeStaleContraptionColliders(): void {
  for (const dimensionId of VANILLA_DIMENSION_IDS) {
    const dimension = world.getDimension(dimensionId);
    for (const entity of dimension.getEntities({
      type: BLOCK_COLLIDER_ENTITY_TYPE_ID
    })) {
      if (entity.isValid) entity.remove();
    }
  }
}

/** Removes a loaded collision proxy unless a live contraption currently owns it. */
export function handleBlockColliderLoad(entity: Entity): void {
  if (entity.typeId !== BLOCK_COLLIDER_ENTITY_TYPE_ID) return;
  system.run(() => {
    if (!allManagedProxyIds.has(entity.id) && entity.isValid) entity.remove();
  });
}

function disposeCollisionBoxes(boxes: readonly CollisionBoxState[]): void {
  for (const box of boxes) box.obb.dispose();
}

function isSupportProxyIntegrityError(error: unknown): boolean {
  return error instanceof Error
    && error.message === "A solid OBB support proxy became invalid.";
}
