import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Prisma } from '@prisma/client';
import driver from '../src/lib/usage/sqlite-read-snapshot.ts';
const { withUsageReadSnapshot } = driver;

const run = promisify(execFile), root = process.cwd();
const evidence = process.env.USAGE_SQLITE_READER_EVIDENCE_ROOT || await fs.mkdtemp(path.join(os.tmpdir(), 'usage-reader-engineering-'));
await fs.mkdir(evidence, { recursive: true });
const fixture = await fs.mkdtemp(path.join(evidence, 'disposable-'));
const database = path.join(fixture, 'UTF8 空格 # query?.sqlite');
const python = '/usr/bin/python3', script = path.join(root, 'scripts/usage-sqlite-reader.py');
const originalUrl = process.env.DATABASE_URL;
const logs = [], checks = [];
const originalLog = console.error;
console.error = (prefix, value, ...rest) => {
  if (prefix === '[UsageReadSnapshot]') logs.push(JSON.parse(value));
  else originalLog(prefix, value, ...rest);
};
async function py(source, ...args) { return JSON.parse((await run(python, ['-c', source, ...args], { maxBuffer: 1024 * 1024 })).stdout); }
async function released(label) {
  const result = await py('import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1],timeout=1);c.execute("UPDATE Fixture SET marker=marker WHERE id=1");c.commit();r=c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone();c.close();print(json.dumps({"checkpoint":r}))', database);
  assert.deepEqual(result.checkpoint, [0, 0, 0], label);
}
function noLiveChildren(start) {
  for (const row of logs.slice(start).filter(row => row.event === 'spawn' && row.childPID)) {
    assert.throws(() => process.kill(row.childPID, 0), error => error.code === 'ESRCH');
    assert.ok(logs.slice(start).some(item => item.event === 'child-close' && item.childPID === row.childPID));
  }
}
async function rawSession() {
  const child = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [], waiters = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => { const value = JSON.parse(line); messages.push(value); for (const wake of waiters.splice(0)) wake(); });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  const next = async type => {
    for (;;) {
      const result = messages.find(row => row.type === type);
      if (result) return result;
      await new Promise(resolve => waiters.push(resolve));
    }
  };
  child.stdin.write(JSON.stringify({ type: 'open', database }) + '\n');
  await next('ready');
  return { child, next, messages, closed, stderr: () => stderr };
}

