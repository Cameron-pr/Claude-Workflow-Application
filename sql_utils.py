"""
Generic read-only SQL Server helper, built on pyodbc + pandas.

Written for querying an on-prem SQL Server / Dynamics NAV-style database
(hence the Windows `{SQL Server}` driver and the latin-1 byte-decode fix
below), but nothing in here is specific to any one project or vendor.

Credentials come from environment variables (see .env.example) — never
hardcode them. Only ever issue SELECT statements: this project is not
set up with any safety rails against a write, and pointing it at a
production database with `db_username`/`db_password` write access is
squarely on you.

Setup:
    pip install pyodbc pandas python-dotenv

Usage:
    from dotenv import load_dotenv
    load_dotenv()
    import sql_utils

    df = sql_utils.sql_to_df("SELECT TOP 5 * FROM [Some Table]")
"""
import os
import warnings

import pandas as pd
import pyodbc

DB_SERVER = os.getenv("DB_SERVER")
DB_NAME = os.getenv("DB_NAME")
DB_USERNAME = os.getenv("DB_USERNAME")
DB_PASSWORD = os.getenv("DB_PASSWORD")


def get_odbc_connection(server=None, database=None, timeout=15):
    conn = pyodbc.connect(
        DRIVER="{SQL Server}",
        server=server or DB_SERVER,
        database=database or DB_NAME,
        uid=DB_USERNAME,
        pwd=DB_PASSWORD,
        timeout=timeout,
    )
    conn.timeout = timeout
    return conn


def sql_to_df(query, server=None, database=None, timeout=15):
    """Run a SELECT and return the result as a pandas DataFrame."""
    connection = get_odbc_connection(server, database, timeout=timeout)
    cursor = connection.cursor()

    warnings.filterwarnings("ignore")
    df = pd.read_sql(query, connection)
    warnings.filterwarnings("default")

    cursor.close()
    connection.close()

    # The {SQL Server} ODBC driver can return varchar data as raw bytes when
    # a column contains non-ASCII characters (e.g. © = 0xa9 in Windows-1252).
    # Decode those bytes so downstream code doesn't hit a UTF-8 decode error.
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].apply(lambda x: x.decode("latin-1") if isinstance(x, bytes) else x)

    return df


def sql_to_dict(query, server=None, database=None, params=None):
    """Run a query and return rows as dict (single row) or list[dict] (0/many rows)."""
    connection = get_odbc_connection(server, database)
    cursor = connection.cursor()
    if params is not None:
        cursor.execute(query, params)
    else:
        cursor.execute(query)

    columns = [c[0] for c in cursor.description] if cursor.description else []
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]

    cursor.close()
    connection.close()

    if len(rows) == 1:
        return rows[0]
    return rows
