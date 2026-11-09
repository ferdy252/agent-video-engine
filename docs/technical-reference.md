# AgentVideoEngine technical reference

[Back to the beginner guide](../README.md).

A local, headless video editor for AI agents. An agent controls source-linked cuts, captions, overlays, audio and renders through MCP tools or a JSON command line interface. There is no desktop editor or timeline UI.

The engine saves one editable project with revision history. The agent supplies editorial decisions; the engine validates edits, maps source timing to output frames and renders through Remotion.

## Requirements and setup

- Node.js 22 or newer.
- Installed `ffmpeg` and `ffprobe` executables.
- An installed Chrome or Chromium executable for rendering.
- For transcription: installed `whisper-cli` from whisper.cpp and a cached compatible GGML model.

Install the pinned JavaScript dependencies and check the local tools:

```sh
npm ci
node src/cli.mjs doctor
```

The engine does not download a browser or transcription model at runtime. It discovers common local Chromium installations, or uses `AGENT_VIDEO_BROWSER` when set to an executable path. Transcription defaults to `~/.cache/whisper.cpp/ggml-medium.en.bin`; set `VIDEO_ENGINE_MODEL` or supply a transcription request's `modelPath` to choose another installed model.

`doctor` reports transcription dependencies even when only rendering is needed. A missing model does not prevent creating projects, importing transcripts or rendering.

## MCP connection

Configure an MCP client to launch the stdio server directly:

```json
{
  "mcpServers": {
    "agent-video-engine": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/agent-video-engine/src/server.mjs"]
    }
  }
}
```

Replace both paths with local installations. If needed, pass `AGENT_VIDEO_BROWSER` and `VIDEO_ENGINE_MODEL` through the client's environment configuration. The server reserves stdout for MCP protocol messages and starts on demand.

MCP hosts receive typed tool schemas. Reconnect the server after updating to discover the current tools. `node src/cli.mjs tools` also lists tool names and descriptions.

## Command line usage

Run any tool with a JSON request file, or read the request from stdin:

```sh
node src/cli.mjs project_create create.json
node src/cli.mjs project_inspect - < inspect.json
```

Example `create.json`:

```json
{
  "projectDir": "/absolute/path/video-project",
  "name": "Example edit",
  "width": 1080,
  "height": 1920,
  "fps": 30
}
```

Example `inspect.json`:

```json
{
  "projectDir": "/absolute/path/video-project",
  "includeTimeline": true
}
```

