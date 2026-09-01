import { world } from "@minecraft/server";

export const TREE_BREAK_SPEED_MIN = 0;
export const TREE_BREAK_SPEED_MAX = 10;
export const TREE_BREAK_SPEED_STEP = 0.25;
const TREE_BREAK_SPEED_DEFAULT = 1;
const TREE_COUNT_MOTION_TIME_DEFAULT = false;
const TREE_LOG_BREAKAGE_DEFAULT = true;
const TREE_PLAYER_CARRYING_DEFAULT = true;
const TREE_SMOOTH_PLAYER_CARRYING_DEFAULT = true;
export const TREE_PHYSICS_PERFORMANCE_LOW = 0;
export const TREE_PHYSICS_PERFORMANCE_HIGH = 1;
const TREE_PHYSICS_PERFORMANCE_DEFAULT = TREE_PHYSICS_PERFORMANCE_LOW;
export const TREE_OBB_COLLISION_LOW = 0;
export const TREE_OBB_COLLISION_HIGH = 1;
export const TREE_OBB_COLLISION_DISABLED = 2;
const TREE_OBB_COLLISION_DEFAULT = TREE_OBB_COLLISION_LOW;

// Persisted world dynamic-property keys, frozen by existing worlds. These
// literals are already in their final "treephysics:" form (unlike
// "treephysics:"-prefixed literals elsewhere, which only reach this prefix
// through the build-time rename), and the redundant inner "tree_" segment on
// the first three keys is likewise frozen by saved data.
const TREE_BREAK_SPEED_PROPERTY = "treephysics:tree_break_speed";
const TREE_COUNT_MOTION_TIME_PROPERTY = "treephysics:tree_count_motion_time";
const TREE_LOG_BREAKAGE_PROPERTY = "treephysics:tree_log_breakage";
const TREE_PLAYER_CARRYING_PROPERTY = "treephysics:player_carrying";
const TREE_SMOOTH_PLAYER_CARRYING_PROPERTY = "treephysics:smooth_player_carrying";
const TREE_PHYSICS_PERFORMANCE_PROPERTY = "treephysics:physics_performance";
const TREE_OBB_COLLISION_PROPERTY = "treephysics:obb_collision";

export type TreePhysicsPerformanceLevel =
  | typeof TREE_PHYSICS_PERFORMANCE_LOW
  | typeof TREE_PHYSICS_PERFORMANCE_HIGH;

export type TreeObbCollisionLevel =
  | typeof TREE_OBB_COLLISION_LOW
  | typeof TREE_OBB_COLLISION_HIGH
  | typeof TREE_OBB_COLLISION_DISABLED;

export interface TreePhysicsSettings {
  readonly breakSpeedMultiplier: number;
  readonly countMotionTime: boolean;
  readonly logBreakageEnabled: boolean;
  readonly obbCollisionLevel: TreeObbCollisionLevel;
  readonly playerCarryingEnabled: boolean;
  readonly physicsPerformanceLevel: TreePhysicsPerformanceLevel;
  readonly smoothPlayerCarryingEnabled: boolean;
}

let loaded = false;
let settings: TreePhysicsSettings = {
  breakSpeedMultiplier: TREE_BREAK_SPEED_DEFAULT,
  countMotionTime: TREE_COUNT_MOTION_TIME_DEFAULT,
  logBreakageEnabled: TREE_LOG_BREAKAGE_DEFAULT,
  obbCollisionLevel: TREE_OBB_COLLISION_DEFAULT,
  playerCarryingEnabled: TREE_PLAYER_CARRYING_DEFAULT,
  physicsPerformanceLevel: TREE_PHYSICS_PERFORMANCE_DEFAULT,
  smoothPlayerCarryingEnabled: TREE_SMOOTH_PLAYER_CARRYING_DEFAULT
};

export function getTreePhysicsSettings(): TreePhysicsSettings {
  loadTreePhysicsSettings();
  return settings;
}

export function getTreeBreakSpeedMultiplier(): number {
  return getTreePhysicsSettings().breakSpeedMultiplier;
}

export function shouldCountTreeMotionTime(): boolean {
  return getTreePhysicsSettings().countMotionTime;
}

export function shouldBreakTreeLogs(): boolean {
  return getTreePhysicsSettings().logBreakageEnabled;
}

export function getTreePhysicsPerformanceLevel(): TreePhysicsPerformanceLevel {
  return getTreePhysicsSettings().physicsPerformanceLevel;
}

export function getTreeObbCollisionLevel(): TreeObbCollisionLevel {
  return getTreePhysicsSettings().obbCollisionLevel;
}

export function shouldCarryPlayers(): boolean {
  return getTreePhysicsSettings().playerCarryingEnabled;
}

export function shouldUseSmoothPlayerCarrying(): boolean {
  return getTreePhysicsSettings().smoothPlayerCarryingEnabled;
}

