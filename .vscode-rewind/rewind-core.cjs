'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const REWIND_DIR = '.rewind';
const DEFAULT_CONFIG = {
  maxStorageBytes: 500 * 1024 * 1024,
  maxCheckpoints: 100,
  maxFileBytes: 50 * 1024 * 1024,
  maxDiffBytes: 1024 * 1024,
  checkpointAllPreToolUse: true,
  ignore: [
    '.git/**',
    '.rewind/**',
    '.vscode-rewind/**',
    'node_modules/**',
    'dist/**',
    'out/**',
    'build/**',
    'coverage/**',
    '.next/**',
    '.turbo/**',
    '*.log'
  ]
};

async function createCheckpoint(root, options = {}) {
  const config = await loadConfig(root);
  await ensureStore(root);

  const files = [];
  const skipped = [];
  const workspaceFiles = await listWorkspaceFiles(root, config);

  for (const relPath of workspaceFiles) {
    const absPath = resolveWorkspacePath(root, relPath);
    const stat = await fs.stat(absPath);
    if (stat.size > config.maxFileBytes) {
      skipped.push(`${relPath} larger than maxFileBytes (${stat.size} bytes)`);
      continue;
    }
    const bytes = await fs.readFile(absPath);
    const sha256 = hash(bytes);
    await writeBlob(root, sha256, bytes);
    files.push({
      path: relPath,
      kind: 'file',
      blob: sha256,
      sha256,
      size: bytes.length,
      binary: isProbablyBinary(bytes)
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = hash(Buffer.from(JSON.stringify(files.map(file => [file.path, file.sha256, file.size]))));
  const latest = await getLatestCheckpoint(root);
  if (!options.allowEmpty && latest?.manifestHash === manifestHash) {
    return {
      ok: true,
      id: latest.id,
      message: `Skipped checkpoint because workspace matches latest checkpoint ${latest.id}.`
    };
  }

  const id = makeCheckpointId();
  const checkpoint = {
    id,
    createdAt: new Date().toISOString(),
    reason: options.reason || 'checkpoint',
    manifestHash,
    workspaceRoot: root,
    hook: sanitizeHook(options.hook),
    files,
    skipped,
    stats: {
      files: files.length,
      skipped: skipped.length,
      sizeBytes: files.reduce((sum, file) => sum + file.size, 0)
    }
  };

  await writeJsonAtomic(checkpointPath(root, id), checkpoint);
  await enforceStorageLimit(root, config, new Set([id]));

  return {
    ok: true,
    id,
    message: `Created checkpoint ${id} with ${files.length} files${skipped.length ? ` (${skipped.length} skipped)` : ''}.`
  };
}

async function listCheckpoints(root) {
  await ensureStore(root);
  const dir = checkpointsDir(root);
  const names = await safeReaddir(dir);
  const checkpoints = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const checkpoint = await readJson(path.join(dir, name));
    checkpoints.push({
      id: checkpoint.id,
      createdAt: checkpoint.createdAt,
      reason: checkpoint.reason,
      files: checkpoint.files?.length ?? 0,
      sizeBytes: checkpoint.stats?.sizeBytes ?? 0,
      manifestHash: checkpoint.manifestHash
    });
  }
  checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return checkpoints;
}

async function diffCheckpoint(root, id) {
  const config = await loadConfig(root);
  const checkpoint = await loadCheckpoint(root, id);
  const checkpointByPath = new Map(checkpoint.files.map(file => [file.path, file]));
  const currentFiles = await listWorkspaceFiles(root, config);
  const currentSet = new Set(currentFiles);
  const allPaths = new Set([...checkpointByPath.keys(), ...currentSet]);
  const chunks = [];

  for (const relPath of [...allPaths].sort()) {
    validateRelativePath(relPath);
    const checkpointFile = checkpointByPath.get(relPath);
    const currentExists = currentSet.has(relPath);

    if (!checkpointFile && currentExists) {
      const currentBytes = await fs.readFile(resolveWorkspacePath(root, relPath));
      chunks.push(renderAddedDiff(relPath, currentBytes, config));
      continue;
    }

    if (checkpointFile && !currentExists) {
      const oldBytes = await readBlob(root, checkpointFile.blob);
      chunks.push(renderDeletedDiff(relPath, oldBytes, checkpointFile, config));
      continue;
    }

    if (checkpointFile && currentExists) {
      const currentBytes = await fs.readFile(resolveWorkspacePath(root, relPath));
      const currentHash = hash(currentBytes);
      if (currentHash === checkpointFile.sha256) {
        continue;
      }
      const oldBytes = await readBlob(root, checkpointFile.blob);
      chunks.push(renderChangedDiff(relPath, oldBytes, currentBytes, checkpointFile, config));
    }
  }

  let text = chunks.filter(Boolean).join('\n');
  if (!text.trim()) {
    text = `No changes since checkpoint ${id}.`;
  }
  if (Buffer.byteLength(text, 'utf8') > config.maxDiffBytes) {
    text = `${text.slice(0, config.maxDiffBytes)}\n\n[diff truncated at ${config.maxDiffBytes} bytes]`;
  }
  return { ok: true, text };
}

async function rewindToCheckpoint(root, id, options = {}) {
  const config = await loadConfig(root);
  const checkpoint = await loadCheckpoint(root, id);
  const report = {
    checkpointId: id,
    safetyCheckpointId: undefined,
    dryRun: Boolean(options.dryRun),
    restored: [],
    unchanged: [],
    deleted: [],
    skipped: [],
    errors: []
  };

  if (!options.dryRun) {
    const safety = await createCheckpoint(root, {
      reason: `safety-before-rewind:${id}`,
      allowEmpty: true
    });
    report.safetyCheckpointId = safety.id;
  }

  const checkpointByPath = new Map(checkpoint.files.map(file => [file.path, file]));
  const currentFiles = await listWorkspaceFiles(root, config);
  const currentSet = new Set(currentFiles);

  for (const file of checkpoint.files) {
    try {
      validateRelativePath(file.path);
      const targetPath = resolveWorkspacePath(root, file.path);
      const currentExists = currentSet.has(file.path);
      if (currentExists) {
        const currentBytes = await fs.readFile(targetPath);
        if (hash(currentBytes) === file.sha256) {
          report.unchanged.push(file.path);
          continue;
        }
      }
      report.restored.push(file.path);
      if (!options.dryRun) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, await readBlob(root, file.blob));
      }
    } catch (error) {
      report.errors.push(`${file.path}: ${error.message}`);
    }
  }

  for (const relPath of currentFiles) {
    if (checkpointByPath.has(relPath)) {
      continue;
    }
    try {
      validateRelativePath(relPath);
      report.deleted.push(relPath);
      if (!options.dryRun) {
        await fs.rm(resolveWorkspacePath(root, relPath), { force: true });
        await removeEmptyParents(root, path.dirname(resolveWorkspacePath(root, relPath)));
      }
    } catch (error) {
      report.errors.push(`${relPath}: ${error.message}`);
    }
  }

  if (!options.dryRun) {
    await enforceStorageLimit(root, config, new Set([id, report.safetyCheckpointId].filter(Boolean)));
  }

  return {
    ok: report.errors.length === 0,
    message: options.dryRun ? `Dry run complete for ${id}.` : `Rewind complete for ${id}.`,
    report
  };
}

