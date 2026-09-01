import type { Vector3 } from "@minecraft/server";
import { blockKey as coordinateKey, parseBlockKey as parseKey } from "@src/utils/BlockKey";
import { NEIGHBOR_OFFSETS } from "@src/utils/Neighborhood";
import { mix } from "@src/content/tree/breakage/Utils";
import type {
  TreeLogBreakGroup,
  TreeLogBreakGroupKind,
  TreeLogBreakagePlan,
  TreeLogBreakageResolution
} from "@src/content/tree/breakage/Plan";

export const TREE_LOG_BREAKAGE_MIN_IMPACT_SPEED = 1.75;

export function getTreeLogImpactDamage(
  plan: TreeLogBreakagePlan,
  mass: number,
  impactSpeed: number,
  localContactPoint: Vector3
): number {
  if (
    !plan.eligible
    || !Number.isFinite(impactSpeed)
    || impactSpeed < TREE_LOG_BREAKAGE_MIN_IMPACT_SPEED
    || !plan.anchorKey
  ) return 0;
  const anchor = parseKey(plan.anchorKey);
  const lever = Math.hypot(
    localContactPoint.x - anchor.x,
    localContactPoint.y - anchor.y,
    localContactPoint.z - anchor.z
  );
  const leverScale = 0.8 + 0.7 * Math.min(1, lever / plan.maximumLever);
  const massScale = Math.min(2.5, Math.max(1, Math.sqrt(Math.max(1, mass) / 128)));
  return impactSpeed * impactSpeed * leverScale * massScale;
}

export function pruneTreeLogBreakagePlan(
  plan: TreeLogBreakagePlan,
  remainingLogKeys: ReadonlySet<string>
): TreeLogBreakagePlan {
  if (!plan.anchorKey || !remainingLogKeys.has(plan.anchorKey)) return disabledPlan();
  const breakGroups = plan.breakGroups
    .map(group => ({
      ...group,
      keys: group.keys.filter(key => remainingLogKeys.has(key))
    }))
    .filter(group => group.keys.length > 0)
    .map((group, id): TreeLogBreakGroup => ({ ...group, id }));
  return {
    ...plan,
    breakGroups,
    eligible: breakGroups.length > 0,
    protectedKeys: new Set(
      [...plan.protectedKeys].filter(key => remainingLogKeys.has(key))
    )
  };
}

export function resolveTreeLogBreakage(
  plan: TreeLogBreakagePlan,
  remainingLogKeys: ReadonlySet<string>,
  availableDamage: number,
  generation: number,
  localContactPoint?: Vector3
): TreeLogBreakageResolution | undefined {
  if (!plan.eligible || !plan.anchorKey || !remainingLogKeys.has(plan.anchorKey)) return undefined;
  const group = selectBreakGroup(plan, remainingLogKeys, generation, localContactPoint);
  if (!group) return undefined;
  const activeKeys = group.keys.filter(key => remainingLogKeys.has(key));
  const cost = breakCost(group.kind, activeKeys.length);
  if (!Number.isFinite(availableDamage) || availableDamage < cost) return undefined;

  const removedKeys = new Set(activeKeys);
  const candidates = new Set(
    [...remainingLogKeys].filter(key => !removedKeys.has(key))
  );
  const connected = collectConnectedKeys(plan.anchorKey, candidates);
  for (const key of candidates) {
    if (!connected.has(key)) removedKeys.add(key);
  }
  for (const key of plan.protectedKeys) {
    if (removedKeys.has(key)) return undefined;
  }
  return { cost, groupId: group.id, removedKeys };
}

