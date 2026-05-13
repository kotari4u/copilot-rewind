# Copilot Rewind

Programmable non-Git workspace checkpoints and rewind tools for GitHub Copilot in VS Code.

## What this provides

- VS Code commands for checkpoint, list, diff, and restore.
- A Copilot Chat participant named `@rewind`.
- Agent tools named `rewindCreateCheckpoint`, `rewindListCheckpoints`, `rewindDiffCheckpoint`, and `rewindRestoreCheckpoint`.
- Copilot lifecycle hooks that create checkpoints on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop`.
- A non-Git checkpoint engine under `.vscode-rewind/`.

## Implemented safety features

- Confirmation before real rewind.
- Automatic safety checkpoint before every real rewind.
- Workspace path validation to block `../` and absolute-path writes.
- Ignore rules for `.git`, `.rewind`, `node_modules`, `dist`, `out`, `build`, and similar generated folders.
- Max checkpoint/storage pruning.
- Binary file storage and binary diff reporting.
- Dry-run mode.
- Clear restored/deleted/unchanged report.

## Important: source repo vs installed extension

Opening this repo in VS Code does not install the extension.

The Extensions sidebar searches installed extensions and the marketplace. This source repo will not appear there just because `npm install` or `npm run compile` succeeded.

To run this extension locally, launch it in an Extension Development Host.

## Run the extension locally

### 1. Open this repo in VS Code

Open the `copilot-rewind` folder itself.

### 2. Install and compile

```bash
npm install
npm run compile
```

### 3. Start the extension

Open the Run and Debug view:

```text
Cmd+Shift+D
```

Choose:

```text
Run Copilot Rewind Extension
```

Click the green play button.

VS Code opens a second window titled something like:

```text
[Extension Development Host]
```

That second window is where the extension is running.

## Verify the extension loaded

In the Extension Development Host window, open Command Palette:

```text
Cmd+Shift+P
```

Search:

```text
Rewind:
```

You should see:

```text
Rewind: Install Workspace Hook Files
Rewind: Create Checkpoint
Rewind: List Checkpoints
Rewind: Diff Checkpoint
Rewind: Restore Checkpoint
```

If you search in the original VS Code window, you will not see these commands. They appear in the Extension Development Host window.

## Install hooks into a workspace

In the Extension Development Host window:

1. Open the project folder you want Copilot to edit.
2. Run this command from Command Palette:

```text
Rewind: Install Workspace Hook Files
```

This creates:

```text
.github/hooks/rewind.json
.vscode-rewind/rewind-cli.cjs
.vscode-rewind/rewind-core.cjs
```

Do not copy `.rewind/`; that is runtime checkpoint data.

## Use the commands

Command Palette:

```text
Rewind: Create Checkpoint
Rewind: List Checkpoints
Rewind: Diff Checkpoint
Rewind: Restore Checkpoint
```

Copilot Chat participant:

```text
@rewind /checkpoint before changes
@rewind /list
@rewind /diff cp_...
@rewind /rewind cp_... --dry-run
@rewind /rewind cp_...
```

Copilot Agent tools:

```text
#rewindCreateCheckpoint
#rewindListCheckpoints
#rewindDiffCheckpoint
#rewindRestoreCheckpoint
```

## Verify hooks are triggering

Open:

```text
View > Output
```

Choose:

```text
GitHub Copilot Chat Hooks
```

Then ask Copilot Agent mode to edit a file.

Checkpoints should appear in:

```text
.rewind/checkpoints/
```

You can also run:

```text
Rewind: List Checkpoints
```

The checkpoint reasons should include values like:

```text
before-user-prompt:UserPromptSubmit
before-tool-use:PreToolUse
session-start:SessionStart
session-stop:Stop
```

## Manual CLI test

From any workspace where `.vscode-rewind/` exists:

```bash
node .vscode-rewind/rewind-cli.cjs checkpoint --reason manual-test
node .vscode-rewind/rewind-cli.cjs list
node .vscode-rewind/rewind-cli.cjs diff <checkpoint-id>
node .vscode-rewind/rewind-cli.cjs rewind <checkpoint-id> --dry-run
```