async function loadHookInput(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function loadConfig(root) {
  const configPath = path.join(root, REWIND_DIR, 'config.json');
  const userConfig = await readJson(configPath).catch(() => ({}));
  const config = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    ignore: [...DEFAULT_CONFIG.ignore, ...(userConfig.ignore || [])]
  };
  config.ignoreRegexes = config.ignore.map(patternToRegex);
  return config;
}

async function ensureStore(root) {
  await fs.mkdir(checkpointsDir(root), { recursive: true });
  await fs.mkdir(blobsDir(root), { recursive: true });
}

async function listWorkspaceFiles(root, config) {
  const files = [];
  async function visit(absDir, relDir) {
    const entries = await safeReaddirWithTypes(absDir);
    for (const entry of entries) {
      const relPath = normalizePath(relDir ? `${relDir}/${entry.name}` : entry.name);
      if (isIgnored(relPath, entry.isDirectory(), config)) {
        continue;
      }
      const absPath = resolveWorkspacePath(root, relPath);
      if (entry.isDirectory()) {
        await visit(absPath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      } else {
        // Symlinks and special files are deliberately skipped to avoid writes outside the workspace.
      }
    }
  }
  await visit(root, '');
  return files.sort();
}

function isIgnored(relPath, isDir, config) {
  const normalized = normalizePath(relPath);
  const candidates = isDir ? [normalized, `${normalized}/`] : [normalized];
  return config.ignoreRegexes.some(regex => candidates.some(candidate => regex.test(candidate)));
}

function patternToRegex(pattern) {
  const normalized = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if ('\\^$+?.()|{}[]'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  if (!normalized.includes('/')) {
    return new RegExp(`(^|/)${source}($|/)`);
  }
  return new RegExp(`^${source}$|^${source.replace(/\\/g, '\\\\')}`);
}

function resolveWorkspacePath(root, relPath) {
  const normalized = validateRelativePath(relPath);
  const target = path.resolve(root, ...normalized.split('/'));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return target;
}

function validateRelativePath(relPath) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('Invalid empty path');
  }
  if (relPath.includes('\0')) {
    throw new Error(`Invalid path contains null byte: ${relPath}`);
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }
  const normalized = normalizePath(path.posix.normalize(normalizePath(relPath)));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Path traversal is not allowed: ${relPath}`);
  }
  return normalized;
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function writeBlob(root, sha256, bytes) {
  const target = blobPath(root, sha256);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!(await exists(target))) {
    await fs.writeFile(target, bytes);
  }
}

async function readBlob(root, sha256) {
  return fs.readFile(blobPath(root, sha256));
}

function blobPath(root, sha256) {
  return path.join(blobsDir(root), sha256.slice(0, 2), sha256);
}

async function loadCheckpoint(root, id) {
  validateCheckpointId(id);
  return readJson(checkpointPath(root, id));
}

function validateCheckpointId(id) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new Error(`Invalid checkpoint id: ${id}`);
  }
}

function checkpointPath(root, id) {
  validateCheckpointId(id);
  return path.join(checkpointsDir(root), `${id}.json`);
}

function checkpointsDir(root) {
  return path.join(root, REWIND_DIR, 'checkpoints');
}

function blobsDir(root) {
  return path.join(root, REWIND_DIR, 'blobs');
}

async function getLatestCheckpoint(root) {
  const checkpoints = await listCheckpoints(root);
  if (!checkpoints.length) {
    return undefined;
  }
  return readJson(checkpointPath(root, checkpoints[0].id));
}

async function enforceStorageLimit(root, config, keepIds = new Set()) {
  let checkpoints = await listCheckpoints(root);
  while (checkpoints.length > config.maxCheckpoints) {
    const oldest = checkpoints[checkpoints.length - 1];
    if (keepIds.has(oldest.id)) {
      break;
    }
    await fs.rm(checkpointPath(root, oldest.id), { force: true });
    checkpoints = await listCheckpoints(root);
  }

  await gcBlobs(root);
  let size = await directorySize(path.join(root, REWIND_DIR));
  checkpoints = await listCheckpoints(root);
  while (size > config.maxStorageBytes && checkpoints.length > 1) {
    const oldest = checkpoints[checkpoints.length - 1];
    if (keepIds.has(oldest.id)) {
      break;
    }
    await fs.rm(checkpointPath(root, oldest.id), { force: true });
    await gcBlobs(root);
    size = await directorySize(path.join(root, REWIND_DIR));
    checkpoints = await listCheckpoints(root);
  }
}

async function gcBlobs(root) {
  const referenced = new Set();
  for (const checkpoint of await listCheckpoints(root)) {
    const full = await readJson(checkpointPath(root, checkpoint.id));
    for (const file of full.files || []) {
      referenced.add(file.blob);
    }
  }
  await visitFiles(blobsDir(root), async file => {
    const name = path.basename(file);
    if (!referenced.has(name)) {
      await fs.rm(file, { force: true });
    }
  });
}

async function directorySize(absPath) {
  let total = 0;
  await visitFiles(absPath, async file => {
    const stat = await fs.stat(file);
    total += stat.size;
  });
  return total;
}

async function visitFiles(absPath, callback) {
  const entries = await safeReaddirWithTypes(absPath);
  for (const entry of entries) {
    const full = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      await visitFiles(full, callback);
    } else if (entry.isFile()) {
      await callback(full);
    }
  }
}

async function removeEmptyParents(root, absDir) {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(absDir);
  while (current.startsWith(`${resolvedRoot}${path.sep}`) && current !== resolvedRoot) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function renderAddedDiff(relPath, currentBytes, config) {
  if (isProbablyBinary(currentBytes)) {
    return `Binary file added: ${relPath} (${currentBytes.length} bytes)`;
  }
  return unifiedWholeFileDiff(`/dev/null`, `workspace/${relPath}`, '', bytesToText(currentBytes), config);
}

function renderDeletedDiff(relPath, oldBytes, oldFile, config) {
  if (oldFile.binary || isProbablyBinary(oldBytes)) {
    return `Binary file deleted: ${relPath} (${oldBytes.length} bytes)`;
  }
  return unifiedWholeFileDiff(`checkpoint/${relPath}`, `/dev/null`, bytesToText(oldBytes), '', config);
}

function renderChangedDiff(relPath, oldBytes, currentBytes, oldFile, config) {
  if (oldFile.binary || isProbablyBinary(oldBytes) || isProbablyBinary(currentBytes)) {
    return `Binary file changed: ${relPath} (${oldBytes.length} -> ${currentBytes.length} bytes)`;
  }
  return unifiedWholeFileDiff(`checkpoint/${relPath}`, `workspace/${relPath}`, bytesToText(oldBytes), bytesToText(currentBytes), config);
}

function unifiedWholeFileDiff(from, to, oldText, newText) {
  if (oldText === newText) {
    return '';
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lines = [
    `--- ${from}`,
    `+++ ${to}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`
  ];
  lines.push(...oldLines.map(line => `-${line}`));
  lines.push(...newLines.map(line => `+${line}`));
  return lines.join('\n');
}

function splitLines(text) {
  if (!text) {
    return [];
  }
  return text.replace(/\n$/, '').split(/\r?\n/);
}

function bytesToText(bytes) {
  return bytes.toString('utf8').replace(/\0/g, '\uFFFD');
}

function isProbablyBinary(bytes) {
  if (!bytes.length) {
    return false;
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if ((byte < 7 || (byte > 14 && byte < 32)) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length > 0.3;
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeCheckpointId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  return `cp_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function safeReaddirWithTypes(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      return [];
    }
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeHook(hook) {
  if (!hook) {
    return undefined;
  }
  const json = JSON.stringify(hook);
  if (json.length > 4000) {
    return { truncated: true, raw: json.slice(0, 4000) };
  }
  return JSON.parse(json);
}

module.exports = {
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  rewindToCheckpoint,
  loadHookInput
};
