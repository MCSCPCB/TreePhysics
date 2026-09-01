// World-block classification for the cannon kernel: fluid detection and fluid
// surfaces, world collision-shape resolution, block material ids, contact
// normalization, and the sensor predicate. Extracted from cannon-kernel.ts.
import type { Block, Dimension, Vector3 } from "@minecraft/server";
import type { PhysicsBlockCollisionBox, PhysicsBlockProperties } from "@src/physics/core/Types";
import {
  getVanillaCollisionResolutionPlan,
  resolveBlockCollisionShape,
  type BlockCollisionBoxShapeDefinition
} from "@src/physics/collision/BlockShapeResolver";
import { safeGetBlock } from "@src/utils/WorldBlock";

export const DEFAULT_SOLID_BLOCK_FRICTION = 1;
export const DEFAULT_SOLID_BLOCK_RESTITUTION = 0;

export type ResolvedWorldBlockCollisionShape =
  | "full"
  | "none"
  | readonly PhysicsBlockCollisionBox[];

const STATIC_VANILLA_WORLD_COLLISION_SHAPES = new Map<
  string,
  ResolvedWorldBlockCollisionShape
>();

export interface WorldBlockLike {
  readonly isAir: boolean;
  readonly isLiquid?: boolean;
  readonly isWaterlogged?: boolean;
  readonly permutation?: {
    getAllStates(): Record<string, boolean | number | string>;
  };
  readonly typeId?: string;
}

export interface FluidSurface {
  readonly nativeFlowing: boolean;
  readonly surfaceY: number;
  readonly typeId: string;
}

// This physics-side literal intentionally mirrors the gameplay interaction-target module;
// the two bundles cannot share a stateful module across their runtime boundary.
const INTERACTION_TARGET_BLOCK_TYPE_ID = "treephysics:interaction_target";
const INTERACTION_TARGET_WATER_DEPTH_STATE = "treephysics:water_depth";
const INTERACTION_TARGET_WATER_KIND_STATE = "treephysics:water_kind";

export function isPhysicsFluidBlock(block: WorldBlockLike): boolean {
  return block.isLiquid === true || isWaterloggedInteractionTarget(block);
}

function isWaterloggedInteractionTarget(block: WorldBlockLike): boolean {
  return block.typeId === INTERACTION_TARGET_BLOCK_TYPE_ID
    && block.isWaterlogged === true;
}

export function createFluidSurface(block: WorldBlockLike, blockY: number): FluidSurface {
  const targetWater = getInteractionTargetWaterState(block);
  const typeId = targetWater?.typeId ?? block.typeId ?? "";
  const depth = targetWater?.depth ?? getVanillaFluidDepth(block, typeId);
  return {
    nativeFlowing: typeId === "minecraft:bubble_column"
      || typeId === "minecraft:flowing_water"
      || typeId === "minecraft:flowing_lava"
      || depth !== undefined && depth !== 0,
    surfaceY: depth === undefined || depth <= 0 || depth >= 8
      ? blockY + 1
      : blockY + Math.max(0.125, 1 - depth / 8),
    typeId
  };
}

/** Restore the exact vanilla water semantics stored by the temporary interaction target. */
function getInteractionTargetWaterState(
  block: WorldBlockLike
): { readonly depth: number; readonly typeId: "minecraft:flowing_water" | "minecraft:water" } | undefined {
  if (!isWaterloggedInteractionTarget(block)) return undefined;
  const states = block.permutation?.getAllStates();
  const kind = states?.[INTERACTION_TARGET_WATER_KIND_STATE];
  const depth = states?.[INTERACTION_TARGET_WATER_DEPTH_STATE];
  if (kind !== 1 && kind !== 2) {
    throw new Error(`Waterlogged interaction target has invalid water kind: ${String(kind)}.`);
  }
  if (!Number.isInteger(depth) || Number(depth) < 0 || Number(depth) > 15) {
    throw new Error(`Waterlogged interaction target has invalid water depth: ${String(depth)}.`);
  }
  return {
    depth: Number(depth),
    typeId: kind === 1 ? "minecraft:water" : "minecraft:flowing_water"
  };
}

function getVanillaFluidDepth(block: WorldBlockLike, typeId: string): number | undefined {
  if (
    typeId !== "minecraft:water"
    && typeId !== "minecraft:flowing_water"
    && typeId !== "minecraft:lava"
    && typeId !== "minecraft:flowing_lava"
  ) return undefined;
  const depth = block.permutation?.getAllStates().liquid_depth;
  if (!Number.isInteger(depth) || Number(depth) < 0 || Number(depth) > 15) {
    throw new Error(`${typeId} has an invalid liquid_depth block state: ${String(depth)}.`);
  }
  return Number(depth);
}

export function sampleTouchesNativeFlowingFluid(
  pointY: number,
  surface: FluidSurface | undefined
): boolean {
  return surface?.nativeFlowing === true && pointY - 0.5 < surface.surfaceY;
}

