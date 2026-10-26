import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

// R03 copy of the reviewed R02 helper: no import-time IO, SQLite connection,
// production probe, automatic retry, or native-error fallback.
// Keep EMPTY_WRITER_LOCK_PYTHON byte-identical to the reviewed source: every
// owner's PlatformSetting sync record is read under the same BEGIN IMMEDIATE.
// Caller MUST pass the established complete owner/request/schema/status parser
// as assertNoSynchronousImageAdmissions; malformed/unknown rows fail closed.
// operationStage is fixed to manifest.stage + '/hd-release-safety-r03'; the SHA
// remains the original manifest bytes, never a derived network fenceView.
export const EMPTY_WRITER_DATABASE = '/data/video-api-debugger/var-lib/dev.db';
export const EMPTY_WRITER_LOCK_PROTOCOL = 'trace03-empty-writer-lock.v1';
export const EMPTY_WRITER_LOCK_LIMIT_MS = 20000;
export const EMPTY_WRITER_FENCE_LIMIT_MS = 8000;
const SYNC_PREFIX = 'image_sync_request_v1:';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The SQL allowlist is deliberately visible here: BEGIN IMMEDIATE, one SELECT,
// and ROLLBACK only. mode=rw cannot create a missing business database. No DML,
// schema initialization, business-state repair, or transaction commit exists.
export const EMPTY_WRITER_LOCK_PYTHON = String.raw`
import json, os, select, signal, sqlite3, stat, sys, time

DATABASE = '/data/video-api-debugger/var-lib/dev.db'
PREFIX = 'image_sync_request_v1:'
PROTOCOL = 'trace03-empty-writer-lock.v1'
parent, run_id, manifest_sha, token = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
started = time.monotonic()
deadline = started + 20.0
deadline_at = int(time.time() * 1000) + 20000
connection = None
acquired = False
reason = 'child-error'
failure = None
database_identity = None

class StopLease(BaseException):
    pass

def emit(event, **fields):
    value = dict(protocol=PROTOCOL, event=event, runId=run_id,
                 manifestSha256=manifest_sha, token=token, pid=os.getpid(), **fields)
    data = (json.dumps(value, separators=(',', ':'), ensure_ascii=True) + '\n').encode()
    view = memoryview(data)
    while view:
        written = os.write(1, view)
        view = view[written:]

def expired():
    return time.monotonic() >= deadline or os.getppid() != parent

def alarm(_signal, _frame):
    raise StopLease('watchdog')

def identity():
    if os.path.realpath(DATABASE) != DATABASE:
        raise RuntimeError('database-alias-refused')
    value = os.lstat(DATABASE)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise RuntimeError('database-not-single-regular-file')
    return dict(dev=str(value.st_dev), ino=str(value.st_ino))

signal.signal(signal.SIGALRM, alarm)
signal.setitimer(signal.ITIMER_REAL, 20.0)
try:
    if os.getppid() != parent:
        raise StopLease('parent-disconnected')
    before = identity()
    connection = sqlite3.connect('file:' + DATABASE + '?mode=rw', uri=True,
                                 timeout=2.0, isolation_level=None)
    # Interrupt long SQL at the same lease boundary, including a large SELECT.
    connection.set_progress_handler(lambda: 1 if expired() else 0, 1000)
    connection.execute('BEGIN IMMEDIATE')
    acquired = True
    if expired():
        raise StopLease('watchdog' if time.monotonic() >= deadline else 'parent-disconnected')
    database_identity = identity()
    if database_identity != before:
        raise RuntimeError('database-identity-changed')
    # Prove the database handle, not just a pathname sampled beside the lock.
    handles = []
    for name in os.listdir('/proc/self/fd'):
        try:
            fd_path = '/proc/self/fd/' + name
            if os.readlink(fd_path) == DATABASE:
                value = os.stat(fd_path)
                handles.append(dict(dev=str(value.st_dev), ino=str(value.st_ino)))
        except FileNotFoundError:
            pass
    if not handles or any(value != database_identity for value in handles):
        raise RuntimeError('database-open-handle-conflict')
    rows = [dict(key=row[0], value_json=row[1]) for row in connection.execute(
        'SELECT key, value_json FROM PlatformSetting WHERE substr(key, 1, ?) = ? ORDER BY key',
        (len(PREFIX), PREFIX)).fetchall()]
    if identity() != database_identity or expired():
        raise StopLease('identity-or-lease-changed')
    emit('lock-acquired', locked=True, released=False, database=DATABASE,
         databaseIdentity=database_identity, syncRows=rows, deadlineAt=deadline_at,
         acquiredAt=int(time.time() * 1000), holdLimitMs=20000, parentPid=parent)
    buffer = b''
    while True:
        if expired():
            reason = 'watchdog' if time.monotonic() >= deadline else 'parent-disconnected'
            break
        readable, _, _ = select.select([0], [], [], min(0.1, max(0, deadline-time.monotonic())))
        if not readable:
            continue
        data = os.read(0, 4096)
        if not data:
            reason = 'stdin-disconnected'
            break
        buffer += data
        if len(buffer) > 4096:
            reason = 'invalid-command'
            break
        if b'\n' in buffer:
            line, remainder = buffer.split(b'\n', 1)
            try:
                command = json.loads(line)
                valid = command == dict(protocol=PROTOCOL, command='rollback', token=token)
            except (ValueError, TypeError):
                valid = False
            reason = 'rollback-requested' if valid and not remainder.strip() else 'invalid-command'
            break
except StopLease as error:
    reason = str(error)
except BaseException as error:
    # Values and exception messages can contain business data; only expose type.
    failure = type(error).__name__
    reason = 'acquire-or-protocol-failed'
finally:
    rolled_back = not acquired
    closed = connection is None
    try:
        if connection is not None:
            connection.set_progress_handler(None, 0)
            if connection.in_transaction:
                connection.execute('ROLLBACK')
                rolled_back = True
            elif acquired:
                rolled_back = False  # Never infer a completed rollback.
    except BaseException as error:
        failure = type(error).__name__
    finally:
        if connection is not None:
            try:
                connection.close()
                closed = True
            except BaseException as error:
                failure = type(error).__name__
        # Closing SQLite also rolls back an uncommitted transaction. Without
        # the explicit ROLLBACK receipt the parent still reports unknown.
        signal.setitimer(signal.ITIMER_REAL, 0)
    try:
        emit('lock-released', acquired=acquired, locked=False if closed else 'unknown',
             released=bool(rolled_back and closed), rollbackCompleted=rolled_back,
             connectionClosed=closed, reason=reason, failure=failure,
             database=DATABASE, databaseIdentity=database_identity,
             finishedAt=int(time.time() * 1000))
    except (BrokenPipeError, OSError):
        pass  # Parent death must not retain the database lock for logging.
`;

