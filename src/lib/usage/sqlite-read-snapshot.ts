import type { Prisma } from '@prisma/client';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { traceMetadata } from '../performance/request-trace';

export type UsageSqlCell = string | number | bigint | null;
export type UsageSqlRow = Record<string, UsageSqlCell>;
export interface UsageSqlReader {
  query<T extends object = UsageSqlRow>(statement: Prisma.Sql): Promise<T[]>;
}

type Cell = ['n'] | ['i', string] | ['r', number] | ['t', string];
type FailureCode = 'USAGE_READ_ABORTED' | 'USAGE_READ_TIMEOUT' | 'USAGE_READ_PROTOCOL'
  | 'USAGE_READ_SQLITE' | 'USAGE_READ_PROCESS' | 'USAGE_READ_PARAMETER' | 'USAGE_READ_CLOSE';
const MAX_CAPTURE_MS = 120000;
const CLOSE_GRACE_MS = 1000;
const MIN_INTEGER = -(BigInt(1) << BigInt(63)), MAX_INTEGER = (BigInt(1) << BigInt(63)) - BigInt(1);

function failure(code: FailureCode): Error & { code: FailureCode } {
  const error = Object.assign(new Error(code), { code });
  if (code === 'USAGE_READ_ABORTED') error.name = 'AbortError';
  return error;
}
function integer(value: bigint): Cell {
  if (value < MIN_INTEGER || value > MAX_INTEGER) throw failure('USAGE_READ_PARAMETER');
  return ['i', value.toString()];
}
function parameter(value: unknown): Cell {
  if (value === null) return ['n'];
  if (typeof value === 'bigint') return integer(value);
  if (typeof value === 'string') return ['t', value];
  if (typeof value === 'boolean') return integer(value ? BigInt(1) : BigInt(0));
  if (value instanceof Date && Number.isFinite(value.getTime())) return integer(BigInt(value.getTime()));
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isInteger(value)) return ['r', value];
    if (Number.isSafeInteger(value)) return integer(BigInt(value));
  }
  throw failure('USAGE_READ_PARAMETER');
}
function cell(value: unknown): UsageSqlCell {
  if (!Array.isArray(value)) throw failure('USAGE_READ_PROTOCOL');
  const [tag, raw] = value;
  if (tag === 'n' && value.length === 1) return null;
  if (value.length !== 2) throw failure('USAGE_READ_PROTOCOL');
  if (tag === 't' && typeof raw === 'string') return raw;
  if (tag === 'r' && typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (tag === 'i' && typeof raw === 'string' && /^(0|-?[1-9]\d*)$/.test(raw)) {
    const parsed = BigInt(raw);
    if (parsed >= MIN_INTEGER && parsed <= MAX_INTEGER) return parsed;
  }
  throw failure('USAGE_READ_PROTOCOL');
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Deployment's WorkingDirectory is the versioned application root. Prisma resolves
// relative file URLs against that root's prisma/schema.prisma, not the Web cwd itself.
async function locations(): Promise<{ script: string; database: string }> {
  const appRoot = process.cwd(), schemaDirectory = path.join(appRoot, 'prisma');
  const script = path.join(appRoot, 'scripts/usage-sqlite-reader.py');
  await Promise.all([access(path.join(schemaDirectory, 'schema.prisma')), access(script)]);
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith('file:')) throw failure('USAGE_READ_PROCESS');
  const raw = url.slice(5).split('?')[0];
  const filename = raw.startsWith('//') ? fileURLToPath(`file:${raw}`) : decodeURIComponent(raw);
  if (!filename || filename === ':memory:' || filename.includes('\0')) throw failure('USAGE_READ_PROCESS');
  return { script, database: path.isAbsolute(filename) ? filename : path.resolve(schemaDirectory, filename) };
}

class SnapshotSession implements UsageSqlReader {
  readonly ready = deferred<string>();
  private readonly exited = deferred<void>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly started = performance.now();
  private readonly metadata = traceMetadata();
  private tail: Promise<void> = Promise.resolve();
  private pending: { id: number; result: ReturnType<typeof deferred<UsageSqlRow[]>>; rows: UsageSqlRow[] } | null = null;
  private sequence = 0;
  private error: unknown = null;
  private readyReceived = false;
  private closeRequested = false;
  private databaseClosed = false;
  private normalCloseReceived = false;
  private processClosed = false;
  private forced = false;
  private closeStarted: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private queries = 0;
  private frames = 0;
  private rows = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;

  constructor(script: string, database: string, dataAsOf?: string) {
    this.child = spawn('/usr/bin/python3', ['-u', script], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', PYTHONIOENCODING: 'utf-8' },
    });
    // Rejections are owned by ready/query/final cleanup; attach handlers before an early child failure.
    void this.ready.promise.catch(() => {});
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stdout.on('data', (bytes: Buffer) => { this.stdoutBytes += bytes.length; });
    this.child.stderr.on('data', (bytes: Buffer) => { this.stderrBytes += bytes.length; });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch { this.cancel(failure('USAGE_READ_PROTOCOL')); }
    });
    this.child.stdin.on('error', () => { if (!this.processClosed) this.cancel(failure('USAGE_READ_PROCESS')); });
    this.child.on('error', () => this.cancel(failure('USAGE_READ_PROCESS')));
    this.child.on('close', (code, signal) => {
      this.processClosed = true;
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
      if (!this.error && (code !== 0 || signal !== null || !this.databaseClosed || !this.normalCloseReceived || !this.closeRequested)) this.error = failure('USAGE_READ_CLOSE');
      const error = this.error || failure('USAGE_READ_PROCESS');
      this.ready.reject(error);
      this.pending?.result.reject(error);
      this.pending = null;
      this.log('child-close', { exitCode: code, signal, databaseClosed: this.databaseClosed, forced: this.forced,
        closeMs: this.closeStarted === null ? null : performance.now() - this.closeStarted,
        elapsedMs: performance.now() - this.started, queries: this.queries, frames: this.frames, rows: this.rows,
        stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes, code: this.safeErrorCode() });
      this.exited.resolve();
    });
    this.log('spawn', {});
    this.send({ type: 'open', database, dataAsOf });
  }

  private safeErrorCode() {
    const code = (this.error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^USAGE_READ_[A-Z_]+$/.test(code) ? code : this.error ? 'CAPTURE_FAILED' : null;
  }
  private log(event: string, fields: Record<string, unknown>) {
    try {
      console.error('[UsageReadSnapshot]', JSON.stringify({ ...this.metadata, event, ...fields,
        utc: new Date().toISOString(), mono: performance.now(), pid: process.pid, childPID: this.child.pid ?? null }));
    } catch { /* Diagnostics never change capture or release. */ }
  }
  private send(message: object) {
    if (!this.processClosed && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
      this.child.stdin.write(JSON.stringify(message) + '\n');
    }
  }
  private armCleanup() {
    if (this.cleanupTimer || this.processClosed) return;
    this.cleanupTimer = setTimeout(() => {
      if (this.processClosed) return;
      this.forced = true;
      this.child.kill('SIGTERM');
      this.cleanupTimer = setTimeout(() => { if (!this.processClosed) this.child.kill('SIGKILL'); }, CLOSE_GRACE_MS);
    }, CLOSE_GRACE_MS);
  }
  private receive(message: unknown) {
    if (!message || typeof message !== 'object') throw failure('USAGE_READ_PROTOCOL');
    const frame = message as Record<string, unknown>;
    if (frame.type === 'error') {
      const code = frame.code === 'CANCELLED' ? 'USAGE_READ_ABORTED' : frame.code === 'SQLITE_FAILED' ? 'USAGE_READ_SQLITE' : 'USAGE_READ_PROTOCOL';
      this.log('reader-error', { code, sqliteCode: typeof frame.sqliteCode === 'number' ? frame.sqliteCode : null });
      this.cancel(failure(code));
      return;
    }
    if (frame.type === 'closed') {
      if (!['normal', 'cancelled', 'failed'].includes(String(frame.reason))) throw failure('USAGE_READ_PROTOCOL');
      this.databaseClosed = frame.databaseClosed === true;
      this.normalCloseReceived = frame.reason === 'normal';
      if (!this.error && (!this.databaseClosed || !this.normalCloseReceived)) this.cancel(failure('USAGE_READ_CLOSE'));
      this.log('database-close', { databaseClosed: frame.databaseClosed === true, reason: frame.reason,
        closeMs: typeof frame.closeMs === 'number' ? frame.closeMs : null });
      return;
    }
    // Continue draining both pipes on failure, but discard all late business results.
    if (this.error) return;
    if (frame.type === 'ready') {
      if (this.readyReceived || typeof frame.dataAsOf !== 'string' || !Number.isFinite(Date.parse(frame.dataAsOf))) throw failure('USAGE_READ_PROTOCOL');
      this.readyReceived = true;
      this.log('ready', { openPinMs: frame.openPinMs, pythonVersion: frame.pythonVersion, sqliteVersion: frame.sqliteVersion });
      this.ready.resolve(frame.dataAsOf);
      return;
    }
    const pending = this.pending;
    if (!pending || frame.id !== pending.id) throw failure('USAGE_READ_PROTOCOL');
    if (frame.type === 'rows') {
      if (!Array.isArray(frame.columns) || !frame.columns.every(column => typeof column === 'string') || !Array.isArray(frame.rows) || frame.rows.length > 500) throw failure('USAGE_READ_PROTOCOL');
      const columns: string[] = frame.columns;
      for (const raw of frame.rows) {
        if (!Array.isArray(raw) || raw.length !== columns.length) throw failure('USAGE_READ_PROTOCOL');
        const row: UsageSqlRow = {};
        for (let index = 0; index < columns.length; index++) row[columns[index]] = cell(raw[index]);
        pending.rows.push(row);
      }
      this.frames++;
      return;
    }
    if (frame.type === 'done') {
      if (frame.rows !== pending.rows.length) throw failure('USAGE_READ_PROTOCOL');
      this.pending = null;
      this.queries++;
      this.rows += pending.rows.length;
      pending.result.resolve(pending.rows);
      return;
    }
    throw failure('USAGE_READ_PROTOCOL');
  }

  query<T extends object = UsageSqlRow>(statement: Prisma.Sql): Promise<T[]> {
    const result = this.tail.then(async () => {
      if (this.error || this.closeRequested || this.processClosed) {
        await this.exited.promise;
        throw this.error || failure('USAGE_READ_CLOSE');
      }
      let params: Cell[];
      try { params = statement.values.map(parameter); }
      catch (error) { this.cancel(error); await this.exited.promise; throw error; }
      const pending = { id: ++this.sequence, result: deferred<UsageSqlRow[]>(), rows: [] as UsageSqlRow[] };
      this.pending = pending;
      this.send({ type: 'query', id: pending.id, sql: statement.sql, params });
      return await pending.result.promise as T[];
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  cancel(error: unknown) {
    this.error ||= error instanceof Error ? error : failure('USAGE_READ_PROCESS');
    if (this.processClosed) return;
    if (this.closeStarted === null) {
      this.closeStarted = performance.now();
      this.log('cancel', { code: this.safeErrorCode() });
      this.send({ type: 'cancel' });
      this.child.stdin.end();
    }
    this.armCleanup();
  }
  captured(outcome: 'fulfilled' | 'rejected', elapsedMs: number) {
    this.log('capture-settled', { outcome, elapsedMs });
  }
  async finish() {
    await this.tail;
    if (!this.error && !this.processClosed) {
      this.closeRequested = true;
      this.closeStarted = performance.now();
      this.send({ type: 'close' });
      this.child.stdin.end();
      this.armCleanup();
    }
    await this.exited.promise;
    if (this.error) throw this.error;
  }
  async stop(error: unknown) {
    this.cancel(error);
    await this.exited.promise;
  }
}

export async function withUsageReadSnapshot<T>(capture: (reader: UsageSqlReader, dataAsOf: string) => Promise<T>,
  options: { signal?: AbortSignal; dataAsOf?: string; timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? MAX_CAPTURE_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CAPTURE_MS) throw failure('USAGE_READ_PARAMETER');
  if (options.dataAsOf !== undefined && !Number.isFinite(Date.parse(options.dataAsOf))) throw failure('USAGE_READ_PARAMETER');
  if (options.signal?.aborted) throw failure('USAGE_READ_ABORTED');
  const started = performance.now(), resolved = await locations();
  const session = new SnapshotSession(resolved.script, resolved.database, options.dataAsOf);
  const abort = () => session.cancel(failure('USAGE_READ_ABORTED'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => session.cancel(failure('USAGE_READ_TIMEOUT')), Math.max(0, timeoutMs - (performance.now() - started)));
  try {
    const dataAsOf = await session.ready.promise;
    const captureStarted = performance.now();
    let result: T;
    try {
      result = await capture(session, dataAsOf);
      session.captured('fulfilled', performance.now() - captureStarted);
    } catch (error) {
      session.captured('rejected', performance.now() - captureStarted);
      throw error;
    }
    await session.finish();
    return result;
  } catch (error) {
    // Await the actual capture unwind and child close; never race an active callback out of ownership.
    await session.stop(error);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
