import { DEFAULT_OBB_SETTINGS } from "../Types";
import type { ObbSupportPreset, ObbSupportPresetCatalog } from "../Types";

/**
 * Collision-box variants implemented by every standard OBB support entity.
 * The event protocol is entity-ID agnostic so integrations can supply their
 * own support entity without rebuilding the collision layout. The dense
 * 1..16 matrix lets geometry choose exact integer fine-grid rectangles.
 */
export const DEFAULT_OBB_SUPPORT_PRESET_CATALOG: ObbSupportPresetCatalog = Object.freeze({
  presets: Object.freeze([
    ...createIntegerRange(1, 16).map(createHorizontalPreset),
    ...createIntegerRange(2, 16).map(createVerticalPreset),
    ...createIntegerRange(2, 16).flatMap(horizontalCells => (
      createIntegerRange(2, 16).map(verticalCells => (
        createCombinedPreset(horizontalCells, verticalCells)
      ))
    )),
    ...createIntegerRange(1, 100)
      .filter(heightSteps => heightSteps % 25 !== 0)
      .map(heightSteps => createVolumeHeightPreset(1, heightSteps))
  ]),
  // Compression may hide at most one collision-height quantization step.
  surfaceHeightTolerance: DEFAULT_OBB_SETTINGS.heightStep
});

function createIntegerRange(minimum: number, maximum: number): number[] {
  return Array.from(
    { length: maximum - minimum + 1 },
    (_, index) => minimum + index
  );
}

function createHorizontalPreset(horizontalCells: number): Readonly<ObbSupportPreset> {
  const id = `w${horizontalCells}_h1`;
  return Object.freeze({
    event: horizontalCells === 1 ? undefined : `obb:support_${id}`,
    height: DEFAULT_OBB_SETTINGS.supportHeight,
    horizontalCells,
    id,
    removeEvent: horizontalCells === 1 ? undefined : `obb:clear_${id}`,
    verticalCells: 1,
    width: DEFAULT_OBB_SETTINGS.supportWidth
      + (horizontalCells - 1) * DEFAULT_OBB_SETTINGS.spacing.forward
  });
}

function createVerticalPreset(verticalCells: number): Readonly<ObbSupportPreset> {
  const id = `w1_h${verticalCells}`;
  return Object.freeze({
    event: `obb:support_${id}`,
    height: verticalCells * DEFAULT_OBB_SETTINGS.supportHeight,
    horizontalCells: 1,
    id,
    removeEvent: `obb:clear_${id}`,
    verticalCells,
    width: DEFAULT_OBB_SETTINGS.supportWidth
  });
}

function createCombinedPreset(
  horizontalCells: number,
  verticalCells: number
): Readonly<ObbSupportPreset> {
  const id = `w${horizontalCells}_h${verticalCells}`;
  return Object.freeze({
    event: `obb:support_${id}`,
    height: verticalCells * DEFAULT_OBB_SETTINGS.supportHeight,
    horizontalCells,
    id,
    removeEvent: `obb:clear_${id}`,
    verticalCells,
    width: DEFAULT_OBB_SETTINGS.supportWidth
      + (horizontalCells - 1) * DEFAULT_OBB_SETTINGS.spacing.forward
  });
}

/** Fine vertical spans prevent one solid column from requiring two entities. */
function createVolumeHeightPreset(
  horizontalCells: number,
  volumeHeightSteps: number
): Readonly<ObbSupportPreset> {
  const id = `v_w${horizontalCells}_q${volumeHeightSteps}`;
  return Object.freeze({
    event: `obb:volume_w${horizontalCells}_q${volumeHeightSteps}`,
    height: volumeHeightSteps * DEFAULT_OBB_SETTINGS.heightStep,
    horizontalCells,
    id,
    removeEvent: `obb:clear_${id}`,
    verticalCells: 1,
    volumeHeightSteps,
    width: DEFAULT_OBB_SETTINGS.supportWidth
      + (horizontalCells - 1) * DEFAULT_OBB_SETTINGS.spacing.forward
  });
}