New projects start at revision `0`. Add a local source with `media_add`:

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 0,
  "path": "/absolute/path/media/source.mp4",
  "addToTimeline": true
}
```

The response includes the asset ID and new revision. Use those returned values in subsequent requests. Media is referenced by its canonical local path and fingerprint; it is not copied into the project.

## Editing workflow

1. Inspect the project and current revision.
2. Add media and import a timestamped transcript, or start local transcription.
   For multiple takes inside one recording, build `media_index` and inspect its source ranges before selecting cuts.
3. Read transcript words and inspect source previews before choosing cuts.
4. Stage a draft with `draft_stage` and preview it using `preview_render` with `draftId`. Use `edit_apply` when you want to save changes immediately.
5. Apply the reviewed draft and use `review_cuts` to inspect joins in the saved edit.
6. Validate the project and deliver the requested video, subtitles or editable timeline.

Every successful edit batch creates a revision. Invalid batches and stale revisions leave the project unchanged. Restoring an earlier revision creates a new revision and preserves the intervening history.

Source files are never edited. Exports use new filenames and cannot replace an existing file or registered source. Built-in processing stays local and has no publishing or upload tools. Numerical checks establish timing and encoded properties; editorial quality and the final audiovisual result still need review.

## Available tools

| Tool | Main inputs and purpose |
| --- | --- |
| `engine_status` | Check local binaries, Node and the cached transcription model |
| `project_create` | `projectDir`, `name`, optional `width`, `height`, `fps`, `audio` |
| `project_inspect` | `projectDir`, optional `includeTimeline` |
| `project_validate` | `projectDir`; validate timing and original-media fingerprints |
| `project_import_legacy` | `projectDir`, `path` to a version-1 `.aive`, optional `name` |
| `project_bundle` | `projectDir`, `expectedRevision`, new `bundleDir`; package editable media and project as a job |
| `project_open_bundle` | `bundleDir`, new `projectDir`; verify and open a portable copy as a job |
| `media_add` | `projectDir`, `expectedRevision`, local `path`, optional `addToTimeline` |
| `media_relink` | `projectDir`, `expectedRevision`, `replacements` with `{assetId, path}` entries |
| `media_index` | `projectDir`, `expectedRevision`, `assetId`; optional `intervalSeconds`, `maxThumbnails` |
| `media_index_get` | `projectDir`, `indexId`; optional `offset`, `limit`, `sheetPage`, `includePreview` |
| `media_search` | `projectDir`, `indexId`, spoken-word `query`; optional `offset`, `limit` |
| `transcript_import` | `projectDir`, `expectedRevision`, `assetId`, local JSON `path` |
| `transcript_search` | `projectDir`, `assetId`, optional `query`, `offset`, `limit` |
| `transcribe` | `projectDir`, `expectedRevision`, `assetId`, optional `modelPath`, `language` |
| `edit_apply` | `projectDir`, `expectedRevision`, `operations` |
| `draft_stage` | `projectDir`, `expectedRevision`, `operations`, optional `name` |
| `draft_inspect` | `projectDir`, `draftId`, optional `includeTimeline` |
| `draft_list` | `projectDir` |
| `draft_apply` | `projectDir`, `expectedRevision`, `draftId` |
| `draft_delete` | `projectDir`, `draftId` |
| `revision_list` | `projectDir` |
| `revision_compare` | `projectDir`, `fromRevision`, `toRevision` |
| `revision_restore` | `projectDir`, `expectedRevision`, target `revision` |
| `graphic_presets` | List the available text graphic styles |
| `source_preview` | `projectDir`, `expectedRevision`, `assetId`, optional `kind`, `sourceStart`, `sourceEnd`, `scale` |
| `preview_render` | `projectDir`, `expectedRevision`, optional `kind`, `frame`, `fromFrame`, `toFrame`, `scale`, `draftId` or `revision`, delivery `preset` and `fit` |
| `color_preview` | `projectDir`, `expectedRevision`, optional output `frame`, `scale` |
| `export_render` | `projectDir`, `expectedRevision`, optional `outputPath`, `concurrency`, delivery `preset`, `fit` and `minShortSide` (1080 by default) |
| `export_verify` | Absolute `outputPath`; read-only fingerprint, metadata and quality-report check of the exact delivery file |
| `export_subtitles` | `projectDir`, `expectedRevision`, `outputPath`, `format` of `srt` or `vtt` |
| `export_timeline` | `projectDir`, `expectedRevision`, `outputPath`, optional `format` of `otio` |
| `review_cuts` | `projectDir`, `expectedRevision`; optional preview context, batch offset/limit and timing-only mode |
| `job_list` | `projectDir` |
| `job_get` | `projectDir`, `jobId`, optional `includePreview` |
| `job_cancel`, `job_retry` | `projectDir`, `jobId` |

Preview `kind` is `still` or `preview`. Frame ranges use output frames, and source preview bounds use source seconds. Transcription, rendering, delivery and bundle operations return durable job IDs. Follow `job_get` until completion, failure or cancellation. Completed stills can be returned as MCP images using `includePreview`.

Detached workers preserve jobs after a client disconnects. A local loopback socket serializes workers to limit concurrent resource use. Job metadata is saved under the project's `.engine/jobs/`; shared worker state defaults to the engine's `.cache/`, configurable with `VIDEO_ENGINE_RUNTIME`. Failed or interrupted jobs can be retried when their original project revision remains current.

## Stage and compare edits

`draft_stage` validates the same operation batch accepted by `edit_apply` and returns a draft ID with a diff. The staged snapshot retains generated clip IDs and the base revision. Use `draft_inspect` with `includeTimeline: true` to inspect its compiled frames. `draft_list` shows which proposals can still be applied.

Send the draft ID and current `expectedRevision` to `preview_render`. Use `draft_apply` to save that exact snapshot as one new revision. If the project advances, stage an updated draft against its current revision. `draft_delete` removes a saved proposal.

`revision_compare` summarizes differences between two saved revisions, including clip changes, graphics, captions and duration. To render an older edit, send that saved `revision` and the current `expectedRevision` to `preview_render`. Select either a draft ID or a saved revision per preview. Draft and revision diffs describe the engine timeline. Independent composition code can render a different edit.

## Deliver and move a project

Use `export_render` for a finished MP4 and optionally choose `preset` of `vertical`, `horizontal` or `square`. A preset preserves the output frame clock and uses `contain` by default. Use `fit: "cover"` with a preset to fill the new canvas. Preview the framing with the same `preset` and `fit` in `preview_render`. `export_subtitles` writes the compiled cue text and timing, including when burned-in captions are disabled. `export_timeline` writes a native OpenTimelineIO document with editable media clips, gaps, transition timing and audio placement. Its result lists what the receiving editor may need to rebuild. [Delivery guide](delivery.md)

`project_bundle` packages the current saved revision and registered originals into a new local `bundleDir`. The package includes saved transcripts, custom properties, supported static custom modules and declared public media. Public media includes the targets of symlinks visible to the renderer. Review what the bundle contains before sharing it.

`project_open_bundle` starts a job to verify the files and open them as a separate editable project. Poll `job_get` using the `projectDir` and job `id` returned when it starts. The completed `result.projectDir` is the editable destination. Review the returned limitations if custom code relies on external paths, network resources or runtime imports. Earlier revisions, jobs and finished exports stay with their original project.

`media_relink` repairs moved originals in one revision. Supply a `replacements` entry for each missing asset and the current `expectedRevision`. Each replacement must match its recorded SHA-256. The asset IDs, transcript timing and cut ranges carry forward with the verified files.

## Map takes inside one source recording

`media_index` works on the original source asset, including a single uninterrupted recording that contains every attempt. It does not require separate files or changes of camera angle. It leaves the saved edit, source file and revision history unchanged.

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 3,
  "assetId": "camera",
  "intervalSeconds": 15,
  "maxThumbnails": 120
}
```

