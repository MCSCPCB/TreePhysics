import type { Vector3 } from "@minecraft/server";

export const MAX_PHYSICS_CONTRAPTION_BLOCKS = 6144;

export interface PhysicsBodyBoxCollider {
  halfExtents?: Vector3;
  size?: Vector3;
  type: "box";
}

export interface PhysicsBodySphereCollider {
  radius: number;
  type: "sphere";
}

export interface PhysicsBodyCylinderCollider {
  height: number;
  radius?: number;
  radiusBottom?: number;
  radiusTop?: number;
  type: "cylinder";
}

export interface PhysicsBodyConvexCollider {
  faces: readonly (readonly number[])[];
  type: "convex";
  vertices: readonly Vector3[];
}

export type PhysicsBodyCompoundChildCollider =
  | PhysicsBodyBoxCollider
  | PhysicsBodySphereCollider
  | PhysicsBodyCylinderCollider
  | PhysicsBodyConvexCollider;

export interface PhysicsBodyCompoundColliderChild {
  collider: PhysicsBodyCompoundChildCollider;
  collisionTag?: PhysicsCollisionTag;
  collisionResponse?: boolean;
  location?: Vector3;
  rotation?: Vector3;
}

export type PhysicsCollisionTag = number | string;

export interface PhysicsBodyCompoundCollider {
  children: readonly PhysicsBodyCompoundColliderChild[];
  type: "compound";
}

export type PhysicsBodySolidCollider =
  | PhysicsBodyCompoundChildCollider
  | PhysicsBodyCompoundCollider;

export interface PhysicsBodySensorCollider {
  collider: PhysicsBodySolidCollider;
  type: "sensor";
}

export type PhysicsBodyCollider = PhysicsBodySolidCollider | PhysicsBodySensorCollider;
export type PhysicsBodyMotionType = "dynamic" | "kinematic" | "static";

export interface PhysicsBodyVisualOptions {
  entityTypeId?: string;
  itemTypeId?: string;
  propertyMap?: {
    pitch: string;
    roll: string;
    scale: string;
    yaw: string;
  };
}

export interface PhysicsBodyOptions {
  allowSleep?: boolean;
  angularDamping?: number;
  angularVelocity?: Vector3;
  buoyancyPoints?: readonly PhysicsBodyBuoyancyPoint[];
  collider?: PhysicsBodyCollider;
  environmentCollider?: PhysicsBodyCollider;
  gravityScale?: number;
  /**
   * Legacy direct item visual. When both paths are present, visual.itemTypeId
   * takes precedence; this field remains the explicit fallback.
   */
  itemTypeId?: string;
  linearDamping?: number;
  location: Vector3;
  mass?: number;
  material?: string;
  motionType?: PhysicsBodyMotionType;
  name?: string;
  rotation?: Vector3;
  size?: Vector3;
  velocity?: Vector3;
  visual?: PhysicsBodyVisualOptions | false;
  /** Legacy direct entity visual; visual.entityTypeId takes precedence. */
  visualEntityTypeId?: string;
}

export interface PhysicsBodyBuoyancyPoint {
  localLocation: Vector3;
  volume: number;
}

export interface PhysicsBodyForceOptions {
  coordinateSpace?: "world" | "local";
}

export interface PhysicsBodyTeleportOptions {
  angularVelocity?: Vector3;
  rotation?: Vector3;
  velocity?: Vector3;
}

export interface PhysicsInertiaTensor {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
  m20: number;
  m21: number;
  m22: number;
}

export interface PhysicsContactMaterialProperties {
  friction?: number;
  restitution?: number;
}

export interface PhysicsBlockCollisionBox {
  max: Vector3;
  min: Vector3;
}

export interface PhysicsBlockProperties {
  collisionShape?: "full" | "none" | readonly PhysicsBlockCollisionBox[];
  fragileImpactSpeed?: number;
  friction?: number;
  restitution?: number;
}

export interface PhysicsBodyAabb {
  max: Vector3;
  min: Vector3;
}

export interface PhysicsWorldOptions {
  angularDamping?: number;
  fixedTimeStep?: number;
  gravity?: Vector3;
  linearDamping?: number;
}

export interface PhysicsWorldStats {
  activeBodyCount: number;
  bodyCount: number;
  fixedTimeStep: number;
  running: boolean;
  sleepingBodyCount: number;
  stepCount: number;
}

