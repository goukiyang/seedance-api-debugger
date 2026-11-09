#!/usr/bin/env python3
"""Bounded private growth replay. No migration, API, provider or writable source connection."""
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time

AS_OF = '2026-11-09T07:25:11.945Z'
MAX_BYTES = 2 * 1024 ** 3
TABLES = ['VideoTask', 'ImageStudioTask', 'ProviderApiRequest', 'CreditLedger', 'ProjectBudgetLedger', 'UsageAttribution', 'CostLedger']


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def size(root):
    return sum(p.stat().st_size for p in root.rglob('*') if p.is_file() and not p.is_symlink())


def budget_size(output):
    return sum(size(p) for p in output.parent.glob('growth-*') if p.is_dir())


def resources():
    suffix = next(x[3:] for x in Path('/proc/self/cgroup').read_text().splitlines() if x.startswith('0::'))
    base = Path('/sys/fs/cgroup' + suffix)
    keyed = lambda name: {k: int(v) for k, v in (x.split() for x in (base / name).read_text().splitlines())}
    return {'epochMs': int(time.time() * 1000), 'cpu': keyed('cpu.stat'), 'memoryEvents': keyed('memory.events'),
            'memoryCurrent': int((base / 'memory.current').read_text()), 'memoryPeak': int((base / 'memory.peak').read_text()),
            'cpuPressure': (base / 'cpu.pressure').read_text().strip(),
            'hostCpuFirst8': list(map(int, Path('/proc/stat').read_text().splitlines()[0].split()[1:9])),
            'hostCpuPressure': Path('/proc/pressure/cpu').read_text().strip()}


def quote(value):
    if not value.replace('_', '').isalnum():
        raise ValueError('unrecognized_identifier')
    return '"' + value + '"'


def clone_rows(connection, table, condition, prefix, overrides):
    fields = [row[1] for row in connection.execute('PRAGMA table_info(' + quote(table) + ')')]
    expressions = []
    for field in fields:
        expression = overrides.get(field, 's.' + quote(field))
        expressions.append(expression.replace(':prefix', "'" + prefix + "'"))
    statement = ('INSERT INTO main.' + quote(table) + ' (' + ','.join(map(quote, fields)) + ') SELECT '
                 + ','.join(expressions) + ' FROM original.' + quote(table) + ' s WHERE ' + condition)
    before = connection.total_changes
    connection.execute(statement)
    return connection.total_changes - before


