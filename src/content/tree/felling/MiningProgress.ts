import { PC_ATTACK_EQUIVALENT_TICKS } from "@src/content/tree/felling/MiningTime";

export const PLAYER_EDIT_MINING_RESET_TICKS = 10;

// Vanilla renders block breaking as ten destroy-overlay crack stages (0-9).
const MINING_STAGE_COUNT = 10;
const FINAL_MINING_STAGE = MINING_STAGE_COUNT - 1; // = 9
const COMPLETION_EPSILON = 1e-9;

interface SharedMiningProgress {
  lastProgressTick: number;
  progress: number;
}

interface TouchProgressSignal {
  key: string;
  tick: number;
}

export interface MiningProgressUpdate {
  completed: boolean;
  progress: number;
  stage: number;
  stageChanged: boolean;
}

export type MiningProgressInput =
  | { readonly type: "attack" }
  | { readonly playerId: string; readonly type: "touch" };

/**
 * Stores one shared mining state per contraption block. A player leaving the
 * target does not erase another player's progress; only the inactivity window
 * resets it.
 */
export class MiningProgress {
  readonly #lastTouchSignalByPlayer = new Map<string, TouchProgressSignal>();
  readonly #progress = new Map<string, SharedMiningProgress>();

  advance(
    key: string,
    currentTick: number,
    targetBreakTicks: number,
    input: MiningProgressInput
  ): MiningProgressUpdate | undefined {
    const normalizedTargetTicks = normalizeTargetBreakTicks(targetBreakTicks);
    let contributionTicks = PC_ATTACK_EQUIVALENT_TICKS;
    if (input.type === "touch") {
      const lastSignal = this.#lastTouchSignalByPlayer.get(input.playerId);
      if (lastSignal?.tick === currentTick) return undefined;
      // Touch mining signals arrive several ticks apart. Use the elapsed time
      // between continuous signals while coalescing all callbacks in one tick.
      contributionTicks = lastSignal
        && lastSignal.key === key
        && currentTick > lastSignal.tick
        && currentTick - lastSignal.tick <= PLAYER_EDIT_MINING_RESET_TICKS
        ? currentTick - lastSignal.tick
        : 0;
      this.#lastTouchSignalByPlayer.set(input.playerId, { key, tick: currentTick });
    }
    const previous = this.#progress.get(key);
    const state = previous
      && currentTick - previous.lastProgressTick <= PLAYER_EDIT_MINING_RESET_TICKS
      ? previous
      : { lastProgressTick: currentTick, progress: 0 };
    // -1 marks fresh or inactivity-reset progress so its first crack stage
    // always reports stageChanged.
    const previousStage = previous === state ? progressStage(state.progress) : -1;
    state.progress += contributionTicks / normalizedTargetTicks;
    state.lastProgressTick = currentTick;
    if (state.progress >= 1 - COMPLETION_EPSILON) {
      this.#progress.delete(key);
      return {
        completed: true,
        progress: 1,
        stage: FINAL_MINING_STAGE,
        stageChanged: previousStage !== FINAL_MINING_STAGE
      };
    }
    this.#progress.set(key, state);
    return toProgressUpdate(state, previousStage);
  }

  clearContraption(contraptionId: number): void {
    // Progress keys are built as `${contraptionId}|${targetKey}` by
    // contraption-outline-controller.ts; the prefix match relies on that format.
    const prefix = `${contraptionId}|`;
    for (const key of this.#progress.keys()) {
      if (key.startsWith(prefix)) this.#progress.delete(key);
    }
  }

  clearPlayer(playerId: string): void {
    this.#lastTouchSignalByPlayer.delete(playerId);
  }

  prune(currentTick: number): void {
    if (this.#progress.size === 0) return;
    for (const [key, state] of this.#progress) {
      if (currentTick - state.lastProgressTick > PLAYER_EDIT_MINING_RESET_TICKS) {
        this.#progress.delete(key);
      }
    }
  }
}

function normalizeTargetBreakTicks(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Tree-edit target break ticks must be a positive finite number.");
  }
  return value;
}

function toProgressUpdate(
  state: SharedMiningProgress,
  previousStage: number
): MiningProgressUpdate {
  const stage = progressStage(state.progress);
  return {
    completed: false,
    progress: state.progress,
    stage,
    stageChanged: stage !== previousStage
  };
}

function progressStage(progress: number): number {
  return Math.min(FINAL_MINING_STAGE, Math.floor(progress * MINING_STAGE_COUNT));
}
