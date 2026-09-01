import type { ItemStack, Vector3 } from "@minecraft/server";

export interface PendingItemDrop {
  readonly item: ItemStack;
  readonly location: Vector3;
  readonly operationTag?: string;
}

interface ItemDropGroup {
  readonly drops: PendingItemDrop[];
  readonly exemplar: ItemStack;
  readonly maximumAmount: number;
  totalAmount: number;
}

export function mergeStackableItemDrops(
  drops: readonly PendingItemDrop[]
): PendingItemDrop[] {
  // Bucket candidate groups by item type before the native isStackableWith
  // comparison; a flat group scan made merging quadratic in native calls.
  // Group creation order still follows first appearance, so output order is
  // unchanged.
  const groups: ItemDropGroup[] = [];
  const groupsByTypeId = new Map<string, ItemDropGroup[]>();
  for (const drop of drops) {
    const candidates = groupsByTypeId.get(drop.item.typeId);
    const group = candidates?.find(candidate => canMergeItemStacks(candidate.exemplar, drop.item));
    if (group) {
      group.drops.push(drop);
      group.totalAmount += itemAmount(drop.item);
      continue;
    }
    const created: ItemDropGroup = {
      drops: [drop],
      exemplar: drop.item,
      maximumAmount: itemMaximumAmount(drop.item),
      totalAmount: itemAmount(drop.item)
    };
    groups.push(created);
    if (candidates) candidates.push(created);
    else groupsByTypeId.set(drop.item.typeId, [created]);
  }

  const merged: PendingItemDrop[] = [];
  for (const group of groups) {
    if (group.drops.length === 1) {
      merged.push(group.drops[0]!);
      continue;
    }
    const stackCount = Math.ceil(group.totalAmount / group.maximumAmount);
    const equalAmount = Math.floor(group.totalAmount / stackCount);
    const remainder = group.totalAmount % stackCount;
    for (let index = 0; index < stackCount; index++) {
      merged.push({
        item: cloneItemStackWithAmount(
          group.exemplar,
          equalAmount + Number(index < remainder)
        ),
        location: selectMergedDropLocation(
          group.drops,
          (index + 0.5) / stackCount,
          group.totalAmount
        )
      });
    }
  }
  return merged;
}

export function totalItemAmount(drops: readonly PendingItemDrop[]): number {
  let total = 0;
  for (const drop of drops) total += itemAmount(drop.item);
  return total;
}

function canMergeItemStacks(left: ItemStack, right: ItemStack): boolean {
  return isMergeableItemStack(left)
    && isMergeableItemStack(right)
    && left.isStackableWith(right);
}

function isMergeableItemStack(item: ItemStack): boolean {
  return item.isStackable && item.maxAmount > 1;
}

function cloneItemStackWithAmount(item: ItemStack, amount: number): ItemStack {
  const cloned = item.clone();
  cloned.amount = amount;
  return cloned;
}

function itemAmount(item: ItemStack): number {
  return Math.max(1, Math.floor(item.amount));
}

function itemMaximumAmount(item: ItemStack): number {
  return Math.max(1, Math.floor(item.maxAmount));
}

function selectMergedDropLocation(
  drops: readonly PendingItemDrop[],
  fraction: number,
  totalAmount: number
): Vector3 {
  const target = fraction * totalAmount;
  let cumulative = 0;
  for (const drop of drops) {
    cumulative += itemAmount(drop.item);
    if (cumulative >= target) return drop.location;
  }
  return drops[drops.length - 1]!.location;
}
