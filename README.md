# AgentVideoEngine

A video editor that your AI agent operates through chat.

The editor runs on your computer. Your agent can cut footage, add captions and graphics, check edits and export a finished video. There is no separate editor window or timeline for you to operate.

You describe the result you want. The agent makes editing decisions and uses this app's tools to carry them out. The app provides the editing engine, saved project and video output.

## What it can do

- Cut, trim and rearrange footage, including cuts based on transcript words.
- Add captions, text, images, music and sound.
- Create custom motion graphics that follow the edit.
- Keep graphics attached to spoken words as the timing changes.
- Make still previews and short video previews for review.
- Flag potentially clipped words, sudden volume changes and long quiet gaps around cuts.
- Save edit history so earlier versions can be restored.
- Export a new video while preserving the original files.

These checks help find places to review. You still need to watch and listen to the finished video.

## Current status

**Developer preview.** The editing, rendering and agent connection have been tested on macOS using generated sample videos. Other operating systems have not been verified.

Setup currently requires some terminal use and separately installed tools. The app does not include its own AI assistant. You need a chat agent that supports MCP and local files. MCP is the connection that lets the agent use the editor's tools.

## Get started

You will need:

- Node.js 22 or newer.
- FFmpeg, including `ffmpeg` and `ffprobe`.
- An installed Chrome or Chromium browser to create the finished video.
- For local transcription only: the speech tool and model described in the [setup reference](docs/technical-reference.md#requirements-and-setup).

Download this project and open a terminal in its folder. If you use an AI coding agent, it can help with these setup steps.

Run:

```sh
npm ci
node src/cli.mjs doctor
```

The first command installs the app's dependencies. The second checks which local tools are available. It may report missing transcription tools even if you only want to use an existing transcript.

Then follow the [agent connection instructions](docs/technical-reference.md#mcp-connection). Your agent can start the editor when it needs it. Browser and speech-model downloads are handled separately.

## Try your first video

Keep your original footage in a local folder, connect your agent, and give it the file path and your editing brief. For example:

> Use this recording to make a shorter edit. Preserve my wording, remove the retakes we identify, add readable captions and show me a preview before the final export.

The agent can inspect the recording, build the edit and return previews. Tell it what to change, then review the final playback and sound before using the export.

For tool details, advanced graphics and troubleshooting, see the [technical reference](docs/technical-reference.md).

## Licensing

The source is public, but no reuse license has been selected for the app's original code. See [licensing](LICENSE) and the [third-party notices](THIRD_PARTY_NOTICES.md) before reusing or redistributing it.
