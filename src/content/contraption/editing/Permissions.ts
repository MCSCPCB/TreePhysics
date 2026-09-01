import {
  GameMode,
  type Container,
  type ItemStack,
  type Player
} from "@minecraft/server";

export function canBreakContraptionBlock(gameMode: GameMode, blockTypeId: string, itemIsSword: boolean, adventureCanDestroy: readonly string[]): boolean {
  if (gameMode === GameMode.Spectator) return false;
  if (gameMode === GameMode.Adventure) return blockListContains(adventureCanDestroy, blockTypeId);
  // Vanilla swords can mine in Survival, but deliberately cannot destroy blocks in Creative.
  return gameMode !== GameMode.Creative || !itemIsSword;
}

export function canPlaceContraptionBlock(gameMode: GameMode, supportBlockTypeId: string, adventureCanPlaceOn: readonly string[]): boolean {
  if (gameMode === GameMode.Spectator) return false;
  return gameMode !== GameMode.Adventure || blockListContains(adventureCanPlaceOn, supportBlockTypeId);
}

export type ContraptionToolDamageResult = "broken" | "damaged" | "unchanged";

/** Applies one vanilla durability use after a player edit has committed successfully. */
export function damageSelectedToolForContraptionBreak(player: Player, usedItem: ItemStack | undefined, random: () => number = Math.random): ContraptionToolDamageResult {
  if (!usedItem || player.getGameMode() === GameMode.Creative) return "unchanged";
  const container = requirePlayerContainer(player, " for tool durability");
  const selectedSlot = player.selectedSlotIndex;
  const selectedItem = container.getItem(selectedSlot);
  if (!selectedItem || selectedItem.typeId !== usedItem.typeId) {
    throw new Error(`Player ${player.id}'s selected item changed before durability was applied.`);
  }
  const durability = selectedItem.getComponent("minecraft:durability");
  if (!durability || durability.unbreakable) return "unchanged";
  const unbreakingLevel = selectedItem.getComponent("minecraft:enchantable")?.getEnchantment("minecraft:unbreaking")?.level ?? 0;
  if (random() * 100 >= durability.getDamageChance(unbreakingLevel)) return "unchanged";
  if (durability.damage + 1 >= durability.maxDurability) {
    container.setItem(selectedSlot, undefined);
    player.playSound("random.break", { pitch: 0.9, volume: 1 });
    return "broken";
  }
  durability.damage += 1;
  container.setItem(selectedSlot, selectedItem);
  return "damaged";
}

export function canPlayerBreakContraptionBlock(player: Player, itemStack: ItemStack | undefined, blockTypeId: string): boolean {
  return canBreakContraptionBlock(player.getGameMode(), blockTypeId, itemStack?.hasTag("minecraft:is_sword") === true, itemStack?.getCanDestroy() ?? []);
}

export function canPlayerPlaceContraptionBlock(player: Player, itemStack: ItemStack, supportBlockTypeId: string): boolean {
  return canPlaceContraptionBlock(player.getGameMode(), supportBlockTypeId, itemStack.getCanPlaceOn());
}

function blockListContains(blocks: readonly string[], blockTypeId: string): boolean {
  const normalizedTarget = withMinecraftNamespace(blockTypeId);
  return blocks.some(value => withMinecraftNamespace(value) === normalizedTarget);
}

function withMinecraftNamespace(typeId: string): string {
  return typeId.includes(":") ? typeId : `minecraft:${typeId}`;
}

function requirePlayerContainer(player: Player, purpose = ""): Container {
  const container = player.getComponent("minecraft:inventory")?.container;
  if (!container) throw new Error(`Player ${player.id} has no inventory container${purpose}.`);
  return container;
}
