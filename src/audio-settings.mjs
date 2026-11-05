/** Saved controls only. Processing and measurements live in audio-processing. */
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  enabled: false, targetLufs: -16, truePeakDb: -1.5, strength: 1,
  maxGainDb: 9, voiceGainDb: 0, musicGainDb: 0, effectsGainDb: 0, outputGainDb: 0,
  ducking: Object.freeze({enabled: false, amountDb: 10, attack: 0.08, release: 0.3, thresholdDb: -32}),
  denoise: Object.freeze({enabled: false, amount: 0.35}),
});
export const AUDIO_LIMITS = Object.freeze({
  targetLufs: [-36, -9], truePeakDb: [-9, -.5], strength: [0, 1],
  maxGainDb: [0, 24], voiceGainDb: [-24, 24], musicGainDb: [-24, 24], effectsGainDb: [-24, 24], outputGainDb: [-24, 24],
});
export const DUCKING_LIMITS = Object.freeze({amountDb: [0, 24], attack: [0.005, 2], release: [0.01, 5], thresholdDb: [-60, 0]});
export const DENOISE_LIMITS = Object.freeze({amount: [0, 1]});
export const AUDIO_ROLES = Object.freeze(['voice', 'music', 'effects']);
const fail = (message) => {throw Object.assign(new Error(message), {code: 'VALIDATION_ERROR'});};
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object.`);
};
const finite = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} must be a finite number from ${min} to ${max}.`);
};

function validateEffect(value, name, limits) {
  object(value, name);
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'enabled') {
      if (typeof setting !== 'boolean') fail(`${name}.enabled must be boolean.`);
    } else if (Object.hasOwn(limits, key)) finite(setting, ...limits[key], `${name}.${key}`);
    else fail(`Unknown ${name} setting: ${key}.`);
  }
}

export function validateAudioSettings(value) {
  object(value, 'audio');
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'enabled') {
      if (typeof setting !== 'boolean') fail('audio.enabled must be boolean.');
    } else if (key === 'ducking') validateEffect(setting, 'audio.ducking', DUCKING_LIMITS);
    else if (key === 'denoise') validateEffect(setting, 'audio.denoise', DENOISE_LIMITS);
    else if (Object.hasOwn(AUDIO_LIMITS, key)) finite(setting, ...AUDIO_LIMITS[key], `audio.${key}`);
    else fail(`Unknown audio setting: ${key}.`);
  }
  return true;
}

export function resolveAudioSettings(value) {
  if (value !== undefined) validateAudioSettings(value);
  return {...DEFAULT_AUDIO_SETTINGS, ...value,
    ducking: {...DEFAULT_AUDIO_SETTINGS.ducking, ...value?.ducking},
    denoise: {...DEFAULT_AUDIO_SETTINGS.denoise, ...value?.denoise}};
}

export function mergeAudioSettings(current, patch) {
  const base = resolveAudioSettings(current);
  validateAudioSettings(patch);
  return {...base, ...patch,
    ducking: {...base.ducking, ...patch.ducking}, denoise: {...base.denoise, ...patch.denoise}};
}

function validateEnvelope(envelope) {
  if (!Array.isArray(envelope) || envelope.length > 128) fail('clip.audio.envelope must contain at most 128 volume points.');
  let previous = -1;
  for (const point of envelope) {
    object(point, 'Volume point');
    if (Object.keys(point).some((key) => !['time', 'value'].includes(key))) fail('Volume points accept only time and value.');
    finite(point.time, 0, Infinity, 'Volume point time');
    finite(point.value, 0, 8, 'Volume point value');
    if (point.time <= previous) fail('Volume point times must be strictly increasing.');
    previous = point.time;
  }
}

export function validateClipAudio(value) {
  object(value, 'clip.audio');
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'leveling' || key === 'muted') {
      if (typeof setting !== 'boolean') fail(`clip.audio.${key} must be boolean.`);
    } else if (key === 'gainDb') finite(setting, -24, 24, 'clip.audio.gainDb');
    else if (key === 'assetId') {
      if (typeof setting !== 'string' || !setting.trim()) fail('clip.audio.assetId must be a nonempty string.');
    } else if (key === 'role') {
      if (!AUDIO_ROLES.includes(setting)) fail('clip.audio.role must be voice, music or effects.');
    } else if (key === 'sourceStart' || key === 'sourceEnd') finite(setting, 0, Infinity, `clip.audio.${key}`);
    else if (key === 'offset' || key === 'curveOffset') finite(setting, -Infinity, Infinity, `clip.audio.${key}`);
    else if (key === 'curveDuration') {
      if (!Number.isFinite(setting) || setting <= 0) fail('clip.audio.curveDuration must be positive and finite.');
    }
    else if (key === 'fadeIn' || key === 'fadeOut') finite(setting, 0, 3600, `clip.audio.${key}`);
    else if (key === 'envelope') validateEnvelope(setting);
    else fail(`Unknown clip audio setting: ${key}.`);
  }
  if (value.sourceEnd !== undefined && value.sourceEnd <= (value.sourceStart ?? 0)) fail('clip.audio.sourceEnd must follow sourceStart.');
  return true;
}

export function resolveClipAudio(value) {
  if (value !== undefined) validateClipAudio(value);
  return {leveling: true, gainDb: 0, ...value};
}

/** Amplitude at a time within the audio sequence. Points use local seconds. */
export function volumeAt(audio, elapsedSeconds, durationSeconds, baseVolume = 1) {
  if (audio?.muted || elapsedSeconds < 0 || elapsedSeconds >= durationSeconds) return 0;
  const time = elapsedSeconds + (audio?.curveOffset ?? 0);
  const duration = audio?.curveDuration ?? durationSeconds;
  let volume = baseVolume;
  if (audio?.fadeIn > 0) volume *= Math.max(0, Math.min(1, time / audio.fadeIn));
  if (audio?.fadeOut > 0) volume *= Math.max(0, Math.min(1, (duration - time) / audio.fadeOut));
  const points = audio?.envelope;
  if (!points?.length) return volume;
  if (time <= points[0].time) return volume * points[0].value;
  const next = points.findIndex((point) => point.time > time);
  if (next < 0) return volume * points.at(-1).value;
  const left = points[next - 1], right = points[next];
  const position = (time - left.time) / (right.time - left.time);
  return volume * (left.value + (right.value - left.value) * position);
}
