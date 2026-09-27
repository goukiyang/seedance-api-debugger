#!/usr/bin/env python3
"""Create and safely inspect isolated SD2 animation backups."""

import argparse
import ctypes
import errno
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
from pathlib import Path


FORMAT = "sd2-animation-backup-v1"
CHUNK_SIZE = 1024 * 1024
MAX_RESOURCE_REFS = 100_000
MAX_ARCHIVE_ENTRIES = MAX_RESOURCE_REFS + 2
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 32 * 1024 * 1024 * 1024
MAX_ARCHIVE_BYTES = MAX_EXPANDED_BYTES + 256 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BLOB_KEY_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
RESOURCE_TABLES = ("AnimationFile", "AnimationExport")


class BackupError(Exception):
    pass


class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size=-1):
        chunk = self.stream.read(size)
        self.digest.update(chunk)
        self.size += len(chunk)
        return chunk


def _regular_file(path, nofollow=True):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if nofollow:
        flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError as exc:
        raise BackupError("required backup input is missing") from exc
    except OSError as exc:
        raise BackupError("backup input is not a regular readable file") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise BackupError("backup input is not a regular file")
        return fd, info
    except Exception:
        os.close(fd)
        raise


def _snapshot_path(path):
    candidate = Path(path)
    try:
        info = os.lstat(candidate)
    except OSError as exc:
        raise BackupError("read-only database snapshot is missing") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise BackupError("database snapshot must be a regular non-symlink file")
    resolved = candidate.resolve(strict=True)
    return resolved


def _sqlite_uri(path):
    return Path(path).as_uri() + "?mode=ro"


def _validate_blob_key(blob_key):
    if not isinstance(blob_key, str) or not BLOB_KEY_RE.fullmatch(blob_key):
        raise BackupError("animation metadata contains an unsafe blob key")
    return blob_key


def _validate_size_and_hash(size, digest):
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise BackupError("animation metadata contains an invalid file size")
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        raise BackupError("animation metadata contains an invalid SHA-256")


def _read_resource_refs(snapshot_path):
    connection = None
    try:
        connection = sqlite3.connect(_sqlite_uri(snapshot_path), uri=True, timeout=5)
        connection.execute("PRAGMA query_only = ON")
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)",
                RESOURCE_TABLES,
            )
        }
        if not tables:
            return None
        if tables != set(RESOURCE_TABLES):
            raise BackupError("animation schema is only partially present")

        refs = []
        for table in RESOURCE_TABLES:
            for blob_key, size, digest in connection.execute(
                "SELECT blob_key, bytes, sha256 FROM " + table
            ):
                _validate_blob_key(blob_key)
                _validate_size_and_hash(size, digest)
                refs.append({
                    "table": table,
                    "blob_key": blob_key,
                    "bytes": size,
                    "sha256": digest,
                })
                if len(refs) > MAX_RESOURCE_REFS:
                    raise BackupError("animation metadata count exceeds the configured limit")
        refs.sort(key=lambda ref: (ref["table"], ref["blob_key"], ref["sha256"], ref["bytes"]))
        return refs
    except BackupError:
        raise
    except sqlite3.Error as exc:
        raise BackupError("read-only database snapshot could not be queried") from exc
    finally:
        if connection is not None:
            connection.close()


def _read_only_connection(path):
    try:
        connection = sqlite3.connect(_sqlite_uri(path), uri=True, timeout=5)
        connection.execute("PRAGMA query_only = ON")
        return connection
    except sqlite3.Error as exc:
        raise BackupError("database snapshot could not be opened read-only") from exc


