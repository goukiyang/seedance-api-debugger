#!/usr/bin/env python3
"""Isolated SQLite evidence for the real additive migration and adoption functions."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('mv_action_migrate', root / 'ops/sd2-multiview-action-purpose-migrate.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
sql = (root / migration.SQL_PATH).read_text()
with tempfile.TemporaryDirectory(prefix='sd2-mv-action-purpose-') as directory:
    temp = Path(directory)
    database = temp / 'isolated.sqlite'
    with sqlite3.connect(database) as db:
        for table, time in [('VideoStudioDraft', 'updated_at'), ('VideoStudioRun', 'created_at')]:
            db.execute('CREATE TABLE "' + table + '" (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, prompt TEXT NOT NULL, "' + time + '" TEXT NOT NULL)')
            db.execute('INSERT INTO "' + table + '" VALUES (?,?,?,?)', ('original', 'owner', 'keep original text', '2026-10-28'))
    identity = {'source': 'a' * 40, 'run': 'engineering'}
    output = temp / 'migration'
    assert migration.apply_schema(database, output, sql, identity)['apply'] is False
    assert not output.exists(), 'dry-run wrote migration artifacts'
    def active_writer():
        raise RuntimeError('writer still active')
    try:
        migration.apply_schema(database, output, sql, identity, True, active_writer)
        raise AssertionError('active writer was ignored')
    except RuntimeError as error:
        assert str(error) == 'writer still active'
    assert not output.exists(), 'rejected active writer created artifacts'
    receipt = migration.apply_schema(database, output, sql, identity, True, lambda: None)
    assert receipt['businessRowWrites'] == 0 and receipt['addedColumns'] == 2 and receipt['addedIndexes'] == 2
    assert migration.apply_schema(database, output, sql, identity, True, lambda: None) == receipt, 'same-run migration was replayed'
    with sqlite3.connect(database) as db:
        for table in migration.TABLES:
            assert db.execute('SELECT prompt,purpose FROM "' + table + '" WHERE id=\'original\'').fetchone() == ('keep original text', 'studio')
        # Exercise an old writer that never specifies the new column.
        db.execute('INSERT INTO VideoStudioDraft(id,owner_user_id,prompt,updated_at) VALUES (?,?,?,?)', ('old-client', 'owner', 'still works', '2026-10-28'))
        assert db.execute('SELECT purpose FROM VideoStudioDraft WHERE id=\'old-client\'').fetchone() == ('studio',)
        db.execute('INSERT INTO VideoStudioRun(id,owner_user_id,prompt,created_at,purpose) VALUES (?,?,?,?,?)', ('new-purpose', 'owner', 'new action', '2026-10-28', 'multiview-action'))
    adopted = migration.adopt_schema(database, temp / 'adoption', sql, {'source': 'b' * 40, 'run': 'next'}, output / 'receipt.json', output / 'consistent-backup.sqlite')
    assert adopted['operation'] == 'ADOPT' and adopted['completedAt'] == receipt['completedAt'], 'adoption changed original migration time'
    assert adopted['originalMigrationIdentity'] == identity and adopted['originalFields'] == receipt['originalFields']
    assert adopted['backupSha256'] == receipt['backupSha256']
    try:
        migration.apply_schema(database, temp / 'wrong-receipt', sql, {'source': 'c' * 40, 'run': 'unproven'}, True, lambda: None)
        raise AssertionError('existing schema accepted without original receipt')
    except RuntimeError as error:
        assert 'original receipt' in str(error)
    try:
        migration.apply_schema(database, temp / 'changed-sql', sql + '\nDROP TABLE VideoStudioRun;', identity, False)
        raise AssertionError('destructive SQL was accepted')
    except RuntimeError as error:
        assert 'reviewed additive statements' in str(error)
print('multiview action purpose migration: stopped-writer gate, backup, old fields, defaults, idempotency, adoption and SQL boundary passed')