function validateBinding({ manifest, manifestSha256, operationStage }) {
  assert.ok(manifest && typeof manifest === 'object');
  assert.equal(manifest.schema, 'rate-impl2-release.v1');
  assert.equal(manifest.database, EMPTY_WRITER_DATABASE, 'Native database override is forbidden');
  assert.match(manifest.runId, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
  assert.equal(manifest.stage, '/data/video-api-debugger/release-staging/' + manifest.runId);
  assert.equal(operationStage, path.join(manifest.stage, 'hd-release-safety-r03'));
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  return Object.freeze({ runId: manifest.runId, manifestSha256, operationStage });
}

function nativeAdapter(binding, token) {
  let descriptor;
  let receipt;
  return {
    kind: 'native', now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
    prepare() {
      assert.equal(process.platform, 'linux', 'Native empty-writer lock is Linux-only');
      assert.equal(process.getuid(), 0, 'Native release operation is root-only');
      let directory = binding.operationStage;
      while (directory !== '/') {
        const value = fs.lstatSync(directory);
        assert.ok(value.isDirectory() && !value.isSymbolicLink() && value.uid === 0 && !(value.mode & 0o022), 'Untrusted operation stage chain');
        assert.equal(fs.realpathSync(directory), directory);
        directory = path.dirname(directory);
      }
      receipt = path.join(binding.operationStage, 'empty-writer-lock-' + token + '.jsonl');
      descriptor = fs.openSync(receipt, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      const directoryFd = fs.openSync(binding.operationStage, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    },
    journal(event) {
      assert.ok(descriptor !== undefined);
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
      fs.fsyncSync(descriptor);
    },
    closeJournal() { if (descriptor !== undefined) { fs.closeSync(descriptor); descriptor = undefined; } },
    receipt: () => receipt,
    spawn(bindingValue, tokenValue) {
      return spawn('/usr/bin/python3', ['-I', '-u', '-c', EMPTY_WRITER_LOCK_PYTHON,
        String(process.pid), bindingValue.runId, bindingValue.manifestSha256, tokenValue], {
        cwd: bindingValue.operationStage, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      });
    },
  };
}

export class EmptyWriterLockError extends Error {
  constructor(message, evidence, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EmptyWriterLockError';
    this.evidence = evidence;
  }
}

// offlineAdapter is explicit and never selected as a native-error fallback.
// Its virtual fixed /data identity cannot widen the native path allowlist.
export function createBoundedEmptyWriterLock({ manifest, manifestSha256, operationStage, offlineAdapter } = {}) {
  const binding = validateBinding({ manifest, manifestSha256, operationStage });
  const token = randomUUID();
  if (offlineAdapter) assert.equal(offlineAdapter.kind, 'offline-empty-writer-protocol');
  const adapter = offlineAdapter || nativeAdapter(binding, token);
  let child, acquirePromise, releasePromise, resolveAcquire, rejectAcquire, resolveClose;
  let acquired, releasedPacket, closed = false, releaseRequested = false;
  let stdout = '', outputBytes = 0, leaseTimer, terminationTimer, finalTimer;
  const errors = [];
  const state = { started: false, locked: false, released: true, exitCode: null, exitSignal: null };
  const evidence = () => ({ protocol: EMPTY_WRITER_LOCK_PROTOCOL, ...binding, token,
    adapter: adapter.kind, database: EMPTY_WRITER_DATABASE, pid: child?.pid ?? null,
    ...state, everAcquired: Boolean(acquired || releasedPacket?.acquired),
    deadlineAt: acquired?.deadlineAt ?? null, releaseRequested,
    releaseReceipt: releasedPacket ? { ...releasedPacket } : null,
    receipt: adapter.receipt?.() ?? null, errors: [...errors],
    businessCompletionInferred: false });
  const journal = (event, fields = {}) => adapter.journal({ protocol: EMPTY_WRITER_LOCK_PROTOCOL,
    runId: binding.runId, manifestSha256: binding.manifestSha256, token,
    at: adapter.now(), event, ...fields });
  function finish(code, signal) {
    if (closed) return;
    closed = true;
    state.exitCode = code; state.exitSignal = signal;
    for (const timer of [leaseTimer, terminationTimer, finalTimer]) adapter.clearTimer(timer);
    state.locked = releasedPacket?.connectionClosed === true ? false : 'unknown';
    state.released = releasedPacket?.released === true && releasedPacket.rollbackCompleted === true
      && releasedPacket.connectionClosed === true && code === 0 && !signal && !errors.length ? true : 'unknown';
    try { journal('child-closed', { ...state, errors: [...errors] }); }
    catch { errors.push('journal-finalization-failed'); state.released = 'unknown'; }
    try { adapter.closeJournal(); } catch { errors.push('journal-close-failed'); state.released = 'unknown'; }
    if (!acquired) rejectAcquire?.(new EmptyWriterLockError('Empty writer lock was not acquired', evidence()));
    resolveClose?.(evidence());
  }
  function requestRelease(reason) {
    if (!child || closed || releaseRequested) return;
    releaseRequested = true;
    // A watchdog/disconnect may already have produced the rollback receipt.
    // Do not write into its closing pipe and turn a confirmed close into EPIPE.
    if (!releasedPacket) {
      try {
        child.stdin.end(JSON.stringify({ protocol: EMPTY_WRITER_LOCK_PROTOCOL, command: 'rollback', token }) + '\n');
      } catch { errors.push('rollback-pipe-unavailable'); child.stdin.destroy(); }
    }
    // Send the rollback before durable logging, so a slow receipt disk cannot
    // delay the actual release request. The child's own watchdog is separate.
    try { journal('rollback-requested', { reason }); } catch { errors.push('journal-release-failed'); }
    // No new transaction/retry: if the peer fails, terminate this exact child.
    // An exit without its rollback+close receipt remains explicitly unknown.
    terminationTimer = adapter.setTimer(() => {
      if (!closed) { errors.push('rollback-receipt-timeout'); child.kill('SIGTERM'); }
    }, 2000);
    finalTimer = adapter.setTimer(() => {
      if (!closed) { errors.push('child-exit-unconfirmed'); child.kill('SIGKILL'); finish(null, 'SIGKILL-unconfirmed'); }
    }, 3000);
  }
  function packet(line) {
    const value = JSON.parse(line);
    assert.equal(value.protocol, EMPTY_WRITER_LOCK_PROTOCOL);
    assert.equal(value.runId, binding.runId); assert.equal(value.manifestSha256, binding.manifestSha256);
    assert.equal(value.token, token); assert.equal(value.pid, child.pid);
    assert.equal(value.database, EMPTY_WRITER_DATABASE);
    if (value.event === 'lock-acquired') {
      assert.ok(!acquired && !releasedPacket && !releaseRequested);
      assert.equal(value.locked, true); assert.equal(value.released, false);
      assert.equal(value.parentPid, process.pid); assert.equal(value.holdLimitMs, EMPTY_WRITER_LOCK_LIMIT_MS);
      assert.ok(Number.isSafeInteger(value.deadlineAt) && value.deadlineAt > adapter.now()
        && value.deadlineAt <= adapter.now() + EMPTY_WRITER_LOCK_LIMIT_MS);
      assert.ok(value.databaseIdentity && /^[0-9]+$/.test(value.databaseIdentity.dev) && /^[0-9]+$/.test(value.databaseIdentity.ino));
      assert.ok(Array.isArray(value.syncRows));
      for (const row of value.syncRows) assert.ok(typeof row.key === 'string' && row.key.startsWith(SYNC_PREFIX) && typeof row.value_json === 'string');
      // Journal only a digest/count. Original settings values stay in memory.
      journal('lock-acquired', { pid: value.pid, databaseIdentity: value.databaseIdentity,
        deadlineAt: value.deadlineAt, rows: value.syncRows.length, rowsSha256: sha(JSON.stringify(value.syncRows)) });
      acquired = structuredClone(value);
      state.locked = true; state.released = false;
      resolveAcquire(Object.freeze(structuredClone(acquired)));
    } else {
      assert.equal(value.event, 'lock-released'); assert.ok(!releasedPacket);
      assert.ok(typeof value.acquired === 'boolean' && typeof value.released === 'boolean');
      assert.ok(typeof value.rollbackCompleted === 'boolean' && typeof value.connectionClosed === 'boolean');
      if (acquired) assert.deepEqual(value.databaseIdentity, acquired.databaseIdentity);
      journal('lock-released', { ...value, token });
      releasedPacket = structuredClone(value);
      state.locked = value.connectionClosed ? false : 'unknown';
      // Only close/exit confirms the complete protocol, not a partial stdout.
      state.released = 'unknown';
    }
  }
  function acquire() {
    if (acquirePromise) return acquirePromise;
    assert.ok(!releaseRequested, 'A released lock handle cannot be acquired');
    acquirePromise = new Promise((resolve, reject) => { resolveAcquire = resolve; rejectAcquire = reject; });
    releasePromise = new Promise(resolve => { resolveClose = resolve; });
    try {
      adapter.prepare();
      journal('spawn-intent', { database: EMPTY_WRITER_DATABASE, holdLimitMs: EMPTY_WRITER_LOCK_LIMIT_MS });
      state.started = true; state.locked = 'unknown'; state.released = 'unknown';
      child = adapter.spawn(binding, token);
      child.stdin.on('error', () => { if (!closed) { errors.push('stdin-pipe-failed'); requestRelease('stdin-pipe-failed'); } });
      child.stdout.on('data', data => {
        if (closed) return;
        outputBytes += data.length;
        if (outputBytes > 16 * 1024 * 1024) { errors.push('protocol-output-limit'); requestRelease('protocol-output-limit'); return; }
        stdout += data.toString('utf8');
        let end;
        while ((end = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
          try { packet(line); } catch { errors.push('invalid-or-unrecorded-protocol'); requestRelease('invalid-or-unrecorded-protocol'); }
        }
      });
      // Drain, but never record arbitrary Python stderr (possibly private).
      child.stderr.on('data', () => {});
      child.on('error', () => { errors.push('child-spawn-or-runtime-failed'); requestRelease('child-error'); });
      child.on('close', (code, signal) => {
        if (stdout.trim()) errors.push('truncated-protocol');
        finish(code, signal);
      });
      leaseTimer = adapter.setTimer(() => requestRelease('parent-lease-deadline'), EMPTY_WRITER_LOCK_LIMIT_MS);
    } catch (error) {
      errors.push('prepare-or-spawn-failed');
      if (child) requestRelease('setup-failed');
      else {
        state.started = false; state.locked = false; state.released = true;
        try { adapter.closeJournal(); } catch { errors.push('journal-close-failed'); }
        closed = true; rejectAcquire(new EmptyWriterLockError('Empty writer lock setup failed', evidence(), error)); resolveClose(evidence());
      }
    }
    return acquirePromise;
  }
  async function release() {
    if (!acquirePromise) { releaseRequested = true; return evidence(); }
    requestRelease('explicit-release');
    return releasePromise;
  }
  return Object.freeze({ acquire, release, evidence });
}

// callback is ONLY installation + verification of the exact Web network fence.
// Never put service stop/wait, candidate builds, or business SQL in this lease.
// External fence commands must honor signal and their own <=8s timeout. A JS
// Promise timeout cannot cancel arbitrary external work; its result is unknown.
export async function withEmptyWriterLock({ callback, assertNoSynchronousImageAdmissions, ...options }) {
  assert.equal(typeof callback, 'function'); assert.equal(typeof assertNoSynchronousImageAdmissions, 'function');
  const handle = createBoundedEmptyWriterLock(options);
  const adapter = options.offlineAdapter;
  const now = adapter?.now ?? Date.now, setTimer = adapter?.setTimer ?? setTimeout, clearTimer = adapter?.clearTimer ?? clearTimeout;
  const abort = new AbortController();
  let lock, timer, value, failure, callbackStarted = false, callbackSettled = false, callbackTimedOut = false;
  try {
    lock = await handle.acquire();
    // The lead's parser/zero-running assertion sees the rows read under THIS
    // write lock. A failure goes directly to finally; no network fence starts.
    const synchronous = assertNoSynchronousImageAdmissions(lock.syncRows);
    assert.ok(!synchronous || typeof synchronous.then !== 'function', 'Running-zero assertion must be synchronous');
    assert.equal(synchronous?.runningRequests, 0, 'Running-zero proof is required');
    assert.equal(handle.evidence().locked, true, 'Lease ended before network fence');
    assert.ok(now() < lock.deadlineAt, 'Lease deadline passed before network fence');
    const deadlineAt = Math.min(lock.deadlineAt, now() + EMPTY_WRITER_FENCE_LIMIT_MS);
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        callbackTimedOut = true;
        abort.abort(new Error('Web network fence callback deadline exceeded'));
        // Rollback begins immediately, without waiting for callback cleanup.
        void handle.release();
        reject(new Error('Web network fence callback exceeded its 8-second bound; fence outcome unknown'));
      }, Math.max(0, deadlineAt - now()));
    });
    const work = Promise.resolve().then(async () => {
      if (abort.signal.aborted) throw abort.signal.reason;
      callbackStarted = true;
      try { return await callback({ lock, signal: abort.signal, deadlineAt }); }
      finally { callbackSettled = true; }
    });
    value = await Promise.race([work, timeout]);
    assert.equal(handle.evidence().locked, true, 'Lease expired before fence proof completed');
  } catch (error) { failure = error; }
  finally {
    clearTimer(timer);
    abort.abort(failure ?? new Error('Empty writer lock callback finished'));
    const releaseEvidence = await handle.release();
    if (failure || releaseEvidence.released !== true) {
      throw new EmptyWriterLockError(failure?.message ?? 'Empty writer lock release is unconfirmed', {
        ...releaseEvidence, callbackStarted, callbackSettled, callbackTimedOut,
        fenceOutcome: callbackTimedOut || (callbackStarted && failure) ? 'unknown' : callbackStarted ? 'callback-returned' : 'not-started',
      }, failure);
    }
  }
  return { value, lock, releaseEvidence: handle.evidence() };
}

