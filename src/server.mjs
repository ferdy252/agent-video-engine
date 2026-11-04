#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readFile, stat} from 'node:fs/promises';
import {toolDefinitions} from './api.mjs';

const server = new McpServer({name: 'agent-video-engine', version: '1.1.0'}, {
  instructions: 'Local headless video editor. Inspect the project revision before changes. Import source footage by reference, use source-timed word IDs for edits, and inspect source/edited previews. Use review_cuts to flag transcript timing and mixed-audio risks at timeline joins and generate short review clips. Reviews never change the edit and are evidence for review, not a verdict on naturalness. Rendering, transcription and cut reviews are asynchronous: poll job_get. The engine performs deterministic edits; editorial decisions belong to the agent. No uploads, publication or model downloads. Custom Remotion compositions can be registered through set_custom for unique motion graphics. See the engine README for the operation schema.',
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
