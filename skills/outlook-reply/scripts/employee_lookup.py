"""
Look up an internal staff member's email address by name, via a read-only
SELECT against a Dynamics NAV-style "User Setup" table.

This is a live lookup, not a cached list -- staff come and go, so resolving
by name at request time avoids ever handing out a stale address.

Configure via env vars (see .env.example):
    NAV_COMPANY_NAME   Company name prefix NAV uses on its table names,
                        e.g. "Contoso Ltd" for table "Contoso Ltd$User Setup".
                        Leave unset if your table has no such prefix.

Usage (run from the project root so load_dotenv() finds .env):
    PYTHONIOENCODING=utf-8 python employee_lookup.py <name>

Prints JSON: {"matches": [{"user_id", "full_name", "email", "department"}, ...]}
Only ever issues a SELECT -- never writes to the database.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from dotenv import load_dotenv

load_dotenv()

import sql_utils


def escape_like(term):
    return term.replace("'", "''")


def table_name(base):
    company = os.environ.get("NAV_COMPANY_NAME")
    return f"[{company}${base}]" if company else f"[{base}]"


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: employee_lookup.py <name>"}))
        sys.exit(1)

    name = escape_like(sys.argv[1])
    sql = f"""
    SELECT [User ID], [Full Name], [E-Mail], [Department]
    FROM {table_name('User Setup')}
    WHERE [Enabled] = 1 AND [E-Mail] <> '' AND [Full Name] LIKE '%{name}%'
    """
    df = sql_utils.sql_to_df(sql)
    matches = [
        {
            "user_id": row["User ID"],
            "full_name": row["Full Name"],
            "email": row["E-Mail"],
            "department": row["Department"],
        }
        for _, row in df.iterrows()
    ]
    print(json.dumps({"query": sys.argv[1], "matches": matches}, default=str))


if __name__ == "__main__":
    main()
