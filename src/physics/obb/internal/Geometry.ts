import type { Vector3 } from "@minecraft/server";
import type { CollisionRegion } from "./Activation";
import { SLOPE_RISE_SIN } from "../Types";
import type {
  ObbSurfaceContact,
  ObbSettings,
  ObbSize,
  ObbSupportPreset,
  ObbSupportPresetCatalog,
  ObbTransform,
  SupportPlacement
} from "../Types";
import { add, dot, scale, subtract } from "@src/utils/Vector3Math";
import {
  compressedHorizontalPatchKey,
  compressedVerticalPatchKey,
  compressedWalkingTopKey,
  fineCellKey,
  parseFineCellKey,
  parseVerticalCellKey,
  topNamespaceKey,
  verticalCellKey,
  volumeSegmentKey,
  walkingSideSegmentKey
} from "./GeometryKeys";
import { getPoseObbVerticalInterval, type VolumeColumnInterval } from "./Interval";
import {
  cellIntersectsFiniteFace,
  getFiniteTopSurfaceY,
  getObbHorizontalBounds,
  getTopFaceBounds,
  getTopFaceBounds3d,
  isWithinHorizontalRegion,
  quantizeDownFromOrigin,
  quantizeNearestFromOrigin,
  quantizeUpFromOrigin
} from "./PlacementGrid";
import {
  GEOMETRY_EPSILON,
  SIGNS,
  createOrientedSolid,
  createOrientedSurface,
  getVerticalProjectionAxis,
  getWorldPoint,
  orientationsEqual,
  transformsEqual,
  type FiniteTopSurface,
  type SurfacePose,
  type VerticalProjectionAxis
} from "./PoseFrame";
import {
  EMPTY_PREPARED_SUPPORT_PRESETS,
  findMaximumCoveredHorizontalPreset,
  getPreparedSupportPresets,
  isLargerVerticalPatch
} from "./Presets";

interface WalkingShellCell {
  readonly interval: VolumeColumnInterval;
  placement?: SupportPlacement;
  readonly regions: CollisionRegion[];
  readonly xIndex: number;
  readonly zIndex: number;
}

/** First continuous contact with the designated positive local-Y face. */
export interface SupportGridOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Tangent axis indices per face axis; = [0, 1, 2].filter(i => i !== axisIndex). */
const TANGENT_INDICES = Object.freeze([
  Object.freeze([1, 2] as const),
  Object.freeze([0, 2] as const),
  Object.freeze([0, 1] as const)
] as const);
/**
 * Entity-reuse lattice discriminators stamped onto placements. SupportSurface
 * (collision.ts) only reuses a proxy entity whose reuseGroup matches, so these
 * strings gate which spawned entities may be teleported instead of respawned.
 */
const REUSE_GROUPS = Object.freeze({
  designatedTop: "designated-top",
  volume: "volume",
  walkingSide: "walking-side",
  walkingTop: "walking-top"
} as const);

/*
 * Placement map key grammar. Keys are the identity used by SupportSurface's
 * layout diff, so every builder and parser below must emit and accept exactly
 * these byte-identical forms:
 *   `${x},${z}`                     one fine horizontal cell
 *   `v:${x},${y},${z}`              one fine steep-face cell
 *   `h:${presetId}:${x},${z}`       compressed horizontal patch
 *   `v:${presetId}:${x},${y},${z}`  compressed steep-face patch
 *   `t:${key}`                      designated/walking top namespace
 *   `t:${presetId}:${cellKey}`      compressed walking-top patch
 *   `${cellKey}:${index}:${y}`      solid volume column segment
 *   `s:${cellKey}:${index}:${y}`    walking-side volume column segment
 */
/** Geometry for a complete solid OBB with one designated friction face. */
export class ObbGeometry {
  readonly #basePreset: ObbSupportPreset | undefined;
  readonly #horizontalPresets: readonly ObbSupportPreset[];
  readonly #settings: ObbSettings;
  readonly #size: ObbSize;
  readonly #surfaceHeightTolerance: number;
  readonly #supportActivationRadius: number;
  readonly #supportActivationVerticalMargin: number;
  readonly #supportHalfSize: number;
  readonly #maximumHorizontalPatchCells: number;
  readonly #maximumVolumeHeightSteps: number;
  readonly #maximumVerticalPatchCells: number;
  readonly #singleCellVolumePresetByHeightStep: ReadonlyMap<
    number,
    ObbSupportPreset
  >;
  readonly #verticalPatchPresetsByHeight: ReadonlyMap<
    number,
    readonly ObbSupportPreset[]
  >;
  #currentSurfacePose: SurfacePose | undefined;
  #previousSurfacePose: SurfacePose | undefined;

  constructor(
    size: ObbSize,
    settings: ObbSettings,
    supportPresets?: ObbSupportPresetCatalog
  ) {
    this.#size = size;
    this.#settings = settings;
    const prepared = supportPresets
      ? getPreparedSupportPresets(supportPresets, settings.heightStep)
      : EMPTY_PREPARED_SUPPORT_PRESETS;
    this.#basePreset = prepared.basePreset;
    this.#horizontalPresets = prepared.horizontalPresets;
    this.#maximumHorizontalPatchCells = prepared.maximumHorizontalPatchCells;
    this.#maximumVolumeHeightSteps = prepared.maximumVolumeHeightSteps;
    this.#maximumVerticalPatchCells = prepared.maximumVerticalPatchCells;
    this.#singleCellVolumePresetByHeightStep =
      prepared.singleCellVolumePresetByHeightStep;
    this.#verticalPatchPresetsByHeight = prepared.verticalPatchPresetsByHeight;
    this.#surfaceHeightTolerance = supportPresets?.surfaceHeightTolerance ?? 0;
    this.#supportHalfSize = settings.supportWidth / 2;
    this.#supportActivationRadius = this.#supportHalfSize
      + Math.max(settings.spacing.forward, settings.spacing.sideways);
    // One forward cell of the proven maximum slope rise bounds how far the
    // designated face can climb between adjacent activation samples.
    this.#supportActivationVerticalMargin = settings.contactRadius
      + settings.supportHeight
      + settings.spacing.forward * SLOPE_RISE_SIN;
  }

  get supportHalfSize(): number {
    return this.#supportHalfSize;
  }

  /** Horizontal radius that conservatively retains nearby valid support. */
  get supportActivationRadius(): number {
    return this.#supportActivationRadius;
  }

  /** Vertical preload range used when selecting fixed collision regions. */
  get supportActivationVerticalMargin(): number {
    return this.#supportActivationVerticalMargin;
  }

