# Claude Floating

A small always-on-top desktop chat widget for [Claude Code](https://claude.com/claude-code) — a dark, orange-accented floating window you can keep pinned above your other apps, instead of switching over to a full editor window every time you want to ask Claude something.

It drives the same `claude` CLI / Agent SDK that Claude Code's editor extensions use, so it shares your login, your CLAUDE.md, your skills, and your memory for whichever project you point it at.

## Features

- **Always-on-top pin** — keep it floating above everything else
- **Multiple concurrent conversations** — start something, switch away while it keeps working in the background, and come back to it later. An "Active" side panel shows everything you've got going, each with a live status dot (working / waiting for permission / error / done)
- **Full conversation history** — browse, resume, archive, or delete past conversations
- **Live tool-call transcript** — see every Bash command, file read, etc. as it runs, with collapsible output and a button to pop long output into its own window
- **Interactive prompts** — Claude's multiple-choice questions render as clickable buttons; permission prompts render as Allow/Deny cards, both inline in the chat
- **Model / effort / permission-mode switchers**
- **Markdown rendering** in replies

## Setup

1. Install the Claude Code CLI globally and sign in, if you haven't already:
   ```
   npm install -g @anthropic-ai/claude-code
   claude
   ```
2. Clone this repo and install dependencies:
   ```
   git clone <this-repo>
   cd claude-floating
   npm install
   ```
3. Copy `config.example.json` to `config.json` and set `projectDir` to whichever project folder you want the widget working in (this is what gives it that project's CLAUDE.md, skills, and memory). It defaults to the current directory if you skip this.
4. Run it:
   ```
   npm start
   ```

### Running from a network drive?

Electron can't launch its GPU/renderer child processes from a binary that lives on a network share — if your checkout is on one, `npm start` will crash on launch. Copy the app to local disk first and run it from there instead (see `start.bat` for an example that syncs a network-drive checkout to `%USERPROFILE%` and launches from there on every run, so you can keep editing the source on the share).

### No GPU / remote desktop session?

Set `CLAUDE_FLOATING_NO_GPU=1` before launching to fall back to software rendering instead of crashing.

## How it works

The app doesn't talk to any API directly — it spawns the official `@anthropic-ai/claude-agent-sdk`, which drives the same `claude` CLI binary as any other Claude Code frontend. Authentication, billing, and project context are all whatever that CLI is configured with locally, per machine/user — there's no separate account or credential store involved.

## Notes

- Everything runs with a conservative tool policy by default (governed by the Permission dropdown) — pick "Bypass" only if you understand what that means for the project you're pointing it at.
- Deleting a conversation from the history picker deletes it from Claude Code's own session store, not just from this app's view.
