import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {checkProjectVersion} from './bundle.mjs';
import {fileFingerprint} from './media.mjs';
import {createProjectFromSnapshot, mutateProject, validateProject} from './project.mjs';

const format = 'agent-video-engine-bundle';
const manifestName = 'bundle.json';
const localIgnore = '*\n';
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const enginePackage = new URL('../package.json', import.meta.url);
const inlineAssetExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.otf'];

function fail(message, code = 'INVALID_PROJECT_BUNDLE') {
  throw Object.assign(new Error(message), {code});
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${name} must be an absolute local path.`);
  return path.resolve(value);
}

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || /^[a-z]:/i.test(part))) {
    fail('The bundle contains an invalid relative file reference.');
  }
  return value;
}

async function newDirectoryPath(value, name) {
  const requested = absolutePath(value, name);
  await mkdir(path.dirname(requested), {recursive: true});
  return path.join(await realpath(path.dirname(requested)), path.basename(requested));
}

async function claimDirectory(directory, name) {
  try {await mkdir(directory, {mode: 0o700});}
  catch (error) {
    if (error.code === 'EEXIST') fail(`${name} already exists. Choose a new directory.`, 'OUTPUT_EXISTS');
    throw error;
  }
}

async function requireNewDirectory(directory, name) {
  const exists = await lstat(directory).catch((error) => {if (error.code === 'ENOENT') return null; throw error;});
  if (exists) fail(`${name} already exists. Choose a new directory.`, 'OUTPUT_EXISTS');
}

async function removeEmptyDirectory(directory) {
  await rmdir(directory).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}

function progress(observer, value, stage) {
  try {observer?.({progress: value, stage})?.catch?.(() => {});} catch {}
}

async function copyVerified(source, destination, expectedFingerprint, signal) {
  signal?.throwIfAborted();
  const original = await stat(source);
  if (!original.isFile()) fail('A bundle input is not a regular file.');
  await mkdir(path.dirname(destination), {recursive: true});
  const hash = createHash('sha256');
  const measure = new Transform({transform(chunk, encoding, callback) {
    hash.update(chunk);
    callback(null, chunk);
  }});
  await pipeline(createReadStream(source), measure, createWriteStream(destination, {flags: 'wx', mode: 0o600}), {signal});
  const fingerprint = `sha256:${hash.digest('hex')}`;
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    fail('A source file does not match its saved fingerprint. Restore the matching original and retry.', 'SOURCE_CHANGED');
  }
  const after = await stat(source);
  if (original.dev !== after.dev || original.ino !== after.ino || original.size !== after.size || original.mtimeMs !== after.mtimeMs) {
    fail('A source file changed during the copy. Retry with a stable original.', 'SOURCE_CHANGED');
  }
  return {fingerprint, bytes: original.size};
}

/** Repair all moved assets in one revision while retaining source IDs and timing. */
export async function relinkMedia(projectDir, {expectedRevision, replacements, signal} = {}) {
  if (!Array.isArray(replacements) || !replacements.length) fail('Supply at least one asset replacement.', 'INVALID_RELINK');
  const relinked = [];
  const project = await mutateProject(projectDir, {expectedRevision, allowMissingAssets: true}, async (draft) => {
    const seen = new Set();
    for (const item of replacements) {
      signal?.throwIfAborted();
      const asset = draft.assets.find((entry) => entry.id === item?.assetId);
      if (!asset) fail('A replacement references an unknown asset.', 'ASSET_NOT_FOUND');
      if (seen.has(asset.id)) fail(`Supply only one replacement for asset ${asset.id}.`, 'INVALID_RELINK');
      seen.add(asset.id);
      if (typeof asset.fingerprint !== 'string' || !fingerprintPattern.test(asset.fingerprint)) {
        fail(`Asset ${asset.id} has no recorded SHA-256. Relinking requires verified original bytes.`, 'RELINK_FINGERPRINT_REQUIRED');
      }
      const replacement = await realpath(absolutePath(item.path, 'Replacement path'));
      if (await fileFingerprint(replacement) !== asset.fingerprint) {
        fail(`Replacement bytes do not match the original for asset ${asset.id}.`, 'RELINK_FINGERPRINT_MISMATCH');
      }
      asset.path = replacement;
      relinked.push({assetId: asset.id, path: replacement, fingerprint: asset.fingerprint});
    }
    signal?.throwIfAborted();
  });
  return {projectId: project.id, revision: project.revision, relinked};
}

async function listPublicFiles(directory, signal) {
  const root = await realpath(directory);
  const files = [];
  async function walk(folder, relative, ancestors) {
    signal?.throwIfAborted();
    const canonical = await realpath(folder);
    if (ancestors.has(canonical)) return;
    if (ancestors.size > 32) fail('The declared public directory exceeds the renderer depth limit.', 'UNSUPPORTED_BUNDLE_CUSTOM');
    const next = new Set([...ancestors, canonical]);
    for (const name of (await readdir(folder)).sort()) {
      if (name.startsWith('.')) continue;
      const source = path.join(folder, name);
      const reference = relativePath(`${relative}/${name}`);
      const info = await stat(source).catch((error) => {if (error.code === 'ENOENT') return null; throw error;});
      if (!info) continue;
      if (info.isDirectory()) await walk(source, reference, next);
      else if (info.isFile()) {
        if (files.length >= 10000) fail('The declared public directory exceeds the renderer file limit.', 'UNSUPPORTED_BUNDLE_CUSTOM');
        files.push({source, canonical: await realpath(source), reference});
      }
    }
  }
  await walk(root, 'public', new Set());
  return {root, files};
}

async function checkRuntimeImports(imports) {
  if (!Array.isArray(imports)) fail('The bundle runtime imports are invalid.');
  const {dependencies} = JSON.parse(await readFile(enginePackage, 'utf8'));
  for (const specifier of imports) {
    if (typeof specifier !== 'string' || !specifier || specifier.includes('\\')) fail('Invalid runtime import in project bundle.');
    const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    try {
      if (!Object.hasOwn(dependencies, name)) throw new Error('Unlisted package');
      const installed = fileURLToPath(import.meta.resolve(specifier));
      if (!(await stat(installed)).isFile()) throw new Error('Missing runtime file');
    } catch {
      fail(`Custom code uses ${specifier}. Portable custom code can use installed engine packages and bundled local modules.`, 'UNSUPPORTED_BUNDLE_DEPENDENCY');
    }
  }
}

async function bundleCustomEntry(entryPoint, directory, signal) {
  await checkProjectVersion(entryPoint);
  const entry = 'custom/entry.mjs';
  const css = 'custom/entry.css';
  let result;
  try {
    result = await build({entryPoints: [entryPoint], absWorkingDir: path.dirname(entryPoint),
      outfile: path.join(directory, entry), bundle: true, write: false, metafile: true,
      format: 'esm', platform: 'browser', packages: 'external', jsx: 'automatic',
      legalComments: 'inline', target: 'chrome120', logLevel: 'silent',
      loader: Object.fromEntries(inlineAssetExtensions.map((extension) => [extension, 'dataurl']))});
  } catch (error) {
    fail(`Custom code could not be packaged: ${error.message}. Use static JS/TS imports and put runtime media in the declared public directory.`,
      'UNSUPPORTED_BUNDLE_CUSTOM');
  }
  signal?.throwIfAborted();
  const externalImports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
    .filter((item) => item.external && item.kind !== 'url-token');
  if (externalImports.some((item) => item.kind === 'require-call' || item.kind === 'require-resolve')) {
    fail('Portable custom code must use ESM imports for installed engine packages.', 'UNSUPPORTED_BUNDLE_CUSTOM');
  }
  const imports = [...new Set(externalImports.map((item) => item.path))].sort();
  await checkRuntimeImports(imports);
  const cssOutput = result.outputFiles.find((file) => file.path === path.join(directory, css));
  const outputs = [];
  for (const file of result.outputFiles) {
    const reference = path.relative(directory, file.path).split(path.sep).join('/');
    if (![entry, css].includes(reference)) fail('Custom packaging produced an unsupported derived file.', 'UNSUPPORTED_BUNDLE_CUSTOM');
    const content = reference === entry && cssOutput ? `import './entry.css';\n${file.text}` : file.contents;
    await mkdir(path.dirname(file.path), {recursive: true});
    await writeFile(file.path, content, {flag: 'wx', mode: 0o600});
    outputs.push({path: reference, fingerprint: await fileFingerprint(file.path), bytes: (await stat(file.path)).size});
  }
  return {entry, imports, outputs};
}

function mapProps(value, knownPaths, references, unresolved, keys = []) {
  if (typeof value === 'string') {
    const isFileUrl = /^file:/i.test(value);
    let candidate = value;
    if (isFileUrl) {try {candidate = fileURLToPath(value);} catch {candidate = '';}}
    if (path.isAbsolute(candidate)) {
      const reference = knownPaths.get(path.resolve(candidate));
      if (reference) {
        references.push({keys, path: reference, isFileUrl});
        return reference;
      }
    }
    if (isFileUrl || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) unresolved.push(keys);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => mapProps(item, knownPaths, references, unresolved, [...keys, String(index)]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, mapProps(item, knownPaths, references, unresolved, [...keys, key])]));
  return value;
}

function bundleSummary(record, directory) {
  const {project} = record;
  return {projectId: project.id, revision: project.revision, assetCount: project.assets.length,
    fileCount: record.files.length, bytes: record.files.reduce((total, file) => total + file.bytes, 0),
    scope: 'current_revision', customBundled: Boolean(project.custom), requiredImports: record.requiredImports,
    unresolvedCustomPropPaths: record.unresolvedCustomPropPaths,
    limitations: ['The bundle includes the current editable revision and registered media. Earlier revisions, exports, jobs and caches are separate.',
      ...(project.custom ? ['Static custom modules and declared public files are packaged. Runtime-only imports, absolute paths inside code and network resources may still require setup.'] : []),
      ...(record.unresolvedCustomPropPaths.length ? ['Some custom properties contain external absolute paths that could not be rebased. Review those properties after opening.'] : [])],
    bundleDir: directory, manifestPath: path.join(directory, manifestName)};
}

/** Freeze the current edit and copy its inputs to a transferable local folder. */
export async function createProjectBundle(snapshot, {bundleDir, signal, onProgress} = {}) {
  signal?.throwIfAborted();
  const project = structuredClone(snapshot);
  validateProject(project);
  const requested = absolutePath(bundleDir, 'Bundle directory');
  const publicMedia = project.custom?.publicDir ? await listPublicFiles(project.custom.publicDir, signal) : null;
  if (publicMedia && inside(publicMedia.root, requested)) {
    fail('Choose a bundle destination outside the custom public directory.', 'INVALID_BUNDLE_DESTINATION');
  }
  const directory = await newDirectoryPath(requested, 'Bundle directory');
  if (publicMedia && inside(publicMedia.root, directory)) {
    fail('Choose a bundle destination outside the custom public directory.', 'INVALID_BUNDLE_DESTINATION');
  }
  await requireNewDirectory(directory, 'Bundle directory');
  const staging = await mkdtemp(path.join(path.dirname(directory), '.engine-bundle-'));
  const files = [], knownPaths = new Map(), propReferences = [], unresolvedCustomPropPaths = [];
  let requiredImports = [], ownsDirectory = false, published = false;
  try {
    const total = project.assets.length + (publicMedia?.files.length ?? 0);
    const copy = async (source, reference, fingerprint) => {
      const info = await copyVerified(source, path.join(staging, ...reference.split('/')), fingerprint, signal);
      files.push({path: reference, ...info});
      progress(onProgress, .85 * files.length / Math.max(1, total), `Copied ${files.length}/${total} media files`);
      return info.fingerprint;
    };
    for (const [index, asset] of project.assets.entries()) {
      const extension = path.extname(asset.path).toLowerCase();
      const suffix = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin';
      const reference = `media/${String(index + 1).padStart(6, '0')}${suffix}`;
      const source = await realpath(asset.path);
      asset.fingerprint = await copy(source, reference, asset.fingerprint);
      knownPaths.set(path.resolve(asset.path), reference);
      knownPaths.set(source, reference);
      asset.path = reference;
    }
    if (project.custom) {
      const custom = await bundleCustomEntry(project.custom.entryPoint, staging, signal);
      knownPaths.set(path.resolve(project.custom.entryPoint), custom.entry);
      project.custom.entryPoint = custom.entry;
      requiredImports = custom.imports;
      if (publicMedia) {
        knownPaths.set(path.resolve(project.custom.publicDir), 'public');
        knownPaths.set(publicMedia.root, 'public');
        await mkdir(path.join(staging, 'public'), {recursive: true});
        for (const {source, canonical, reference} of publicMedia.files) {
          await copy(canonical, reference);
          knownPaths.set(source, reference);
          knownPaths.set(path.resolve(project.custom.publicDir, ...reference.split('/').slice(1)), reference);
          if (!knownPaths.has(canonical)) knownPaths.set(canonical, reference);
        }
        project.custom.publicDir = 'public';
      }
      if (project.custom.props !== undefined) {
        project.custom.props = mapProps(project.custom.props, knownPaths, propReferences, unresolvedCustomPropPaths);
      }
      files.push(...custom.outputs);
    }
    signal?.throwIfAborted();
    const record = {format, version: 1, project, files, requiredImports, propReferences, unresolvedCustomPropPaths};
    await writeFile(path.join(staging, '.gitignore'), localIgnore, {flag: 'wx', mode: 0o600});
    await writeFile(path.join(staging, manifestName), `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx', mode: 0o600, signal});
    signal?.throwIfAborted();
    await claimDirectory(directory, 'Bundle directory');
    ownsDirectory = true;
    signal?.throwIfAborted();
    await rename(staging, directory);
    published = true;
    progress(onProgress, 1, 'Project bundle ready');
    return bundleSummary(record, directory);
  } finally {
    if (!published) {
      await rm(staging, {recursive: true, force: true});
      if (ownsDirectory) await removeEmptyDirectory(directory);
    }
  }
}