def prepare(args, axis, selection, manifest, deadline, existing):
    path = args.output / (axis + '.sqlite')
    start = time.monotonic()
    check = lambda: (_ for _ in ()).throw(TimeoutError('prepare_budget')) if time.monotonic() > deadline else None
    if not existing:
        source = sqlite3.connect(args.source.as_uri() + '?mode=ro', uri=True, isolation_level=None)
        source.execute('PRAGMA query_only=ON')
        destination = sqlite3.connect(path)
        try:
            source.backup(destination, pages=256, progress=lambda *_: check())
        finally:
            destination.close()
            source.close()
        path.chmod(0o600)
    connection = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, isolation_level=None)
    connection.execute('ATTACH DATABASE ? AS original', (args.source.as_uri() + '?mode=ro',))
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    for name, statement in selection['statements'].items():
        seed_sql = re.sub(r'(?i)\b(FROM|JOIN)\s+"([^"]+)"', lambda m: m.group(1) + ' original.' + quote(m.group(2)), statement['sql'])
        connection.execute('CREATE TEMP TABLE seed_' + name + ' AS ' + seed_sql, statement['params'])
    counts = {name: connection.execute('SELECT COUNT(*) FROM seed_' + name).fetchone()[0] for name in ['video', 'image', 'cash']}
    if counts != {'video': 364, 'image': 101, 'cash': 1147}:
        connection.close()
        raise ValueError('frozen_selection_count_mismatch')
    connection.execute('CREATE TEMP TABLE seed_fact AS SELECT id FROM seed_video UNION ALL SELECT id FROM seed_image')
    connection.execute('CREATE TEMP TABLE seed_request AS SELECT id FROM original.ProviderApiRequest WHERE '
                       + ('task_id IN(SELECT id FROM seed_video)' if axis == 'facts' else
                          'id IN(SELECT provider_request_id FROM original.CostLedger WHERE id IN(SELECT id FROM seed_cash)) '
                          "OR id IN(SELECT source_id FROM original.CostLedger WHERE id IN(SELECT id FROM seed_cash) AND source_type='provider_request')"))
    available = MAX_BYTES - budget_size(args.output) - 128 * 1024 ** 2 + path.stat().st_size
    page = connection.execute('PRAGMA page_size').fetchone()[0]
    connection.execute('PRAGMA max_page_count=' + str(max(path.stat().st_size // page, available // page)))
    copied = []
    first = manifest.get('copiesCompleted', 0) + 1
    for number in range(first, args.scale):
        check()
        if budget_size(args.output) > MAX_BYTES - 128 * 1024 ** 2:
            raise RuntimeError('private_disk_budget')
        prefix = 'growth-' + axis + '-' + str(number) + ':'
        ns = lambda field: "CASE WHEN s." + quote(field) + " IS NULL THEN NULL ELSE :prefix||s." + quote(field) + ' END'
        nonempty = lambda field: "CASE WHEN s." + quote(field) + " IS NULL OR s." + quote(field) + "='' THEN s." + quote(field) + " ELSE :prefix||s." + quote(field) + ' END'
        connection.execute('BEGIN')
        try:
            changed = {}
            if axis == 'facts':
                changed['VideoTask'] = clone_rows(connection, 'VideoTask', 's.id IN(SELECT id FROM seed_video)', prefix,
                    {'id': ns('id'), 'snapshot_id': 'NULL', 'idempotency_key': ns('idempotency_key'),
                     'provider_task_id': nonempty('provider_task_id'), 'provider_client_request_id': nonempty('provider_client_request_id')})
                changed['ImageStudioTask'] = clone_rows(connection, 'ImageStudioTask', 's.id IN(SELECT id FROM seed_image)', prefix,
                    {'id': ns('id'), 'batch_id': ns('batch_id'), 'gateway_request_id': nonempty('gateway_request_id')})
                for table in ['CreditLedger', 'ProjectBudgetLedger']:
                    changed[table] = clone_rows(connection, table, 's.related_task_id IN(SELECT id FROM seed_fact)', prefix,
                        {'id': ns('id'), 'related_task_id': ns('related_task_id'), 'idempotency_key': ns('idempotency_key')})
                changed['UsageAttribution'] = clone_rows(connection, 'UsageAttribution',
                    "(s.source_kind='video_task' AND s.source_id IN(SELECT id FROM seed_video)) OR (s.source_kind='image_task' AND s.source_id IN(SELECT id FROM seed_image))", prefix,
                    {'source_id': ns('source_id')})
                changed['ProviderApiRequest'] = clone_rows(connection, 'ProviderApiRequest', 's.id IN(SELECT id FROM seed_request)', prefix,
                    {'id': ns('id'), 'task_id': ns('task_id'), 'provider_task_id': nonempty('provider_task_id')})
            else:
                changed['ProviderApiRequest'] = clone_rows(connection, 'ProviderApiRequest', 's.id IN(SELECT id FROM seed_request)', prefix,
                    {'id': ns('id'), 'provider_task_id': nonempty('provider_task_id')})
                changed['CostLedger'] = clone_rows(connection, 'CostLedger', 's.id IN(SELECT id FROM seed_cash)', prefix,
                    {'id': ns('id'), 'idempotency_key': ns('idempotency_key'), 'official_charge_id': nonempty('official_charge_id'),
                     'provider_task_id': nonempty('provider_task_id'),
                     'provider_request_id': 'CASE WHEN s.provider_request_id IN(SELECT id FROM seed_request) THEN :prefix||s.provider_request_id ELSE s.provider_request_id END',
                     'source_id': "CASE WHEN s.source_type='provider_request' AND s.source_id IN(SELECT id FROM seed_request) THEN :prefix||s.source_id ELSE s.source_id END"})
            connection.execute('COMMIT')
        except Exception:
            connection.execute('ROLLBACK')
            raise
        copied.append({'copy': number, 'rows': changed})
        manifest['copiesCompleted'] = number
    connection.set_progress_handler(None, 0)
    manifest.setdefault('copies', []).extend(copied)
    manifest['originalSelectedRows'] = counts
    manifest['tableCounts'] = {table: connection.execute('SELECT COUNT(*) FROM ' + quote(table)).fetchone()[0] for table in TABLES}
    manifest['databaseBytes'] = path.stat().st_size
    connection.close()
    manifest['prepareWallMs'] = manifest.get('prepareWallMs', 0) + (time.monotonic() - start) * 1000
    if budget_size(args.output) > MAX_BYTES:
        raise RuntimeError('private_disk_budget')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--total-seconds', type=int, default=360)
    parser.add_argument('--axes', choices=['both', 'cash'], default='both')
    parser.add_argument('--compare-before', type=Path)
    args = parser.parse_args()
    for field in ['app_root', 'source', 'baseline', 'output']:
        setattr(args, field, getattr(args, field).resolve())
    if not 60 <= args.total_seconds <= 360 or not args.output.name.startswith('growth-'):
        raise ValueError('bounded_growth_output_required')
    if args.output.exists():
        raise ValueError('new_private_output_directory_required')
    for live in [args.app_root / 'var-lib/dev.db', Path('/data/video-api-debugger/var-lib/dev.db')]:
        if live.exists() and os.path.samefile(live, args.source):
            raise ValueError('live_source_forbidden')
    args.output.mkdir(mode=0o700)
    (args.output / 'tmp').mkdir(mode=0o700)
    env = {**os.environ, 'TMPDIR': str(args.output / 'tmp'), 'NODE_ENV': 'production'}
    baseline = json.loads(args.baseline.read_text())
    if baseline.get('asOf') != AS_OF or baseline.get('recordsRows') != 465 or baseline.get('cashEventsRows') != 1147:
        raise ValueError('explicit_frozen_baseline_required')
    source_before = args.source.stat()
    state = {'schema': 'usage-report-growth-engineering.v1', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'sourceBackup': str(args.source), 'asOf': AS_OF, 'baselineReceiptSha256': hashlib.sha256(args.baseline.read_bytes()).hexdigest(),
             'baselineRecomputed': False, 'engineeringSourceSha256': {Path(__file__).name: hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'usage-report-growth-case.cjs': hashlib.sha256(Path(__file__).with_name('usage-report-growth-case.cjs').read_bytes()).hexdigest()}, 'budget': {'cpuCores': 1, 'memoryMiB': 512, 'totalSeconds': args.total_seconds, 'caseSeconds': 60, 'temporaryBytes': MAX_BYTES},
             'axes': {}, 'cases': [], 'samples': [], 'completed': False,
             'datasetMeaning': {'facts': 'Repeat current video/image fact shapes and attribution/point/request metadata; cash constant, fresh provider references have no invented cash evidence.',
                                'cash': 'Repeat current cash shapes with unique event/proof/request identities; original task links retained, implicit-only new references remain unlinked rather than guessed.',
                                'executionSnapshots': 'Unrelated VideoTask.snapshot_id is NULL in synthetic clones; frozen report pricing/status/metadata remains copied. No API/generation uses this database.'}}
    receipt = args.output / 'growth-receipt.json'
    save(receipt, state)
    started = time.monotonic()
    case = Path(__file__).with_name('usage-report-growth-case.cjs')
    command = ['/usr/bin/node', '--import', str(args.app_root / 'node_modules/tsx/dist/loader.mjs'), str(case)]
    selection = args.output / 'selection.json'
    subprocess.run(command + [str(args.app_root), str(args.source), str(args.output / 'module-preflight.json'), AS_OF, 'preflight'], cwd=args.app_root, env=env, check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    subprocess.run(command + [str(args.app_root), str(args.source), str(selection), AS_OF, 'selection'], cwd=args.app_root, env=env, check=True, timeout=15,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    selected = json.loads(selection.read_text())
    stop = False
    axes = ['facts', 'cash'] if args.axes == 'both' else ['cash']
    if args.compare_before:
        args.compare_before = args.compare_before.resolve()
    for axis in axes:
        manifest = {'copiesCompleted': 0}
        state['axes'][axis] = manifest
        for scale in [5, 10]:
            if stop or time.monotonic() - started >= args.total_seconds - 10:
                state['cases'].append({'axis': axis, 'scale': scale, 'notRun': True, 'reason': 'earlier_case_failed' if stop else 'total_budget'})
                continue
            args.scale = scale
            try:
                remaining_prepare = 45 - manifest.get('prepareWallMs', 0) / 1000
                if remaining_prepare <= 0:
                    raise TimeoutError('prepare_budget')
                database = prepare(args, axis, selected, manifest, time.monotonic() + remaining_prepare, scale == 10)
            except Exception as error:
                state['cases'].append({'axis': axis, 'scale': scale, 'prepareFailure': type(error).__name__})
                save(receipt, state)
                break
            destination = args.output / (axis + '-' + str(scale) + '.json')
            state['samples'].append(resources())
            log = args.output / (axis + '-' + str(scale) + '.log')
            with log.open('wb') as logs:
                log.chmod(0o600)
                process = subprocess.Popen(command + [str(args.app_root), str(database), str(destination), AS_OF], env=env, cwd=args.app_root,
                                           stdout=logs, stderr=logs, start_new_session=True)
                deadline = time.monotonic() + min(60, args.total_seconds - 5 - (time.monotonic() - started))
                timed_out = False
                while process.poll() is None:
                    if time.monotonic() >= deadline or budget_size(args.output) > MAX_BYTES:
                        timed_out = True
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                        break
                    state['samples'].append(resources())
                    time.sleep(0.25)
                code = process.wait()
            result = json.loads(destination.read_text()) if destination.exists() else {}
            expected_facts = 465 * scale if axis == 'facts' else 465
            contract = result.get('completed') and result.get('recordsRows') == expected_facts and result.get('cashEventsRows') == (1147 * scale if axis == 'cash' else 1147) and result.get('databaseFileUnchanged') and result.get('forbiddenCalls') == 0
            equivalence = None
            if args.compare_before and result.get('completed'):
                before_file = args.compare_before / (axis + '-' + str(scale) + '.json')
                before = json.loads(before_file.read_text())
                fields = ['asOf', 'query', 'reportHash', 'recordsHash', 'cashEventsHash', 'recordsRows', 'cashEventsRows', 'summary']
                equality = {name: result.get(name) == before.get(name) for name in fields}
                original_root = Path(json.loads((args.compare_before / 'module-preflight.json').read_text())['bootWorkingDirectory'])
                csv_source = 'src/lib/admin/usage-csv.ts'
                csv_equal = hashlib.sha256((original_root / csv_source).read_bytes()).hexdigest() == result['sourceSha256'].get(csv_source)
                equivalence = {'beforeReceiptSha256': hashlib.sha256(before_file.read_bytes()).hexdigest(), 'equal': equality,
                               'csvProjection': {'equalInputsAndGenerator': all(equality.values()) and csv_equal,
                                                 'generatorUnchanged': csv_equal, 'beforeCsvBytesMeasured': False,
                                                 'method': 'Equal complete report/records/cash streams and unchanged actual CSV generator; only after CSV bytes captured.',
                                                 'after': result.get('csv')}}
                contract = contract and all(equality.values()) and csv_equal
            state['cases'].append({'axis': axis, 'scale': scale, 'exitCode': code, 'timedOut': timed_out,
                                   'receipt': destination.name, 'completed': result.get('completed', False), 'factCountContract': bool(contract),
                                   'recordRows': result.get('recordsRows'), 'cashRows': result.get('cashEventsRows'), 'equivalence': equivalence})
            state['samples'].append(resources())
            save(receipt, state)
            if not contract:
                stop = True
    after = args.source.stat()
    state['sourceBackupUnchanged'] = (source_before.st_size, source_before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
    state['totalWallMs'] = (time.monotonic() - started) * 1000
    state['temporaryBytes'] = budget_size(args.output)
    state['completed'] = len(state['cases']) == len(axes) * 2 and all(c.get('factCountContract') for c in state['cases']) and state['sourceBackupUnchanged']
    state['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save(receipt, state)
    print(json.dumps({'receipt': str(receipt), 'completed': state['completed'], 'cases': state['cases'], 'temporaryBytes': state['temporaryBytes']}))
    if not state['completed']:
        sys.exit(2)


if __name__ == '__main__':
    main()
