#!/usr/bin/env python3
"""Focused synthetic schema3/foreground backup proof; no production data or providers."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import struct
import sys
import unittest
import zlib
from pathlib import Path

spec = importlib.util.spec_from_file_location('legacy_backup_fixture', Path(__file__).with_name('backup-multiview-private-engineering.py'))
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
backup = legacy.backup


def transparent_png(red):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    pixels = (b'\x00' + bytes((red, 0, 0, 0, red, 0, 0, 255))) * 2
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


class ReferenceFixture(legacy.Fixture):
    def __init__(self):
        super().__init__()
        self.foregrounds = self.root / 'foregrounds'
        self.foregrounds.mkdir(mode=0o700)
        self.foreground_files = []
        version, task = legacy.digest(b'reference-source'), 'reference_task'
        self.recipe = {'schema': 3, 'kind': 'reference-collage', 'sourceVersion': version,
            'slots': [{'id': 'shot-' + str(i), 'frame': i, 'name': '', 'manual': False, 'locked': False} for i in range(2)],
            'reserve': [], 'restoreOrder': [], 'layout': {'columns': 2, 'margin': 0, 'gap': 0, 'background': '#cccccc'},
            'output': {'width': 128, 'height': 64, 'background': '#cccccc'},
            'panels': [{'slotId': 'shot-' + str(i), 'x': i / 2, 'y': 0, 'width': .5, 'height': 1} for i in range(2)],
            'placements': [{'slotId': 'shot-' + str(i), 'x': i / 2, 'y': 0, 'width': .5, 'height': 1, 'z': i} for i in range(2)],
            'divider': {'enabled': False, 'color': '#666666', 'widthPx': 2}, 'foregrounds': []}
        with sqlite3.connect(self.database) as connection:
            connection.execute('ALTER TABLE MultiviewWork ADD COLUMN source_task_id TEXT')
            connection.execute('ALTER TABLE MultiviewWork ADD COLUMN source_info_json TEXT')
            for i in range(3):  # Third ready result is still only in a draft/reusable receipt.
                content = transparent_png(120 + i)
                sha = legacy.digest(content)
                receipt = legacy.digest(json.dumps(['owner', task, version, i], separators=(',', ':')).encode())
                item = {'schema': 1, 'receiptId': receipt, 'ownerId': 'owner', 'taskId': task,
                    'sourceVersion': version, 'frame': i, 'stage': 'ready', 'phaseAt': 1,
                    'asset': {'asset_id': 'source_asset_' + str(i), 'width': 2, 'height': 2, 'size': 999},
                    'job': {'job_id': 'cutout_job_' + str(i), 'kind': 'cutout', 'status': 'succeeded'}, 'sha256': sha,
                    'message': 'PRIVATE_CUTOUT_MESSAGE_MUST_NOT_ENTER_MAPPING'}
                self.setting(connection, backup.FOREGROUND_PREFIX + receipt, item)
                file = self.foregrounds / legacy.digest(b'owner') / (sha + '.png')
                legacy.write(file, content)
                self.foreground_files.append(file)
                if i < 2:
                    self.recipe['foregrounds'].append({'slotId': 'shot-' + str(i), 'jobId': item['job']['job_id'],
                        'sourceAssetId': item['asset']['asset_id'], 'sha256': sha})
            self.setting(connection, backup.FOREGROUND_PREFIX + 'not-ready-fixture', {'schema': 1, 'stage': 'accepted'})
            recipe = json.dumps(self.recipe, separators=(',', ':'))
            directory = self.works / 'owner/reference_work/1'
            original = json.loads(connection.execute('SELECT ready_manifest_json FROM MultiviewWork').fetchone()[0])
            files = []
            for role in ('thumbnail', 'collage', 'zip', 'frame-shot-0', 'frame-shot-1'):
                if role == 'zip':
                    content = (self.works / 'owner/work_fixture/3/zip.zip').read_bytes()
                else:
                    content = legacy.png(90, 128, 64) if role == 'collage' else legacy.png(90)
                name = role + ('.zip' if role == 'zip' else '.png')
                legacy.write(directory / name, content)
                files.append({'role': role, 'file': name, 'bytes': len(content), 'sha256': legacy.digest(content),
                    'mime': 'application/zip' if role == 'zip' else 'image/png',
                    **({} if role == 'zip' else {'width': 128 if role == 'collage' else 2, 'height': 64 if role == 'collage' else 2})})
            manifest = {**original, 'revision': 1, 'sourceVersion': version, 'recipeHash': legacy.digest(recipe.encode()),
                        'frameCount': 2, 'width': 128, 'height': 64, 'files': files}
            legacy.write(directory / 'manifest.json', json.dumps(manifest).encode())
            info = {'taskId': task, 'sourceVersion': version, 'width': 2, 'height': 2, 'duration': 1, 'timestamps': [0, .5, 1]}
            connection.execute('INSERT INTO MultiviewWork VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                ('reference_work', 'owner', version, 1, 1, recipe, json.dumps(manifest), None, task, json.dumps(info)))

    def invoke(self, name='snapshot', private_roots=True):
        arguments = ['backup-multiview-works.py', '--database', str(self.database), '--source-root', str(self.works),
            '--destination', str(self.backups / name), '--recipe-root', str(self.recipes), '--uploads-root', str(self.uploads),
            '--foreground-root', str(self.foregrounds), '--non-production']
        previous, stdout, stderr = sys.argv, io.StringIO(), io.StringIO()
        try:
            sys.argv = arguments
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = backup.main()
            return result, json.loads((stdout if result == 0 else stderr).getvalue())
        finally:
            sys.argv = previous


class ReferenceBackupEngineering(unittest.TestCase):
    def setUp(self):
        self.fixture = ReferenceFixture()

    def tearDown(self):
        self.fixture.close()

    def test_roundtrip_including_unattached_ready_foreground(self):
        status, result = self.fixture.invoke()
        self.assertEqual(status, 0, result)
        directory = Path(result['directory'])
        record = json.loads((directory / 'mapping.json').read_text())
        self.assertEqual(record['format'], 'sd2.multiview-works-backup.v4')
        self.assertEqual(len(record['foregrounds']), 3)
        self.assertEqual(record['readyWorks'], 2)
        self.assertNotIn('PRIVATE_CUTOUT_MESSAGE', (directory / 'mapping.json').read_text())
        self.assertNotIn('PRIVATE_FIXTURE_TEXT', (directory / 'mapping.json').read_text())
        shutil.rmtree(self.fixture.foregrounds)
        self.fixture.database.unlink()
        self.assertEqual(backup.verify_backup(directory)['foregroundReceipts'], 3)
        for file in (directory / 'foregrounds').iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_missing_foreground_rejected(self):
        self.fixture.foreground_files[0].unlink()
        self.assertEqual(self.fixture.invoke()[0], 1)

    def test_changed_foreground_rejected(self):
        self.fixture.foreground_files[0].write_bytes(transparent_png(3))
        status, result = self.fixture.invoke()
        self.assertEqual(status, 1)
        self.assertEqual(result['error'], 'foreground_file_content_mismatch')

    def test_wrong_work_job_binding_rejected(self):
        self.fixture.recipe['foregrounds'][0]['jobId'] = 'other_job'
        self.fixture.edit_database('UPDATE MultiviewWork SET ready_recipe_json = ? WHERE id = ?',
            (json.dumps(self.fixture.recipe), 'reference_work'))
        # Rebind the manifest hash so the independent source/job check is the rejecting gate.
        with sqlite3.connect(self.fixture.database) as connection:
            raw, manifest = connection.execute('SELECT ready_recipe_json, ready_manifest_json FROM MultiviewWork WHERE id = ?', ('reference_work',)).fetchone()
            manifest = json.loads(manifest)
            manifest['recipeHash'] = legacy.digest(raw.encode())
            connection.execute('UPDATE MultiviewWork SET ready_manifest_json = ? WHERE id = ?', (json.dumps(manifest), 'reference_work'))
        status, result = self.fixture.invoke()
        self.assertEqual(status, 1)
        self.assertEqual(result['error'], 'reference_foreground_receipt_mismatch')

    def test_symlink_and_public_file_rejected(self):
        file = self.fixture.foreground_files[0]
        content = file.read_bytes()
        file.unlink()
        target = self.fixture.root / 'link-target.png'
        legacy.write(target, content)
        file.symlink_to(target)
        self.assertEqual(self.fixture.invoke('symlink')[0], 1)
        file.unlink()
        legacy.write(file, content, 0o644)
        status, result = self.fixture.invoke('public')
        self.assertEqual(status, 1)
        self.assertEqual(result['error'], 'foreground_file_not_private_or_bounded')

    def test_archived_foreground_corruption_rejected(self):
        status, result = self.fixture.invoke()
        self.assertEqual(status, 0, result)
        directory = Path(result['directory'])
        file = next((directory / 'foregrounds').iterdir())
        file.write_bytes(transparent_png(3))
        with self.assertRaisesRegex(backup.BackupError, 'backup_private_media_hash_mismatch'):
            backup.verify_backup(directory)


class LegacyCompatibilityEngineering(unittest.TestCase):
    def test_legacy_only_snapshot_needs_no_foreground_directory_and_v3_still_verifies(self):
        fixture = legacy.Fixture()
        try:
            # Original schema1 and schema2 retain their original 3/4/8 slots.
            for schema in (1, 2):
                with sqlite3.connect(fixture.database) as connection:
                    recipe, manifest = connection.execute('SELECT ready_recipe_json, ready_manifest_json FROM MultiviewWork').fetchone()
                    parsed = json.loads(recipe)
                    parsed['schema'] = schema
                    recipe = json.dumps(parsed)
                    manifest = json.loads(manifest)
                    manifest['recipeHash'] = legacy.digest(recipe.encode())
                    connection.execute('UPDATE MultiviewWork SET ready_recipe_json = ?, ready_manifest_json = ?', (recipe, json.dumps(manifest)))
                    legacy.write(fixture.works / 'owner/work_fixture/3/manifest.json', json.dumps(manifest).encode())
                status, result = fixture.invoke('schema-' + str(schema))
                self.assertEqual(status, 0, result)
                directory = Path(result['directory'])
                mapping = json.loads((directory / 'mapping.json').read_text())
                mapping['format'] = 'sd2.multiview-works-backup.v3'
                del mapping['foregrounds']
                legacy.write(directory / 'mapping.json', json.dumps(mapping).encode())
                self.assertTrue(backup.verify_backup(directory)['verified'])
            parsed['slots'] = parsed['slots'][:2]
            fixture.edit_database('UPDATE MultiviewWork SET ready_recipe_json = ?', (json.dumps(parsed),))
            status, result = fixture.invoke('invalid-legacy-two-slots')
            self.assertEqual(status, 1)
            self.assertEqual(result['error'], 'ready_work_slots_invalid')
        finally:
            fixture.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
