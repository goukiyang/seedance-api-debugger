import { release } from '@/lib/release';

export type VideoSubmissionPhase = 'preparing' | 'request_sent' | 'response_received' | 'response_decoded' | 'receipt_saved' | 'lookup_started' | 'task_observed' | 'handler_finished' | 'ui_idle';

export function markVideoSubmission(requestId: string | undefined, phase: VideoSubmissionPhase) {
  if (requestId) performance.mark(`sd2:video-submit:${phase}`, { detail: { requestId, phase, version: release.version } });
}

// This observer owns only a read request; stopping it never aborts the generation POST.
export function observePendingVideoSubmission(probe: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const timer = setTimeout(() => { void probe(controller.signal).catch(() => undefined); }, 10_000);
  return () => { clearTimeout(timer); controller.abort(); };
}
