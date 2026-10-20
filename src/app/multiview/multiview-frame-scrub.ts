export type MultiviewScrubSession = {
  preview: (frame: number) => Promise<string | null>;
  displayed?: (frame: number) => void;
  commit: (frame: number) => boolean;
  cancel: () => void;
};

// One running preview and one replaceable target. Only the final readable target commits.
export function createMultiviewFrameScrub(session: MultiviewScrubSession, shown: (frame: number, url: string) => void,
  settled: (error?: string) => void) {
  let target: number | null = null;
  let ready: { frame: number; url: string } | null = null;
  let running = false;
  let ending = false;
  let stopped = false;
  function complete() {
    if (stopped || !ending || running || !ready || target !== ready.frame) return;
    stopped = true;
    const committed = session.commit(ready.frame);
    session.cancel();
    settled(committed ? undefined : '选帧现场已变化，原选择保持不变。');
  }
  async function pump() {
    if (running || stopped || target === null) return;
    if (ready?.frame === target) { complete(); return; }
    running = true;
    const frame = target;
    let url: string | null = null;
    try { url = await session.preview(frame); } catch { /* Failure preserves the original slot. */ }
    running = false;
    if (stopped) return;
    if (frame === target) {
      if (!url) {
        stopped = true; session.cancel(); settled('这一帧预览未就绪，原选择保持不变，请重试。'); return;
      }
      ready = { frame, url }; session.displayed?.(frame); shown(frame, url);
    }
    if (frame !== target) void pump(); else complete();
  }
  return {
    target(frame: number) { if (stopped || ending) return; target = frame; void pump(); },
    finish(frame: number) { if (stopped) return; ending = true; target = frame; void pump(); complete(); },
    cancel() { if (stopped) return; stopped = true; session.cancel(); settled(); },
  };
}
