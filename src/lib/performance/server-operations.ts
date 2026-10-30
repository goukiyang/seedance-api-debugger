type Operation = 'studio.tasks' | 'studio.active' | 'studio.gallery' | 'studio.shared-read' | 'assets.picker' | 'assets.library' | 'usage.report' | 'studio.claim' | 'hd.synchronize';
type Measurements = { rows?: number; bytes?: number; queueMs?: number; transactionWaitMs?: number; bodyMs?: number; scanned?: number };
const counters = new Map<Operation, number>();

/** Fixed operation labels only. Never include identities, prompts or URLs. */
export function observeOperation(operation: Operation) {
  const started = performance.now();
  return (measurements: Measurements = {}) => {
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    const count = (counters.get(operation) || 0) + 1;
    counters.set(operation, count % 64);
    if (elapsedMs < 500 && count % 64 !== 1) return;
    const safe = Object.fromEntries(Object.entries(measurements).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      .map(([key, value]) => [key, Math.round(value! * 10) / 10]));
    console.info('[Capacity]', JSON.stringify({ operation, elapsedMs, ...safe }));
  };
}
