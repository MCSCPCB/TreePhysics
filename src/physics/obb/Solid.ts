import type { AABB, Dimension, Entity, InputButton, Player, Vector3 } from "@minecraft/server";
import {
  CollisionRegionActivation,
  type CollisionRegion
} from "./internal/Activation";
import { SupportSurface } from "./internal/Collision";
import { ObbGeometry } from "./internal/Geometry";
import { applyTangentialFriction } from "./internal/Motion";
import { EPSILON_1E6, add, length, subtract } from "@src/utils/Vector3Math";
import {
  EMPTY_COLLISION_UPDATE,
  type ObbBox,
  type ObbCollisionShell,
  type ObbCollisionUpdate,
  type ObbEntitySnapshot,
  type ObbSurfaceContact,
  type ObbSettings,
  type ObbSize,
  type ObbTransform,
  type ObbUpdateOptions,
  type ObbUpdateResult,
  type SolidObbOptions
} from "./Types";
import { resolveSettings, resolveSupportPresets } from "./internal/Settings";

const MAXIMUM_PITCH = 90;
const POSITION_EPSILON = EPSILON_1E6;
const DEFAULT_PLAYER_HEIGHT = 1.8;
const SURFACE_CONTACT_ACQUIRE_DISTANCE = 0.25;
const JUMP_INPUT = "Jump" as InputButton;
const PLAYER_TYPE_ID = "minecraft:player";
const FULL_COLLISION_REGION_ID = "obb:full-collision";

interface FrictionContact {
  readonly contact: ObbSurfaceContact;
  readonly entity: EntitySnapshot;
  readonly transferSurfaceDelta: boolean;
}

interface FrictionSummary {
  readonly count: number;
  readonly impulse: number;
}

/** Stable actor data shared by collision and friction in one update. */
interface EntitySnapshot extends ObbEntitySnapshot {
  readonly player?: Player;
}

/** A moving, entity-collidable OBB with local +Y as its designated face. */
export class SolidObb {
  readonly initialCollisionUpdate: ObbCollisionUpdate;
  readonly settings: ObbSettings;
  readonly size: ObbSize;
  readonly #dimension: Dimension;
  readonly #collisionActivation: CollisionRegionActivation;
  /** Fixed for the instance lifetime; built once instead of per native query. */
  readonly #entityQueryExcludeTypes: string[];
  readonly #entityQueryRadius: number;
  readonly #fullCollisionExtent: number;
  readonly #geometry: ObbGeometry;
  readonly #supportEntityTypeId: string;
  readonly #surface: SupportSurface;
  readonly #usesFullCollision: boolean;
  #disposed = false;
  #frictionSurfaceVelocities = new Map<string, Vector3>();
  #movingTicksSinceCollision = 0;
  #collisionShell: ObbCollisionShell = "solid";
  #transform: ObbTransform;

