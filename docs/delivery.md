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

Before delivery or upload, call `export_verify` with an absolute `outputPath`. It rereads the matching sidecar, recomputes the video fingerprint and probes the encoded file. `passed` means the recorded technical checks passed for these exact bytes. `needs_review` includes missing or inconsistent reports and final-resolution warnings. `not_final` identifies a preview or source preview. An absent report on an older export requires an explicit manual review; the tool does not invent provenance or re-encode the file.

Copy the report alongside the MP4, retaining the naming relationship, and verify the destination file again. Never promote a preview by renaming it. Reports are local consistency evidence, not signed proof of origin or creative approval. Successful checks do not assess readable text, crop enlargement, source softness, compression artifacts or a platform's later processing. Compare representative details with the original and review the actual output at its intended viewing size. Upscaling cannot restore missing source detail.

Video and report outputs refuse overwrite, including a pre-existing report. Failed publication of the video removes only the report created by that attempt. Quality warnings preserve the output for review rather than silently changing it.

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
