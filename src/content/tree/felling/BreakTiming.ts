import {
  getTreeBreakSpeedMultiplier,
  TREE_BREAK_SPEED_MAX
} from "@src/config/Settings";

export interface TreeBreakTiming {
  readonly sleepTicksPerLog: number;
  readonly sleepTimeoutTicks: number;
}

function scaleTreeBreakTicks(ticks: number): number {
  const baseTicks = Number.isFinite(ticks) ? Math.max(1, Math.floor(ticks)) : 1;
  const speed = getTreeBreakSpeedMultiplier();
  // Zero pauses the runtime timer; retain a finite 1x duration so it can resume safely.
  return speed === 0 ? baseTicks : Math.max(1, Math.round(baseTicks / speed));
}

export function getTreeBreakTiming(logCount: number, ticksPerLog: number): TreeBreakTiming {
  const normalizedLogCount = Number.isFinite(logCount)
    ? Math.max(1, Math.floor(logCount))
    : 1;
  if (getTreeBreakSpeedMultiplier() >= TREE_BREAK_SPEED_MAX) {
    return { sleepTicksPerLog: 1, sleepTimeoutTicks: 1 };
  }
  const scaledTicksPerLog = scaleTreeBreakTicks(ticksPerLog);
  return {
    sleepTicksPerLog: scaledTicksPerLog,
    sleepTimeoutTicks: normalizedLogCount * scaledTicksPerLog
  };
}
