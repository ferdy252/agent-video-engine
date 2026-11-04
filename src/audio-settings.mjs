/** Saved controls only. Processing and measurements live in audio-processing. */
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  enabled: false, targetLufs: -16, truePeakDb: -1.5, strength: 1,
  maxGainDb: 9, voiceGainDb: 0, outputGainDb: 0,
});
export const AUDIO_LIMITS = Object.freeze({
  targetLufs: [-36, -9], truePeakDb: [-9, -.5], strength: [0, 1],
  maxGainDb: [0, 24], voiceGainDb: [-24, 24], outputGainDb: [-24, 24],
});
const fail = (message) => {throw Object.assign(new Error(message), {code: 'VALIDATION_ERROR'});};
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
};
const finite = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} must be a finite number from ${min} to ${max}.`);
};

export function validateAudioSettings(value) {
  object(value, 'audio');
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'enabled') {
      if (typeof setting !== 'boolean') fail('audio.enabled must be boolean.');
    } else if (Object.hasOwn(AUDIO_LIMITS, key)) finite(setting, ...AUDIO_LIMITS[key], `audio.${key}`);
    else fail(`Unknown audio setting: ${key}.`);
  }
  return true;
}

export function resolveAudioSettings(value) {
  if (value !== undefined) validateAudioSettings(value);
  return {...DEFAULT_AUDIO_SETTINGS, ...value};
}

export function validateClipAudio(value) {
  object(value, 'clip.audio');
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'leveling') {
      if (typeof setting !== 'boolean') fail('clip.audio.leveling must be boolean.');
    } else if (key === 'gainDb') finite(setting, -24, 24, 'clip.audio.gainDb');
    else fail(`Unknown clip audio setting: ${key}.`);
  }
  return true;
}

export function resolveClipAudio(value) {
  if (value !== undefined) validateClipAudio(value);
  return {leveling: true, gainDb: 0, ...value};
}
