import {
  CommandPermissionLevel,
  system,
  type Player
} from "@minecraft/server";
import {
  CustomForm,
  DataDrivenScreenClosedReason,
  type DropdownItemData,
  ObservableBoolean,
  ObservableNumber
} from "@minecraft/server-ui";
import {
  getTreePhysicsSettings,
  normalizeObbCollisionLevel,
  normalizePhysicsPerformanceLevel,
  saveTreePhysicsSettings,
  TREE_BREAK_SPEED_MAX,
  TREE_BREAK_SPEED_MIN,
  TREE_BREAK_SPEED_STEP,
  TREE_OBB_COLLISION_DISABLED,
  TREE_OBB_COLLISION_HIGH,
  TREE_OBB_COLLISION_LOW,
  TREE_PHYSICS_PERFORMANCE_HIGH,
  TREE_PHYSICS_PERFORMANCE_LOW,
  type TreePhysicsSettings,
  updateTreePhysicsSettings
} from "@src/config/Settings";

const FORM_OPEN_DELAY_TICKS = 1;
const FORM_RETRY_DELAY_TICKS = 2;
const FORM_MAX_BUSY_RETRIES = 10;
const BREAK_SPEED_SAVE_DEBOUNCE_TICKS = 4;

const PHYSICS_PERFORMANCE_OPTIONS: DropdownItemData[] = [
  {
    label: { translate: "ui.treephysics.settings.physics_performance.low" },
    value: TREE_PHYSICS_PERFORMANCE_LOW
  },
  {
    label: { translate: "ui.treephysics.settings.physics_performance.high" },
    value: TREE_PHYSICS_PERFORMANCE_HIGH
  }
];

const OBB_COLLISION_OPTIONS: DropdownItemData[] = [
  {
    label: { translate: "ui.treephysics.settings.obb_collision.disabled" },
    value: TREE_OBB_COLLISION_DISABLED
  },
  {
    label: { translate: "ui.treephysics.settings.obb_collision.low" },
    value: TREE_OBB_COLLISION_LOW
  },
  {
    label: { translate: "ui.treephysics.settings.obb_collision.high" },
    value: TREE_OBB_COLLISION_HIGH
  }
];

const pendingPlayers = new Set<string>();

export function queueTreeSettingsForm(player: Player): void {
  if (pendingPlayers.has(player.id)) return;
  pendingPlayers.add(player.id);
  system.runTimeout(() => void showTreeSettingsForm(player, 0), FORM_OPEN_DELAY_TICKS);
}

function canEditTreePhysicsSettings(player: Player): boolean {
  try {
    return player.commandPermissionLevel >= CommandPermissionLevel.Admin;
  } catch {
    return false;
  }
}

