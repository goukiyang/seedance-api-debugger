#!/usr/bin/env python3
"""Extract a declared animation ZIP payload without trusting archive paths."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import struct
import sys
import time
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
ALLOWED_ROLES = {"pose", "mother", "reference", "video", "candidate"}
ALLOWED_SUFFIXES = {".png", ".mp4"}
CHUNK_BYTES = 1024 * 1024
EOCD_SIGNATURE = b"PK\x05\x06"
CENTRAL_SIGNATURE = b"PK\x01\x02"
EOCD_BYTES = 22
CENTRAL_HEADER_BYTES = 46
MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def normalized_name(name: str) -> str:
    if not isinstance(name, str) or not name or len(name) > 1024:
        raise ValueError("ZIP paths must be non-empty strings no longer than 1024 characters")
    if "\x00" in name or "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ValueError(f"unsafe ZIP path: {name!r}")
    if unicodedata.normalize("NFC", name) != name:
        raise ValueError(f"ZIP path is not NFC-normalized: {name!r}")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"unsafe ZIP path segment: {name!r}")
    if any(len(part) > 255 or ":" in part or any(ord(ch) < 32 for ch in part) for part in parts):
        raise ValueError(f"unsupported ZIP path component: {name!r}")
    if PurePosixPath(name).is_absolute():
        raise ValueError(f"absolute ZIP path: {name!r}")
    return unicodedata.normalize("NFKC", name).casefold()


def validate_manifest(data: bytes, max_manifest_bytes: int, max_files: int) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if len(data) > max_manifest_bytes:
        raise ValueError("manifest exceeds its byte limit")
    manifest = json.loads(data.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("manifest schema_version must be 1")
    files = manifest.get("files")
    if not isinstance(files, list) or not files or len(files) > max_files:
        raise ValueError("manifest files list is missing or exceeds its limit")

    by_path: dict[str, dict[str, Any]] = {}
    folded: dict[str, str] = {normalized_name("manifest.json"): "manifest.json"}
    ids: set[str] = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ValueError(f"files[{index}] must be an object")
        if set(item) - {"id", "path", "name", "role", "sha256"} or not {"id", "path", "name", "role"}.issubset(item):
            raise ValueError(f"files[{index}] has unsupported or missing fields")
        file_id = item["id"]
        file_path = item["path"]
        if not isinstance(file_id, str) or not ID_PATTERN.fullmatch(file_id) or file_id in ids:
            raise ValueError(f"files[{index}].id is invalid or duplicated")
        ids.add(file_id)
        if not isinstance(item["name"], str) or not item["name"] or len(item["name"]) > 255:
            raise ValueError(f"files[{index}].name is invalid")
        if item["role"] not in ALLOWED_ROLES:
            raise ValueError(f"files[{index}].role is unsupported")
        if "sha256" in item and (not isinstance(item["sha256"], str) or not re.fullmatch(r"[0-9a-fA-F]{64}", item["sha256"])):
            raise ValueError(f"files[{index}].sha256 is invalid")
        key = normalized_name(file_path)
        if file_path == "manifest.json" or key in folded:
            raise ValueError(f"duplicate or conflicting ZIP path: {file_path!r}")
        suffix = Path(file_path).suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            raise ValueError(f"unsupported media path: {file_path!r}")
        folded[key] = file_path
        by_path[file_path] = item
    return manifest, by_path


def validate_member(info: zipfile.ZipInfo, max_single_bytes: int) -> str:
    key = normalized_name(info.filename)
    if info.is_dir() or info.filename.endswith("/"):
        raise ValueError("directory entries are not accepted")
    if info.flag_bits & 0x1:
        raise ValueError("encrypted ZIP entries are not accepted")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ValueError("unsupported ZIP compression method")
    if info.file_size < 0 or info.file_size > max_single_bytes:
        raise ValueError(f"ZIP member exceeds its per-file limit: {info.filename!r}")
    if info.file_size and info.compress_size == 0:
        raise ValueError("non-empty ZIP member has no compressed data")
    if info.compress_size and info.file_size / info.compress_size > 10_000:
        raise ValueError(f"suspicious compression ratio: {info.filename!r}")

    unix_mode = info.external_attr >> 16
    file_type = stat.S_IFMT(unix_mode)
    if file_type not in (0, stat.S_IFREG) or stat.S_ISLNK(unix_mode):
        raise ValueError("non-regular ZIP entries are not accepted")
    if unix_mode & 0o111:
        raise ValueError("executable ZIP entries are not accepted")
    if info.external_attr & 0x400:
        raise ValueError("reparse-point ZIP entries are not accepted")
    return key


def safe_destination(root: Path, relative_path: str) -> Path:
    target = root.joinpath(*relative_path.split("/"))
    resolved = target.resolve(strict=False)
    if os.path.commonpath((str(root), str(resolved))) != str(root):
        raise ValueError("resolved ZIP path escaped the extraction directory")

    current = root
    for part in relative_path.split("/")[:-1]:
        current = current / part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError("ZIP parent path is not a plain directory")
    return target


def preflight_central_directory(stream: Any, archive_size: int, max_entries: int, deadline: float) -> None:
    tail_length = min(archive_size, EOCD_BYTES + 65_535)
    stream.seek(archive_size - tail_length)
    tail = stream.read(tail_length)
    if time.monotonic() > deadline:
        raise TimeoutError("ZIP preflight exceeded its time budget")
    eocd_offset_in_tail = tail.rfind(EOCD_SIGNATURE)
    if eocd_offset_in_tail < 0 or len(tail) - eocd_offset_in_tail < EOCD_BYTES:
        raise ValueError("ZIP end-of-central-directory record is missing or truncated")
    eocd_absolute = archive_size - tail_length + eocd_offset_in_tail
    fields = struct.unpack_from("<4s4H2LH", tail, eocd_offset_in_tail)
    _, disk_number, central_disk, disk_entries, total_entries, central_size, central_offset, comment_length = fields
    if eocd_offset_in_tail + EOCD_BYTES + comment_length != len(tail):
        raise ValueError("ZIP end-of-central-directory comment length is invalid")
    if disk_number != 0 or central_disk != 0 or disk_entries != total_entries:
        raise ValueError("multi-disk ZIP archives are not accepted")
    if total_entries in (0xFFFF,) or central_size in (0xFFFFFFFF,) or central_offset in (0xFFFFFFFF,):
        raise ValueError("ZIP64 archives are not accepted by the bounded importer")
    if total_entries < 1 or total_entries > max_entries:
        raise ValueError("ZIP entry count is outside the allowed range")
    if central_size > MAX_CENTRAL_DIRECTORY_BYTES:
        raise ValueError("ZIP central directory exceeds its byte limit")
    if central_offset + central_size != eocd_absolute or central_offset < 0 or central_offset > archive_size:
        raise ValueError("ZIP central directory offsets are invalid")

    stream.seek(central_offset)
    central = stream.read(central_size)
    if len(central) != central_size:
        raise ValueError("ZIP central directory is truncated")
    cursor = 0
    seen_names: dict[str, str] = {}
    for _ in range(total_entries):
        if time.monotonic() > deadline:
            raise TimeoutError("ZIP preflight exceeded its time budget")
        if cursor + CENTRAL_HEADER_BYTES > len(central):
            raise ValueError("ZIP central directory entry is truncated")
        record = struct.unpack_from("<4s6H3L5H2L", central, cursor)
        signature = record[0]
        flags = record[3]
        compressed_size = record[8]
        uncompressed_size = record[9]
        name_length = record[10]
        extra_length = record[11]
        member_comment_length = record[12]
        start_disk = record[13]
        local_header_offset = record[16]
        record_end = cursor + CENTRAL_HEADER_BYTES + name_length + extra_length + member_comment_length
        if signature != CENTRAL_SIGNATURE or record_end > len(central):
            raise ValueError("ZIP central directory entry layout is invalid")
        if name_length < 1 or name_length > 1_024:
            raise ValueError("ZIP member name exceeds its byte limit")
        if start_disk != 0 or compressed_size == 0xFFFFFFFF or uncompressed_size == 0xFFFFFFFF or local_header_offset == 0xFFFFFFFF:
            raise ValueError("ZIP64 or multi-disk member metadata is not accepted")
        name_bytes = central[cursor + CENTRAL_HEADER_BYTES:cursor + CENTRAL_HEADER_BYTES + name_length]
        try:
            member_name = name_bytes.decode("utf-8" if flags & 0x800 else "cp437", "strict")
        except UnicodeDecodeError as error:
            raise ValueError("ZIP member name encoding is invalid") from error
        key = normalized_name(member_name)
        previous = seen_names.get(key)
        if previous is not None:
            raise ValueError(f"duplicate or normalized-name collision: {previous!r}, {member_name!r}")
        seen_names[key] = member_name

        extra_start = cursor + CENTRAL_HEADER_BYTES + name_length
        extra_end = extra_start + extra_length
        extra_cursor = extra_start
        while extra_cursor < extra_end:
            if extra_cursor + 4 > extra_end:
                raise ValueError("ZIP extra field is truncated")
            extra_id, extra_size = struct.unpack_from("<HH", central, extra_cursor)
            extra_cursor += 4
            if extra_cursor + extra_size > extra_end:
                raise ValueError("ZIP extra field length is invalid")
            if extra_id == 0x0001:
                raise ValueError("ZIP64 members are not accepted by the bounded importer")
            extra_cursor += extra_size
        cursor = record_end
    if cursor != central_size:
        raise ValueError("ZIP central directory contains unindexed data")


def extract(args: argparse.Namespace) -> None:
    deadline = time.monotonic() + args.max_seconds
    zip_path = Path(args.zip).absolute()
    zip_info = zip_path.lstat()
    if not stat.S_ISREG(zip_info.st_mode) or stat.S_ISLNK(zip_info.st_mode):
        raise ValueError("ZIP input must be a regular, non-symlink file")
    if zip_info.st_size > args.max_archive_bytes:
        raise ValueError("compressed ZIP exceeds its byte limit")

    output = Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("extraction destination must not already exist")
    if not output.parent.is_dir() or output.parent.is_symlink():
        raise ValueError("extraction parent must be an existing non-symlink directory")
    created = False
    created_identity: tuple[int, int] | None = None

    try:
        if time.monotonic() > deadline:
            raise TimeoutError("ZIP extraction exceeded its time budget")
        descriptor = os.open(zip_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as zip_stream:
            opened_info = os.fstat(zip_stream.fileno())
            if not stat.S_ISREG(opened_info.st_mode) or opened_info.st_size != zip_info.st_size:
                raise ValueError("ZIP input changed while opening")
            preflight_central_directory(zip_stream, opened_info.st_size, args.max_files + 1, deadline)
            zip_stream.seek(0)
            with zipfile.ZipFile(zip_stream, "r") as archive:
                if time.monotonic() > deadline:
                    raise TimeoutError("ZIP preflight exceeded its time budget")
                members = archive.infolist()
                if not members or len(members) > args.max_files + 1:
                    raise ValueError("ZIP entry count is outside the allowed range")

                folded: dict[str, str] = {}
                by_exact_name: dict[str, zipfile.ZipInfo] = {}
                declared_total = 0
                for info in members:
                    if time.monotonic() > deadline:
                        raise TimeoutError("ZIP extraction exceeded its time budget")
                    key = validate_member(info, args.max_single_bytes)
                    previous = folded.get(key)
                    if previous is not None:
                        raise ValueError(f"duplicate or normalized-name collision: {previous!r}, {info.filename!r}")
                    folded[key] = info.filename
                    by_exact_name[info.filename] = info
                    declared_total += info.file_size
                    if declared_total > args.max_total_bytes:
                        raise ValueError("declared ZIP expansion exceeds its total byte limit")

                manifests = [info for info in members if info.filename == "manifest.json"]
                if len(manifests) != 1:
                    raise ValueError("ZIP must contain exactly one root manifest.json")
                manifest_info = manifests[0]
                if manifest_info.file_size > args.max_manifest_bytes:
                    raise ValueError("manifest exceeds its byte limit")
                if time.monotonic() > deadline:
                    raise TimeoutError("ZIP extraction exceeded its time budget")
                with archive.open(manifest_info, "r") as stream:
                    manifest_bytes = stream.read(args.max_manifest_bytes + 1)
                if time.monotonic() > deadline:
                    raise TimeoutError("ZIP extraction exceeded its time budget")
                manifest, declared_files = validate_manifest(manifest_bytes, args.max_manifest_bytes, args.max_files)
                expected = {"manifest.json", *declared_files.keys()}
                actual = set(by_exact_name)
                if actual != expected:
                    extra = sorted(actual - expected)
                    missing = sorted(expected - actual)
                    raise ValueError(f"ZIP members do not match manifest (extra={extra[:3]}, missing={missing[:3]})")

                output.mkdir(mode=0o700)
                created = True
                output_info = output.lstat()
                created_identity = (output_info.st_dev, output_info.st_ino)
                root = output.resolve(strict=True)
                actual_total = 0
                extracted_count = 0
                for info in members:
                    if time.monotonic() > deadline:
                        raise TimeoutError("ZIP extraction exceeded its time budget")
                    target = safe_destination(root, info.filename)
                    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                    descriptor = os.open(target, flags, 0o600)
                    written = 0
                    try:
                        with archive.open(info, "r") as source, os.fdopen(descriptor, "wb") as destination:
                            descriptor = -1
                            while True:
                                chunk = source.read(CHUNK_BYTES)
                                if not chunk:
                                    break
                                written += len(chunk)
                                actual_total += len(chunk)
                                if actual_total > args.max_total_bytes or written > args.max_single_bytes:
                                    raise ValueError("actual ZIP expansion exceeds its byte limit")
                                if time.monotonic() > deadline:
                                    raise TimeoutError("ZIP extraction exceeded its time budget")
                                destination.write(chunk)
                            destination.flush()
                            os.fsync(destination.fileno())
                    finally:
                        if descriptor >= 0:
                            os.close(descriptor)
                    if written != info.file_size:
                        raise ValueError(f"actual byte count differs from ZIP metadata: {info.filename!r}")
                    extracted_count += 1

                sys.stdout.write(json.dumps({"member_count": extracted_count, "total_bytes": actual_total}))
    except Exception:
        if created:
            try:
                current = output.lstat()
                if created_identity == (current.st_dev, current.st_ino) and stat.S_ISDIR(current.st_mode) and not stat.S_ISLNK(current.st_mode):
                    shutil.rmtree(output, ignore_errors=True)
            except FileNotFoundError:
                pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-files", type=int, default=2001)
    parser.add_argument("--max-single-bytes", type=int, default=1024 * 1024 * 1024)
    parser.add_argument("--max-total-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    parser.add_argument("--max-archive-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    parser.add_argument("--max-manifest-bytes", type=int, default=4 * 1024 * 1024)
    parser.add_argument("--max-seconds", type=int, default=120)
    args = parser.parse_args()
    if min(args.max_files, args.max_single_bytes, args.max_total_bytes, args.max_archive_bytes, args.max_manifest_bytes, args.max_seconds) <= 0:
        parser.error("all limits must be positive")
    try:
        extract(args)
        return 0
    except Exception as error:
        sys.stderr.write(f"animation-safe-extract: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
