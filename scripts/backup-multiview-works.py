#!/usr/bin/env python3
"""One-shot SQLite snapshot plus its referenced immutable multiview files.

Production: --database /data/video-api-debugger/var-lib/dev.db
  --source-root /data/video-api-debugger/var-lib/storage/multiview-works
  --destination /data/video-api-debugger/backups/multiview-works-<unique-name>
--non-production permits explicit isolated absolute paths. Linux renameat2 is required.
No generation, live-table writes, history cleanup, environment or credential reads.
Optional --recipe-root / --uploads-root must use the canonical data-disk roots in production.
--verify-backup <isolated-copy> --non-production only reads and verifies a backup; it never restores live data.
"""

import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import sqlite3
import stat
import struct
import sys
import time
import uuid
import zlib
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


PRODUCTION_BASE = Path('/data/video-api-debugger')
PRODUCTION_WORKS = PRODUCTION_BASE / 'var-lib/storage/multiview-works'
PRODUCTION_RECIPES = PRODUCTION_BASE / 'var-lib/storage/multiview-recipes'
PRODUCTION_SOURCES = PRODUCTION_BASE / 'var-lib/storage/multiview-sources'
PRODUCTION_UPLOADS = PRODUCTION_BASE / 'var-lib/uploads'
PRODUCTION_BACKUPS = PRODUCTION_BASE / 'backups'
MINIMUM_FREE = 5 * 1024 ** 3
MAXIMUM_REVISION_BYTES = 1536 * 1024 ** 2
MAXIMUM_MEDIA_BYTES = 64 * 1024 ** 3
MAXIMUM_READY_WORKS = 100000
MAXIMUM_PRIVATE_RECORDS = 100000
MAXIMUM_GUIDE_BYTES = 30000000
RECIPE_PREFIX = 'multiview_rotation_preset_v1:version:'
RECIPE_CURRENT = 'multiview_rotation_preset_v1:current'
OUTPUT_PREFIX = 'multiview_output_registration_v1:receipt:'
SITE_ORIGINS = {'https://sd2.youdooart.com', 'https://sd2.youdoodesign.com', 'https://sd2-server.youdoodesign.com'}
PRIVATE_IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,179}\Z')
RECIPE_VERSION = re.compile(r'1\.0\.(?:0|[1-9][0-9]{0,15})\Z')
SNAPSHOT_TIMEOUT_SECONDS = 15 * 60
TOTAL_TIMEOUT_SECONDS = 90 * 60
deadline = None
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
SLOT_ID = re.compile(r'[A-Za-z0-9-]{1,80}\Z')
BASENAME = re.compile(r'[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|zip)\Z')
BACKUP_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class BackupError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise BackupError(code)


def check_time():
    require(deadline is None or time.monotonic() < deadline, 'backup_time_budget_exceeded')


def absolute_path(value):
    path = Path(value)
    require(path.is_absolute() and '..' not in path.parts and str(path) == os.path.normpath(value), 'absolute_normalized_path_required')
    return path


def open_directory(path):
    """Walk from / using directory FDs; reject symlinks in every component."""
    descriptor = os.open('/', DIRECTORY_FLAGS)
    try:
        for component in path.parts[1:]:
            following = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_isolated_directory(directory):
    """Pin a private non-production copy; Linux copies must stay on the actual data disk."""
    directory = absolute_path(str(directory))
    require(directory != PRODUCTION_BASE and PRODUCTION_BASE not in directory.parents,
            'isolated_directory_must_be_outside_production')
    require(directory.resolve(strict=True) == directory, 'isolated_directory_must_be_canonical')
    descriptor = open_directory(directory)
    try:
        info = os.fstat(descriptor)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                'isolated_directory_must_be_owned_private_0700')
        if sys.platform == 'linux':
            require(Path('/data') in directory.parents, 'isolated_directory_must_use_data_disk')
            data_fd = open_directory(Path('/data'))
            try:
                data = os.fstat(data_fd)
                require(data.st_dev != os.stat('/').st_dev, 'real_data_mount_required')
                require(info.st_dev == data.st_dev, 'isolated_directory_must_use_actual_data_mount')
            finally:
                os.close(data_fd)
        named = os.stat(directory, follow_symlinks=False)
        require(stat.S_ISDIR(named.st_mode) and info.st_dev == named.st_dev and info.st_ino == named.st_ino
                and named.st_uid == os.geteuid() and stat.S_IMODE(named.st_mode) == 0o700
                and directory.resolve(strict=True) == directory, 'isolated_directory_identity_changed')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def regular_file(directory_fd, name):
    descriptor = os.open(name, READ_FLAGS, dir_fd=directory_fd)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'file_not_single_regular_file')
        return descriptor, info
    except BaseException:
        os.close(descriptor)
        raise


def available_space(directory_fd, additional=0):
    check_time()
    disk = os.fstatvfs(directory_fd)
    require(disk.f_bavail * disk.f_frsize >= MINIMUM_FREE + additional, 'backup_space_below_reserve')


def same_file(before, after):
    return before.st_dev == after.st_dev and before.st_ino == after.st_ino and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns and after.st_nlink == 1


def digest_file(directory_fd, name):
    descriptor, before = regular_file(directory_fd, name)
    digest = hashlib.sha256()
    count = 0
    try:
        while True:
            check_time()
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            count += len(chunk)
        require(count == before.st_size and same_file(before, os.fstat(descriptor)), 'file_changed_during_hash')
    finally:
        os.close(descriptor)
    return {'bytes': count, 'sha256': digest.hexdigest()}


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def write_private(directory_fd, name, data):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb', closefd=False) as target:
            target.write(data)
            target.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def child_directory(parent_fd, name):
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    require(stat.S_IMODE(os.fstat(descriptor).st_mode) == 0o700, 'backup_directory_not_private')
    os.fsync(parent_fd)
    return descriptor


def readonly_database(path, immutable=False):
    suffix = '&immutable=1' if immutable else ''
    connection = sqlite3.connect('file:' + quote(str(path), safe='/') + '?mode=ro' + suffix, uri=True, timeout=30)
    connection.execute('PRAGMA query_only=ON')
    return connection


