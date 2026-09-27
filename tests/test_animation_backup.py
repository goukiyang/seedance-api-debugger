import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "animation-backup.py"
BACKUP_SCRIPT = Path(__file__).resolve().parents[1] / "ops" / "server" / "sd2" / "sd2-backup.sh"
SPEC = importlib.util.spec_from_file_location("animation_backup", SCRIPT)
animation_backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(animation_backup)


PNG_KEY = "2f2e62dc-1345-4bea-a334-020465f65412"
PNG_DUPLICATE_KEY = "bf1305b3-f890-4721-afd4-650a03c71209"
TEXT_KEY = "7e12bb16-89f4-4e14-87f4-2d7b8cb9aacc"
PNG_BYTES = b"\x89PNG\r\n\x1a\nfixed-test-png"
TEXT_BYTES = b"fixed animation export bytes\n"


class AnimationBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.database = self.base / "source.sqlite3"
        self.snapshot = self.base / "snapshot.sqlite3"
        self.animation_root = self.base / "animation"
        self.animation_root.mkdir(mode=0o700)
        self.archive = self.base / "backup.tar.gz"
        self._create_database(with_animation=True)

    def tearDown(self):
        self.temp.cleanup()

    def _create_database(self, with_animation):
        if self.database.exists():
            self.database.unlink()
        if self.snapshot.exists():
            self.snapshot.unlink()
        with sqlite3.connect(self.database) as connection:
            if not with_animation:
                connection.execute("CREATE TABLE LegacyRecord (id TEXT PRIMARY KEY)")
                connection.commit()
                return
            connection.execute(
                "CREATE TABLE AnimationFile (blob_key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE AnimationExport (blob_key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL)"
            )
            png_hash = hashlib.sha256(PNG_BYTES).hexdigest()
            text_hash = hashlib.sha256(TEXT_BYTES).hexdigest()
            connection.execute(
                "INSERT INTO AnimationFile VALUES (?, ?, ?)",
                (PNG_KEY, len(PNG_BYTES), png_hash),
            )
            connection.execute(
                "INSERT INTO AnimationFile VALUES (?, ?, ?)",
                (PNG_DUPLICATE_KEY, len(PNG_BYTES), png_hash),
            )
            connection.execute(
                "INSERT INTO AnimationExport VALUES (?, ?, ?)",
                (TEXT_KEY, len(TEXT_BYTES), text_hash),
            )
            connection.commit()
        (self.animation_root / PNG_KEY).write_bytes(PNG_BYTES)
        (self.animation_root / PNG_DUPLICATE_KEY).write_bytes(PNG_BYTES)
        (self.animation_root / TEXT_KEY).write_bytes(TEXT_BYTES)
        with sqlite3.connect(self.database) as source, sqlite3.connect(self.snapshot) as target:
            source.backup(target)

    def test_archive_binds_read_only_snapshot_and_deduplicates_content(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("DELETE FROM AnimationFile")
            connection.commit()

        result = animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

        self.assertEqual(result["status"], "created")
        self.assertEqual(result["records"], 3)
        self.assertEqual(result["unique_blobs"], 2)
        verified = animation_backup.verify_archive(self.archive)
        self.assertEqual(verified["records"], 3)
        self.assertEqual(verified["unique_blobs"], 2)

        restored = self.base / "isolated-restore"
        animation_backup.restore_archive(self.archive, restored)
        with sqlite3.connect(restored / "database.sqlite3") as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM AnimationFile").fetchone()[0], 2)
        self.assertEqual((restored / "animation" / PNG_KEY).read_bytes(), PNG_BYTES)
        self.assertEqual((restored / "animation" / PNG_DUPLICATE_KEY).read_bytes(), PNG_BYTES)
        self.assertEqual((restored / "animation" / TEXT_KEY).read_bytes(), TEXT_BYTES)

    def test_archive_uses_one_private_database_snapshot_if_input_changes_after_reference_query(self):
        original_read_refs = animation_backup._read_resource_refs
        changed_input = False
        queried_paths = []
        private_modes = []

        def read_refs_then_change_input(database_path):
            nonlocal changed_input
            private_path = Path(database_path).resolve()
            queried_paths.append(private_path)
            private_modes.append((private_path.parent.stat().st_mode & 0o777, private_path.stat().st_mode & 0o777))
            refs = original_read_refs(database_path)
            if not changed_input:
                changed_input = True
                with sqlite3.connect(self.snapshot) as connection:
                    connection.execute("DELETE FROM AnimationFile WHERE blob_key = ?", (PNG_KEY,))
            return refs

        with patch.object(animation_backup, "_read_resource_refs", side_effect=read_refs_then_change_input):
            result = animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

        self.assertEqual(result["status"], "created")
        self.assertTrue(changed_input)
        self.assertNotEqual(queried_paths[0], self.snapshot.resolve())
        self.assertEqual(private_modes[0], (0o700, 0o600))
        self.assertEqual(animation_backup.verify_archive(self.archive)["records"], 3)

        restored = self.base / "consistent-restore"
        animation_backup.restore_archive(self.archive, restored)
        with sqlite3.connect(restored / "database.sqlite3") as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM AnimationFile").fetchone()[0], 2)

    def test_verify_rejects_database_whose_references_disagree_with_manifest(self):
        animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)
        members = {}
        with tarfile.open(self.archive, "r:gz") as archive:
            for member in archive.getmembers():
                source = archive.extractfile(member)
                self.assertIsNotNone(source)
                members[member.name] = source.read()

        altered_database = self.base / "altered.sqlite3"
        with sqlite3.connect(self.snapshot) as source, sqlite3.connect(altered_database) as target:
            source.backup(target)
            target.execute("DELETE FROM AnimationFile WHERE blob_key = ?", (PNG_KEY,))
            target.commit()
        altered_bytes = altered_database.read_bytes()
        members["database.sqlite3"] = altered_bytes
        manifest = json.loads(members["manifest.json"])
        manifest["database"]["bytes"] = len(altered_bytes)
        manifest["database"]["sha256"] = hashlib.sha256(altered_bytes).hexdigest()
        members["manifest.json"] = json.dumps(
            manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")

        inconsistent = self.base / "inconsistent.tar.gz"
        with tarfile.open(inconsistent, "w:gz") as archive:
            for name, content in members.items():
                member = tarfile.TarInfo(name)
                member.size = len(content)
                member.mode = 0o600
                archive.addfile(member, io.BytesIO(content))

        with self.assertRaisesRegex(animation_backup.BackupError, "references do not match"):
            animation_backup.verify_archive(inconsistent)

    def test_backup_script_rejects_a_second_concurrent_instance(self):
        bin_directory = self.base / "bin"
        bin_directory.mkdir(mode=0o700)
        backup_root = self.base / "daily"
        source_database = self.base / "legacy.sqlite3"
        ready = self.base / "first-entered-sqlite-backup"
        release = self.base / "release-first-backup"
        with sqlite3.connect(source_database) as connection:
            connection.execute("CREATE TABLE LegacyRecord (id TEXT PRIMARY KEY)")

        stubs = {
            "flock": f"#!{sys.executable}\n"
            "import fcntl, sys\n"
            "try:\n"
            "    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "except (BlockingIOError, OSError):\n"
            "    raise SystemExit(1)\n",
            "sqlite3": """#!/bin/sh
set -eu
sql="$2"
case "$sql" in
  .backup\ *)
    target=$(printf '%s' "$sql" | sed -e "s/^\\.backup '//" -e "s/'$//")
    : > "$FAKE_BACKUP_READY"
    while [ ! -e "$FAKE_BACKUP_RELEASE" ]; do sleep 0.02; done
    cp "$FAKE_BACKUP_SOURCE" "$target"
    ;;
  *integrity_check*) printf 'ok\\n' ;;
  *) printf '0\\n' ;;
esac
""",
            "gzip": f"#!{sys.executable}\n"
            "import gzip, pathlib, sys\n"
            "sys.stdout.buffer.write(gzip.compress(pathlib.Path(sys.argv[-1]).read_bytes()))\n",
            "sha256sum": f"#!{sys.executable}\n"
            "import hashlib, pathlib, sys\n"
            "if sys.argv[-1] == '-':\n"
            "    data = sys.stdin.buffer.read()\n"
            "    print(hashlib.sha256(data).hexdigest(), '-')\n"
            "else:\n"
            "    path = pathlib.Path(sys.argv[-1])\n"
            "    print(hashlib.sha256(path.read_bytes()).hexdigest(), path)\n",
        }
        for name, content in stubs.items():
            executable = bin_directory / name
            executable.write_text(content)
            executable.chmod(0o700)

        environment = {
            **os.environ,
            "PATH": str(bin_directory) + os.pathsep + os.environ.get("PATH", ""),
            "DB_PATH": str(source_database),
            "BACKUP_ROOT": str(backup_root),
            "APP_DIR": str(self.base / "app"),
            "RETENTION_DAYS": "30",
            "FAKE_BACKUP_SOURCE": str(source_database),
            "FAKE_BACKUP_READY": str(ready),
            "FAKE_BACKUP_RELEASE": str(release),
        }
        first = subprocess.Popen(
            ["bash", str(BACKUP_SCRIPT)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and first.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "first backup did not reach the SQLite snapshot step")

            second = subprocess.run(
                ["bash", str(BACKUP_SCRIPT)], env=environment, capture_output=True, text=True, timeout=5
            )
            self.assertNotEqual(second.returncode, 0)
            self.assertIn("another backup is already running", second.stderr)
        finally:
            release.touch()
            try:
                stdout, stderr = first.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                first.terminate()
                stdout, stderr = first.communicate(timeout=5)
                self.fail("first backup did not exit after releasing the test gate")

        self.assertEqual(first.returncode, 0, stderr or stdout)
        self.assertIn("[sd2-backup] ok", stdout)

    def test_missing_referenced_file_fails_without_publishing_archive(self):
        (self.animation_root / TEXT_KEY).unlink()

        with self.assertRaisesRegex(animation_backup.BackupError, "missing"):
            animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

        self.assertFalse(self.archive.exists())

    def test_archive_output_is_never_overwritten(self):
        self.archive.write_bytes(b"keep existing backup")

        with self.assertRaisesRegex(animation_backup.BackupError, "already exists"):
            animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

        self.assertEqual(self.archive.read_bytes(), b"keep existing backup")

    def test_tampered_referenced_file_fails_hash_check(self):
        (self.animation_root / PNG_KEY).write_bytes(PNG_BYTES[:-1] + b"X")

        with self.assertRaises(animation_backup.BackupError):
            animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

        self.assertFalse(self.archive.exists())

    def test_traversal_blob_key_is_rejected(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("UPDATE AnimationFile SET blob_key = ? WHERE blob_key = ?", ("../outside", PNG_KEY))
            connection.commit()
        with sqlite3.connect(self.database) as source, sqlite3.connect(self.snapshot) as target:
            source.backup(target)

        with self.assertRaisesRegex(animation_backup.BackupError, "unsafe blob key"):
            animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

    def test_symlinked_animation_file_is_rejected(self):
        external_file = self.base / "outside.bin"
        external_file.write_bytes(TEXT_BYTES)
        (self.animation_root / TEXT_KEY).unlink()
        os.symlink(external_file, self.animation_root / TEXT_KEY)

        with self.assertRaises(animation_backup.BackupError):
            animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

    def test_archive_path_traversal_is_rejected_without_writing_restore_target(self):
        malicious = self.base / "malicious.tar.gz"
        with tarfile.open(malicious, "w:gz") as archive:
            member = tarfile.TarInfo("../outside.txt")
            member.size = len(TEXT_BYTES)
            archive.addfile(member, io.BytesIO(TEXT_BYTES))

        destination = self.base / "traversal-restore"
        escaped_path = self.base / "outside.txt"
        with self.assertRaisesRegex(animation_backup.BackupError, "unsafe path|unexpected path"):
            animation_backup.restore_archive(malicious, destination)

        self.assertFalse(destination.exists())
        self.assertFalse(escaped_path.exists())

    def test_archive_symlink_member_is_rejected(self):
        malicious = self.base / "symlink.tar.gz"
        with tarfile.open(malicious, "w:gz") as archive:
            member = tarfile.TarInfo("animation/blobs/" + "0" * 64)
            member.type = tarfile.SYMTYPE
            member.linkname = "../../outside.txt"
            archive.addfile(member)

        with self.assertRaisesRegex(animation_backup.BackupError, "link or non-regular"):
            animation_backup.verify_archive(malicious)

    def test_restore_rejects_existing_destination_without_modifying_it(self):
        animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)
        destination = self.base / "already-exists"
        destination.mkdir()
        marker = destination / "keep.txt"
        marker.write_text("keep")

        with self.assertRaisesRegex(animation_backup.BackupError, "must not already exist"):
            animation_backup.restore_archive(self.archive, destination)

        self.assertEqual(marker.read_text(), "keep")

    def test_unmigrated_database_is_explicitly_skipped(self):
        self._create_database(with_animation=False)
        with sqlite3.connect(self.database) as source, sqlite3.connect(self.snapshot) as target:
            source.backup(target)

        result = animation_backup.create_archive(self.snapshot, self.animation_root, self.archive)

        self.assertEqual(result, {"status": "skipped", "reason": "legacy_schema", "records": 0})
        self.assertFalse(self.archive.exists())


if __name__ == "__main__":
    unittest.main()
