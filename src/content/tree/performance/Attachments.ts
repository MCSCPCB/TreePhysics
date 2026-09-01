import type { Vector3 } from "@minecraft/server";
import { blockKey } from "@src/utils/BlockKey";
import type { PhysicsContraptionBlock } from "@src/Physics";
import {
  TREE_ATTACHMENT_FRAGMENT_FAMILIES,
  createFragmentVisual
} from "@src/render/contraption/fragment/FragmentVisual";
import { isPerformanceDetachableTreeAttachment, type CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import {
  ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID,
  packFragments
} from "@src/render/contraption/fragment/FragmentLayout";
import type { TreeLeafPhysicsProfileId } from "@src/content/tree/foliage/PhysicsQuality";

export interface TreeAttachmentPerformanceCost {
  readonly candidateBlockCount: number;
  readonly avoidableControllerCount: number;
  readonly avoidableFragmentCount: number;
  readonly fullControllerCount: number;
  readonly fullFragmentCount: number;
  readonly retainedControllerCount: number;
  readonly retainedFragmentCount: number;
}
export interface TreeAttachmentPerformancePlan {
  readonly cost: TreeAttachmentPerformanceCost;
  readonly detachedAttachments: readonly CapturedTreeBlock[];
  readonly retainedSnapshots: readonly CapturedTreeBlock[];
}

interface AttachmentPerformanceThreshold {
  readonly controllerCount: number;
  readonly fragmentCount: number;
}

const TREE_ATTACHMENT_CONTROLLER_COUNT_BY_FAMILY: Readonly<Record<
  typeof TREE_ATTACHMENT_FRAGMENT_FAMILIES[number],
  number
>> = {
  bee_nest: 8,
  cocoa: 3,
  creaking_heart: 18,
  hanging_roots: 1,
  mangrove_propagule: 5,
  mangrove_roots: 2,
  muddy_mangrove_roots: 2,
  pale_hanging_moss: 2,
  vine: 27
};

const ATTACHMENT_PERFORMANCE_THRESHOLDS: Readonly<Record<
  TreeLeafPhysicsProfileId,
  AttachmentPerformanceThreshold
>> = {
  exact: { controllerCount: 384, fragmentCount: 16 },
  high: { controllerCount: 384, fragmentCount: 16 },
  low: { controllerCount: 96, fragmentCount: 4 },
  medium: { controllerCount: 192, fragmentCount: 8 }
};

// Every attachment fragment family maps to exactly one vanilla block whose id
// is the family name under the minecraft: namespace, so the id set can be
// derived from the shared family list instead of being maintained by hand.
const ATTACHMENT_FRAGMENT_TYPE_IDS = new Set<string>(
  TREE_ATTACHMENT_FRAGMENT_FAMILIES.map(family => `minecraft:${family}`)
);

export function createTreeAttachmentPerformancePlan(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3,
  profileId: TreeLeafPhysicsProfileId
): TreeAttachmentPerformancePlan {
  const candidates = snapshots.filter(snapshot =>
    isPerformanceDetachableTreeAttachment(snapshot)
  );
  if (candidates.length === 0) return unchangedPlan(snapshots);

  const retainedSnapshots = snapshots.filter(snapshot =>
    !isPerformanceDetachableTreeAttachment(snapshot)
  );
  const fullCost = measureAttachmentVisualCost(snapshots, origin);
  const retainedCost = measureAttachmentVisualCost(retainedSnapshots, origin);
  const cost: TreeAttachmentPerformanceCost = {
    candidateBlockCount: candidates.length,
    avoidableControllerCount: Math.max(
      0,
      fullCost.controllerCount - retainedCost.controllerCount
    ),
    avoidableFragmentCount: Math.max(0, fullCost.fragmentCount - retainedCost.fragmentCount),
    fullControllerCount: fullCost.controllerCount,
    fullFragmentCount: fullCost.fragmentCount,
    retainedControllerCount: retainedCost.controllerCount,
    retainedFragmentCount: retainedCost.fragmentCount
  };
  const threshold = ATTACHMENT_PERFORMANCE_THRESHOLDS[profileId];
  const shouldDetach = cost.avoidableFragmentCount >= threshold.fragmentCount
    || cost.avoidableControllerCount >= threshold.controllerCount;
  return shouldDetach
    ? { cost, detachedAttachments: candidates, retainedSnapshots }
    : { cost, detachedAttachments: [], retainedSnapshots: snapshots };
}

function unchangedPlan(
  snapshots: readonly CapturedTreeBlock[]
): TreeAttachmentPerformancePlan {
  return {
    cost: {
      candidateBlockCount: 0,
      avoidableControllerCount: 0,
      avoidableFragmentCount: 0,
      fullControllerCount: 0,
      fullFragmentCount: 0,
      retainedControllerCount: 0,
      retainedFragmentCount: 0
    },
    detachedAttachments: [],
    retainedSnapshots: snapshots
  };
}

function measureAttachmentVisualCost(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3
): { readonly controllerCount: number; readonly fragmentCount: number } {
  const blocks = snapshots
    .filter(snapshot => ATTACHMENT_FRAGMENT_TYPE_IDS.has(snapshot.typeId))
    .map(snapshot => attachmentContraptionBlock(snapshot, origin))
    .filter((block): block is PhysicsContraptionBlock => block !== undefined);
  const fragments = packFragments(blocks) ?? [];
  const attachmentFragments = fragments.filter(fragment =>
    fragment.entityTypeId === ATTACHMENT_FRAGMENT_ENTITY_TYPE_ID
  );
  const familyByBlockKey = new Map(blocks.map(block => [
    blockKey(block.localLocation),
    block.visual!.family
  ]));
  let controllerCount = 0;
  for (const fragment of attachmentFragments) {
    const families = new Set<number>();
    for (const assignment of fragment.assignments) {
      const family = familyByBlockKey.get(assignment.blockKey);
      if (family !== undefined) families.add(family);
    }
    for (const family of families) {
      const name = TREE_ATTACHMENT_FRAGMENT_FAMILIES[family];
      if (name) controllerCount += TREE_ATTACHMENT_CONTROLLER_COUNT_BY_FAMILY[name];
    }
  }
  return { controllerCount, fragmentCount: attachmentFragments.length };
}

function attachmentContraptionBlock(
  snapshot: CapturedTreeBlock,
  origin: Vector3
): PhysicsContraptionBlock | undefined {
  const visual = createFragmentVisual(snapshot);
  if (visual?.renderer !== "attachment_fragment") return undefined;
  return {
    localLocation: {
      x: snapshot.location.x - origin.x,
      y: snapshot.location.y - origin.y,
      z: snapshot.location.z - origin.z
    },
    typeId: snapshot.typeId,
    visual
  };
}