def create_snapshot(database, staging, staging_fd, parent_fd):
    database_parent = open_directory(database.parent)
    source_fd = None
    try:
        source_fd, source_identity = regular_file(database_parent, database.name)
        available_space(parent_fd, source_identity.st_size)
        snapshot_name = 'database.sqlite3'
        descriptor = os.open(snapshot_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=staging_fd)
        os.close(descriptor)
        snapshot_deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS

        def progress(_status, _remaining, _total):
            require(time.monotonic() < snapshot_deadline, 'sqlite_snapshot_time_budget_exceeded')
            available_space(parent_fd)

        source = readonly_database(database)
        target = sqlite3.connect(str(staging / snapshot_name), timeout=30)
        try:
            target.set_progress_handler(lambda: 1 if time.monotonic() >= snapshot_deadline or deadline is not None and time.monotonic() >= deadline else 0, 10000)
            source.backup(target, pages=256, progress=progress, sleep=0.1)
            target.execute('PRAGMA journal_mode=DELETE')
            require(target.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'sqlite_snapshot_integrity_failed')
            target.commit()
        finally:
            target.close()
            source.close()
        current = os.stat(database.name, dir_fd=database_parent, follow_symlinks=False)
        require(stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and current.st_dev == source_identity.st_dev
                and current.st_ino == source_identity.st_ino, 'source_database_identity_changed')
        descriptor, _ = regular_file(staging_fd, snapshot_name)
        try:
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return digest_file(staging_fd, snapshot_name)
    finally:
        if source_fd is not None:
            os.close(source_fd)
        os.close(database_parent)


def integer(value, minimum=1):
    return type(value) is int and minimum <= value <= 9007199254740991


def load_ready_works(snapshot):
    """All metadata selection is against the closed, immutable snapshot only."""
    connection = readonly_database(snapshot, immutable=True)
    connection.row_factory = sqlite3.Row
    try:
        required = {
            'MultiviewWork': {'id', 'owner_id', 'source_version', 'draft_revision', 'ready_revision', 'ready_recipe_json', 'ready_manifest_json', 'removed_at'},
            'MultiviewWorkMutation': {'id', 'actor_id', 'mutation_id', 'work_id', 'request_hash', 'receipt_json'},
        }
        for table, columns in required.items():
            present = {row['name'] for row in connection.execute('PRAGMA table_info("' + table + '")')}
            require(columns.issubset(present), 'multiview_backup_schema_missing_or_incompatible')
        total_works = connection.execute('SELECT count(*) FROM "MultiviewWork"').fetchone()[0]
        ready_count = connection.execute('SELECT count(*) FROM "MultiviewWork" WHERE ready_revision IS NOT NULL '
                                         'OR ready_manifest_json IS NOT NULL OR ready_recipe_json IS NOT NULL').fetchone()[0]
        require(ready_count <= MAXIMUM_READY_WORKS, 'ready_work_inventory_budget_exceeded')
        # No status/removed filter: pending new drafts still require their previous ready files.
        rows = connection.execute('SELECT id, owner_id, source_version, draft_revision, ready_revision, ready_recipe_json, '
                                  'ready_manifest_json, removed_at FROM "MultiviewWork" '
                                  'WHERE ready_revision IS NOT NULL OR ready_manifest_json IS NOT NULL OR ready_recipe_json IS NOT NULL '
                                  'ORDER BY owner_id, id').fetchall()
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='MultiviewShare'").fetchone():
            rows += connection.execute('SELECT work_id AS id, owner_id, source_version, revision AS draft_revision, '
                                       'revision AS ready_revision, recipe_json AS ready_recipe_json, manifest_json AS ready_manifest_json, '
                                       'NULL AS removed_at FROM MultiviewShare ORDER BY owner_id, work_id, revision').fetchall()
        require(len(rows) <= MAXIMUM_READY_WORKS, 'ready_work_inventory_budget_exceeded')
        seen = {}
        works = []
        for row in rows:
            check_time()
            identity = (row['owner_id'], row['id'], row['ready_revision'])
            if identity in seen:
                require(seen[identity] == row['ready_manifest_json'], 'snapshot_revision_manifest_conflict')
                continue
            seen[identity] = row['ready_manifest_json']
            require(isinstance(row['id'], str) and IDENTIFIER.fullmatch(row['id']) and isinstance(row['owner_id'], str)
                    and IDENTIFIER.fullmatch(row['owner_id']) and integer(row['ready_revision']), 'ready_work_identity_invalid')
            require(isinstance(row['ready_recipe_json'], str) and len(row['ready_recipe_json'].encode('utf-8')) <= 100000
                    and isinstance(row['ready_manifest_json'], str) and len(row['ready_manifest_json'].encode('utf-8')) <= 100000, 'ready_work_metadata_missing')
            recipe = json.loads(row['ready_recipe_json'])
            manifest = json.loads(row['ready_manifest_json'])
            require(isinstance(recipe, dict) and isinstance(manifest, dict) and recipe.get('schema') in (1, 2) and manifest.get('schema') == 1, 'ready_work_schema_invalid')
            slots = recipe.get('slots')
            require(isinstance(slots, list) and len(slots) in (3, 4, 8)
                    and all(isinstance(slot, dict) and isinstance(slot.get('id'), str) and SLOT_ID.fullmatch(slot['id']) for slot in slots), 'ready_work_slots_invalid')
            roles = {'thumbnail', 'collage', 'zip'} | {'frame-' + slot['id'] for slot in slots}
            require(len(roles) == len(slots) + 3 and manifest.get('revision') == row['ready_revision']
                    and isinstance(row['source_version'], str) and SHA256.fullmatch(row['source_version'])
                    and manifest.get('sourceVersion') == row['source_version'] == recipe.get('sourceVersion')
                    and manifest.get('recipeHash') == hashlib.sha256(row['ready_recipe_json'].encode('utf-8')).hexdigest()
                    and manifest.get('frameCount') == len(slots) and integer(manifest.get('width')) and integer(manifest.get('height'))
                    and manifest['width'] * manifest['height'] <= 64000000, 'ready_work_manifest_binding_invalid')
            files = manifest.get('files')
            require(isinstance(files, list) and len(files) == len(roles), 'ready_work_files_incomplete')
            seen_roles, seen_files = set(), set()
            for entry in files:
                require(isinstance(entry, dict) and isinstance(entry.get('role'), str) and entry['role'] in roles
                        and isinstance(entry.get('file'), str) and BASENAME.fullmatch(entry['file'])
                        and entry['file'] not in seen_files and entry['role'] not in seen_roles
                        and integer(entry.get('bytes')) and entry['bytes'] <= MAXIMUM_REVISION_BYTES
                        and isinstance(entry.get('sha256'), str) and SHA256.fullmatch(entry['sha256']), 'ready_file_metadata_invalid')
                role, mime = entry['role'], entry.get('mime')
                allowed = ('application/zip',) if role == 'zip' else ('image/png', 'image/jpeg') if role == 'thumbnail' else ('image/png',)
                extension = Path(entry['file']).suffix
                require(mime in allowed and extension in ({'application/zip': ('.zip',), 'image/png': ('.png',), 'image/jpeg': ('.jpg', '.jpeg')}[mime]), 'ready_file_role_or_basename_invalid')
                require(role == 'zip' or integer(entry.get('width')) and integer(entry.get('height')), 'ready_file_dimensions_invalid')
                seen_roles.add(role)
                seen_files.add(entry['file'])
            require(seen_roles == roles and sum(entry['bytes'] for entry in files) <= MAXIMUM_REVISION_BYTES, 'ready_work_files_incomplete')
            works.append({'ownerId': row['owner_id'], 'workId': row['id'], 'readyRevision': row['ready_revision'],
                          'draftRevision': row['draft_revision'], 'removed': row['removed_at'] is not None,
                          'manifest': manifest})
        return total_works, works
    finally:
        connection.close()


