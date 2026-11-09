import { traceMetadata } from '@/lib/performance/request-trace';

type Waiter = { start: () => void };
type Admission = { active: boolean; waiting: Waiter[] };
const key = Symbol.for('sd2.usage-report-admission.v1');
const processState = globalThis as typeof globalThis & { [key]?: Admission };
// Next overview, records and export bundles must share the same process slot.
const admission = processState[key] ??= { active: false, waiting: [] };

export class UsageReportBusyError extends Error {
  readonly status = 429;
  constructor() { super('报表正在处理其他读取，请稍后重试当前条件；已有结果仍保留。'); }
}
const aborted = () => Object.assign(new Error('Usage read interrupted'), { name: 'AbortError' });

/** One capture+fold runs per Web process, with one cancellable FIFO waiter.
 * The returned snapshot owns CSV disposal; delivery never holds this slot.
 */
export function withUsageReportAdmission<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted());
  if (admission.active && admission.waiting.length >= 1) return Promise.reject(new UsageReportBusyError());
  const requestedAt = performance.now();
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queued = false;
    const clean = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const remove = () => { admission.waiting.splice(admission.waiting.indexOf(waiter), 1); queued = false; clean(); };
    const cancel = () => { if (queued) { remove(); reject(aborted()); } };
    const release = () => { admission.active = false; admission.waiting.shift()?.start(); };
    const waiter: Waiter = { start() {
      queued = false; clean(); admission.active = true;
      if (signal?.aborted) { release(); reject(aborted()); return; }
      try { console.info('[UsageReportAdmission]', JSON.stringify({ ...traceMetadata(), scope: 'process-capture-fold',
        queueMs: Math.round((performance.now() - requestedAt) * 10) / 10, waiting: admission.waiting.length })); }
      catch { /* Observation cannot change admission. */ }
      Promise.resolve().then(run).then(value => { release(); resolve(value); }, error => { release(); reject(error); });
    } };
    if (!admission.active) waiter.start();
    else {
      queued = true; admission.waiting.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { if (queued) { remove(); reject(new UsageReportBusyError()); } }, 10000);
    }
  });
}
