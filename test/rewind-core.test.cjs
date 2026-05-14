'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');

const {
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  rewindToCheckpoint
} = require('../.vscode-rewind/rewind-core.cjs');

const execFileAsync = promisify(execFile);

test('diff output is hunk-based instead of dumping the whole file', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'app.txt', numberedLines(20));
  const cp = await checkpoint(workspace, 'before');

  const changed = numberedLines(20).replace('line 10\n', 'line 10 changed\n');
  await writeFile(workspace, 'app.txt', changed);

  const result = await diffCheckpoint(workspace, cp.id);
  assert.match(result.text, /^--- checkpoint\/app\.txt/m);
  assert.match(result.text, /^\+line 10 changed$/m);
  assert.match(result.text, /^-line 10$/m);
  assert.doesNotMatch(result.text, /line 1\n/);
  assert.doesNotMatch(result.text, /line 20\n?/);
});

test('delta rewind patches same file when newer edits are on different lines', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'app.txt', lines('line1', 'line2', 'line3', 'line4', 'line5'));
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'app.txt', lines('line1', 'line2 agent edit', 'line3', 'line4', 'line5'));
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'app.txt', lines('line1 later user edit', 'line2 agent edit', 'line3', 'line4', 'line5'));
  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.restored, ['app.txt (patched)']);
  assert.deepEqual(result.report.skipped, []);
  assert.equal(await readFile(workspace, 'app.txt'), lines('line1 later user edit', 'line2', 'line3', 'line4', 'line5'));
});

test('delta rewind removes an inserted line while preserving later unrelated lines', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'app.txt', lines('a', 'b', 'c', 'd'));
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'app.txt', lines('a', 'b', 'agent added', 'c', 'd'));
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'app.txt', lines('user later', 'a', 'b', 'agent added', 'c', 'd'));
  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.restored, ['app.txt (patched)']);
  assert.equal(await readFile(workspace, 'app.txt'), lines('user later', 'a', 'b', 'c', 'd'));
});

test('delta rewind restores a deleted line while preserving later unrelated edits', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'app.txt', lines('a', 'b', 'c', 'd'));
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'app.txt', lines('a', 'c', 'd'));
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'app.txt', lines('user later', 'a', 'c', 'd'));
  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.restored, ['app.txt (patched)']);
  assert.equal(await readFile(workspace, 'app.txt'), lines('user later', 'a', 'b', 'c', 'd'));
});

test('delta rewind skips overlapping newer edits on the same lines', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'app.txt', lines('a', 'b', 'c'));
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'app.txt', lines('a', 'agent', 'c'));
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'app.txt', lines('a', 'user-overlap', 'c'));
  const result = await rewindToCheckpoint(workspace, cp1.id, { dryRun: true });

  assert.deepEqual(result.report.restored, []);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0], /overlapping newer edit/);
  assert.equal(await readFile(workspace, 'app.txt'), lines('a', 'user-overlap', 'c'));
});

test('delta rewind deletes files created in the checkpoint window and preserves later unrelated files', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'created-by-agent.txt', 'agent\n');
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'created-later.txt', 'later\n');
  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.deleted, ['created-by-agent.txt']);
  assert.equal(await exists(path.join(workspace, 'created-by-agent.txt')), false);
  assert.equal(await readFile(workspace, 'created-later.txt'), 'later\n');
});

test('delta rewind removes nested files created in the checkpoint window and cleans empty directories', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'features/new/created-by-agent.ts', 'export const value = 1;\n');
  await checkpoint(workspace, 'after-agent');

  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.deleted, ['features/new/created-by-agent.ts']);
  assert.equal(await exists(path.join(workspace, 'features/new/created-by-agent.ts')), false);
  assert.equal(await exists(path.join(workspace, 'features/new')), false);
  assert.equal(await exists(path.join(workspace, 'features')), false);
});