def _create_consistent_snapshot(source_path, destination):
    source = _read_only_connection(source_path)
    target = None
    try:
        page_size_row = source.execute("PRAGMA page_size").fetchone()
        if not page_size_row or not isinstance(page_size_row[0], int) or page_size_row[0] <= 0:
            raise BackupError("database snapshot has an invalid SQLite page size")
        page_size = page_size_row[0]

        def check_progress(_status, _remaining, total_pages):
            if total_pages * page_size > MAX_EXPANDED_BYTES:
                raise BackupError("database snapshot exceeds the configured size limit")

        target = sqlite3.connect(os.fspath(destination), timeout=5)
        source.backup(target, pages=256, progress=check_progress, sleep=0.01)
        target.commit()
    except BackupError:
        raise
    except sqlite3.Error as exc:
        raise BackupError("consistent private database snapshot could not be created") from exc
    finally:
        if target is not None:
            target.close()
        source.close()

    os.chmod(destination, 0o600)
    info = os.lstat(destination)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > MAX_EXPANDED_BYTES:
        raise BackupError("private database snapshot is invalid or exceeds the configured size limit")


def _hash_stream(stream, limit=None):
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        size += len(chunk)
        if limit is not None and size > limit:
            raise BackupError("file exceeds the configured size limit")
        digest.update(chunk)
    return size, digest.hexdigest()


def _hash_path(path, expected_size=None):
    fd, info = _regular_file(path)
    try:
        if expected_size is not None and info.st_size != expected_size:
            raise BackupError("file size does not match its metadata")
        if info.st_size > MAX_EXPANDED_BYTES:
            raise BackupError("file exceeds the configured size limit")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            size, digest = _hash_stream(stream, MAX_EXPANDED_BYTES)
        if size != info.st_size:
            raise BackupError("file changed while it was being read")
        return size, digest
    finally:
        os.close(fd)


def _root_directory(path):
    try:
        root = Path(path).resolve(strict=True)
        info = root.stat()
    except OSError as exc:
        raise BackupError("animation storage root is unavailable") from exc
    if not stat.S_ISDIR(info.st_mode):
        raise BackupError("animation storage root is not a directory")
    flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        fd = os.open(root, flags)
    except OSError as exc:
        raise BackupError("animation storage root cannot be opened") from exc
    opened = os.fstat(fd)
    if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
        os.close(fd)
        raise BackupError("animation storage root changed while opening")
    return root, fd


def _open_blob(root_fd, blob_key, expected_size):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(blob_key, flags, dir_fd=root_fd)
    except FileNotFoundError as exc:
        raise BackupError("referenced animation resource is missing") from exc
    except OSError as exc:
        raise BackupError("referenced animation resource is not a regular file") from exc
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size:
        os.close(fd)
        raise BackupError("animation resource size does not match its metadata")
    return fd, info


def _tar_info(name, size):
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = 0o600
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    return info


def _add_stream(tar, name, stream, expected_size, expected_digest):
    reader = HashingReader(stream)
    tar.addfile(_tar_info(name, expected_size), reader)
    if reader.size != expected_size or reader.digest.hexdigest() != expected_digest:
        raise BackupError("file hash or size does not match its metadata")


def _output_path(path):
    candidate = Path(path)
    if not candidate.name or candidate.name in (".", ".."):
        raise BackupError("archive output path is invalid")
    try:
        parent = candidate.parent.resolve(strict=True)
    except OSError as exc:
        raise BackupError("archive output directory does not exist") from exc
    if not parent.is_dir():
        raise BackupError("archive output parent is not a directory")
    output = parent / candidate.name
    if os.path.lexists(output):
        raise BackupError("archive output already exists")
    return output, parent