This is an asynchronous job. Read `job_get` for its `indexId`, counts and cache status. Then read `media_index_get` with that ID to inspect source passages, possible-retake groups and timestamped contact-sheet pages. Each entry links back to original asset IDs, word IDs and source seconds. Use its source-preview hints with `source_preview` and the current project revision to compare actual delivery.

The text map uses an existing transcript. Run `transcribe` or `transcript_import` first when spoken take grouping is needed. Pauses, sentence endings and nearby repeated phrases can suggest separate passages or restarts. Candidate groups identify possible alternatives; they do not choose a better take, remove speech or certify that a restart occurred. Timing and transcript errors can affect the suggestions.

Video maps sample across the recording and near attempted passages. They adapt sampling when needed to keep at most `maxThumbnails` images. The default is 120, configurable from 6 to 240; `intervalSeconds` supports 1 to 120 seconds. Samples are representative source previews, not a claim that every visual scene change has been detected. Contact sheets keep their source timestamp labels and are returned as bounded JPEG pages through MCP. Audio assets receive a text map without image previews.

`media_index_get` and `media_search` support `offset` and `limit` (default 20, maximum 50). `sheetPage` selects a contact sheet independently of the text page. Set `includePreview: false` to read metadata without inline images. `media_search` searches words actually present in the transcript and returns source ranges plus possible alternatives; it does not perform semantic image search. Match `text` and `wordIds` identify matching source entries, while `contextText` provides surrounding speech separately.

Indexes are private derived files under `.engine/indexes/`. Cache identity includes the source content fingerprint, transcript words and timings, asset/project identity, sampling options and algorithm version. Normal timeline edits can reuse the same map. Changed source media or transcript makes an old map stale; build a new index before using it. Missing transcripts are reported explicitly: video receives a visual-only map, while audio receives metadata only. Neither triggers a hidden model download or transcription call. Cancellation removes partial work. No original media is copied into the index.

## Saved color controls

