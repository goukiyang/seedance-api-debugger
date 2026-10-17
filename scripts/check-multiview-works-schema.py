#!/usr/bin/env python3
"""Read-only MV05 schema preflight. Never applies DDL or opens a writable DB."""
import argparse
import json
import pathlib
import sqlite3
import sys

EXPECTED = {
    "MultiviewWork": {
        "id", "owner_id", "source_task_id", "project_id", "video_card_id", "base_key", "branch_key", "parent_work_id",
        "title", "schema_version", "revision", "source_version", "source_info_json", "draft_revision", "recipe_json", "recipe_hash",
        "ready_revision", "ready_recipe_json", "ready_manifest_json", "status", "removed_at", "lease_token", "lease_until", "attempts",
        "next_attempt_at", "last_error", "created_at", "updated_at",
    },
    "MultiviewWorkMutation": {"id", "actor_id", "mutation_id", "work_id", "request_hash", "base_revision", "action", "receipt_json", "created_at"},
}
UNIQUE = {
    "MultiviewWork": {("owner_id", "source_task_id", "base_key"), ("owner_id", "branch_key")},
    "MultiviewWorkMutation": {("actor_id", "mutation_id")},
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    database = pathlib.Path(args.database).resolve(strict=True)
    if not database.is_file():
        raise ValueError("Expected an existing SQLite file")
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        present = set(EXPECTED).intersection(names)
        if not present:
            print(json.dumps({"state": "absent", "additiveMigrationRequired": True, "writes": 0}))
            return
        if present != set(EXPECTED):
            raise ValueError("Partial MV05 schema exists; refusing to classify as safe to apply")
        # Generate the reference only in memory; the supplied database remains
        # mode=ro/query_only. Compare types, nullability, defaults and PK too.
        reference = sqlite3.connect(":memory:")
        migration = pathlib.Path(__file__).resolve().parent.parent / "prisma/migrations/20261016230000_multiview_works/migration.sql"
        reference.executescript(migration.read_text(encoding="utf-8"))
        for table, expected in EXPECTED.items():
            actual_info = list(connection.execute('PRAGMA table_info("' + table + '")'))
            if actual_info != list(reference.execute('PRAGMA table_info("' + table + '")')):
                raise ValueError("MV05 column type/default/required/PK differs: " + table)
            columns = {row[1] for row in actual_info}
            if columns != expected:
                raise ValueError("Unexpected MV05 columns: " + table)
            unique = set()
            for index in connection.execute('PRAGMA index_list("' + table + '")'):
                if index[2]:
                    index_name = index[1].replace('"', '""')
                    unique.add(tuple(row[2] for row in connection.execute('PRAGMA index_info("' + index_name + '")')))
            if not UNIQUE[table].issubset(unique):
                raise ValueError("Required MV05 uniqueness protection is missing: " + table)
        fk = list(connection.execute('PRAGMA foreign_key_list("MultiviewWorkMutation")'))
        if not any(row[2] == "MultiviewWork" and row[3] == "work_id" and row[4] == "id" and row[5] == "CASCADE" and row[6] == "RESTRICT" for row in fk):
            raise ValueError("MV05 receipt/work relationship is incompatible")
        reference.close()
        print(json.dumps({"state": "compatible", "additiveMigrationRequired": False, "writes": 0}))
    finally:
        connection.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"state": "incompatible", "error": str(error), "writes": 0}))
        sys.exit(1)