  /** Anchors collision cells to world XZ coordinates for the OBB lifetime. */
  getSupportGridOrigin(transform: ObbTransform): SupportGridOrigin {
    return {
      x: Math.round(transform.center.x / this.#settings.spacing.forward)
        * this.#settings.spacing.forward,
      y: Math.round(transform.center.y / this.#settings.supportHeight)
        * this.#settings.supportHeight,
      z: Math.round(transform.center.z / this.#settings.spacing.sideways)
        * this.#settings.spacing.sideways
    };
  }

  /** Samples an upright player capsule against the finite top face. */
  sampleSurfaceContact(
    transform: ObbTransform,
    playerLocation: Vector3,
    playerHalfWidth: number,
    playerHeight: number
  ): ObbSurfaceContact {
    if (!Number.isFinite(playerHalfWidth) || playerHalfWidth <= 0) {
      throw new RangeError("playerHalfWidth must be a finite positive number.");
    }
    if (!Number.isFinite(playerHeight) || playerHeight <= 0) {
      throw new RangeError("playerHeight must be a finite positive number.");
    }
    const surface = this.#getSurfacePose(transform).surface;
    const { frame, topCenter } = surface;
    const halfHeight = playerHeight / 2;
    const segmentHalfLength = Math.max(0, halfHeight - playerHalfWidth);
    const playerCenter = {
      x: playerLocation.x,
      y: playerLocation.y + halfHeight,
      z: playerLocation.z
    };
    const relative = subtract(playerCenter, topCenter);
    const localForward = dot(relative, frame.forward);
    const localSideways = dot(relative, frame.sideways);
    const normalRadius = getCapsuleProjectionRadius(
      frame.normal,
      playerHalfWidth,
      segmentHalfLength
    );
    const forwardRadius = getCapsuleProjectionRadius(
      frame.forward,
      playerHalfWidth,
      segmentHalfLength
    );
    return {
      distance: dot(relative, frame.normal) - normalRadius,
      localForward,
      localPoint: {
        x: localSideways,
        y: this.#size.height / 2,
        z: localForward
      },
      localSideways,
      normal: { ...frame.normal },
      // Reuse the frame and top center already calculated for this contact.
      // A top sweep calls this method repeatedly, so recomputing both here
      // would duplicate all three-axis trigonometry for every binary sample.
      surfacePoint: {
        x: topCenter.x
          + frame.forward.x * localForward
          + frame.sideways.x * localSideways,
        y: topCenter.y
          + frame.forward.y * localForward
          + frame.sideways.y * localSideways,
        z: topCenter.z
          + frame.forward.z * localForward
          + frame.sideways.z * localSideways
      },
      withinSurface:
        Math.abs(localForward) <= this.#size.depth / 2 + forwardRadius
        && Math.abs(localSideways) <= this.#size.width / 2 + playerHalfWidth
    };
  }

  /** Returns the nearest upward-facing OBB face touching an upright capsule. */
  sampleStandableSurfaceContact(
    transform: ObbTransform,
    playerLocation: Vector3,
    playerHalfWidth: number,
    playerHeight: number
  ): ObbSurfaceContact | undefined {
    if (!Number.isFinite(playerHalfWidth) || playerHalfWidth <= 0) {
      throw new RangeError("playerHalfWidth must be a finite positive number.");
    }
    if (!Number.isFinite(playerHeight) || playerHeight <= 0) {
      throw new RangeError("playerHeight must be a finite positive number.");
    }
    const pose = this.#getSurfacePose(transform);
    const axes = pose.solid.axes;
    const playerCenter = {
      x: playerLocation.x,
      y: playerLocation.y + playerHeight / 2,
      z: playerLocation.z
    };
    const segmentHalfLength = Math.max(
      0,
      playerHeight / 2 - playerHalfWidth
    );
    let nearest: ObbSurfaceContact | undefined;
    for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
      const faceAxis = axes[axisIndex]!;
      for (const sign of SIGNS) {
        const normal = scale(faceAxis.axis, sign);
        if (normal.y <= GEOMETRY_EPSILON) continue;
        const faceCenter = add(
          pose.solid.center,
          scale(faceAxis.axis, faceAxis.extent * sign)
        );
        const relative = subtract(playerCenter, faceCenter);
        const normalRadius = getCapsuleProjectionRadius(
          normal,
          playerHalfWidth,
          segmentHalfLength
        );
        const distance = dot(relative, normal) - normalRadius;
        const tangentIndices = TANGENT_INDICES[axisIndex]!;
        const first = axes[tangentIndices[0]!]!;
        const second = axes[tangentIndices[1]!]!;
        const firstCoordinate = dot(relative, first.axis);
        const secondCoordinate = dot(relative, second.axis);
        const withinSurface = Math.abs(firstCoordinate)
            <= first.extent + getCapsuleProjectionRadius(
              first.axis,
              playerHalfWidth,
              segmentHalfLength
            )
          && Math.abs(secondCoordinate)
            <= second.extent + getCapsuleProjectionRadius(
              second.axis,
              playerHalfWidth,
              segmentHalfLength
            );
        if (!withinSurface
          || (nearest && Math.abs(nearest.distance) <= Math.abs(distance))) {
          continue;
        }
        const coordinates = [0, 0, 0];
        coordinates[axisIndex] = faceAxis.extent * sign;
        coordinates[tangentIndices[0]!] = firstCoordinate;
        coordinates[tangentIndices[1]!] = secondCoordinate;
        // Oriented-solid axes are local Z, X, Y in that order.
        const localPoint = {
          x: coordinates[1]!,
          y: coordinates[2]!,
          z: coordinates[0]!
        };
        nearest = {
          distance,
          localForward: localPoint.z,
          localPoint,
          localSideways: localPoint.x,
          normal,
          surfacePoint: add(faceCenter, add(
            scale(first.axis, firstCoordinate),
            scale(second.axis, secondCoordinate)
          )),
          withinSurface: true
        };
      }
    }
    return nearest;
  }

  /** Velocity of one local surface point between two game ticks. */
  getSurfaceVelocity(
    previousTransform: ObbTransform,
    transform: ObbTransform,
    localForward: number,
    localSideways: number
  ): Vector3 {
    return subtract(
      this.getSurfacePoint(transform, localForward, localSideways),
      this.getSurfacePoint(previousTransform, localForward, localSideways)
    );
  }

  /** Velocity of an arbitrary rigid-body local point between two ticks. */
  getPointVelocity(
    previousTransform: ObbTransform,
    transform: ObbTransform,
    localPoint: Vector3
  ): Vector3 {
    return subtract(
      getWorldPoint(transform, localPoint),
      getWorldPoint(previousTransform, localPoint)
    );
  }

  /** Height of the exact top plane at one horizontal world position. */
  getSurfaceY(
    transform: ObbTransform,
    position: Readonly<{ x: number; z: number }>
  ): number {
    const surface = this.#getSurfacePose(transform).finiteTop;
    if (!surface) {
      throw new RangeError(
        "Surface height is undefined when the OBB top face is not upward-facing."
      );
    }
    const relativeX = position.x - surface.topCenter.x;
    const relativeZ = position.z - surface.topCenter.z;
    return surface.topCenter.y - (
      surface.frame.normal.x * relativeX
      + surface.frame.normal.z * relativeZ
    ) / surface.frame.normal.y;
  }

  /** Returns one point on the top face from local surface coordinates. */
  getSurfacePoint(
    transform: ObbTransform,
    localForward: number,
    localSideways: number
  ): Vector3 {
    const { frame, topCenter } = this.#getSurfacePose(transform).surface;
    return {
      x: topCenter.x
        + frame.forward.x * localForward
        + frame.sideways.x * localSideways,
      y: topCenter.y
        + frame.forward.y * localForward
        + frame.sideways.y * localSideways,
      z: topCenter.z
        + frame.forward.z * localForward
        + frame.sideways.z * localSideways
    };
  }

  /** Builds every fixed-world grid cell covering the designated face. */
  createSupportPlacements(
    transform: ObbTransform,
    origin = this.getSupportGridOrigin(transform)
  ): Map<string, SupportPlacement> {
    const pose = this.#getSurfacePose(transform);
    const verticalAxis = pose.verticalAxis;
    if (verticalAxis) {
      return this.#createVerticalSupportPlacements(
        transform,
        origin,
        verticalAxis
      );
    }
    const surface = pose.finiteTop;
    if (!surface) return new Map<string, SupportPlacement>();
    const bounds = getTopFaceBounds(surface, this.#size);
    const placements = this.#createGridPlacements(
      surface,
      origin,
      Math.floor((bounds.minimumX - origin.x) / this.#settings.spacing.forward),
      Math.ceil((bounds.maximumX - origin.x) / this.#settings.spacing.forward),
      Math.floor((bounds.minimumZ - origin.z) / this.#settings.spacing.sideways),
      Math.ceil((bounds.maximumZ - origin.z) / this.#settings.spacing.sideways)
    );
    return this.#compressHorizontalPlacements(placements, surface, origin);
  }

  /** Builds only the fixed-world cells needed around active actor AABBs. */
  createNearbySupportPlacements(
    transform: ObbTransform,
    origin: SupportGridOrigin,
    regions: readonly CollisionRegion[]
  ): Map<string, SupportPlacement> {
    const pose = this.#getSurfacePose(transform);
    const verticalAxis = pose.verticalAxis;
    if (verticalAxis) {
      return this.#createNearbyVerticalSupportPlacements(
        transform,
        origin,
        regions,
        verticalAxis
      );
    }
    const placements = new Map<string, SupportPlacement>();
    const surface = pose.finiteTop;
    if (!surface) return placements;
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    for (const region of regions) {
      const lower = region.location.y - region.extent.y;
      const upper = region.location.y + region.extent.y;
      const minimumX = Math.floor((
        region.location.x - region.extent.x - origin.x
      )
        / forwardSpacing);
      const maximumX = Math.ceil((
        region.location.x + region.extent.x - origin.x
      )
        / forwardSpacing);
      const minimumZ = Math.floor((
        region.location.z - region.extent.z - origin.z
      )
        / sidewaysSpacing);
      const maximumZ = Math.ceil((
        region.location.z + region.extent.z - origin.z
      )
        / sidewaysSpacing);
      for (let xIndex = minimumX; xIndex <= maximumX; xIndex += 1) {
        const x = origin.x + xIndex * forwardSpacing;
        for (let zIndex = minimumZ; zIndex <= maximumZ; zIndex += 1) {
          const z = origin.z + zIndex * sidewaysSpacing;
          const key = fineCellKey(xIndex, zIndex);
          if (placements.has(key)) continue;
          if (!isWithinHorizontalRegion(x, z, region)) continue;
          const placement = this.#createPlacement(surface, x, z);
          if (!placement) continue;
          if (placement.topY < lower
            || placement.topY - this.#settings.supportHeight > upper) continue;
          placements.set(key, placement);
        }
      }
    }
    return this.#compressHorizontalPlacements(placements, surface, origin);
  }

  /** Combines the proven shallow top lattice with the remaining solid volume. */
  createNearbyCollisionPlacements(
    transform: ObbTransform,
    origin: SupportGridOrigin,
    regions: readonly CollisionRegion[]
  ): Map<string, SupportPlacement> {
    const finePlacements = new Map<string, SupportPlacement>();
    if (regions.length === 0) return finePlacements;
    const pose = this.#getSurfacePose(transform);
    pose.intervalCache.clear();
    const frame = pose.surface.frame;
    const designatedSurface = pose.finiteTop;
    if (this.#maximumVolumeHeightSteps < 1) {
      throw new Error("Complete OBB collision requires exact-height presets.");
    }
    const bounds = getObbHorizontalBounds(transform, this.#size, frame);
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    for (const region of regions) {
      const {
        activeBottom,
        activeTop,
        maximumX,
        maximumZ,
        minimumX,
        minimumZ
      } = this.#getRegionCellBounds(region, bounds, origin);
      for (let xIndex = minimumX; xIndex <= maximumX; xIndex += 1) {
        const x = origin.x + xIndex * forwardSpacing;
        for (let zIndex = minimumZ; zIndex <= maximumZ; zIndex += 1) {
          const z = origin.z + zIndex * sidewaysSpacing;
          if (!isWithinHorizontalRegion(x, z, region)) continue;
          const interval = getPoseObbVerticalInterval(
            pose,
            x,
            z,
            this.#supportHalfSize
          );
          if (!interval) continue;
          const bottomY = Math.max(
            quantizeNearestFromOrigin(
              interval.bottomY,
              origin.y,
              this.#settings.heightStep
            ),
            activeBottom
          );
          let topY = Math.min(
            quantizeNearestFromOrigin(
              interval.topY,
              origin.y,
              this.#settings.heightStep
            ),
            activeTop
          );
          // The first-generation shallow top proxy owns all walkable contact.
          // Stop the volume exactly at its underside so tall column walls can
          // never catch a rider or alter the proven slope stepping behavior.
          const topPlacement = designatedSurface
            ? this.#createPlacement(designatedSurface, x, z)
            : undefined;
          if (topPlacement) topY = Math.min(topY, topPlacement.location.y);
          if (topY <= bottomY + GEOMETRY_EPSILON) continue;
          const segments = this.#createVolumeColumnSegments(
            bottomY,
            topY
          );
          for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index]!;
            const key = volumeSegmentKey(
              fineCellKey(xIndex, zIndex),
              index,
              segment.location.y
            );
            if (finePlacements.has(key)) continue;
            finePlacements.set(key, {
              ...segment,
              location: { x, y: segment.location.y, z },
              reuseGroup: REUSE_GROUPS.volume
            });
          }
        }
      }
    }
    const placements = finePlacements;
    this.#appendDesignatedTopPlacements(
      placements,
      transform,
      origin,
      regions
    );
    return placements;
  }

  /** Builds only the world-up envelope and actor-facing perimeter walls. */
  createNearbyWalkingShellPlacements(
    transform: ObbTransform,
    origin: SupportGridOrigin,
    regions: readonly CollisionRegion[]
  ): Map<string, SupportPlacement> {
    const cells = new Map<string, WalkingShellCell>();
    if (regions.length === 0) return new Map<string, SupportPlacement>();
    if (!this.#basePreset || this.#maximumVolumeHeightSteps < 1) {
      throw new Error("Walking OBB collision requires complete support presets.");
    }
    const pose = this.#getSurfacePose(transform);
    pose.intervalCache.clear();
    const bounds = getObbHorizontalBounds(transform, this.#size, pose.surface.frame);
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    for (const region of regions) {
      const {
        activeBottom,
        activeTop,
        maximumX,
        maximumZ,
        minimumX,
        minimumZ
      } = this.#getRegionCellBounds(region, bounds, origin);
      for (let xIndex = minimumX; xIndex <= maximumX; xIndex += 1) {
        const x = origin.x + xIndex * forwardSpacing;
        for (let zIndex = minimumZ; zIndex <= maximumZ; zIndex += 1) {
          const z = origin.z + zIndex * sidewaysSpacing;
          const key = fineCellKey(xIndex, zIndex);
          if (!isWithinHorizontalRegion(x, z, region)) continue;
          const existing = cells.get(key);
          const interval = existing?.interval ?? getPoseObbVerticalInterval(
              pose,
              x,
              z,
              this.#supportHalfSize
            );
          if (!interval) continue;
          const topY = quantizeNearestFromOrigin(
            interval.topY,
            origin.y,
            this.#settings.heightStep
          );
          const bottomY = quantizeNearestFromOrigin(
            interval.bottomY,
            origin.y,
            this.#settings.heightStep
          );
          if (topY < activeBottom - GEOMETRY_EPSILON
            || bottomY > activeTop + GEOMETRY_EPSILON) continue;
          const topIntersectsRegion = topY >= activeBottom - GEOMETRY_EPSILON
            && topY - this.#settings.supportHeight
              <= activeTop + GEOMETRY_EPSILON;
          // The existing-cell and new-cell branches attach the same placement.
          const placement = topIntersectsRegion ? {
            location: {
              x,
              y: topY - this.#settings.supportHeight,
              z
            },
            preset: this.#basePreset,
            reuseGroup: REUSE_GROUPS.walkingTop,
            topY
          } : undefined;
          if (existing) {
            existing.regions.push(region);
            if (!existing.placement && placement) {
              existing.placement = placement;
            }
            continue;
          }
          cells.set(key, {
            interval,
            placement,
            regions: [region],
            xIndex,
            zIndex
          });
        }
      }
    }

    const placements = this.#compressWalkingTopPlacements(cells, origin);
    this.#appendWalkingSidePlacements(
      placements,
      cells,
      pose,
      transform,
      origin
    );
    return placements;
  }

  /** Clips one activation region to the OBB footprint on the fine cell grid. */
  #getRegionCellBounds(
    region: CollisionRegion,
    bounds: Readonly<{
      maximumX: number;
      maximumZ: number;
      minimumX: number;
      minimumZ: number;
    }>,
    origin: SupportGridOrigin
  ): Readonly<{
    activeBottom: number;
    activeTop: number;
    maximumX: number;
    maximumZ: number;
    minimumX: number;
    minimumZ: number;
  }> {
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    return {
      activeBottom: quantizeDownFromOrigin(
        region.location.y - region.extent.y,
        origin.y,
        this.#settings.heightStep
      ),
      activeTop: quantizeUpFromOrigin(
        region.location.y + region.extent.y,
        origin.y,
        this.#settings.heightStep
      ),
      maximumX: Math.ceil((Math.min(
        bounds.maximumX + this.#supportHalfSize,
        region.location.x + region.extent.x
      ) - origin.x) / forwardSpacing),
      maximumZ: Math.ceil((Math.min(
        bounds.maximumZ + this.#supportHalfSize,
        region.location.z + region.extent.z
      ) - origin.z) / sidewaysSpacing),
      minimumX: Math.floor((Math.max(
        bounds.minimumX - this.#supportHalfSize,
        region.location.x - region.extent.x
      ) - origin.x) / forwardSpacing),
      minimumZ: Math.floor((Math.max(
        bounds.minimumZ - this.#supportHalfSize,
        region.location.z - region.extent.z
      ) - origin.z) / sidewaysSpacing)
    };
  }

  /** Adds a solid-height strip only along each actor's approaching silhouette. */
  #appendWalkingSidePlacements(
    placements: Map<string, SupportPlacement>,
    cells: ReadonlyMap<string, WalkingShellCell>,
    pose: SurfacePose,
    transform: ObbTransform,
    origin: SupportGridOrigin
  ): void {
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    for (const [cellKey, cell] of cells) {
      let bottomY = Number.POSITIVE_INFINITY;
      let topY = Number.NEGATIVE_INFINITY;
      for (const region of cell.regions) {
        const deltaX = region.location.x - transform.center.x;
        const deltaZ = region.location.z - transform.center.z;
        if (Math.abs(deltaX) <= GEOMETRY_EPSILON
          && Math.abs(deltaZ) <= GEOMETRY_EPSILON) continue;
        const outwardSteps: ReadonlyArray<readonly [number, number]> = [
          ...(Math.abs(deltaX) > GEOMETRY_EPSILON
            ? [[Math.sign(deltaX), 0] as const]
            : []),
          ...(Math.abs(deltaZ) > GEOMETRY_EPSILON
            ? [[0, Math.sign(deltaZ)] as const]
            : [])
        ];
        const exposesApproachSide = outwardSteps.some(([xStep, zStep]) => (
          !getPoseObbVerticalInterval(
            pose,
            origin.x + (cell.xIndex + xStep) * forwardSpacing,
            origin.z + (cell.zIndex + zStep) * sidewaysSpacing,
            this.#supportHalfSize
          )
        ));
        if (!exposesApproachSide) continue;
        bottomY = Math.min(bottomY, Math.max(
          quantizeNearestFromOrigin(
            cell.interval.bottomY,
            origin.y,
            this.#settings.heightStep
          ),
          quantizeDownFromOrigin(
            region.location.y - region.extent.y,
            origin.y,
            this.#settings.heightStep
          )
        ));
        topY = Math.max(topY, Math.min(
          cell.placement?.location.y ?? quantizeNearestFromOrigin(
            cell.interval.topY,
            origin.y,
            this.#settings.heightStep
          ),
          quantizeUpFromOrigin(
            region.location.y + region.extent.y,
            origin.y,
            this.#settings.heightStep
          )
        ));
      }
      if (topY <= bottomY + GEOMETRY_EPSILON) continue;
      const segments = this.#createVolumeColumnSegments(bottomY, topY);
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        placements.set(walkingSideSegmentKey(cellKey, index, segment.location.y), {
          ...segment,
          location: {
            x: origin.x + cell.xIndex * forwardSpacing,
            y: segment.location.y,
            z: origin.z + cell.zIndex * sidewaysSpacing
          },
          reuseGroup: REUSE_GROUPS.walkingSide
        });
      }
    }
  }

  /** Compresses a non-planar world-up height field without bridging holes. */
  #compressWalkingTopPlacements(
    cells: ReadonlyMap<string, WalkingShellCell>,
    origin: SupportGridOrigin
  ): Map<string, SupportPlacement> {
    if (this.#horizontalPresets.length === 0 || cells.size === 0) {
      const placements = new Map<string, SupportPlacement>();
      for (const [key, cell] of cells) {
        if (cell.placement) placements.set(topNamespaceKey(key), cell.placement);
      }
      return placements;
    }
    const uncovered = new Set(cells.keys());
    const compressed = new Map<string, SupportPlacement>();
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    for (const [cellKey, seed] of cells) {
      if (!seed.placement || !uncovered.has(cellKey)) {
        uncovered.delete(cellKey);
        continue;
      }
      let selectedPreset: ObbSupportPreset | undefined;
      let selectedMaximumTop = Number.NEGATIVE_INFINITY;
      for (const preset of this.#horizontalPresets) {
        let minimumTop = Number.POSITIVE_INFINITY;
        let maximumTop = Number.NEGATIVE_INFINITY;
        let complete = true;
        for (let xOffset = 0; xOffset < preset.horizontalCells && complete; xOffset += 1) {
          for (let zOffset = 0; zOffset < preset.horizontalCells; zOffset += 1) {
            const candidateKey = fineCellKey(seed.xIndex + xOffset, seed.zIndex + zOffset);
            const candidate = cells.get(candidateKey);
            if (!candidate?.placement || !uncovered.has(candidateKey)) {
              complete = false;
              break;
            }
            minimumTop = Math.min(minimumTop, candidate.placement.topY);
            maximumTop = Math.max(maximumTop, candidate.placement.topY);
          }
        }
        if (!complete || maximumTop - minimumTop
          > this.#surfaceHeightTolerance + GEOMETRY_EPSILON) continue;
        selectedPreset = preset;
        selectedMaximumTop = maximumTop;
        break;
      }
      if (!selectedPreset) {
        throw new Error(`Support preset catalog did not cover walking shell cell ${cellKey}.`);
      }
      for (let xOffset = 0; xOffset < selectedPreset.horizontalCells; xOffset += 1) {
        for (let zOffset = 0; zOffset < selectedPreset.horizontalCells; zOffset += 1) {
          uncovered.delete(fineCellKey(seed.xIndex + xOffset, seed.zIndex + zOffset));
        }
      }
      const cellCount = selectedPreset.horizontalCells;
      compressed.set(compressedWalkingTopKey(selectedPreset.id, cellKey), {
        location: {
          x: origin.x + (seed.xIndex + (cellCount - 1) / 2) * forwardSpacing,
          y: selectedMaximumTop - selectedPreset.height,
          z: origin.z + (seed.zIndex + (cellCount - 1) / 2) * sidewaysSpacing
        },
        preset: selectedPreset,
        reuseGroup: REUSE_GROUPS.walkingTop,
        topY: selectedMaximumTop
      });
    }
    if (uncovered.size > 0) {
      throw new Error("Support preset catalog did not cover every walking shell cell.");
    }
    return compressed;
  }

  /** Adds the stable shallow lattice under a collision-specific key space. */
  #appendDesignatedTopPlacements(
    placements: Map<string, SupportPlacement>,
    transform: ObbTransform,
    origin: SupportGridOrigin,
    regions: readonly CollisionRegion[]
  ): void {
    const topPlacements = this.createNearbySupportPlacements(
      transform,
      origin,
      regions
    );
    for (const [key, placement] of topPlacements) {
      placements.set(topNamespaceKey(key), {
        ...placement,
        reuseGroup: REUSE_GROUPS.designatedTop
      });
    }
  }

  /** Covers one quantized vertical interval with exact-height presets. */
  #createVolumeColumnSegments(
    bottomY: number,
    topY: number
  ): SupportPlacement[] {
    const segments: SupportPlacement[] = [];
    let cursor = topY;
    while (cursor - bottomY > GEOMETRY_EPSILON) {
      // Round outward at the non-walkable bottom boundary. The top boundary is
      // exact, so this can extend by less than one height step but can never
      // leave a collision gap inside the requested OBB volume.
      const remainingSteps = Math.max(1, Math.ceil(
        (cursor - bottomY - GEOMETRY_EPSILON) / this.#settings.heightStep
      ));
      const heightSteps = Math.min(
        this.#maximumVolumeHeightSteps,
        remainingSteps
      );
      const preset =
        this.#singleCellVolumePresetByHeightStep.get(heightSteps);
      if (!preset) {
        throw new Error(
          `Support preset catalog did not cover volume height ${heightSteps}.`
        );
      }
      const locationY = cursor - preset.height;
      segments.push({
        location: { x: 0, y: locationY, z: 0 },
        preset,
        reportsSupportTop: false,
        reuseGroup: REUSE_GROUPS.volume,
        topY: cursor
      });
      cursor = locationY;
    }
    return segments;
  }

  /** Rasterizes a steep face on its dominant world-horizontal normal axis. */
  #createVerticalSupportPlacements(
    transform: ObbTransform,
    origin: SupportGridOrigin,
    axis: VerticalProjectionAxis
  ): Map<string, SupportPlacement> {
    const placements = new Map<string, SupportPlacement>();
    const surface = this.#getSurfacePose(transform).surface;
    const bounds = getTopFaceBounds3d(surface, this.#size);
    const minimumY = Math.floor((bounds.minimumY - origin.y)
      / this.#settings.supportHeight);
    const maximumY = Math.ceil((bounds.maximumY - origin.y)
      / this.#settings.supportHeight);
    if (axis === "x") {
      const minimumZ = Math.floor((bounds.minimumZ - origin.z)
        / this.#settings.spacing.sideways);
      const maximumZ = Math.ceil((bounds.maximumZ - origin.z)
        / this.#settings.spacing.sideways);
      for (let yIndex = minimumY; yIndex <= maximumY; yIndex += 1) {
        const y = origin.y + yIndex * this.#settings.supportHeight;
        for (let zIndex = minimumZ; zIndex <= maximumZ; zIndex += 1) {
          const z = origin.z + zIndex * this.#settings.spacing.sideways;
          const entry = this.#createVerticalPlacementAt(
            surface,
            origin,
            axis,
            { x: surface.topCenter.x, y, z }
          );
          if (entry) placements.set(entry[0], entry[1]);
        }
      }
    } else {
      const minimumX = Math.floor((bounds.minimumX - origin.x)
        / this.#settings.spacing.forward);
      const maximumX = Math.ceil((bounds.maximumX - origin.x)
        / this.#settings.spacing.forward);
      for (let yIndex = minimumY; yIndex <= maximumY; yIndex += 1) {
        const y = origin.y + yIndex * this.#settings.supportHeight;
        for (let xIndex = minimumX; xIndex <= maximumX; xIndex += 1) {
          const x = origin.x + xIndex * this.#settings.spacing.forward;
          const entry = this.#createVerticalPlacementAt(
            surface,
            origin,
            axis,
            { x, y, z: surface.topCenter.z }
          );
          if (entry) placements.set(entry[0], entry[1]);
        }
      }
    }
    return this.#compressVerticalPlacements(
      placements,
      surface.frame.normal,
      this.#size.height,
      axis
    );
  }

  /** Builds only steep-face cells whose fixed lattice boxes are near actors. */
  #createNearbyVerticalSupportPlacements(
    transform: ObbTransform,
    origin: SupportGridOrigin,
    regions: readonly CollisionRegion[],
    axis: VerticalProjectionAxis
  ): Map<string, SupportPlacement> {
    const placements = new Map<string, SupportPlacement>();
    const surface = this.#getSurfacePose(transform).surface;
    const bounds = getTopFaceBounds3d(surface, this.#size);
    for (const region of regions) {
      const minimumY = Math.floor((Math.max(
        bounds.minimumY - this.#settings.supportHeight / 2,
        region.location.y - region.extent.y
      ) - origin.y) / this.#settings.supportHeight);
      const maximumY = Math.ceil((Math.min(
        bounds.maximumY + this.#settings.supportHeight / 2,
        region.location.y + region.extent.y
      ) - origin.y) / this.#settings.supportHeight);
      if (axis === "x") {
        const minimumZ = Math.floor((Math.max(
          bounds.minimumZ - this.#supportHalfSize,
          region.location.z - region.extent.z
        ) - origin.z) / this.#settings.spacing.sideways);
        const maximumZ = Math.ceil((Math.min(
          bounds.maximumZ + this.#supportHalfSize,
          region.location.z + region.extent.z
        ) - origin.z) / this.#settings.spacing.sideways);
        for (let yIndex = minimumY; yIndex <= maximumY; yIndex += 1) {
          const y = origin.y + yIndex * this.#settings.supportHeight;
          for (let zIndex = minimumZ; zIndex <= maximumZ; zIndex += 1) {
            const z = origin.z + zIndex * this.#settings.spacing.sideways;
            const entry = this.#createVerticalPlacementAt(
              surface,
              origin,
              axis,
              { x: surface.topCenter.x, y, z }
            );
            if (!entry || placements.has(entry[0])) continue;
            const location = entry[1].location;
            if (!isWithinHorizontalRegion(
              location.x,
              location.z,
              region
            )) continue;
            placements.set(entry[0], entry[1]);
          }
        }
      } else {
        const minimumX = Math.floor((Math.max(
          bounds.minimumX - this.#supportHalfSize,
          region.location.x - region.extent.x
        ) - origin.x) / this.#settings.spacing.forward);
        const maximumX = Math.ceil((Math.min(
          bounds.maximumX + this.#supportHalfSize,
          region.location.x + region.extent.x
        ) - origin.x) / this.#settings.spacing.forward);
        for (let yIndex = minimumY; yIndex <= maximumY; yIndex += 1) {
          const y = origin.y + yIndex * this.#settings.supportHeight;
          for (let xIndex = minimumX; xIndex <= maximumX; xIndex += 1) {
            const x = origin.x + xIndex * this.#settings.spacing.forward;
            const entry = this.#createVerticalPlacementAt(
              surface,
              origin,
              axis,
              { x, y, z: surface.topCenter.z }
            );
            if (!entry || placements.has(entry[0])) continue;
            const location = entry[1].location;
            if (!isWithinHorizontalRegion(
              location.x,
              location.z,
              region
            )) continue;
            placements.set(entry[0], entry[1]);
          }
        }
      }
    }
    return this.#compressVerticalPlacements(
      placements,
      surface.frame.normal,
      this.#size.height,
      axis
    );
  }

  /** Solves and quantizes the dominant coordinate of one vertical-face cell. */
  #createVerticalPlacementAt(
    surface: FiniteTopSurface,
    origin: SupportGridOrigin,
    axis: VerticalProjectionAxis,
    projectedPoint: Vector3
  ): readonly [string, SupportPlacement] | undefined {
    const normal = surface.frame.normal;
    const yIndex = Math.round((projectedPoint.y - origin.y)
      / this.#settings.supportHeight);
    const y = origin.y + yIndex * this.#settings.supportHeight;
    let xIndex: number;
    let zIndex: number;
    if (axis === "x") {
      zIndex = Math.round((projectedPoint.z - origin.z)
        / this.#settings.spacing.sideways);
      const z = origin.z + zIndex * this.#settings.spacing.sideways;
      const solvedX = surface.topCenter.x - (
        normal.y * (y - surface.topCenter.y)
        + normal.z * (z - surface.topCenter.z)
      ) / normal.x;
      xIndex = Math.round((solvedX - origin.x)
        / this.#settings.spacing.forward);
    } else {
      xIndex = Math.round((projectedPoint.x - origin.x)
        / this.#settings.spacing.forward);
      const x = origin.x + xIndex * this.#settings.spacing.forward;
      const solvedZ = surface.topCenter.z - (
        normal.x * (x - surface.topCenter.x)
        + normal.y * (y - surface.topCenter.y)
      ) / normal.z;
      zIndex = Math.round((solvedZ - origin.z)
        / this.#settings.spacing.sideways);
    }
    const center = {
      x: origin.x + xIndex * this.#settings.spacing.forward,
      y,
      z: origin.z + zIndex * this.#settings.spacing.sideways
    };
    if (!cellIntersectsFiniteFace(
      center,
      surface,
      this.#size,
      this.#supportHalfSize,
      this.#settings.supportHeight / 2
    )) return undefined;
    return [verticalCellKey(xIndex, yIndex, zIndex), {
      location: {
        x: center.x,
        y: center.y - this.#settings.supportHeight / 2,
        z: center.z
      },
      preset: this.#basePreset,
      topY: center.y + this.#settings.supportHeight / 2
    }];
  }

  #createGridPlacements(
    surface: FiniteTopSurface,
    origin: SupportGridOrigin,
    minimumX: number,
    maximumX: number,
    minimumZ: number,
    maximumZ: number
  ): Map<string, SupportPlacement> {
    const placements = new Map<string, SupportPlacement>();
    for (let xIndex = minimumX; xIndex <= maximumX; xIndex += 1) {
      const x = origin.x + xIndex * this.#settings.spacing.forward;
      for (let zIndex = minimumZ; zIndex <= maximumZ; zIndex += 1) {
        const z = origin.z + zIndex * this.#settings.spacing.sideways;
        const placement = this.#createPlacement(surface, x, z);
        if (placement) placements.set(fineCellKey(xIndex, zIndex), placement);
      }
    }
    return placements;
  }

  #createPlacement(
    surface: FiniteTopSurface,
    x: number,
    z: number
  ): SupportPlacement | undefined {
    const surfaceY = getFiniteTopSurfaceY(surface, this.#size, x, z);
    if (surfaceY === undefined) return undefined;
    const topY = this.#quantizeHeight(surfaceY);
    return {
      location: {
        x,
        y: topY - this.#settings.supportHeight,
        z
      },
      preset: this.#basePreset,
      topY
    };
  }

  /** Covers required fine cells with stable world-grid patches. */
  #compressHorizontalPlacements(
    placements: Map<string, SupportPlacement>,
    surface: FiniteTopSurface,
    origin: SupportGridOrigin
  ): Map<string, SupportPlacement> {
    if (this.#horizontalPresets.length === 0 || placements.size === 0) {
      return placements;
    }
    const required = new Map<string, Readonly<{ x: number; z: number }>>();
    for (const key of placements.keys()) {
      required.set(key, parseFineCellKey(key));
    }
    const uncovered = new Set(required.keys());
    const compressed = new Map<string, SupportPlacement>();
    const forwardSpacing = this.#settings.spacing.forward;
    const sidewaysSpacing = this.#settings.spacing.sideways;
    const maximumPresetCells = this.#horizontalPresets[0]?.horizontalCells ?? 0;

    for (const [requiredKey, seed] of required) {
      if (!uncovered.has(requiredKey)) continue;
      const boundsByCellCount = new Map<number, Readonly<{
        maximumTop: number;
        minimumTop: number;
      }> | undefined>();
      const getPatchBounds = (cellCount: number) => {
        const cached = boundsByCellCount.get(cellCount);
        if (cached !== undefined || boundsByCellCount.has(cellCount)) return cached;
        const minimumX = seed.x;
        const minimumZ = seed.z;
        const maximumX = minimumX + cellCount - 1;
        const maximumZ = minimumZ + cellCount - 1;
        // A projected OBB face is convex and its height is planar. Testing
        // four macro-cell centers therefore validates the complete patch and
        // bounds its hidden height variation without scanning every cell.
        const corners = [
          [minimumX, minimumZ],
          [minimumX, maximumZ],
          [maximumX, minimumZ],
          [maximumX, maximumZ]
        ] as const;
        let minimumTop = Number.POSITIVE_INFINITY;
        let maximumTop = Number.NEGATIVE_INFINITY;
        for (const [xIndex, zIndex] of corners) {
          const corner = this.#createPlacement(
            surface,
            origin.x + xIndex * forwardSpacing,
            origin.z + zIndex * sidewaysSpacing
          );
          if (!corner) {
            boundsByCellCount.set(cellCount, undefined);
            return undefined;
          }
          minimumTop = Math.min(minimumTop, corner.topY);
          maximumTop = Math.max(maximumTop, corner.topY);
        }
        if (maximumTop - minimumTop
          > this.#surfaceHeightTolerance + GEOMETRY_EPSILON) {
          boundsByCellCount.set(cellCount, undefined);
          return undefined;
        }
        const bounds = { maximumTop, minimumTop };
        boundsByCellCount.set(cellCount, bounds);
        return bounds;
      };

      let minimumValidCells = 1;
      let maximumCandidateCells = maximumPresetCells;
      while (minimumValidCells < maximumCandidateCells) {
        const middle = Math.ceil((minimumValidCells + maximumCandidateCells) / 2);
        if (getPatchBounds(middle)) minimumValidCells = middle;
        else maximumCandidateCells = middle - 1;
      }
      const preset = findMaximumCoveredHorizontalPreset(
        this.#horizontalPresets,
        minimumValidCells
      );
      if (!preset) {
        throw new Error(`Support preset catalog did not cover horizontal cell ${requiredKey}.`);
      }
      const cellCount = preset.horizontalCells;
      const bounds = getPatchBounds(cellCount)!;
      // Fine placements are inserted in ascending grid order. Anchoring at
      // the first uncovered cell keeps odd-sized patches deterministic.
      for (let x = seed.x; x < seed.x + cellCount; x += 1) {
        for (let z = seed.z; z < seed.z + cellCount; z += 1) {
          uncovered.delete(fineCellKey(x, z));
        }
      }
      compressed.set(compressedHorizontalPatchKey(preset.id, seed.x, seed.z), {
        location: {
          x: origin.x + (seed.x + (cellCount - 1) / 2) * forwardSpacing,
          y: bounds.maximumTop - preset.height,
          z: origin.z + (seed.z + (cellCount - 1) / 2) * sidewaysSpacing
        },
        preset,
        topY: bounds.maximumTop
      });
    }
    if (uncovered.size > 0) {
      throw new Error("Support preset catalog did not cover every horizontal fine cell.");
    }
    return compressed;
  }

  /** Covers a steep face with exact fine-cell rectangles. */
  #compressVerticalPlacements(
    placements: Map<string, SupportPlacement>,
    normal: Vector3,
    inwardThickness: number,
    axis: VerticalProjectionAxis
  ): Map<string, SupportPlacement> {
    if (this.#verticalPatchPresetsByHeight.size === 0 || placements.size === 0) {
      return placements;
    }
    const required = new Map<string, Readonly<{
      placement: SupportPlacement;
      x: number;
      y: number;
      z: number;
    }>>();
    for (const [key, placement] of placements) {
      const { x, y, z } = parseVerticalCellKey(key);
      required.set(key, { placement, x, y, z });
    }
    const uncovered = new Set(required.keys());
    const compressed = new Map<string, SupportPlacement>();
    const normalComponent = axis === "x" ? normal.x : normal.z;
    // Width expansion is entirely inward from the represented face and may
    // not pass the opposite local-Y face of the physical OBB volume.
    const inwardDepth = inwardThickness * Math.abs(normalComponent);
    const maximumHorizontalCells = Math.min(
      this.#maximumHorizontalPatchCells,
      1 + Math.floor(
        (inwardDepth + GEOMETRY_EPSILON) / this.#settings.spacing.forward
      )
    );

    for (const [requiredKey, seed] of required) {
      if (!uncovered.has(requiredKey)) continue;
      let availableHorizontalCells = maximumHorizontalCells;
      let bestPreset: ObbSupportPreset | undefined;
      for (let vertical = 0;
        vertical < this.#maximumVerticalPatchCells;
        vertical += 1) {
        let rowCells = 0;
        while (rowCells < availableHorizontalCells) {
          const x = axis === "x" ? seed.x : seed.x + rowCells;
          const z = axis === "x" ? seed.z + rowCells : seed.z;
          const key = verticalCellKey(x, seed.y + vertical, z);
          if (!uncovered.has(key)) break;
          rowCells += 1;
        }
        if (rowCells === 0) break;
        availableHorizontalCells = Math.min(availableHorizontalCells, rowCells);
        const presets = this.#verticalPatchPresetsByHeight.get(vertical + 1);
        const candidate = presets
          ? findMaximumCoveredHorizontalPreset(
            presets,
            availableHorizontalCells
          )
          : undefined;
        if (!candidate) continue;
        if (!bestPreset
          || isLargerVerticalPatch(candidate, bestPreset)) {
          bestPreset = candidate;
        }
      }
      if (!bestPreset) {
        throw new Error(`Support preset catalog did not cover vertical cell ${requiredKey}.`);
      }

      const coveredKeys: string[] = [];
      for (let vertical = 0; vertical < bestPreset.verticalCells; vertical += 1) {
        for (let horizontal = 0;
          horizontal < bestPreset.horizontalCells;
          horizontal += 1) {
          const x = axis === "x" ? seed.x : seed.x + horizontal;
          const z = axis === "x" ? seed.z + horizontal : seed.z;
          coveredKeys.push(verticalCellKey(x, seed.y + vertical, z));
        }
      }
      const last = required.get(coveredKeys[coveredKeys.length - 1]!)!;
      const extraWidth = bestPreset.width - this.#settings.supportWidth;
      const location = { ...seed.placement.location };
      if (axis === "x") {
        location.x -= Math.sign(normalComponent) * extraWidth / 2;
        location.z += (bestPreset.horizontalCells - 1)
          * this.#settings.spacing.sideways / 2;
      } else {
        location.x += (bestPreset.horizontalCells - 1)
          * this.#settings.spacing.forward / 2;
        location.z -= Math.sign(normalComponent) * extraWidth / 2;
      }
      for (const key of coveredKeys) uncovered.delete(key);
      compressed.set(compressedVerticalPatchKey(bestPreset.id, seed.x, seed.y, seed.z), {
        location,
        preset: bestPreset,
        reportsSupportTop: seed.placement.reportsSupportTop,
        reuseGroup: seed.placement.reuseGroup,
        topY: last.placement.topY
      });
    }
    return compressed;
  }

  #quantizeHeight(value: number): number {
    return Math.round(value / this.#settings.heightStep)
      * this.#settings.heightStep;
  }

  /** Reuses all three-axis trigonometry across one previous/current tick pair. */
  #getSurfacePose(transform: ObbTransform): SurfacePose {
    if (this.#currentSurfacePose
      && transformsEqual(this.#currentSurfacePose.transform, transform)) {
      return this.#currentSurfacePose;
    }
    if (this.#previousSurfacePose
      && transformsEqual(this.#previousSurfacePose.transform, transform)) {
      return this.#previousSurfacePose;
    }
    const cachedOrientation = this.#currentSurfacePose
      && orientationsEqual(this.#currentSurfacePose.transform, transform)
      ? this.#currentSurfacePose
      : this.#previousSurfacePose
        && orientationsEqual(this.#previousSurfacePose.transform, transform)
        ? this.#previousSurfacePose
        : undefined;
    const surface = createOrientedSurface(
      transform,
      this.#size,
      cachedOrientation?.surface.frame
    );
    // The XZ determinant equals the top normal's Y projection. A non-positive
    // value means the designated local top face is vertical or faces downward,
    // so it cannot be represented by upward collidable height-field proxies.
    const pose: SurfacePose = {
      finiteTop: surface.determinant > GEOMETRY_EPSILON
        ? surface
        : undefined,
      intervalCache: new Map(),
      solid: createOrientedSolid(transform, this.#size, surface.frame),
      surface,
      transform: {
        center: { ...transform.center },
        pitch: transform.pitch,
        roll: transform.roll,
        yaw: transform.yaw
      },
      verticalAxis: getVerticalProjectionAxis(surface.frame.normal)
    };
    this.#previousSurfacePose = this.#currentSurfacePose;
    this.#currentSurfacePose = pose;
    return pose;
  }
}

function getCapsuleProjectionRadius(
  axis: Vector3,
  radius: number,
  segmentHalfLength: number
): number {
  return radius + segmentHalfLength * Math.abs(axis.y);
}
