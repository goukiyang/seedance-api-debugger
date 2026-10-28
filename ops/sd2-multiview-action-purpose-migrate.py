#!/usr/bin/env python3
"""Reviewed additive purpose columns; called only by the protected release after writer drain."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess

SQL_PATH = 'prisma/migrations/20261028170000_multiview_action_purpose/migration.sql'
TABLES = ('VideoStudioDraft', 'VideoStudioRun')
INDEXES = ('VideoStudioDraft_owner_user_id_purpose_updated_at_idx', 'VideoStudioRun_owner_user_id_purpose_created_at_idx')
WRITERS = ('sd2-gray.service', 'sd2-image-studio.service', 'sd2-hd-derivatives.service', 'sd2-multiview-works.service', 'sd2-role-coordinator.service', 'sd2-template-prompts.service')
EXPECTED_SQL = '''ALTER TABLE "VideoStudioDraft" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE "VideoStudioRun" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'studio';
CREATE INDEX "VideoStudioDraft_owner_user_id_purpose_updated_at_idx" ON "VideoStudioDraft"("owner_user_id", "purpose", "updated_at");
CREATE INDEX "VideoStudioRun_owner_user_id_purpose_created_at_idx" ON "VideoStudioRun"("owner_user_id", "purpose", "created_at");'''


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest_file(file):
    result = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            result.update(chunk)
    return result.hexdigest()


def old_content(db, table, columns):
    names = ','.join('"' + column.replace('"', '""') + '"' for column in columns)
    result = hashlib.sha256()
    count = 0
    for row in db.execute('SELECT ' + names + ' FROM "' + table + '" ORDER BY id'):
        # These Studio tables contain only scalar TEXT/integer/time fields.
        result.update(json.dumps(row, ensure_ascii=True, separators=(',', ':'), default=str).encode())
        result.update(b'\n')
        count += 1
    return {'rows': count, 'sha256': result.hexdigest()}


def stopped_writers():
    for unit in WRITERS:
        state = subprocess.check_output(['systemctl', 'show', unit, '--property=ActiveState', '--value'], text=True).strip()
        require(state in ('inactive', 'failed'), 'Existing writer has not stopped: ' + unit)
        pid = subprocess.check_output(['systemctl', 'show', unit, '--property=MainPID', '--value'], text=True).strip()
        require(pid == '0', 'Existing writer still has a main process: ' + unit)


def apply_schema(database, output, source, identity, apply=False, observe_stopped=stopped_writers):
    """No data rewrite. Test callers can supply an isolated writer observer, never a production bypass flag."""
    database, output = Path(database).resolve(), Path(output).resolve()
    sql = '\n'.join(line.strip() for line in source.splitlines() if line.strip() and not line.lstrip().startswith('--'))
    require(sql == EXPECTED_SQL, 'Migration SQL differs from the reviewed additive statements')
    require(database.is_file(), 'Database is missing')
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=30) as before:
        require(before.execute('PRAGMA quick_check').fetchone() == ('ok',), 'Original database is not healthy')
        columns = {table: [row[1] for row in before.execute('PRAGMA table_info("' + table + '")')] for table in TABLES}
        require(all(columns.values()), 'Studio source tables are missing')
        present = ['purpose' in columns[table] for table in TABLES]
        if any(present):
            require(all(present), 'Partial purpose schema; stop and reconcile the original migration')
            require(all(before.execute('SELECT 1 FROM sqlite_master WHERE type=\'index\' AND name=?', (name,)).fetchone() for name in INDEXES), 'Purpose indexes are incomplete')
            receipt_file = output / 'receipt.json'
            require(receipt_file.is_file(), 'Existing migration needs the original receipt, never a new fabricated receipt')
            receipt = json.loads(receipt_file.read_text())
            require(receipt.get('identity') == identity and receipt.get('sqlSha256') == hashlib.sha256(source.encode()).hexdigest() and receipt.get('completed') is True, 'Original migration identity differs')
            require(receipt.get('databaseIdentity') == [str(database.stat().st_dev), str(database.stat().st_ino)], 'Database file identity changed')
            require((output / 'consistent-backup.sqlite').is_file() and digest_file(output / 'consistent-backup.sqlite') == receipt.get('backupSha256'), 'Original backup is missing or changed')
            return receipt
        original = {table: old_content(before, table, columns[table]) for table in TABLES}
        if not apply:
            return {'ready': True, 'apply': False, 'tables': original, 'addsColumns': 2, 'addsIndexes': 2}
        observe_stopped()
        require(not output.exists(), 'Migration output already exists; retain it and reconcile, do not overwrite')
        output.mkdir(mode=0o700, parents=True)
        backup = output / 'consistent-backup.sqlite'
        with sqlite3.connect(backup) as saved:
            before.backup(saved)
            require(saved.execute('PRAGMA quick_check').fetchone() == ('ok',), 'Consistent backup is not healthy')
        os.chmod(backup, 0o600)
    observe_stopped()
    with sqlite3.connect(database, timeout=30, isolation_level=None) as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            require({table: old_content(db, table, columns[table]) for table in TABLES} == original, 'Studio rows changed after backup')
            for statement in EXPECTED_SQL.split(';'):
                if statement.strip():
                    db.execute(statement)
            require({table: old_content(db, table, columns[table]) for table in TABLES} == original, 'Existing Studio fields changed')
            for table in TABLES:
                require(db.execute('SELECT COUNT(*) FROM "' + table + '" WHERE purpose != \'studio\' OR purpose IS NULL').fetchone() == (0,), 'Historical purpose changed')
                added = list(db.execute('PRAGMA table_info("' + table + '")'))[-1]
                require(added[1:5] == ('purpose', 'TEXT', 1, "'studio'"), 'Unexpected purpose column declaration')
            require(db.execute('PRAGMA quick_check').fetchone() == ('ok',), 'Migrated database is not healthy')
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    receipt = {'schema': 'sd2-multiview-action-purpose.v1', 'completed': True, 'identity': identity,
               'databaseIdentity': [str(database.stat().st_dev), str(database.stat().st_ino)],
               'sqlSha256': hashlib.sha256(source.encode()).hexdigest(), 'backupSha256': digest_file(backup),
               'originalFields': original, 'addedColumns': 2, 'addedIndexes': 2, 'businessRowWrites': 0,
               'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with (output / 'receipt.json').open('x') as stream:
        os.chmod(output / 'receipt.json', 0o600)
        json.dump(receipt, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    return receipt


def adopt_schema(database, output, source, identity, original_receipt_file, original_backup_file):
    """Preserve the original migration/backup evidence, inspect the same current database, write no DB rows."""
    database, output = Path(database).resolve(), Path(output).resolve()
    original_receipt_file, original_backup_file = Path(original_receipt_file).resolve(), Path(original_backup_file).resolve()
    original = json.loads(original_receipt_file.read_text())
    require(original.get('schema') == 'sd2-multiview-action-purpose.v1' and original.get('completed') is True, 'Original migration did not complete')
    require(original.get('sqlSha256') == hashlib.sha256(source.encode()).hexdigest(), 'Original migration SQL differs')
    require(original.get('databaseIdentity') == [str(database.stat().st_dev), str(database.stat().st_ino)], 'Cannot adopt a different database')
    require(original_backup_file.is_file() and digest_file(original_backup_file) == original.get('backupSha256'), 'Original backup changed')
    with sqlite3.connect(original_backup_file.as_uri() + '?mode=ro', uri=True, timeout=30) as backup:
        require(backup.execute('PRAGMA quick_check').fetchone() == ('ok',), 'Original backup is not healthy')
        for table in TABLES:
            columns = [row[1] for row in backup.execute('PRAGMA table_info("' + table + '")')]
            require('purpose' not in columns and old_content(backup, table, columns) == original['originalFields'][table], 'Original fields proof differs from its backup')
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=30) as db:
        require(db.execute('PRAGMA quick_check').fetchone() == ('ok',), 'Current database is not healthy')
        for table in TABLES:
            added = [row for row in db.execute('PRAGMA table_info("' + table + '")') if row[1] == 'purpose']
            require(len(added) == 1 and added[0][1:5] == ('purpose', 'TEXT', 1, "'studio'"), 'Current purpose column differs')
        require(all(db.execute('SELECT 1 FROM sqlite_master WHERE type=\'index\' AND name=?', (name,)).fetchone() for name in INDEXES), 'Current purpose indexes are incomplete')
    result = {**original, 'operation': 'ADOPT', 'identity': identity, 'originalMigrationIdentity': original['identity'],
              'originalMigrationReceipt': str(original_receipt_file), 'originalMigrationReceiptSha256': digest_file(original_receipt_file),
              'backupReference': str(original_backup_file), 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    require(not output.exists(), 'Adoption output exists; preserve its original evidence')
    output.mkdir(mode=0o700, parents=True)
    with (output / 'receipt.json').open('x') as stream:
        os.chmod(output / 'receipt.json', 0o600)
        json.dump(result, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--adopt-receipt')
    parser.add_argument('--adopt-backup')
    args = parser.parse_args()
    require(re.fullmatch(r'[a-f0-9]{40}', args.source), 'Exact candidate source is required')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args.run), 'Release run is invalid')
    source = (Path(__file__).resolve().parent.parent / SQL_PATH).read_text()
    identity = {'source': args.source, 'run': args.run}
    require(not args.apply or not args.adopt_receipt, 'Apply and adopt are separate operations')
    if args.adopt_receipt:
        require(args.adopt_backup, 'Original backup path is required')
        result = adopt_schema(args.database, args.output, source, identity, args.adopt_receipt, args.adopt_backup)
    else:
        require(not args.adopt_backup, 'Adopt backup requires its original receipt')
        result = apply_schema(args.database, args.output, source, identity, args.apply)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