test('delta rewind does not delete a created file that was edited after the checkpoint window', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'created-by-agent.txt', 'agent version\n');
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'created-by-agent.txt', 'later user version\n');
  const result = await rewindToCheckpoint(workspace, cp1.id, { dryRun: true });

  assert.deepEqual(result.report.deleted, []);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0], /created-by-agent\.txt changed after checkpoint window/);
  assert.equal(await readFile(workspace, 'created-by-agent.txt'), 'later user version\n');
});

test('delta rewind treats already-deleted agent-created files as newer delete edits and leaves them missing', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'created-by-agent.txt', 'agent version\n');
  await checkpoint(workspace, 'after-agent');

  await fs.rm(path.join(workspace, 'created-by-agent.txt'));
  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.deleted, []);
  assert.equal(result.report.skipped.length, 1);
  assert.equal(await exists(path.join(workspace, 'created-by-agent.txt')), false);
});

test('delta rewind restores files deleted in the checkpoint window', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'deleted-by-agent.txt', 'bring me back\n');
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await fs.rm(path.join(workspace, 'deleted-by-agent.txt'));
  await checkpoint(workspace, 'after-agent');

  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.restored, ['deleted-by-agent.txt']);
  assert.equal(await readFile(workspace, 'deleted-by-agent.txt'), 'bring me back\n');
});

test('delta rewind restores nested files deleted in the checkpoint window and recreates directories', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'src/removed/deleted-by-agent.ts', 'export const removed = true;\n');
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await fs.rm(path.join(workspace, 'src/removed/deleted-by-agent.ts'));
  await fs.rmdir(path.join(workspace, 'src/removed'));
  await checkpoint(workspace, 'after-agent');

  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.restored, ['src/removed/deleted-by-agent.ts']);
  assert.equal(await readFile(workspace, 'src/removed/deleted-by-agent.ts'), 'export const removed = true;\n');
});

test('delta rewind does not overwrite a deleted file that was recreated after the checkpoint window', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'deleted-by-agent.txt', 'original content\n');
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await fs.rm(path.join(workspace, 'deleted-by-agent.txt'));
  await checkpoint(workspace, 'after-agent');

  await writeFile(workspace, 'deleted-by-agent.txt', 'later recreated content\n');
  const result = await rewindToCheckpoint(workspace, cp1.id);

  assert.deepEqual(result.report.restored, []);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0], /preserve newer create\/delete edit/);
  assert.equal(await readFile(workspace, 'deleted-by-agent.txt'), 'later recreated content\n');
});

test('dry-run delta rewind reports created/deleted file actions without mutating files', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'deleted-by-agent.txt', 'restore me\n');
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await fs.rm(path.join(workspace, 'deleted-by-agent.txt'));
  await writeFile(workspace, 'created-by-agent.txt', 'delete me\n');
  await checkpoint(workspace, 'after-agent');

  const result = await rewindToCheckpoint(workspace, cp1.id, { dryRun: true });

  assert.deepEqual(result.report.restored, ['deleted-by-agent.txt']);
  assert.deepEqual(result.report.deleted, ['created-by-agent.txt']);
  assert.equal(await exists(path.join(workspace, 'deleted-by-agent.txt')), false);
  assert.equal(await readFile(workspace, 'created-by-agent.txt'), 'delete me\n');
});

test('diff reports added and deleted files clearly', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'deleted.txt', 'old content\n');
  await writeFile(workspace, 'base.txt', 'base\n');
  const cp1 = await checkpoint(workspace, 'before');

  await fs.rm(path.join(workspace, 'deleted.txt'));
  await writeFile(workspace, 'added.txt', 'new content\n');

  const result = await diffCheckpoint(workspace, cp1.id);

  assert.match(result.text, /^--- \/dev\/null$/m);
  assert.match(result.text, /^\+\+\+ workspace\/added\.txt$/m);
  assert.match(result.text, /^\+new content$/m);
  assert.match(result.text, /^--- checkpoint\/deleted\.txt$/m);
  assert.match(result.text, /^\+\+\+ \/dev\/null$/m);
  assert.match(result.text, /^-old content$/m);
});

