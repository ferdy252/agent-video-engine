# AgentVideoEngine

A video editor that your AI agent operates through chat.

Describe the video you want in chat. Your agent uses the editor on your computer to build a draft, show previews and export a finished video. Your project keeps links to the original recordings and saves a history of the edit.

## What it can do

- Find possible retakes inside one recording and preview the matching source ranges.
- Stage a draft, preview the exact changes and apply it as a saved revision. Compare or restore earlier versions.
- Cut by transcript words, insert pauses and blend neighboring clips. Start sound before the picture changes or let it continue afterward.
- Reframe footage, adjust its color and animate changes in position, size or opacity.
- Balance voice, music and effects. Lower music under speech and reduce mild background noise.
- Edit caption wording, line breaks and timing. Add reusable titles, name labels and callouts, or attach graphics to spoken words.
- Export vertical, wide or square video, subtitle files and an editable timeline for compatible editors.
- Move a project with its source media or reconnect a recording that moved.

These checks help find places to review. You still need to watch and listen to the finished video.

## Current status

**Developer preview.** The editing, rendering and agent connection have been tested on macOS using generated sample videos. Other operating systems have not been verified.

Setup uses a terminal and a chat agent that supports MCP and local files. MCP is the connection that gives your agent access to the editor's tools.

## Get started

You will need these local tools.

- Node.js 22 or newer.
- FFmpeg, including `ffmpeg` and `ffprobe`.
- An installed Chrome or Chromium browser to create the finished video.
- The speech tool and model if you want the engine to transcribe recordings. [Setup reference](docs/technical-reference.md#requirements-and-setup)

Download this project and open a terminal in its folder. If you use an AI coding agent, it can help with these setup steps.

Run these commands in the project folder.

```sh
npm ci
node src/cli.mjs doctor
```

The first command installs the app's dependencies. The second checks which local tools are available. It may report missing transcription tools even if you only want to use an existing transcript.

Your agent can start the editor when it needs it. Reconnect the MCP server after an update so your agent sees the new tools. [Agent connection instructions](docs/technical-reference.md#mcp-connection)

## Try your first video

Keep your original footage in a local folder and give your connected agent the file path and a brief.

> Use this recording to draft a shorter edit. Preserve my wording, remove the retakes we identify and add readable captions. Show me the draft before applying it. Then export a vertical version and an SRT subtitle file.

Review the preview and tell your agent what to change. Watch and listen to the final export before using it.

## All your takes in one recording

Keep recording the way you normally do. The agent can use the transcript to find pauses, restarts and repeated passages inside the same file. A saved map links those possible attempts to timestamps and picture previews.

The agent can search a line and preview its different deliveries before choosing cuts. Repeated wording suggests places to review.

## Adjust the sound through chat

Ask your agent to level voice across takes, lower music while you speak, or adjust one sound independently. You can also ask it to fade a sound in or out, move the sound ahead of a cut, or reduce mild background noise.

The agent saves those adjustments with the edit and uses the complete audio mix for previews and exports.

## Adjust the picture through chat

Ask your agent to brighten a recording, keep a person in frame, or slowly zoom in on a detail. A saved color correction can follow every cut from one recording or be adjusted clip by clip. Compare the same frame before and after to choose the look.

## Deliver or move the edit

Ask for an MP4 in the shape you need, an SRT or VTT subtitle file, or an editable OpenTimelineIO file. The timeline handoff carries media and cuts. Bring the finished MP4 to show the intended graphics, color and mix. [Delivery guide](docs/delivery.md)

Each moving preview and final MP4 gets a small quality report beside it. Before delivery, the agent can check the exact file against that report. The editor flags previews, changed files and finals below the selected resolution target. It keeps the original footage and does not silently resize a finished edit. These checks help prevent the wrong file being uploaded; you still need to review sharpness, cropping and playback.

Use a project bundle to move the editable engine project and its media to another machine. A bundle includes saved transcripts, custom settings and registered media. Review its contents before sharing. Your agent can also reconnect a moved file after verifying that its contents match the original. [Technical reference](docs/technical-reference.md)

## Licensing

The source is public, but no reuse license has been selected for the app's original code. See [licensing](LICENSE) and the [third-party notices](THIRD_PARTY_NOTICES.md) before reusing or redistributing it.