// Pure in-memory protocol fixtures. They NEVER spawn Python, touch SQLite/fs,
// run fence commands, or stand in for a native SQLite/process acceptance test.
export function createOfflineEmptyWriterLockAdapter() {
  let clock = 1700000000000, sequence = 0, child, binding, token, finished = false;
  const timers = new Map(), events = [];
  const setTimer = (callback, delay) => { const id = ++sequence; timers.set(id, { at: clock + delay, callback }); return id; };
  const clearTimer = id => timers.delete(id);
  const send = (event, fields) => child.stdout.write(JSON.stringify({ protocol: EMPTY_WRITER_LOCK_PROTOCOL,
    event, runId: binding.runId, manifestSha256: binding.manifestSha256, token, pid: child.pid,
    database: EMPTY_WRITER_DATABASE, ...fields }) + '\n');
  const end = reason => {
    if (finished || !child) return;
    finished = true;
    send('lock-released', { acquired: true, locked: false, released: true, rollbackCompleted: true,
      connectionClosed: true, databaseIdentity: { dev: '77', ino: '88' }, reason, failure: null, finishedAt: clock });
    queueMicrotask(() => child.emit('close', 0, null));
  };
  const adapter = {
    kind: 'offline-empty-writer-protocol', now: () => clock, setTimer, clearTimer,
    prepare() {}, journal: event => events.push(structuredClone(event)), closeJournal() {}, receipt: () => null,
    spawn(value, nonce) {
      assert.ok(!child, 'Each offline adapter is single-use'); binding = value; token = nonce;
      child = new EventEmitter(); child.pid = 424242;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const command = JSON.parse(bytes.toString());
        assert.deepEqual(command, { protocol: EMPTY_WRITER_LOCK_PROTOCOL, command: 'rollback', token });
        queueMicrotask(() => end('rollback-requested')); done();
      } });
      child.kill = signal => { finished = true; queueMicrotask(() => child.emit('close', null, signal)); return true; };
      setTimer(() => end('watchdog'), EMPTY_WRITER_LOCK_LIMIT_MS);
      queueMicrotask(() => send('lock-acquired', { locked: true, released: false,
        databaseIdentity: { dev: '77', ino: '88' }, syncRows: [], parentPid: process.pid,
        acquiredAt: clock, deadlineAt: clock + EMPTY_WRITER_LOCK_LIMIT_MS, holdLimitMs: EMPTY_WRITER_LOCK_LIMIT_MS }));
      return child;
    },
    disconnect: () => end('stdin-disconnected'),
    advance(milliseconds) {
      const target = clock + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]); clock = next[1].at; next[1].callback();
      }
      clock = target;
    },
    events,
  };
  return adapter;
}