def load_source_inventory(snapshot):
    connection = readonly_database(snapshot, immutable=True)
    connection.row_factory = sqlite3.Row
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='MultiviewSource'").fetchone():
            return []
        rows = connection.execute('SELECT id, owner_id, file_path, file_bytes, file_sha256 FROM MultiviewSource ORDER BY id LIMIT ?',
                                  (MAXIMUM_PRIVATE_RECORDS + 1,)).fetchall()
        require(len(rows) <= MAXIMUM_PRIVATE_RECORDS, 'source_inventory_budget_exceeded')
        result = []
        for row in rows:
            require(IDENTIFIER.fullmatch(row['id']) and IDENTIFIER.fullmatch(row['owner_id'])
                    and re.fullmatch(r'[a-f0-9]{64}\.mp4', row['file_path']) and SHA256.fullmatch(row['file_sha256'])
                    and integer(row['file_bytes']) and row['file_bytes'] <= 128 * 1024 ** 2, 'source_inventory_invalid')
            result.append({'id': row['id'], 'ownerId': row['owner_id'], 'file': row['file_path'],
                           'bytes': row['file_bytes'], 'sha256': row['file_sha256']})
        return result
    finally:
        connection.close()


def local_upload_parts(value):
    """Only known site aliases resolve to local files; never fetch remote URLs."""
    require(isinstance(value, str) and 0 < len(value) <= 4096 and '\\' not in value, 'output_upload_url_invalid')
    url = urlsplit(value)
    if url.scheme or url.netloc:
        require(url.scheme in ('http', 'https') and not url.username and not url.password,
                'output_upload_origin_invalid')
        port = url.port
        origin = url.scheme + '://' + (url.hostname or '').lower()
        if port is not None and port != (443 if url.scheme == 'https' else 80):
            origin += ':' + str(port)
        require(origin in SITE_ORIGINS, 'output_upload_origin_not_local')
    require(not re.search(r'%(?:2f|5c|00)', url.path, re.I), 'output_upload_path_encoding_invalid')
    path = unquote(url.path, errors='strict')
    require(path.startswith('/uploads/') and '\\' not in path and not any(ord(char) < 32 or ord(char) == 127 for char in path),
            'output_upload_path_invalid')
    parts = path[len('/uploads/'):].split('/')
    require(1 <= len(parts) <= 12 and all(part not in ('', '.', '..') and len(os.fsencode(part)) <= 255 for part in parts),
            'output_upload_path_invalid')
    return parts


def required_columns(connection, table, columns):
    present = {row['name'] for row in connection.execute('PRAGMA table_info("' + table + '")')}
    require(set(columns).issubset(present), 'private_media_snapshot_schema_incompatible')


