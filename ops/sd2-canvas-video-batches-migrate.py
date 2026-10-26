#!/usr/bin/env python3
"""Apply the reviewed additive canvas batch schema, retaining a consistent backup."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess

SQL_PATH = 'prisma/migrations/20261021180000_canvas_video_batches/migration.sql'
TABLES = {'CanvasVideoBatch', 'CanvasVideoBatchChild'}
OBJECTS = TABLES | {
    'CanvasVideoBatch_active_node_key_key',
    'CanvasVideoBatch_owner_user_id_client_request_id_key',
    'CanvasVideoBatch_owner_user_id_document_id_node_id_created_at_id_idx',
    'CanvasVideoBatch_document_id_idx',
    'CanvasVideoBatchChild_request_id_key',
    'CanvasVideoBatchChild_idempotency_key_key',
    'CanvasVideoBatchChild_task_id_key',
    'CanvasVideoBatchChild_batch_id_ordinal_key',
    'CanvasVideoBatchChild_batch_id_state_idx',
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(file):
    result = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            result.update(block)
    return result.hexdigest()


def save(file, value):
    with Path(file).open('x', encoding='utf-8') as stream:
        os.chmod(file, 0o600)
        json.dump(value, stream, ensure_ascii=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


def schema(db):
    return {row[0]: [row[1], row[2], row[3]] for row in db.execute(
        "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}


def counts(db, names):
    return {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
            for name in sorted(names)}


def object_digest(value):
    return hashlib.sha256(json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def parsed_sql(source):
    statements, pending = [], ''
    for line in source.splitlines(keepends=True):
        if line.lstrip().startswith('--'):
            continue
        pending += line
        if sqlite3.complete_statement(pending):
            statement = pending.strip()
            require(re.match(r'^CREATE (?:TABLE|(?:UNIQUE )?INDEX) "CanvasVideoBatch(?:Child)?(?:_[a-z_]+)?"\s', statement),
                    'Only canvas batch CREATE statements are permitted')
            require(not re.search(r'\b(?:INSERT|ALTER|DROP|REPLACE|TRIGGER|ATTACH|DETACH|VACUUM|PRAGMA)\b', statement, re.I),
                    'Non-additive SQL is forbidden')
            statements.append(statement)
            pending = ''
    require(not pending.strip() and len(statements) == len(OBJECTS), 'Incomplete or unexpected migration')
    with sqlite3.connect(':memory:') as empty:
        for statement in statements:
            empty.execute(statement)
        expected = schema(empty)
        require(set(expected) == OBJECTS, 'Unexpected schema objects')
        require({name for name, value in expected.items() if value[0] == 'table'} == TABLES, 'Unexpected tables')
        require(all(value[1] in TABLES for value in expected.values()), 'Index escaped the new tables')
    return statements, expected


def apply_schema(database, output, source, identity, apply=False):
    database, output = Path(database), Path(output)
    statements, expected = parsed_sql(source)
    receipt_file, backup_file = output / 'receipt.json', output / 'consistent-backup.sqlite'
    db_identity = [str(database.stat().st_dev), str(database.stat().st_ino)]
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=30) as original:
        original.execute('PRAGMA query_only=ON')
        existing = schema(original)
        if OBJECTS.intersection(existing):
            require(receipt_file.is_file(), 'Existing schema requires the original same-run receipt')
            receipt = json.loads(receipt_file.read_text())
            require(all(receipt.get(key) == value for key, value in identity.items()), 'Migration identity changed')
            require(receipt.get('completed') is True and receipt.get('databaseIdentity') == db_identity, 'Incomplete or replaced database')
            require({name: existing.get(name) for name in sorted(OBJECTS)} == expected, 'Migrated schema changed')
            require(digest(backup_file) == receipt['backupSha256'], 'Recovery backup changed')
            return {**receipt, 'alreadyApplied': True}
        if not apply:
            return {**identity, 'ready': True, 'applied': False, 'databaseIdentity': db_identity, 'businessRowsWritten': 0}
        output.mkdir(mode=0o700)
        original.execute('BEGIN')
        before_schema = schema(original)
        before_counts = counts(original, [name for name, value in before_schema.items() if value[0] == 'table'])
        with sqlite3.connect(backup_file) as backup:
            os.chmod(backup_file, 0o600)
            original.backup(backup)
            require(backup.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Backup integrity failed')
            require(schema(backup) == before_schema and counts(backup, before_counts) == before_counts, 'Backup snapshot differs')
        original.rollback()
    backup_sha = digest(backup_file)
    save(output / 'backup-proof.json', {**identity, 'databaseIdentity': db_identity, 'backupSha256': backup_sha,
         'integrity': 'ok', 'consistent': True, 'originalSchemaSha256': object_digest(before_schema),
         'originalTableCounts': before_counts, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    with sqlite3.connect(database, timeout=30, isolation_level=None) as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        try:
            require(schema(db) == before_schema and counts(db, before_counts) == before_counts,
                    'Database changed after the stopped-writer backup')
            changes = db.total_changes
            for statement in statements:
                db.execute(statement)
            after = schema(db)
            require(set(after) - set(before_schema) == OBJECTS, 'Unexpected schema addition')
            require(all(after.get(name) == value for name, value in before_schema.items()), 'Original schema changed')
            require({name: after[name] for name in sorted(OBJECTS)} == expected, 'Added schema differs')
            require(counts(db, before_counts) == before_counts and db.total_changes == changes, 'Business rows changed')
            require(counts(db, TABLES) == {name: 0 for name in TABLES}, 'History backfill is forbidden')
            require([str(database.stat().st_dev), str(database.stat().st_ino)] == db_identity, 'Database identity changed')
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    receipt = {**identity, 'databaseIdentity': db_identity, 'completed': True, 'backupSha256': backup_sha,
               'businessRowsWritten': 0, 'historyBackfilled': False, 'originalSchemaPreserved': True,
               'newObjects': sorted(OBJECTS), 'newSchemaSha256': object_digest(expected),
               'originalSchemaSha256': object_digest(before_schema),
               'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    save(receipt_file, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--sql-sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.getuid() == 0, 'Root-owned release execution required')
    require(args.manifest.resolve() == args.manifest and digest(args.manifest) == args.manifest_sha256, 'Manifest differs')
    manifest = json.loads(args.manifest.read_text())
    require(manifest['project'] == 'video-api-debugger', 'Wrong project')
    stage = Path(manifest['stage'])
    require(str(stage) == '/data/video-api-debugger/release-staging/' + manifest['runId'], 'Wrong staging boundary')
    require(args.manifest == stage / 'manifest.json', 'Manifest boundary differs')
    database = Path(manifest['database'])
    for file in [stage, database]:
        require(file.resolve() == file, 'Path alias refused')
        require(subprocess.check_output(['findmnt', '-n', '-o', 'TARGET', '-T', str(file)], text=True).strip() == '/data', 'Real data mount required')
    require(database.is_file() and database.stat().st_nlink == 1, 'Existing regular database required')
    sql_file = Path(manifest['main']['root']) / SQL_PATH
    require(sql_file.resolve() == sql_file and digest(sql_file) == args.sql_sha256, 'Reviewed SQL differs')
    require(digest(Path(manifest['guard']['root']) / SQL_PATH) == args.sql_sha256, 'Guard schema differs')
    required = manifest['canvasVideoBatchSchema']
    require(required['sqlSha256'] == args.sql_sha256 and digest(Path(__file__)) == required['migrationModuleSha256'], 'Unreviewed migration module')
    space = os.statvfs(stage)
    require(space.f_bavail * space.f_frsize >= max(database.stat().st_size * 3, 1073741824), 'Insufficient backup space')
    identity = {'schema': 'sd2-canvas-video-batches-migration.v1', 'runId': manifest['runId'],
                'source': manifest['mainSource'], 'guardSource': manifest['guardSource'],
                'manifestSha256': args.manifest_sha256, 'sqlSha256': args.sql_sha256}
    print(json.dumps(apply_schema(database, stage / 'canvas-video-batches-migration', sql_file.read_text(), identity, args.apply)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Canvas batch migration stopped; retain the private backup and original release receipts.')
