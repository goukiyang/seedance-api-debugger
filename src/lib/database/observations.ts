import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const scopes = ['unscoped', 'image-studio.shared', 'video-task.create', 'video-task.draft-upgrade', 'other'] as const;
type Scope = typeof scopes[number];
export type DatabaseCallCategory = 'interactive' | 'batch' | 'query' | 'initialization' | 'unknown';
export type DatabaseOutcome = 'succeeded' | 'failed' | 'unknown';
type Counters = { p1008: number; p2028: number; p2024: number; transactions: number; transactionMs: number; maxTransactionMs: number;
  succeeded: number; failed: number; outcomeUnknown: number };
export type DatabaseReporter = { id: string; pid: number; consumer: 'application-writer' | 'readonly' };
export type DatabaseMinute = { minute: string; p1008: number; transactions: number; transactionMs: number; maxTransactionMs: number;
  p2028?: number; p2024?: number; succeeded?: number; failed?: number; outcomeUnknown?: number;
  reporter?: DatabaseReporter; dimensions?: Array<Counters & { scope: Scope; category: DatabaseCallCategory }> };
type Minute = DatabaseMinute & Counters & { dimensions: NonNullable<DatabaseMinute['dimensions']> };
type State = { minutes: Map<string, Minute>; seen: WeakSet<object>; timer?: ReturnType<typeof setTimeout>; writer: boolean; active: number; flushing: boolean;
  context: AsyncLocalStorage<Scope>; reporter: DatabaseReporter };
const key = Symbol.for('video-api.database-observations.v1');
const globals = globalThis as typeof globalThis & { [key]?: State };
const state = globals[key] ||= { minutes: new Map(), seen: new WeakSet(), writer: false, active: 0, flushing: false,
  context: new AsyncLocalStorage<Scope>(), reporter: { id: randomUUID(), pid: process.pid,
    consumer: process.env.SD2_DATABASE_MODE === 'readonly' ? 'readonly' : 'application-writer' } };
const normalizeScope = (scope: string): Scope => scopes.includes(scope as Scope) ? scope as Scope : 'other';
const callCategory = (category: string): DatabaseCallCategory => ['interactive', 'batch', 'query', 'initialization'].includes(category) ? category as DatabaseCallCategory : 'unknown';
const counters = (): Counters => ({ p1008: 0, p2028: 0, p2024: 0, transactions: 0, transactionMs: 0, maxTransactionMs: 0, succeeded: 0, failed: 0, outcomeUnknown: 0 });

// Metrics context only. Never stores or selects a database/transaction client.
export function withDatabaseObservationScope<T>(scope: string, work: () => T): T {
  return state.context.run(normalizeScope(scope), work);
}
function minute(now = Date.now()) {
  const at = new Date(Math.floor(now / 60000) * 60000).toISOString();
  if (!state.minutes.has(at)) state.minutes.set(at, { minute: at, ...counters(), dimensions: [] });
  while (state.minutes.size > 60) state.minutes.delete(state.minutes.keys().next().value!);
  return state.minutes.get(at)!;
}
function dimension(row: Minute, scope: Scope, category: DatabaseCallCategory) {
  let value = row.dimensions.find(item => item.scope === scope && item.category === category);
  if (!value) { value = { scope, category, ...counters() }; row.dimensions.push(value); }
  return value;
}
function schedule() {
  if (!state.writer || state.timer || state.flushing) return;
  state.timer = setTimeout(() => state.context.run('unscoped', () => {
    state.timer = undefined;
    if (state.active) { schedule(); return; }
    state.flushing = true;
    // This callback is outside transaction callbacks. Diagnostics never enable it.
    void import('./alerts').then(module => module.flushDatabaseAlerts(databaseObservations().minutes))
      .catch(() => {}).finally(() => { state.flushing = false; if (state.minutes.size) schedule(); });
  }), 60000 - Date.now() % 60000 + 20);
  state.timer.unref?.();
}
export function databaseWriterReady() { state.writer = true; schedule(); }
export function databaseTransactionStarted() { state.active++; return state.context.getStore() || 'unscoped'; }
export function databaseTransactionFinished(durationMs: number, outcome: DatabaseOutcome = 'unknown', category: DatabaseCallCategory = 'unknown', scope?: string) {
  state.active = Math.max(0, state.active - 1);
  const row = minute(), elapsed = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  for (const value of [row, dimension(row, scope ? normalizeScope(scope) : state.context.getStore() || 'unscoped', callCategory(category))]) {
    value.transactions++; value.transactionMs += elapsed; value.maxTransactionMs = Math.max(value.maxTransactionMs, elapsed);
    if (outcome === 'succeeded') value.succeeded++; else if (outcome === 'failed') value.failed++; else value.outcomeUnknown++;
  }
  schedule();
}
export function observeDatabaseError(error: unknown, category: DatabaseCallCategory = 'query') {
  if (!error || typeof error !== 'object' || state.seen.has(error)) return;
  const code = (error as { code?: string }).code;
  if (code !== 'P1008' && code !== 'P2028' && code !== 'P2024') return;
  state.seen.add(error);
  const row = minute(), field = code === 'P1008' ? 'p1008' : code === 'P2028' ? 'p2028' : 'p2024';
  row[field]++; dimension(row, state.context.getStore() || 'unscoped', callCategory(category))[field]++; schedule();
}
export function databaseObservations() {
  for (const at of state.minutes.keys()) if (Date.parse(at) < Date.now() - 60 * 60000) state.minutes.delete(at);
  return { scope: 'process' as const, reporter: { ...state.reporter }, retentionMinutes: 60, slowTransactionMs: 1000,
    transactionScope: 'explicit_prisma_transaction' as const,
    durationScope: 'prisma_call_wall_ms_including_queue_execution_and_failure_excluding_initialization' as const,
    heldLockTimeMeasured: false as const, categoryLimit: 5, scopeLimit: scopes.length,
    minutes: [...state.minutes.values()].map(row => ({ ...row, reporter: { ...state.reporter }, dimensions: row.dimensions.map(item => ({ ...item })) })) };
}