export async function runEmptyWriterLockProtocolFixtures() {
  const manifest = { schema: 'rate-impl2-release.v1', runId: 'offline-lock-protocol', stage: '/data/video-api-debugger/release-staging/offline-lock-protocol', database: EMPTY_WRITER_DATABASE };
  const base = { manifest, manifestSha256: 'a'.repeat(64), operationStage: manifest.stage + '/hd-release-safety-r03' };
  const results = [];
  for (const scenario of ['disconnect', 'watchdog']) {
    const offlineAdapter = createOfflineEmptyWriterLockAdapter();
    const handle = createBoundedEmptyWriterLock({ ...base, offlineAdapter });
    const lock = await handle.acquire(); assert.deepEqual(lock.databaseIdentity, { dev: '77', ino: '88' });
    if (scenario === 'disconnect') offlineAdapter.disconnect(); else offlineAdapter.advance(EMPTY_WRITER_LOCK_LIMIT_MS);
    const released = await handle.release();
    assert.equal(released.released, true); assert.equal(released.locked, false);
    assert.equal(released.releaseReceipt.reason, scenario === 'disconnect' ? 'stdin-disconnected' : 'watchdog');
    results.push({ scenario, released: true, native: false });
  }
  for (const scenario of ['callback-failure', 'callback-timeout', 'running-nonzero']) {
    const offlineAdapter = createOfflineEmptyWriterLockAdapter(); let fenced = false;
    await assert.rejects(withEmptyWriterLock({ ...base, offlineAdapter,
      assertNoSynchronousImageAdmissions() { if (scenario === 'running-nonzero') throw new Error('running'); return { runningRequests: 0 }; },
      callback() {
        fenced = true;
        if (scenario === 'callback-failure') throw new Error('fixture-callback-failed');
        queueMicrotask(() => offlineAdapter.advance(EMPTY_WRITER_FENCE_LIMIT_MS));
        return new Promise(() => {});
      },
    }), error => {
      assert.ok(error instanceof EmptyWriterLockError); assert.equal(error.evidence.released, true);
      assert.equal(error.evidence.businessCompletionInferred, false);
      if (scenario === 'running-nonzero') { assert.equal(fenced, false); assert.equal(error.evidence.fenceOutcome, 'not-started'); }
      if (scenario === 'callback-timeout') { assert.equal(error.evidence.callbackTimedOut, true); assert.equal(error.evidence.fenceOutcome, 'unknown'); }
      return true;
    });
    results.push({ scenario, released: true, native: false });
  }
  return { schema: 'trace03-empty-writer-lock-offline-fixtures.v1', nativeDatabaseOpened: false, results };
}