function selectBreakGroup(
  plan: TreeLogBreakagePlan,
  remainingLogKeys: ReadonlySet<string>,
  generation: number,
  localContactPoint?: Vector3
): TreeLogBreakGroup | undefined {
  const activeGroups = plan.breakGroups.filter(group =>
    group.keys.some(key => remainingLogKeys.has(key))
  );
  const branches = activeGroups.filter(group => group.kind === "branch");
  const random = mix(plan.seed, Math.max(1, Math.floor(generation)));
  if (branches.length > 0) return branches[random % branches.length];

  const crosscuts = activeGroups.filter(group => group.kind === "crosscut");
  if (crosscuts.length > 0) return selectCrosscutGroup(crosscuts, random, localContactPoint);

  const byBand = new Map<number, TreeLogBreakGroup[]>();
  for (const group of activeGroups) {
    if (group.kind !== "trunk" || group.bandId === undefined) continue;
    let groups = byBand.get(group.bandId);
    if (!groups) byBand.set(group.bandId, groups = []);
    groups.push(group);
  }
  const bands = [...byBand].sort(([left], [right]) => left - right);
  const activeBands = bands.filter(([, groups]) => groups.length === 1);
  const unopenedBands = bands.filter(([, groups]) => groups.length > 1);
  if (activeBands.length === 0) {
    const groups = unopenedBands[0]?.[1];
    return groups?.[random % groups.length];
  }
  if (activeBands.length >= 2 || unopenedBands.length === 0 || random % 3 !== 0) {
    const groups = activeBands[random % activeBands.length]![1];
    return groups[random % groups.length];
  }
  const groups = unopenedBands[0]![1];
  return groups[random % groups.length];
}

function selectCrosscutGroup(
  groups: readonly TreeLogBreakGroup[],
  random: number,
  localContactPoint?: Vector3
): TreeLogBreakGroup | undefined {
  const byBand = new Map<number, TreeLogBreakGroup[]>();
  for (const group of groups) {
    if (group.bandId === undefined) continue;
    let band = byBand.get(group.bandId);
    if (!band) byBand.set(group.bandId, band = []);
    band.push(group);
  }
  const bands = [...byBand].sort(([left], [right]) => left - right);
  const activeBands = bands.filter(([, band]) => band.length === 1);
  const candidates = activeBands.length > 0 ? activeBands : bands.filter(([, band]) => band.length > 1);
  if (candidates.length === 0) return undefined;

  let selected = candidates[0]!;
  if (localContactPoint && Number.isFinite(localContactPoint.y)) {
    let selectedDistance = crosscutDistance(selected[1], localContactPoint.y);
    for (let index = 1; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const distance = crosscutDistance(candidate[1], localContactPoint.y);
      if (distance < selectedDistance
        || (distance === selectedDistance && ((random + index) & 1) === 0)) {
        selected = candidate;
        selectedDistance = distance;
      }
    }
  }
  const selectedGroups = selected[1];
  return selectedGroups[random % selectedGroups.length];
}

function crosscutDistance(groups: readonly TreeLogBreakGroup[], contactY: number): number {
  let totalY = 0;
  let count = 0;
  for (const group of groups) {
    for (const key of group.keys) {
      totalY += parseKey(key).y;
      count++;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : Math.abs(contactY - totalY / count);
}

function breakCost(kind: TreeLogBreakGroupKind, keyCount: number): number {
  return kind === "branch"
    ? 6 + Math.min(4, Math.sqrt(keyCount))
    : 12 + Math.min(4, keyCount * 0.5);
}

export function collectConnectedKeys(anchorKey: string, candidates: ReadonlySet<string>): Set<string> {
  if (!candidates.has(anchorKey)) return new Set();
  const connected = new Set([anchorKey]);
  const queue = [anchorKey];
  for (let index = 0; index < queue.length; index++) {
    const location = parseKey(queue[index]!);
    for (const offset of NEIGHBOR_OFFSETS) {
      const key = coordinateKey({
        x: location.x + offset.x,
        y: location.y + offset.y,
        z: location.z + offset.z
      });
      if (!candidates.has(key) || connected.has(key)) continue;
      connected.add(key);
      queue.push(key);
    }
  }
  return connected;
}

function disabledPlan(): TreeLogBreakagePlan {
  return {
    breakGroups: [],
    eligible: false,
    maximumLever: 1,
    protectedKeys: new Set(),
    seed: 0
  };
}