Save a correction on a source image/video with `set_asset_color`. Engine-rendered main clips and media overlays using that asset inherit it. Use `set_clip_color` for a main-clip override. The controls participate in normal edit revisions and undo.

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 3,
  "operations": [
    {"type": "set_asset_color", "assetId": "camera", "patch": {"brightness": 1.1, "temperature": -0.2}},
    {"type": "set_clip_color", "clipId": "take-2", "patch": {"brightness": 1.2}}
  ]
}
```

| Color control | Default | Range or meaning |
| --- | --- | --- |
| `enabled` | `true` | Apply the resolved correction; `false` bypasses it |
| `brightness` | `1` | Display-brightness multiplier, from `0` to `3` |
| `contrast` | `1` | Contrast multiplier, from `0` to `3` |
| `saturation` | `1` | Color-intensity multiplier, from `0` to `3`; `0` gives grayscale |
| `temperature` | `0` | Relative cool/warm adjustment, from `-1` to `1`; positive values warm the image |
| `tint` | `0` | Relative green/magenta adjustment, from `-1` to `1`; positive values shift toward magenta |

These are relative display controls. Temperature and tint apply modest RGB channel gains, followed by brightness, contrast and saturation. Existing projects resolve to neutral settings. Corrections apply directly to source image/video elements, with the rest of the composition retaining its own colors.

Settings resolve in the order defaults, asset, then clip. A clip field replaces the inherited value. For example, clip brightness `1.2` replaces source brightness `1.1`. Other fields keep inheriting. Set a field to `null` in a patch to remove that local override, or use `patch: null` to clear all local controls. Set clip `enabled: false` to bypass the complete inherited correction. Splitting a clip preserves its overrides.

Stored `asset.color` and `clip.color` objects contain partial controls. `project_inspect` returns them, and its optional compiled timeline contains the fully resolved settings. Audio-only assets reject color controls.

To compare the result, call `color_preview` with the current revision and an output `frame`. Both images use that same frozen edit, frame and scale. `frame` defaults to `0`; `scale` defaults to `0.5` and supports `0.1` to `1`. The before image bypasses saved engine color controls. Read the returned job through `job_get` for `result.before` and `result.after`, each containing a PNG path and render metadata. MCP includes a labeled image for each PNG under 5 MB unless `includePreview: false` is set. Comparison files are stored under the project's ignored `.engine/color-previews/` directory, and cancellation removes incomplete comparisons.

Normal previews and exports use the same corrections. `source_preview` and source-index thumbnails show the source before these saved adjustments. Captions, text overlays and generated custom graphics keep their own colors. Custom-layer code that directly draws its own media URLs controls those elements itself. Engine color controls require the built-in composition or custom `mode: "layer"`; independent compositions with active saved color controls return `UNSUPPORTED_CUSTOM_COLOR` so they can be adapted explicitly. Neutral independent compositions retain their existing behavior.

## Automatic audio leveling and manual adjustments

Automatic loudness finishing is opt-in. Enable it at project creation with `audio: {"enabled": true}` or save settings with `edit_apply`.

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 3,
  "operations": [
    {"type": "set_audio", "patch": {"enabled": true}},
    {"type": "set_clip_audio", "clipId": "take-2", "patch": {"gainDb": -3}}
  ]
}
```

`project_inspect` returns the current audio settings. These edits use the same revision checks, atomic batches and undo history as other operations. Existing projects without audio settings retain their previous sound.

| Project `audio` control | Default | Range or meaning |
| --- | --- | --- |
| `enabled` | `false` | Enable automatic main-track matching and complete-mix finishing |
| `targetLufs` | `-16` | Target loudness, from `-36` to `-9` |
| `truePeakDb` | `-1.5` | Maximum encoded output peak, from `-9` to `-0.5` dBTP |
| `strength` | `1` | Main-track matching strength, from `0` to `1` |
| `maxGainDb` | `9` | Automatic boost limit, from `0` to `24` dB; also bounds take-matching adjustments |
| `voiceGainDb`, `musicGainDb`, `effectsGainDb` | `0` each | Relative gain for the respective audio role, from `-24` to `24` dB |
| `outputGainDb` | `0` | Overall adjustment after calculating target gain, from `-24` to `24` dB |
| `ducking` | Off | Lower the music bus in response to the voice signal |
| `denoise` | Off | Reduce steady background noise in the voice bus |

Use `outputGainDb` to adjust overall loudness when automatic finishing is enabled. Use role gains for relative balance. Version 3 applies all three role gains even with finishing off, including a `voiceGainDb` previously saved in an older project.

Main clips default to `voice`. Audio and video overlays default to `effects`. Set `audio.role` to `music` on a music bed so music gain and ducking affect it. Custom-layer audio enters the effects stem during role-based mixing.

