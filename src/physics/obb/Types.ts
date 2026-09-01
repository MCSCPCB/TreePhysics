import type { AABB, Dimension, Entity, Vector3 } from "@minecraft/server";

/**
 * Sine of the proven 20-degree maximum rise between adjacent collidable
 * cells. The fixed world grid uses this value directly as its spacing, so one
 * cell of horizontal travel can climb at most one such rise; geometry derives
 * its vertical activation margin from the same constant.
 */
export const SLOPE_RISE_SIN = Math.sin(20 * Math.PI / 180);

/**
 * World-space pose of an OBB.
 *
 * Rotation order is yaw around world Y, pitch around the resulting local
 * sideways axis, then roll around the resulting local forward axis. Pitch is
 * limited to -90 through 90 degrees; yaw and roll are continuous angles.
 */
export interface ObbTransform {
  readonly center: Vector3;
  readonly pitch: number;
  readonly roll: number;
  readonly yaw: number;
}

/** Unrotated OBB dimensions in blocks. */
export interface ObbSize {
  readonly depth: number;
  readonly height: number;
  readonly width: number;
}

/** Complete immutable shape and initial pose supplied by a caller. */
export interface ObbBox extends ObbTransform {
  readonly size: ObbSize;
}

/**
 * Maximum distance between neighboring collision proxies.
 *
 * Despite the names, `forward` is applied to the fixed world X axis and
 * `sideways` to the fixed world Z axis: the support grid is anchored to world
 * coordinates for the OBB lifetime and never rotates with yaw.
 */
export interface ObbCollisionSpacing {
  readonly forward: number;
  readonly sideways: number;
}

/** Finite actor friction supplied by a genuinely moving OBB surface. */
export interface ObbFrictionSettings {
  /** Measured one-tick horizontal velocity retained by a grounded actor. */
  readonly groundVelocityRetention: number;
  /** Fixed impulse magnitude used after static friction can no longer hold. */
  readonly kineticImpulse: number;
  /** Largest one-tick tangential impulse that may completely stop slipping. */
  readonly maxStaticImpulse: number;
}

/** Collision behavior shared by every supported OBB. */
export interface ObbSettings {
  /**
   * Extra broad-phase reach for actor AABBs and their one-tick travel.
   * Increase this when an integration contains unusually large or fast actors.
   */
  readonly collisionQueryMargin: number;
  /** World-space quantization step for one actor collision neighborhood. */
  readonly collisionActivationBucketSize: number;
  /** Ticks an obsolete region overlaps its replacement before removal. */
  readonly collisionRegionRetentionTicks: number;
  /** Extra distance that retains an already loaded collision region. */
  readonly collisionUnloadMargin: number;
  readonly collisionUpdateInterval: number;
  readonly contactRadius: number;
  readonly friction: ObbFrictionSettings;
  /** Maximum conservative fine XZ columns allowed for full collision residency. */
  readonly fullCollisionColumnLimit: number;
  readonly heightStep: number;
  readonly spacing: ObbCollisionSpacing;
  readonly supportHeight: number;
  readonly supportWidth: number;
}

/** One data-driven collision-box shape available to a support entity. */
export interface ObbSupportPreset {
  /** Entity event that activates this collision-box component group. */
  readonly event?: string;
  readonly height: number;
  /** Number of fine horizontal cells covered along both world X and Z. */
  readonly horizontalCells: number;
  readonly id: string;
  /** Entity event that removes this collision-box component group. */
  readonly removeEvent?: string;
  /** Number of vertically contiguous fine cells covered by the proxy. */
  readonly verticalCells: number;
  /** Exact `heightStep` count used by a solid-volume interval preset. */
  readonly volumeHeightSteps?: number;
  readonly width: number;
}

/** Finite proxy catalog used to compress fine collision samples. */
export interface ObbSupportPresetCatalog {
  readonly presets: readonly ObbSupportPreset[];
  /** Maximum top-height variation hidden inside one flat proxy. */
  readonly surfaceHeightTolerance: number;
}

/** Stable actor state that grouped OBB owners may sample once per tick. */
export interface ObbEntitySnapshot {
  readonly aabb: AABB;
  readonly entity: Entity;
  readonly velocity: Vector3;
}

/** Data required to create one solid OBB. Visuals belong to the caller. */
export interface SolidObbOptions {
  readonly box: ObbBox;
  readonly dimension: Dimension;
  /** Optional shared candidates used during the initial collision build. */
  readonly entityCandidates?: readonly Entity[];
  /** Pre-sampled initial candidates; mutually exclusive with entityCandidates. */
  readonly entitySnapshots?: readonly ObbEntitySnapshot[];
  readonly settings?: Partial<ObbSettings>;
  readonly supportEntityTypeId: string;
  readonly supportPresets?: ObbSupportPresetCatalog;
}

