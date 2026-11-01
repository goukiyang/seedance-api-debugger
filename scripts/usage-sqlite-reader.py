#!/usr/bin/env python3
"""Private usage-report session: one read-only connection, one pinned read transaction."""
import datetime
import json
import math
import os
from pathlib import Path
import queue
import selectors
import sqlite3
import sys
import threading
import time


class ProtocolError(Exception):
    pass


def decode_cell(cell):
    if not isinstance(cell, list) or not cell:
        raise ProtocolError()
    tag = cell[0]
    if tag == 'n' and len(cell) == 1:
        return None
    if len(cell) != 2:
        raise ProtocolError()
    value = cell[1]
    if tag == 'i' and isinstance(value, str):
        # int() never passes through a floating-point representation.
        integer = int(value)
        if value != str(integer):
            raise ProtocolError()
        if not -(2 ** 63) <= integer < 2 ** 63:
            raise ProtocolError()
        return integer
    if tag == 'r' and type(value) in (int, float) and math.isfinite(value):
        return float(value)
    if tag == 't' and isinstance(value, str):
        return value
    raise ProtocolError()


def encode_cell(value):
    if value is None:
        return ['n']
    if type(value) is int:
        return ['i', str(value)]
    if type(value) is float and math.isfinite(value):
        return ['r', value]
    if isinstance(value, str):
        return ['t', value]
    # No report projection returns BLOB. Unknown/non-finite values fail the whole capture.
    raise ProtocolError()


