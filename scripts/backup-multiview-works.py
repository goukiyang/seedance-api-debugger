#!/usr/bin/env python3
"""One-shot SQLite snapshot plus its referenced immutable multiview files.

Production: --database /data/video-api-debugger/var-lib/dev.db
  --source-root /data/video-api-debugger/var-lib/storage/multiview-works
  --destination /data/video-api-debugger/backups/multiview-works-<unique-name>
--non-production permits explicit isolated absolute paths. Linux renameat2 is required.
No generation, live-table writes, history cleanup, environment or credential reads.
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
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


PRODUCTION_BASE = Path('/data/video-api-debugger')
PRODUCTION_WORKS = PRODUCTION_BASE / 'var-lib/storage/multiview-works'
PRODUCTION_BACKUPS = PRODUCTION_BASE / 'backups'
MINIMUM_FREE = 5 * 1024 ** 3
MAXIMUM_REVISION_BYTES = 1536 * 1024 ** 2
MAXIMUM_MEDIA_BYTES = 64 * 1024 ** 3
MAXIMUM_READY_WORKS = 100000
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
    return before.st_dev == after.st_dev and before.st_ino == after.st_ino and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns and after.st_nlink == 1


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
        works = []
        for row in rows:
            check_time()
            require(isinstance(row['id'], str) and IDENTIFIER.fullmatch(row['id']) and isinstance(row['owner_id'], str)
                    and IDENTIFIER.fullmatch(row['owner_id']) and integer(row['ready_revision']), 'ready_work_identity_invalid')
            require(isinstance(row['ready_recipe_json'], str) and len(row['ready_recipe_json'].encode('utf-8')) <= 100000
                    and isinstance(row['ready_manifest_json'], str) and len(row['ready_manifest_json'].encode('utf-8')) <= 100000, 'ready_work_metadata_missing')
            recipe = json.loads(row['ready_recipe_json'])
            manifest = json.loads(row['ready_manifest_json'])
            require(isinstance(recipe, dict) and isinstance(manifest, dict) and recipe.get('schema') == 1 and manifest.get('schema') == 1, 'ready_work_schema_invalid')
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


def copy_verified(source_fd, target_fd, entry, parent_fd):
    available_space(parent_fd, entry['bytes'])
    descriptor, before = regular_file(source_fd, entry['file'])
    target = None
    digest, count, prefix = hashlib.sha256(), 0, b''
    try:
        require(before.st_size == entry['bytes'], 'ready_file_length_mismatch')
        target = os.open(entry['file'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_fd)
        os.fchmod(target, 0o600)
        with os.fdopen(target, 'wb', closefd=False) as output:
            while True:
                check_time()
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                if not prefix:
                    prefix = chunk[:8]
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
        require(mime is None or mime == 'image/png' and prefix == b'\x89PNG\r\n\x1a\n'
                or mime == 'image/jpeg' and prefix.startswith(b'\xff\xd8')
                or mime == 'application/zip' and prefix.startswith(b'PK\x03\x04'), 'ready_file_mime_mismatch')
    finally:
        os.close(descriptor)
        if target is not None:
            os.close(target)
    copied = digest_file(target_fd, entry['file'])
    require(copied['bytes'] == entry['bytes'] and copied['sha256'] == entry['sha256'], 'backup_copy_verification_failed')
    return copied


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


def main():
    global deadline
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--source-root', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--non-production', action='store_true', help='Explicit isolated paths; still requires Linux atomic publication.')
    arguments = parser.parse_args()
    deadline = time.monotonic() + TOTAL_TIMEOUT_SECONDS
    os.umask(0o077)
    staging = None
    open_descriptors = []
    try:
        database, source_root, destination = map(absolute_path, (arguments.database, arguments.source_root, arguments.destination))
        require(BACKUP_NAME.fullmatch(destination.name), 'backup_destination_name_invalid')
        require(database != destination and source_root != destination and source_root not in destination.parents
                and destination not in source_root.parents and destination not in database.parents, 'backup_path_overlap_forbidden')
        publish = atomic_publisher()
        data_device = None
        if not arguments.non_production:
            data_fd = open_directory(Path('/data'))
            open_descriptors.append(data_fd)
            require(os.fstat(data_fd).st_dev != os.stat('/').st_dev, 'real_data_mount_required')
            data_device = os.fstat(data_fd).st_dev
            require(source_root == PRODUCTION_WORKS and destination.parent == PRODUCTION_BACKUPS
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
        expected_media_bytes = sum(entry['bytes'] for work in works for entry in work['manifest']['files'])
        require(expected_media_bytes <= MAXIMUM_MEDIA_BYTES, 'backup_media_budget_exceeded')
        available_space(parent_fd, expected_media_bytes + len(works) * 200000 + 1024 * 1024)
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
        record = {'format': 'sd2.multiview-works-backup.v1', 'preparedAt': datetime.now(timezone.utc).isoformat(),
                  'database': {'file': 'database.sqlite3', 'integrity': 'ok', **database_info},
                  'totalWorksInSnapshot': total_works, 'readyWorks': len(works), 'mediaFiles': file_count,
                  'mediaBytes': total_bytes, 'works': mapping}
        write_private(staging_fd, 'mapping.json', json_bytes(record))
        os.fsync(files_fd)
        os.fsync(staging_fd)
        available_space(parent_fd)
        publish(parent_fd, staging_name, destination.name)
        os.fsync(parent_fd)
        print(json.dumps({'complete': True, 'directory': str(destination), 'databaseSha256': database_info['sha256'],
                          'readyWorks': len(works), 'mediaFiles': file_count, 'mediaBytes': total_bytes}, separators=(',', ':')))
        return 0
    except (BackupError, OSError, sqlite3.Error, ValueError, TypeError, KeyError) as error:
        # Partial directories are retained, never promoted or mistaken for a complete backup.
        code = str(error) if isinstance(error, BackupError) else type(error).__name__
        print(json.dumps({'complete': False, 'error': code, 'partialDirectory': str(staging) if staging else None}, separators=(',', ':')), file=sys.stderr)
        return 1
    finally:
        for descriptor in reversed(open_descriptors):
            os.close(descriptor)


if __name__ == '__main__':
    sys.exit(main())
