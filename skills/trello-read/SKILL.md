---
name: trello-read
description: Look up a card, list, or search a configured Trello board — read-only. Use when the user asks to check, read, look up, or find something on Trello. Scoped only to the configured board; never creates, edits, moves, or deletes anything.
---

# Trello read

Read-only lookups against the Trello API, **scoped only to whichever board
is configured** via `TRELLO_BOARD_ID`. This skill must **only ever issue
GET requests** — never create, update, move, archive, or delete a card,
list, or board. If the user asks to change something in Trello, tell them
this skill is read-only and don't attempt the write. If the user asks about
a card/board outside the configured one, tell them this skill doesn't
cover it rather than looking it up.

## Setup

Requires `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, and `TRELLO_BOARD_ID` in the
project's `.env` file (see `.env.example`). Get an API key/token at
https://trello.com/app-key, and the board ID from its URL or via the
Trello API. Run scripts from the project root so `load_dotenv()` can find
`.env`, e.g.:

```
python trello_read.py board
```

Card names, descriptions, and comments often contain non-ASCII characters
(smart quotes, zero-width joiners, etc.). The Windows terminal defaults to
cp1252, and `print()` will raise `UnicodeEncodeError` on these unless
`PYTHONIOENCODING=utf-8` is set first:

```
PYTHONIOENCODING=utf-8 python trello_read.py find 329
```

Set it on every invocation of this script, not just after a crash.

## Commands

- `board` — print the configured board's lists and the cards in each.
- `card <id_or_url>` — print a card's name, list, due date, labels,
  description, checklists, and recent comments. Accepts a raw card ID,
  short link, or a full `https://trello.com/c/...` URL. Refuses cards that
  aren't on the configured board.
- `list <list_id>` — print the cards in a single list on the configured board.
- `search <query>` — search cards within the configured board only.
- `find <text or #number>` — locate a card by its card number (e.g. `347`
  or `#347`) or by matching text in its name, and print full detail
  (description, checklists, recent comments) if there's exactly one match.
  If several cards match, it lists them so you can narrow down.

## "I'm working on X" workflow

When the user says something like "I'm working on [card name/number]" or
otherwise references a piece of work without giving an exact card ID, use
`find <text>` to locate it on the configured board and pull up its
description and comments so you have the same context they do. If `find`
returns multiple matches, ask the user which one they mean (or show the
short list and let them pick) rather than guessing.

## Notes

- Card/board references can be pasted as a full Trello URL — the script
  extracts the ID automatically.
- If a lookup fails with a 401/403, the token in `.env` may have expired
  or lack the right scope — ask the user to regenerate it rather than
  trying to work around it.
