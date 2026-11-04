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

MCP hosts receive typed tool schemas. `node src/cli.mjs tools` also lists tool names and descriptions.

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
3. Read transcript words and inspect source previews before choosing cuts.
4. Apply edits using the current `expectedRevision`.
5. Run `review_cuts`, inspect the report and short join previews, then revise.
6. Validate the project and render a new final export.

Every successful edit batch creates a revision. Invalid batches and stale revisions leave the project unchanged. Restoring an earlier revision creates a new revision and preserves the intervening history.

Source files are never edited. Exports use new filenames and cannot replace an existing file or registered source. Built-in processing stays local and has no publishing or upload tools. Numerical checks establish timing and encoded properties; editorial quality and the final audiovisual result still need review.

## Available tools

| Tool | Main inputs and purpose |
| --- | --- |
| `engine_status` | Check local binaries, Node and the cached transcription model |
| `project_create` | `projectDir`, `name`, optional `width`, `height`, `fps` |
| `project_inspect` | `projectDir`, optional `includeTimeline` |
| `project_validate` | `projectDir`; validate timing and original-media fingerprints |
| `project_import_legacy` | `projectDir`, `path` to a version-1 `.aive`, optional `name` |
| `media_add` | `projectDir`, `expectedRevision`, local `path`, optional `addToTimeline` |
| `transcript_import` | `projectDir`, `expectedRevision`, `assetId`, local JSON `path` |
| `transcript_search` | `projectDir`, `assetId`, optional `query`, `offset`, `limit` |
| `transcribe` | `projectDir`, `expectedRevision`, `assetId`, optional `modelPath`, `language` |
| `edit_apply` | `projectDir`, `expectedRevision`, `operations` |
| `revision_list` | `projectDir` |
| `revision_restore` | `projectDir`, `expectedRevision`, target `revision` |
| `source_preview` | `projectDir`, `expectedRevision`, `assetId`, optional `kind`, `sourceStart`, `sourceEnd`, `scale` |
| `preview_render` | `projectDir`, `expectedRevision`, optional `kind`, `frame`, `fromFrame`, `toFrame`, `scale` |
| `export_render` | `projectDir`, `expectedRevision`, optional `outputPath`, `concurrency` |
| `review_cuts` | `projectDir`, `expectedRevision`; optional preview context, batch offset/limit and timing-only mode |
| `job_list` | `projectDir` |
| `job_get` | `projectDir`, `jobId`, optional `includePreview` |
| `job_cancel`, `job_retry` | `projectDir`, `jobId` |

Preview `kind` is `still` or `preview`. Frame ranges use output frames; source preview bounds use source seconds. Transcription and rendering return durable job IDs. Follow `job_get` until completion, failure or cancellation. Completed stills can be returned as MCP images using `includePreview`.

Detached workers preserve jobs after a client disconnects. A local loopback socket serializes workers to limit concurrent resource use. Job metadata is saved under the project's `.engine/jobs/`; shared worker state defaults to the engine's `.cache/`, configurable with `VIDEO_ENGINE_RUNTIME`. Failed or interrupted jobs can be retried when their original project revision remains current.

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
| `set_clips` | `clips`: replace the sequential main timeline |
| `split_clip` | `clipId`, `sourceTime`; optional `newClipId` |
| `remove_clip` | `clipId` |
| `trim_clip` | `clipId`, `sourceStart`, `sourceEnd` |
| `reorder_clips` | `clipIds`: every retained clip exactly once |
| `delete_source_range` | `assetId`, `start`, `end` in source seconds |
| `delete_words` | `assetId`, `wordIds` |
| `upsert_overlay` | Complete `overlay` object |
| `remove_overlay` | `overlayId` |
| `set_captions` | `patch` with caption-style fields |
| `set_settings` | `patch` with output settings |
| `set_custom` | `custom` composition metadata, or `null` to use the built-in composition |

A main clip has `id`, `assetId`, `sourceStart` and `sourceEnd`. Optional `playbackRate`, `volume` and `fit` default to `1`, `1` and `"cover"`. `fit` can also be `"contain"`. Optional `position` contains pixel values `{x,y,width,height}`.

An overlay has `id`, `type`, `start` and `end`. Its type is `text`, `image`, `video` or `audio`. Text overlays need `text`; other types need an appropriate `assetId`. Timed overlays support optional `sourceStart` and `volume`. The `style` object supports positioning, size, opacity, crop, typography and `fadeInFrames`/`fadeOutFrames`.

Output settings are `width`, `height`, integer `fps` from 1 to 120, and `background`. Caption fields are `enabled`, `fontSize`, `color`, `highlightColor`, `bottom` and `wordsPerPage`.

Example edit request:

```json
{
  "projectDir": "/absolute/path/video-project",
  "expectedRevision": 3,
  "operations": [
    {"type": "delete_source_range", "assetId": "camera", "start": 2.1, "end": 3.4},
    {"type": "set_captions", "patch": {"enabled": true, "wordsPerPage": 4}},
    {"type": "upsert_overlay", "overlay": {
      "id": "callout", "type": "text", "text": "Look here", "start": 0, "end": 2,
      "anchor": {"assetId": "camera", "wordId": "w42", "offset": 0.1},
      "style": {"fontSize": 56, "top": 100, "height": 120, "fadeInFrames": 5}
    }}
  ]
}
```

`delete_source_range` affects every retained occurrence of that source interval. Use clip-specific trimming or removal to change one occurrence. Overlay positions and durations are not automatically inferred from spoken content.

## Source timing and word anchors

The manifest stores source seconds without independently rounding every cut. Compilation rounds cumulative output boundaries onto one integer frame clock. This prevents accumulated duration drift across many cuts. Captions follow retained clips, including repeats, reordering and playback-rate changes.

Words retain stable IDs and original source times. Native point timestamps, where start equals end, compile as one-frame captions. Deleting a point-timed word raises a timing error because it has no measured speech interval.

An optional overlay `anchor` attaches it to a source word:

```json
{"assetId": "camera", "wordId": "w42", "offset": 0.1, "clipId": "optional-occurrence-id"}
```

The stored `end - start` supplies duration. The compiled start follows the edited word plus `offset`, clamped to zero. Removing the speech suppresses its overlay. The first edited occurrence is selected by default; `clipId` selects a specific occurrence. Omit `anchor` for absolute output timing.

Overlay endpoints extend the composition when needed. Overlay-only titles, graphics and audio projects can have an empty main timeline.

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