export interface PhysicsWorldStepAfterEvent {
  currentTick: number;
  fixedTimeStep: number;
}

export interface PhysicsContraptionBlock {
  buoyancyVolume?: number;
  collidable?: boolean;
  collisionResponse?: boolean;
  collisionShape?: "full" | "none" | readonly PhysicsBlockCollisionBox[];
  itemTypeId?: string;
  localLocation: Vector3;
  mass?: number;
  rotation?: Vector3;
  runtimeCollidable?: boolean;
  typeId: string;
  visual?: PhysicsContraptionBlockVisual;
}

export type PhysicsContraptionBlockVisual =
  | {
    allBark: boolean;
    family: number;
    renderer: "log_fragment";
    state: number;
  }
  | {
    family: number;
    renderer: "leaf_fragment";
    state: 1;
  }
  | {
    family: number;
    renderer: "attachment_fragment";
    state: number;
  }
  | {
    family: 0;
    renderer: "cube_block_fragment";
    state: number;
  };

export interface PhysicsContraptionOptions {
  allowSleep?: boolean;
  angularVelocity?: Vector3;
  blocks: readonly PhysicsContraptionBlock[];
  foliageTint?: PhysicsContraptionFoliageTint;
  linearDamping?: number;
  angularDamping?: number;
  location: Vector3;
  name?: string;
  rotation?: Vector3;
  runtimeRepresentation?: PhysicsContraptionRuntimeRepresentationFactory;
  velocity?: Vector3;
  visualEntityTags?: readonly string[];
}

export interface PhysicsContraptionFoliageTint {
  gradientAxis: "x" | "z";
  mapKind: number;
  uAtLocalOrigin: number;
  uPerLocalX: number;
  vAtLocalOrigin: number;
  vPerLocalZ: number;
}

export interface PhysicsContraptionRuntimeRepresentation {
  readonly buoyancyPoints: readonly PhysicsBodyBuoyancyPoint[];
  readonly collider: PhysicsBodyCollider;
}

export interface PhysicsContraptionRuntimeRepresentationState {
  readonly representation: PhysicsContraptionRuntimeRepresentation;
  addBlocks?(blocks: readonly PhysicsContraptionBlock[]): PhysicsContraptionRuntimeRepresentation;
  removeBlocks(blocks: readonly PhysicsContraptionBlock[]): PhysicsContraptionRuntimeRepresentation;
}

export interface PhysicsContraptionRuntimeRepresentationFactory {
  (blocks: readonly PhysicsContraptionBlock[]): PhysicsContraptionRuntimeRepresentation;
  createIncrementalState?: (
    blocks: readonly PhysicsContraptionBlock[]
  ) => PhysicsContraptionRuntimeRepresentationState;
}

export interface PhysicsContraptionRaycastHit {
  readonly block: PhysicsContraptionBlock;
  readonly distance: number;
  readonly face: PhysicsContraptionBlockFace;
  readonly localLocation: Vector3;
  readonly localNormal: Vector3;
  readonly location: Vector3;
  readonly normal: Vector3;
}

export interface PhysicsContraptionRaycastOptions {
  /**
   * Traverse blocks without a collision response (leaves, fragile plants)
   * instead of hitting them. Interaction rays use this so foliage between the
   * player and an interactable block does not swallow the crosshair.
   */
  readonly ignorePassableBlocks?: boolean;
  /** Ignore an contraption block containing the ray origin and select farther blocks. */
  readonly skipContainingBlock?: boolean;
}

export type PhysicsContraptionBlockFace = "down" | "up" | "north" | "south" | "west" | "east";

export interface PhysicsCollisionAfterEvent {
  body: import("@src/Physics").PhysicsBody;
  collisionTag?: PhysicsCollisionTag;
  currentTick: number;
  impactSpeed: number;
  normal: Vector3;
  otherBody?: import("@src/Physics").PhysicsBody;
  otherCollisionTag?: PhysicsCollisionTag;
  point: Vector3;
}

export interface PhysicsWaterEntryAfterEvent {
  body: import("@src/Physics").PhysicsBody;
  fastestContactVelocityY: number;
  maxContactX: number;
  maxContactZ: number;
  minContactX: number;
  minContactZ: number;
  point: Vector3;
  timeStep: number;
  bodyAabbSizeX: number;
  bodyAabbSizeZ: number;
}

export interface PhysicsLavaEntryAfterEvent extends PhysicsWaterEntryAfterEvent {}
