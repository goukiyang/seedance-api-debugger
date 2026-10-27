export type DatabaseMinute = { minute: string; p1008: number; transactions: number; transactionMs: number; maxTransactionMs: number };
type State = { minutes: Map<string, DatabaseMinute>; seen: WeakSet<object>; timer?: ReturnType<typeof setTimeout>; writer: boolean; active: number; flushing: boolean };
const key = Symbol.for('video-api.database-observations.v1');
const globals = globalThis as typeof globalThis & { [key]?: State };
const state = globals[key] ||= { minutes: new Map(), seen: new WeakSet(), writer: false, active: 0, flushing: false };
function minute(now = Date.now()) {
  const at = new Date(Math.floor(now / 60000) * 60000).toISOString();
  if (!state.minutes.has(at)) state.minutes.set(at, { minute: at, p1008: 0, transactions: 0, transactionMs: 0, maxTransactionMs: 0 });
  while (state.minutes.size > 60) state.minutes.delete(state.minutes.keys().next().value!);
  return state.minutes.get(at)!;
}
function schedule() {
  if (!state.writer || state.timer || state.flushing) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (state.active) { schedule(); return; }
    state.flushing = true;
    // This callback is outside transaction callbacks. Diagnostics never enable it.
    void import('./alerts').then(module => module.flushDatabaseAlerts(databaseObservations().minutes))
      .catch(() => {}).finally(() => { state.flushing = false; if (state.minutes.size) schedule(); });
  }, 60000 - Date.now() % 60000 + 20);
  state.timer.unref?.();
}
export function databaseWriterReady() { state.writer = true; schedule(); }
export function databaseTransactionStarted() { state.active++; }
export function databaseTransactionFinished(durationMs: number) {
  state.active--;
  const row = minute(); row.transactions++; row.transactionMs += Math.max(0, Math.round(durationMs));
  row.maxTransactionMs = Math.max(row.maxTransactionMs, Math.max(0, Math.round(durationMs))); schedule();
}
export function observeDatabaseError(error: unknown) {
  if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'P1008' || state.seen.has(error)) return;
  state.seen.add(error); minute().p1008++; schedule();
}
export function databaseObservations() {
  for (const at of state.minutes.keys()) if (Date.parse(at) < Date.now() - 60 * 60000) state.minutes.delete(at);
  return { scope: 'process' as const, retentionMinutes: 60, slowTransactionMs: 1000,
    transactionScope: 'explicit_prisma_transaction' as const,
    minutes: [...state.minutes.values()].map(row => ({ ...row })) };
}