async function bundleFile(directory, reference, {allowDirectory = false} = {}) {
  const candidate = path.join(directory, ...relativePath(reference).split('/'));
  let canonical, info;
  try {canonical = await realpath(candidate); info = await lstat(candidate);}
  catch {fail(`A required bundle file is missing: ${reference}.`, 'BUNDLE_FILE_MISSING');}
  if (!inside(directory, canonical) || (allowDirectory ? !info.isDirectory() : !info.isFile())) {
    fail(`The bundle reference ${reference} must stay inside the bundle as a regular ${allowDirectory ? 'directory' : 'file'}.`);
  }
  return canonical;
}

function rebaseProject(record, directory, filePaths) {
  const project = structuredClone(record.project);
  const resolveFile = (reference) => {
    const file = filePaths.get(reference);
    if (!file) fail(`A project reference is absent from the bundle inventory: ${reference}.`);
    return file;
  };
  for (const asset of project.assets) asset.path = resolveFile(asset.path);
  if (project.custom) {
    if (project.custom.entryPoint !== 'custom/entry.mjs') fail('The bundle custom entry reference is invalid.');
    project.custom.entryPoint = resolveFile(project.custom.entryPoint);
    if (project.custom.publicDir !== undefined) {
      if (project.custom.publicDir !== 'public') fail('The bundle public directory reference is invalid.');
      project.custom.publicDir = path.join(directory, 'public');
    }
    for (const reference of record.propReferences) {
      if (!Array.isArray(reference?.keys) || !reference.keys.length || reference.keys.some((key) => typeof key !== 'string') ||
        typeof reference.isFileUrl !== 'boolean') fail('Invalid custom property reference in project bundle.');
      let parent = project.custom.props;
      for (const key of reference.keys.slice(0, -1)) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) fail('Missing custom property in project bundle.');
        parent = parent[key];
      }
      const key = reference.keys.at(-1);
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) || parent[key] !== reference.path) {
        fail('Custom property reference does not match its saved value.');
      }
      const target = reference.path === 'public' && project.custom.publicDir ? project.custom.publicDir : resolveFile(reference.path);
      parent[key] = reference.isFileUrl ? pathToFileURL(target).href : target;
    }
  } else if (record.propReferences.length) fail('A bundle without custom code cannot contain custom property references.');
  return project;
}

