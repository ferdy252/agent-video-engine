import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {applyOperations} from './project.mjs';
import {jobDir, saveJob, runtimeDir, isCancelled} from './jobs.mjs';
import {assertAssets} from './media.mjs';
import {transcribeAsset} from './transcribe.mjs';

const [projectDir, id] = process.argv.slice(2);
const dir = jobDir(projectDir, id);
await writeFile(join(dir, 'pid'), String(process.pid));
let job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
const controller = new AbortController();
// The OS releases this exclusive loopback socket on every process exit,
// including SIGKILL. It cannot leave a stale lock file or lose a reaper race.
const lockPort = 49152 + createHash('sha256').update(runtimeDir).digest().readUInt16BE(0) % 10000;
let workerLock, saving = Promise.resolve();
function update(patch) {
  job = {...job, ...patch, updatedAt: new Date().toISOString()};
  const snapshot = structuredClone(job);
  saving = saving.then(() => saveJob(dir, snapshot));
  return saving;
}
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => controller.abort());
const cancelTimer = setInterval(async () => { if (await isCancelled(dir)) controller.abort(); }, 250);
cancelTimer.unref();
try {
  await mkdir(runtimeDir, {recursive: true});
  const queuedAt = Date.now();
  while (!workerLock) {
    controller.signal.throwIfAborted();
    if (Date.now() - queuedAt > 2 * 60 * 60 * 1000) throw Object.assign(new Error('Local worker stayed busy for two hours. Retry when the running job finishes.'), {code: 'QUEUE_TIMEOUT'});
    const candidate = createServer(socket => socket.destroy());
    try {
      await new Promise((ready, reject) => {
        candidate.once('error', reject);
        candidate.listen({host: '127.0.0.1', port: lockPort, exclusive: true}, ready);
      });
      workerLock = candidate;
    } catch (error) {
      candidate.close();
      if (error.code !== 'EADDRINUSE') throw error;
      await delay(300, undefined, {signal: controller.signal});
    }
  }
  await update({status: 'running', stage: 'Checking original assets', startedAt: new Date().toISOString()});
  await assertAssets(job.snapshot);
  const onProgress = (value, label) => {
    const progress = typeof value === 'object' ? value.progress : value;
    const stage = typeof value === 'object' ? value.stage : label;
    update({...(Number.isFinite(progress) ? {progress: Math.min(0.99, Math.max(0, progress))} : {}),
      ...(stage ? {stage} : {})}).catch(() => controller.abort());
  };
  let result;
  if (job.type === 'transcribe') {
    const asset = job.snapshot.assets.find(item => item.id === job.request.assetId);
    if (!asset) throw new Error('Unknown transcript asset');
    const output = await transcribeAsset(projectDir, asset, {...job.request, signal: controller.signal, onProgress});
    controller.signal.throwIfAborted();
    try {
      const project = await applyOperations(projectDir, {expectedRevision: job.revision,
        operations: [{type: 'set_transcript', transcript: output.transcript}]});
      result = {transcriptPath: output.transcriptPath, wordCount: output.transcript.words.length,
        cached: output.cached, applied: true, revision: project.revision,
        timingReviewWordIds: output.transcript.timingReviewWordIds || []};
    } catch (error) {
      if (!['STALE_REVISION', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      result = {transcriptPath: output.transcriptPath, wordCount: output.transcript.words.length,
        cached: output.cached, applied: false, message: 'Project changed. Import the saved transcript into the current revision.'};
    }
  } else if (job.type === 'review_cuts') {
    const {reviewCuts} = await import('./cut-review.mjs');
    result = await reviewCuts(job.snapshot, {...job.request, projectDir,
      outputDir: join(projectDir, '.engine/reviews', id), signal: controller.signal, onProgress});
  } else if (job.type === 'render') {
    const {renderProject} = await import('./render.mjs');
    let renderSnapshot = job.snapshot;
    if (job.request.sourcePreview) {
      const asset = job.snapshot.assets.find(item => item.id === job.request.assetId);
      if (!asset) throw new Error('Unknown source asset');
      const start = job.request.sourceStart ?? 0;
      const end = job.request.sourceEnd ?? (asset.type === 'image' ? start + 1 : Math.min(asset.duration, start + 5));
      renderSnapshot = {...job.snapshot, custom: undefined, transcripts: [], overlays: [],
        settings: {...job.snapshot.settings, width: asset.width || 640, height: asset.height || 360},
        captions: {...job.snapshot.captions, enabled: false}, clips: [{id: 'source-preview', assetId: asset.id,
          sourceStart: start, sourceEnd: end, playbackRate: 1, volume: 1, fit: 'contain'}]};
    }
    result = await renderProject(renderSnapshot, {...job.request, signal: controller.signal, onProgress});
  } else throw new Error(`Unsupported job type: ${job.type}`);
  await update({status: 'completed', progress: 1, stage: 'Finished', result, finishedAt: new Date().toISOString()});
} catch (error) {
  await update({status: controller.signal.aborted ? 'cancelled' : 'failed', stage: controller.signal.aborted ? 'Cancelled' : 'Failed',
    error: {code: controller.signal.aborted ? 'CANCELLED' : error.code || 'JOB_FAILED', message: error.message}, finishedAt: new Date().toISOString()});
} finally {
  clearInterval(cancelTimer);
  await saving;
  if (workerLock) await new Promise(done => workerLock.close(done));
}
