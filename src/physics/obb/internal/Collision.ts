import type { Dimension, Entity, Vector3 } from "@minecraft/server";
import type { CollisionRegion } from "./Activation";
import { ObbGeometry, type SupportGridOrigin } from "./Geometry";
import type {
  ObbCollisionShell,
  ObbCollisionUpdate,
  ObbTransform,
  SupportPlacement
} from "../Types";
import { EPSILON_1E6 } from "@src/utils/Vector3Math";

const POSITION_EPSILON = EPSILON_1E6;

interface SupportRecord {
  readonly entity: Entity;
  readonly presetEvent: string | undefined;
  readonly presetId: string | undefined;
  readonly presetRemoveEvent: string | undefined;
  readonly reportsSupportTop: boolean;
  readonly reuseGroup: string | undefined;
  readonly topY: number;
  readonly width: number;
  readonly x: number;
  readonly z: number;
}

const UNCHANGED_COLLISION: ObbCollisionUpdate = Object.freeze({
  addedEntityIds: Object.freeze([]),
  changed: false,
  removed: 0,
  removedEntityIds: Object.freeze([]),
  spawned: 0
});

/** Owns persistent proxies and trims them to nearby actor contact regions. */
export class SupportSurface {
  readonly #dimension: Dimension;
  readonly #entityTypeId: string;
  readonly #geometry: ObbGeometry;
  readonly #gridOrigin: SupportGridOrigin;
  readonly #initialCenterY: number;
  #regionSignature: string | undefined;
  #supports = new Map<string, SupportRecord>();

  constructor(
    dimension: Dimension,
    entityTypeId: string,
    geometry: ObbGeometry,
    initialTransform: ObbTransform
  ) {
    this.#dimension = dimension;
    this.#entityTypeId = entityTypeId;
    this.#geometry = geometry;
    this.#gridOrigin = geometry.getSupportGridOrigin(initialTransform);
    this.#initialCenterY = initialTransform.center.y;
  }

  get size(): number {
    return this.#supports.size;
  }

  get entityIds(): readonly string[] {
    return [...this.#supports.values()].map(support => support.entity.id);
  }

  /** Returns whether the fixed set of active world regions changed. */
  regionsChanged(
    regions: readonly CollisionRegion[],
    collisionShell: ObbCollisionShell
  ): boolean {
    return getRegionSignature(regions, collisionShell) !== this.#regionSignature;
  }

  /** Atomically moves existing proxies after the owning OBB validates them. */
  sync(
    transform: ObbTransform,
    regions: readonly CollisionRegion[],
    collisionShell: ObbCollisionShell = "solid"
  ): ObbCollisionUpdate {
    const regionSignature = getRegionSignature(regions, collisionShell);
    if (regions.length === 0 && this.#supports.size === 0) {
      this.#regionSignature = regionSignature;
      return UNCHANGED_COLLISION;
    }
    // X/Z remain on the lifetime world grid. Only the Y coordinate of the
    // same active cell may move; horizontal changes spawn overlapping
    // replacements before obsolete permanently collidable entities are removed.
    const gridOrigin = {
      x: this.#gridOrigin.x,
      y: this.#gridOrigin.y + transform.center.y - this.#initialCenterY,
      z: this.#gridOrigin.z
    };
    // All nearby actor neighborhoods form one union before compression. This
    // preserves the exact collision volume without duplicating complete proxy
    // sets at artificial region boundaries.
    const placements = collisionShell === "walking"
      ? this.#geometry.createNearbyWalkingShellPlacements(
        transform,
        gridOrigin,
        regions
      )
      : this.#geometry.createNearbyCollisionPlacements(
        transform,
        gridOrigin,
        regions
      );
    const nextSupports = new Map<string, SupportRecord>();
    const pendingPlacements: Array<readonly [string, SupportPlacement]> = [];
    let layoutChanged = placements.size !== this.#supports.size;
    for (const [key, placement] of placements) {
      const existing = this.#supports.get(key);
      if (existing && hasSamePlacement(existing, placement)) {
        nextSupports.set(key, existing);
      } else {
        layoutChanged = true;
        pendingPlacements.push([key, placement]);
      }
    }
    if (!layoutChanged) {
      this.#regionSignature = regionSignature;
      return UNCHANGED_COLLISION;
    }

