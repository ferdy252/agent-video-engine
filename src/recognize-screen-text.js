// Invoked by macOS JavaScript for Automation. Vision reads local image files.
ObjC.import('Vision');

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
      const candidates = observations.objectAtIndex(i).topCandidates(1);
      if (candidates.count) lines.push(ObjC.unwrap(candidates.firstObject.string));
    }
    return lines;
  }));
}