export function isWaterFluidType(typeId: string): boolean {
  return typeId === "minecraft:water"
    || typeId === "minecraft:flowing_water"
    || typeId === "minecraft:bubble_column";
}

export function isLavaFluidType(typeId: string): boolean {
  return typeId === "minecraft:lava"
    || typeId === "minecraft:flowing_lava";
}

export function getWorldBlockMaterialId(
  block: WorldBlockLike,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>
): string {
  const properties = block.typeId ? blockProperties.get(block.typeId) : undefined;
  return getWorldBlockMaterialIdFromProperties(properties);
}

export function getWorldBlockMaterialIdFromProperties(
  properties: PhysicsBlockProperties | undefined
): string {
  const friction = normalizeContactFriction(
    properties?.friction,
    DEFAULT_SOLID_BLOCK_FRICTION
  );
  const restitution = normalizeContactRestitution(
    properties?.restitution,
    DEFAULT_SOLID_BLOCK_RESTITUTION
  );
  return friction === DEFAULT_SOLID_BLOCK_FRICTION
      && restitution === DEFAULT_SOLID_BLOCK_RESTITUTION
    ? "world_block"
    : `world_block:${friction}:${restitution}`;
}

export function normalizeContactFriction(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value ?? fallback);
}

export function normalizeContactRestitution(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value ?? fallback));
}

export function matchesWorldBlockSensorPredicate(
  block: WorldBlockLike,
  predicate: ((block: Block) => boolean) | undefined
): boolean {
  if (!predicate) return false;
  try {
    return predicate(block as Block) === true;
  } catch {
    return false;
  }
}

export function isWorldBlockColliding(
  dimension: Dimension,
  location: Vector3,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>,
  sensorPredicate: ((block: Block) => boolean) | undefined
): boolean {
    const block = safeGetBlock(dimension, location);
  if (block === undefined || block.isAir || isPhysicsFluidBlock(block)) return false;
  return resolveWorldBlockCollisionShape(block, blockProperties) !== "none"
    && !matchesWorldBlockSensorPredicate(block, sensorPredicate);
}

export function resolveWorldBlockCollisionShape(
  block: Block | WorldBlockLike,
  blockProperties: ReadonlyMap<string, PhysicsBlockProperties>
): ResolvedWorldBlockCollisionShape {
  const properties = block.typeId ? blockProperties.get(block.typeId) : undefined;
  const configuredShape = properties?.collisionShape;
  if (configuredShape !== undefined) {
    return normalizeConfiguredWorldBlockCollisionShape(configuredShape);
  }

  const typeId = block.typeId;
  const plan = typeId?.startsWith("minecraft:")
    ? getVanillaCollisionResolutionPlan(typeId)
    : undefined;
  const cacheable = plan !== undefined
    && !plan.contextDependent
    && !plan.neighborDependent
    && !plan.stateDependent;
  if (cacheable) {
    const cached = STATIC_VANILLA_WORLD_COLLISION_SHAPES.get(typeId!);
    if (cached !== undefined) return cached;
  }

  const shape = resolveBlockCollisionShape(block as never);
  const resolved = normalizeResolvedWorldBlockCollisionShape(shape);
  if (cacheable) STATIC_VANILLA_WORLD_COLLISION_SHAPES.set(typeId!, resolved);
  return resolved;
}

function normalizeResolvedWorldBlockCollisionShape(
  shape: ReturnType<typeof resolveBlockCollisionShape>
): ResolvedWorldBlockCollisionShape {
  if (shape.kind === "none") return "none";
  if (shape.kind === "full") return "full";
  const boxes = shape.shapes.map(toPhysicsBlockCollisionBox).filter(isValidBlockCollisionBox);
  return boxes.length > 0 ? boxes : "none";
}

function normalizeConfiguredWorldBlockCollisionShape(
  shape: NonNullable<PhysicsBlockProperties["collisionShape"]>
): ResolvedWorldBlockCollisionShape {
  if (shape === "none") return "none";
  if (shape === "full") return "full";
  const boxes = shape.filter(isValidBlockCollisionBox);
  return boxes.length > 0 ? boxes : "none";
}

function toPhysicsBlockCollisionBox(box: BlockCollisionBoxShapeDefinition): PhysicsBlockCollisionBox {
  return {
    min: { x: box.minX, y: box.minY, z: box.minZ },
    max: { x: box.maxX, y: box.maxY, z: box.maxZ }
  };
}

function isValidBlockCollisionBox(box: PhysicsBlockCollisionBox): boolean {
  return (
    Number.isFinite(box.min.x)
    && Number.isFinite(box.min.y)
    && Number.isFinite(box.min.z)
    && Number.isFinite(box.max.x)
    && Number.isFinite(box.max.y)
    && Number.isFinite(box.max.z)
    && box.min.x >= 0
    && box.min.y >= 0
    && box.min.z >= 0
    && box.max.x <= 1
    && box.max.y <= 2
    && box.max.z <= 1
    && box.max.x > box.min.x
    && box.max.y > box.min.y
    && box.max.z > box.min.z
  );
}
