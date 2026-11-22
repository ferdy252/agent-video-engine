import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeReference} from '../src/reference-analysis.mjs';
import {fileFingerprint, run} from '../src/media.mjs';
import {setTimeout as delay} from 'node:timers/promises';

test('reference adapter runs offline, preserves source, and reports its actual outputs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'reference-analysis-'));
  try {
    const pkg = join(temp, 'rea_video');
    await mkdir(pkg);
    await writeFile(join(pkg, '__init__.py'), '');
    await writeFile(join(pkg, 'util.py'), 'def fetch(*args):\n    raise AssertionError("fetch not blocked")\n');
    await writeFile(join(pkg, 'cli.py'), `import os, sys, socket, pathlib\nfrom . import util\ndef main():\n    assert '--no-vlm' in sys.argv and '--no-stems' in sys.argv\n    assert '--no-asr' in sys.argv and '--no-speakers' in sys.argv\n    try:\n        socket.create_connection(('127.0.0.1', 1))\n        raise AssertionError('network allowed')\n    except OSError as e:\n        assert 'offline' in str(e)\n    try:\n        util.fetch('https://example.invalid', 'model')\n        raise AssertionError('download allowed')\n    except OSError as e:\n        assert 'offline' in str(e)\n    out = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])\n    (out / 'breakdown.json').write_text('{}')\n    for name in ('report.html', 'VIDEO.md'):\n        (out / name).write_text('test')\n    return 0\n`);
    const python = join(temp, 'fake-rea-python');
    await writeFile(python, `#!/bin/sh\nexport PYTHONPATH='${temp}'\nexec python3 "$@"\n`);
    await chmod(python, 0o755);
    const source = join(temp, 'source.mp4');
    await writeFile(source, 'test media');
    const fingerprint = await fileFingerprint(source);
    const project = {assets: [{id: 'reference', type: 'video', path: source, fingerprint}]};
    const outputDir = join(temp, 'analysis');
    const result = await analyzeReference(project, {assetId: 'reference', outputDir, pythonPath: python});
    assert.equal(result.audioSeparationRequested, false);
    assert.equal(result.audioSeparationStatus, 'disabled');
    assert.equal(result.ocrAvailability, 'disabled');
    assert.equal(result.sourceFingerprint, fingerprint);
    assert.equal(await readFile(result.reportPath, 'utf8'), 'test');
    assert.equal(await readFile(source, 'utf8'), 'test media');
    await assert.rejects(() => analyzeReference(project, {assetId: 'reference', outputDir, pythonPath: python}), {code: 'EEXIST'});
    await assert.rejects(() => analyzeReference(project, {assetId: 'reference', outputDir: join(temp, 'stems'), pythonPath: python, modelsDir: temp, audioSeparation: true}), {code: 'REA_MODEL_REQUIRED'});
    await assert.rejects(() => analyzeReference(project, {assetId: 'reference', outputDir: join(temp, 'other'), pythonPath: 'python'}), {code: 'REA_PYTHON_REQUIRED'});
    await assert.rejects(() => analyzeReference(project, {assetId: 'reference', outputDir: join(temp, 'ocr'), pythonPath: python, ocr: true}), {code: 'REA_OCR_UNAVAILABLE'});
  } finally { await rm(temp, {recursive: true, force: true}); }
});

test('cancelling an analysis process also stops its child processes', {skip: process.platform === 'win32'}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'reference-cancel-'));
  try {
    const ready = join(temp, 'ready'), stopped = join(temp, 'stopped');
    const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'yes');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'yes');setInterval(()=>{},1000)`;
    const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const task = run(process.execPath, ['-e', parentCode], {signal: controller.signal, terminateGroup: true});
    let available = false;
    for (let i = 0; i < 100; i++) { try { await access(ready); available = true; break; } catch { await delay(20); } }
    assert.ok(available, 'child started');
    controller.abort();
    await assert.rejects(task, {code: 'CANCELLED'});
    for (let i = 0; i < 100; i++) { try { await access(stopped); return; } catch { await delay(20); } }
    assert.fail('child did not receive cancellation');
  } finally { await rm(temp, {recursive: true, force: true}); }
});