Use `set_clip_audio` for an individual clip or include `audio` on a clip or overlay. `gainDb` ranges from `-24` to `24` and multiplies the base `volume` together with role gain. `muted` silences the item, and `leveling: false` exempts a main voice clip from automatic matching. `fadeIn` and `fadeOut` are durations in seconds. An `envelope` is an ordered array of `{time, value}` points with local audio seconds and amplitude multipliers from `0` to `8`. The engine interpolates between points. Set `patch: null` to reset a clip's audio overrides.

Set `ducking.enabled` with optional `amountDb` from `0` to `24` (default `10`), `attack` from `0.005` to `2` seconds (default `0.08`), `release` from `0.01` to `5` seconds (default `0.3`) and `thresholdDb` from `-60` to `0` (default `-32`). Set `denoise.enabled` and choose `amount` from `0` to `1` (default `0.35`). Both process the full mix timing before a preview slice. Role gains, manual changes, ducking and denoise each operate independently of automatic loudness finishing.

Automatic take matching measures main clips assigned to `voice` and applies a bounded constant gain. Nearby source fragments share an adjustment. Short, silent or unmeasurable spans skip automatic take gain. Audio analysis measures signal levels. Assign the appropriate role to music, effects and any non-speech main clips.

Moving previews and exports that use finishing or role-based stem mixing render the complete composition's audio first. Floating-point intermediates preserve mixing headroom. With finishing enabled, one constant gain approaches the requested loudness while reserving peak headroom. Short previews use a range from this complete master. If an exceptional AAC slice boundary exceeds the ceiling, rendering stops with an adjustment recommendation. Still images skip audio processing, and `source_preview` plays the original audio without edit processing.

Read the completed render job's `result.audio` for role and source-span gains. When enabled, `mix` describes ducking and denoise, and `master`, `encoded` and `peakSafety` describe finishing and the verified output. Peak protection and boost limits can make a target unreachable. Listen to the output as well as reading these measurements. The worker deletes temporary audio masters after rendering or cancellation.

Finishing, ducking and denoise support the built-in composition and custom `mode: "layer"`. For independent compositions, mix audio in the composition or adapt it to layer mode. The floating-point render bridge uses a POSIX shell and installed FFmpeg and is verified on macOS. Windows reports an unsupported-platform error for these processes.

## Review speech cuts

