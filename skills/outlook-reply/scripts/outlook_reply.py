"""
Search the local desktop Outlook mailbox (personal + shared mailboxes) and
open (never send) a Reply-All draft, or a brand-new email, via COM
automation.

Requires the desktop Outlook application to already be running and signed
into the target mailboxes.

Commands:
    python outlook_reply.py list-mailboxes
    python outlook_reply.py search <query> [--days N] [--mailbox NAME ...] [--limit N]
    python outlook_reply.py recent [--days N] [--mailbox NAME ...] [--limit N]
    python outlook_reply.py reply <entry_id> <store_id> --body-file <path>
        [--subject <new subject>] [--attach <path> [<path> ...]]
    python outlook_reply.py compose --to <addr[,addr...]> --subject <subj> --body-file <path>
        [--cc <addr[,addr...]>] [--attach <path> [<path> ...]]

`list-mailboxes`, `search` and `recent` print JSON so the calling agent can
parse results and present a short ranked list. `reply` and `compose` open a
real Outlook Inspector window, fully populated, and DISPLAY it -- neither
ever calls .Send().
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta

import win32com.client

OLFOLDER_INBOX = 6
OLFOLDER_SENTMAIL = 5
OLMAILITEM = 0

# Non-mail top-level "stores" that show up in ns.Folders alongside real
# mailboxes -- never search these.
NON_MAIL_STORES = {"internet calendars", "sharepoint lists"}

# Shared mailboxes searched by default alongside the personal mailbox, as a
# comma-separated list, e.g.: OUTLOOK_SHARED_MAILBOXES="Sales,Support,Billing"
# Online Archive stores are excluded by default (slower, historical) --
# pass them explicitly via --mailbox if needed.
DEFAULT_SHARED_MAILBOXES = [
    name.strip()
    for name in os.environ.get("OUTLOOK_SHARED_MAILBOXES", "").split(",")
    if name.strip()
]


def get_outlook():
    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
        return outlook.GetNamespace("MAPI")
    except Exception as exc:
        print(json.dumps({"error": f"Could not connect to Outlook: {exc}. "
                                    f"Is desktop Outlook running and signed in?"}))
        sys.exit(1)


def list_top_level_mailboxes(ns):
    names = []
    for folder in ns.Folders:
        if folder.Name.lower() not in NON_MAIL_STORES:
            names.append(folder.Name)
    return names


def get_top_level_folder(ns, name):
    name_lower = name.lower()
    for folder in ns.Folders:
        if folder.Name.lower() == name_lower:
            return folder
    for folder in ns.Folders:
        if folder.Name.lower() not in NON_MAIL_STORES and name_lower in folder.Name.lower():
            return folder
    return None


# Non-mail folder names that turn up under an Inbox (rare, but skip them --
# they don't support the DASL httpmail properties search relies on).
NON_MAIL_SUBFOLDERS = {"sharepoint"}

MAX_SUBFOLDER_DEPTH = 6


def _walk_folder(folder, label, path="", depth=0):
    """Recursively collect (label, folder) for `folder` and every
    subfolder beneath it, so a rule-filed subfolder (e.g. "Inbox -
    Internal Emails") is searched alongside the Inbox root itself."""
    full_label = label if not path else f"{label}/{path}"
    collected = [(full_label, folder)]
    if depth >= MAX_SUBFOLDER_DEPTH:
        return collected
    try:
        subfolders = list(folder.Folders)
    except Exception:
        subfolders = []
    for sub in subfolders:
        try:
            sub_name = sub.Name
        except Exception:
            continue
        if sub_name.lower() in NON_MAIL_SUBFOLDERS:
            continue
        new_path = sub_name if not path else f"{path}/{sub_name}"
        collected.extend(_walk_folder(sub, label, new_path, depth + 1))
    return collected


def expand_with_subfolders(resolved):
    expanded = []
    for label, folder in resolved:
        expanded.extend(_walk_folder(folder, label))
    return expanded


def resolve_inbox_folders(ns, mailbox_names, include_subfolders=True):
    """Return [(mailbox_label, folder)] for the requested mailboxes.

    mailbox_names: None/empty -> personal Inbox + DEFAULT_SHARED_MAILBOXES.
    "all" -> every top-level mail store's Inbox.
    Otherwise: the named mailboxes (must match a top-level store name).

    Each resolved Inbox is expanded to include its subfolders (recursively,
    up to MAX_SUBFOLDER_DEPTH) unless include_subfolders=False, since rules
    routinely file mail (e.g. internal-sender mail) out of the Inbox root
    into a subfolder that would otherwise be invisible to search/recent.
    """
    personal_inbox = ns.GetDefaultFolder(OLFOLDER_INBOX)
    resolved = []

    if not mailbox_names:
        resolved.append(("personal", personal_inbox))
        for name in DEFAULT_SHARED_MAILBOXES:
            top = get_top_level_folder(ns, name)
            if top is None:
                continue
            try:
                resolved.append((name, top.Folders["Inbox"]))
            except Exception:
                continue
        return expand_with_subfolders(resolved) if include_subfolders else resolved

    if len(mailbox_names) == 1 and mailbox_names[0].lower() == "all":
        resolved.append(("personal", personal_inbox))
        for name in list_top_level_mailboxes(ns):
            top = get_top_level_folder(ns, name)
            if top is None or top.StoreID == personal_inbox.Parent.StoreID:
                continue
            try:
                resolved.append((name, top.Folders["Inbox"]))
            except Exception:
                continue
        return expand_with_subfolders(resolved) if include_subfolders else resolved

    for name in mailbox_names:
        if name.lower() in ("personal", "inbox", "me"):
            resolved.append(("personal", personal_inbox))
            continue
        if name.lower() in ("sent", "sent items"):
            resolved.append(("sent", ns.GetDefaultFolder(OLFOLDER_SENTMAIL)))
            continue
        top = get_top_level_folder(ns, name)
        if top is None:
            raise ValueError(f"Mailbox '{name}' not found. Run list-mailboxes to see options.")
        try:
            resolved.append((name, top.Folders["Inbox"]))
        except Exception:
            resolved.append((name, top))
    return expand_with_subfolders(resolved) if include_subfolders else resolved


def restrict_by_date(items, days):
    if not days:
        return items
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%d/%m/%Y %I:%M %p")
    return items.Restrict(f"[ReceivedTime] >= '{cutoff}'")


def escape_dasl_like(term):
    return term.replace("'", "''")


def dasl_search_filter(query, days, include_body=False):
    """Server-side DASL filter matching subject/sender (and optionally
    body), bounded to the last `days` days. Runs inside Outlook/Exchange
    rather than pulling every item into Python to inspect -- orders of
    magnitude faster on large shared mailboxes.

    Body text (`textdescription`) is excluded by default: on this mailbox
    a body-LIKE clause measured ~45s on the personal store alone (vs
    <1s without it) even with a date bound, while subject/sender matches
    the actual use case (order/quote numbers, names) almost always."""
    esc = escape_dasl_like(query)
    clauses = [
        "\"urn:schemas:httpmail:subject\" LIKE '%" + esc + "%'",
        "\"urn:schemas:httpmail:fromname\" LIKE '%" + esc + "%'",
    ]
    if include_body:
        clauses.append("\"urn:schemas:httpmail:textdescription\" LIKE '%" + esc + "%'")
    keyword_clause = "(" + " OR ".join(clauses) + ")"
    if days:
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%d/%m/%Y %I:%M %p")
        date_clause = "(\"urn:schemas:httpmail:datereceived\" >= '" + cutoff + "')"
        return "@SQL=" + date_clause + " AND " + keyword_clause
    return "@SQL=" + keyword_clause


def snippet_of(text, length=200):
    text = " ".join((text or "").split())
    return text[:length]


def score_item(mail, query_lower):
    subject = (mail.Subject or "").lower()
    sender = (mail.SenderName or "").lower()
    body = (mail.Body or "").lower()
    if query_lower in subject:
        return 3, "subject"
    if query_lower in sender:
        return 2, "sender"
    if query_lower in body:
        return 1, "body"
    return 0, None


def item_to_dict(mail, mailbox_label, matched_on=None):
    return {
        "entry_id": mail.EntryID,
        "store_id": mail.Parent.StoreID,
        "mailbox": mailbox_label,
        "subject": mail.Subject,
        "sender": mail.SenderName,
        "received": str(mail.ReceivedTime),
        "snippet": snippet_of(mail.Body),
        "matched_on": matched_on,
    }


def cmd_list_mailboxes(args):
    ns = get_outlook()
    names = list_top_level_mailboxes(ns)
    print(json.dumps({"mailboxes": names,
                       "searched_by_default": ["personal"] + DEFAULT_SHARED_MAILBOXES}))


def cmd_search(args):
    ns = get_outlook()
    folders = resolve_inbox_folders(ns, args.mailbox, include_subfolders=not args.no_subfolders)

    query_lower = args.query.lower()
    scored = []
    dasl_filter = dasl_search_filter(args.query, args.days, include_body=args.include_body)

    for label, folder in folders:
        try:
            matches = folder.Items.Restrict(dasl_filter)
        except Exception:
            continue
        for mail in matches:
            try:
                score, matched_on = score_item(mail, query_lower)
                received = mail.ReceivedTime
            except Exception:
                continue
            scored.append((score, received, mail, label, matched_on))

    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    top = scored[: args.limit]
    results = [item_to_dict(mail, label, matched_on) for _, _, mail, label, matched_on in top]
    print(json.dumps({"query": args.query, "days": args.days, "total_matches": len(scored),
                       "shown": len(results), "mailboxes_searched": [l for l, _ in folders],
                       "results": results}, default=str))


def cmd_recent(args):
    ns = get_outlook()
    folders = resolve_inbox_folders(ns, args.mailbox, include_subfolders=not args.no_subfolders)

    combined = []
    for label, folder in folders:
        try:
            items = restrict_by_date(folder.Items, args.days)
            items.Sort("[ReceivedTime]", True)
        except Exception:
            continue
        for i, mail in enumerate(items):
            if i >= args.limit:
                break
            try:
                combined.append((mail.ReceivedTime, mail, label))
            except Exception:
                continue

    combined.sort(key=lambda t: t[0], reverse=True)
    top = combined[: args.limit]
    results = [item_to_dict(mail, label) for _, mail, label in top]
    print(json.dumps({"shown": len(results), "mailboxes_searched": [l for l, _ in folders],
                       "results": results}, default=str))


def body_html_from_file(path):
    with open(path, "r", encoding="utf-8") as f:
        body_text = f.read()
    return "<div>" + body_text.replace("\n", "<br>") + "</div><br>"


def cmd_reply(args):
    ns = get_outlook()
    try:
        mail = ns.GetItemFromID(args.entry_id, args.store_id)
    except Exception as exc:
        print(json.dumps({"error": f"Could not load message: {exc}"}))
        sys.exit(1)

    reply = mail.ReplyAll()

    if args.subject:
        reply.Subject = args.subject

    if args.body_file:
        reply.HTMLBody = body_html_from_file(args.body_file) + reply.HTMLBody

    for path in args.attach or []:
        reply.Attachments.Add(path)

    reply.Display()
    print(json.dumps({"status": "displayed", "subject": reply.Subject}))


def cmd_compose(args):
    outlook = win32com.client.Dispatch("Outlook.Application")
    mail = outlook.CreateItem(OLMAILITEM)

    mail.To = args.to
    if args.cc:
        mail.CC = args.cc
    mail.Subject = args.subject

    if args.body_file:
        mail.HTMLBody = body_html_from_file(args.body_file) + (mail.HTMLBody or "")

    for path in args.attach or []:
        mail.Attachments.Add(path)

    mail.Display()
    print(json.dumps({"status": "displayed", "to": mail.To, "subject": mail.Subject}))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list-mailboxes").set_defaults(func=cmd_list_mailboxes)

    p_search = sub.add_parser("search")
    p_search.add_argument("query")
    p_search.add_argument("--days", type=int, default=20)
    p_search.add_argument("--mailbox", nargs="*", default=None)
    p_search.add_argument("--limit", type=int, default=5)
    p_search.add_argument("--include-body", dest="include_body", action="store_true",
                           help="Also match body text (much slower on some mailboxes)")
    p_search.add_argument("--no-subfolders", dest="no_subfolders", action="store_true",
                           help="Search only each mailbox's Inbox root, skip its subfolders")
    p_search.set_defaults(func=cmd_search)

    p_recent = sub.add_parser("recent")
    p_recent.add_argument("--days", type=int, default=14)
    p_recent.add_argument("--mailbox", nargs="*", default=None)
    p_recent.add_argument("--limit", type=int, default=10)
    p_recent.add_argument("--no-subfolders", dest="no_subfolders", action="store_true",
                           help="Search only each mailbox's Inbox root, skip its subfolders")
    p_recent.set_defaults(func=cmd_recent)

    p_reply = sub.add_parser("reply")
    p_reply.add_argument("entry_id")
    p_reply.add_argument("store_id")
    p_reply.add_argument("--body-file", dest="body_file", default=None)
    p_reply.add_argument("--subject", default=None)
    p_reply.add_argument("--attach", nargs="*", default=None)
    p_reply.set_defaults(func=cmd_reply)

    p_compose = sub.add_parser("compose")
    p_compose.add_argument("--to", required=True)
    p_compose.add_argument("--cc", default=None)
    p_compose.add_argument("--subject", required=True)
    p_compose.add_argument("--body-file", dest="body_file", default=None)
    p_compose.add_argument("--attach", nargs="*", default=None)
    p_compose.set_defaults(func=cmd_compose)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
