import type { AABB, Vector3 } from "@minecraft/server";

/** Immutable world-space neighborhood whose complete OBB intersection is loaded. */
export interface CollisionRegion {
  readonly extent: Vector3;
  readonly id: string;
  readonly location: Vector3;
}

/** Actor data required to select collision regions without contact semantics. */
export interface CollisionRegionActor {
  readonly aabb: AABB;
  readonly id: string;
  /** Retains this predictive region briefly when it is replaced or removed. */
  readonly retainPrevious?: boolean;
  readonly velocity: Vector3;
}

/** Preload distance around an actor AABB before native contact is possible. */
export interface CollisionRegionLoadMargin {
  readonly horizontal: number;
  readonly vertical: number;
}

interface RequiredBounds {
  readonly extent: Vector3;
  readonly location: Vector3;
}

interface ActiveRegion {
  readonly region: CollisionRegion;
  readonly retainPrevious: boolean;
}

interface RetiringRegion {
  readonly expiresAtTick: number;
  readonly region: CollisionRegion;
}

/** Read-only default carrier velocity; hoisted to avoid per-call allocation. */
const ZERO_VELOCITY: Vector3 = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * Maintains one compact swept neighborhood per actor.
 *
 * Each region contains spare horizontal release space and at least one actor
 * height of vertical landing space. Ordinary movement and a complete jump can
 * therefore occur without changing the collision layout. Once the predicted
 * swept AABB leaves that interior, one replacement region is computed. An
 * optional short overlap keeps the previous native collision alive while the
 * replacement becomes active in the engine.
 *
 * Grounded state, feet height, surface classification, and friction never
 * participate in this layer.
 */
export class CollisionRegionActivation {
  readonly #bucketSize: number;
  readonly #loadMargin: CollisionRegionLoadMargin;
  readonly #retentionTicks: number;
  readonly #releaseMargin: number;
  #active = new Map<string, ActiveRegion>();
  #nextRegionRevision = 0;
  #retiring: RetiringRegion[] = [];
  #tick = 0;

  constructor(
    bucketSize: number,
    releaseMargin: number,
    loadMargin: CollisionRegionLoadMargin,
    retentionTicks = 0
  ) {
    this.#bucketSize = bucketSize;
    this.#releaseMargin = releaseMargin;
    this.#loadMargin = loadMargin;
    this.#retentionTicks = retentionTicks;
  }

  update(
    actors: readonly CollisionRegionActor[],
    carrierVelocity: Vector3 = ZERO_VELOCITY
  ): CollisionRegion[] {
    this.#tick += 1;
    const next = new Map<string, ActiveRegion>();
    for (const actor of actors) {
      const required = this.#createRequiredBounds(actor, carrierVelocity);
      const current = this.#active.get(actor.id);
      if (current && containsBounds(current.region, required)) {
        next.set(actor.id, current);
        continue;
      }
      if (current && (current.retainPrevious || actor.retainPrevious)) {
        this.#retire(current.region);
      }
      next.set(actor.id, this.#createRegion(actor, required));
    }
    for (const [actorId, active] of this.#active) {
      if (!next.has(actorId) && active.retainPrevious) {
        this.#retire(active.region);
      }
    }
    this.#active = next;
    this.#retiring = this.#retiring.filter(
      retiring => retiring.expiresAtTick > this.#tick
    );
    return [
      ...[...next.values()].map(active => active.region),
      ...this.#retiring.map(retiring => retiring.region)
    ].sort((left, right) => left.id.localeCompare(right.id));
  }

  clear(): void {
    this.#active.clear();
    this.#retiring = [];
  }

  /** Builds the exact conservative AABB of actor and carrier travel this tick. */
  #createRequiredBounds(
    actor: CollisionRegionActor,
    carrierVelocity: Vector3
  ): RequiredBounds {
    const relativeVelocity = {
      x: actor.velocity.x - carrierVelocity.x,
      y: actor.velocity.y - carrierVelocity.y,
      z: actor.velocity.z - carrierVelocity.z
    };
    const center = {
      x: actor.aabb.center.x + relativeVelocity.x / 2,
      y: actor.aabb.center.y + relativeVelocity.y / 2,
      z: actor.aabb.center.z + relativeVelocity.z / 2
    };
    return {
      extent: {
        x: actor.aabb.extent.x + this.#loadMargin.horizontal
          + Math.abs(relativeVelocity.x) / 2,
        y: actor.aabb.extent.y + this.#loadMargin.vertical
          + Math.abs(relativeVelocity.y) / 2,
        z: actor.aabb.extent.z + this.#loadMargin.horizontal
          + Math.abs(relativeVelocity.z) / 2
      },
      location: center
    };
  }

  #createRegion(
    actor: CollisionRegionActor,
    required: RequiredBounds
  ): ActiveRegion {
    const location = {
      x: quantize(required.location.x, this.#bucketSize),
      y: quantize(required.location.y, this.#bucketSize),
      z: quantize(required.location.z, this.#bucketSize)
    };
    // Retaining one actor height vertically keeps the original landing volume
    // resident through a jump without inspecting grounded or airborne state.
    const verticalRelease = Math.max(
      this.#releaseMargin,
      actor.aabb.extent.y * 2
    );
    const extent = {
      x: required.extent.x + this.#releaseMargin
        + Math.abs(location.x - required.location.x),
      y: required.extent.y + verticalRelease
        + Math.abs(location.y - required.location.y),
      z: required.extent.z + this.#releaseMargin
        + Math.abs(location.z - required.location.z)
    };
    return {
      region: {
        extent,
        id: this.#retentionTicks > 0 && actor.retainPrevious
          ? `${actor.id}:${this.#nextRegionRevision++}`
          : actor.id,
        location
      },
      retainPrevious: actor.retainPrevious === true
    };
  }

  /** Keeps the previous native collision alive while its replacement settles. */
  #retire(region: CollisionRegion): void {
    if (this.#retentionTicks === 0) return;
    this.#retiring.push({
      expiresAtTick: this.#tick + this.#retentionTicks,
      region
    });
  }
}

function containsBounds(
  region: CollisionRegion,
  required: RequiredBounds
): boolean {
  return Math.abs(region.location.x - required.location.x) + required.extent.x
      <= region.extent.x
    && Math.abs(region.location.y - required.location.y) + required.extent.y
      <= region.extent.y
    && Math.abs(region.location.z - required.location.z) + required.extent.z
      <= region.extent.z;
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}