def emit(frame):
    data = (json.dumps(frame, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
    while data:
        data = data[os.write(sys.stdout.fileno(), data):]


def main():
    commands = queue.Queue()
    cancelled = threading.Event()
    lifecycle = threading.Lock()
    state = {'connection': None, 'closing': False, 'closeAccepted': False, 'controlError': None}
    wake_read, wake_write = os.pipe()

    def cancel(code='CANCELLED'):
        cancelled.set()
        with lifecycle:
            state['controlError'] = state['controlError'] or code
            connection = state['connection']
            if connection is not None and not state['closing']:
                connection.interrupt()
        commands.put({'type': 'cancel'})

    def control():
        pending = b''
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
                selector.register(wake_read, selectors.EVENT_READ)
                while True:
                    for key, _ in selector.select():
                        if key.fd == wake_read:
                            return
                        data = os.read(sys.stdin.fileno(), 65536)
                        if not data:
                            if not state['closeAccepted']:
                                cancel()
                            return
                        pending += data
                        while b'\n' in pending:
                            line, pending = pending.split(b'\n', 1)
                            message = json.loads(line)
                            if not isinstance(message, dict):
                                raise ProtocolError()
                            kind = message.get('type')
                            if kind == 'cancel':
                                cancel()
                                return
                            if kind == 'close':
                                state['closeAccepted'] = True
                                commands.put(message)
                                return
                            if kind not in ('open', 'query'):
                                raise ProtocolError()
                            commands.put(message)
        except Exception:
            cancel('PROTOCOL_FAILED')

    controller = threading.Thread(target=control, name='usage-reader-control')
    controller.start()
    connection = None
    cursor = None
    normal = False
    failed = False
    broken_pipe = False
    request_id = None
    opened_at = time.monotonic()
    try:
        message = commands.get()
        if cancelled.is_set():
            raise InterruptedError()
        if message.get('type') != 'open' or not isinstance(message.get('database'), str):
            raise ProtocolError()
        database = Path(message['database'])
        if not database.is_absolute() or not database.is_file():
            raise ProtocolError()
        options = {'uri': True, 'detect_types': 0, 'isolation_level': None, 'timeout': 5.0}
        if sys.version_info >= (3, 12):
            options['autocommit'] = sqlite3.LEGACY_TRANSACTION_CONTROL
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', **options)
        with lifecycle:
            state['connection'] = connection
        connection.set_progress_handler(lambda: int(cancelled.is_set()), 1000)
        cursor = connection.cursor()
        try:
            cursor.execute('PRAGMA query_only=ON')
            cursor.execute('BEGIN DEFERRED')
            # Reading the real schema pins the database snapshot; SELECT 1 would not.
            cursor.execute('SELECT name FROM sqlite_master LIMIT 1')
            cursor.fetchall()
            data_as_of = message.get('dataAsOf') or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        finally:
            cursor.close()
            cursor = None
        if cancelled.is_set():
            raise InterruptedError()
        emit({'type': 'ready', 'dataAsOf': data_as_of, 'pid': os.getpid(),
              'pythonVersion': '.'.join(map(str, sys.version_info[:3])), 'sqliteVersion': sqlite3.sqlite_version,
              'openPinMs': (time.monotonic() - opened_at) * 1000})
        while True:
            message = commands.get()
            if cancelled.is_set():
                raise InterruptedError()
            if message.get('type') == 'close':
                normal = True
                break
            if message.get('type') != 'query' or not isinstance(message.get('id'), int) or not isinstance(message.get('sql'), str) or not isinstance(message.get('params'), list):
                raise ProtocolError()
            request_id = message['id']
            parameters = tuple(decode_cell(cell) for cell in message['params'])
            started = time.monotonic()
            rows = frames = 0
            cursor = connection.cursor()
            try:
                cursor.execute(message['sql'], parameters)
                if cursor.description is None:
                    raise ProtocolError()
                columns = [column[0] for column in cursor.description]
                while True:
                    if cancelled.is_set():
                        raise InterruptedError()
                    batch = cursor.fetchmany(500)
                    if not batch:
                        break
                    emit({'type': 'rows', 'id': request_id, 'columns': columns,
                          'rows': [[encode_cell(value) for value in row] for row in batch]})
                    rows += len(batch)
                    frames += 1
            finally:
                cursor.close()
                cursor = None
            if cancelled.is_set():
                raise InterruptedError()
            emit({'type': 'done', 'id': request_id, 'rows': rows, 'frames': frames,
                  'queryMs': (time.monotonic() - started) * 1000})
            request_id = None
    except BrokenPipeError:
        broken_pipe = True
        failed = True
        cancelled.set()
    except Exception as error:
        failed = True
        code = state['controlError'] or ('CANCELLED' if cancelled.is_set() or isinstance(error, InterruptedError)
                                        else 'PROTOCOL_FAILED' if isinstance(error, (ProtocolError, ValueError, OverflowError))
                                        else 'SQLITE_FAILED' if isinstance(error, sqlite3.Error) else 'READER_FAILED')
        try:
            emit({'type': 'error', 'id': request_id, 'code': code,
                  'sqliteCode': getattr(error, 'sqlite_errorcode', None) if isinstance(error, sqlite3.Error) else None})
        except BrokenPipeError:
            broken_pipe = True
    finally:
        close_started = time.monotonic()
        closed = False
        try:
            try:
                if cursor is not None:
                    cursor.close()
            finally:
                if connection is not None:
                    # Detach interrupt ownership only after the active cursor has ended.
                    with lifecycle:
                        state['closing'] = True
                        state['connection'] = None
                    try:
                        connection.set_progress_handler(None, 0)
                        if connection.in_transaction:
                            connection.execute('COMMIT' if normal and not failed and not cancelled.is_set() else 'ROLLBACK').close()
                    finally:
                        connection.close()
            closed = True
        except Exception:
            failed = True
        finally:
            os.write(wake_write, b'x')
            controller.join()
            os.close(wake_write)
            os.close(wake_read)
        if not broken_pipe:
            try:
                emit({'type': 'closed', 'databaseClosed': closed,
                      'reason': 'normal' if normal and not failed and not cancelled.is_set() else 'cancelled' if cancelled.is_set() else 'failed',
                      'closeMs': (time.monotonic() - close_started) * 1000})
            except BrokenPipeError:
                pass
    return 0 if normal and not failed and not cancelled.is_set() else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Never print exception messages: SQLite can include SQL fragments or bound data.
        raise SystemExit(1)