    const claimedEntities = new Set<Entity>();
    for (const support of nextSupports.values()) {
      claimedEntities.add(support.entity);
    }
    const reusableSupportsByColumn = createReusableSupportColumnIndex(
      this.#supports.values()
    );
    const movedEntities: Array<readonly [
      SupportRecord,
      SupportPlacement,
      Vector3
    ]> = [];
    const spawnedEntities: Entity[] = [];
    try {
      for (const [key, placement] of pendingPlacements) {
        const keyed = this.#supports.get(key);
        const existing = keyed
          && !claimedEntities.has(keyed.entity)
          && canReuseSupport(keyed, placement)
          ? keyed
          : findVerticalReusableSupport(
            placement,
            claimedEntities,
            reusableSupportsByColumn
          );
        if (existing) {
          if (Math.abs(existing.x - placement.location.x) > POSITION_EPSILON
            || Math.abs(existing.z - placement.location.z) > POSITION_EPSILON) {
            throw new Error(
              `Fixed support cell ${key} moved horizontally before its height update.`
            );
          }
          const previousLocation = { ...existing.entity.location };
          movedEntities.push([existing, placement, previousLocation]);
          setSupportPreset(existing, placement);
          existing.entity.teleport(placement.location);
          claimedEntities.add(existing.entity);
          nextSupports.set(key, createSupportRecord(
            existing.entity,
            placement,
            this.#geometry.supportHalfSize * 2
          ));
          continue;
        }
        const entity = this.#dimension.spawnEntity(this.#entityTypeId, placement.location);
        spawnedEntities.push(entity);
        claimedEntities.add(entity);
        if (placement.preset?.event) entity.triggerEvent(placement.preset.event);
        nextSupports.set(key, createSupportRecord(
          entity,
          placement,
          this.#geometry.supportHalfSize * 2
        ));
      }
    } catch (error) {
      // Preserve the previous active surface if a move or spawn fails midway.
      for (const entity of spawnedEntities) {
        if (entity.isValid) entity.remove();
      }
      for (let index = movedEntities.length - 1; index >= 0; index -= 1) {
        const [previous, placement, previousLocation] = movedEntities[index]!;
        if (!previous.entity.isValid) continue;
        restoreSupportPreset(previous, placement);
        previous.entity.teleport(previousLocation);
      }
      throw error;
    }

    // Spawn and validate the complete replacement layout first. Obsolete
    // permanently collidable entities can then be removed in the same script
    // update without leaving partial collision when creation throws.
    let removed = 0;
    const removedEntityIds: string[] = [];
    for (const support of this.#supports.values()) {
      if (!claimedEntities.has(support.entity)) {
        removedEntityIds.push(support.entity.id);
        if (support.entity.isValid) support.entity.remove();
        removed += 1;
      }
    }
    this.#supports = nextSupports;
    this.#regionSignature = regionSignature;
    return {
      addedEntityIds: spawnedEntities.map(entity => entity.id),
      changed: true,
      removed,
      removedEntityIds,
      spawned: spawnedEntities.length
    };
  }

  /** Highest active proxy touching a horizontal point and contact radius. */
  getTopAt(location: Vector3, contactRadius: number): number | undefined {
    if (!Number.isFinite(contactRadius) || contactRadius < 0) {
      throw new RangeError("contactRadius must be a finite non-negative number.");
    }
    let topY: number | undefined;
    for (const support of this.#supports.values()) {
      if (!support.reportsSupportTop) continue;
      const radius = contactRadius + support.width / 2;
      if (Math.abs(location.x - support.x) > radius
        || Math.abs(location.z - support.z) > radius) continue;
      if (topY === undefined || support.topY > topY) topY = support.topY;
    }
    return topY;
  }

  assertValid(): void {
    for (const support of this.#supports.values()) {
      if (!support.entity.isValid) {
        throw new Error("A solid OBB support proxy became invalid.");
      }
    }
  }

  dispose(): void {
    for (const support of this.#supports.values()) {
      if (support.entity.isValid) support.entity.remove();
    }
    this.#supports.clear();
  }

}

interface IndexedSupportRecord {
  readonly order: number;
  readonly support: SupportRecord;
}

/** Groups reusable entities by their immutable XZ lattice column. */
function createReusableSupportColumnIndex(
  supports: Iterable<SupportRecord>
): ReadonlyMap<string, readonly IndexedSupportRecord[]> {
  const columns = new Map<string, IndexedSupportRecord[]>();
  let order = 0;
  for (const support of supports) {
    const key = supportColumnKey(
      quantizeSupportCoordinate(support.x),
      quantizeSupportCoordinate(support.z),
      support.reuseGroup
    );
    const column = columns.get(key);
    const indexed = { order, support };
    if (column) column.push(indexed);
    else columns.set(key, [indexed]);
    order += 1;
  }
  return columns;
}

