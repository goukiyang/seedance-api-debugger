#!/usr/bin/env python3
"""Stage the additive API schema or archive one proved terminal API video."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
from contextlib import closing


TABLES = {
    "ApiAsset", "ApiConfiguration", "ApiCustomer", "ApiKey", "ApiProviderCredential",
    "ApiQuote", "ApiRate", "ApiRequest", "ApiRequestRejection", "ApiUpload",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def connect(path, writable=False):
    mode = "rw" if writable else "ro"
    db = sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=" + mode, uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def schema_sql(path):
    pending = ""
    statements = []
    for line in path.read_text().splitlines(keepends=True):
        if not line.lstrip().startswith("--"):
            pending += line
        if sqlite3.complete_statement(pending):
            require(re.match(r'^\s*CREATE (?:TABLE|(?:UNIQUE )?INDEX) "', pending),
                    "Customer API migration must only add tables and indexes")
            statements.append(pending)
            pending = ""
    require(not pending.strip() and statements, "Incomplete customer API migration")
    with closing(sqlite3.connect(":memory:")) as probe:
        for statement in statements:
            probe.execute(statement)
        entries = probe.execute(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
        ).fetchall()
    require({table for _, table, _ in entries} == TABLES, "Unexpected customer API table set")
    return statements, entries


def verify_schema(db, entries):
    names = tuple(name for name, _, _ in entries)
    marks = ",".join("?" for _ in names)
    actual = [tuple(row) for row in db.execute(
        f"SELECT name, tbl_name, sql FROM sqlite_master WHERE name IN ({marks}) ORDER BY name", names
    )]
    return actual == entries


def schema_action(args):
    statements, entries = schema_sql(args.migration)
    with closing(connect(args.database, args.action == "migrate-schema")) as db:
        if args.action == "migrate-schema":
            with db:
                db.execute("BEGIN IMMEDIATE")
                if not verify_schema(db, entries):
                    for statement in statements:
                        db.execute(statement)
                require(verify_schema(db, entries), "Customer API schema confirmation failed")
        else:
            require(verify_schema(db, entries), "Customer API schema is missing or different")
    return {"schemaReady": True, "tables": len(TABLES), "schemaObjects": len(entries)}


def row(db, table, record_id):
    result = db.execute(f'SELECT * FROM "{table}" WHERE id = ?', (record_id,)).fetchone()
    require(result is not None, f"Missing original {table} row")
    return result


def pick(record, names):
    return {name: record[name] for name in names.split()}


def install_row(db, table, data):
    existing = db.execute(f'SELECT * FROM "{table}" WHERE id = ?', (data["id"],)).fetchone()
    if existing is not None:
        require(all(existing[key] == value for key, value in data.items()),
                f"An existing {table} row differs. No existing row can be changed.")
        return
    columns = ", ".join(f'"{name}"' for name in data)
    marks = ", ".join("?" for _ in data)
    db.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({marks})', tuple(data.values()))


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def private_media(args, owner, content_hash, size):
    root = args.private_uploads.resolve(strict=True)
    require(root.name == "verified-uploads" and stat.S_IMODE(root.stat().st_mode) == 0o700,
            "Private upload root must be an existing private directory")
    require(not args.video.is_symlink() and args.video.is_file()
            and args.video.stat().st_size == size and sha256(args.video) == content_hash,
            "Original video checksum or length differs")
    owner_hash = hashlib.sha256(owner.encode()).hexdigest()
    directory = root
    for segment in ("api-clients", "videos", owner_hash):
        directory = directory / segment
        directory.mkdir(mode=0o700, exist_ok=True)
        mode = directory.lstat().st_mode
        require(stat.S_ISDIR(mode) and stat.S_IMODE(mode) == 0o700 and directory.resolve() == directory,
                "Unsafe private media directory")
    destination = directory / (content_hash + ".mp4")
    with tempfile.NamedTemporaryFile(dir=directory, prefix=".archive-", delete=False) as temporary:
        temporary_path = Path(temporary.name)
        try:
            with args.video.open("rb") as original:
                shutil.copyfileobj(original, temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
            require(sha256(temporary_path) == content_hash, "Video changed while reading")
            try:
                os.link(temporary_path, destination)
            except FileExistsError:
                pass
        finally:
            temporary_path.unlink(missing_ok=True)
    mode = destination.lstat().st_mode
    require(stat.S_ISREG(mode) and stat.S_IMODE(mode) == 0o600
            and destination.stat().st_size == size and sha256(destination) == content_hash,
            "Existing private video is not the same original file")
    version = subprocess.check_output(
        [args.node, "-e", 'const s=require("fs").statSync(process.argv[1]);'
         'process.stdout.write([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(":"))',
         str(destination)], text=True,
    )
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return f"api-private://videos/{owner_hash}/{content_hash}.mp4", version


def archive(args):
    require(args.database.resolve() != args.original.resolve(), "Use an independent original database")
    require(math.isfinite(args.points) and args.points > 0, "Invalid actual debit")
    with closing(connect(args.original)) as source:
        task = row(source, "VideoTask", args.task_id)
        receipt = source.execute('SELECT * FROM "ApiRequest" WHERE task_id = ?', (args.task_id,)).fetchone()
        require(receipt is not None and receipt["request_id"] == args.request_id
                and task["source_request_id"] == args.request_id, "Original request does not match")
        require(task["source_type"] == "customer_api" and task["local_status"] == "succeeded"
                and task["delivery_status"] == "succeeded" and task["actual_cost"] == args.points
                and task["user_id"] == args.owner_id and task["owner_user_id"] == args.owner_id,
                "Original task owner, cost, or terminal state differs")
        debit = [tuple(item) for item in source.execute(
            'SELECT type, amount FROM "CreditLedger" WHERE related_task_id = ? AND user_id = ? ORDER BY type',
            (args.task_id, args.owner_id))]
        require(debit == [("task_freeze", -args.points), ("task_success_deduct", -args.points)],
                "Expected one original freeze and one successful settlement")
        require(receipt["output_sha256"] == args.sha256 and re.fullmatch("[0-9a-f]{64}", args.sha256)
                and receipt["output_bytes"] > 0, "Original delivery receipt is incomplete")
        owner = row(source, "User", args.owner_id)
        customer = row(source, "ApiCustomer", receipt["customer_id"])
        credential = row(source, "ApiProviderCredential", receipt["credential_id"])
        project = row(source, "Project", task["project_id"])
        card = row(source, "VideoCard", task["video_card_id"])
        require(customer["user_id"] == project["owner_user_id"] == project["created_by"]
                == card["owner_user_id"] == card["created_by"] == args.owner_id
                and customer["project_id"] == card["project_id"] == task["project_id"]
                and customer["video_card_id"] == task["video_card_id"], "Original private ownership differs")

    _, entries = schema_sql(args.migration)
    with closing(connect(args.database, True)) as target:
        require(verify_schema(target, entries), "Target API schema has not been verified")
        url, version = private_media(args, args.owner_id, args.sha256, receipt["output_bytes"])
        alias = "archived-api-" + hashlib.sha256(args.owner_id.encode()).hexdigest()[:20]
        with target:
            target.execute("BEGIN IMMEDIATE")
            require(target.execute(
                'SELECT id FROM "VideoTask" WHERE source_request_id = ? AND id <> ?',
                (args.request_id, args.task_id)).fetchone() is None, "Original request already exists under another task")
            install_row(target, "User", {**pick(owner, "id created_at updated_at"),
                        "username": alias, "email": alias + "@archive.invalid", "name": "API 实扣验收（原测试账号）",
                        "password_hash": "DISABLED_ARCHIVE", "role": "user", "status": "disabled",
                        "account_type": owner["account_type"]})
            install_row(target, "Project", {**pick(project, "id name created_at updated_at owner_user_id created_by"),
                        "type": "personal", "visibility": "private", "status": "archived"})
            install_row(target, "VideoCard", {**pick(card, "id project_id title owner_user_id created_by created_at updated_at"),
                        "status": "archived"})
            install_row(target, "ApiCustomer", {**pick(customer, "id name user_id project_id video_card_id timezone created_at updated_at"),
                        "create_enabled": 0, "read_enabled": 0, "license_confirmed": 0})
            install_row(target, "ApiProviderCredential", {**pick(credential, "id created_at"),
                        "digest": hashlib.sha256(("archive:" + credential["id"]).encode()).hexdigest(),
                        "configuration_json": "{}"})
            install_row(target, "VideoTask", {**pick(task, "id provider model generation_mode prompt source_type source_label "
                        "source_request_id ratio duration resolution generate_audio provider_task_id provider_status "
                        "local_status user_id owner_user_id project_id video_card_id estimated_cost actual_cost "
                        "billing_scope created_at updated_at completed_at delivery_completed_at delivery_status"),
                        "local_video_path": url, "visibility": "private", "retention_status": "active",
                        "source_metadata_json": json.dumps({"archived_api_test_receipt": True})})
            install_row(target, "ApiRequest", {**pick(receipt, "id customer_id request_id fingerprint agent_id key_id task_id "
                        "quote_id reserved_points day_key month_key timezone credential_id output_reserved_bytes "
                        "output_bytes output_sha256 created_at"), "output_version": version, "delivery_recovery_used": 1})
    return {"requestId": args.request_id, "taskId": args.task_id, "actualPoints": args.points,
            "originalSha256": args.sha256, "newWalletEntries": 0, "apiAccessEnabled": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for command in ("check-schema", "migrate-schema", "archive"):
        action = commands.add_parser(command)
        action.add_argument("--database", required=True, type=Path)
        action.add_argument("--migration", required=True, type=Path)
        if command == "archive":
            for name in ("original", "video", "private_uploads"):
                action.add_argument("--" + name.replace("_", "-"), required=True, type=Path)
            for name in ("task_id", "request_id", "owner_id", "sha256"):
                action.add_argument("--" + name.replace("_", "-"), required=True)
            action.add_argument("--points", required=True, type=float)
            action.add_argument("--node", default="/usr/bin/node")
    args = parser.parse_args()
    print(json.dumps(archive(args) if args.action == "archive" else schema_action(args), ensure_ascii=False))


if __name__ == "__main__":
    main()
