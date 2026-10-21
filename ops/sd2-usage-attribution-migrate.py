#!/usr/bin/env python3
"""Add the usage-origin table without touching existing business rows."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    with path.open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


def schema(db):
    return {row[0]: (row[1], row[2], row[3]) for row in db.execute(
        "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")}


def counts(db):
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    return {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
            for (name,) in tables if name != 'UsageAttribution'}


def object_digest(objects, names):
    return hashlib.sha256(json.dumps({name: objects[name] for name in sorted(names)},
                                    separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--sql-sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.getuid() == 0, 'Root-owned release execution required')
    require(not args.manifest.is_symlink() and digest(args.manifest) == args.manifest_sha256, 'Release manifest differs')
    manifest = json.loads(args.manifest.read_text())
    require(manifest['project'] == 'video-api-debugger', 'Wrong project')
    stage = Path(manifest['stage'])
    require(stage.is_absolute() and str(stage).startswith('/data/video-api-debugger/release-staging/'), 'Wrong staging boundary')
    require(subprocess.check_output(['findmnt', '-n', '-o', 'TARGET', '-T', str(stage)], text=True).strip() == '/data', 'Real data mount required')
    database = Path(manifest['database'])
    require(not database.is_symlink() and database.is_file(), 'Database must be an existing regular file')
    require(subprocess.check_output(['findmnt', '-n', '-o', 'TARGET', '-T', str(database)], text=True).strip() == '/data', 'Database is not on data mount')
    sql_file = Path(manifest['main']['root']) / 'prisma/migrations/20261021073000_usage_attribution/migration.sql'
    require(not sql_file.is_symlink() and digest(sql_file) == args.sql_sha256, 'Reviewed additive SQL differs')
    statements = [part.strip() for part in sql_file.read_text().split(';') if part.strip()]
    expected_names = {'UsageAttribution', 'UsageAttribution_owner_user_id_occurred_at_idx',
                      'UsageAttribution_project_id_occurred_at_idx', 'UsageAttribution_occurred_at_idx'}
    require(len(statements) == 4 and statements[0].startswith('CREATE TABLE "UsageAttribution" ('), 'Unexpected table migration')
    require(all(re.fullmatch(r'CREATE INDEX "UsageAttribution_[a-z_]+" ON "UsageAttribution"\("[a-z_]+"(?:, "[a-z_]+")?\)', item)
                for item in statements[1:]), 'Only reviewed indexes are allowed')
    require(not re.search(r'\b(INSERT|UPDATE|DELETE|ALTER|DROP|REPLACE|TRIGGER|ATTACH)\b', '\n'.join(statements), re.I), 'Business writes are forbidden')
    free = os.statvfs(stage)
    require(free.f_bavail * free.f_frsize >= max(database.stat().st_size * 3, 1073741824), 'Insufficient backup space')
    output = stage / 'usage-attribution-migration'
    receipt_path = output / 'receipt.json'
    identity = {'schema': 'sd2-usage-attribution-migration.v1', 'runId': manifest['runId'],
                'source': manifest['mainSource'], 'guardSource': manifest['guardSource'],
                'manifestSha256': args.manifest_sha256, 'sqlSha256': args.sql_sha256}
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=30) as source:
        source.execute('PRAGMA query_only=ON')
        existing = schema(source)
        if 'UsageAttribution' in existing:
            require(receipt_path.is_file(), 'Existing table has no same-run migration proof')
            receipt = json.loads(receipt_path.read_text())
            require(all(receipt.get(k) == value for k, value in identity.items()), 'Migration belongs to a different reviewed run')
            require(receipt.get('completed') is True and expected_names <= existing.keys(), 'Incomplete migration proof')
            require(receipt.get('newSchemaSha256') == object_digest(existing, expected_names), 'Migrated table or indexes differ')
            require(digest(output / 'consistent-backup.sqlite') == receipt['backupSha256'], 'Recovery backup differs')
            print(json.dumps({**identity, 'completed': True, 'alreadyApplied': True, 'businessRowsWritten': 0}))
            return
        require(not expected_names.intersection(existing), 'Partial or conflicting schema exists')
        if not args.apply:
            print(json.dumps({**identity, 'ready': True, 'applied': False, 'businessRowsWritten': 0}))
            return
        output.mkdir(mode=0o700)
        backup_file = output / 'consistent-backup.sqlite'
        source.execute('BEGIN')
        before_schema = schema(source)
        before_counts = counts(source)
        with sqlite3.connect(backup_file) as backup:
            os.chmod(backup_file, 0o600)
            source.backup(backup)
            require(backup.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Backup integrity failed')
            require(schema(backup) == before_schema and counts(backup) == before_counts, 'Backup snapshot differs')
        source.rollback()
    backup_sha = digest(backup_file)
    save(output / 'backup-proof.json', {**identity, 'backupSha256': backup_sha, 'consistent': True,
         'integrity': 'ok', 'originalTableCounts': before_counts, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    with sqlite3.connect(database, timeout=30, isolation_level=None) as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            original_schema, original_counts = schema(db), counts(db)
            require('UsageAttribution' not in original_schema, 'Table appeared after backup')
            changes = db.total_changes
            for statement in statements:
                db.execute(statement)
            after_schema = schema(db)
            require(set(after_schema) - set(original_schema) == expected_names, 'Unexpected schema additions')
            require(all(after_schema.get(k) == value for k, value in original_schema.items()), 'Existing schema changed')
            require(counts(db) == original_counts and db.total_changes == changes, 'Original business rows changed')
            require(db.execute('SELECT COUNT(*) FROM "UsageAttribution"').fetchone()[0] == 0, 'Historical backfill is forbidden')
            new_schema_sha = object_digest(after_schema, expected_names)
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    receipt = {**identity, 'completed': True, 'backupSha256': backup_sha, 'businessRowsWritten': 0,
               'historyBackfilled': False, 'originalSchemaPreserved': True, 'newObjects': sorted(expected_names),
               'newSchemaSha256': new_schema_sha,
               'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    save(receipt_path, receipt)
    print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never echo database locations, connection values or database contents.
        raise SystemExit('Usage-origin migration stopped; preserve the private recovery proof and inspect the reviewed inputs.')
