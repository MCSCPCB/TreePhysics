import { EPSILON_1E6 } from "@src/utils/Vector3Math";
import { assertFrictionSettings } from "./Motion";
import {
  DEFAULT_OBB_SETTINGS,
  type ObbSettings,
  type ObbSupportPresetCatalog
} from "../Types";

const RESOLVED_PRESET_CATALOGS = new WeakMap<ObbSupportPresetCatalog, Map<string, ObbSupportPresetCatalog>>();

export function resolveSettings(overrides: Partial<ObbSettings> | undefined): ObbSettings {
  const settings: ObbSettings = {
    collisionActivationBucketSize: overrides?.collisionActivationBucketSize ?? DEFAULT_OBB_SETTINGS.collisionActivationBucketSize,
    collisionQueryMargin: overrides?.collisionQueryMargin ?? DEFAULT_OBB_SETTINGS.collisionQueryMargin,
    collisionRegionRetentionTicks: overrides?.collisionRegionRetentionTicks ?? DEFAULT_OBB_SETTINGS.collisionRegionRetentionTicks,
    collisionUnloadMargin: overrides?.collisionUnloadMargin ?? DEFAULT_OBB_SETTINGS.collisionUnloadMargin,
    collisionUpdateInterval: overrides?.collisionUpdateInterval ?? DEFAULT_OBB_SETTINGS.collisionUpdateInterval,
    contactRadius: overrides?.contactRadius ?? DEFAULT_OBB_SETTINGS.contactRadius,
    friction: overrides?.friction ?? DEFAULT_OBB_SETTINGS.friction,
    fullCollisionColumnLimit: overrides?.fullCollisionColumnLimit ?? DEFAULT_OBB_SETTINGS.fullCollisionColumnLimit,
    heightStep: overrides?.heightStep ?? DEFAULT_OBB_SETTINGS.heightStep,
    spacing: overrides?.spacing ?? DEFAULT_OBB_SETTINGS.spacing,
    supportHeight: overrides?.supportHeight ?? DEFAULT_OBB_SETTINGS.supportHeight,
    supportWidth: overrides?.supportWidth ?? DEFAULT_OBB_SETTINGS.supportWidth
  };
  assertPositive(settings.heightStep, "heightStep");
  assertPositive(settings.spacing.forward, "spacing.forward");
  assertPositive(settings.spacing.sideways, "spacing.sideways");
  assertPositive(settings.supportHeight, "supportHeight");
  assertPositive(settings.supportWidth, "supportWidth");
  assertPositive(settings.collisionActivationBucketSize, "collisionActivationBucketSize");
  if (!Number.isFinite(settings.collisionQueryMargin) || settings.collisionQueryMargin < 0) throw new RangeError("collisionQueryMargin must be a finite non-negative number.");
  if (!Number.isInteger(settings.collisionRegionRetentionTicks) || settings.collisionRegionRetentionTicks < 0) throw new RangeError("collisionRegionRetentionTicks must be a non-negative integer.");
  if (!Number.isFinite(settings.collisionUnloadMargin) || settings.collisionUnloadMargin < 0) throw new RangeError("collisionUnloadMargin must be a finite non-negative number.");
  assertFrictionSettings(settings.friction, "friction.");
  if (!Number.isInteger(settings.fullCollisionColumnLimit) || settings.fullCollisionColumnLimit < 0) throw new RangeError("fullCollisionColumnLimit must be a non-negative integer.");
  if (!Number.isInteger(settings.collisionUpdateInterval) || settings.collisionUpdateInterval < 1) throw new RangeError("collisionUpdateInterval must be a positive integer.");
  if (!Number.isFinite(settings.contactRadius) || settings.contactRadius < 0) throw new RangeError("contactRadius must be a finite non-negative number.");
  return Object.freeze({ ...settings, friction: Object.freeze({ ...settings.friction }), spacing: Object.freeze({ ...settings.spacing }) });
}

export function resolveSupportPresets(catalog: ObbSupportPresetCatalog | undefined, settings: ObbSettings): ObbSupportPresetCatalog | undefined {
  if (catalog === undefined) return undefined;
  const settingsKey = [settings.heightStep, settings.spacing.forward, settings.spacing.sideways, settings.supportHeight, settings.supportWidth].join("|");
  const cached = RESOLVED_PRESET_CATALOGS.get(catalog)?.get(settingsKey);
  if (cached) return cached;
  if (!Number.isFinite(catalog.surfaceHeightTolerance) || catalog.surfaceHeightTolerance < 0) throw new RangeError("supportPresets.surfaceHeightTolerance must be a finite non-negative number.");
  if (!Array.isArray(catalog.presets) || catalog.presets.length === 0) throw new RangeError("supportPresets.presets must contain at least one preset.");
  const ids = new Set<string>();
  let hasBasePreset = false;
  const presets = catalog.presets.map((preset, index) => {
    if (typeof preset?.id !== "string" || preset.id.length === 0) throw new TypeError(`supportPresets.presets[${index}].id must be non-empty.`);
    if (ids.has(preset.id)) throw new RangeError(`Duplicate support preset id: ${preset.id}.`);
    ids.add(preset.id);
    if (preset.event !== undefined && (typeof preset.event !== "string" || preset.event.length === 0)) throw new TypeError(`supportPresets.presets[${index}].event must be a non-empty string.`);
    assertPositive(preset.width, `supportPresets.presets[${index}].width`);
    assertPositive(preset.height, `supportPresets.presets[${index}].height`);
    assertPositiveCellCount(preset.horizontalCells, `supportPresets.presets[${index}].horizontalCells`);
    assertPositiveCellCount(preset.verticalCells, `supportPresets.presets[${index}].verticalCells`);
    if (preset.volumeHeightSteps !== undefined) assertPositiveCellCount(preset.volumeHeightSteps, `supportPresets.presets[${index}].volumeHeightSteps`);
    if (preset.horizontalCells > 1 && Math.abs(settings.spacing.forward - settings.spacing.sideways) > EPSILON_1E6) throw new RangeError("Horizontal support presets require square fine-grid spacing.");
    const expectedWidth = settings.supportWidth + (preset.horizontalCells - 1) * settings.spacing.forward;
    const expectedHeight = preset.volumeHeightSteps === undefined ? preset.verticalCells * settings.supportHeight : preset.volumeHeightSteps * settings.heightStep;
    if (Math.abs(preset.width - expectedWidth) > EPSILON_1E6 || Math.abs(preset.height - expectedHeight) > EPSILON_1E6) throw new RangeError(`Support preset ${preset.id} dimensions do not match its declared fine-cell span.`);
    if (preset.volumeHeightSteps === undefined && preset.horizontalCells === 1 && preset.verticalCells === 1) {
      if (hasBasePreset) throw new RangeError("supportPresets must contain exactly one base preset.");
      hasBasePreset = true;
    }
    return Object.freeze({ ...preset });
  });
  if (!hasBasePreset) throw new RangeError("supportPresets must contain a 1x1 base preset.");
  const resolved = Object.freeze({ presets: Object.freeze(presets), surfaceHeightTolerance: catalog.surfaceHeightTolerance });
  const resolvedBySettings = RESOLVED_PRESET_CATALOGS.get(catalog) ?? new Map<string, ObbSupportPresetCatalog>();
  resolvedBySettings.set(settingsKey, resolved);
  RESOLVED_PRESET_CATALOGS.set(catalog, resolvedBySettings);
  return resolved;
}

function assertPositiveCellCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite positive number.`);
}