def create_archive(snapshot, animation_root, output):
    snapshot_path = _snapshot_path(snapshot)
    output_path, output_parent = _output_path(output)
    work_directory = Path(tempfile.mkdtemp(prefix=".animation-backup-", dir=output_parent))
    root_fd = None
    try:
        os.chmod(work_directory, 0o700)
        private_snapshot = work_directory / "database.sqlite3"
        _create_consistent_snapshot(snapshot_path, private_snapshot)
        refs = _read_resource_refs(private_snapshot)
        if refs is None:
            return {"status": "skipped", "reason": "legacy_schema", "records": 0}
        if not refs:
            return {"status": "skipped", "reason": "empty", "records": 0}

        records_by_key = {}
        content_sizes = {}
        for ref in refs:
            current = records_by_key.get(ref["blob_key"])
            expected = (ref["bytes"], ref["sha256"])
            if current is not None and current != expected:
                raise BackupError("one blob key has conflicting metadata")
            records_by_key[ref["blob_key"]] = expected
            previous_size = content_sizes.get(ref["sha256"])
            if previous_size is not None and previous_size != ref["bytes"]:
                raise BackupError("identical SHA-256 metadata has conflicting sizes")
            content_sizes[ref["sha256"]] = ref["bytes"]

        _root, root_fd = _root_directory(animation_root)
        db_size, db_digest = _hash_path(private_snapshot)
        if db_size > MAX_EXPANDED_BYTES:
            raise BackupError("database snapshot exceeds the configured size limit")
        fd, temp_name = tempfile.mkstemp(prefix="." + output_path.name + ".", suffix=".tmp", dir=output_parent)
        temp_path = Path(temp_name)
        try:
            os.fchmod(fd, 0o600)
            archive_stream = os.fdopen(fd, "wb")
            fd = None
            with archive_stream:
                with gzip.GzipFile(fileobj=archive_stream, mode="wb", compresslevel=6, mtime=0) as compressed_stream:
                    with tarfile.open(fileobj=compressed_stream, mode="w|") as tar:
                        db_fd, db_info = _regular_file(private_snapshot)
                        try:
                            if db_info.st_size != db_size:
                                raise BackupError("database snapshot changed while backing up")
                            with os.fdopen(db_fd, "rb", closefd=False) as stream:
                                _add_stream(tar, "database.sqlite3", stream, db_size, db_digest)
                        finally:
                            os.close(db_fd)

                        added_paths = set()
                        expanded_size = db_size
                        for blob_key in sorted(records_by_key):
                            expected_size, expected_digest = records_by_key[blob_key]
                            archive_member = "animation/blobs/" + expected_digest
                            blob_fd, blob_info = _open_blob(root_fd, blob_key, expected_size)
                            try:
                                with os.fdopen(blob_fd, "rb", closefd=False) as stream:
                                    if archive_member not in added_paths:
                                        if expanded_size + expected_size > MAX_EXPANDED_BYTES:
                                            raise BackupError("backup exceeds the expanded size limit")
                                        _add_stream(tar, archive_member, stream, expected_size, expected_digest)
                                        added_paths.add(archive_member)
                                        expanded_size += expected_size
                                    else:
                                        actual_size, actual_digest = _hash_stream(stream, expected_size)
                                        if actual_size != expected_size or actual_digest != expected_digest:
                                            raise BackupError("animation resource hash or size does not match its metadata")
                                if os.fstat(blob_fd).st_size != blob_info.st_size:
                                    raise BackupError("animation resource changed while backing up")
                            finally:
                                os.close(blob_fd)

                        manifest = {
                            "format": FORMAT,
                            "database": {
                                "path": "database.sqlite3",
                                "bytes": db_size,
                                "sha256": db_digest,
                            },
                            "resources": [
                                dict(ref, archive_path="animation/blobs/" + ref["sha256"])
                                for ref in refs
                            ],
                        }
                        manifest_bytes = json.dumps(
                            manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True
                        ).encode("utf-8")
                        if len(manifest_bytes) > MAX_MANIFEST_BYTES:
                            raise BackupError("backup manifest exceeds the configured size limit")
                        if expanded_size + len(manifest_bytes) > MAX_EXPANDED_BYTES:
                            raise BackupError("backup exceeds the expanded size limit")
                        tar.addfile(_tar_info("manifest.json", len(manifest_bytes)), io.BytesIO(manifest_bytes))
                archive_stream.flush()
                os.fsync(archive_stream.fileno())

            _verify_archive(temp_path, expected_snapshot=private_snapshot)
            try:
                os.link(temp_path, output_path, follow_symlinks=False)
            except FileExistsError as exc:
                raise BackupError("archive output already exists") from exc
            except OSError as exc:
                raise BackupError("verified archive could not be atomically published") from exc
            os.unlink(temp_path)
            temp_path = None
            dir_fd = os.open(output_parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        finally:
            if fd is not None:
                os.close(fd)
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass
    finally:
        if root_fd is not None:
            os.close(root_fd)
        shutil.rmtree(work_directory, ignore_errors=True)

    return {
        "status": "created",
        "records": len(refs),
        "unique_blobs": len(added_paths),
        "database_sha256": db_digest,
        "path": str(output_path),
    }


def _reject_duplicate_json_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BackupError("manifest contains duplicate fields")
        result[key] = value
    return result


def _safe_archive_member(name):
    if not isinstance(name, str) or "\\" in name or name.startswith("/"):
        raise BackupError("archive contains an unsafe path")
    if name in ("database.sqlite3", "manifest.json"):
        return name
    match = re.fullmatch(r"animation/blobs/([0-9a-f]{64})", name)
    if match:
        return name
    raise BackupError("archive contains an unexpected path")


def _archive_fd(path):
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise BackupError("archive file is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise BackupError("archive must be a regular non-symlink file")
    if info.st_size > MAX_ARCHIVE_BYTES:
        raise BackupError("archive exceeds the configured compressed size limit")
    fd, opened = _regular_file(path)
    if opened.st_ino != info.st_ino or opened.st_dev != info.st_dev:
        os.close(fd)
        raise BackupError("archive changed while opening")
    return fd


def _validate_manifest(manifest, member_hashes, member_sizes):
    if not isinstance(manifest, dict) or set(manifest) != {"format", "database", "resources"}:
        raise BackupError("archive manifest has an unsupported structure")
    if manifest["format"] != FORMAT:
        raise BackupError("archive manifest version is unsupported")
    database = manifest["database"]
    if not isinstance(database, dict) or set(database) != {"path", "bytes", "sha256"}:
        raise BackupError("archive database manifest is invalid")
    if database["path"] != "database.sqlite3":
        raise BackupError("archive database path is invalid")
    _validate_size_and_hash(database["bytes"], database["sha256"])
    resources = manifest["resources"]
    if not isinstance(resources, list) or not resources or len(resources) > MAX_RESOURCE_REFS:
        raise BackupError("archive resource manifest is invalid")

    expected_paths = {"database.sqlite3", "manifest.json"}
    seen_records = set()
    blob_metadata = {}
    for ref in resources:
        if not isinstance(ref, dict) or set(ref) != {"table", "blob_key", "bytes", "sha256", "archive_path"}:
            raise BackupError("archive resource manifest entry is invalid")
        if ref["table"] not in RESOURCE_TABLES:
            raise BackupError("archive resource table is invalid")
        _validate_blob_key(ref["blob_key"])
        _validate_size_and_hash(ref["bytes"], ref["sha256"])
        archive_path = "animation/blobs/" + ref["sha256"]
        if ref["archive_path"] != archive_path:
            raise BackupError("archive resource mapping is invalid")
        identity = (ref["table"], ref["blob_key"])
        if identity in seen_records:
            raise BackupError("archive manifest merges or repeats a logical record")
        seen_records.add(identity)
        prior = blob_metadata.get(ref["blob_key"])
        current = (ref["bytes"], ref["sha256"])
        if prior is not None and prior != current:
            raise BackupError("archive blob mapping is inconsistent")
        blob_metadata[ref["blob_key"]] = current
        expected_paths.add(archive_path)

    actual_paths = set(member_hashes)
    if actual_paths != expected_paths:
        raise BackupError("archive members do not match the manifest")
    if member_sizes.get("database.sqlite3") != database["bytes"]:
        raise BackupError("database snapshot size does not match the manifest")
    if member_hashes.get("database.sqlite3") != database["sha256"]:
        raise BackupError("database snapshot hash does not match the manifest")
    for ref in resources:
        if member_sizes.get(ref["archive_path"]) != ref["bytes"]:
            raise BackupError("animation resource size does not match the manifest")
        if member_hashes.get(ref["archive_path"]) != ref["sha256"]:
            raise BackupError("animation resource hash does not match the manifest")
    return blob_metadata


def _scan_archive(path, extract_dir=None, database_copy=None):
    fd = _archive_fd(path)
    member_hashes = {}
    member_sizes = {}
    manifest_bytes = None
    total_size = 0
    count = 0
    try:
        with os.fdopen(fd, "rb") as archive_stream:
            try:
                tar = tarfile.open(fileobj=archive_stream, mode="r|gz")
            except (tarfile.TarError, OSError, EOFError) as exc:
                raise BackupError("archive is not a valid gzip tar file") from exc
            with tar:
                while True:
                    try:
                        member = tar.next()
                    except (tarfile.TarError, OSError, EOFError) as exc:
                        raise BackupError("archive stream is damaged") from exc
                    if member is None:
                        break
                    count += 1
                    if count > MAX_ARCHIVE_ENTRIES:
                        raise BackupError("archive contains too many entries")
                    name = _safe_archive_member(member.name)
                    if name in member_hashes or name == "manifest.json" and manifest_bytes is not None:
                        raise BackupError("archive contains duplicate paths")
                    if not member.isreg() or member.size <= 0:
                        raise BackupError("archive contains a link or non-regular entry")
                    if name == "manifest.json" and member.size > MAX_MANIFEST_BYTES:
                        raise BackupError("archive manifest exceeds the configured size limit")
                    if total_size + member.size > MAX_EXPANDED_BYTES:
                        raise BackupError("archive exceeds the expanded size limit")
                    total_size += member.size
                    source = tar.extractfile(member)
                    if source is None:
                        raise BackupError("archive member could not be read")

                    destination = None
                    if extract_dir is not None:
                        if name == "database.sqlite3":
                            destination = Path(extract_dir) / "database.sqlite3"
                        elif name.startswith("animation/"):
                            destination = Path(extract_dir) / name
                        elif name == "manifest.json":
                            destination = None
                        if destination is not None:
                            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    elif database_copy is not None and name == "database.sqlite3":
                        destination = Path(database_copy)
                        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

                    digest = hashlib.sha256()
                    read_size = 0
                    chunks = [] if name == "manifest.json" else None
                    output = None
                    if destination is not None:
                        try:
                            output = open(destination, "xb")
                            os.chmod(destination, 0o600)
                        except OSError as exc:
                            raise BackupError("isolated restore staging write failed") from exc
                    try:
                        while True:
                            chunk = source.read(CHUNK_SIZE)
                            if not chunk:
                                break
                            read_size += len(chunk)
                            if read_size > member.size:
                                raise BackupError("archive member exceeds its declared size")
                            digest.update(chunk)
                            if chunks is not None:
                                chunks.append(chunk)
                            if output is not None:
                                output.write(chunk)
                        if read_size != member.size:
                            raise BackupError("archive member is truncated")
                        if output is not None:
                            output.flush()
                            os.fsync(output.fileno())
                    finally:
                        source.close()
                        if output is not None:
                            output.close()

                    member_hashes[name] = digest.hexdigest()
                    member_sizes[name] = read_size
                    if chunks is not None:
                        manifest_bytes = b"".join(chunks)

        if manifest_bytes is None:
            raise BackupError("archive manifest is missing")
        try:
            manifest = json.loads(manifest_bytes.decode("utf-8"), object_pairs_hook=_reject_duplicate_json_keys)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BackupError("archive manifest is not valid UTF-8 JSON") from exc
        blob_metadata = _validate_manifest(manifest, member_hashes, member_sizes)
        return manifest, manifest_bytes, blob_metadata, total_size, count
    except BackupError:
        raise
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise BackupError("archive could not be read safely") from exc


def verify_archive(path):
    return _verify_archive(path)


def _verify_archive(path, expected_snapshot=None):
    if expected_snapshot is None:
        with tempfile.TemporaryDirectory(prefix=".animation-verify-") as temporary:
            os.chmod(temporary, 0o700)
            database_copy = Path(temporary) / "database.sqlite3"
            manifest, _manifest_bytes, _blobs, expanded, entries = _scan_archive(path, database_copy=database_copy)
            refs = _read_resource_refs(database_copy)
    else:
        manifest, _manifest_bytes, _blobs, expanded, entries = _scan_archive(path)
        refs = _read_resource_refs(expected_snapshot)
        expected_size, expected_digest = _hash_path(expected_snapshot)
        database = manifest["database"]
        if database["bytes"] != expected_size or database["sha256"] != expected_digest:
            raise BackupError("archive database snapshot does not match the private snapshot")

    if refs is None or _canonical_refs(refs) != _canonical_refs(manifest["resources"]):
        raise BackupError("database snapshot references do not match the archive manifest")
    return {
        "status": "verified",
        "records": len(manifest["resources"]),
        "unique_blobs": len({ref["sha256"] for ref in manifest["resources"]}),
        "database_sha256": manifest["database"]["sha256"],
        "entries": entries,
        "expanded_bytes": expanded,
    }


def _canonical_refs(refs):
    return sorted((ref["table"], ref["blob_key"], ref["bytes"], ref["sha256"]) for ref in refs)


def _safe_destination(path):
    candidate = Path(path)
    if not candidate.name or candidate.name in (".", ".."):
        raise BackupError("restore destination path is invalid")
    try:
        parent = candidate.parent.resolve(strict=True)
    except OSError as exc:
        raise BackupError("restore destination parent does not exist") from exc
    if not parent.is_dir():
        raise BackupError("restore destination parent is not a directory")
    destination = parent / candidate.name
    if os.path.lexists(destination):
        raise BackupError("restore destination must not already exist")
    return destination, parent


def _rename_directory_noreplace(source, destination):
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    if sys.platform.startswith("linux"):
        renameat2 = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
        if renameat2 is None:
            raise BackupError("atomic no-overwrite restore is unavailable on this system")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, source_bytes, -100, destination_bytes, 1)
    elif sys.platform == "darwin":
        renamex_np = getattr(ctypes.CDLL(None, use_errno=True), "renamex_np", None)
        if renamex_np is None:
            raise BackupError("atomic no-overwrite restore is unavailable on this system")
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(source_bytes, destination_bytes, 0x00000004)
    elif os.name == "nt":
        os.rename(source, destination)
        return
    else:
        raise BackupError("atomic no-overwrite restore is unavailable on this system")
    if result == 0:
        return
    error = ctypes.get_errno()
    if error == errno.EEXIST:
        raise BackupError("restore destination must not already exist")
    raise BackupError("isolated restore could not be atomically published")


def _check_database_integrity(path):
    connection = _read_only_connection(path)
    try:
        result = connection.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise BackupError("restored database integrity check failed")
    except sqlite3.Error as exc:
        raise BackupError("restored database integrity check failed") from exc
    finally:
        connection.close()


def restore_archive(archive, destination):
    target, parent = _safe_destination(destination)
    stage = Path(tempfile.mkdtemp(prefix="." + target.name + ".restore-", dir=parent))
    os.chmod(stage, 0o700)
    try:
        manifest, manifest_bytes, blob_metadata, expanded, entries = _scan_archive(archive, stage)
        database_path = stage / "database.sqlite3"
        refs = _read_resource_refs(database_path)
        if refs is None or _canonical_refs(refs) != _canonical_refs(manifest["resources"]):
            raise BackupError("database snapshot references do not match the archive manifest")
        _check_database_integrity(database_path)

        blobs_dir = stage / "animation" / "blobs"
        animation_dir = stage / "animation"
        animation_dir.mkdir(mode=0o700, exist_ok=True)
        linked_keys = set()
        for ref in manifest["resources"]:
            key = ref["blob_key"]
            if key in linked_keys:
                continue
            source = blobs_dir / ref["sha256"]
            output = animation_dir / key
            try:
                os.link(source, output, follow_symlinks=False)
            except OSError as exc:
                raise BackupError("restored animation resource could not be materialized") from exc
            linked_keys.add(key)

        shutil.rmtree(blobs_dir)
        manifest_path = stage / "manifest.json"
        with open(manifest_path, "xb") as stream:
            os.chmod(manifest_path, 0o600)
            stream.write(manifest_bytes)
            stream.flush()
            os.fsync(stream.fileno())

        for key, (size, digest) in blob_metadata.items():
            actual_size, actual_digest = _hash_path(animation_dir / key, size)
            if actual_size != size or actual_digest != digest:
                raise BackupError("restored animation resource failed its integrity check")
        database_info = manifest["database"]
        actual_db_size, actual_db_digest = _hash_path(database_path, database_info["bytes"])
        if actual_db_size != database_info["bytes"] or actual_db_digest != database_info["sha256"]:
            raise BackupError("restored database snapshot failed its integrity check")

        _rename_directory_noreplace(stage, target)
        stage = None
        parent_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        return {
            "status": "restored",
            "destination": str(target),
            "records": len(manifest["resources"]),
            "unique_blobs": len(blob_metadata),
            "entries": entries,
            "expanded_bytes": expanded,
        }
    except Exception:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Create, verify, or restore an isolated animation backup.")
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--create", action="store_true")
    operation.add_argument("--verify", metavar="ARCHIVE")
    operation.add_argument("--restore", metavar="ARCHIVE")
    parser.add_argument("--snapshot")
    parser.add_argument("--animation-root")
    parser.add_argument("--output")
    parser.add_argument("--destination")
    args = parser.parse_args(argv)

    try:
        if args.verify:
            if any((args.snapshot, args.animation_root, args.output, args.destination)):
                parser.error("--verify cannot be combined with create or restore options")
            result = verify_archive(args.verify)
        elif args.restore:
            if not args.destination or any((args.snapshot, args.animation_root, args.output)):
                parser.error("--restore requires --destination and accepts no create options")
            result = restore_archive(args.restore, args.destination)
        else:
            if args.destination or not args.snapshot or not args.animation_root or not args.output:
                parser.error("--create requires --snapshot, --animation-root, and --output")
            result = create_archive(args.snapshot, args.animation_root, args.output)
    except BackupError as exc:
        print("[animation-backup] failed: " + str(exc), file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error, tarfile.TarError, EOFError):
        print("[animation-backup] failed: I/O or archive integrity error", file=sys.stderr)
        return 1

    if result["status"] == "skipped":
        print("[animation-backup] skipped reason=" + result["reason"])
    elif result["status"] == "created":
        print("[animation-backup] created records={} unique_blobs={} database_sha256={}".format(
            result["records"], result["unique_blobs"], result["database_sha256"]
        ))
    elif result["status"] == "verified":
        print("[animation-backup] verified records={} unique_blobs={} entries={} database_sha256={}".format(
            result["records"], result["unique_blobs"], result["entries"], result["database_sha256"]
        ))
    else:
        print("[animation-backup] restored records={} unique_blobs={}".format(
            result["records"], result["unique_blobs"]
        ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