/** Reuses the same nearest compatible entity without scanning other columns. */
function findVerticalReusableSupport(
  placement: SupportPlacement,
  claimedEntities: ReadonlySet<Entity>,
  columns: ReadonlyMap<string, readonly IndexedSupportRecord[]>
): SupportRecord | undefined {
  let nearest: SupportRecord | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestOrder = Number.POSITIVE_INFINITY;
  const xBucket = quantizeSupportCoordinate(placement.location.x);
  const zBucket = quantizeSupportCoordinate(placement.location.z);
  const candidates: IndexedSupportRecord[] = [];
  // Neighbor buckets preserve the original epsilon comparison at rounding
  // boundaries; explicit order keeps equal-distance selection deterministic.
  for (let zOffset = -1; zOffset <= 1; zOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      candidates.push(...columns.get(supportColumnKey(
        xBucket + xOffset,
        zBucket + zOffset,
        placement.reuseGroup
      )) ?? []);
    }
  }
  for (const { order, support } of candidates) {
    if (claimedEntities.has(support.entity)) continue;
    if (support.reuseGroup !== placement.reuseGroup
      || Math.abs(support.x - placement.location.x) > POSITION_EPSILON
      || Math.abs(support.z - placement.location.z) > POSITION_EPSILON) continue;
    if (!canReuseSupport(support, placement)) continue;
    const distance = Math.abs(support.entity.location.y - placement.location.y);
    if (distance > nearestDistance
      || (distance === nearestDistance && order >= nearestOrder)) continue;
    nearest = support;
    nearestDistance = distance;
    nearestOrder = order;
  }
  return nearest;
}

function supportColumnKey(
  xBucket: number,
  zBucket: number,
  reuseGroup: string | undefined
): string {
  return `${xBucket},${zBucket}:${reuseGroup ?? ""}`;
}

function quantizeSupportCoordinate(value: number): number {
  return Math.round(value / POSITION_EPSILON);
}

function getRegionSignature(
  regions: readonly CollisionRegion[],
  collisionShell: ObbCollisionShell
): string {
  const signatures = new Array<string>(regions.length);
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    const location = collisionShell === "walking"
      ? `:${region.location.x},${region.location.y},${region.location.z}`
      : "";
    signatures[index] = `${region.id}${location}:${region.extent.x},${region.extent.y},${region.extent.z}`;
  }
  if (signatures.length > 1) signatures.sort();
  return `${collisionShell}|${signatures.join("|")}`;
}

function hasSamePlacement(
  support: SupportRecord,
  placement: SupportPlacement
): boolean {
  return Math.abs(support.x - placement.location.x) < EPSILON_1E6
    && Math.abs(support.z - placement.location.z) < EPSILON_1E6
    && Math.abs(support.topY - placement.topY) < EPSILON_1E6
    && support.presetId === placement.preset?.id
    && support.reportsSupportTop === (placement.reportsSupportTop !== false)
    && support.reuseGroup === placement.reuseGroup;
}

function createSupportRecord(
  entity: Entity,
  placement: SupportPlacement,
  defaultWidth: number
): SupportRecord {
  return {
    entity,
    presetEvent: placement.preset?.event,
    presetId: placement.preset?.id,
    presetRemoveEvent: placement.preset?.removeEvent,
    reportsSupportTop: placement.reportsSupportTop !== false,
    reuseGroup: placement.reuseGroup,
    topY: placement.topY,
    width: placement.preset?.width ?? defaultWidth,
    x: placement.location.x,
    z: placement.location.z
  };
}

/** Whether a preset can be replaced and restored without respawning. */
function canReuseSupport(
  support: SupportRecord,
  placement: SupportPlacement
): boolean {
  if (support.presetId === placement.preset?.id) return true;
  const canRemoveCurrent = support.presetEvent === undefined
    || support.presetRemoveEvent !== undefined;
  const canRemoveNext = placement.preset?.event === undefined
    || placement.preset.removeEvent !== undefined;
  return canRemoveCurrent && canRemoveNext;
}

/** Replaces the active collision component group before moving the proxy. */
function setSupportPreset(
  support: SupportRecord,
  placement: SupportPlacement
): void {
  if (support.presetId === placement.preset?.id) return;
  if (support.presetRemoveEvent) {
    support.entity.triggerEvent(support.presetRemoveEvent);
  }
  if (placement.preset?.event) {
    support.entity.triggerEvent(placement.preset.event);
  }
}

/** Restores a switched component group when a later sync operation fails. */
function restoreSupportPreset(
  support: SupportRecord,
  placement: SupportPlacement
): void {
  if (support.presetId === placement.preset?.id) return;
  if (placement.preset?.removeEvent) {
    support.entity.triggerEvent(placement.preset.removeEvent);
  }
  if (support.presetEvent) support.entity.triggerEvent(support.presetEvent);
}