  constructor(options: SolidObbOptions) {
    assertEntityTypeId(options.supportEntityTypeId, "supportEntityTypeId");
    assertBox(options.box);
    assertEntitySources(options.entityCandidates, options.entitySnapshots);
    this.settings = resolveSettings(options.settings);
    this.size = Object.freeze({ ...options.box.size });
    this.#dimension = options.dimension;
    this.#supportEntityTypeId = options.supportEntityTypeId;
    this.#entityQueryExcludeTypes = [options.supportEntityTypeId];
    this.#transform = copyTransform(options.box);
    this.#geometry = new ObbGeometry(
      this.size,
      this.settings,
      resolveSupportPresets(options.supportPresets, this.settings)
    );
    this.#collisionActivation = new CollisionRegionActivation(
      this.settings.collisionActivationBucketSize,
      this.settings.collisionUnloadMargin,
      {
        horizontal: this.#geometry.supportActivationRadius,
        vertical: this.#geometry.supportActivationVerticalMargin
      },
      this.settings.collisionRegionRetentionTicks
    );
    const boundingDiameter = Math.hypot(
      this.size.width,
      this.size.height,
      this.size.depth
    );
    this.#fullCollisionExtent = boundingDiameter / 2;
    const maximumColumns = Math.ceil((
      boundingDiameter + this.settings.supportWidth
    ) / this.settings.spacing.forward) * Math.ceil((
      boundingDiameter + this.settings.supportWidth
    ) / this.settings.spacing.sideways);
    this.#usesFullCollision = maximumColumns
      <= this.settings.fullCollisionColumnLimit;
    this.#entityQueryRadius = this.#fullCollisionExtent
      + this.settings.collisionQueryMargin
      + this.#geometry.supportActivationRadius;
    this.#surface = new SupportSurface(
      options.dimension,
      options.supportEntityTypeId,
      this.#geometry,
      this.#transform
    );
    const initialRegions = this.#selectRegions(
      this.#transform,
      options.entityCandidates,
      options.entitySnapshots
    );
    this.initialCollisionUpdate = this.#surface.sync(
      this.#transform,
      initialRegions
    );
  }

  get box(): ObbBox {
    return { ...copyTransform(this.#transform), size: { ...this.size } };
  }

  get supportCount(): number { return this.#surface.size; }

  get supportEntityIds(): readonly string[] { return this.#surface.entityIds; }

  get transform(): ObbTransform { return copyTransform(this.#transform); }

  /** Whether collision is permanently resident without actor activation queries. */
  get usesFullCollision(): boolean { return this.#usesFullCollision; }

  /** Updates the cached pose without changing the native support layout. */
  updateTransformOnly(transform: ObbTransform): void {
    this.assertValid();
    assertTransform(transform);
    this.#transform = copyTransform(transform);
  }

  /** Applies a new 3D position and complete yaw-pitch-roll orientation. */
  update(
    transform: ObbTransform,
    options: ObbUpdateOptions = {}
  ): ObbUpdateResult {
    this.assertValid();
    assertTransform(transform);
    assertEntitySources(options.entityCandidates, options.entitySnapshots);
    const previousTransform = this.#transform;
    const collisionShell = options.collisionShell ?? "solid";
    const nextTransform = copyTransform(transform);
    const velocity = subtract(nextTransform.center, previousTransform.center);
    const transformChanged = hasMovement(velocity)
      || Math.abs(nextTransform.pitch - previousTransform.pitch) > POSITION_EPSILON
      || Math.abs(nextTransform.roll - previousTransform.roll) > POSITION_EPSILON
      || Math.abs(nextTransform.yaw - previousTransform.yaw) > POSITION_EPSILON;
    // Full-collision boxes keep their proxies resident without activation, so
    // the actor query only serves friction. Skip it entirely whenever this
    // update cannot produce a friction impulse (stationary pose, friction
    // disabled, or a zero static-impulse budget).
    const entities = this.#usesFullCollision
      ? transformChanged
        && options.friction !== false
        && this.settings.friction.maxStaticImpulse > POSITION_EPSILON
        ? this.#getNearbyEntities(
          previousTransform,
          nextTransform,
          options.entityCandidates,
          options.entitySnapshots
        )
        : []
      : this.#getNearbyEntities(
        previousTransform,
        nextTransform,
        options.entityCandidates,
        options.entitySnapshots,
        options.collisionActivationAabbs
      );
    const regions = this.#usesFullCollision
      ? [this.#createFullCollisionRegion(nextTransform)]
      : this.#collisionActivation.update(
        entities.map(snapshot => {
          const activationAabb = options.collisionActivationAabbs
            ?.get(snapshot.entity.id);
          return {
            aabb: activationAabb ?? snapshot.aabb,
            id: snapshot.entity.id,
            retainPrevious: activationAabb !== undefined,
            // The virtual landing AABB already represents the predicted
            // contact point; sweeping it again would preload inside the OBB.
            velocity: activationAabb ? velocity : snapshot.velocity
          };
        }),
        velocity
      );
    // A locally activated empty OBB has no collision or friction work until
    // an actor enters its conservative query range. Keep only the new pose;
    // the first non-empty region still forces a complete collision sync.
    if (!this.#usesFullCollision
      && regions.length === 0
      && this.#surface.size === 0) {
      this.#frictionSurfaceVelocities.clear();
      this.#movingTicksSinceCollision = 0;
      this.#collisionShell = collisionShell;
      this.#transform = nextTransform;
      const collision = (options.syncCollision
        || this.#surface.regionsChanged([], collisionShell))
        ? this.#surface.sync(nextTransform, [], collisionShell)
        : EMPTY_COLLISION_UPDATE;
      return {
        collision,
        frictionImpulse: 0,
        frictionEntities: 0,
        transformChanged,
        velocity
      };
    }
    // A pose-identical update is collision-only regardless of actor state.
    // This is the hard boundary between persistent native collision and
    // carrier motion: falling, jumping, or contact error cannot authorize an
    // impulse from a stationary OBB.
    const frictionCandidates = transformChanged && options.friction !== false
      ? entities.filter(snapshot => !options.frictionEntityIds
        || options.frictionEntityIds.has(snapshot.entity.id))
      : [];
    const frictionContacts = this.#collectFrictionContacts(
      previousTransform,
      frictionCandidates,
      options.frictionContacts
    );
    let collision = EMPTY_COLLISION_UPDATE;

    if (transformChanged) this.#movingTicksSinceCollision += 1;
    if (options.syncCollision
      || (transformChanged
        && this.#movingTicksSinceCollision >= this.settings.collisionUpdateInterval)
        || this.#surface.regionsChanged(regions, collisionShell)) {
      collision = this.#surface.sync(
        nextTransform,
        regions,
        collisionShell
      );
      this.#movingTicksSinceCollision = 0;
    }
    this.#collisionShell = collisionShell;
    this.#transform = nextTransform;
    const friction = this.#applyFriction(
      frictionContacts,
      previousTransform,
      nextTransform
    );
    return {
      collision,
      frictionImpulse: friction.impulse,
      frictionEntities: friction.count,
      transformChanged,
      velocity
    };
  }

  /** Synchronizes the current final collision layout immediately. */
  syncCollision(): ObbCollisionUpdate {
    this.assertValid();
    const regions = this.#selectRegions(this.#transform);
    const result = this.#surface.sync(
      this.#transform,
      regions,
      this.#collisionShell
    );
    this.#movingTicksSinceCollision = 0;
    return result;
  }

  getSurfaceY(position: Readonly<{ x: number; z: number }>): number {
    this.#assertActive();
    return this.#geometry.getSurfaceY(this.#transform, position);
  }

  /** Returns one point on the current top face in local coordinates. */
  getSurfacePoint(localForward: number, localSideways: number): Vector3 {
    this.#assertActive();
    assertFinite(localForward, "localForward");
    assertFinite(localSideways, "localSideways");
    return this.#geometry.getSurfacePoint(
      this.#transform,
      localForward,
      localSideways
    );
  }

  getSupportTop(location: Vector3): number | undefined {
    this.assertValid();
    return this.#surface.getTopAt(
      location,
      this.settings.contactRadius
    );
  }

  /** Samples an upright player capsule against the current top face. */
  sampleSurfaceContact(
    playerLocation: Vector3,
    playerHeight = DEFAULT_PLAYER_HEIGHT
  ): ObbSurfaceContact {
    this.#assertActive();
    if (!isFiniteVector(playerLocation)) {
      throw new TypeError("playerLocation must be a finite vector.");
    }
    return this.#geometry.sampleSurfaceContact(
      this.#transform,
      playerLocation,
      this.settings.contactRadius,
      playerHeight
    );
  }

  /** Samples the nearest upward-facing face for grounded friction. */
  sampleStandableSurfaceContact(
    playerLocation: Vector3,
    playerHeight = DEFAULT_PLAYER_HEIGHT
  ): ObbSurfaceContact | undefined {
    this.#assertActive();
    if (!isFiniteVector(playerLocation)) {
      throw new TypeError("playerLocation must be a finite vector.");
    }
    return this.#geometry.sampleStandableSurfaceContact(
      this.#transform,
      playerLocation,
      this.settings.contactRadius,
      playerHeight
    );
  }

  /** Returns current contact-point displacement for a proposed next pose. */
  getSurfaceVelocity(
    transform: ObbTransform,
    contact: Pick<
      ObbSurfaceContact,
      "localForward" | "localPoint" | "localSideways"
    >
  ): Vector3 {
    this.#assertActive();
    assertTransform(transform);
    if (!contact
      || !Number.isFinite(contact.localForward)
      || !Number.isFinite(contact.localSideways)) {
      throw new TypeError("contact must contain finite local surface coordinates.");
    }
    return contact.localPoint
      ? this.#geometry.getPointVelocity(
        this.#transform,
        transform,
        contact.localPoint
      )
      : this.#geometry.getSurfaceVelocity(
        this.#transform,
        transform,
        contact.localForward,
        contact.localSideways
      );
  }

  assertValid(): void {
    this.#assertActive();
    this.#surface.assertValid();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#collisionActivation.clear();
    this.#frictionSurfaceVelocities.clear();
    this.#surface.dispose();
  }

  /** Selects the active collision regions for one stationary-pose query. */
  #selectRegions(
    transform: ObbTransform,
    candidates?: readonly Entity[],
    sharedSnapshots?: readonly ObbEntitySnapshot[]
  ): CollisionRegion[] {
    return this.#usesFullCollision
      ? [this.#createFullCollisionRegion(transform)]
      : this.#collisionActivation.update(
        this.#getNearbyEntities(
          transform,
          transform,
          candidates,
          sharedSnapshots
        ).map(snapshot => ({
          aabb: snapshot.aabb,
          id: snapshot.entity.id,
          velocity: snapshot.velocity
        }))
      );
  }

  /** Performs the one ranged actor query shared by collision and friction. */
  #getNearbyEntities(
    previousTransform: ObbTransform,
    transform: ObbTransform,
    candidates?: readonly Entity[],
    sharedSnapshots?: readonly ObbEntitySnapshot[],
    collisionActivationAabbs?: ReadonlyMap<string, AABB>
  ): EntitySnapshot[] {
    if (candidates?.length === 0 || sharedSnapshots?.length === 0) return [];
    const query = this.#createEntityQuery(previousTransform, transform);
    if (sharedSnapshots) {
      return this.#filterEntitySnapshots(
        sharedSnapshots,
        previousTransform,
        transform,
        query.radius,
        collisionActivationAabbs
      );
    }
    const entities = candidates ?? this.#dimension.getEntities({
        excludeTypes: this.#entityQueryExcludeTypes,
        location: query.center,
        maxDistance: query.radius
      });
    return this.#createEntitySnapshots(
      entities,
      previousTransform,
      transform,
      query.radius
    );
  }

  #createEntityQuery(
    previousTransform: ObbTransform,
    transform: ObbTransform
  ): Readonly<{ center: Vector3; radius: number }> {
    const transformTravel = length(subtract(
      transform.center,
      previousTransform.center
    ));
    return {
      center: midpoint(previousTransform.center, transform.center),
      radius: this.#entityQueryRadius + transformTravel / 2
    };
  }

  #createEntitySnapshots(
    entities: readonly Entity[],
    previousTransform: ObbTransform,
    transform: ObbTransform,
    queryRadius: number
  ): EntitySnapshot[] {
    const snapshots: EntitySnapshot[] = [];
    for (const entity of entities) {
      if (!entity.isValid || entity.typeId === this.#supportEntityTypeId) continue;
      const aabb = entity.getAABB();
      assertAabb(aabb);
      const velocity = entity.getVelocity();
      if (!isFiniteVector(velocity)) {
        throw new TypeError("entity velocity must be a finite vector.");
      }
      if (isWithinSweptRange(
        aabb,
        velocity,
        previousTransform,
        transform,
        queryRadius
      )) {
        snapshots.push(createEntitySnapshot(entity, copyAabb(aabb), velocity));
      }
    }
    return snapshots;
  }

  /** Filters shared snapshots without repeating native AABB or velocity calls. */
  #filterEntitySnapshots(
    sharedSnapshots: readonly ObbEntitySnapshot[],
    previousTransform: ObbTransform,
    transform: ObbTransform,
    queryRadius: number,
    collisionActivationAabbs?: ReadonlyMap<string, AABB>
  ): EntitySnapshot[] {
    const snapshots: EntitySnapshot[] = [];
    for (const snapshot of sharedSnapshots) {
      const { aabb, entity, velocity } = snapshot;
      if (!entity?.isValid || entity.typeId === this.#supportEntityTypeId) continue;
      assertAabb(aabb);
      if (!isFiniteVector(velocity)) {
        throw new TypeError("entity snapshot velocity must be a finite vector.");
      }
      const activationAabb = collisionActivationAabbs?.get(entity.id);
      const activationRelative = activationAabb
        ? subtract(activationAabb.center, transform.center)
        : undefined;
      const activationRadius = activationAabb
        ? Math.hypot(
          activationAabb.extent.x,
          activationAabb.extent.y,
          activationAabb.extent.z
        )
        : 0;
      const actualInRange = isWithinSweptRange(
        aabb,
        velocity,
        previousTransform,
        transform,
        queryRadius
      );
      const activationInRange = activationRelative !== undefined
        && length(activationRelative) <= queryRadius + activationRadius;
      if (!actualInRange && !activationInRange) continue;
      snapshots.push(createEntitySnapshot(entity, aabb, velocity));
    }
    return snapshots;
  }

  #createFullCollisionRegion(transform: ObbTransform): CollisionRegion {
    const extent = this.#fullCollisionExtent;
    return {
      extent: { x: extent, y: extent, z: extent },
      id: FULL_COLLISION_REGION_ID,
      location: { ...transform.center }
    };
  }

  /** Finds grounded designated-face contacts eligible for finite friction. */
  #collectFrictionContacts(
    previousTransform: ObbTransform,
    entities: readonly EntitySnapshot[],
    sampledContacts?: ReadonlyMap<string, ObbSurfaceContact>
  ): FrictionContact[] {
    const contacts: FrictionContact[] = [];
    for (const snapshot of entities) {
      const { aabb, entity, player } = snapshot;
      if (!entity.isValid
        || !entity.isOnGround
        || (player && isJumpPressed(player))) continue;
      const entityHeight = aabb.extent.y * 2;
      const entityHalfWidth = Math.max(aabb.extent.x, aabb.extent.z);
      const feet = getAabbFeet(aabb);
      const contact = sampledContacts?.get(entity.id)
        ?? this.#geometry.sampleStandableSurfaceContact(
          previousTransform,
          feet,
          entityHalfWidth,
          entityHeight
        );
      if (contact && canAcquireSurfaceContact(contact)) {
        contacts.push({
          contact,
          entity: snapshot,
          transferSurfaceDelta: Boolean(player && hasMovementInput(player))
        });
      }
    }
    return contacts;
  }

  /** Applies only bounded tangential friction at current top-face contacts. */
  #applyFriction(
    contacts: readonly FrictionContact[],
    previousTransform: ObbTransform,
    transform: ObbTransform
  ): FrictionSummary {
    let count = 0;
    let impulse = 0;
    const activeEntityIds = new Set<string>();
    for (const {
      contact,
      entity: snapshot,
      transferSurfaceDelta
    } of contacts) {
      if (!snapshot.entity.isValid) continue;
      activeEntityIds.add(snapshot.entity.id);
      const surfaceVelocity = contact.localPoint
        ? this.#geometry.getPointVelocity(
          previousTransform,
          transform,
          contact.localPoint
        )
        : this.#geometry.getSurfaceVelocity(
          previousTransform,
          transform,
          contact.localForward,
          contact.localSideways
        );
      const result = applyTangentialFriction({
        entity: snapshot.entity,
        entityVelocity: snapshot.velocity,
        normal: contact.normal,
        previousSurfaceVelocity:
          this.#frictionSurfaceVelocities.get(snapshot.entity.id),
        settings: this.settings.friction,
        surfaceVelocity,
        transferSurfaceDelta
      });
      this.#frictionSurfaceVelocities.set(
        snapshot.entity.id,
        { ...surfaceVelocity }
      );
      if (result.magnitude <= POSITION_EPSILON) continue;
      count += 1;
      impulse += result.magnitude;
    }
    for (const entityId of this.#frictionSurfaceVelocities.keys()) {
      if (!activeEntityIds.has(entityId)) {
        this.#frictionSurfaceVelocities.delete(entityId);
      }
    }
    return { count, impulse };
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("The solid OBB has been disposed.");
  }
}

