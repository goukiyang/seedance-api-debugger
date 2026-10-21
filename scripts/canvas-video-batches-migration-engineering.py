"""Synthetic database only; no production connection, service or provider calls."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration', root / 'ops/sd2-canvas-video-batches-migrate.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
source = (root / migration.SQL_PATH).read_text()
identity = {'schema': 'sd2-canvas-video-batches-migration.v1', 'runId': 'synthetic',
            'source': 'a' * 40, 'guardSource': 'b' * 40, 'manifestSha256': 'c' * 64,
            'sqlSha256': migration.digest(root / migration.SQL_PATH)}
checks = []
with tempfile.TemporaryDirectory(prefix='canvas-batch-migration-') as directory:
    folder = Path(directory).resolve()
    database = folder / 'synthetic.sqlite'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE ExistingTask(id TEXT PRIMARY KEY, frozen INTEGER NOT NULL)')
        db.execute("INSERT INTO ExistingTask VALUES ('original-request', 123)")
    dry = migration.apply_schema(database, folder / 'proof', source, identity)
    assert dry['ready'] and not (folder / 'proof').exists()
    receipt = migration.apply_schema(database, folder / 'proof', source, identity, True)
    assert receipt['completed'] and receipt['businessRowsWritten'] == 0
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT * FROM ExistingTask').fetchall() == [('original-request', 123)]
        assert migration.counts(db, migration.TABLES) == {name: 0 for name in migration.TABLES}
    checks.append('actual additive SQL preserves original rows and creates exactly eleven schema objects')
    again = migration.apply_schema(database, folder / 'proof', source, identity, True)
    assert again['alreadyApplied']
    checks.append('same-run receipt is idempotent and backup verified')
    for changed in [{**identity, 'runId': 'different'}, {**identity, 'source': 'd' * 40}]:
        try:
            migration.apply_schema(database, folder / 'proof', source, changed, True)
            raise AssertionError('changed release identity accepted')
        except RuntimeError:
            pass
    checks.append('wrong run and source cannot adopt existing schema')
    for appended in ['\nDROP TABLE ExistingTask;\n', '\nCREATE TABLE Other(id TEXT);\n', '\nINSERT INTO ExistingTask VALUES ("x",0);\n']:
        try:
            migration.parsed_sql(source + appended)
            raise AssertionError('non-additive SQL accepted')
        except RuntimeError:
            pass
    checks.append('non-additive, foreign object and business writes rejected')
    backup = folder / 'proof/consistent-backup.sqlite'
    with sqlite3.connect(backup) as db:
        assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert not migration.TABLES.intersection(migration.schema(db))
        assert db.execute('SELECT * FROM ExistingTask').fetchall() == [('original-request', 123)]
    checks.append('backup independently readable and contains original pre-migration state')
print(json.dumps({'checks': checks, 'passed': len(checks), 'productionWrites': 0, 'providerCalls': 0}))