def load_private_inventory(snapshot):
    """SQL projects bindings only. Full recipe text never enters Python or logs."""
    connection = readonly_database(snapshot, immutable=True)
    connection.row_factory = sqlite3.Row
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='PlatformSetting'").fetchone():
            return [], []
        required_columns(connection, 'PlatformSetting', {'key', 'value_json'})
        settings = connection.execute('''WITH settings AS (
          SELECT key, json_valid(value_json) AS valid,
            CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END AS safe
          FROM PlatformSetting WHERE key = ? OR substr(key, 1, ?) = ?)
          SELECT key, valid, json_type(safe, '$.preset.compositionReference') AS binding_type,
            json_extract(safe, '$.revision') AS revision, json_type(safe, '$.revision') AS revision_type,
            json_extract(safe, '$.preset.id') AS preset_id,
            json_extract(safe, '$.preset.version') AS version,
            json_extract(safe, '$.preset.compositionReference') AS binding_json
          FROM settings ORDER BY key LIMIT ?''',
          (RECIPE_CURRENT, len(RECIPE_PREFIX), RECIPE_PREFIX, MAXIMUM_PRIVATE_RECORDS + 1)).fetchall()
        require(len(settings) <= MAXIMUM_PRIVATE_RECORDS, 'recipe_inventory_budget_exceeded')
        recipes = []
        for row in settings:
            check_time()
            require(row['valid'] == 1, 'recipe_metadata_invalid')
            if row['binding_type'] is None:
                continue  # Unchanged legacy recipes have no private guide binding.
            require(row['binding_type'] == 'object' and isinstance(row['version'], str)
                    and RECIPE_VERSION.fullmatch(row['version']) and row['revision_type'] == 'integer' and integer(row['revision'], 0)
                    and row['version'] == '1.0.' + str(row['revision']) and row['preset_id'] == 'multiview-360',
                    'recipe_version_binding_invalid')
            binding = json.loads(row['binding_json'])
            require(isinstance(binding, dict) and set(binding) == {'assetId', 'referenceImageId', 'ownerId', 'sha256'}
                    and all(isinstance(binding[key], str) and PRIVATE_IDENTIFIER.fullmatch(binding[key])
                            for key in ('assetId', 'referenceImageId', 'ownerId'))
                    and isinstance(binding['sha256'], str) and SHA256.fullmatch(binding['sha256']), 'recipe_reference_binding_invalid')
            if row['key'] == RECIPE_CURRENT:
                continue
            require(row['key'] == RECIPE_PREFIX + row['version'], 'recipe_immutable_version_key_invalid')
            required_columns(connection, 'Asset', {'id', 'owner_id', 'hash', 'file_size', 'mime_type', 'width', 'height', 'type', 'status'})
            required_columns(connection, 'ReferenceImage', {'id', 'owner_user_id', 'asset_id'})
            asset = connection.execute('SELECT id, owner_id, hash, file_size, mime_type, width, height, type, status '
                                       'FROM Asset WHERE id = ?', (binding['assetId'],)).fetchone()
            reference = connection.execute('SELECT id, owner_user_id, asset_id FROM ReferenceImage WHERE id = ?',
                                           (binding['referenceImageId'],)).fetchone()
            require(asset is not None and reference is not None and asset['owner_id'] == binding['ownerId']
                    and reference['owner_user_id'] == binding['ownerId'] and reference['asset_id'] == binding['assetId']
                    and asset['type'] == 'image' and asset['mime_type'] == 'image/png'
                    and asset['hash'] in (None, binding['sha256']) and integer(asset['file_size'], 24)
                    and asset['file_size'] < MAXIMUM_GUIDE_BYTES and integer(asset['width']) and integer(asset['height'])
                    and asset['width'] * asset['height'] <= 40000000, 'recipe_asset_snapshot_binding_invalid')
            recipes.append({'versionKey': row['key'], 'version': row['version'], 'revision': row['revision'], 'binding': binding,
                            'file': binding['sha256'] + '.png', 'sha256': binding['sha256'], 'bytes': asset['file_size'],
                            'width': asset['width'], 'height': asset['height'], 'mime': 'image/png'})
        if recipes or any(row['binding_type'] is not None for row in settings):
            # Compare inside SQLite: neither the prompt nor the complete preset is returned.
            current_matches = connection.execute('''SELECT count(*) FROM PlatformSetting c JOIN PlatformSetting v
              ON v.key = ? || json_extract(CASE WHEN json_valid(c.value_json) THEN c.value_json ELSE '{}' END, '$.preset.version')
              WHERE c.key = ? AND json_valid(c.value_json) AND json_valid(v.value_json)
                AND json_extract(c.value_json, '$.revision') = json_extract(v.value_json, '$.revision')
                AND json(json_extract(c.value_json, '$.preset')) = json(json_extract(v.value_json, '$.preset'))''',
              (RECIPE_PREFIX, RECIPE_CURRENT)).fetchone()[0]
            require(current_matches == 1, 'recipe_current_immutable_pointer_mismatch')

        receipt_count, receipt_bytes = connection.execute('SELECT count(*), coalesce(sum(length(CAST(value_json AS BLOB))), 0) '
            'FROM PlatformSetting WHERE substr(key, 1, ?) = ?', (len(OUTPUT_PREFIX), OUTPUT_PREFIX)).fetchone()
        require(receipt_count <= MAXIMUM_PRIVATE_RECORDS and receipt_bytes <= 128 * 1024 * 1024, 'output_receipt_metadata_budget_exceeded')
        receipts = connection.execute('''WITH settings AS (
          SELECT key, json_valid(value_json) AS valid, CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END AS safe
          FROM PlatformSetting WHERE substr(key, 1, ?) = ?)
          SELECT key, valid, json_extract(safe, '$.schema') AS schema, json_type(safe, '$.schema') AS schema_type,
            json_extract(safe, '$.state') AS state,
            json_extract(safe, '$.ownerId') AS owner_id, json_extract(safe, '$.workId') AS work_id,
            json_extract(safe, '$.readyRevision') AS revision, json_type(safe, '$.readyRevision') AS revision_type,
            json_extract(safe, '$.mutationId') AS mutation_id,
            json_extract(safe, '$.outputs') AS outputs_json
          FROM settings ORDER BY key LIMIT ?''', (len(OUTPUT_PREFIX), OUTPUT_PREFIX, MAXIMUM_PRIVATE_RECORDS + 1)).fetchall()
        require(len(receipts) <= MAXIMUM_PRIVATE_RECORDS, 'output_receipt_inventory_budget_exceeded')
        require(sum(len(row['outputs_json'].encode('utf-8')) for row in receipts if isinstance(row['outputs_json'], str))
                <= 128 * 1024 * 1024, 'output_receipt_metadata_budget_exceeded')
        registrations = []
        if receipts:
            required_columns(connection, 'Asset', {'id', 'owner_id', 'type', 'status', 'hash', 'file_size', 'width', 'height',
                                                  'mime_type', 'original_url', 'thumbnail_url', 'metadata_json'})
        for row in receipts:
            check_time()
            require(row['valid'] == 1 and row['schema'] == 1 and row['schema_type'] == 'integer' and row['state'] == 'registered'
                    and all(isinstance(row[key], str) and PRIVATE_IDENTIFIER.fullmatch(row[key])
                            for key in ('owner_id', 'work_id', 'mutation_id')) and row['revision_type'] == 'integer' and integer(row['revision'])
                    and row['key'] == OUTPUT_PREFIX + row['work_id'] + ':' + str(row['revision']), 'output_receipt_identity_invalid')
            require(isinstance(row['outputs_json'], str) and len(row['outputs_json'].encode('utf-8')) <= 100000,
                    'output_receipt_files_invalid')
            outputs = json.loads(row['outputs_json'])
            require(isinstance(outputs, list) and 0 < len(outputs) <= 9, 'output_receipt_files_invalid')
            result, roles = [], set()
            for output in outputs:
                require(isinstance(output, dict) and output.get('state') in ('registered', 'unavailable')
                        and isinstance(output.get('role'), str) and (output['role'] == 'collage'
                            or output['role'].startswith('frame-') and SLOT_ID.fullmatch(output['role'][6:]))
                        and output['role'] not in roles, 'output_receipt_role_invalid')
                roles.add(output['role'])
                item = {'state': output['state'], 'role': output['role']}
                if output['state'] == 'unavailable':
                    result.append(item)
                    continue
                require(isinstance(output.get('assetId'), str) and PRIVATE_IDENTIFIER.fullmatch(output['assetId'])
                        and isinstance(output.get('sha256'), str) and SHA256.fullmatch(output['sha256'])
                        and integer(output.get('bytes')) and output['bytes'] <= MAXIMUM_REVISION_BYTES
                        and integer(output.get('width')) and integer(output.get('height'))
                        and output['width'] * output['height'] <= 64000000 and output.get('mime') == 'image/png'
                        and isinstance(output.get('thumbnailSha256'), str) and SHA256.fullmatch(output['thumbnailSha256'])
                        and integer(output.get('thumbnailBytes')) and output['thumbnailBytes'] < MAXIMUM_GUIDE_BYTES,
                        'output_receipt_media_invalid')
                asset = connection.execute('''SELECT id, owner_id, type, status, hash, file_size, width, height, mime_type,
                  original_url, thumbnail_url, json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                  '$.multiviewOutput.schema') AS output_schema FROM Asset WHERE id = ?''', (output['assetId'],)).fetchone()
                item['assetId'] = output['assetId']
                require(asset is None or asset['status'] in ('active', 'hidden', 'deleted'), 'output_asset_status_invalid')
                if asset is None or asset['status'] != 'active':
                    item.update({'state': 'unavailable', 'registrationState': 'registered',
                                 'reason': 'asset_missing' if asset is None else 'asset_' + asset['status']})
                    result.append(item)
                    continue
                original_parts, thumbnail_parts = local_upload_parts(output.get('originalUrl')), local_upload_parts(output.get('thumbnailUrl'))
                require(asset['owner_id'] == row['owner_id'] and asset['type'] == 'image' and asset['mime_type'] == 'image/png'
                        and asset['hash'] == output['sha256'] and asset['file_size'] == output['bytes']
                        and asset['width'] == output['width'] and asset['height'] == output['height'] and asset['output_schema'] == 1
                        and local_upload_parts(asset['original_url']) == original_parts
                        and local_upload_parts(asset['thumbnail_url']) == thumbnail_parts, 'output_asset_snapshot_binding_invalid')
                extension = Path(thumbnail_parts[-1]).suffix.lower()
                require(extension in ('.png', '.jpg', '.jpeg', '.webp'), 'output_thumbnail_type_invalid')
                thumbnail_mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}[extension]
                item.update({key: output[key] for key in ('sha256', 'bytes', 'width', 'height', 'mime', 'thumbnailSha256', 'thumbnailBytes')})
                item.update({'originalPath': '/uploads/' + '/'.join(original_parts), 'thumbnailPath': '/uploads/' + '/'.join(thumbnail_parts),
                             'file': output['sha256'] + '.png', 'thumbnailFile': output['thumbnailSha256'] + extension,
                             'thumbnailMime': thumbnail_mime})
                result.append(item)
            registrations.append({'receiptKey': row['key'], 'schema': 1, 'state': 'registered', 'ownerId': row['owner_id'],
                                  'workId': row['work_id'], 'readyRevision': row['revision'], 'mutationId': row['mutation_id'], 'outputs': result})
        return recipes, registrations
    finally:
        connection.close()


