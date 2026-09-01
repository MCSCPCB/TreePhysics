// Immutable support-preset lookup tables built once per shared preset
// catalog, plus the preset-selection helpers used by patch compression.
import type { ObbSupportPreset, ObbSupportPresetCatalog } from "../Types";
import { GEOMETRY_EPSILON } from "./PoseFrame";

export interface PreparedSupportPresets {
  readonly basePreset: ObbSupportPreset | undefined;
  readonly horizontalPresets: readonly ObbSupportPreset[];
  readonly maximumHorizontalPatchCells: number;
  readonly maximumVerticalPatchCells: number;
  readonly maximumVolumeHeightSteps: number;
  /** Widest-first selection of the 1-cell volume preset per height count. */
  readonly singleCellVolumePresetByHeightStep: ReadonlyMap<
    number,
    ObbSupportPreset
  >;
  readonly volumePresetsByHeightStep: ReadonlyMap<
    number,
    readonly ObbSupportPreset[]
  >;
  readonly verticalPatchPresetsByHeight: ReadonlyMap<
    number,
    readonly ObbSupportPreset[]
  >;
}

const PREPARED_SUPPORT_PRESETS = new WeakMap<
  ObbSupportPresetCatalog,
  Map<number, PreparedSupportPresets>
>();
export const EMPTY_PREPARED_SUPPORT_PRESETS: PreparedSupportPresets = Object.freeze({
  basePreset: undefined,
  horizontalPresets: Object.freeze([]),
  maximumHorizontalPatchCells: 0,
  maximumVerticalPatchCells: 0,
  maximumVolumeHeightSteps: 0,
  singleCellVolumePresetByHeightStep: new Map(),
  volumePresetsByHeightStep: new Map(),
  verticalPatchPresetsByHeight: new Map()
});

/** Builds immutable lookup tables once for every shared preset catalog. */
export function getPreparedSupportPresets(
  catalog: ObbSupportPresetCatalog,
  heightStep: number
): PreparedSupportPresets {
  const preparedByHeightStep = PREPARED_SUPPORT_PRESETS.get(catalog);
  const cached = preparedByHeightStep?.get(heightStep);
  if (cached) return cached;

  const regularPresets = catalog.presets.filter(
    preset => preset.volumeHeightSteps === undefined
  );
  const horizontalPresets = Object.freeze(
    regularPresets
      .filter(preset => preset.verticalCells === 1)
      .sort((left, right) => right.horizontalCells - left.horizontalCells)
  );
  const verticalPresets = new Map<number, ObbSupportPreset[]>();
  let maximumHorizontalPatchCells = 0;
  let maximumVerticalPatchCells = 0;
  for (const preset of regularPresets) {
    const presets = verticalPresets.get(preset.verticalCells) ?? [];
    presets.push(preset);
    verticalPresets.set(preset.verticalCells, presets);
    maximumHorizontalPatchCells = Math.max(
      maximumHorizontalPatchCells,
      preset.horizontalCells
    );
    maximumVerticalPatchCells = Math.max(
      maximumVerticalPatchCells,
      preset.verticalCells
    );
  }
  const verticalPatchPresetsByHeight = new Map(
    [...verticalPresets].map(([verticalCells, presets]) => [
      verticalCells,
      Object.freeze(presets.sort(
        (left, right) => right.horizontalCells - left.horizontalCells
      ))
    ])
  );

  const volumePresets = new Map<number, ObbSupportPreset[]>();
  let maximumVolumeHeightSteps = 0;
  for (const preset of catalog.presets) {
    const exactHeightSteps = preset.volumeHeightSteps
      ?? preset.height / heightStep;
    const heightSteps = Math.round(exactHeightSteps);
    if (Math.abs(exactHeightSteps - heightSteps) > GEOMETRY_EPSILON) continue;
    const presets = volumePresets.get(heightSteps) ?? [];
    presets.push(preset);
    volumePresets.set(heightSteps, presets);
    maximumVolumeHeightSteps = Math.max(maximumVolumeHeightSteps, heightSteps);
  }
  const volumePresetsByHeightStep = new Map(
    [...volumePresets].map(([heightSteps, presets]) => [
      heightSteps,
      Object.freeze(presets.sort(
        (left, right) => right.horizontalCells - left.horizontalCells
      ))
    ])
  );
  // Volume columns only ever consume the 1-cell preset of each height count;
  // resolving that descending-sorted find once here keeps the per-segment
  // lookup selection identical while avoiding a scan per placed segment.
  const singleCellVolumePresetByHeightStep = new Map<number, ObbSupportPreset>();
  for (const [heightSteps, presets] of volumePresetsByHeightStep) {
    const preset = presets.find(candidate => candidate.horizontalCells === 1);
    if (preset) singleCellVolumePresetByHeightStep.set(heightSteps, preset);
  }
  const prepared: PreparedSupportPresets = Object.freeze({
    basePreset: regularPresets.find(
      preset => preset.horizontalCells === 1 && preset.verticalCells === 1
    ),
    horizontalPresets,
    maximumHorizontalPatchCells,
    maximumVerticalPatchCells,
    maximumVolumeHeightSteps,
    singleCellVolumePresetByHeightStep,
    volumePresetsByHeightStep,
    verticalPatchPresetsByHeight
  });
  const nextPreparedByHeightStep = preparedByHeightStep ?? new Map();
  nextPreparedByHeightStep.set(heightStep, prepared);
  if (!preparedByHeightStep) {
    PREPARED_SUPPORT_PRESETS.set(catalog, nextPreparedByHeightStep);
  }
  return prepared;
}

/** Finds the widest descending preset that fits an available face patch. */
export function findMaximumCoveredHorizontalPreset(
  presets: readonly ObbSupportPreset[],
  availableCells: number
): ObbSupportPreset | undefined {
  let lower = 0;
  let upper = presets.length - 1;
  let match: ObbSupportPreset | undefined;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = presets[middle]!;
    if (candidate.horizontalCells <= availableCells) {
      match = candidate;
      upper = middle - 1;
    } else {
      lower = middle + 1;
    }
  }
  return match;
}

/** Prefers area, then vertical span, for deterministic exact patch covering. */
export function isLargerVerticalPatch(
  candidate: ObbSupportPreset,
  current: ObbSupportPreset
): boolean {
  const candidateArea = candidate.horizontalCells * candidate.verticalCells;
  const currentArea = current.horizontalCells * current.verticalCells;
  return candidateArea > currentArea
    || (candidateArea === currentArea
      && candidate.verticalCells > current.verticalCells)
    || (candidateArea === currentArea
      && candidate.verticalCells === current.verticalCells
      && candidate.horizontalCells > current.horizontalCells);
}