/** Copy a verified bundle into a fresh normal project with rebased references. */
export async function openProjectBundle(bundleDir, {projectDir, signal, onProgress} = {}) {
  signal?.throwIfAborted();
  const source = await realpath(absolutePath(bundleDir, 'Bundle directory'));
  const descriptor = await bundleFile(source, manifestName);
  let record;
  try {record = JSON.parse(await readFile(descriptor, 'utf8'));}
  catch {fail('The bundle manifest is not valid JSON.');}
  if (record?.format !== format || record.version !== 1 || !Array.isArray(record.project?.assets) ||
    !Array.isArray(record.files) || !Array.isArray(record.propReferences) || !Array.isArray(record.unresolvedCustomPropPaths)) {
    fail('Unsupported or incomplete project bundle manifest.');
  }
  await checkRuntimeImports(record.requiredImports);
  const inputPaths = new Map(), fingerprints = new Map();
  for (const file of record.files) {
    signal?.throwIfAborted();
    const reference = relativePath(file?.path);
    if (!/^(media\/\d{6,}\.[a-z0-9]{1,12}|custom\/entry\.(mjs|css)|public\/.+)$/.test(reference) ||
      inputPaths.has(reference) || typeof file.fingerprint !== 'string' || !fingerprintPattern.test(file.fingerprint) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('Invalid or duplicate file in project bundle inventory.');
    inputPaths.set(reference, await bundleFile(source, reference));
    fingerprints.set(reference, file.fingerprint);
  }
  for (const asset of record.project.assets) {
    if (typeof asset?.path !== 'string' || !asset.path.startsWith('media/') || !fingerprints.has(asset.path) ||
      fingerprints.get(asset.path) !== asset.fingerprint) fail('Asset metadata does not match the bundle file inventory.');
  }
  if (record.project.custom?.publicDir !== undefined) await bundleFile(source, 'public', {allowDirectory: true});
  validateProject(rebaseProject(record, source, inputPaths));
  const destination = await newDirectoryPath(projectDir, 'Project directory');
  await requireNewDirectory(destination, 'Project directory');
  const staging = await mkdtemp(path.join(path.dirname(destination), '.engine-import-'));
  const content = path.join(destination, 'bundle-files');
  const ignorePath = path.join(destination, '.gitignore');
  let ownsDestination = false, movedContent = false, ownsIgnore = false;
  try {
    if (record.project.custom?.publicDir) await mkdir(path.join(staging, 'public'));
    const outputPaths = new Map();
    for (const [index, file] of record.files.entries()) {
      const parts = file.path.split('/');
      const copied = await copyVerified(inputPaths.get(file.path), path.join(staging, ...parts), file.fingerprint, signal);
      if (copied.bytes !== file.bytes) fail('A bundle file has the wrong size.');
      outputPaths.set(file.path, path.join(content, ...parts));
      progress(onProgress, .9 * (index + 1) / Math.max(1, record.files.length), `Verified ${index + 1}/${record.files.length} bundle files`);
    }
    const project = rebaseProject(record, content, outputPaths);
    signal?.throwIfAborted();
    await claimDirectory(destination, 'Project directory');
    ownsDestination = true;
    const ignore = await open(ignorePath, 'wx', 0o600);
    ownsIgnore = true;
    try {await ignore.writeFile(localIgnore);}
    finally {await ignore.close();}
    await rename(staging, content);
    movedContent = true;
    signal?.throwIfAborted();
    await createProjectFromSnapshot(destination, project);
    progress(onProgress, 1, 'Editable project ready');
    return {...bundleSummary(record, source), projectDir: destination, projectPath: path.join(destination, 'project.json')};
  } catch (error) {
    if (movedContent) await rm(content, {recursive: true, force: true});
    if (ownsIgnore) await rm(ignorePath, {force: true});
    // Another caller may have created an independent project in this folder.
    // Remove only our copied assets and an empty destination.
    if (ownsDestination) await removeEmptyDirectory(destination);
    throw error;
  } finally {
    if (!movedContent) await rm(staging, {recursive: true, force: true});
  }
}
