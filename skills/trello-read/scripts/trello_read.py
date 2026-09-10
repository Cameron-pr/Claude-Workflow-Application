"""Read-only Trello lookups, scoped to a single configured board only.
GET requests only - never POST/PUT/DELETE.

Configure via env vars (see .env.example):
    TRELLO_API_KEY, TRELLO_API_TOKEN   from https://trello.com/app-key
    TRELLO_BOARD_ID                    the board to scope all lookups to

Usage:
    python trello_read.py board
    python trello_read.py card <card_id_or_short_link_or_url>
    python trello_read.py list <list_id>
    python trello_read.py search <query>
"""
import os
import re
import sys

from dotenv import load_dotenv
load_dotenv()

import requests

API_KEY = os.environ["TRELLO_API_KEY"]
API_TOKEN = os.environ["TRELLO_API_TOKEN"]
BASE = "https://api.trello.com/1"

BOARD_ID = os.environ["TRELLO_BOARD_ID"]


def _auth_params(**extra):
    params = {"key": API_KEY, "token": API_TOKEN}
    params.update(extra)
    return params


def _get(path, **params):
    resp = requests.get(f"{BASE}{path}", params=_auth_params(**params), timeout=15)
    resp.raise_for_status()
    return resp.json()


def _extract_id(value):
    # Accept a raw ID/shortlink, or a full trello.com URL
    match = re.search(r"trello\.com/(?:c|b)/([A-Za-z0-9]+)", value)
    return match.group(1) if match else value


def _card_on_configured_board(card):
    return card.get("idBoard") == BOARD_ID


def read_board():
    board = _get(f"/boards/{BOARD_ID}", fields="name,url")
    print(f"Board: {board['name']} ({board['url']})")
    lists_ = _get(f"/boards/{BOARD_ID}/lists", fields="name")
    for lst in lists_:
        print(f"\nList: {lst['name']}")
        cards = _get(f"/lists/{lst['id']}/cards", fields="name,due,shortUrl,idShort")
        for c in cards:
            due = f" (due {c['due']})" if c.get("due") else ""
            print(f"  #{c['idShort']}  {c['name']}{due}  {c['shortUrl']}")


def read_card(card_ref):
    card_id = _extract_id(card_ref)
    card = _get(
        f"/cards/{card_id}",
        fields="name,desc,due,dueComplete,url,shortUrl,closed,dateLastActivity,idBoard,idShort",
        list="true",
        checklists="all",
        actions="commentCard",
        actions_limit=20,
        labels="true",
    )
    if not _card_on_configured_board(card):
        print("This skill only reads cards from the configured board — that card is on a different board.")
        return
    print(f"Card: #{card['idShort']} {card['name']}")
    print(f"URL: {card['shortUrl']}")
    print(f"List: {card.get('list', {}).get('name')}")
    print(f"Due: {card.get('due')} (complete: {card.get('dueComplete')})")
    labels = ", ".join(l["name"] for l in card.get("labels", []) if l.get("name"))
    if labels:
        print(f"Labels: {labels}")
    if card.get("desc"):
        print(f"\nDescription:\n{card['desc']}")
    for cl in card.get("checklists", []):
        print(f"\nChecklist: {cl['name']}")
        for item in cl.get("checkItems", []):
            box = "x" if item["state"] == "complete" else " "
            print(f"  [{box}] {item['name']}")
    actions = card.get("actions", [])
    if actions:
        print("\nRecent comments:")
        for a in actions:
            who = a.get("memberCreator", {}).get("fullName", "?")
            text = a.get("data", {}).get("text", "")
            print(f"  - {who}: {text}")


def read_list(list_id):
    lst = _get(f"/lists/{list_id}", fields="name,idBoard")
    if lst.get("idBoard") != BOARD_ID:
        print("This skill only reads lists from the configured board.")
        return
    cards = _get(f"/lists/{list_id}/cards", fields="name,due,shortUrl,idShort")
    for c in cards:
        due = f" (due {c['due']})" if c.get("due") else ""
        print(f"#{c['idShort']}  {c['name']}{due}  {c['shortUrl']}")


def search(query):
    results = _get(
        "/search",
        query=f"{query} board:{BOARD_ID}",
        modelTypes="cards",
        cards_limit=20,
    )
    for c in results.get("cards", []):
        print(f"- {c['name']}  {c['shortUrl']}")


def find(text):
    """Locate a card on the configured board by #number or by name text.

    If exactly one card matches, print its full detail (incl. comments),
    same as `read_card`. If several match, list them so the caller can
    narrow down. If none match, say so.
    """
    all_cards = _get(
        f"/boards/{BOARD_ID}/cards",
        fields="name,idShort,shortUrl,id",
    )

    stripped = text.strip().lstrip("#")
    if stripped.isdigit():
        matches = [c for c in all_cards if str(c["idShort"]) == stripped]
    else:
        needle = text.lower()
        matches = [c for c in all_cards if needle in c["name"].lower()]

    if not matches:
        print(f"No card on the configured board matches: {text}")
        return
    if len(matches) > 1:
        print(f"Multiple cards match '{text}':")
        for c in matches:
            print(f"  #{c['idShort']}  {c['name']}  {c['shortUrl']}")
        print("\nBe more specific, or use `card <id_or_url>` with one of the URLs above.")
        return

    read_card(matches[0]["id"])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "board":
        read_board()
    elif cmd == "card":
        read_card(sys.argv[2])
    elif cmd == "list":
        read_list(sys.argv[2])
    elif cmd == "search":
        search(" ".join(sys.argv[2:]))
    elif cmd == "find":
        find(" ".join(sys.argv[2:]))
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