test('full restore still restores the entire checkpoint snapshot', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'a.txt', 'a0\n');
  const cp1 = await checkpoint(workspace, 'snapshot');

  await writeFile(workspace, 'a.txt', 'a1\n');
  await writeFile(workspace, 'later.txt', 'later\n');
  const result = await rewindToCheckpoint(workspace, cp1.id, { fullRestore: true });

  assert.equal(result.report.mode, 'full');
  assert.equal(await readFile(workspace, 'a.txt'), 'a0\n');
  assert.equal(await exists(path.join(workspace, 'later.txt')), false);
});

test('dry run does not mutate files or create a safety checkpoint', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'a.txt', 'a0\n');
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeFile(workspace, 'a.txt', 'a1\n');
  await checkpoint(workspace, 'after-agent');
  const before = await listCheckpoints(workspace);

  const result = await rewindToCheckpoint(workspace, cp1.id, { dryRun: true });
  const after = await listCheckpoints(workspace);

  assert.equal(result.report.safetyCheckpointId, undefined);
  assert.equal(await readFile(workspace, 'a.txt'), 'a1\n');
  assert.deepEqual(after.map(item => item.id), before.map(item => item.id));
});

test('binary files with newer edits are skipped instead of line-patched', async () => {
  const workspace = await makeWorkspace();
  await writeBinary(workspace, 'asset.bin', Buffer.from([0, 1, 2, 3]));
  const cp1 = await checkpoint(workspace, 'before-agent');

  await writeBinary(workspace, 'asset.bin', Buffer.from([0, 1, 9, 3]));
  await checkpoint(workspace, 'after-agent');

  await writeBinary(workspace, 'asset.bin', Buffer.from([0, 1, 8, 3]));
  const result = await rewindToCheckpoint(workspace, cp1.id, { dryRun: true });

  assert.deepEqual(result.report.restored, []);
  assert.equal(result.report.skipped.length, 1);
  assert.match(result.report.skipped[0], /binary file has newer edits/);
});

test('ignored files are not checkpointed, diffed, or rewound', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'src.txt', 'src0\n');
  await writeFile(workspace, 'node_modules/pkg/index.js', 'ignored0\n');
  const cp1 = await checkpoint(workspace, 'before');

  await writeFile(workspace, 'src.txt', 'src1\n');
  await writeFile(workspace, 'node_modules/pkg/index.js', 'ignored1\n');
  await rewindToCheckpoint(workspace, cp1.id);

  assert.equal(await readFile(workspace, 'src.txt'), 'src0\n');
  assert.equal(await readFile(workspace, 'node_modules/pkg/index.js'), 'ignored1\n');
});

test('malicious checkpoint paths are rejected without writing outside the workspace', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, 'safe.txt', 'safe\n');
  await checkpoint(workspace, 'normal');

  const outsidePath = path.join(path.dirname(workspace), 'outside.txt');
  await fs.rm(outsidePath, { force: true });
  const bad = {
    id: 'bad_checkpoint',
    createdAt: new Date().toISOString(),
    reason: 'malicious',
    files: [
      {
        path: '../outside.txt',
        kind: 'file',
        blob: 'missing',
        sha256: 'missing',
        size: 1,
        binary: false
      }
    ],
    stats: { files: 1, skipped: 0, sizeBytes: 1 }
  };
  await fs.mkdir(path.join(workspace, '.rewind', 'checkpoints'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.rewind', 'checkpoints', 'bad_checkpoint.json'), JSON.stringify(bad, null, 2));

  const result = await rewindToCheckpoint(workspace, 'bad_checkpoint');

  assert.equal(result.ok, false);
  assert.equal(await exists(outsidePath), false);
  assert.match(result.report.errors.join('\n'), /Path traversal is not allowed/);
});

