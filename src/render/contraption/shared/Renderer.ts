// Contraption visual rendering contract: the shared renderer/body interfaces,
// carrier constants, and the factories over the block and fragment
// renderer implementations (block-visual-renderer / fragment-visual-renderer).
import { ItemTypes, type Entity, type Vector3 } from "@minecraft/server";
import type { PhysicsContraptionBlock, PhysicsContraptionFoliageTint } from "@src/physics/core/Types";
import {
  CUBE_FRAGMENT_ENTITY_TYPE_ID,
  ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID,
  COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID,
  LOG_FRAGMENT_ENTITY_TYPE_ID,
  TALL_LOG_FRAGMENT_ENTITY_TYPE_ID,
  LEAF_FRAGMENT_ENTITY_TYPE_ID,
  packFragments
} from "@src/render/contraption/fragment/FragmentLayout";
import { DEFAULT_CONTRAPTION_FOLIAGE_TINT } from "@src/render/foliage/TintCodec";
import { selectContraptionVisualAnchor } from "@src/render/contraption/shared/VisualAnchor";
import { BlockRenderer } from "@src/render/contraption/block/BlockRenderer";
import {
  FRAGMENT_CARRIER_ENTITY_TYPE_ID,
  FragmentRenderer
} from "@src/render/contraption/fragment/FragmentRenderer";

export const BLOCK_CARRIER_ENTITY_TYPE_ID = "treephysics:block_carrier";
// One native seat is reserved for the single contraption outline rider.
export const BLOCK_CARRIER_CAPACITY = 511;
export const BLOCK_SLOTS_PER_ENTITY = 2;
// Existing packed properties carry readiness because attachment fragments
// already use all 32 entity properties.
export const CONTRAPTION_RENDER_ENTITY_TYPE_IDS = new Set([
  "treephysics:block",
  BLOCK_CARRIER_ENTITY_TYPE_ID,
  FRAGMENT_CARRIER_ENTITY_TYPE_ID,
  LOG_FRAGMENT_ENTITY_TYPE_ID,
  TALL_LOG_FRAGMENT_ENTITY_TYPE_ID,
  LEAF_FRAGMENT_ENTITY_TYPE_ID,
  COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID,
  ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID,
  CUBE_FRAGMENT_ENTITY_TYPE_ID
]);

export interface BlockCarrier {
  readonly entity: Entity;
  readonly riderIds: readonly string[];
}

export type BlockSlot = "mainhand" | "offhand";

export interface BlockAssignment {
  readonly block: PhysicsContraptionBlock;
  readonly entity: Entity;
  readonly slot: BlockSlot;
}

export interface ContraptionRenderBody {
  readonly isValid: boolean;
  readonly isSleeping?: boolean;
  getRotation(): Vector3;
  getVisualRotation?(reference?: Vector3): Vector3;
  localPointToWorld(location: Vector3): Vector3;
}

export interface ContraptionRenderer {
  readonly supportsBlockAddition: boolean;
  readonly initialPoseDeferred: boolean;
  /** Rotation values most recently published to the visual entities. */
  readonly visualRotation: Readonly<Vector3>;
  readonly visualAnchorLocal: Vector3;
  readonly entityCount: number;
  readonly entityIds: readonly string[];
  readonly entityLocations: readonly Vector3[];
  readonly firstEntityLocation: Vector3 | undefined;
  hasEntity(entityId: string): boolean;
  hasKnownIntegrityFailure(): boolean;
  hasIntactEntities(): boolean;
  releaseInitialPose(): void;
  setAttachmentBlockVisualState(blockKey: string, state: number): boolean;
  setCubeBlockOpenState(blockKey: string, open: boolean): boolean;
  attachAuxiliaryRider(entity: Entity): boolean;
  attachPersistentRider(entity: Entity): boolean;
  addBlocks(blocks: readonly PhysicsContraptionBlock[]): void;
  detachAuxiliaryRider(entity: Entity): void;
  detachPersistentRider(entity: Entity, preserveEmptyCarrier?: boolean): void;
  removeEmptyPersistentRiderCarriers(): void;
  remove(): void;
  removeBlocks(blockKeys: ReadonlySet<string>): void;
  rebaseVisualAnchor(blocks: readonly PhysicsContraptionBlock[]): void;
  sync(force?: boolean): number;
}

/** Refuse block rendering when any block has no registered visual item. */
export function assertBlockVisualItems(blocks: readonly PhysicsContraptionBlock[]): void {
  const missing = new Set<string>();
  for (const block of blocks) {
    const itemTypeId = block.itemTypeId ?? block.typeId;
    if (!ItemTypes.get(itemTypeId)) missing.add(itemTypeId);
  }
  if (missing.size > 0) {
    throw new Error(`Block visual items are not registered: ${[...missing].sort().join(", ")}.`);
  }
}

export function createBlockRenderer(
  body: ContraptionRenderBody,
  assignments: readonly BlockAssignment[],
  carriers: readonly BlockCarrier[],
  onEntityRemoved?: (entityId: string) => void,
  visualAnchor: Vector3 = selectContraptionVisualAnchor(
    assignments.map(assignment => assignment.block)
  ),
  spawnEntity?: (typeId: string, location: Vector3) => Entity,
  foliageTint: PhysicsContraptionFoliageTint = DEFAULT_CONTRAPTION_FOLIAGE_TINT,
  onEntityAdded?: (entityId: string) => void,
  initialCubeBlocks: readonly PhysicsContraptionBlock[] = []
): ContraptionRenderer {
  return new BlockRenderer(
    body,
    assignments,
    carriers,
    onEntityRemoved,
    visualAnchor,
    spawnEntity,
    foliageTint,
    onEntityAdded,
    initialCubeBlocks
  );
}

export function tryCreateFragmentRenderer(
  body: ContraptionRenderBody,
  blocks: readonly PhysicsContraptionBlock[],
  spawnEntity: (typeId: string, location: Vector3) => Entity,
  foliageTint?: PhysicsContraptionFoliageTint,
  onEntityRemoved?: (entityId: string) => void,
  visualAnchor: Vector3 = selectContraptionVisualAnchor(blocks),
  onEntityAdded?: (entityId: string) => void
): ContraptionRenderer | undefined {
  const fragments = packFragments(blocks);
  if (!fragments) return undefined;
  return new FragmentRenderer(
    body,
    fragments,
    spawnEntity,
    foliageTint ?? DEFAULT_CONTRAPTION_FOLIAGE_TINT,
    onEntityRemoved,
    visualAnchor,
    onEntityAdded
  );
}
