#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {callTool, toolDefinitions} from './api.mjs';

try {
  const [command, input] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log('video-engine doctor | tools | <tool_name> <request.json|->\nUse npm start for the MCP stdio server.');
  } else if (command === 'tools') {
    console.log(JSON.stringify(toolDefinitions.map(({name, description}) => ({name, description})), null, 2));
  } else {
    let text = '{}';
    if (input === '-') {text = ''; for await (const chunk of process.stdin) text += chunk;}
    else if (input) text = await readFile(input, 'utf8');
    const result = await callTool(command === 'doctor' ? 'engine_status' : command, JSON.parse(text));
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({code: error.code || 'ENGINE_ERROR', message: error.message}));
  process.exitCode = 1;
}