try {
  const versions = await py('import json,sqlite3,sys,platform\nc=sqlite3.connect(sys.argv[1]);assert c.execute("PRAGMA journal_mode=WAL").fetchone()==("wal",);c.execute("CREATE TABLE Fixture(id INTEGER PRIMARY KEY,marker TEXT NOT NULL)");c.executemany("INSERT INTO Fixture VALUES (?,?)",[(i,"before") for i in range(1,1251)]);c.commit();c.close();print(json.dumps({"python":platform.python_version(),"sqlite":sqlite3.sqlite_version,"platform":platform.system()}))', database);
  process.env.DATABASE_URL = pathToFileURL(database).href;
  let firstAsOf;
  const result = await withUsageReadSnapshot(async (reader, dataAsOf) => {
    firstAsOf = dataAsOf;
    const rows = await reader.query(Prisma.sql`SELECT 9223372036854775807 AS max, -9223372036854775808 AS min, 1.25 AS real, NULL AS missing, ${'中文\ntext'} AS text, typeof(${BigInt(3)}) AS integer_type, typeof(${1.5}) AS real_type, ${true} AS boolean_value, typeof(${1}) AS safe_number_type, ${new Date('2026-11-01T00:00:00.123Z')} AS date_value`);
    assert.equal(rows[0].max, BigInt('9223372036854775807'));
    assert.equal(rows[0].min, BigInt('-9223372036854775808'));
    assert.equal(rows[0].real, 1.25);
    assert.equal(rows[0].missing, null);
    assert.equal(rows[0].text, '中文\ntext');
    assert.equal(rows[0].integer_type, 'integer');
    assert.equal(rows[0].real_type, 'real');
    assert.equal(rows[0].boolean_value, BigInt(1));
    assert.equal(rows[0].safe_number_type, 'integer');
    assert.equal(rows[0].date_value, BigInt(Date.parse('2026-11-01T00:00:00.123Z')));
    const [one, two] = await Promise.all([reader.query(Prisma.sql`SELECT 1 AS value`), reader.query(Prisma.sql`SELECT 2 AS value`)]);
    assert.equal(one[0].value, BigInt(1)); assert.equal(two[0].value, BigInt(2));
    const before = await reader.query(Prisma.sql`SELECT id,marker FROM Fixture WHERE id <= 500 ORDER BY id`);
    assert.equal(before.length, 500);
    await py('import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1],timeout=1);c.execute("UPDATE Fixture SET marker=?",("after",));c.commit();c.close();print(json.dumps({"committed":True}))', database);
    const after = await reader.query(Prisma.sql`SELECT id,marker FROM Fixture ORDER BY id`);
    assert.equal(after.length, 1250);
    assert.ok(after.every(row => row.marker === 'before'));
    return after.length;
  });
  assert.equal(result, 1250);
  assert.ok(Number.isFinite(Date.parse(firstAsOf)));
  const next = await withUsageReadSnapshot(reader => reader.query(Prisma.sql`SELECT marker FROM Fixture WHERE id=1`));
  assert.equal(next[0].marker, 'after');
  process.env.DATABASE_URL = 'file:' + path.relative(path.join(root, 'prisma'), database).split(path.sep).map(encodeURIComponent).join('/') + '?connection_limit=1';
  const override = '2026-11-01T00:00:00.000Z';
  await withUsageReadSnapshot(async (reader, dataAsOf) => {
    assert.equal(dataAsOf, override);
    assert.equal((await reader.query(Prisma.sql`SELECT marker FROM Fixture WHERE id=1`))[0].marker, 'after');
  }, { dataAsOf: override });
  process.env.DATABASE_URL = pathToFileURL(database).href;
  checks.push({ name: 'precise_scalars_serial_queries_1250_rows_one_pinned_snapshot_concurrent_writer', passed: true,
    multiFrameQueryRows: 1250, maxRowsPerFrame: 500 });
  await released('normal-close'); noLiveChildren(0);

  const beforeRefusal = logs.length;
  await assert.rejects(withUsageReadSnapshot(reader => reader.query(Prisma.sql`UPDATE Fixture SET marker='forbidden'`)), error => error.code === 'USAGE_READ_SQLITE');
  assert.equal((await withUsageReadSnapshot(reader => reader.query(Prisma.sql`SELECT marker FROM Fixture WHERE id=1`)))[0].marker, 'after');
  noLiveChildren(beforeRefusal); await released('readonly-refusal');
  checks.push({ name: 'readonly_write_refusal_actual_exit_and_lock_release', passed: true });

  for (const value of [BigInt('9223372036854775808'), Number.MAX_SAFE_INTEGER + 1, NaN, undefined, new Date('invalid')]) {
    await assert.rejects(withUsageReadSnapshot(reader => reader.query(Prisma.sql`SELECT ${value} AS value`)), error => error.code === 'USAGE_READ_PARAMETER');
  }
  checks.push({ name: 'invalid_or_out_of_range_parameters_fail_and_close', passed: true });

  const long = Prisma.sql`WITH RECURSIVE count(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM count WHERE x<1000000000) SELECT sum(x) AS value FROM count`;
  for (const kind of ['cancel', 'timeout']) {
    const start = logs.length, controller = new AbortController();
    let cancelAt;
    const started = performance.now();
    const query = withUsageReadSnapshot(async reader => {
      if (kind === 'cancel') setTimeout(() => { cancelAt = performance.now(); controller.abort(); }, 50);
      return reader.query(long);
    }, kind === 'timeout' ? { timeoutMs: 150 } : { signal: controller.signal });
    await assert.rejects(query, error => error.code === (kind === 'timeout' ? 'USAGE_READ_TIMEOUT' : 'USAGE_READ_ABORTED'));
    noLiveChildren(start); await released(kind);
    checks.push({ name: `real_long_sql_${kind}_actual_child_close_and_lock_release`, passed: true,
      elapsedMs: performance.now() - started, cancelToSettledMs: cancelAt ? performance.now() - cancelAt : null,
      forced: logs.slice(start).some(row => row.event === 'child-close' && row.forced) });
  }

  // Exercise the already specified last-resort cleanup on this fixture's direct child only.
  // SIGSTOP prevents protocol cleanup; accept actual TERM/KILL exit and check OS descriptor release.
  const forcedStart = logs.length;
  await assert.rejects(withUsageReadSnapshot(async reader => {
    const spawned = logs.slice(forcedStart).find(row => row.event === 'spawn');
    assert.ok(spawned?.childPID);
    process.kill(spawned.childPID, 'SIGSTOP');
    return reader.query(long);
  }, { timeoutMs: 3000 }), error => error.code === 'USAGE_READ_TIMEOUT');
  noLiveChildren(forcedStart); await released('forced-direct-child-exit');
  assert.ok(logs.slice(forcedStart).some(row => row.event === 'child-close' && row.forced && ['SIGTERM', 'SIGKILL'].includes(row.signal) && !row.databaseClosed));
  checks.push({ name: 'nonresponsive_direct_child_timeout_waits_for_actual_signal_close_and_os_lock_release', passed: true,
    explicitPythonCloseClaimed: false });

  // Capture itself must unwind before the wrapper releases its ownership, even after the DB has exited.
  let callbackFinished = false;
  const controller = new AbortController(), idleStart = logs.length;
  await assert.rejects(withUsageReadSnapshot(async reader => {
    await reader.query(Prisma.sql`SELECT id FROM Fixture LIMIT 1`);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    callbackFinished = true;
    return 'late-result';
  }, { signal: controller.signal }), error => error.code === 'USAGE_READ_ABORTED');
  assert.equal(callbackFinished, true); noLiveChildren(idleStart); await released('capture-unwind');
  checks.push({ name: 'batch_gap_cancel_waits_for_capture_unwind_and_discards_late_result', passed: true });

  const eof = await rawSession();
  eof.child.stdin.write(JSON.stringify({ type: 'query', id: 1, sql: long.sql, params: [] }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 50));
  eof.child.stdin.end();
  assert.equal((await eof.closed).code, 1);
  assert.equal((await eof.next('closed')).databaseClosed, true);
  assert.equal(eof.stderr(), ''); await released('eof');
  checks.push({ name: 'stdin_eof_before_close_interrupts_real_sql_and_exits', passed: true });

  const normal = await rawSession();
  normal.child.stdin.end(JSON.stringify({ type: 'close' }) + '\n');
  assert.equal((await normal.closed).code, 0);
  assert.equal((await normal.next('closed')).reason, 'normal');
  assert.equal(normal.stderr(), ''); await released('normal-eof');
  checks.push({ name: 'accepted_close_followed_by_eof_is_normal', passed: true });

  const absent = path.join(fixture, 'must-not-be-created.sqlite');
  process.env.DATABASE_URL = pathToFileURL(absent).href;
  await assert.rejects(withUsageReadSnapshot(async () => 'unexpected'));
  await assert.rejects(fs.stat(absent), error => error.code === 'ENOENT');
  process.env.DATABASE_URL = originalUrl;
  checks.push({ name: 'missing_database_fails_without_creation', passed: true });

  const sourceSha256 = {};
  for (const name of ['src/lib/usage/sqlite-read-snapshot.ts', 'scripts/usage-sqlite-reader.py', 'scripts/usage-sqlite-reader-engineering.mjs']) {
    sourceSha256[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
  }
  const report = { schema: 'usage-sqlite-read-snapshot-driver-engineering.v1', at: new Date().toISOString(),
    node: process.version, ...versions, sourceSha256, checks, logs, passed: true,
    disposableFixtureOnly: true, productionDatabaseAccessed: false, linuxPerformanceAccepted: false,
    functionalAcceptance: false };
  await fs.writeFile(path.join(evidence, 'driver-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, evidence: path.join(evidence, 'driver-report.json'), ...versions }));
} catch (error) {
  await fs.writeFile(path.join(evidence, 'driver-failure.json'), JSON.stringify({ code: error?.code || 'ENGINEERING_ASSERTION', errorClass: error?.name || 'Error', checks, logs }, null, 2) + '\n');
  throw error;
} finally {
  console.error = originalLog;
  if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
  await fs.rm(fixture, { recursive: true, force: true });
}