function canAcquireSurfaceContact(contact: ObbSurfaceContact): boolean {
  return isStandableTopFace(contact)
    && contact.withinSurface
    && contact.distance >= -SURFACE_CONTACT_ACQUIRE_DISTANCE
    && contact.distance <= SURFACE_CONTACT_ACQUIRE_DISTANCE;
}

/** A vertical top face is side collision, not a grounded friction surface. */
function isStandableTopFace(contact: ObbSurfaceContact): boolean {
  return contact.normal.y > POSITION_EPSILON;
}

function isJumpPressed(player: Player): boolean {
  return player.inputInfo.getButtonState(JUMP_INPUT) === "Pressed";
}

function hasMovementInput(player: Player): boolean {
  const movement = player.inputInfo.getMovementVector();
  return Math.hypot(movement.x, movement.y) > 0.01;
}


function assertEntitySources(
  candidates: readonly Entity[] | undefined,
  snapshots: readonly ObbEntitySnapshot[] | undefined
): void {
  if (candidates !== undefined && snapshots !== undefined) {
    throw new TypeError(
      "entityCandidates and entitySnapshots are mutually exclusive."
    );
  }
  if (candidates !== undefined && !Array.isArray(candidates)) {
    throw new TypeError("entityCandidates must be an array of entities.");
  }
  if (snapshots !== undefined && !Array.isArray(snapshots)) {
    throw new TypeError("entitySnapshots must be an array of snapshots.");
  }
}

