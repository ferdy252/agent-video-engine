import {mkdir, access, readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, isAbsolute, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {fileFingerprint, run, toolEnv} from './media.mjs';

const launcher = fileURLToPath(new URL('./rea-offline.py', import.meta.url));
const audioModels = [
  ['UVR-MDX-NET-Inst_HQ_3.onnx', '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc'],
  ['bandit-v2-multi.onnx', '319b6293f007e27b43026953ef80d88bb000cf52bbc5ffc382683c97445171e4'],
];

export async function analyzeReference(project, {assetId, outputDir, pythonPath, modelsDir, audioSeparation = false, ocr = false, signal, onProgress} = {}) {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || asset.type !== 'video') throw Object.assign(new Error('Reference analysis requires a registered video asset.'), {code: 'REFERENCE_ASSET_REQUIRED'});
  const python = pythonPath || process.env.VIDEO_ENGINE_REA_PYTHON;
  if (!python || !isAbsolute(python)) throw Object.assign(new Error('Set VIDEO_ENGINE_REA_PYTHON or supply pythonPath as the absolute path to a Python installation with rea-video.'), {code: 'REA_PYTHON_REQUIRED'});
  await access(python, constants.X_OK);
  const models = resolve(modelsDir || process.env.REA_VIDEO_MODELS || join(homedir(), '.cache/rea-video/models'));
  if (audioSeparation) {
    for (const [name, hash] of audioModels) {
      let actual;
      try { actual = await fileFingerprint(join(models, name)); } catch {}
      if (actual !== `sha256:${hash}`) throw Object.assign(new Error(`REA audio model ${name} is missing or has an unexpected checksum. Provision the verified model separately, or rerun without audio separation.`), {code: 'REA_MODEL_REQUIRED'});
    }
  }
  if (!isAbsolute(outputDir)) throw new Error('Reference output directory must be absolute.');
  await mkdir(dirname(outputDir), {recursive: true});
  await mkdir(outputDir);
  const prefsDir = join(outputDir, '.rea-home');
  await mkdir(prefsDir);
  const env = {...toolEnv, REA_VIDEO_HOME: prefsDir, REA_VIDEO_MODELS: models, REA_OCR_LANG: 'zh'};
  if (ocr) {
    try { await run(python, [launcher, '--engine-check-ocr'], {signal, env, terminateGroup: true}); }
    catch (error) {
      if (error.code === 'CANCELLED') throw error;
      throw Object.assign(new Error('REA OCR is unavailable or failed to initialize locally. Install its OCR dependency, or rerun with ocr:false and use the editor screen-text tool.'), {code: 'REA_OCR_UNAVAILABLE'});
    }
  }
  const args = [launcher, 'decompose', asset.path, '-o', outputDir, '--lang', 'en', '--no-vlm', '--no-asr', '--no-speakers', '--no-moments', '--no-survey', '--ocr-lang', 'zh',
    ...(audioSeparation ? [] : ['--no-stems']), ...(ocr ? [] : ['--no-ocr'])];
  onProgress?.(.1, 'Analyzing reference locally with REA');
  await run(python, args, {signal, env, terminateGroup: true});
  signal?.throwIfAborted();
  const after = await fileFingerprint(asset.path);
  if (asset.fingerprint && asset.fingerprint !== after) throw Object.assign(new Error('Reference source changed during analysis.'), {code: 'SOURCE_CHANGED'});
  for (const file of ['breakdown.json', 'report.html', 'VIDEO.md']) await access(join(outputDir, file), constants.R_OK);
  const breakdown = JSON.parse(await readFile(join(outputDir, 'breakdown.json'), 'utf8'));
  const stemStatus = !audioSeparation ? 'disabled' : !breakdown.stems?.ok ? 'unavailable' : breakdown.stems?.effects ? 'complete' : 'partial';
  return {kind: 'reference_analysis', assetId, sourceFingerprint: after, outputDir,
    breakdownPath: join(outputDir, 'breakdown.json'), reportPath: join(outputDir, 'report.html'),
    videoMdPath: join(outputDir, 'VIDEO.md'), audioSeparationRequested: audioSeparation, audioSeparationStatus: stemStatus, ocrRequested: ocr,
    ocrAvailability: ocr ? 'initialized_before_analysis' : 'disabled',
    limitations: ['REA output is analysis, not a verified editor handoff. Review reference frames and sound and distinguish observations from inferences.',
      'REA speech recognition and speaker separation are disabled; use the editor transcription separately.',
      ...(stemStatus === 'disabled' ? ['Separate voice, music and effects stems were not requested.'] :
        stemStatus === 'unavailable' ? ['REA did not produce voice and music stems; review the breakdown for the reason.'] :
          stemStatus === 'partial' ? ['REA produced voice and music stems but no separate effects stem.'] : []),
      ...(ocr ? ['OCR initialized before analysis; inspect the report for incomplete recognition.'] : ['REA on-screen text recognition was disabled.'])]};
}
