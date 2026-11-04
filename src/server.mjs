#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readFile, stat} from 'node:fs/promises';
import {toolDefinitions} from './api.mjs';

const server = new McpServer({name: 'agent-video-engine', version: '2.1.0'}, {
  instructions: 'Local headless video editor. Inspect the project revision before changes. Import source footage by reference. For a recording with multiple takes in one file, transcribe or import source words, build media_index, then use media_index_get and media_search to compare possible alternative attempts through source_preview. Indexing never selects the best take or changes the recording. Use source-timed word IDs for edits and inspect source/edited previews. Use review_cuts to flag transcript timing and mixed-audio risks at timeline joins and generate short review clips. Reviews never change the edit and are evidence for review, not a verdict on naturalness. Rendering, transcription, source indexing and cut reviews are asynchronous: poll job_get. The engine performs deterministic edits; editorial decisions belong to the agent. No uploads, publication or model downloads. Register custom motion with set_custom mode="layer" to keep the engine in control of timing and allow cut review. Independent standalone compositions retain their own timing and require adaptation for automatic cut review. See docs/technical-reference.md for the operation schema.',
});
for (const tool of toolDefinitions) {
  server.registerTool(tool.name, {description: tool.description, inputSchema: tool.schema, annotations: tool.annotations}, async args => {
    try {
      const result = await tool.run(args);
      const content = [{type: 'text', text: JSON.stringify(result)}];
      if (tool.name === 'job_get' && args.includePreview !== false && result.status === 'completed' && result.result?.kind === 'still') {
        const path = result.result.outputPath, info = await stat(path);
        if (info.size < 5 * 1024 * 1024) content.push({type: 'image', mimeType: 'image/png', data: (await readFile(path)).toString('base64')});
      }
      if (tool.name === 'media_index_get' && args.includePreview !== false && result.contactSheet?.path) {
        const path = result.contactSheet.path, info = await stat(path);
        if (info.size < 5 * 1024 * 1024) content.push({type: 'image', mimeType: 'image/jpeg', data: (await readFile(path)).toString('base64')});
      }
      return {content, structuredContent: Array.isArray(result) ? {items: result} : result};
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: JSON.stringify({code: error.code || 'ENGINE_ERROR', message: error.message})}]};
    }
  });
}
const transport = new StdioServerTransport();
await server.connect(transport);
// Workers are detached with durable logs; closing the MCP connection does not lose jobs.
process.stdin.on('end', () => { server.close().finally(() => process.exit(0)); });
