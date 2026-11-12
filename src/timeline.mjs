import {resolveAudioSettings} from './audio-settings.mjs';
import {resolveColorSettings} from './color-settings.mjs';
import {clipSeconds, captionCues} from './edit-controls.mjs';
import {applyCaptionOverrides} from './caption-overrides.mjs';

/** Compile one source-linked edit into the common output frame clock. */
export function compileTimeline(project) {
  const {fps, width, height} = project.settings;
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  let elapsed = 0;
  const clips = project.clips.map((clip) => {
    const previousEnd = Math.round(elapsed * fps);
    elapsed -= clip.transition?.duration ?? 0;
    const from = Math.round(elapsed * fps);
    elapsed += clipSeconds(clip);
    if (clip.type === 'gap') return {...clip, from, durationInFrames: Math.round(elapsed * fps) - from};
    const asset = assets.get(clip.assetId);
    const rate = clip.playbackRate ?? 1, sound = clip.audio ?? {};
    const audioStart = sound.sourceStart ?? clip.sourceStart;
    const audioEnd = sound.sourceEnd ?? clip.sourceEnd;
    const rawAudioFrom = from + Math.round((sound.offset ?? 0) * fps);
    const audioFrom = Math.max(0, rawAudioFrom);
    const audioFollowsPicture = sound.sourceStart === undefined && sound.sourceEnd === undefined && !sound.offset;
    const audioDurationInFrames = audioFollowsPicture ? Math.round(elapsed * fps) - from
      : Math.max(0, Math.round((audioEnd - audioStart) / rate * fps) - (audioFrom - rawAudioFrom));
    return {
      ...clip,
      from,
      durationInFrames: Math.round(elapsed * fps) - from,
      sourceFrame: Math.round(clip.sourceStart * fps),
      sourceStartSeconds: clip.sourceStart,
      sourceFps: asset?.fps ?? fps,
      color: resolveColorSettings(asset?.color, clip.color),
      transitionFrames: clip.transition ? previousEnd - from : 0,
      audioAssetId: sound.assetId ?? clip.assetId, audioFrom, audioDurationInFrames,
      audioSourceFrame: Math.round(audioStart * fps + (audioFrom - rawAudioFrom) * rate),
      audioSourceStartSeconds: audioStart + (audioFrom - rawAudioFrom) / fps * rate,
      audioSourceEndSeconds: audioEnd,
      audioTrimmedSeconds: (audioFrom - rawAudioFrom) / fps,
      audioOriginalDurationSeconds: (audioEnd - audioStart) / rate,
      audioFollowsPicture,
    };
  }).filter((clip) => clip.durationInFrames > 0);
  for (let i = 0; i < clips.length - 1; i++) {
    clips[i].outgoingTransitionFrames = clips[i + 1].transitionFrames ?? 0;
    clips[i].outgoingTransitionType = clips[i + 1].transition?.type;
  }
  const captions = retimeWords(project, clips);
  const displayCaptions = applyCaptionOverrides(captions, project.captions, clips);
  const overlays = project.overlays.flatMap((overlay) => {
    let start = overlay.start;
    let end = overlay.end;
    if (overlay.anchor) {
      const {assetId, wordId, offset = 0, clipId} = overlay.anchor;
      // Edited order determines the first occurrence when the source is reused.
      const word = captions.find((entry) => entry.assetId === assetId && entry.id === wordId &&
        (clipId === undefined || entry.clipId === clipId));
      if (!word) return [];
      start = Math.max(0, word.start + offset);
      end = start + overlay.end - overlay.start;
    }
    const from = Math.round(start * fps);
    const asset = assets.get(overlay.assetId);
    return [{...overlay, start, end, from, durationInFrames: Math.round(end * fps) - from,
      color: resolveColorSettings(asset?.color)}];
  }).filter((overlay) => overlay.durationInFrames > 0);
  const mainEnd = clips.reduce((end, clip) => {
    const asset = assets.get(clip.audioAssetId);
    const audible = asset && asset.type !== 'image' && asset.hasAudio !== false && !clip.audio?.muted && clip.volume !== 0;
    return Math.max(end, audible ? clip.audioFrom + clip.audioDurationInFrames : 0);
  }, Math.round(elapsed * fps));
  const durationInFrames = overlays.reduce((end, overlay) => Math.max(end, overlay.from + overlay.durationInFrames), mainEnd);
  return {
    fps, width, height, durationInFrames, clips, overlays,
    captions,
    captionCues: captionCues(displayCaptions.words, project.captions, fps),
    ...(project.captions.wordOverrides?.length ? {captionOverrideReview: displayCaptions.review} : {}),
    settings: project.settings,
    captionsStyle: project.captions,
    audio: resolveAudioSettings(project.audio),
    assets: project.assets,
    custom: project.custom,
  };
}

/** Retain original word identities and map them through the actual kept clips. */
export function retimeWords(project, compiledClips) {
  if (!compiledClips) return compileTimeline(project).captions;
  const fps = project.settings.fps;
  const transcripts = new Map(project.transcripts.map((entry) => [entry.assetId, entry.words]));
  const result = [];
  for (const clip of compiledClips) {
    if (clip.type === 'gap' || clip.audio?.muted || (clip.audio?.role && clip.audio.role !== 'voice')) continue;
    const rate = clip.playbackRate ?? 1;
    const assetId = clip.audioAssetId ?? clip.assetId;
    const retainedStart = clip.audioSourceStartSeconds ?? clip.sourceStart;
    const retainedEnd = clip.audioSourceEndSeconds ?? clip.sourceEnd;
    const from = clip.audioFrom ?? clip.from, duration = clip.audioDurationInFrames ?? clip.durationInFrames;
    if (duration <= 0) continue;
    for (const word of transcripts.get(assetId) ?? []) {
      const isPoint = word.start === word.end;
      // A point timestamp has no measured duration. Keep it as a single caption
      // frame only when it belongs to this half-open source interval.
      if (isPoint && (word.start < retainedStart || word.start >= retainedEnd)) continue;
      const sourceStart = Math.max(word.start, retainedStart);
      const sourceEnd = Math.min(word.end, retainedEnd);
      if (!isPoint && sourceEnd <= sourceStart) continue;
      // Relative rounding is anchored to the compiled clip, avoiding drift after cuts.
      const startFrame = Math.max(from, Math.min(from + duration - 1,
        from + Math.round((sourceStart - retainedStart) / rate * fps)));
      const endFrame = Math.min(from + duration,
        Math.max(startFrame + 1, from + Math.round((sourceEnd - retainedStart) / rate * fps)));
      result.push({...word, assetId, clipId: clip.id,
        sourceStart: word.start, sourceEnd: word.end,
        start: startFrame / fps, end: endFrame / fps, startFrame, endFrame});
    }
  }
  return result;
}
