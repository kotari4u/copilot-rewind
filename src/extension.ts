import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

type CliResult = {
  ok: boolean;
  message?: string;
  id?: string;
  text?: string;
  checkpoints?: Array<{ id: string; createdAt: string; reason?: string; files?: number; sizeBytes?: number }>;
  report?: {
    checkpointId?: string;
    mode?: string;
    windowStartCheckpointId?: string;
    windowEndCheckpointId?: string;
    safetyCheckpointId?: string;
    dryRun?: boolean;
    restored?: string[];
    unchanged?: string[];
    deleted?: string[];
    skipped?: string[];
    errors?: string[];
  };
};

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('rewind.installWorkspaceFiles', () => installWorkspaceFiles(context)),
    vscode.commands.registerCommand('rewind.createCheckpoint', () => createCheckpointCommand(context)),
    vscode.commands.registerCommand('rewind.listCheckpoints', () => listCheckpointsCommand(context)),
    vscode.commands.registerCommand('rewind.diffCheckpoint', () => diffCheckpointCommand(context)),
    vscode.commands.registerCommand('rewind.restoreCheckpoint', () => restoreCheckpointCommand(context)),
    vscode.chat.createChatParticipant('rewind.chat', createChatHandler(context)),
    vscode.lm.registerTool('rewind_create_checkpoint', new CreateCheckpointTool(context)),
    vscode.lm.registerTool('rewind_list_checkpoints', new ListCheckpointsTool(context)),
    vscode.lm.registerTool('rewind_diff_checkpoint', new DiffCheckpointTool(context)),
    vscode.lm.registerTool('rewind_restore_checkpoint', new RestoreCheckpointTool(context))
  );
}

export function deactivate() {}

function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('Open a workspace folder before using Rewind.');
  }
  return folder.uri.fsPath;
}

function getCliPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, '.vscode-rewind', 'rewind-cli.cjs');
}

async function runCli(context: vscode.ExtensionContext, args: string[]): Promise<CliResult> {
  const cwd = getWorkspaceRoot();
  const cliPath = getCliPath(context);
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args, '--json'], {
    cwd,
    maxBuffer: 50 * 1024 * 1024
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) as CliResult : { ok: true };
}

async function installWorkspaceFiles(context: vscode.ExtensionContext) {
  const root = getWorkspaceRoot();
  const sourceRuntime = path.join(context.extensionPath, '.vscode-rewind');
  const targetRuntime = path.join(root, '.vscode-rewind');
  const sourceHook = path.join(context.extensionPath, '.github', 'hooks', 'rewind.json');
  const targetHook = path.join(root, '.github', 'hooks', 'rewind.json');

  await copyDirectory(sourceRuntime, targetRuntime);
  await fs.mkdir(path.dirname(targetHook), { recursive: true });
  await fs.copyFile(sourceHook, targetHook);

  vscode.window.showInformationMessage('Rewind workspace files installed: .vscode-rewind/ and .github/hooks/rewind.json');
}

async function copyDirectory(source: string, target: string) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}

async function createCheckpointCommand(context: vscode.ExtensionContext) {
  const reason = await vscode.window.showInputBox({
    prompt: 'Checkpoint reason',
    value: 'manual checkpoint'
  });
  if (reason === undefined) {
    return;
  }
  const result = await runCli(context, ['checkpoint', '--reason', reason]);
  vscode.window.showInformationMessage(result.message ?? `Created checkpoint ${result.id}`);
}

async function listCheckpointsCommand(context: vscode.ExtensionContext) {
  const result = await runCli(context, ['list']);
  const items = (result.checkpoints ?? []).map(cp => ({
    label: cp.id,
    description: cp.createdAt,
    detail: `${cp.reason ?? 'no reason'} - ${cp.files ?? 0} files`
  }));
  if (!items.length) {
    vscode.window.showInformationMessage('No Rewind checkpoints found.');
    return;
  }
  await vscode.window.showQuickPick(items, { title: 'Rewind checkpoints' });
}

async function diffCheckpointCommand(context: vscode.ExtensionContext) {
  const id = await pickCheckpointId(context);
  if (!id) {
    return;
  }
  const result = await runCli(context, ['diff', id]);
  const doc = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: result.text ?? ''
  });
  await vscode.window.showTextDocument(doc);
}

