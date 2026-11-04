import {mkdir, readFile, writeFile, rename, open, readdir, access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadProject} from './project.mjs';
import {toolEnv} from './media.mjs';

export const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeDir = resolve(process.env.VIDEO_ENGINE_RUNTIME || join(engineRoot, '.cache'));
export const activeStatuses = new Set(['queued', 'running']);
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
export function jobDir(projectDir, jobId) {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('Invalid job ID');
  return join(resolve(projectDir), '.engine/jobs', jobId);
}
export async function saveJob(dir, job) {
  const temp = join(dir, `job-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(job, null, 2) + '\n');
  await rename(temp, join(dir, 'job.json'));
}
export async function startJob(projectDir, request) {
  const absolute = resolve(projectDir);
  const project = await loadProject(absolute);
  if (request.expectedRevision !== undefined && project.revision !== request.expectedRevision) {
    throw Object.assign(new Error('Project revision changed. Inspect the project and retry.'), {code: 'STALE_REVISION'});
  }
  const id = randomUUID(), dir = jobDir(absolute, id);
  await mkdir(dir, {recursive: true});
  const job = {id, projectDir: absolute, type: request.type, status: 'queued', progress: 0,
    stage: 'Waiting for local worker', createdAt: new Date().toISOString(), revision: project.revision,
    request, snapshot: project};
  await saveJob(dir, job);
  const log = await open(join(dir, 'worker.log'), 'a');
  try {
    const child = spawn(process.execPath, [join(engineRoot, 'src/worker.mjs'), absolute, id], {
      env: toolEnv, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    await writeFile(join(dir, 'pid'), String(child.pid));
    child.unref();
  } catch (error) {
    await saveJob(dir, {...job, status: 'failed', error: {code: 'START_FAILED', message: error.message}});
    throw error;
  } finally { await log.close(); }
  return summarize(job);
}
export function summarize(job) {
  const {snapshot, ...rest} = job;
  return rest;
}
export async function getJob(projectDir, id) {
  const dir = jobDir(projectDir, id);
  let job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
  if (activeStatuses.has(job.status)) {
    let pid = 0;
    try { pid = Number(await readFile(join(dir, 'pid'), 'utf8')); } catch {}
    if ((pid && !alive(pid)) || (!pid && Date.now() - Date.parse(job.createdAt) > 10000)) {
      // The worker may have committed its final result between our first read
      // and the liveness check. Never replace that result with a stale snapshot.
      job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
      if (activeStatuses.has(job.status)) {
        // A newly spawned worker publishes its own PID as its first operation.
        const currentPid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => '0'));
        if (!currentPid || !alive(currentPid)) {
          job = {...job, status: 'interrupted', stage: 'Worker stopped', finishedAt: new Date().toISOString(),
            error: {code: 'WORKER_STOPPED', message: 'Saved project and request are intact. Use job_retry to restart.'}};
          await saveJob(dir, job);
        }
      }
    }
  }
  return summarize(job);
}
export async function cancelJob(projectDir, id) {
  const job = await getJob(projectDir, id);
  if (activeStatuses.has(job.status)) await writeFile(join(jobDir(projectDir, id), 'cancel'), 'cancel\n');
  return {...job, cancelRequested: activeStatuses.has(job.status)};
}
export async function retryJob(projectDir, id) {
  const job = await getJob(projectDir, id);
  if (activeStatuses.has(job.status)) throw new Error('Job is still active');
  if (job.status === 'completed') throw new Error('Completed jobs cannot be retried. Start a new versioned render.');
  return startJob(projectDir, {...job.request, expectedRevision: job.revision});
}
export async function listJobs(projectDir) {
  const root = join(resolve(projectDir), '.engine/jobs');
  let ids;
  try { ids = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => getJob(projectDir, id)));
}
export async function isCancelled(dir) {
  try { await access(join(dir, 'cancel')); return true; } catch { return false; }
}