function assertBox(box: ObbBox): void {
  if (!box) throw new TypeError("box is required.");
  assertTransform(box);
  assertPositive(box.size?.depth, "box.size.depth");
  assertPositive(box.size?.height, "box.size.height");
  assertPositive(box.size?.width, "box.size.width");
}

function assertTransform(transform: ObbTransform): void {
  if (!transform
    || !isFiniteVector(transform.center)
    || !Number.isFinite(transform.pitch)
    || !Number.isFinite(transform.roll)
    || !Number.isFinite(transform.yaw)) {
    throw new TypeError(
      "transform must contain a finite center, pitch, roll, and yaw."
    );
  }
  if (Math.abs(transform.pitch) > MAXIMUM_PITCH) {
    throw new RangeError(
      `transform.pitch must be between -${MAXIMUM_PITCH} and ${MAXIMUM_PITCH} degrees.`
    );
  }
}

function assertEntityTypeId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty entity type identifier.`);
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number.`);
  }
}

function assertAabb(aabb: AABB): void {
  if (!aabb
    || !isFiniteVector(aabb.center)
    || !isFiniteVector(aabb.extent)
    || aabb.extent.x <= 0
    || aabb.extent.y <= 0
    || aabb.extent.z <= 0) {
    throw new TypeError("entity AABB must contain a finite center and positive extent.");
  }
}

