import type { Vector3 } from "@minecraft/server";
import { isVanillaTypeId, logFamily, type CapturedTreeBlock } from "@src/content/tree/block/Blocks";
import { resolveTreeAttachmentSupport } from "@src/content/tree/block/AttachmentSupport";
import { createTreeLogBreakagePlan } from "@src/content/tree/breakage/Plan";
import { blockKey as locationKey } from "@src/utils/BlockKey";
import { add, subtract, squaredDistance } from "@src/utils/Vector3Math";
import {
  hasNeighborKey as hasAdjacentKey,
  NEIGHBOR_OFFSETS as SUPPORT_OFFSETS
} from "@src/utils/Neighborhood";

export interface LowPerformanceBranchPruningPlan {
  readonly detachedSnapshots: readonly CapturedTreeBlock[];
  readonly retainedSnapshots: readonly CapturedTreeBlock[];
}
const ANCHOR_TARGET: Vector3 = { x: 0, y: 1, z: 0 };

/** Removes eligible branch structures before a low-performance body is created. */
export function createLowPerformanceBranchPruningPlan(
  snapshots: readonly CapturedTreeBlock[],
  origin: Vector3
): LowPerformanceBranchPruningPlan {
  const entries = snapshots.map(snapshot => {
    const localLocation = subtract(snapshot.location, origin);
    return { key: locationKey(localLocation), localLocation, snapshot };
  });
  const logs = entries.filter(entry => entry.snapshot.kind === "log");
  if (logs.length === 0) return unchangedPlan(snapshots);

  const anchorLocation = selectAnchorLocation(logs.map(entry => entry.localLocation));
  const breakagePlan = createTreeLogBreakagePlan(
    logs.map(entry => ({
      family: logFamily(entry.snapshot),
      key: entry.key,
      localLocation: entry.localLocation
    })),
    {
      anchorLocation,
      inferFamilyFromStructure: snapshots.some(snapshot =>
        (snapshot.kind === "log" || snapshot.kind === "leaf")
        && !isVanillaTypeId(snapshot.typeId)
      ),
      seed: 0
    }
  );
  const detachedKeys = new Set(
    breakagePlan.breakGroups
      .filter(group => group.kind === "branch")
      .flatMap(group => group.keys)
  );
  if (detachedKeys.size === 0) return unchangedPlan(snapshots);

  const remainingLogKeys = new Set(
    logs.filter(entry => !detachedKeys.has(entry.key)).map(entry => entry.key)
  );
  detachUnsupportedLeaves(entries, detachedKeys, remainingLogKeys);
  const attachmentSupport = resolveTreeAttachmentSupport(entries, detachedKeys);
  for (const key of attachmentSupport.unsupportedKeys) detachedKeys.add(key);

  return {
    detachedSnapshots: entries
      .filter(entry => detachedKeys.has(entry.key))
      .map(entry => entry.snapshot),
    retainedSnapshots: entries
      .filter(entry => !detachedKeys.has(entry.key))
      .map(entry => attachmentSupport.stateUpdates.get(entry.key)?.snapshot ?? entry.snapshot)
  };
}

interface SnapshotEntry {
  readonly key: string;
  readonly localLocation: Vector3;
  readonly snapshot: CapturedTreeBlock;
}

function detachUnsupportedLeaves(
  entries: readonly SnapshotEntry[],
  detachedKeys: Set<string>,
  remainingLogKeys: ReadonlySet<string>
): void {
  const leaves = new Map(
    entries
      .filter(entry => entry.snapshot.kind === "leaf")
      .map(entry => [entry.key, entry])
  );
  const affectedSeeds = new Set<string>();
  for (const entry of entries) {
    if (!detachedKeys.has(entry.key) || entry.snapshot.kind !== "log") continue;
    for (const offset of SUPPORT_OFFSETS) {
      const neighborKey = locationKey(add(entry.localLocation, offset));
      if (leaves.has(neighborKey)) affectedSeeds.add(neighborKey);
    }
  }

  const visited = new Set<string>();
  for (const seed of affectedSeeds) {
    if (visited.has(seed)) continue;
    const component: string[] = [];
    const queue = [seed];
    visited.add(seed);
    let supported = false;
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]!;
      const entry = leaves.get(key);
      if (!entry) continue;
      component.push(key);
      supported ||= hasAdjacentKey(entry.localLocation, remainingLogKeys);
      for (const offset of SUPPORT_OFFSETS) {
        const neighborKey = locationKey(add(entry.localLocation, offset));
        if (visited.has(neighborKey) || !leaves.has(neighborKey)) continue;
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }
    if (!supported) for (const key of component) detachedKeys.add(key);
  }
}

function selectAnchorLocation(locations: readonly Vector3[]): Vector3 {
  let selected = locations[0]!;
  let selectedDistance = squaredDistance(selected, ANCHOR_TARGET);
  for (let index = 1; index < locations.length; index++) {
    const candidate = locations[index]!;
    const distance = squaredDistance(candidate, ANCHOR_TARGET);
    if (distance >= selectedDistance) continue;
    selected = candidate;
    selectedDistance = distance;
  }
  return { ...selected };
}

function unchangedPlan(
  snapshots: readonly CapturedTreeBlock[]
): LowPerformanceBranchPruningPlan {
  return { detachedSnapshots: [], retainedSnapshots: snapshots };
}