async function restoreCheckpointCommand(context: vscode.ExtensionContext) {
  const id = await pickCheckpointId(context);
  if (!id) {
    return;
  }
  const action = await vscode.window.showQuickPick(['Dry run preview', 'Undo changes after this checkpoint', 'Undo change that produced this checkpoint', 'Full snapshot restore'], {
    title: `Rewind ${id}`,
    placeHolder: 'Choose whether to preview, undo a window, undo the selected change, or restore the full snapshot'
  });
  if (!action) {
    return;
  }
  if (action !== 'Dry run preview') {
    const confirmed = await confirmRewind(id);
    if (!confirmed) {
      return;
    }
  }
  const args = ['rewind', id];
  if (action === 'Dry run preview') {
    args.push('--dry-run');
  }
  if (action === 'Full snapshot restore') {
    args.push('--full');
  }
  if (action === 'Undo change that produced this checkpoint') {
    args.push('--change');
  }
  const result = await runCli(context, args);
  await showReport(result);
}

async function pickCheckpointId(context: vscode.ExtensionContext): Promise<string | undefined> {
  const result = await runCli(context, ['list']);
  const items = (result.checkpoints ?? []).map(cp => ({
    label: cp.id,
    description: cp.createdAt,
    detail: cp.reason ?? ''
  }));
  if (!items.length) {
    vscode.window.showInformationMessage('No Rewind checkpoints found.');
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { title: 'Choose checkpoint' }))?.label;
}

function createChatHandler(context: vscode.ExtensionContext): vscode.ChatRequestHandler {
  return async (request, _chatContext, stream) => {
    try {
      if (request.command === 'checkpoint') {
        const reason = request.prompt.trim() || 'chat checkpoint';
        const result = await runCli(context, ['checkpoint', '--reason', reason]);
        stream.markdown(result.message ?? `Created checkpoint \`${result.id}\`.`);
        return {};
      }

      if (request.command === 'list') {
        const result = await runCli(context, ['list']);
        stream.markdown(formatCheckpointList(result));
        return {};
      }

      if (request.command === 'diff') {
        const id = request.prompt.trim();
        if (!id) {
          stream.markdown('Usage: `@rewind /diff <checkpoint-id>`');
          return {};
        }
        const result = await runCli(context, ['diff', id]);
        stream.markdown(`\`\`\`diff\n${result.text ?? ''}\n\`\`\``);
        return {};
      }

      if (request.command === 'rewind') {
        const { id, dryRun, fullRestore, changeCheckpoint } = parseRewindPrompt(request.prompt);
        if (!id) {
          stream.markdown('Usage: `@rewind /rewind <checkpoint-id> [--dry-run] [--change] [--full]`');
          return {};
        }
        if (!dryRun && !(await confirmRewind(id))) {
          stream.markdown('Rewind cancelled.');
          return {};
        }
        const args = ['rewind', id];
        if (dryRun) {
          args.push('--dry-run');
        }
        if (fullRestore) {
          args.push('--full');
        }
        if (changeCheckpoint) {
          args.push('--change');
        }
        const result = await runCli(context, args);
        stream.markdown(formatReport(result));
        return {};
      }

      stream.markdown('Use `/checkpoint`, `/list`, `/diff <id>`, or `/rewind <id> [--dry-run] [--change] [--full]`.');
      return {};
    } catch (error) {
      stream.markdown(`Rewind failed: \`${error instanceof Error ? error.message : String(error)}\``);
      return {};
    }
  };
}

function parseRewindPrompt(prompt: string): { id?: string; dryRun: boolean; fullRestore: boolean; changeCheckpoint: boolean } {
  const tokens = prompt.trim().split(/\s+/).filter(Boolean);
  return {
    id: tokens.find(token => !token.startsWith('--')),
    dryRun: tokens.includes('--dry-run'),
    fullRestore: tokens.includes('--full'),
    changeCheckpoint: tokens.includes('--change')
  };
}

async function confirmRewind(id: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `Rewind workspace to checkpoint ${id}? A safety checkpoint will be created first, then later file changes may be overwritten or deleted.`,
    { modal: true },
    'Rewind'
  );
  return answer === 'Rewind';
}

