import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {access, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {bundle} from './bundle.mjs';
import {makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {compileTimeline} from './timeline.mjs';
import {validateProject} from './project.mjs';
import {assertAssets, run} from './media.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = {'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'};

const abortError = () => Object.assign(new Error('Render cancelled'), {name: 'AbortError'});
const checkAbort = (signal) => {if (signal?.aborted) throw abortError();};
const report = (onProgress, update) => {
  // Progress observers must not turn a committed export into a failed job.
  try {onProgress?.(update)?.catch?.(() => {});} catch {}
};

async function executable(path) {
  try {await access(path, constants.X_OK); return (await stat(path)).isFile();} catch {return false;}
}

// Always select a local executable. Passing no executable to Remotion would
// permit an implicit browser download, which is outside this local engine.
export async function findBrowserExecutable() {
  if (process.env.AGENT_VIDEO_BROWSER) {
    const path = resolve(process.env.AGENT_VIDEO_BROWSER);
    if (!await executable(path)) throw new Error('AGENT_VIDEO_BROWSER is not an executable file');
    return path;
  }
  const cacheRoots = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
  for (const cache of cacheRoots) {
    const entries = await readdir(cache).catch(() => []);
    for (const name of entries.filter((entry) => /^chromium-/.test(entry)).sort().reverse()) {
      for (const platform of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac', 'chrome-linux', 'chrome-linux64', 'chrome-win']) {
        for (const binary of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'Chromium.app/Contents/MacOS/Chromium', 'chrome', 'chrome.exe']) {
          const path = join(cache, name, platform, binary);
          if (await executable(path)) return path;
        }
      }
    }
  }
  const installed = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32' ? [
      join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(process.env.LOCALAPPDATA ?? homedir(), 'Google/Chrome/Application/chrome.exe')]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const path of installed) if (await executable(path)) return path;
  throw new Error('No local Chromium browser found. Set AGENT_VIDEO_BROWSER to an installed Chrome executable.');
}