async function showTreeSettingsForm(player: Player, busyRetry: number): Promise<void> {
  if (!player.isValid) {
    pendingPlayers.delete(player.id);
    return;
  }

  let pendingSaveRunId: number | undefined;
  // Unsubscribe callbacks collected in subscribe order; the finally block
  // replays them so every registered subscription is released even when the
  // form throws.
  const subscriptionCleanups: Array<() => void> = [];

  const cancelPendingSave = (): void => {
    if (pendingSaveRunId === undefined) return;
    system.clearRun(pendingSaveRunId);
    pendingSaveRunId = undefined;
  };

  try {
    const current = getTreePhysicsSettings();
    const canEdit = canEditTreePhysicsSettings(player);
    const breakSpeedMultiplier = new ObservableNumber(current.breakSpeedMultiplier, {
      clientWritable: true
    });
    const countMotionTime = new ObservableBoolean(current.countMotionTime, {
      clientWritable: true
    });
    const logBreakageEnabled = new ObservableBoolean(current.logBreakageEnabled, {
      clientWritable: true
    });
    const playerCarryingEnabled = new ObservableBoolean(current.playerCarryingEnabled, {
      clientWritable: true
    });
    const smoothPlayerCarryingEnabled = new ObservableBoolean(
      current.smoothPlayerCarryingEnabled,
      { clientWritable: true }
    );
    const playerCarryingDisabled = new ObservableBoolean(
      !canEdit || current.obbCollisionLevel === TREE_OBB_COLLISION_DISABLED
    );
    const smoothPlayerCarryingDisabled = new ObservableBoolean(
      !canEdit
        || current.obbCollisionLevel === TREE_OBB_COLLISION_DISABLED
        || !current.playerCarryingEnabled
    );
    const physicsPerformanceLevel = new ObservableNumber(current.physicsPerformanceLevel, {
      clientWritable: true
    });
    const obbCollisionLevel = new ObservableNumber(current.obbCollisionLevel, {
      clientWritable: true
    });

    const readFormSettings = (): TreePhysicsSettings => ({
      breakSpeedMultiplier: breakSpeedMultiplier.getData(),
      countMotionTime: countMotionTime.getData(),
      logBreakageEnabled: logBreakageEnabled.getData(),
      obbCollisionLevel: normalizeObbCollisionLevel(obbCollisionLevel.getData()),
      playerCarryingEnabled: playerCarryingEnabled.getData(),
      physicsPerformanceLevel: normalizePhysicsPerformanceLevel(
        physicsPerformanceLevel.getData()
      ),
      smoothPlayerCarryingEnabled: smoothPlayerCarryingEnabled.getData()
    });
    const applyFormSettings = (persist: boolean): void => {
      if (!canEditTreePhysicsSettings(player)) return;
      const next = readFormSettings();
      updateTreePhysicsSettings(next);
      if (persist) saveTreePhysicsSettings(next);
    };
    const persistFormSettings = (): void => {
      cancelPendingSave();
      applyFormSettings(true);
    };
    if (canEdit) {
      const updateCollisionSettingAvailability = (): void => {
        const collisionDisabled = obbCollisionLevel.getData() === TREE_OBB_COLLISION_DISABLED;
        playerCarryingDisabled.setData(collisionDisabled);
        smoothPlayerCarryingDisabled.setData(
          collisionDisabled || !playerCarryingEnabled.getData()
        );
      };
      // Slider drags emit a burst of intermediate values: each one updates the
      // runtime settings immediately, while the dynamic-property write is
      // debounced until the slider has been quiet for a few ticks.
      const breakSpeedSubscription = breakSpeedMultiplier.subscribe(() => {
        applyFormSettings(false);
        cancelPendingSave();
        pendingSaveRunId = system.runTimeout(() => {
          pendingSaveRunId = undefined;
          applyFormSettings(true);
        }, BREAK_SPEED_SAVE_DEBOUNCE_TICKS);
      });
      subscriptionCleanups.push(
        () => breakSpeedMultiplier.unsubscribe(breakSpeedSubscription)
      );
      const countMotionSubscription = countMotionTime.subscribe(persistFormSettings);
      subscriptionCleanups.push(() => countMotionTime.unsubscribe(countMotionSubscription));
      const logBreakageSubscription = logBreakageEnabled.subscribe(persistFormSettings);
      subscriptionCleanups.push(
        () => logBreakageEnabled.unsubscribe(logBreakageSubscription)
      );
      const playerCarryingSubscription = playerCarryingEnabled.subscribe(() => {
        updateCollisionSettingAvailability();
        persistFormSettings();
      });
      subscriptionCleanups.push(
        () => playerCarryingEnabled.unsubscribe(playerCarryingSubscription)
      );
      const smoothPlayerCarryingSubscription =
        smoothPlayerCarryingEnabled.subscribe(persistFormSettings);
      subscriptionCleanups.push(
        () => smoothPlayerCarryingEnabled.unsubscribe(smoothPlayerCarryingSubscription)
      );
      const physicsPerformanceSubscription =
        physicsPerformanceLevel.subscribe(persistFormSettings);
      subscriptionCleanups.push(
        () => physicsPerformanceLevel.unsubscribe(physicsPerformanceSubscription)
      );
      const obbCollisionSubscription = obbCollisionLevel.subscribe(() => {
        updateCollisionSettingAvailability();
        persistFormSettings();
      });
      subscriptionCleanups.push(
        () => obbCollisionLevel.unsubscribe(obbCollisionSubscription)
      );
    }

    // Keep the explanatory text in the normal label flow. Header controls have a
    // fixed layout height on some Bedrock clients and can overlap the first slider.
    const form = new CustomForm(player, { translate: "ui.treephysics.settings.title" });
    form
      .label({ translate: "ui.treephysics.settings.header" })
      .spacer()
      .dropdown(
        { translate: "ui.treephysics.settings.physics_performance" },
        physicsPerformanceLevel,
        PHYSICS_PERFORMANCE_OPTIONS,
        {
          disabled: !canEdit,
          description: {
            translate: "ui.treephysics.settings.physics_performance.description"
          }
        }
      )
      .dropdown(
        { translate: "ui.treephysics.settings.obb_collision" },
        obbCollisionLevel,
        OBB_COLLISION_OPTIONS,
        {
          disabled: !canEdit,
          description: {
            translate: "ui.treephysics.settings.obb_collision.description"
          }
        }
      )
      .slider(
        { translate: "ui.treephysics.settings.break_speed" },
        breakSpeedMultiplier,
        TREE_BREAK_SPEED_MIN,
        TREE_BREAK_SPEED_MAX,
        {
          step: TREE_BREAK_SPEED_STEP,
          disabled: !canEdit,
          description: { translate: "ui.treephysics.settings.break_speed.description" }
        }
      )
      .toggle(
        { translate: "ui.treephysics.settings.log_breakage" },
        logBreakageEnabled,
        {
          disabled: !canEdit,
          description: { translate: "ui.treephysics.settings.log_breakage.description" }
        }
      )
      .toggle(
        { translate: "ui.treephysics.settings.count_motion_time" },
        countMotionTime,
        {
          disabled: !canEdit,
          description: { translate: "ui.treephysics.settings.count_motion_time.description" }
        }
      )
      .toggle(
        { translate: "ui.treephysics.settings.player_carrying" },
        playerCarryingEnabled,
        {
          disabled: playerCarryingDisabled,
          description: { translate: "ui.treephysics.settings.player_carrying.description" }
        }
      )
      .toggle(
        { translate: "ui.treephysics.settings.smooth_player_carrying" },
        smoothPlayerCarryingEnabled,
        {
          disabled: smoothPlayerCarryingDisabled,
          description: {
            translate: "ui.treephysics.settings.smooth_player_carrying.description"
          }
        }
      );

    const reason = await form.show();
    if (reason === DataDrivenScreenClosedReason.UserBusy) {
      // UserBusy means another screen still owns the display (for example the
      // chat screen the command was typed into is still closing), so re-queue
      // the form instead of dropping the request.
      if (busyRetry < FORM_MAX_BUSY_RETRIES) {
        system.runTimeout(
          () => void showTreeSettingsForm(player, busyRetry + 1),
          FORM_RETRY_DELAY_TICKS
        );
        return;
      }
    } else if (canEdit) persistFormSettings();
  } catch {
    // A closed or unavailable form must not affect gameplay.
  } finally {
    cancelPendingSave();
    for (const cleanup of subscriptionCleanups) cleanup();
  }

  pendingPlayers.delete(player.id);
}