export function updateTreePhysicsSettings(next: TreePhysicsSettings): void {
  settings = normalizeTreePhysicsSettings(next);
  loaded = true;
}

export function saveTreePhysicsSettings(next: TreePhysicsSettings): void {
  const normalized = normalizeTreePhysicsSettings(next);
  try {
    world.setDynamicProperty(TREE_BREAK_SPEED_PROPERTY, normalized.breakSpeedMultiplier);
    world.setDynamicProperty(TREE_COUNT_MOTION_TIME_PROPERTY, normalized.countMotionTime);
    world.setDynamicProperty(TREE_LOG_BREAKAGE_PROPERTY, normalized.logBreakageEnabled);
    world.setDynamicProperty(TREE_OBB_COLLISION_PROPERTY, normalized.obbCollisionLevel);
    world.setDynamicProperty(TREE_PLAYER_CARRYING_PROPERTY, normalized.playerCarryingEnabled);
    world.setDynamicProperty(
      TREE_PHYSICS_PERFORMANCE_PROPERTY,
      normalized.physicsPerformanceLevel
    );
    world.setDynamicProperty(
      TREE_SMOOTH_PLAYER_CARRYING_PROPERTY,
      normalized.smoothPlayerCarryingEnabled
    );
    settings = normalized;
    loaded = true;
  } catch {
    // Keep the previous runtime settings if dynamic properties are unavailable.
  }
}

function loadTreePhysicsSettings(): void {
  if (loaded) return;
  try {
    const next: TreePhysicsSettings = {
      breakSpeedMultiplier: normalizeBreakSpeed(
        world.getDynamicProperty(TREE_BREAK_SPEED_PROPERTY)
      ),
      countMotionTime: world.getDynamicProperty(TREE_COUNT_MOTION_TIME_PROPERTY) === true,
      logBreakageEnabled: normalizeBoolean(
        world.getDynamicProperty(TREE_LOG_BREAKAGE_PROPERTY),
        TREE_LOG_BREAKAGE_DEFAULT
      ),
      obbCollisionLevel: normalizeObbCollisionLevel(
        world.getDynamicProperty(TREE_OBB_COLLISION_PROPERTY)
      ),
      playerCarryingEnabled: normalizeBoolean(
        world.getDynamicProperty(TREE_PLAYER_CARRYING_PROPERTY),
        TREE_PLAYER_CARRYING_DEFAULT
      ),
      physicsPerformanceLevel: normalizePhysicsPerformanceLevel(
        world.getDynamicProperty(TREE_PHYSICS_PERFORMANCE_PROPERTY)
      ),
      smoothPlayerCarryingEnabled: normalizeBoolean(
        world.getDynamicProperty(TREE_SMOOTH_PLAYER_CARRYING_PROPERTY),
        TREE_SMOOTH_PLAYER_CARRYING_DEFAULT
      )
    };
    settings = next;
    loaded = true;
  } catch {
    // Dynamic properties are unavailable during early execution. The next tick retries.
  }
}

function normalizeBreakSpeed(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : TREE_BREAK_SPEED_DEFAULT;
  const stepped = Math.round(numeric / TREE_BREAK_SPEED_STEP) * TREE_BREAK_SPEED_STEP;
  return Math.min(
    TREE_BREAK_SPEED_MAX,
    Math.max(TREE_BREAK_SPEED_MIN, Number(stepped.toFixed(2)))
  );
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizePhysicsPerformanceLevel(value: unknown): TreePhysicsPerformanceLevel {
  return value === TREE_PHYSICS_PERFORMANCE_HIGH
    ? TREE_PHYSICS_PERFORMANCE_HIGH
    : TREE_PHYSICS_PERFORMANCE_DEFAULT;
}

export function normalizeObbCollisionLevel(value: unknown): TreeObbCollisionLevel {
  if (value === TREE_OBB_COLLISION_DISABLED) return TREE_OBB_COLLISION_DISABLED;
  return value === TREE_OBB_COLLISION_HIGH
    ? TREE_OBB_COLLISION_HIGH
    : TREE_OBB_COLLISION_DEFAULT;
}

function normalizeTreePhysicsSettings(next: TreePhysicsSettings): TreePhysicsSettings {
  return {
    breakSpeedMultiplier: normalizeBreakSpeed(next.breakSpeedMultiplier),
    countMotionTime: next.countMotionTime === true,
    logBreakageEnabled: next.logBreakageEnabled === true,
    obbCollisionLevel: normalizeObbCollisionLevel(next.obbCollisionLevel),
    playerCarryingEnabled: next.playerCarryingEnabled === true,
    physicsPerformanceLevel: normalizePhysicsPerformanceLevel(next.physicsPerformanceLevel),
    smoothPlayerCarryingEnabled: next.smoothPlayerCarryingEnabled === true
  };
}
