import type { Vector3 } from "@minecraft/server";
import {
  COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID,
  TREE_FRAGMENT_ORIGIN_BIAS,
  TREE_FRAGMENT_ORIGIN_SIZE,
  LEAF_FRAGMENT_ENTITY_TYPE_ID,
  type CubeBlockFragmentLayout,
  type PackedFragment
} from "@src/render/contraption/fragment/FragmentLayout";
import {
  DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL
} from "@src/render/contraption/shared/VisualAnchor";

export const FRAGMENT_INITIAL_POSE_READY_BIT = 16;
export const ATTACHMENT_FRAGMENT_INITIAL_POSE_READY_BIT = TREE_FRAGMENT_ORIGIN_SIZE * 512;

export function getPackedFragmentOrigin(fragment: PackedFragment, visualAnchor: Vector3): { xz: number; y: number } {
  return getPackedFragmentOriginFromAnchor(fragment.anchorLocalLocation, visualAnchor);
}

export function getPackedFragmentOriginFromAnchor(fragmentAnchor: Vector3, visualAnchor: Vector3): { xz: number; y: number } {
  return packFragmentOrigin({
    x: fragmentAnchor.x + DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.x - visualAnchor.x,
    y: fragmentAnchor.y + DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.y - visualAnchor.y,
    z: fragmentAnchor.z + DEFAULT_CONTRAPTION_VISUAL_ANCHOR_LOCAL.z - visualAnchor.z
  });
}

export function isLeafFragmentEntityTypeId(entityTypeId: string): boolean {
  return entityTypeId === LEAF_FRAGMENT_ENTITY_TYPE_ID
    || entityTypeId === COMPACT_LEAF_FRAGMENT_ENTITY_TYPE_ID;
}

export function logFragmentModes(words: readonly number[], allBark: boolean): number {
  let modes = 0;
  const normalMode = allBark ? 4 : 1;
  const strippedMode = allBark ? 8 : 2;
  const completeModes = normalMode | strippedMode;
  for (const word of words) {
    for (let shift = 0; shift < 24; shift += 3) {
      const state = Math.floor(word / (2 ** shift)) % 8;
      if (state >= 2 && state <= 4) modes |= normalMode;
      else if (state >= 5) modes |= strippedMode;
      if (modes === completeModes) return modes;
    }
  }
  return modes;
}

export function encodeFragmentFamily(family: number, poseReady: boolean): number {
  return family + (poseReady ? FRAGMENT_INITIAL_POSE_READY_BIT : 0);
}

export function encodeLogFragmentModes(modes: number, poseReady: boolean): number {
  return modes + (poseReady ? FRAGMENT_INITIAL_POSE_READY_BIT : 0);
}

export function encodeCubeFragmentModes(layout: CubeBlockFragmentLayout, poseReady: boolean): number {
  return (poseReady ? 1 : 0)
    + (layout.format === "sparse" ? 2 : 0)
    + layout.width * 4
    + layout.depth * 1024;
}

export function attachmentFamilyMask(words: readonly number[]): number {
  let mask = 0;
  for (const descriptor of words) {
    if (Math.floor(descriptor / 0x10000) < 1) continue;
    mask |= 2 ** (Math.floor(descriptor / 0x100) % 0x10);
  }
  return mask;
}

export function packAttachmentOriginY(originY: number, familyMask: number, poseReady: boolean): number {
  return originY
    + familyMask * TREE_FRAGMENT_ORIGIN_SIZE
    + (poseReady ? ATTACHMENT_FRAGMENT_INITIAL_POSE_READY_BIT : 0);
}

function packFragmentOrigin(localLocation: Vector3): { xz: number; y: number } {
  const x = localLocation.x + TREE_FRAGMENT_ORIGIN_BIAS;
  const y = localLocation.y + TREE_FRAGMENT_ORIGIN_BIAS;
  const z = localLocation.z + TREE_FRAGMENT_ORIGIN_BIAS;
  if (
    !Number.isInteger(x) || x < 0 || x >= TREE_FRAGMENT_ORIGIN_SIZE
    || !Number.isInteger(y) || y < 0 || y >= TREE_FRAGMENT_ORIGIN_SIZE
    || !Number.isInteger(z) || z < 0 || z >= TREE_FRAGMENT_ORIGIN_SIZE
  ) throw new RangeError("Tree fragment origin exceeds the packed visual range.");
  return { xz: x + z * TREE_FRAGMENT_ORIGIN_SIZE, y };
}
