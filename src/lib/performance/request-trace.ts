import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TRACE_ID_HEADER, TRACE_START_HEADER, TRACE_OPERATIONS, TRACE_PHASES,
  type TraceOperation, type TracePhase } from './trace-contract';

type Context = { requestId: string | null; txId: string | null; operation: TraceOperation | null; phase: TracePhase | null };
type HeaderReader = { get(name: string): string | null };
const key = Symbol.for('sd2.request-trace.v1');
const processState = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<Context> };
// Next's separately bundled routes must share this context within one process.
const context = processState[key] ??= new AsyncLocalStorage<Context>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const classes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError', 'PrismaClientInitializationError', 'PrismaClientValidationError', 'PrismaClientRustPanicError']);
const codes = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1017', 'P2002', 'P2003', 'P2024', 'P2025', 'P2028', 'P2034']);
const rounded = (value: number) => Math.round(value * 10) / 10;

export function traceMetadata() {
  const current = context.getStore(), epochMs = Date.now();
  return { requestId: current?.requestId ?? null, txId: current?.txId ?? null,
    op: current?.operation ?? null, phase: current?.phase ?? null,
    at: new Date(epochMs).toISOString(), epochMs, mono: rounded(performance.now()), pid: process.pid };
}

// Observation failures must never change a response, callback result or thrown value.
function log(event: string, values: Record<string, unknown>, error?: unknown) {
  try {
    const failure = error as { name?: unknown; code?: unknown } | null;
    const errorClass = error === undefined ? undefined : typeof failure?.name === 'string' && classes.has(failure.name) ? failure.name : 'Error';
    const errorCode = typeof failure?.code === 'string' && codes.has(failure.code) ? failure.code : undefined;
    console.info('[RequestTrace]', JSON.stringify({ ...traceMetadata(), event, ...values, errorClass, errorCode }));
  } catch { /* Logging is not part of the business operation. */ }
}

async function request<T>(operation: TraceOperation, headers: HeaderReader, run: () => Promise<T>, http: boolean): Promise<T> {
  const started = performance.now(), epochMs = Date.now();
  let loop: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  try { loop = performance.eventLoopUtilization(); } catch { /* Optional runtime measurement. */ }
  let requestId: string = randomUUID(), requestStartEpochMs = epochMs;
  try {
    const forwarded = headers.get(TRACE_ID_HEADER), start = headers.get(TRACE_START_HEADER);
    if (forwarded && uuid.test(forwarded)) requestId = forwarded.toLowerCase();
    if (start && /^\d{13}$/.test(start) && Number(start) <= epochMs && epochMs - Number(start) <= 86400000) requestStartEpochMs = Number(start);
  } catch { /* Missing or unreadable request headers use a new server identity. */ }
  const store: Context = { requestId, txId: null, operation: TRACE_OPERATIONS.includes(operation) ? operation : null, phase: null };
  return context.run(store, async () => {
    let status: number | undefined, failed = false, failure: unknown;
    try {
      const result = await run();
      if (http) {
        const response = result as Response;
        status = response.status;
        try { response.headers.set(TRACE_ID_HEADER, requestId); } catch { /* Middleware also supplies the response ID. */ }
      }
      return result;
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      // This process-wide window includes unrelated work; it is not request CPU time.
      let processWindow: Record<string, unknown> = {};
      try {
        if (loop) {
          const delta = performance.eventLoopUtilization(loop);
          processWindow = { eventLoopScope: 'process-window', eventLoopUtilization: rounded(delta.utilization),
            eventLoopActiveMs: rounded(delta.active), eventLoopIdleMs: rounded(delta.idle) };
        }
      } catch { /* Optional runtime measurements cannot alter request results. */ }
      log(failed ? 'request-threw' : http ? 'response-ready' : 'server-complete', {
        status, requestStartEpochMs, handlerEnteredEpochMs: epochMs, elapsedMs: rounded(performance.now() - started), ...processWindow,
      }, failed ? failure : undefined);
    }
  });
}

export function traceHttpRequest(operation: TraceOperation, headers: HeaderReader, run: () => Promise<Response>): Promise<Response> {
  return request(operation, headers, run, true);
}
export function traceServerRequest<T>(operation: TraceOperation, headers: HeaderReader, run: () => Promise<T>): Promise<T> {
  return request(operation, headers, run, false);
}
export function tracePhase<T>(phase: TracePhase, run: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (!parent || !TRACE_PHASES.includes(phase)) return run();
  const started = performance.now();
  return context.run({ ...parent, phase }, async () => {
    let failed = false, failure: unknown;
    try { return await run(); }
    catch (error) { failed = true; failure = error; throw error; }
    finally { log('phase-settled', { outcome: failed ? 'rejected' : 'fulfilled', elapsedMs: rounded(performance.now() - started) }, failed ? failure : undefined); }
  });
}

/** Observe the original transaction call. No callback means entry/body are unknown. */
export function observeTransaction<T>(kind: 'callback' | 'batch' | 'implicit',
  run: (enter: <R>(body: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
  const parent = context.getStore(), requestedMono = performance.now(), requestedEpochMs = Date.now();
  const store: Context = { requestId: parent?.requestId ?? null, txId: randomUUID(), operation: parent?.operation ?? null, phase: parent?.phase ?? null };
  return context.run(store, async () => {
    let enteredMono: number | null = null, bodyEndMono: number | null = null;
    let enteredEpochMs: number | null = null, bodyEndEpochMs: number | null = null;
    let failed = false, failure: unknown;
    const enter = async <R>(body: () => Promise<R>) => {
      enteredMono = performance.now(); enteredEpochMs = Date.now();
      try { return await body(); }
      finally { bodyEndMono = performance.now(); bodyEndEpochMs = Date.now(); }
    };
    try { return await run(enter); }
    catch (error) { failed = true; failure = error; throw error; }
    finally {
      const settledMono = performance.now();
      log('transaction-settled', { kind, outcome: failed ? 'rejected' : 'fulfilled', requestedEpochMs, enteredEpochMs,
        bodyEndEpochMs, settledEpochMs: Date.now(), elapsedMs: rounded(settledMono - requestedMono),
        entryMs: enteredMono === null ? null : rounded(enteredMono - requestedMono),
        bodyMs: enteredMono === null || bodyEndMono === null ? null : rounded(bodyEndMono - enteredMono),
        settleMs: bodyEndMono === null ? null : rounded(settledMono - bodyEndMono),
        entryScope: 'pool-lock-scheduling', settleScope: 'callback-end-to-promise-settled',
      }, failed ? failure : undefined);
    }
  });
}
