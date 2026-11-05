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
