# Deliver a video, subtitles or an editable timeline

Use one saved revision for all three. Each output has its own file, and export refuses an existing filename.

## Frame sizes

| Preset | Dimensions |
| --- | --- |
| `vertical` | 1080 × 1920 |
| `horizontal` | 1920 × 1080 |
| `square` | 1080 × 1080 |

A preset changes the canvas for the requested render. Use the same `preset` in `preview_render` and `export_render`. The preset preserves the saved revision, frame rate, cuts, transitions and caption timing. Main visual clips default to `contain` to keep the full picture visible. Use `fit: "cover"` with the preset to fill the canvas with a crop. Saved focal points guide the crop.

Explicit clip rectangles, numeric overlay geometry and horizontal or vertical motion distances scale with the canvas. Percentage and CSS expressions keep their authored values. Preview each new shape to check framing and any custom layer that uses fixed pixel positions.

## Final-export quality

`export_render` renders at full scale with H.264, `yuv420p` and CRF 18. Moving previews use CRF 25 and normally half scale. The encoder uses quality-based compression, so the measured bitrate varies with the picture; bitrate alone is not a visual-quality verdict. See the [Remotion encoding guide](https://www.remotion.dev/docs/encoding/).

Every rendered MP4 has an adjacent `<filename>.mp4.quality.json` report. The completed job returns `quality` and `qualityReportPath`. The report records the render purpose, project revision, exact file SHA-256 and byte count, intended settings, measured media properties and warnings. Requested encoder controls are labeled separately from measured properties. Finals warn below a 1080-pixel short edge by default. Set `minShortSide` explicitly for an intentional smaller delivery; this changes the check, not the rendered dimensions. Use a delivery preset or project settings to change the canvas and review the new framing.

Before delivery or upload, call `export_verify` with an absolute `outputPath`. It rereads the matching sidecar, recomputes the video fingerprint and probes the encoded file. `passed` means the recorded technical checks passed for these exact bytes. `needs_review` includes missing or inconsistent reports, final-resolution warnings, framing findings and possible speech gaps. `not_final` identifies a preview or source preview. Version 1 reports remain readable but cannot pass as having the new checks: export again to run them. Verification reads the stored scan evidence bound to the file fingerprint; it does not rerun the scan or invent provenance.

Copy the report alongside the MP4, retaining the naming relationship, and verify the destination file again. Never promote a preview by renaming it. Reports are local consistency evidence, not signed proof of origin or creative approval. Successful checks do not establish readable text, sharp focus, natural pauses or platform playback quality. Compare representative details with the original and review the actual output at its intended viewing size. Upscaling cannot restore missing source detail.

Video and report outputs refuse overwrite, including a pre-existing report. Failed publication of the video removes only the report created by that attempt. Quality warnings preserve the output for review rather than silently changing it.

## Automatic framing and speech-gap checks

Version 2 quality reports add two checks:

- `checks.framing`: crop, contain/cover fit, positioned boxes, source rotation/pixel aspect and animated scale on the compiled clock. The default `maxUpscale: 1.25` flags more than 1.25 output pixels per source pixel along either axis. The report includes timestamps and full-size still preview hints. Unsupported CSS and custom media are marked unassessed. Text/vector graphics are excluded. Before rendering, use `quality_preflight` for the same check with optional draft/preset and pagination.
- `checks.speechGaps`: a complete FFmpeg audio decode of the encoded final, with quiet intervals detected at `speechGapNoiseDb: -40` for at least `speechGapMinSeconds: 0.8`. It preserves separate channels, so opposite-phase stereo does not cancel into false silence. Measured source word intervals are mapped through retained voice tracks, replacement audio, playback speed, J/L offsets and voice overlays to identify possible pauses under continuous music. Edited display captions are not used as speech evidence. Missing or point-only word timing is explicitly unassessed.

These thresholds are review preferences, configurable on `export_render`; they never modify the edit. A silent intro, demo pause or music-only ending may be intentional. Quiet audio is not semantic speech detection, and transcript timing does not prove audibility. Music, noise, inaccurate transcripts or independently authored custom audio require direct listening. The scan needs no speech model, downloads or uploads. It decodes the whole exported file, not just cut boundaries; decoder errors and cancellation prevent the final/report pair from being published.

Framing reports return at most 100 findings in exports (paginate `quality_preflight` for more). Speech reports store up to 1,000 findings while continuing to scan/count the entire file. Truncation is explicit and keeps the export in `needs_review`; a truncated report is not a complete review checklist. Each speech finding provides an encoded-file time range and padded review range. Listen to flagged moments before sharing, fix unwanted pauses, and rerender/reverify after changes. Record intentional pauses separately without editing the machine-generated report. `verifiedFinal` remains false while warnings exist; it is a technical status, not a record of a human's editorial approval.

## Subtitle files

Call `export_subtitles` with `format` of `srt` or `vtt` and the matching filename extension. `outputPath` can be absolute or relative to the project. The sidecar uses the same compiled cue boundaries as the edit and stops at the end of the video. Explicit output cues take precedence over pages grouped from the retimed source transcript. Both formats preserve multiline text and write times to the nearest millisecond. WebVTT escapes literal text markup. You can export a sidecar with burned-in captions turned off.

The sidecar carries text and timing. The rendered MP4 carries the caption design, including highlighting on automatic word pages.

## Editable handoff

Call `export_timeline` to write a native OpenTimelineIO timeline. It contains editable media clips, source in-points, gaps, video and audio tracks, and local URLs for the referenced originals. The output clock preserves sequence timing, including overlap handles, playback rates and independent audio placement for J/L cuts. Bring the original media or relink it in the receiving editor.

Crossfades use the standard OTIO dissolve. Dip and wipe retain their original type and timing as custom transitions. Receiving editors vary in how they interpret transitions, playback rates, stills, media timecode and linked audio.

Legacy videos with unknown audio metadata keep a separate audio track, matching the engine renderer. Receiving editors may leave that track empty for picture-only files.

Engine text overlays, custom animation, visual corrections, layout and keyframes, caption styling and the finished audio mix do not transfer as editable effects. Include the MP4 as a picture and sound reference and a subtitle file for caption text. Timeline dimensions and some original edit settings are available as engine metadata, which receiving editors can ignore.

These delivery paths need the engine timeline. Adapt an independent composition to `custom.mode: "layer"` to use its motion above the shared edit.

The interchange structure follows [OpenTimelineIO's serialized schema](https://opentimelineio.readthedocs.io/en/v0.18.1/tutorials/otio-serialized-schema.html) and [timeline timing model](https://opentimelineio.readthedocs.io/en/v0.18.1/tutorials/otio-timeline-structure.html).
