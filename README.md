# copilot-rewind

Files Created


package.json: VS Code extension manifest, chat participant, slash commands, LM tools.

src/extension.ts: chat commands, tool handlers, confirmation UI, command palette actions.

.github/hooks/rewind.json: Copilot lifecycle hooks.

.vscode-rewind/rewind-cli.cjs: CLI used by hooks and extension.

.vscode-rewind/rewind-core.cjs: checkpoint, diff, rewind, validation, storage engine.

.vscode-rewind/config.example.json: ignore rules and limits.

tsconfig.json: TypeScript config.


What Is Implemented


Confirmation before rewind: confirmRewind() in src/extension.ts.

Auto safety checkpoint before every real rewind: rewindToCheckpoint() in rewind-core.cjs.

Workspace path validation against ../ and absolute paths.

Ignore rules for .git, .rewind, node_modules, dist, out, build, etc.

Max storage and checkpoint pruning.

Binary file storage and binary diff reporting.

Dry-run mode.

Clear restored/deleted/unchanged report.


How To Run

From this folder:

bash



npm install
npm run compile



I already ran both successfully.

Then open this folder in VS Code and press F5 to launch an Extension Development Host.

How To Use In Copilot Chat

Because VS Code slash commands belong to chat participants, the command shape is:

text



@rewind /checkpoint before big refactor
@rewind /list
@rewind /diff cp_...
@rewind /rewind cp_... --dry-run
@rewind /rewind cp_...



For agent/tool usage, ask Copilot to use:

text



#rewindCreateCheckpoint
#rewindListCheckpoints
#rewindDiffCheckpoint
#rewindRestoreCheckpoint



How Hooks Work

The hook file is:

text



.github/hooks/rewind.json



It creates checkpoints on:

text



SessionStart
UserPromptSubmit
PreToolUse
Stop



The hook command calls:

bash



node .vscode-rewind/rewind-cli.cjs hook --reason before-tool-use



Hook success is intentionally silent on stdout so VS Code does not misread normal output as hook control JSON.

Copying Into Another Project

Copy .vscode-rewind/ into the target repo.
Copy .github/hooks/rewind.json into the target repo.
Install/run this extension.
Or use Command Palette: Rewind: Install Workspace Hook Files.

Do not copy .rewind/; that is runtime checkpoint data.

Verified


CLI checkpoint creation works.

List works.

Diff works.

Dry-run rewind works.

Hook command is silent on success.

TypeScript extension compiles.


Sources used for current APIs: VS Code Agent Hooks, VS Code Chat Participant API.