`review_cuts` reviews discontinuous joins in the engine timeline, including custom layer mode, without changing its project or revision. Contiguous splits of the same source with unchanged playback and layout are omitted. It returns a durable job ID; use `job_get` to read the completed report and preview paths.

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 3,
  "contextSeconds": 1,
  "offset": 0,
  "limit": 20,
  "renderPreviews": true
}
```

The report identifies each join in output frames and seconds, and both sides in original source time. It flags boundaries inside timestamped words, large audio-level changes and long silence near a join. Audio measurements use the rendered master, including music, overlays, volume and playback rate. They are cues for review, not proof of a clipped syllable or an unnatural edit.

Previews include approximately `contextSeconds` on each side, rounded to whole frames and clamped to the composition bounds. The default is one second per side; supported values are 0.25 to 3 seconds. Reviews are paginated: `offset` starts at zero and `limit` defaults to 20, with a maximum of 50 joins per job. Continue with the returned `nextOffset` when `hasMore` is true. This bounds rendering work on long videos.

The default audio checks compare 150 ms RMS windows and flag level changes of at least 12 dB when both sides are above the -45 dBFS silence floor. Quiet gaps of at least 0.4 seconds are flagged. Stereo channels are measured by energy, preserving opposite-phase audio. Reports mark truncated measurement windows, silence that reaches a preview edge and neighboring cuts that limit attribution. These fixed heuristics describe the mixed master; they do not classify speech or intentional pauses.

Use `renderPreviews: false` for transcript timing review without rendering or audio analysis. Missing transcripts, absent audio and measurements limited by preview context are reported explicitly. Review files stay under the project's ignored `.engine/reviews/` directory. Cancellation preserves the original edit and removes incomplete review output.

Custom motion registered with `mode: "layer"` shares the engine clock and is supported by cut review. Independent standalone compositions can use different cuts, so those still return `UNSUPPORTED_CUSTOM_REVIEW` until adapted. Review covers engine-owned main clips and the final mixed audio. It does not discover edits made inside custom layer content or prove the main footage remains visible beneath graphics.

## Edit operations

`edit_apply` accepts a batch of up to 1,000 operations:

| Operation `type` | Required fields |
| --- | --- |
| `set_clips` | `clips` to replace the main timeline |
| `insert_clip` | Zero-based `index` and complete `clip` |
| `replace_clip` | Existing `clipId` and complete replacement `clip` |
| `insert_gap` | Zero-based `index`, output `duration` in seconds, optional `id` |
| `set_gap` | Gap `clipId` and output `duration` in seconds |
| `set_transition` | Incoming `clipId`, `transition` with `type` and `duration`, or `null` to remove |
| `set_clip_visual` | `clipId`, `patch` with `fit`, `position`, `crop`, `focus` or `motion` |
| `split_clip` | `clipId`, `sourceTime`; optional `newClipId` |
| `remove_clip` | `clipId` |
| `trim_clip` | `clipId`, `sourceStart`, `sourceEnd` |
| `reorder_clips` | `clipIds`: every retained clip exactly once |
| `delete_source_range` | `assetId`, `start`, `end` in source seconds |
| `delete_words` | `assetId`, `wordIds` |
| `upsert_overlay` | Complete `overlay` object |
| `remove_overlay` | `overlayId` |
| `set_captions` | `patch` with caption-style fields or explicit `cues` |
| `set_caption_cues` | `cues` with `{id, text, start, end}` entries, or `null` to regenerate from words |
| `set_settings` | `patch` with output settings |
| `set_audio` | `patch` with mix, leveling, finishing, ducking and denoise settings |
| `set_clip_audio` | `clipId`, `patch` with audio role, gain, trims, offset, fades or envelope, or `null` to reset |
| `set_asset_color` | `assetId`, `patch` with source color controls; `null` resets all local controls |
| `set_clip_color` | `clipId`, `patch` with color overrides; `null` restores full inheritance |
| `set_custom` | `custom` composition metadata, or `null` to use the built-in composition |

A media clip has `id`, `assetId`, `sourceStart` and `sourceEnd`. Optional `playbackRate`, `volume` and `fit` default to `1`, `1` and `"cover"`. The `contain` fit keeps the full picture visible. Optional `position` contains pixel values `{x, y, width, height}`. Optional `color` contains source-color overrides. A gap uses `{id, type: "gap", duration}` instead of source media and displays the project background.

An overlay has `id`, `type`, `start` and `end`. Its type is `text`, `image`, `video` or `audio`. Text overlays need `text`, and media overlays need a matching `assetId`. Media overlays accept `sourceStart` and `volume`. The `style` object supports positioning, size, opacity, typography and `fadeInFrames`/`fadeOutFrames`. Audio and video overlays accept an `audio` role and volume controls. Their source timing follows the overlay's own `assetId`, `sourceStart`, `start` and `end`.

Output settings are `width`, `height`, integer `fps` from 1 to 120, and `background`. Caption fields are `enabled`, `fontSize`, `color`, `highlightColor`, `bottom`, `wordsPerPage` and optional `cues`.

This request deletes a source interval and attaches a styled callout to a retained word.

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 3,
  "operations": [
    {"type": "delete_source_range", "assetId": "camera", "start": 2.1, "end": 3.4},
    {"type": "set_captions", "patch": {"enabled": true, "wordsPerPage": 4}},
    {"type": "upsert_overlay", "overlay": {
      "id": "callout", "type": "text", "preset": "callout", "text": "Look here", "start": 0, "end": 2,
      "anchor": {"assetId": "camera", "wordId": "w42", "offset": 0.1},
      "style": {"fontSize": 56, "top": 100, "height": 120, "fadeInFrames": 5}
    }}
  ]
}
```

`delete_source_range` affects every retained occurrence of that source interval. Use clip-specific trimming or removal to change one occurrence. Overlay positions and durations are not automatically inferred from spoken content.

## Transitions and split audio cuts

Put an incoming transition on the second clip with `set_transition`. Its type is `crossfade`, `dip` or `wipe`. Duration is in output seconds, with at least two frames and at most 30 seconds. The transition uses the retained end of the first clip and the retained start of the second. The clips overlap, which shortens their combined time by the overlap duration. The overlaps at both ends of a clip must fit inside its duration. Use a gap to insert time on the output clock.

