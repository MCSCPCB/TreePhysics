import {
  CommandPermissionLevel,
  CustomCommandStatus,
  system,
  type Player
} from "@minecraft/server";
import { queueTreeSettingsForm } from "@src/ui/SettingsForm";

const TREE_SETTINGS_COMMAND = "treephysics:settings";

let installed = false;

export function installTreeSettings(): void {
  if (installed) return;
  installed = true;
  system.beforeEvents.startup.subscribe(event => {
    event.customCommandRegistry.registerCommand({
      name: TREE_SETTINGS_COMMAND,
      description: "ui.treephysics.settings.command.description",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false
    }, origin => {
      const source = origin.sourceEntity;
      if (source?.typeId !== "minecraft:player") {
        return { status: CustomCommandStatus.Failure };
      }
      queueTreeSettingsForm(source as Player);
      return { status: CustomCommandStatus.Success };
    });
  });
}
