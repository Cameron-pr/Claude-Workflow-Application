---
name: outlook-reply
description: Find an email across the user's personal and shared Outlook mailboxes and open a Reply-All draft for it (body, subject, attachments all editable), or compose a brand-new email — including "email <person> about X" by internal staff name, resolved live against a directory database if one is configured. Never sends anything; only opens a populated Outlook window for the user to review and send themselves.
---

# Outlook reply

Searches across the user's personal mailbox and any configured shared
mailboxes via COM automation, and opens a real Reply-All (or new-email)
compose window — fully drafted (body, subject, attachments) but **never
sent**. The user reviews and sends it themselves from Outlook.

**Hard rule: this skill must never call `.Send()` or otherwise transmit an
email.** Its only job is to find/compose and open a populated window with
`.Display()`. If the user asks you to actually send something, tell them
this skill only drafts and displays — they send it.

## Requirements

- Desktop Outlook must already be running and signed in, with any shared
  mailboxes you want searched already added.
- Run from the project root (wherever `outlook_reply.py` and its sibling
  scripts live).
- Set `PYTHONIOENCODING=utf-8` on every invocation of both scripts below —
  subjects/bodies routinely contain non-ASCII characters and `print()`/JSON
  output raises `UnicodeEncodeError` under Windows' default cp1252 codepage
  otherwise.
- Optional: set `OUTLOOK_SHARED_MAILBOXES` (comma-separated names) in `.env`
  to search shared mailboxes by default alongside the personal one. Without
  it, only the personal mailbox is searched unless `--mailbox` is given
  explicitly.

## Finding an email

```
PYTHONIOENCODING=utf-8 python outlook_reply.py search "<query>" --days 20 --limit 5
PYTHONIOENCODING=utf-8 python outlook_reply.py recent --days 14 --limit 10
PYTHONIOENCODING=utf-8 python outlook_reply.py list-mailboxes
```

- `search` scans the personal mailbox plus whatever's configured in
  `OUTLOOK_SHARED_MAILBOXES`, unless narrowed. Matches subject and sender by
  default — add `--include-body` only if a subject/sender search comes up
  empty and the user wants a deeper (much slower) pass.
- **Every mailbox's Inbox is searched recursively, subfolders included**
  (e.g. a rule-filed "Inbox - Internal" folder), since Outlook rules
  routinely move mail out of the Inbox root and each person's folder
  structure differs — don't assume a miss means the email doesn't exist,
  it may just be in a subfolder, which is covered automatically. Results
  are labelled `<mailbox>/<subfolder path>` so you can see where a match
  actually lives. Pass `--no-subfolders` only if the user explicitly wants
  the Inbox root alone (e.g. for speed on a very deep shared mailbox).
- **Scoping to one mailbox**: if the user names a mailbox ("check the
  support inbox"), pass `--mailbox "Support"` etc — matching is
  substring/case-insensitive. Use `--mailbox "all"` to also sweep Online
  Archive stores when even the shared mailboxes come up empty. Run
  `list-mailboxes` if unsure what's available.
- **Default window is 20 days.** If `total_matches` comes back 0, **tell
  the user nothing turned up in the last 20 days and ask whether to widen
  the search** (e.g. `--days 90`) rather than silently retrying or giving up.
- Every result carries a `"mailbox"` field. **Don't silently auto-pick the
  top result** — present the candidates back labelled by mailbox, so the
  user can pick, unless there's a single, obviously-correct top match (name
  it explicitly either way — never reply based on a silent pick).

## Finding an internal person's email (for composing by name)

```
PYTHONIOENCODING=utf-8 python employee_lookup.py "<name>"
```

Only useful if you have a directory database configured (see
`employee_lookup.py`'s docstring and `.env.example`) — this is a
**live read-only SELECT**, never cached, since staff change. Prints
`{"matches": [{"user_id", "full_name", "email", "department"}, ...]}`. If
more than one match, ask the user which one (department helps
disambiguate). Use the resolved email as `--to` for `compose` below. If no
directory database is set up, just ask the user for the address directly.

## Drafting a reply

```
PYTHONIOENCODING=utf-8 python outlook_reply.py reply "<entry_id>" "<store_id>" \
    --body-file "<path to drafted body>" \
    [--subject "<new subject>"] \
    [--attach "<path>" ["<path>" ...]]
```

Compose a full, polite reply around whatever the user gave you (a gist, a
line item, a decision) — don't just insert their wording verbatim. Write it
to a temp file first. `entry_id`/`store_id` come from the chosen
`search`/`recent` result. Reply All is already selected (`.ReplyAll()`, not
`.Reply()`); the drafted body is inserted above the quoted thread.

## Formatting tabular data in the body

`--body-file` content is inserted into the email as **raw HTML** (only
newlines become `<br>` — nothing is escaped), so a plain-text table with
space-padded columns will NOT line up in Outlook: HTML collapses runs of
whitespace, so aligned-looking text in the file renders as one run-on line.
Any time the body includes a table of items/data, write real HTML
`<table>` markup in the body file instead of space-aligned plain text, e.g.:

```html
<p>Hi Alex,</p>
<p>Could you take a look at these line items?</p>
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt">
  <tr style="background:#f2f2f2"><th>Item</th><th>Qty</th><th>Price</th></tr>
  <tr><td>Widget A</td><td>20</td><td>19.97</td></tr>
</table>
<p>Let me know if you have any questions.</p>
```

Plain prose paragraphs (no table) are fine as plain text with newlines, as
before — this only applies when the body contains tabular data.

## When the email body needs data from a database

If drafting the email requires facts that live in a database rather than in
what the user already told you, **ask the user first** whether they want
you to run a query to pull that data before you draft the email, rather
than drafting a vague/generic email and having them ask for the data
separately afterward. A quick one-line check is enough — don't block on it
if the answer is obvious from context.

## Composing a brand-new email

```
PYTHONIOENCODING=utf-8 python outlook_reply.py compose \
    --to "<address[,address...]>" --subject "<subject>" --body-file "<path>" \
    [--cc "<address[,address...]>"] [--attach "<path> ["<path>" ...]]
```

Use this for "email X about Y" requests that aren't a reply to anything.
Resolve internal names to addresses via `employee_lookup.py` first if you
have a directory database configured; use the address directly if the user
already gave one. Draft the body the same way as a reply — a proper
composed message, not verbatim insertion.

## After running reply/compose

Tell the user the window is open, not sent — they need to switch to
Outlook, review it, and send it themselves.

## Notes

- Attachments must be local file paths that already exist on disk — the
  skill doesn't create or fetch files, only attaches ones the user names.
- If Outlook isn't running, the script fails fast with a clear error — ask
  the user to open Outlook rather than retrying automatically.
- `employee_lookup.py` only ever SELECTs — never use it (or any other
  script) to write to the database.