Use `set_clip_audio` to start audio ahead of picture or carry it past a cut. `sourceStart` and `sourceEnd` select the audio range in source seconds. Supply both together. `assetId` optionally selects a separate registered sound source. `offset` moves the sound relative to the picture start in output seconds. A negative value starts it earlier, and time before frame zero is trimmed. The clip's playback rate also applies to its sound. Late audio can extend the output duration.

For example, `{"assetId":"recorded-voice","sourceStart":1.2,"sourceEnd":3.4,"offset":-0.2,"fadeIn":0.05}` starts the selected voice 0.2 seconds before the picture. Inspect `audioFrom`, `audioDurationInFrames`, `audioSourceFrame` and `audioAssetId` in the compiled timeline. Sound following its picture crossfades across an overlapping join. Independently placed sound uses its saved fades and volume envelope. Use the audio source bounds to trim replacement sound. `delete_words` cuts main media ranges.

## Reframe and animate

`set_clip_visual` accepts `position`, `fit`, `crop`, `focus` and `motion`. Use `null` on a field to clear its override. A `crop` sets fractions to remove from the left, right, top or bottom and must leave visible picture. A `focus` sets normalized `x` and `y` from `0` to `1` for object positioning. The default focus is the center. `cover` uses the available canvas, and `contain` shows the whole picture inside it.

Set `motion` on a main visual clip or overlay using any of `x`, `y`, `scale`, `rotation` and `opacity`. Each control takes ordered `{time, value, easing?}` points. Time is in seconds from the item's output start. Position values use pixels, rotation uses degrees, scale is a multiplier, and opacity is `0` to `1`. `linear`, `easeInOut` and `hold` specify the curve from that point toward the next. For example, `{"scale":[{"time":0,"value":1,"easing":"easeInOut"},{"time":1,"value":1.12}]}` makes a slow zoom over the first second.

`graphic_presets` lists `title`, `lower_third` and `callout`. Set `preset` on a text overlay and use `style` or `motion` to customize it. Standard graphics follow the engine clock. Use a custom layer for more involved animation.

## Edit caption cues

Source words from the main voice clips are retimed into automatic caption pages. With split audio, the pages follow its selected source and output placement. To change wording, line breaks or display timing, send `set_caption_cues` with ordered cues containing `id`, `text`, `start` and `end`. Cue times are output seconds. Each cue needs at least one output frame, and cues cannot overlap. Use a newline in `text` for a new line.

Manual cues are fixed to output time. After changing cuts, review their timing or send `cues: null` to return to automatic pages. An empty array gives no cues. The source transcript and its stable word IDs continue to drive word-based cuts and anchors. Inspect `timeline.captionCues` for the displayed cues and `timeline.captions` for the retimed source words. SRT and VTT exports use the compiled cue timing. [Delivery guide](delivery.md)

## Source timing and word anchors

The manifest stores source seconds. Compilation rounds cumulative output boundaries onto one integer frame clock to prevent duration drift across cuts. Automatic captions follow retained voice ranges, including repeats, reordering, independent audio timing and playback-rate changes.

Words retain stable IDs and original source times. Native point timestamps, where start equals end, compile as one-frame captions. Deleting a point-timed word raises a timing error because it has no measured speech interval.

An optional overlay `anchor` attaches it to a source word:

```json
{"assetId": "camera", "wordId": "w42", "offset": 0.1, "clipId": "optional-occurrence-id"}
```

The stored `end - start` supplies duration. The compiled start follows the edited word plus `offset`, clamped to zero. Removing the speech suppresses its overlay. The first edited occurrence is selected by default; `clipId` selects a specific occurrence. Omit `anchor` for absolute output timing.

Overlay and audible clip endpoints can extend the composition. Overlay-only titles, graphics and audio projects can have an empty main timeline.

## Version 2 import naming

The legacy project import tool is now `project_import_legacy`, and its JavaScript export is `importLegacyProject`. Version 1's branded tool and export names have been removed. Update integrations that call those names directly. Saved project files and supported `.aive` files keep their existing formats.

## Transcript and legacy project imports

`transcript_import` accepts word arrays, legacy transcript JSON or native whisper.cpp JSON. Plain word entries use `id` (optional), `text` or `word`, `start`, `end` and optional `confidence`. Times must be finite, nonnegative and ordered in source time.

