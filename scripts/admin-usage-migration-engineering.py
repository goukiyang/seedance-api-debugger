#!/usr/bin/env python3
"""Isolated SQLite schema/backup compatibility, not application acceptance."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile


def main():
    root = Path.cwd().resolve()
    destination = Path(sys.argv[1]).resolve()
    scratch = root / '.role-tests'
    assert scratch in destination.parents and not destination.exists()
    sql_path = root / 'prisma/migrations/20261021073000_usage_attribution/migration.sql'
    helper_path = root / 'ops/sd2-usage-attribution-migrate.py'
    spec = importlib.util.spec_from_file_location('usage_migration', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    sql = sql_path.read_text()
    statements = [part.strip() for part in sql.split(';') if part.strip()]
    assert len(statements) == 4 and statements[0].startswith('CREATE TABLE "UsageAttribution" (')
    with tempfile.TemporaryDirectory(prefix='usage-schema-', dir=scratch) as directory:
        fixture = Path(directory) / 'isolated.sqlite'
        backup_path = Path(directory) / 'snapshot.sqlite'
        with sqlite3.connect(fixture) as db:
            db.execute('CREATE TABLE OriginalBusiness (id TEXT PRIMARY KEY, owner TEXT, amount INTEGER)')
            db.execute("INSERT INTO OriginalBusiness VALUES ('original', 'owner-before', 125)")
            db.commit()
            db.execute('BEGIN')
            before_schema, before_counts = helper.schema(db), helper.counts(db)
            with sqlite3.connect(backup_path) as backup:
                db.backup(backup)
                assert backup.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
                assert helper.schema(backup) == before_schema and helper.counts(backup) == before_counts
            db.rollback()
            db.execute('BEGIN IMMEDIATE')
            changes = db.total_changes
            for statement in statements:
                db.execute(statement)
            assert db.total_changes == changes
            assert helper.counts(db) == before_counts
            assert all(helper.schema(db)[key] == value for key, value in before_schema.items())
            assert db.execute('SELECT COUNT(*) FROM UsageAttribution').fetchone()[0] == 0
            db.commit()
            # The unchanged original reader remains valid after the additive DDL.
            assert db.execute('SELECT id,owner,amount FROM OriginalBusiness').fetchall() == [('original', 'owner-before', 125)]
            db.execute('INSERT INTO UsageAttribution (source_kind,source_id,actor_user_id,owner_user_id,project_id,occurred_at,context_version,context_origin) VALUES (?,?,?,?,?,?,?,?)',
                       ('agent_text_step', 'step-original', 'actor', 'owner-before', None, 1792569600000, 1, 'isolated-schema-proof'))
            db.execute("UPDATE OriginalBusiness SET owner='owner-after'")
            db.commit()
            assert db.execute('SELECT owner_user_id FROM UsageAttribution').fetchall() == [('owner-before',)]
            try:
                db.execute('INSERT INTO UsageAttribution SELECT * FROM UsageAttribution')
                raise AssertionError('Duplicate origin was accepted')
            except sqlite3.IntegrityError:
                db.rollback()
            with sqlite3.connect(backup_path) as backup, sqlite3.connect(':memory:') as restored:
                backup.backup(restored)
                assert helper.schema(restored) == before_schema and helper.counts(restored) == before_counts
                assert restored.execute('SELECT id,owner,amount FROM OriginalBusiness').fetchall() == [('original', 'owner-before', 125)]
                assert 'UsageAttribution' not in helper.schema(restored)
    receipt = {'schema': 'admin-usage-migration-engineering.v1', 'completed': True, 'synthetic': True,
               'applicationDatabaseOpened': False, 'productionWrites': 0, 'paidRequests': 0, 'browserRuns': 0,
               'checks': ['consistent_backup_integrity_and_restore', 'additive_ddl_preserves_original_schema_and_rows',
                          'old_reader_compatible_and_new_table_empty', 'unique_frozen_origin_survives_current_owner_change'],
               'sourceSha256': {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest()
                                for file in [Path(__file__).resolve(), sql_path, helper_path]}}
    with destination.open('x') as stream:
        destination.chmod(0o600)
        json.dump(receipt, stream, indent=2)
    print('USAGE_MIGRATION_ENGINEERING_RECEIPT=' + str(destination))


if __name__ == '__main__':
    main()
