// Invoked by macOS JavaScript for Automation. Vision reads local image files.
ObjC.import('Vision');

// Vision uses a bottom-left origin. The editor uses displayed source coordinates.
function sourceBounds(rect) {
  const clamp = n => Math.max(0, Math.min(1, n));
  const x = clamp(rect.origin.x), y = clamp(1 - rect.origin.y - rect.size.height);
  const width = clamp(rect.origin.x + rect.size.width) - x, height = clamp(1 - rect.origin.y) - y;
  return width > 0 && height > 0 ? {x, y, width, height} : null;
}

function run(paths) {
  return JSON.stringify(paths.map(path => {
    const request = $.VNRecognizeTextRequest.alloc.init;
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(path), $({}));
    const error = Ref();
    if (!handler.performRequestsError($.NSArray.arrayWithObject(request), error)) {
      throw Error(ObjC.unwrap(error[0].localizedDescription));
    }
    const lines = [];
    const observations = request.results;
    for (let i = 0; i < observations.count; i++) {
      const observation = observations.objectAtIndex(i), candidates = observation.topCandidates(1);
      if (!candidates.count) continue;
      const candidate = candidates.firstObject, text = ObjC.unwrap(candidate.string);
      const words = [];
      // NSRange and JS match.index both count UTF-16 code units.
      for (const match of text.matchAll(/[\p{L}\p{N}'’]+/gu)) {
        const range = $.NSMakeRange(match.index, match[0].length);
        const box = candidate.boundingBoxForRangeError(range, Ref());
        words.push({text: match[0], bounds: box && !box.isNil() ? sourceBounds(box.boundingBox) : null});
      }
      lines.push({text, bounds: sourceBounds(observation.boundingBox), words});
    }
    return lines;
  }));
}