async function showReport(result: CliResult) {
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: formatReport(result)
  });
  await vscode.window.showTextDocument(doc);
}

function formatCheckpointList(result: CliResult): string {
  const checkpoints = result.checkpoints ?? [];
  if (!checkpoints.length) {
    return 'No Rewind checkpoints found.';
  }
  return [
    '| ID | Created | Files | Reason |',
    '|---|---:|---:|---|',
    ...checkpoints.map(cp => `| \`${cp.id}\` | ${cp.createdAt} | ${cp.files ?? 0} | ${escapeMarkdownTable(cp.reason ?? '')} |`)
  ].join('\n');
}

function formatReport(result: CliResult): string {
  const report = result.report;
  if (!report) {
    return result.message ?? 'Done.';
  }
  const lines = [
    `# Rewind ${report.dryRun ? 'Dry Run' : 'Report'}`,
    '',
    `Checkpoint: \`${report.checkpointId ?? ''}\``,
    `Mode: \`${report.mode ?? 'delta'}\``
  ];
  if (report.windowEndCheckpointId) {
    if (report.windowStartCheckpointId) {
      lines.push(`Window start: \`${report.windowStartCheckpointId}\``);
    }
    lines.push(`Window end: \`${report.windowEndCheckpointId}\``);
  }
  if (report.safetyCheckpointId) {
    lines.push(`Safety checkpoint: \`${report.safetyCheckpointId}\``);
  }
  lines.push('', `Restored: ${report.restored?.length ?? 0}`, `Deleted: ${report.deleted?.length ?? 0}`, `Unchanged: ${report.unchanged?.length ?? 0}`);
  if (report.skipped?.length) {
    lines.push(`Skipped: ${report.skipped.length}`);
  }
  if (report.errors?.length) {
    lines.push('', '## Errors', ...report.errors.map(item => `- ${item}`));
  }
  for (const [title, values] of [
    ['Restored', report.restored],
    ['Deleted', report.deleted],
    ['Skipped', report.skipped]
  ] as Array<[string, string[] | undefined]>) {
    if (values?.length) {
      lines.push('', `## ${title}`, ...values.map(item => `- \`${item}\``));
    }
  }
  return lines.join('\n');
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

class CreateCheckpointTool implements vscode.LanguageModelTool<{ reason?: string }> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<{ reason?: string }>) {
    const reason = options.input.reason ?? 'language model checkpoint';
    const result = await runCli(this.context, ['checkpoint', '--reason', reason]);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.message ?? `Created checkpoint ${result.id}`)]);
  }
}

class ListCheckpointsTool implements vscode.LanguageModelTool<object> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async invoke() {
    const result = await runCli(this.context, ['list']);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(formatCheckpointList(result))]);
  }
}

class DiffCheckpointTool implements vscode.LanguageModelTool<{ id: string }> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<{ id: string }>) {
    const result = await runCli(this.context, ['diff', options.input.id]);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text ?? '')]);
  }
}

class RestoreCheckpointTool implements vscode.LanguageModelTool<{ id: string; dryRun?: boolean; fullRestore?: boolean; changeCheckpoint?: boolean }> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ id: string; dryRun?: boolean; fullRestore?: boolean; changeCheckpoint?: boolean }>) {
    return {
      invocationMessage: options.input.dryRun ? `Previewing rewind to ${options.input.id}` : `Rewinding workspace to ${options.input.id}`,
      confirmationMessages: options.input.dryRun ? undefined : {
        title: 'Restore Rewind Checkpoint',
        message: new vscode.MarkdownString(`Restore checkpoint \`${options.input.id}\`? A safety checkpoint will be created first. Default mode only undoes the checkpoint change window; full restore requires \`fullRestore: true\`.`)
      }
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<{ id: string; dryRun?: boolean; fullRestore?: boolean; changeCheckpoint?: boolean }>) {
    if (!options.input.dryRun && !(await confirmRewind(options.input.id))) {
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Rewind cancelled by user.')]);
    }
    const args = ['rewind', options.input.id];
    if (options.input.dryRun) {
      args.push('--dry-run');
    }
    if (options.input.fullRestore) {
      args.push('--full');
    }
    if (options.input.changeCheckpoint) {
      args.push('--change');
    }
    const result = await runCli(this.context, args);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(formatReport(result))]);
  }
}