test('checkpoint pruning keeps storage within configured maxCheckpoints while preserving latest checkpoints', async () => {
  const workspace = await makeWorkspace();
  await writeFile(workspace, '.rewind/config.json', JSON.stringify({ maxCheckpoints: 2 }, null, 2));

  await writeFile(workspace, 'file.txt', 'one\n');
  const cp1 = await checkpoint(workspace, 'one');
  await writeFile(workspace, 'file.txt', 'two\n');
  const cp2 = await checkpoint(workspace, 'two');
  await writeFile(workspace, 'file.txt', 'three\n');
  const cp3 = await checkpoint(workspace, 'three');

  const checkpoints = await listCheckpoints(workspace);
  assert.deepEqual(checkpoints.map(item => item.id), [cp3.id, cp2.id]);
  assert.equal(checkpoints.some(item => item.id === cp1.id), false);
});

test('CLI hook command is silent on success but creates a checkpoint', async () => {
  const workspace = await makeWorkspace();
  await fs.mkdir(path.join(workspace, '.vscode-rewind'), { recursive: true });
  await fs.copyFile(path.join(__dirname, '..', '.vscode-rewind', 'rewind-cli.cjs'), path.join(workspace, '.vscode-rewind', 'rewind-cli.cjs'));
  await fs.copyFile(path.join(__dirname, '..', '.vscode-rewind', 'rewind-core.cjs'), path.join(workspace, '.vscode-rewind', 'rewind-core.cjs'));
  await writeFile(workspace, 'file.txt', 'content\n');

  const result = await runCliWithInput(
    workspace,
    ['hook', '--reason', 'test-hook'],
    JSON.stringify({ hook_event_name: 'UserPromptSubmit' })
  );
  const checkpoints = await listCheckpoints(workspace);

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(checkpoints.length, 1);
  assert.match(checkpoints[0].reason, /test-hook:UserPromptSubmit/);
});

test('CLI dry-run rewind reports JSON and does not mutate the workspace', async () => {
  const workspace = await makeWorkspace();
  await fs.mkdir(path.join(workspace, '.vscode-rewind'), { recursive: true });
  await fs.copyFile(path.join(__dirname, '..', '.vscode-rewind', 'rewind-cli.cjs'), path.join(workspace, '.vscode-rewind', 'rewind-cli.cjs'));
  await fs.copyFile(path.join(__dirname, '..', '.vscode-rewind', 'rewind-core.cjs'), path.join(workspace, '.vscode-rewind', 'rewind-core.cjs'));

  await writeFile(workspace, 'file.txt', 'before\n');
  const cp1 = await checkpoint(workspace, 'before');
  await writeFile(workspace, 'file.txt', 'after\n');
  await checkpoint(workspace, 'after');

  const result = await execFileAsync(process.execPath, ['.vscode-rewind/rewind-cli.cjs', 'rewind', cp1.id, '--dry-run', '--json'], {
    cwd: workspace
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.report.dryRun, true);
  assert.equal(await readFile(workspace, 'file.txt'), 'after\n');
});

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'copilot-rewind-test-'));
}

async function checkpoint(workspace, reason) {
  await delay(2);
  return createCheckpoint(workspace, { reason });
}

async function writeFile(workspace, relPath, value) {
  const target = path.join(workspace, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

async function writeBinary(workspace, relPath, value) {
  const target = path.join(workspace, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

async function readFile(workspace, relPath) {
  return fs.readFile(path.join(workspace, relPath), 'utf8');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function lines(...items) {
  return `${items.join('\n')}\n`;
}

function numberedLines(count) {
  return lines(...Array.from({ length: count }, (_, index) => `line ${index + 1}`));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCliWithInput(workspace, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['.vscode-rewind/rewind-cli.cjs', ...args], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`CLI exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}