def copy_verified(source_fd, target_fd, entry, parent_fd, private_source=False):
    available_space(parent_fd, entry['bytes'])
    descriptor, before = regular_file(source_fd, entry.get('sourceFile', entry['file']))
    target = None
    digest, count, prefix = hashlib.sha256(), 0, b''
    try:
        require(before.st_size == entry['bytes'], 'ready_file_length_mismatch')
        require(not private_source or stat.S_IMODE(before.st_mode) == 0o600, 'recipe_file_not_private_0600')
        target = os.open(entry['file'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_fd)
        os.fchmod(target, 0o600)
        with os.fdopen(target, 'wb', closefd=False) as output:
            while True:
                check_time()
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                if not prefix:
                    prefix = chunk[:12]
                count += len(chunk)
                require(count <= entry['bytes'], 'ready_file_grew_during_copy')
                digest.update(chunk)
                output.write(chunk)
                if count % (8 * 1024 * 1024) == 0:
                    available_space(parent_fd)
            output.flush()
            os.fsync(target)
        require(count == entry['bytes'] and digest.hexdigest() == entry['sha256'] and same_file(before, os.fstat(descriptor)), 'ready_file_content_mismatch')
        mime = entry.get('mime')
        require(mime is None or mime == 'image/png' and prefix.startswith(b'\x89PNG\r\n\x1a\n')
                or mime == 'image/jpeg' and prefix.startswith(b'\xff\xd8')
                or mime == 'image/webp' and prefix[:4] == b'RIFF' and prefix[8:12] == b'WEBP'
                or mime == 'application/zip' and prefix.startswith(b'PK\x03\x04'), 'ready_file_mime_mismatch')
    finally:
        os.close(descriptor)
        if target is not None:
            os.close(target)
    copied = digest_file(target_fd, entry['file'])
    require(copied['bytes'] == entry['bytes'] and copied['sha256'] == entry['sha256'], 'backup_copy_verification_failed')
    return copied


def verify_image(directory_fd, entry):
    """Parse complete PNG chunks and bounded IDAT data, not just an extension."""
    descriptor, before = regular_file(directory_fd, entry['file'])
    try:
        require(before.st_size == entry['bytes'], 'private_media_length_mismatch')
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            mime = entry['mime']
            if mime == 'image/png':
                require(source.read(8) == b'\x89PNG\r\n\x1a\n', 'private_png_signature_invalid')
                dimensions, decoder, expected, expanded = None, None, 0, 0
                saw_idat, saw_palette, ended = False, False, False
                while not ended:
                    check_time()
                    header = source.read(8)
                    require(len(header) == 8, 'private_png_truncated')
                    length, kind = struct.unpack('>I4s', header)
                    require(length <= before.st_size - source.tell() - 4 and re.fullmatch(b'[A-Za-z]{4}', kind), 'private_png_chunk_invalid')
                    require(kind in (b'IHDR', b'PLTE', b'IDAT', b'IEND') or kind[0] & 0x20, 'private_png_unknown_critical_chunk')
                    require(dimensions is not None or kind == b'IHDR', 'private_png_ihdr_missing')
                    crc, remaining, ihdr = zlib.crc32(kind), length, b''
                    while remaining:
                        chunk = source.read(min(remaining, 65536))
                        require(bool(chunk), 'private_png_truncated')
                        remaining -= len(chunk)
                        crc = zlib.crc32(chunk, crc)
                        if kind == b'IHDR':
                            ihdr += chunk
                        if kind == b'IDAT':
                            require(decoder is not None and (color != 3 or saw_palette), 'private_png_idat_invalid')
                            saw_idat = True
                            pending = chunk
                            while pending:
                                check_time()
                                decoded = decoder.decompress(pending, min(1024 * 1024, expected - expanded + 1))
                                expanded += len(decoded)
                                require(expanded <= expected and not decoder.unused_data, 'private_png_decoded_size_invalid')
                                following = decoder.unconsumed_tail
                                require(not following or len(following) < len(pending) or decoded, 'private_png_decoder_stalled')
                                pending = following
                    checksum = source.read(4)
                    require(len(checksum) == 4 and struct.unpack('>I', checksum)[0] == crc & 0xffffffff, 'private_png_crc_invalid')
                    if kind == b'IHDR':
                        require(dimensions is None and length == 13, 'private_png_ihdr_invalid')
                        width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', ihdr)
                        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
                        allowed_depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
                        require(width > 0 and height > 0 and width * height <= 64000000 and channels is not None
                                and depth in allowed_depths[color] and compression == 0 and filtering == 0 and interlace in (0, 1),
                                'private_png_dimensions_or_format_invalid')
                        require(entry.get('width', width) == width and entry.get('height', height) == height, 'private_png_dimensions_mismatch')
                        dimensions = (width, height)
                        passes = [(0, 0, 1, 1)] if interlace == 0 else [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8),
                            (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
                        for x, y, dx, dy in passes:
                            columns, rows = max(0, (width - x + dx - 1) // dx), max(0, (height - y + dy - 1) // dy)
                            if columns and rows:
                                expected += (((columns * channels * depth + 7) // 8) + 1) * rows
                        decoder = zlib.decompressobj()
                    elif kind == b'PLTE':
                        require(not saw_idat and 0 < length <= 768 and length % 3 == 0, 'private_png_palette_invalid')
                        saw_palette = True
                    elif kind == b'IEND':
                        require(length == 0 and saw_idat and decoder.eof and expanded == expected and source.read(1) == b'',
                                'private_png_payload_incomplete')
                        ended = True
            elif mime == 'image/webp':
                header = source.read(12)
                require(len(header) == 12 and header[:4] == b'RIFF' and header[8:] == b'WEBP'
                        and struct.unpack('<I', header[4:8])[0] + 8 == before.st_size, 'private_webp_container_invalid')
                require(source.read(4) in (b'VP8 ', b'VP8L', b'VP8X'), 'private_webp_payload_invalid')
            elif mime == 'image/jpeg':
                require(source.read(2) == b'\xff\xd8', 'private_jpeg_signature_invalid')
                source.seek(-2, os.SEEK_END)
                require(source.read(2) == b'\xff\xd9', 'private_jpeg_payload_incomplete')
            else:
                raise BackupError('private_media_mime_invalid')
        require(same_file(before, os.fstat(descriptor)), 'private_media_changed_during_parse')
    finally:
        os.close(descriptor)


def private_media_entries(recipes, registrations):
    entries = {}
    def add(namespace, entry, source_parts):
        key = namespace + '/' + entry['file']
        existing = entries.get(key)
        if existing:
            require(all(existing['entry'].get(field) == entry.get(field) for field in ('file', 'sha256', 'bytes', 'mime'))
                    and all(field not in existing['entry'] or field not in entry or existing['entry'][field] == entry[field]
                            for field in ('width', 'height')), 'private_media_duplicate_binding_conflict')
            existing['entry'].update(entry)
            if source_parts not in existing['sourcePaths']:
                existing['sourcePaths'].append(source_parts)
        else:
            entries[key] = {'entry': entry, 'sourceParts': source_parts, 'sourcePaths': [source_parts], 'namespace': namespace}
    for recipe in recipes:
        add('recipes', {key: recipe[key] for key in ('file', 'sha256', 'bytes', 'width', 'height', 'mime')}, [recipe['file']])
    for registration in registrations:
        for output in registration['outputs']:
            if output['state'] != 'registered':
                continue
            add('outputs', {key: output[key] for key in ('file', 'sha256', 'bytes', 'width', 'height', 'mime')}, local_upload_parts(output['originalPath']))
            add('outputs', {'file': output['thumbnailFile'], 'sha256': output['thumbnailSha256'],
                           'bytes': output['thumbnailBytes'], 'mime': output['thumbnailMime']}, local_upload_parts(output['thumbnailPath']))
    return entries


def relative_directory(root_fd, components):
    descriptor = os.dup(root_fd)
    device = os.fstat(root_fd).st_dev
    try:
        for component in components:
            following = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
            require(os.fstat(descriptor).st_dev == device, 'private_media_nested_mount_forbidden')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def copy_private_media(entries, source_roots, staging_fd, parent_fd):
    file_count, total_bytes = 0, 0
    for namespace in ('recipes', 'outputs', 'sources'):
        selected = [value for value in entries.values() if value['namespace'] == namespace]
        if not selected:
            continue
        root_fd = open_directory(source_roots[namespace])
        target_fd = child_directory(staging_fd, namespace)
        try:
            require(namespace != 'recipes' or stat.S_IMODE(os.fstat(root_fd).st_mode) == 0o700, 'recipe_root_not_private_0700')
            require(os.fstat(root_fd).st_dev == os.fstat(parent_fd).st_dev, 'private_media_root_device_mismatch')
            for value in selected:
                source_fd = relative_directory(root_fd, value['sourceParts'][:-1])
                try:
                    # Copy under a content name, not an arbitrary source basename.
                    entry = value['entry']
                    copy_verified(source_fd, target_fd, {**entry, 'sourceFile': value['sourceParts'][-1]}, parent_fd, namespace == 'recipes')
                    if namespace != 'sources':
                        verify_image(target_fd, entry)
                    # Content is stored once, but every active receipt alias must actually exist.
                    for alternative in value['sourcePaths'][1:]:
                        alternative_fd = relative_directory(root_fd, alternative[:-1])
                        try:
                            require(digest_file(alternative_fd, alternative[-1]) == {key: entry[key] for key in ('bytes', 'sha256')},
                                    'private_media_alias_content_mismatch')
                        finally:
                            os.close(alternative_fd)
                    file_count += 1
                    total_bytes += entry['bytes']
                finally:
                    os.close(source_fd)
            os.fsync(target_fd)
        finally:
            os.close(target_fd)
            os.close(root_fd)
    return file_count, total_bytes


def read_source_manifest(directory_fd, expected):
    descriptor, before = regular_file(directory_fd, 'manifest.json')
    try:
        require(0 < before.st_size <= 100000, 'source_manifest_size_invalid')
        chunks, count = [], 0
        while True:
            chunk = os.read(descriptor, 16384)
            if not chunk:
                break
            count += len(chunk)
            require(count <= 100000, 'source_manifest_size_invalid')
            chunks.append(chunk)
        data = b''.join(chunks)
        require(same_file(before, os.fstat(descriptor)) and len(data) == before.st_size
                and json.loads(data) == expected, 'source_manifest_differs_from_snapshot')
        return data
    finally:
        os.close(descriptor)


def atomic_publisher():
    require(sys.platform.startswith('linux'), 'linux_renameat2_runtime_required')
    library = ctypes.CDLL(None, use_errno=True)
    function = getattr(library, 'renameat2', None)
    require(function is not None, 'atomic_noreplace_rename_runtime_unavailable')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int

    def publish(parent_fd, staging_name, destination_name):
        if function(parent_fd, os.fsencode(staging_name), parent_fd, os.fsencode(destination_name), 1) != 0:
            code = ctypes.get_errno()
            if code == errno.EEXIST:
                raise BackupError('destination_already_exists_not_overwritten')
            raise BackupError('atomic_backup_publish_failed_errno_' + str(code))
    return publish


def read_private_json(directory_fd, name, maximum_bytes):
    descriptor, before = regular_file(directory_fd, name)
    try:
        require(stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= maximum_bytes, 'backup_json_not_private_or_bounded')
        chunks, count = [], 0
        while True:
            check_time()
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            count += len(chunk)
            require(count <= maximum_bytes, 'backup_json_size_exceeded')
            chunks.append(chunk)
        require(count == before.st_size and same_file(before, os.fstat(descriptor)), 'backup_json_changed_during_read')
        return json.loads(b''.join(chunks))
    finally:
        os.close(descriptor)


def verify_backup(directory):
    """Read-only recovery proof in an isolated copy. Never restore a live DB."""
    require(directory != PRODUCTION_BASE and PRODUCTION_BASE not in directory.parents, 'recovery_verification_requires_isolated_copy')
    root_fd = open_isolated_directory(directory)
    try:
        require(stat.S_IMODE(os.fstat(root_fd).st_mode) == 0o700, 'backup_directory_not_private')
        record = read_private_json(root_fd, 'mapping.json', 256 * 1024 * 1024)
        require(isinstance(record, dict) and record.get('format') in ('sd2.multiview-works-backup.v1', 'sd2.multiview-works-backup.v2', 'sd2.multiview-works-backup.v3')
                and isinstance(record.get('database'), dict) and record['database'].get('file') == 'database.sqlite3', 'backup_mapping_format_invalid')
        require(digest_file(root_fd, 'database.sqlite3') == {key: record['database'].get(key) for key in ('bytes', 'sha256')},
                'backup_database_hash_mismatch')
        connection = readonly_database(directory / 'database.sqlite3', immutable=True)
        try:
            require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'backup_database_integrity_failed')
        finally:
            connection.close()
        total_works, works = load_ready_works(directory / 'database.sqlite3')
        recipes, registrations = load_private_inventory(directory / 'database.sqlite3')
        sources = load_source_inventory(directory / 'database.sqlite3')
        require(record.get('sources', []) == sources, 'backup_source_inventory_differs_from_snapshot')
        require(record.get('recipes', []) == recipes and record.get('outputRegistrations', []) == registrations,
                'backup_private_inventory_differs_from_snapshot')
        stored_works = record.get('works')
        require(isinstance(stored_works, list) and len(stored_works) == len(works)
                and record.get('totalWorksInSnapshot') == total_works and record.get('readyWorks') == len(works), 'backup_works_inventory_mismatch')
        file_count, total_bytes = 0, 0
        for work, stored in zip(works, stored_works):
            components = ['works', work['ownerId'], work['workId'], str(work['readyRevision'])]
            require(isinstance(stored, dict) and all(stored.get(key) == value for key, value in work.items() if key != 'manifest')
                    and stored.get('directory') == '/'.join(components), 'backup_work_pointer_mismatch')
            target_fd = relative_directory(root_fd, components)
            try:
                read_source_manifest(target_fd, work['manifest'])
                require(stored.get('manifestFile') == {'file': 'manifest.json', **digest_file(target_fd, 'manifest.json')}, 'backup_manifest_hash_mismatch')
                files = []
                for entry in work['manifest']['files']:
                    result = digest_file(target_fd, entry['file'])
                    require(result == {key: entry[key] for key in ('bytes', 'sha256')}, 'backup_work_media_hash_mismatch')
                    files.append({'role': entry['role'], 'file': entry['file'], 'mime': entry['mime'], **result})
                    file_count += 1
                    total_bytes += result['bytes']
                require(stored.get('files') == files, 'backup_work_media_mapping_mismatch')
            finally:
                os.close(target_fd)
        entries = private_media_entries(recipes, registrations)
        for source in sources:
            entries['sources/' + source['file']] = {'entry': source, 'namespace': 'sources'}
        require(sum(item['entry']['bytes'] for item in entries.values()) + total_bytes <= MAXIMUM_MEDIA_BYTES, 'backup_media_budget_exceeded')
        for value in entries.values():
            target_fd = relative_directory(root_fd, [value['namespace']])
            try:
                entry = value['entry']
                require(digest_file(target_fd, entry['file']) == {key: entry[key] for key in ('bytes', 'sha256')}, 'backup_private_media_hash_mismatch')
                if value['namespace'] != 'sources':
                    verify_image(target_fd, entry)
                file_count += 1
                total_bytes += entry['bytes']
            finally:
                os.close(target_fd)
        require(record.get('mediaFiles') == file_count and record.get('mediaBytes') == total_bytes, 'backup_media_totals_mismatch')
        return {'verified': True, 'directory': str(directory), 'readyWorks': len(works), 'recipeVersions': len(recipes),
                'outputReceipts': len(registrations), 'mediaFiles': file_count, 'mediaBytes': total_bytes}
    finally:
        os.close(root_fd)


def main():
    global deadline
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database')
    parser.add_argument('--source-root')
    parser.add_argument('--destination')
    parser.add_argument('--recipe-root', default=str(PRODUCTION_RECIPES))
    parser.add_argument('--private-source-root', default=str(PRODUCTION_SOURCES))
    parser.add_argument('--uploads-root', default=str(PRODUCTION_UPLOADS))
    parser.add_argument('--verify-backup', help='Read-only verification of an isolated backup copy; requires --non-production.')
    parser.add_argument('--non-production', action='store_true', help='Explicit isolated paths; still requires Linux atomic publication.')
    arguments = parser.parse_args()
    deadline = time.monotonic() + TOTAL_TIMEOUT_SECONDS
    os.umask(0o077)
    staging = None
    open_descriptors = []
    try:
        if arguments.verify_backup:
            require(arguments.non_production and not any((arguments.database, arguments.source_root, arguments.destination)),
                    'recovery_verification_requires_only_isolated_backup')
            print(json.dumps(verify_backup(absolute_path(arguments.verify_backup)), separators=(',', ':')))
            return 0
        require(all((arguments.database, arguments.source_root, arguments.destination)), 'database_source_and_destination_required')
        database, source_root, destination = map(absolute_path, (arguments.database, arguments.source_root, arguments.destination))
        recipe_root, uploads_root = map(absolute_path, (arguments.recipe_root, arguments.uploads_root))
        private_source_root = absolute_path(arguments.private_source_root)
        require(BACKUP_NAME.fullmatch(destination.name), 'backup_destination_name_invalid')
        require(database != destination and source_root != destination and source_root not in destination.parents
                and destination not in source_root.parents and destination not in database.parents, 'backup_path_overlap_forbidden')
        require(all(root != destination and root not in destination.parents and destination not in root.parents
                    and root != database and root not in database.parents for root in (recipe_root, uploads_root, private_source_root)), 'private_media_backup_path_overlap_forbidden')
        publish = atomic_publisher()
        data_device = None
        if not arguments.non_production:
            data_fd = open_directory(Path('/data'))
            open_descriptors.append(data_fd)
            require(os.fstat(data_fd).st_dev != os.stat('/').st_dev, 'real_data_mount_required')
            data_device = os.fstat(data_fd).st_dev
            require(source_root == PRODUCTION_WORKS and destination.parent == PRODUCTION_BACKUPS
                    and recipe_root == PRODUCTION_RECIPES and uploads_root == PRODUCTION_UPLOADS and private_source_root == PRODUCTION_SOURCES
                    and PRODUCTION_BASE / 'var-lib' in database.parents, 'production_backup_paths_invalid')
        parent_fd = open_directory(destination.parent)
        open_descriptors.append(parent_fd)
        require(stat.S_IMODE(os.fstat(parent_fd).st_mode) == 0o700, 'backup_parent_must_be_private_0700')
        try:
            os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise BackupError('destination_already_exists_not_overwritten')
        source_root_fd = open_directory(source_root)
        open_descriptors.append(source_root_fd)
        if data_device is not None:
            database_parent_fd = open_directory(database.parent)
            try:
                database_info = os.stat(database.name, dir_fd=database_parent_fd, follow_symlinks=False)
                require(database_info.st_dev == data_device and os.fstat(parent_fd).st_dev == data_device
                        and os.fstat(source_root_fd).st_dev == data_device, 'backup_paths_must_use_actual_data_mount')
            finally:
                os.close(database_parent_fd)
        available_space(parent_fd)
        staging_name = '.' + destination.name + '.partial-' + uuid.uuid4().hex
        os.mkdir(staging_name, mode=0o700, dir_fd=parent_fd)
        staging = destination.parent / staging_name
        staging_fd = os.open(staging_name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        open_descriptors.append(staging_fd)
        database_info = create_snapshot(database, staging, staging_fd, parent_fd)
        total_works, works = load_ready_works(staging / 'database.sqlite3')
        recipes, registrations = load_private_inventory(staging / 'database.sqlite3')
        private_entries = private_media_entries(recipes, registrations)
        sources = load_source_inventory(staging / 'database.sqlite3')
        for source in sources:
            private_entries['sources/' + source['file']] = {'entry': source, 'namespace': 'sources',
                                                          'sourceParts': [source['file']], 'sourcePaths': [[source['file']]]}
        if arguments.non_production:
            require(not sources or private_source_root != PRODUCTION_BASE and PRODUCTION_BASE not in private_source_root.parents,
                    'fixture_source_root_must_be_isolated')
            require(not any(value['namespace'] == 'recipes' for value in private_entries.values())
                    or recipe_root != PRODUCTION_BASE and PRODUCTION_BASE not in recipe_root.parents,
                    'fixture_recipe_root_must_be_isolated')
            require(not any(value['namespace'] == 'outputs' for value in private_entries.values())
                    or uploads_root != PRODUCTION_BASE and PRODUCTION_BASE not in uploads_root.parents,
                    'fixture_uploads_root_must_be_isolated')
        expected_media_bytes = sum(entry['bytes'] for work in works for entry in work['manifest']['files']) + sum(value['entry']['bytes'] for value in private_entries.values())
        require(expected_media_bytes <= MAXIMUM_MEDIA_BYTES, 'backup_media_budget_exceeded')
        available_space(parent_fd, expected_media_bytes + len(works) * 200000 + len(json_bytes([recipes, registrations])) + 1024 * 1024)
        files_fd = child_directory(staging_fd, 'works')
        open_descriptors.append(files_fd)
        mapping, file_count, total_bytes = [], 0, 0
        for work in works:
            source_fd = os.dup(source_root_fd)
            target_fd = os.dup(files_fd)
            try:
                for component in (work['ownerId'], work['workId'], str(work['readyRevision'])):
                    following_source = os.open(component, DIRECTORY_FLAGS, dir_fd=source_fd)
                    following_target = child_directory(target_fd, component)
                    os.close(source_fd)
                    os.close(target_fd)
                    source_fd, target_fd = following_source, following_target
                source_manifest = read_source_manifest(source_fd, work['manifest'])
                files = []
                for entry in work['manifest']['files']:
                    result = copy_verified(source_fd, target_fd, entry, parent_fd)
                    files.append({'role': entry['role'], 'file': entry['file'], 'mime': entry['mime'], **result})
                    file_count += 1
                    total_bytes += result['bytes']
                write_private(target_fd, 'manifest.json', source_manifest)
                manifest_info = digest_file(target_fd, 'manifest.json')
                os.fsync(target_fd)
                mapping.append({key: value for key, value in work.items() if key != 'manifest'} | {
                    'directory': '/'.join(('works', work['ownerId'], work['workId'], str(work['readyRevision']))),
                    'manifestFile': {'file': 'manifest.json', **manifest_info}, 'files': files})
            finally:
                os.close(source_fd)
                os.close(target_fd)
        private_count, private_bytes = copy_private_media(private_entries, {'recipes': recipe_root, 'outputs': uploads_root, 'sources': private_source_root}, staging_fd, parent_fd)
        file_count += private_count
        total_bytes += private_bytes
        record = {'format': 'sd2.multiview-works-backup.v3', 'preparedAt': datetime.now(timezone.utc).isoformat(),
                  'database': {'file': 'database.sqlite3', 'integrity': 'ok', **database_info},
                  'totalWorksInSnapshot': total_works, 'readyWorks': len(works), 'mediaFiles': file_count,
                  'mediaBytes': total_bytes, 'works': mapping, 'recipes': recipes, 'outputRegistrations': registrations, 'sources': sources}
        write_private(staging_fd, 'mapping.json', json_bytes(record))
        os.fsync(files_fd)
        os.fsync(staging_fd)
        available_space(parent_fd)
        publish(parent_fd, staging_name, destination.name)
        os.fsync(parent_fd)
        print(json.dumps({'complete': True, 'directory': str(destination), 'databaseSha256': database_info['sha256'],
                          'readyWorks': len(works), 'mediaFiles': file_count, 'mediaBytes': total_bytes}, separators=(',', ':')))
        return 0
    except (BackupError, OSError, sqlite3.Error, ValueError, TypeError, KeyError, struct.error, zlib.error) as error:
        # Partial directories are retained, never promoted or mistaken for a complete backup.
        code = str(error) if isinstance(error, BackupError) else type(error).__name__
        print(json.dumps({'complete': False, 'error': code, 'partialDirectory': str(staging) if staging else None}, separators=(',', ':')), file=sys.stderr)
        return 1
    finally:
        for descriptor in reversed(open_descriptors):
            os.close(descriptor)


if __name__ == '__main__':
    sys.exit(main())
