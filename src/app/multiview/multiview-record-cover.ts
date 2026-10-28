import type { MultiviewRecord, MultiviewRecordCover } from '@/lib/video/multiview-records.server';

export type RecordCoverState = { phase: 'loading' | 'ready' | 'retryable' | 'missing' | 'denied' | 'refresh' | 'signed-out'; url?: string; kind?: MultiviewRecordCover['kind']; retryable?: boolean; refresh?: boolean; release?: () => void };
export function recordCoverFailure(status: number): RecordCoverState['phase'] {
  if (status === 401) return 'signed-out';
  if (status === 409) return 'refresh';
  if (status === 403) return 'denied';
  if (status === 404 || status === 410) return 'missing';
  return 'retryable';
}
/** A list-local two-read queue. No persistent media cache or authority is introduced. */
export function createRecordCoverReader() {
  let running = 0;
  let retainedBytes = 0;
  const budget = 64 * 1024 * 1024;
  const waiting: Array<() => void> = [];
  return async function read(item: MultiviewRecord, owner: string, signal: AbortSignal): Promise<RecordCoverState> {
    if (running >= 2) await new Promise<void>(resolve => waiting.push(resolve));
    running++;
    try {
      signal.throwIfAborted();
      const candidates: MultiviewRecordCover[] = item.cover?.candidates || (item.coverUrl ? [{ url: item.coverUrl, kind: 'video-frame' }] : []);
      let retryable = item.cover?.retryable === true, denied = false, refresh = false;
      for (const candidate of candidates) {
        signal.throwIfAborted();
        if (candidate.width && candidate.height && retainedBytes + candidate.width * candidate.height * 4 + (candidate.bytes || 0) > budget) { retryable = true; continue; }
        let url: string | undefined;
        try {
          const response = await fetch(candidate.url, { cache: 'no-store', credentials: 'same-origin', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            const reason = recordCoverFailure(response.status);
            if (reason === 'signed-out') return { phase: reason };
            retryable ||= reason === 'retryable'; denied ||= reason === 'denied'; refresh ||= reason === 'refresh';
            continue;
          }
          if (!response.headers.get('content-type')?.startsWith('image/') || !response.body) throw new Error('invalid_image');
          const chunks: Uint8Array[] = [], reader = response.body.getReader();
          let bytes = 0;
          try {
            while (true) {
              const next = await reader.read(); signal.throwIfAborted();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 32 * 1024 * 1024 || retainedBytes + bytes > budget) throw new Error('cover_too_large');
              chunks.push(next.value);
            }
          } finally { void reader.cancel().catch(() => {}); }
          if (!bytes) throw new Error('empty_image');
          const blob = new Blob(chunks as BlobPart[], { type: response.headers.get('content-type')!.split(';')[0] });
          url = URL.createObjectURL(blob);
          const image = new Image(); image.src = url;
          const cancelDecode = () => { image.src = ''; };
          signal.addEventListener('abort', cancelDecode, { once: true });
          try { await image.decode(); signal.throwIfAborted(); }
          finally { signal.removeEventListener('abort', cancelDecode); }
          if (!image.naturalWidth || !image.naturalHeight) throw new Error('invalid_image');
          const cost = bytes + image.naturalWidth * image.naturalHeight * 4;
          if (retainedBytes + cost > budget) throw new Error('cover_budget');
          retainedBytes += cost;
          const retainedUrl = url; let released = false;
          return { phase: 'ready', url, kind: candidate.kind, retryable, refresh, release: () => {
            if (released) return; released = true; retainedBytes -= cost; URL.revokeObjectURL(retainedUrl);
          } };
        } catch (error) {
          if (url) URL.revokeObjectURL(url);
          if (signal.aborted) throw error;
          retryable = true;
        }
      }
      return { phase: retryable ? 'retryable' : refresh ? 'refresh' : denied ? 'denied' : 'missing' };
    } finally { running--; waiting.shift()?.(); }
  };
}
