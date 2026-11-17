import {spawn} from 'node:child_process';
import {run, toolEnv} from './media.mjs';

// Backpressure keeps a long export bounded to a few decoded frames per input.
export async function* decodedBlocks(args, blockSize, {signal, allowPartial = false} = {}) {
  signal?.throwIfAborted();
  const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', ...args, 'pipe:1'],
    {env: toolEnv, stdio: ['ignore', 'pipe', 'pipe']});
  let errorText = '', spawnError;
  child.stderr.on('data', chunk => {errorText = (errorText + chunk).slice(-2000);});
  child.once('error', error => {spawnError = error;});
  const closed = new Promise(done => child.once('close', done));
  const stop = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', stop, {once: true});
  let block = Buffer.allocUnsafe(blockSize), used = 0;
  try {
    for await (const chunk of child.stdout) {
      for (let offset = 0; offset < chunk.length;) {
        const copied = chunk.copy(block, used, offset, offset + blockSize - used);
        used += copied;
        offset += copied;
        if (used === blockSize) {
          yield block;
          block = Buffer.allocUnsafe(blockSize);
          used = 0;
        }
      }
    }
    const status = await closed;
    signal?.throwIfAborted();
    if (spawnError) throw spawnError;
    if (status !== 0) throw new Error('Could not decode the export: ' + errorText);
    if (used && !allowPartial) throw new Error('Incomplete decoded video frame.');
    if (used) yield block.subarray(0, used);
  } finally {
    stop();
    await closed;
    signal?.removeEventListener('abort', stop);
  }
}

const frameBytes = 108 * 192 * 3;
export function pictureFrames(path, signal) {
  return decodedBlocks(['-i', path, '-map', '0:v:0', '-an', '-vf', 'scale=108:192',
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo'], frameBytes, {signal});
}

function pictureDifference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export async function scanFrameGlitches(path, {fps, expectedFrames, signal}) {
  let previous, current, leftDifference, decodedFrames = 0, totalFindings = 0;
  const findings = [];
  for await (const next of pictureFrames(path, signal)) {
    if (current) {
      const rightDifference = pictureDifference(current, next);
      if (previous && Math.min(leftDifference, rightDifference) > 15 &&
          pictureDifference(previous, next) < .4 * Math.min(leftDifference, rightDifference)) {
        totalFindings++;
        const frame = decodedFrames - 1;
        if (findings.length < 100) findings.push({frame, seconds: frame / fps});
      }
      leftDifference = rightDifference;
    }
    previous = current;
    current = next;
    decodedFrames++;
  }
  if (!decodedFrames || (expectedFrames != null && decodedFrames !== expectedFrames)) {
    throw new Error('Decoded frame count does not match the encoded video metadata.');
  }
  return {decodedFrames, totalFindings, findings, truncated: totalFindings > findings.length};
}

// Decode the exact file whose frame number was reported. A fresh timeline render
// can be clean even when the saved MP4 contains a damaged frame.
export async function frameContext(path, frame, signal) {
  if (!Number.isSafeInteger(frame) || frame < 1) throw new Error('Choose an interior frame with two neighbors.');
  const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames',
    '-of', 'csv=p=0', path], {signal});
  const count = Number(stdout.trim());
  if (count > 0 && frame + 1 >= count) throw new Error('The requested frame and both neighbors must exist.');
  const graph = ['[0:v:0]scale=320:320:force_original_aspect_ratio=decrease,setsar=1,split=3[a][b][c]',
    ...['a','b','c'].map((label, i) => `[${label}]select=eq(n\\,${frame - 1 + i}),setpts=PTS-STARTPTS[v${i}]`),
    '[v0][v1][v2]hstack=inputs=3:shortest=1[out]'].join(';');
  const chunks = [];
  for await (const chunk of decodedBlocks(['-i', path, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1',
    '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'image2pipe'], 512 * 1024, {signal, allowPartial: true})) chunks.push(chunk);
  if (!chunks.length) throw new Error('The requested frame and both neighbors must exist.');
  return {frames: [frame - 1, frame, frame + 1], imageBase64: Buffer.concat(chunks).toString('base64')};
}
