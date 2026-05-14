#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const { createCheckpoint, diffCheckpoint, listCheckpoints, rewindToCheckpoint, loadHookInput } = require('./rewind-core.cjs');

main().catch(error => {
  const json = process.argv.includes('--json');
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, message: error.message }, null, 2));
  } else {
    process.stderr.write(`Rewind failed: ${error.stack || error.message}\n`);
  }
  process.exitCode = 1;
});

async function main() {
  const args = process.argv.slice(2);
  const json = takeFlag(args, '--json');
  const command = args.shift();
  const root = process.cwd();

  if (!command || command === 'help' || command === '--help') {
    output(json, {
      ok: true,
      text: [
        'Usage:',
        '  node .vscode-rewind/rewind-cli.cjs checkpoint --reason "before edit"',
        '  node .vscode-rewind/rewind-cli.cjs list',
        '  node .vscode-rewind/rewind-cli.cjs diff <checkpoint-id>',
        '  node .vscode-rewind/rewind-cli.cjs rewind <checkpoint-id> [--dry-run]',
        '  node .vscode-rewind/rewind-cli.cjs rewind <checkpoint-id> --change [--dry-run]',
        '  node .vscode-rewind/rewind-cli.cjs rewind <checkpoint-id> --full [--dry-run]',
        '  node .vscode-rewind/rewind-cli.cjs hook --reason before-tool-use'
      ].join('\n')
    });
    return;
  }

  if (command === 'checkpoint') {
    const reason = takeOption(args, '--reason') || 'manual checkpoint';
    const allowEmpty = takeFlag(args, '--allow-empty');
    const result = await createCheckpoint(root, { reason, allowEmpty });
    output(json, result);
    return;
  }

  if (command === 'hook') {
    const reason = takeOption(args, '--reason') || 'copilot hook';
    const hookInput = await loadHookInput(process.stdin);
    const hookEventName = hookInput?.hookEventName || hookInput?.hook_event_name || hookInput?.eventName || reason;
    if (!shouldCheckpointHook(hookEventName, hookInput)) {
      output(json, { ok: true, message: `Skipped checkpoint for ${hookEventName}` }, { quiet: true });
      return;
    }
    const result = await createCheckpoint(root, {
      reason: `${reason}:${hookEventName}`,
      hook: hookInput,
      allowEmpty: false
    });
    output(json, result, { quiet: true });
    return;
  }

  if (command === 'list') {
    const checkpoints = await listCheckpoints(root);
    output(json, { ok: true, checkpoints });
    return;
  }

  if (command === 'diff') {
    const id = args.shift();
    if (!id) {
      throw new Error('Missing checkpoint id. Usage: diff <checkpoint-id>');
    }
    const result = await diffCheckpoint(root, id);
    output(json, result);
    return;
  }

  if (command === 'rewind') {
    const id = args.shift();
    if (!id) {
      throw new Error('Missing checkpoint id. Usage: rewind <checkpoint-id> [--dry-run] [--change] [--full]');
    }
    const dryRun = takeFlag(args, '--dry-run');
    const fullRestore = takeFlag(args, '--full');
    const changeCheckpoint = takeFlag(args, '--change');
    const result = await rewindToCheckpoint(root, id, { dryRun, fullRestore, changeCheckpoint });
    output(json, result);
    return;
  }

  if (command === 'init-config') {
    await fs.mkdir('.rewind', { recursive: true });
    const example = await fs.readFile('.vscode-rewind/config.example.json', 'utf8');
    await fs.writeFile('.rewind/config.json', example);
    output(json, { ok: true, message: 'Created .rewind/config.json' });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function shouldCheckpointHook(hookEventName, hookInput) {
  if (hookEventName === 'SessionStart' || hookEventName === 'UserPromptSubmit' || hookEventName === 'Stop') {
    return true;
  }
  if (hookEventName !== 'PreToolUse') {
    return false;
  }
  const allPreTool = hookInput?.rewind?.checkpointAllPreToolUse;
  if (allPreTool === false) {
    const toolName = String(hookInput?.toolName || hookInput?.tool_name || hookInput?.tool?.name || '').toLowerCase();
    return /edit|write|create|delete|patch|replace|notebook|terminal|run/.test(toolName);
  }
  return true;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function output(json, result, options = {}) {
  if (options.quiet && !json) {
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }
  if (result.text) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.message) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
