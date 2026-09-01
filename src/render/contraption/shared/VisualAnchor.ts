import type { Vector3 } from "@minecraft/server";
import type { PhysicsContraptionBlock } from "@src/physics/core/Types";
import { isTreeLog } from "@src/content/tree/block/Blocks";

export const DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL: Vector3 = Object.freeze({ x: 0, y: 1, z: 0 });

/** Select a stable log, or a stable collidable block when no log remains. */
export function selectContraptionVisualAnchor(blocks: readonly PhysicsContraptionBlock[]): Vector3 {
  return findContraptionVisualAnchor(blocks) ?? { ...DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL };
}

export function findContraptionVisualAnchor(blocks: readonly PhysicsContraptionBlock[]): Vector3 | undefined {
  let selectedLog: PhysicsContraptionBlock | undefined;
  let selectedLogDistance = Number.POSITIVE_INFINITY;
  // Detached lower branches may contain only logs below the break origin. Keep
  // the nearest lower log so their visual anchor stays below the removed block.
  let selectedLowerLog: PhysicsContraptionBlock | undefined;
  let selectedLowerLogDistance = Number.POSITIVE_INFINITY;
  let selectedFallback: PhysicsContraptionBlock | undefined;
  let selectedFallbackDistance = Number.POSITIVE_INFINITY;
  let containsLog = false;
  for (const block of blocks) {
    containsLog ||= isTreeLog(block.typeId);
    if (!isStableVisualAnchorBlock(block)) continue;
    const dx = block.localLocation.x - DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.x;
    const dy = block.localLocation.y - DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.y;
    const dz = block.localLocation.z - DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (isVisualAnchorCandidate(block)) {
      if (distance < selectedLogDistance) {
        selectedLog = block;
        selectedLogDistance = distance;
      }
    } else if (isTreeLog(block.typeId)) {
      if (distance < selectedLowerLogDistance) {
        selectedLowerLog = block;
        selectedLowerLogDistance = distance;
      }
    } else if (distance < selectedFallbackDistance) {
      selectedFallback = block;
      selectedFallbackDistance = distance;
    }
  }
  const selected = selectedLog ?? selectedLowerLog ?? (containsLog ? undefined : selectedFallback);
  return selected ? { ...selected.localLocation } : undefined;
}

function isVisualAnchorCandidate(block: PhysicsContraptionBlock): boolean {
  return isTreeLog(block.typeId)
    && block.localLocation.y >= DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.y
    && isStableVisualAnchorBlock(block);
}

function isStableVisualAnchorBlock(block: PhysicsContraptionBlock): boolean {
  return block.collidable !== false
    && block.collisionResponse !== false
    && block.runtimeCollidable !== false
    && block.collisionShape !== "none";
}