function copyTransform(transform: ObbTransform): ObbTransform {
  return {
    center: { ...transform.center },
    pitch: transform.pitch,
    roll: transform.roll,
    yaw: transform.yaw
  };
}

function copyAabb(aabb: AABB): AABB {
  return {
    center: { ...aabb.center },
    extent: { ...aabb.extent }
  };
}

function getAabbFeet(aabb: AABB): Vector3 {
  return {
    x: aabb.center.x,
    y: aabb.center.y - aabb.extent.y,
    z: aabb.center.z
  };
}

/** Exact swept-segment broad-phase test shared by both snapshot paths. */
function isWithinSweptRange(
  aabb: AABB,
  velocity: Vector3,
  previousTransform: ObbTransform,
  transform: ObbTransform,
  queryRadius: number
): boolean {
  const relativeStart = subtract(aabb.center, previousTransform.center);
  const relativeEnd = subtract(
    add(aabb.center, velocity),
    transform.center
  );
  const entityRadius = Math.hypot(
    aabb.extent.x,
    aabb.extent.y,
    aabb.extent.z
  );
  return getSegmentDistanceSquaredToOrigin(relativeStart, relativeEnd)
    <= (queryRadius + entityRadius) ** 2;
}

/** Downcasts the player once so friction can read input state later. */
function createEntitySnapshot(
  entity: Entity,
  aabb: AABB,
  velocity: Vector3
): EntitySnapshot {
  return {
    aabb,
    entity,
    player: entity.typeId === PLAYER_TYPE_ID
      ? entity as Player
      : undefined,
    velocity
  };
}

function midpoint(left: Vector3, right: Vector3): Vector3 {
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    z: (left.z + right.z) / 2
  };
}


function getSegmentDistanceSquaredToOrigin(start: Vector3, end: Vector3): number {
  const delta = subtract(end, start);
  const lengthSquared = delta.x * delta.x
    + delta.y * delta.y
    + delta.z * delta.z;
  if (lengthSquared <= POSITION_EPSILON) {
    return start.x * start.x + start.y * start.y + start.z * start.z;
  }
  const time = Math.max(0, Math.min(1, -(
    start.x * delta.x + start.y * delta.y + start.z * delta.z
  ) / lengthSquared));
  const closest = {
    x: start.x + delta.x * time,
    y: start.y + delta.y * time,
    z: start.z + delta.z * time
  };
  return closest.x * closest.x
    + closest.y * closest.y
    + closest.z * closest.z;
}

function hasMovement(value: Vector3): boolean {
  return Math.abs(value.x) > POSITION_EPSILON
    || Math.abs(value.y) > POSITION_EPSILON
    || Math.abs(value.z) > POSITION_EPSILON;
}
function isFiniteVector(value: Vector3): boolean {
  return Boolean(value)
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z);
}
