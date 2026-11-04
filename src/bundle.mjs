import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir, stat, writeFile, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {VERSION} from 'remotion';

const require = createRequire(import.meta.url);
const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedVersion = '4.0.534';

async function checkProjectVersion(entryPoint) {
  let directory = dirname(resolve(entryPoint));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const declared = metadata.dependencies?.remotion || metadata.devDependencies?.remotion;
      if (declared && declared !== supportedVersion) {
        throw new Error(`Composition project declares Remotion ${declared}; this engine uses ${supportedVersion}. Migrate explicitly before rendering.`);
      }
      if (declared) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** A render-only bundle, with no dependency on Studio, CLI, Webpack or Rspack. */
export async function bundle({entryPoint, outDir, onProgress, staticBase, staticFiles = [], customLayer}) {
  if (VERSION !== supportedVersion || require('@remotion/renderer/package.json').version !== supportedVersion) {
    throw new Error(`The headless bridge requires Remotion and renderer ${supportedVersion}. Update and verify the bridge before upgrading.`);
  }
  await checkProjectVersion(entryPoint);
  if (customLayer) await checkProjectVersion(customLayer.entryPoint);
  await mkdir(outDir, {recursive: true});
  onProgress?.(0);
  const aliases = Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']
    .map((name) => [name, require.resolve(name)]));
  for (const name of ['remotion', 'remotion/no-react', 'remotion/version']) aliases[name] = fileURLToPath(import.meta.resolve(name));
  const contents = customLayer ? `import * as React from 'react';
import {Internals, registerRoot} from 'remotion';
import * as LayerModule from ${JSON.stringify(customLayer.entryPoint)};
import {createEngineRoot} from ${JSON.stringify(join(engineRoot, 'src/composition.tsx'))};
import ${JSON.stringify(join(engineRoot, 'src/render-bridge.tsx'))};
globalThis.React = React;
if (Internals.getRoot()) throw new Error("Layer modules must export a React component without calling registerRoot(). Use mode:'composition' for a standalone composition.");
const CustomLayer = LayerModule[${JSON.stringify(customLayer.exportName ?? 'default')}];
const componentType = CustomLayer && CustomLayer.$$typeof;
if (typeof CustomLayer !== 'function' && componentType !== Symbol.for('react.memo') && componentType !== Symbol.for('react.forward_ref')) {
  throw new Error(${JSON.stringify(`Custom layer export "${customLayer.exportName ?? 'default'}" must be a React component (function, memo or forwardRef).`)});
}
registerRoot(createEngineRoot(CustomLayer));`
    : `import * as React from 'react';\nimport ${JSON.stringify(entryPoint)};\nimport ${JSON.stringify(join(engineRoot, 'src/render-bridge.tsx'))};\nglobalThis.React = React;`;
  const built = await build({
    stdin: {contents,
      resolveDir: engineRoot, sourcefile: 'agent-video-entry.ts', loader: 'ts'},
    outfile: join(outDir, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife',
    target: 'chrome120', jsx: 'automatic', minify: true, sourcemap: 'linked', metafile: true,
    alias: aliases, nodePaths: [join(engineRoot, 'node_modules')],
    define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent',
    loader: {'.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.webp': 'file', '.gif': 'file',
      '.svg': 'file', '.mp4': 'file', '.webm': 'file', '.mov': 'file', '.mp3': 'file',
      '.wav': 'file', '.m4a': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.otf': 'file'},
  });
  if (Object.keys(built.metafile.inputs).some((file) => /node_modules[\\/]@remotion[\\/](studio|cli)[\\/]/.test(file))) {
    throw new Error('A custom composition imports Studio or CLI code. This engine accepts render-only compositions.');
  }
  const hasCss = await stat(join(outDir, 'bundle.css')).then(() => true).catch(() => false);
  const safeJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
  await writeFile(join(outDir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="icon" href="data:,">${hasCss ? '<link rel="stylesheet" href="bundle.css">' : ''}</head><body>
<script>
window.process={env:{...JSON.parse(window.remotion_envVariables||'{}'),NODE_ENV:'production'}};
window.siteVersion='11';window.remotion_version='${supportedVersion}';
window.remotion_staticBase=${staticBase ? safeJson(staticBase) : "new URL('./public',location.href).pathname"};window.remotion_staticFiles=${safeJson(staticFiles)};
window.remotion_publicPath='./';window.remotion_outputsBase=null;window.remotion_publicFolderExists=null;
window.remotion_numberOfAudioTags=0;window.remotion_audioLatencyHint='playback';
window.remotion_experimentalKeepAudioContextAlive=false;
window.remotion_sampleRate=window.remotion_sampleRate??48000;window.remotion_previewSampleRate=window.remotion_sampleRate;
window.remotion_audioEnabled=window.remotion_audioEnabled??true;window.remotion_videoEnabled=window.remotion_videoEnabled??true;
window.remotion_renderDefaults=null;window.remotion_editorName=null;
</script><div id="video-container"></div><script src="bundle.js"></script></body></html>`);
  onProgress?.(100);
  return outDir;
}
