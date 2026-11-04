# agent-video-engine development

Read `README.md` for the public API, timing model and runtime requirements. This repository is a standalone headless editor and MCP server. Development must not depend on a particular user's parent workspace, installed skills, private media or project history.

## Architecture

- Keep one saved manifest, one source-linked edit model and one compiled output frame clock.
- Keep source media immutable. Reference it by asset ID and verify fingerprints before and after rendering.
- Use structured operations for ordinary edits. Custom compositions consume the compiled timeline when their output should follow engine edits.
- Prefer `custom.mode: "layer"` for new custom motion. It keeps the engine in control of the main clips and clock and supports cut review. Standalone composition mode preserves independent timing and requires adaptation before automatic join review.
- Preserve atomic revision checks, complete batch validation, revision history, cancellation and exports that refuse to overwrite files.
- Treat a returned job ID as queued work. Inspect the terminal job result before reporting success.
- Preserve native transcript timing and raw evidence. Never infer a missing speech duration merely to permit a cut.

## Runtime boundaries

Use local installed binaries and explicit local file paths. Do not introduce automatic browser or model downloads, cloud model providers, desktop shells, editor UI packages or always-running services. Custom composition code is trusted executable code; retain exact asset registration and token-protected local media routes.

Pin Remotion and its renderer together at `4.0.534` until the render bridge and real rendering checks support a coordinated update. Preserve third-party attribution. Do not replace the bridge with Studio or CLI dependencies as an incidental implementation shortcut.

## Verification

Run focused tests while developing, then run `npm run check` for changes to editing, rendering, worker behavior or MCP integration. The full check requires the local tools listed in the README. Explain unavailable checks rather than claiming they passed.

Use synthetic media generated under temporary directories. Cover real behavior, especially source-to-output timing, cancellation, encoded output, revision conflicts and original preservation. Do not require personal media, private folders, machine-specific credentials or downloaded models in tests.

Successful rendering and numerical checks do not establish editorial quality or continuous audiovisual review. Keep that distinction clear in tooling and documentation.

## Repository hygiene

Keep code, tests, lockfiles and required attribution in version control. Keep footage, editable user projects, exports, models, caches, jobs, local client configuration, environment files, tokens and backups out. Inspect staged files before publication. Use generic paths and examples in public documentation.