`project_import_legacy` creates a new engine project from a version-1 `.aive`. It resolves a relative `videoPath` against the original project directory, preserves the full source transcript and keeps everything outside the union of explicit `deletedRanges`. Untranscribed lead-in, gaps and trailing footage survive unless explicitly cut. The original `.aive` and media remain unchanged.

Local transcription retains raw output and normalized words under `.engine/transcripts/`. Temporary extracted audio is removed. Small decoder overshoots can be bounded to the actual media duration and marked for timing review, with raw timings retained.

## Custom motion on the shared timeline

Use `mode: "layer"` for custom animation that follows the same footage cuts, captions and output clock. The engine renders the main clips and ordinary overlays, adds the custom layer, then draws captions above it. The engine determines composition dimensions, frame rate and duration from its saved timeline. A layer cannot supply a separate composition ID or clock.

Register a local React component module. It must export the layer and must not call `registerRoot()`:

```json
{
  "type": "set_custom",
  "custom": {
    "mode": "layer",
    "entryPoint": "/absolute/path/custom-motion.tsx",
    "publicDir": "/absolute/path/composition/public",
    "props": {"color": "#ffde59"}
  }
}
```

Example `custom-motion.tsx`:

```tsx
import {useCurrentFrame} from 'remotion';

export default function Motion({timeline, color}) {
  const frame = useCurrentFrame();
  const cue = timeline.captions.find(word => word.id === 'w42');
  if (!cue || frame < cue.startFrame || frame >= cue.endFrame) return null;
  return <div style={{position: 'absolute', top: 40, left: 40, color}}>
    Word-linked motion
  </div>;
}
```

The default export is selected unless `exportName` names another component. Components receive `{...custom.props, timeline}` with the compiled engine timeline taking precedence. Use its clip frames, caption word IDs and word-anchored overlay times to keep animation aligned after edits. React memo and forwardRef components are supported.

`review_cuts` uses exactly the same layer-enabled rendering path as previews and final exports. Reports identify their scope as `engine_main_timeline`. Audio level changes can be measured in the final mix even when the layer supplies audio. Silence is not classified when the engine cannot establish expected audio on both sides from its clips and registered overlays.

To adapt an older custom composition, extract its motion into a component, move primary footage cuts into engine clips, and register that component in layer mode. Remove its `registerRoot()` and independent `<Composition>` setup from the layer module. Existing project files are not converted automatically.

## Independent standalone compositions

Standalone mode remains available for existing Remotion projects that own their complete composition and timing. Omit `mode` or use `mode: "composition"`. Its entry point must call `registerRoot()`:

```json
{
  "type": "set_custom",
  "custom": {
    "entryPoint": "/absolute/path/composition/src/index.ts",
    "compositionId": "ExampleComposition",
    "publicDir": "/absolute/path/composition/public",
    "props": {}
  }
}
```

Standalone compositions receive `{...custom.props, timeline}`. The timeline contains compiled clips, captions, overlays and registered asset `src` URLs. Consume that timeline when engine edits should affect the composition. Existing code with hardcoded timing retains its behavior until adapted.

`custom.publicDir` is optional and must identify an absolute local directory. `staticFile()` and `getStaticFiles()` use token-protected loopback routes for inventoried files, including symlinked files and directories, without copying those media files. Unregistered local paths are not served. Custom composition code is trusted executable project code.

The render-only bridge pins Remotion and `@remotion/renderer` to **4.0.534**. It uses esbuild and a compatibility layer adapted from upstream render internals, without Studio, the Remotion CLI, Webpack or Rspack. A mismatched runtime or composition dependency declaration fails explicitly. Upgrade Remotion packages together and verify the bridge before adopting another version. Consult the repository's third-party notices for attribution and dependency licensing.

## Development checks

```sh
npm test
npm run check
```

`npm test` runs project, timing, migration and boundary checks. `npm run check` also enables real headless synthetic rendering and an MCP client workflow. Tests cover cuts, captions, word anchors, revisions, source previews, encoded frame counts and audio, custom motion, symlinked public media, cancellation and source preservation. Test media is generated in temporary directories.

Keep personal footage, projects, caches, models, credentials and generated exports outside the repository. The included ignore rules are a precaution; inspect staged files before committing.
