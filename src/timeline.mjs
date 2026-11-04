/** Compile one source-linked edit into the common Remotion frame clock. */
export function compileTimeline(project) {
  const {fps, width, height} = project.settings;
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  let elapsed = 0;
  const clips = project.clips.map((clip) => {
    const from = Math.round(elapsed * fps);
    elapsed += (clip.sourceEnd - clip.sourceStart) / (clip.playbackRate ?? 1);
    const asset = assets.get(clip.assetId);
    return {
      ...clip,
      from,
      durationInFrames: Math.round(elapsed * fps) - from,
      sourceFrame: Math.round(clip.sourceStart * fps),
      sourceStartSeconds: clip.sourceStart,
      sourceFps: asset?.fps ?? fps,
    };
  }).filter((clip) => clip.durationInFrames > 0);
  const captions = retimeWords(project, clips);
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
    return [{...overlay, start, end, from, durationInFrames: Math.round(end * fps) - from}];
  }).filter((overlay) => overlay.durationInFrames > 0);
  const durationInFrames = overlays.reduce((end, overlay) => Math.max(end, overlay.from + overlay.durationInFrames),
    Math.round(elapsed * fps));
  return {
    fps, width, height, durationInFrames, clips, overlays,
    captions,
    settings: project.settings,
    captionsStyle: project.captions,
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
    const rate = clip.playbackRate ?? 1;
    for (const word of transcripts.get(clip.assetId) ?? []) {
      const isPoint = word.start === word.end;
      // A point timestamp has no measured duration. Keep it as a single caption
      // frame only when it belongs to this half-open source interval.
      if (isPoint && (word.start < clip.sourceStart || word.start >= clip.sourceEnd)) continue;
      const sourceStart = Math.max(word.start, clip.sourceStart);
      const sourceEnd = Math.min(word.end, clip.sourceEnd);
      if (!isPoint && sourceEnd <= sourceStart) continue;
      // Relative rounding is anchored to the compiled clip, avoiding drift after cuts.
      const startFrame = Math.max(clip.from, Math.min(clip.from + clip.durationInFrames - 1,
        clip.from + Math.round((sourceStart - clip.sourceStart) / rate * fps)));
      const endFrame = Math.min(clip.from + clip.durationInFrames,
        Math.max(startFrame + 1, clip.from + Math.round((sourceEnd - clip.sourceStart) / rate * fps)));
      result.push({...word, assetId: clip.assetId, clipId: clip.id,
        sourceStart: word.start, sourceEnd: word.end,
        start: startFrame / fps, end: endFrame / fps, startFrame, endFrame});
    }
  }
  return result;
}
