# Copilot Rewind

Programmable non-Git workspace checkpoints and rewind tools for GitHub Copilot in VS Code.

## How to run this extension locally

This repo is extension source code. It will not appear in the VS Code Extensions sidebar until you either run it in an Extension Development Host or package and install it.

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

Then click the green play button.

VS Code opens a second window titled something like:

```text
[Extension Development Host]
```

That second window is where the extension is running.

## How to verify it loaded

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

## How to install hooks into a workspace

In the Extension Development Host window:

1. Open the project folder you want Copilot to edit.
2. Run:

```text
Rewind: Install Workspace Hook Files
```

This creates:

```text
.github/hooks/rewind.json
.vscode-rewind/rewind-cli.cjs
.vscode-rewind/rewind-core.cjs
```

## How to use the commands

Command Palette commands:

```text
Rewind: Create Checkpoint
Rewind: List Checkpoints
Rewind: Diff Checkpoint
Rewind: Restore Checkpoint
```

Copilot Chat participant commands:

```text
@rewind /checkpoint before changes
@rewind /list
@rewind /diff cp_...
@rewind /rewind cp_... --dry-run
@rewind /rewind cp_...
```

Agent tools:

```text
rewindCreateCheckpoint
rewindListCheckpoints
rewindDiffCheckpoint
rewindRestoreCheckpoint
```

## How to verify hooks are triggering

Open:

```text
View > Output
```

Choose:

```text
GitHub Copilot Chat Hooks
```

Then ask Copilot Agent mode to edit a file. Checkpoints should appear in:

```text
.rewind/checkpoints/
```

You can also run:

```text
Rewind: List Checkpoints
```
