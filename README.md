# Claude Generic Workflow Application

A small toolkit of extras for [Claude Code](https://claude.com/claude-code) — a floating desktop chat widget plus a couple of Claude Code skills for working with email, a SQL Server / Dynamics NAV-style database, and Trello. Everything here was pulled out of a real internal setup and genericized: no company-specific names, tables, boards, or credentials — just the reusable mechanics, driven by your own `.env`.

## What's in here

- **`floating-app/`** — an always-on-top, dark/orange floating chat window that drives the same `claude` CLI / Agent SDK as any other Claude Code frontend. Multiple concurrent conversations, live tool-call transcripts, interactive question/approval prompts, model/effort/permission switchers. See [`floating-app/README.md`](floating-app/README.md) for setup.
<img width="448" height="591" alt="image" src="https://github.com/user-attachments/assets/74b7a930-c76e-4fd5-b3e4-b8041208072d" />
<img width="401" height="580" alt="image" src="https://github.com/user-attachments/assets/b531394a-eb41-4a02-af1d-3eefaaadbef2" />
<img width="569" height="571" alt="image" src="https://github.com/user-attachments/assets/1764373c-541a-4cea-8532-4ac177f4ecfd" />


- **`sql_utils.py`** — a small, generic pyodbc + pandas helper for read-only queries against SQL Server (works well with Dynamics NAV-style databases in particular — see the driver quirks called out in the docstring).
- **`skills/outlook-reply/`** — a Claude Code skill that searches your Outlook mailboxes (personal + any configured shared ones) via COM automation and opens a fully-drafted Reply-All or new email for you to review and send yourself. It never sends anything.
- **`skills/trello-read/`** — a read-only Claude Code skill for looking up cards/lists on a single configured Trello board.

## Setup

1. Install the Claude Code CLI and sign in, if you haven't:
   ```
   npm install -g @anthropic-ai/claude-code
   claude
   ```
2. Python dependencies (for the skills and `sql_utils.py`):
   ```
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and fill in whichever pieces you're actually using — you don't need all of it. Skip the SQL/Trello/Outlook sections entirely if you're only after the floating widget.
4. To use the skills with Claude Code, either point Claude Code at this repo's `skills/` directory or copy the ones you want into your own project's `.claude/skills/`.
5. For the floating widget, see [`floating-app/README.md`](floating-app/README.md).

## A note on scope

`sql_utils.py` and the two skills are read-only by design (or, for `outlook-reply`, draft-only — it composes but never sends). Nothing here is set up with safety rails against being pointed at a database with write access or a mailbox you don't want touched, so that's on you to keep true.
