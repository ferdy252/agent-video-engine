import {spawn} from 'node:child_process';
import {stat, realpath, access} from 'node:fs/promises';
import {constants, createReadStream} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {resolve, delimiter} from 'node:path';
import {homedir} from 'node:os';

// GUI-launched MCP hosts often omit Homebrew from PATH.
export const toolEnv = {...process.env, PATH: [...new Set([
  '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(delimiter),
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
])].join(delimiter)};

export function run(command, args, {signal, onData, maxOutput = 4 * 1024 * 1024, cwd} = {}) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn(command, args, {env: toolEnv, cwd, stdio: ['ignore', 'pipe', 'pipe']});
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      clearTimeout(killTimer);
      error ? reject(error) : resolvePromise(value);
    };
    let killTimer;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-maxOutput); onData?.(String(data), 'stdout'); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-maxOutput); onData?.(String(data), 'stderr'); });
    child.once('error', error => finish(error));
    child.once('close', (code, sig) => {
      if (signal?.aborted) return finish(Object.assign(new Error('Operation cancelled'), {code: 'CANCELLED'}));
      if (code !== 0) return finish(Object.assign(new Error(`${command} failed (${code ?? sig}): ${stderr.slice(-3000)}`), {code: 'PROCESS_FAILED'}));
      finish(null, {stdout, stderr});
    });
  });
}

export async function fileFingerprint(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error(`Source changed while reading: ${path}`);
  return `sha256:${hash.digest('hex')}`;
}

export function videoGeometry(video) {
  const rotation = Number(video?.side_data_list?.find(entry => entry.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const [sarWidth, sarHeight] = String(video?.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  return {width: video.width, height: video.height, rotation: Number.isFinite(rotation) ? rotation : 0,
    sampleAspectRatio: sarWidth > 0 && sarHeight > 0 ? sarWidth / sarHeight : 1};
}

export async function probeAsset(path, id = randomUUID()) {
  const absolute = await realpath(resolve(path));
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', absolute]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find(stream => stream.codec_type === 'video');
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  if (!video && !audio) throw new Error('The file contains no supported image, video or audio stream');
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const image = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i.test(absolute);
  const fraction = String(video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
  const fps = fraction[1] ? fraction[0] / fraction[1] : fraction[0];
  return {id, path: absolute, type: image ? 'image' : video ? 'video' : 'audio',
    duration: Number.isFinite(duration) ? duration : 0,
    ...(video ? {...videoGeometry(video), fps: Number.isFinite(fps) && fps > 0 ? fps : 30} : {}),
    hasAudio: Boolean(audio), fingerprint: await fileFingerprint(absolute)};
}

export async function assertAssets(project) {
  for (const asset of project.assets) {
    const current = await fileFingerprint(asset.path);
    if (asset.fingerprint && current !== asset.fingerprint) {
      throw Object.assign(new Error(`Source changed since import: ${asset.id}. Reimport it before rendering.`), {code: 'SOURCE_CHANGED'});
    }
  }
}

export async function doctor() {
  const checks = {};
  for (const tool of ['ffmpeg', 'ffprobe', 'whisper-cli']) {
    try { const result = await run(tool, [tool === 'whisper-cli' ? '--help' : '-version']); checks[tool] = {ok: true, version: (result.stdout || result.stderr).split('\n')[0]}; }
    catch (error) { checks[tool] = {ok: false, error: error.message}; }
  }
  const model = process.env.VIDEO_ENGINE_MODEL || resolve(homedir(), '.cache/whisper.cpp/ggml-medium.en.bin');
  try { await access(model, constants.R_OK); checks.model = {ok: true, path: model}; }
  catch { checks.model = {ok: false, path: model, error: 'No cached model. Supply VIDEO_ENGINE_MODEL. Models are never downloaded automatically.'}; }
  checks.node = {ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node};
  checks.mode = {ok: true, local: true, editorUI: false, uploads: false};
  return {ok: Object.values(checks).every(check => check.ok), checks};
}
