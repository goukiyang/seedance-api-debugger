#!/usr/bin/env python3
"""Isolated backup/recovery fixtures. Run only during the lead's unified Verify.

Requires Linux renameat2, matching the production backup publisher. Linux reads only
MULTIVIEW_PRIVATE_FIXTURE_ROOT to locate a precreated private data-disk scratch root.
Linux ignores inherited TMPDIR. No network, provider, real account, production path, or live database is used.
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path


SCRIPT = Path(__file__).with_name('backup-multiview-works.py')
SPEC = importlib.util.spec_from_file_location('multiview_backup_fixture_target', SCRIPT)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def png(red, width=2, height=2):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    pixels = b''.join(b'\x00' + bytes((red, 0, 0, 255)) * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def write(path, data, mode=0o600):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def temporary_fixture_directory():
    prepared = os.environ.get('MULTIVIEW_PRIVATE_FIXTURE_ROOT')
    parent_fd = None
    if prepared is not None:
        parent = backup.absolute_path(prepared)
        if sys.platform == 'linux':
            engineering = Path('/data/video-api-debugger-engineering')
            backup.require(engineering in parent.parents and len(parent.relative_to(engineering).parts) == 2
                           and all(backup.BACKUP_NAME.fullmatch(part) for part in parent.relative_to(engineering).parts),
                           'fixture_root_must_use_dedicated_engineering_path')
        parent_fd = backup.open_isolated_directory(parent)
    else:
        backup.require(sys.platform != 'linux', 'MULTIVIEW_PRIVATE_FIXTURE_ROOT_required_on_linux')
        # Keep the existing local synthetic route, but reject a production TMPDIR
        # before tempfile can create anything there. Linux never selects this route.
        parent = Path(tempfile.gettempdir()).resolve(strict=True)
        backup.require(parent != backup.PRODUCTION_BASE and backup.PRODUCTION_BASE not in parent.parents,
                       'fixture_temporary_parent_must_be_isolated')
        parent_fd = backup.open_directory(parent)
    temporary = None
    try:
        before = os.fstat(parent_fd)
        temporary = tempfile.TemporaryDirectory(prefix='sd2-private-backup-fixture-', dir=str(parent))
        named = os.stat(parent, follow_symlinks=False)
        backup.require(before.st_dev == named.st_dev and before.st_ino == named.st_ino
                       and parent.resolve(strict=True) == parent, 'fixture_parent_identity_changed')
        child_fd = backup.open_isolated_directory(Path(temporary.name))
        os.close(child_fd)
        return temporary
    except BaseException:
        if temporary is not None:
            temporary.cleanup()
        raise
    finally:
        os.close(parent_fd)


class Fixture:
    def __init__(self):
        self.temporary = temporary_fixture_directory()
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.database = self.root / 'source.sqlite3'
        self.works, self.recipes, self.uploads = (self.root / name for name in ('works', 'recipes', 'uploads'))
        self.backups = self.root / 'backups'
        for path in (self.works, self.recipes, self.uploads, self.backups):
            path.mkdir(mode=0o700)
        connection = sqlite3.connect(self.database)
        connection.executescript('''
          CREATE TABLE PlatformSetting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
          CREATE TABLE Asset (id TEXT PRIMARY KEY, owner_id TEXT, hash TEXT, file_size INTEGER, mime_type TEXT,
            width INTEGER, height INTEGER, type TEXT, status TEXT, original_url TEXT, thumbnail_url TEXT, metadata_json TEXT);
          CREATE TABLE ReferenceImage (id TEXT PRIMARY KEY, owner_user_id TEXT, asset_id TEXT);
          CREATE TABLE MultiviewWork (id TEXT PRIMARY KEY, owner_id TEXT, source_version TEXT, draft_revision INTEGER,
            ready_revision INTEGER, ready_recipe_json TEXT, ready_manifest_json TEXT, removed_at TEXT);
          CREATE TABLE MultiviewWorkMutation (id TEXT, actor_id TEXT, mutation_id TEXT, work_id TEXT, request_hash TEXT, receipt_json TEXT);
        ''')
        self.guide_files = []
        for revision in (1, 2):
            content = png(10 + revision)
            sha = digest(content)
            filename = self.recipes / (sha + '.png')
            write(filename, content)
            self.guide_files.append(filename)
            asset_id, ref_id = 'guide_asset_' + str(revision), 'guide_ref_' + str(revision)
            self.asset(connection, asset_id, content, '/uploads/assets/guide.png', None, owner='guide_owner', output=False)
            connection.execute('INSERT INTO ReferenceImage VALUES (?, ?, ?)', (ref_id, 'guide_owner', asset_id))
            state = {'revision': revision, 'preset': {'id': 'multiview-360', 'version': '1.0.' + str(revision),
                'prompt': 'PRIVATE_FIXTURE_TEXT_NEVER_IN_MAPPING', 'defaults': {}, 'compositionReference': {
                    'assetId': asset_id, 'referenceImageId': ref_id, 'ownerId': 'guide_owner', 'sha256': sha}}}
            self.setting(connection, backup.RECIPE_PREFIX + state['preset']['version'], state)
            if revision == 2:
                self.setting(connection, backup.RECIPE_CURRENT, state)
        self.setting(connection, backup.RECIPE_PREFIX + '1.0.0', {'revision': 0, 'preset': {'version': '1.0.0'}})
        self.output_paths = []
        for revision in (1, 2):
            content, thumbnail = png(50 + revision), png(70 + revision, 1, 1)
            if revision == 1:
                original = '/uploads/assets/legacy-saved-output.png'
                thumb = '/uploads/thumbs/legacy-saved-output.png'
                receipt_original = 'https://sd2.youdoodesign.com' + original
            else:
                original = '/uploads/multiview-outputs/' + digest(b'owner') + '/' + digest(content) + '.png'
                thumb = '/uploads/multiview-outputs/' + digest(b'owner') + '/' + digest(thumbnail) + '.png'
                receipt_original = original
            original_path = self.uploads.joinpath(*backup.local_upload_parts(original))
            thumbnail_path = self.uploads.joinpath(*backup.local_upload_parts(thumb))
            write(original_path, content, 0o644)
            write(thumbnail_path, thumbnail, 0o644)
            self.output_paths.append(original_path)
            self.asset(connection, 'output_' + str(revision), content, original, thumb)
            outputs = [{'state': 'registered', 'role': 'collage' if revision == 1 else 'frame-s1',
                'assetId': 'output_' + str(revision), 'sha256': digest(content), 'bytes': len(content), 'width': 2, 'height': 2,
                'mime': 'image/png', 'originalUrl': receipt_original, 'thumbnailUrl': thumb,
                'thumbnailSha256': digest(thumbnail), 'thumbnailBytes': len(thumbnail)}]
            if revision == 2:
                self.asset(connection, 'deleted_output', content, '/uploads/assets/deleted.png', '/uploads/thumbs/deleted.png', status='deleted')
                outputs.append({**outputs[0], 'role': 'frame-s2', 'assetId': 'deleted_output',
                                'originalUrl': '/uploads/assets/deleted.png', 'thumbnailUrl': '/uploads/thumbs/deleted.png'})
                outputs.append({'state': 'unavailable', 'role': 'frame-s3'})
            self.setting(connection, backup.OUTPUT_PREFIX + 'work_fixture:' + str(revision), {
                'schema': 1, 'state': 'registered', 'ownerId': 'owner', 'workId': 'work_fixture', 'readyRevision': revision,
                'mutationId': 'saved_' + str(revision), 'outputs': outputs})
        self.ready_work(connection)
        connection.commit()
        connection.close()
        self.database.chmod(0o600)

    @staticmethod
    def setting(connection, key, value):
        connection.execute('INSERT OR REPLACE INTO PlatformSetting VALUES (?, ?)', (key, json.dumps(value)))

    @staticmethod
    def asset(connection, asset_id, content, original, thumbnail, owner='owner', output=True, status='active'):
        connection.execute('INSERT INTO Asset VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (asset_id, owner, digest(content), len(content), 'image/png', 2, 2, 'image', status, original, thumbnail,
             json.dumps({'multiviewOutput': {'schema': 1}}) if output else '{}'))

    def ready_work(self, connection):
        version = digest(b'fixture-source-video')
        recipe = json.dumps({'schema': 1, 'sourceVersion': version, 'slots': [{'id': 's1'}, {'id': 's2'}, {'id': 's3'}]})
        directory = self.works / 'owner' / 'work_fixture' / '3'
        files = []
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w') as archive:
            archive.writestr('frames.json', '{"synthetic":true}')
        for role in ('collage', 'frame-s1', 'frame-s2', 'frame-s3', 'thumbnail', 'zip'):
            content = zip_buffer.getvalue() if role == 'zip' else png(99)
            filename = role + ('.zip' if role == 'zip' else '.png')
            write(directory / filename, content)
            files.append({'role': role, 'file': filename, 'bytes': len(content), 'sha256': digest(content),
                'mime': 'application/zip' if role == 'zip' else 'image/png', **({} if role == 'zip' else {'width': 2, 'height': 2})})
        manifest = {'schema': 1, 'revision': 3, 'sourceVersion': version, 'recipeHash': digest(recipe.encode()),
                    'frameCount': 3, 'width': 2, 'height': 2, 'files': files}
        write(directory / 'manifest.json', json.dumps(manifest).encode())
        connection.execute('INSERT INTO MultiviewWork VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                           ('work_fixture', 'owner', version, 3, 3, recipe, json.dumps(manifest), None))

    def invoke(self, name='snapshot', private_roots=True):
        arguments = ['backup-multiview-works.py', '--database', str(self.database), '--source-root', str(self.works),
                     '--destination', str(self.backups / name), '--non-production']
        if private_roots:
            arguments += ['--recipe-root', str(self.recipes), '--uploads-root', str(self.uploads)]
        previous = sys.argv
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            sys.argv = arguments
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = backup.main()
            return result, json.loads((stdout if result == 0 else stderr).getvalue())
        finally:
            sys.argv = previous

    def edit_database(self, sql, values=()):
        with sqlite3.connect(self.database) as connection:
            connection.execute(sql, values)

    def close(self):
        self.temporary.cleanup()


class PrivateBackupEngineering(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()

    def tearDown(self):
        self.fixture.close()

    def test_history_outputs_and_recipe_versions_survive_current_ready_revision(self):
        status, result = self.fixture.invoke()
        self.assertEqual(status, 0, result)
        directory = Path(result['directory'])
        record = json.loads((directory / 'mapping.json').read_text())
        self.assertEqual(len(record['recipes']), 2)
        self.assertEqual([item['readyRevision'] for item in record['outputRegistrations']], [1, 2])
        self.assertEqual(record['works'][0]['readyRevision'], 3)
        self.assertNotIn('PRIVATE_FIXTURE_TEXT', (directory / 'mapping.json').read_text())
        self.assertEqual(record['outputRegistrations'][1]['outputs'][1]['reason'], 'asset_deleted')
        self.assertTrue(backup.verify_backup(directory)['verified'])
        self.assertFalse((self.fixture.uploads / 'assets/deleted.png').exists())
        # Recovery depends on the archived DB and files, not the mutable source directories.
        self.fixture.edit_database('DELETE FROM PlatformSetting')
        self.fixture.guide_files[0].unlink()
        self.fixture.output_paths[0].unlink()
        self.assertTrue(backup.verify_backup(directory)['verified'])
        self.assertEqual(self.fixture.invoke(name='snapshot')[0], 1)  # Never overwrite a published backup.

    def test_legacy_cli_does_not_require_unused_private_roots(self):
        self.fixture.edit_database('DELETE FROM PlatformSetting')
        status, result = self.fixture.invoke(private_roots=False)
        self.assertEqual(status, 0, result)
        self.assertTrue(backup.verify_backup(Path(result['directory']))['verified'])

    def test_current_pointer_must_match_immutable_version(self):
        self.fixture.edit_database('UPDATE PlatformSetting SET value_json = json_set(value_json, ?, ?) WHERE key = ?',
            ('$.preset.prompt', 'changed-only-current', backup.RECIPE_CURRENT))
        self.assertEqual(self.fixture.invoke()[1]['error'], 'recipe_current_immutable_pointer_mismatch')

    def test_active_asset_owner_mismatch_blocks_complete_backup(self):
        self.fixture.edit_database('UPDATE Asset SET owner_id = ? WHERE id = ?', ('other', 'output_1'))
        status, result = self.fixture.invoke()
        self.assertEqual(status, 1)
        self.assertEqual(result['error'], 'output_asset_snapshot_binding_invalid')
        self.assertFalse((self.fixture.backups / 'snapshot').exists())

    def test_remote_receipt_url_is_not_downloaded(self):
        self.fixture.edit_database('UPDATE PlatformSetting SET value_json = json_set(value_json, ?, ?) WHERE key = ?',
            ('$.outputs[0].originalUrl', 'https://remote.invalid/uploads/assets/legacy-saved-output.png', backup.OUTPUT_PREFIX + 'work_fixture:1'))
        self.assertEqual(self.fixture.invoke()[1]['error'], 'output_upload_origin_not_local')

    def test_symlink_guide_is_not_followed(self):
        original = self.fixture.guide_files[0]
        moved = original.with_suffix('.source')
        original.rename(moved)
        original.symlink_to(moved.name)
        self.assertEqual(self.fixture.invoke()[0], 1)

    def test_nonprivate_guide_is_rejected(self):
        self.fixture.guide_files[0].chmod(0o644)
        self.assertEqual(self.fixture.invoke()[1]['error'], 'recipe_file_not_private_0600')

    def test_missing_registered_active_output_is_not_silently_skipped(self):
        self.fixture.output_paths[0].unlink()
        self.assertEqual(self.fixture.invoke()[0], 1)

    def test_recovery_detects_changed_archived_media(self):
        status, result = self.fixture.invoke()
        self.assertEqual(status, 0, result)
        directory = Path(result['directory'])
        output = next((directory / 'outputs').glob('*.png'))
        output.write_bytes(png(201))
        with self.assertRaises(backup.BackupError):
            backup.verify_backup(directory)

    def test_traversal_and_credential_urls_are_rejected(self):
        for url in ('/uploads/../private.png', '/uploads/%2e%2e/private.png', '/uploads/assets%2fprivate.png',
                    'https://user:secret@sd2.youdooart.com/uploads/assets/file.png'):
            with self.subTest(url=url), self.assertRaises(backup.BackupError):
                backup.local_upload_parts(url)


if __name__ == '__main__':
    try:
        backup.atomic_publisher()
    except backup.BackupError as error:
        print(json.dumps({'verified': False, 'runtimeUnsupported': str(error)}), file=sys.stderr)
        sys.exit(2)
    unittest.main()