/** Serve only exact registered asset routes on loopback, with byte ranges for seeking. */
export async function startAssetServer(assets, {publicDir} = {}) {
  const token = randomBytes(24).toString('hex');
  const routes = new Map();
  const assetIds = new Set();
  const metadata = [];
  const publicFiles = [];
  for (const asset of assets) {
    if (assetIds.has(asset.id)) throw new Error(`Duplicate asset ${asset.id}`);
    assetIds.add(asset.id);
    if (!isAbsolute(asset.path)) throw new Error(`Asset ${asset.id} needs an absolute local path`);
    const path = await realpath(asset.path);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Asset ${asset.id} is not a regular file`);
    const route = `/${token}/assets/${encodeURIComponent(asset.id)}/${encodeURIComponent(basename(path))}`;
    if (routes.has(route)) throw new Error(`Duplicate asset ${asset.id}`);
    routes.set(route, {path, size: info.size});
    metadata.push({asset, route, path});
  }
  if (publicDir !== undefined) {
    if (!isAbsolute(publicDir)) throw new Error('custom.publicDir must be an absolute local directory');
    const directory = await realpath(publicDir);
    if (!(await stat(directory)).isDirectory()) throw new Error('custom.publicDir must identify a directory');
    const walk = async (folder, name, ancestors) => {
      const canonical = await realpath(folder);
      if (ancestors.has(canonical)) return;
      if (ancestors.size > 32) throw new Error('custom.publicDir has too many nested directory levels');
      const next = new Set([...ancestors, canonical]);
      for (const entry of await readdir(folder)) {
        if (entry.startsWith('.')) continue;
        const relative = name ? `${name}/${entry}` : entry;
        const target = join(folder, entry);
        const info = await stat(target).catch((error) => {if (error.code === 'ENOENT') return null; throw error;});
        if (!info) continue;
        if (info.isDirectory()) await walk(target, relative, next);
        else if (info.isFile()) {
          if (publicFiles.length >= 10000) throw new Error('custom.publicDir exceeds 10000 files. Register a smaller media directory.');
          const path = await realpath(target);
          const route = `/${token}/public/${relative.split('/').map(encodeURIComponent).join('/')}`;
          routes.set(route, {path, size: info.size});
          publicFiles.push({name: relative, route, path, sizeInBytes: info.size, lastModified: Math.floor(info.mtimeMs)});
        }
      }
    };
    await walk(directory, '', new Set());
  }
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {response.writeHead(405, {Allow: 'GET, HEAD'}); response.end(); return;}
    const entry = routes.get((request.url ?? '').split('?')[0]);
    if (!entry) {response.writeHead(404); response.end(); return;}
    const headers = {'Content-Type': contentTypes[extname(entry.path).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'};
    let start = 0, end = entry.size - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, {'Content-Range': `bytes */${entry.size}`}); response.end(); return;
      }
      if (match[1]) {start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;}
      else start = Math.max(0, entry.size - Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= entry.size) {
        response.writeHead(416, {'Content-Range': `bytes */${entry.size}`}); response.end(); return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${entry.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    response.writeHead(request.headers.range ? 206 : 200, headers);
    if (request.method === 'HEAD' || entry.size === 0) {response.end(); return;}
    const stream = createReadStream(entry.path, {start, end});
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  server.on('connection', (socket) => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  await new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveStart);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    assets: metadata.map(({asset, route}) => {const {path: _privatePath, ...safe} = asset; return {...safe, src: origin + route};}),
    sourcePaths: [...new Set([...metadata, ...publicFiles].map(({path}) => path))],
    staticBase: `${origin}/${token}/public`,
    staticFiles: publicFiles.map(({path: _path, route, ...file}) => ({...file, src: origin + route})),
    close: async () => {for (const socket of sockets) socket.destroy(); await new Promise((done) => server.close(done));},
  };
}

async function targetPath(outputPath, sources) {
  if (!isAbsolute(outputPath)) throw new Error('outputPath must be an absolute local path');
  await mkdir(dirname(outputPath), {recursive: true});
  const output = join(await realpath(dirname(outputPath)), basename(outputPath));
  if (sources.includes(output)) throw new Error('Output cannot replace a source asset');
  try {await lstat(output); throw new Error('Output already exists. Choose a new versioned outputPath.');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  return output;
}

function frameNumber(value, fallback, duration, label) {
  const frame = value ?? fallback;
  if (!Number.isInteger(frame) || frame < 0 || frame >= duration) throw new Error(`${label} must be an integer inside the composition`);
  return frame;
}

function outputDimensions(composition, scale, still) {
  let {width, height} = composition;
  if (!still) {
    // H.264 requires even dimensions. Remotion reduces the unscaled dimension
    // until its scaled value rounds to an even integer.
    while (width > 0 && Math.round(width * scale) % 2) width--;
    while (height > 0 && Math.round(height * scale) % 2) height--;
  }
  const result = {width: Math.round(width * scale), height: Math.round(height * scale)};
  if (result.width < (still ? 1 : 2) || result.height < (still ? 1 : 2)) throw new Error('scale produces an output that is too small');
  return result;
}

async function verifyOutput(file, {kind, dimensions, frames, fps, signal}) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {signal});
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video || video.width !== dimensions.width || video.height !== dimensions.height) {
    throw new Error('Rendered output dimensions do not match the requested composition');
  }
  if (kind !== 'still') {
    const [numerator, denominator = 1] = String(video.avg_frame_rate ?? video.r_frame_rate).split('/').map(Number);
    const actualFps = numerator / denominator;
    const duration = Number(video.duration ?? probe.format?.duration);
    if (Number(video.nb_frames) !== frames) throw new Error(`Rendered frame count mismatch: expected ${frames}, got ${video.nb_frames}`);
    if (!Number.isFinite(actualFps) || Math.abs(actualFps - fps) > 1e-6) throw new Error('Rendered frame rate mismatch');
    if (!Number.isFinite(duration) || Math.abs(duration - frames / fps) > 1 / fps + 1e-6) throw new Error('Rendered video duration mismatch');
    if (!audio) throw new Error('Rendered MP4 is missing its audio track');
    return {probe: 'passed', frames, duration, fps: actualFps, audio: true, ...dimensions};
  }
  return {probe: 'passed', frames: 1, ...dimensions};
}

/** One-shot headless render. Persistence, revisions and job state belong to the caller. */
export async function renderProject(project, options = {}) {
  const {kind = 'video', signal, onProgress} = options;
  if (!['video', 'preview', 'still'].includes(kind)) throw new Error('kind must be video, preview or still');
  if (typeof options.outputPath !== 'string') throw new Error('outputPath is required');
  if (!isAbsolute(options.outputPath)) throw new Error('outputPath must be an absolute local path');
  const extension = extname(options.outputPath).toLowerCase();
  if (kind === 'still' ? !['.png', '.jpg', '.jpeg'].includes(extension) : extension !== '.mp4') {
    throw new Error(kind === 'still' ? 'Still output must be PNG or JPEG' : 'Video output must be MP4');
  }
  const scale = options.scale ?? (kind === 'preview' ? .5 : 1);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw new Error('scale must be greater than zero and at most 2');
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be an integer from 1 to 8');
  checkAbort(signal);
  validateProject(project);
  await assertAssets(project);
  const timeline = compileTimeline(project);
  if ((!timeline.custom || timeline.custom.mode === 'layer') && timeline.durationInFrames < 1) {
    throw new Error('Add at least one clip or overlay before rendering');
  }
  const server = await startAssetServer(timeline.assets, {publicDir: timeline.custom?.publicDir});
  let work, browser;
  const {cancelSignal, cancel} = makeCancelSignal();
  const abort = () => {cancel(); if (browser) void browser.close({silent: true}).catch(() => {});};
  signal?.addEventListener('abort', abort, {once: true});
  try {
    checkAbort(signal);
    const output = await targetPath(resolve(options.outputPath), server.sourcePaths);
    work = await mkdtemp(join(dirname(output), '.agent-video-render-'));
    const partial = join(work, `render${extension}`);
    const custom = timeline.custom;
    const customMode = custom?.mode ?? 'composition';
    let customLayer;
    let entryPoint = join(engineRoot, 'src/remotion-entry.ts');
    if (custom) {
      if (!isAbsolute(custom.entryPoint)) throw new Error('Custom entryPoint must be an absolute local path');
      const customEntryPoint = await realpath(custom.entryPoint);
      if (!(await stat(customEntryPoint)).isFile()) throw new Error('Custom entryPoint is not a regular file');
      if (customMode === 'layer') customLayer = {entryPoint: customEntryPoint, exportName: custom.exportName ?? 'default'};
      else {
        entryPoint = customEntryPoint;
        if (typeof custom.compositionId !== 'string' || !custom.compositionId) throw new Error('Custom compositionId is required');
      }
    }
    const browserExecutable = await findBrowserExecutable();
    const inputProps = customMode === 'layer'
      ? {timeline: {...timeline, assets: server.assets}, customLayerProps: custom?.props ?? {}}
      : {...(custom?.props ?? {}), timeline: {...timeline, assets: server.assets}};
    const compositionId = custom && customMode !== 'layer' ? custom.compositionId : 'AgentVideo';
    report(onProgress, {stage: 'bundle', progress: 0});
    const serveUrl = await bundle({entryPoint, outDir: join(work, 'bundle'), customLayer,
      staticBase: server.staticBase, staticFiles: server.staticFiles,
      onProgress: (progress) => report(onProgress, {stage: 'bundle', progress: progress / 100})});
    checkAbort(signal);
    browser = await openBrowser('chrome', {browserExecutable, chromeMode: 'chrome-for-testing',
      chromiumOptions: {headless: true}, logLevel: 'error'});
    checkAbort(signal);
    const composition = await selectComposition({serveUrl, id: compositionId, inputProps,
      puppeteerInstance: browser, browserExecutable, chromeMode: 'chrome-for-testing', logLevel: 'error'});
    checkAbort(signal);
    if (customMode === 'layer' && ['fps', 'width', 'height', 'durationInFrames'].some((key) => composition[key] !== timeline[key])) {
      throw new Error('Custom layer changed the engine composition clock. Layers must use the supplied timeline.');
    }
    const dimensions = outputDimensions(composition, scale, kind === 'still');
    const common = {serveUrl, composition, inputProps, puppeteerInstance: browser,
      browserExecutable, chromeMode: 'chrome-for-testing', cancelSignal, scale, overwrite: false, logLevel: 'error'};
    let frame, frameRange;
    if (kind === 'still') {
      frame = frameNumber(options.frame, 0, composition.durationInFrames, 'frame');
      report(onProgress, {stage: 'render', progress: 0});
      await renderStill({...common, output: partial, frame, imageFormat: extension === '.png' ? 'png' : 'jpeg',
        ...(extension === '.png' ? {} : {jpegQuality: 90})});
    } else {
      const from = frameNumber(options.fromFrame, 0, composition.durationInFrames, 'fromFrame');
      const to = frameNumber(options.toFrame, kind === 'preview'
        ? Math.min(composition.durationInFrames - 1, from + Math.round(composition.fps * 5) - 1)
        : composition.durationInFrames - 1, composition.durationInFrames, 'toFrame');
      if (to < from) throw new Error('toFrame must be at or after fromFrame (inclusive)');
      frameRange = [from, to];
      await renderMedia({...common, outputLocation: partial, codec: 'h264', pixelFormat: 'yuv420p',
        frameRange, concurrency, crf: kind === 'preview' ? 25 : 18, audioBitrate: '192k',
        enforceAudioTrack: true, colorSpace: 'bt709',
        onProgress: (progress) => report(onProgress, {stage: 'render', ...progress})});
    }
    checkAbort(signal);
    const info = await stat(partial);
    if (!info.size) throw new Error('Renderer produced an empty output');
    report(onProgress, {stage: 'verify', progress: 0});
    const verification = await verifyOutput(partial, {kind, dimensions,
      frames: kind === 'still' ? 1 : frameRange[1] - frameRange[0] + 1, fps: composition.fps, signal});
    checkAbort(signal);
    // Catch original media replaced while a long render was in progress, too.
    await assertAssets(project);
    // Hard-link in the destination directory is atomic and refuses to overwrite
    // a file created after the initial existence check.
    await link(partial, output);
    report(onProgress, {stage: 'complete', progress: 1});
    return {outputPath: output, kind, revision: project.revision, bytes: info.size,
      compositionId, ...(custom ? {customMode} : {}), durationInFrames: kind === 'still' ? 1 : frameRange[1] - frameRange[0] + 1,
      fps: composition.fps, ...dimensions, verification,
      ...(frame === undefined ? {frameRange} : {frame})};
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (browser) await browser.close({silent: true}).catch(() => {});
    await server.close();
    if (work) await rm(work, {recursive: true, force: true});
  }
}