/** Optional controls for one OBB pose update. */
export interface ObbUpdateOptions {
  /** Selects the complete solid layout or the walking-priority outer shell. */
  readonly collisionShell?: ObbCollisionShell;
  /** Optional per-actor AABBs used only to activate native collision regions. */
  readonly collisionActivationAabbs?: ReadonlyMap<string, AABB>;
  /**
   * Shared broad-phase candidates supplied by a grouped OBB owner.
   * SolidObb still performs its exact per-box range and AABB filtering.
   */
  readonly entityCandidates?: readonly Entity[];
  /**
   * Pre-sampled broad-phase candidates shared by grouped OBBs. SolidObb still
   * validates and filters every AABB against its exact swept query volume.
   */
  readonly entitySnapshots?: readonly ObbEntitySnapshot[];
  /** Disables finite tangential friction without changing native collision. */
  readonly friction?: boolean;
  /**
   * Limits friction ownership without reducing collision-proxy coverage.
   * Grouped OBB callers use this to ensure one entity has one solver per tick.
   */
  readonly frictionEntityIds?: ReadonlySet<string>;
  /** Reuses contacts sampled by a grouped OBB owner for the same tick. */
  readonly frictionContacts?: ReadonlyMap<string, ObbSurfaceContact>;
  /** Synchronizes the final collision layout during this update. */
  readonly syncCollision?: boolean;
}

/** Work performed by one collision-layout update. */
export interface ObbCollisionUpdate {
  readonly addedEntityIds: readonly string[];
  readonly changed: boolean;
  readonly removed: number;
  readonly removedEntityIds: readonly string[];
  readonly spawned: number;
}

/** Shared no-op result for updates that leave the proxy layout untouched. */
export const EMPTY_COLLISION_UPDATE: ObbCollisionUpdate = Object.freeze({
  addedEntityIds: Object.freeze([]),
  changed: false,
  removed: 0,
  removedEntityIds: Object.freeze([]),
  spawned: 0
});

/** Native proxy layout used for actor collision around one OBB. */
export type ObbCollisionShell = "solid" | "walking";

/** Result of moving or rotating one OBB. */
export interface ObbUpdateResult {
  readonly collision: ObbCollisionUpdate;
  /** Sum of finite tangential friction impulse magnitudes this tick. */
  readonly frictionImpulse: number;
  /** Entities that received a finite tangential friction impulse this tick. */
  readonly frictionEntities: number;
  readonly transformChanged: boolean;
  readonly velocity: Vector3;
}

/** Upright actor contact against the finite designated face. */
export interface ObbSurfaceContact {
  readonly distance: number;
  readonly localForward: number;
  /** Exact rigid-body local point used by multi-face friction contacts. */
  readonly localPoint?: Vector3;
  readonly localSideways: number;
  readonly normal: Vector3;
  readonly surfacePoint: Vector3;
  readonly withinSurface: boolean;
}

export const DEFAULT_OBB_SETTINGS: ObbSettings = Object.freeze({
  collisionActivationBucketSize: SLOPE_RISE_SIN / 2,
  collisionQueryMargin: 4,
  collisionRegionRetentionTicks: 0,
  collisionUnloadMargin: 0.5,
  collisionUpdateInterval: 1,
  contactRadius: 0.3,
  friction: Object.freeze({
    groundVelocityRetention: 0.546,
    kineticImpulse: 0.08,
    maxStaticImpulse: 0.2
  }),
  fullCollisionColumnLimit: 64,
  heightStep: 0.04,
  // The fixed world grid keeps the proven 20-degree rise between adjacent
  // collidable cells while keeping each active neighborhood compact.
  spacing: Object.freeze({
    forward: SLOPE_RISE_SIN,
    sideways: SLOPE_RISE_SIN
  }),
  supportHeight: 0.25,
  supportWidth: 0.33
});

/** @internal One persistent proxy placement. */
export interface SupportPlacement {
  readonly location: Vector3;
  readonly preset?: ObbSupportPreset;
  /** False for volume segments that must not answer designated-top queries. */
  readonly reportsSupportTop?: boolean;
  /** Limits entity reuse to one compatible immutable proxy lattice. */
  readonly reuseGroup?: string;
  readonly topY: number;
}
