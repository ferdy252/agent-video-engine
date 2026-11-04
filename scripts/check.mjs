import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..');
const tests = (await readdir(resolve(root, 'test'))).filter(file => file.endsWith('.test.mjs')).map(file => `test/${file}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
  cwd: root, env: {...process.env, AGENT_VIDEO_RENDER_SMOKE: '1', AGENT_VIDEO_INTEGRATION: '1'}, stdio: 'inherit',
});
child.once('error', error => {console.error(error.message); process.exitCode = 1;});
child.once('close', code => {process.exitCode = code || 0;});
