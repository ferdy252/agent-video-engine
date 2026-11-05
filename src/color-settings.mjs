/** Relative display corrections. Temperature and tint are not Kelvin values. */
export const DEFAULT_COLOR_SETTINGS = Object.freeze({
  enabled: true, brightness: 1, contrast: 1, saturation: 1, temperature: 0, tint: 0,
});

export const COLOR_LIMITS = Object.freeze({
  brightness: Object.freeze([0, 3]),
  contrast: Object.freeze([0, 3]),
  saturation: Object.freeze([0, 3]),
  temperature: Object.freeze([-1, 1]),
  tint: Object.freeze([-1, 1]),
});

const keys = new Set(Object.keys(DEFAULT_COLOR_SETTINGS));
function invalid(message) {
  throw Object.assign(new Error(message), {code: 'VALIDATION_ERROR'});
}
function validateObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${name} must be a plain object.`);
}
function validateField(key, value) {
  if (!keys.has(key)) invalid(`Unknown color setting: ${String(key)}.`);
  if (key === 'enabled') {
    if (typeof value !== 'boolean') invalid('color.enabled must be boolean.');
    return;
  }
  const [minimum, maximum] = COLOR_LIMITS[key];
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`color.${key} must be a finite number from ${minimum} to ${maximum}.`);
  }
}

/** Stored values may be partial, but contain no nulls or unknown fields. */
export function validateColorSettings(value) {
  validateObject(value, 'Color settings');
  for (const key of Reflect.ownKeys(value)) validateField(key, value[key]);
  return true;
}

/** Resolve defaults, asset settings and clip overrides without changing them. */
export function resolveColorSettings(...settings) {
  const resolved = {...DEFAULT_COLOR_SETTINGS};
  for (const value of settings) {
    if (value === undefined) continue;
    validateColorSettings(value);
    Object.assign(resolved, value);
  }
  return resolved;
}

export function isColorCorrectionActive(settings) {
  const resolved = resolveColorSettings(settings);
  return resolved.enabled && Object.keys(COLOR_LIMITS).some((key) => resolved[key] !== DEFAULT_COLOR_SETTINGS[key]);
}

/** CSS controls and modest RGB gains for warm/cool and green/magenta shifts. */
export function colorTransform(settings) {
  const resolved = resolveColorSettings(settings);
  if (!resolved.enabled) return {filter: '', rgbGains: [1, 1, 1]};
  const filters = [];
  for (const [key, cssName] of [['brightness', 'brightness'], ['contrast', 'contrast'], ['saturation', 'saturate']]) {
    if (resolved[key] !== 1) filters.push(`${cssName}(${resolved[key]})`);
  }
  const {temperature, tint} = resolved;
  return {filter: filters.join(' '), rgbGains: [
    1 + temperature * 0.2 + tint * 0.1,
    1 - tint * 0.15,
    1 - temperature * 0.2 + tint * 0.1,
  ]};
}

/** Null removes a local override, exposing its inherited value on resolution. */
export function applyColorPatch(current, patch) {
  if (current !== undefined) validateColorSettings(current);
  if (patch === null) return undefined;
  validateObject(patch, 'Color patch');
  const updated = {...current};
  for (const key of Reflect.ownKeys(patch)) {
    if (!keys.has(key)) invalid(`Unknown color setting: ${String(key)}.`);
    const value = patch[key];
    if (value === null) delete updated[key];
    else {validateField(key, value); updated[key] = value;}
  }
  return Object.keys(updated).length ? updated : undefined;
}
