type Job = { run: () => Promise<boolean>; resolve: (value: boolean) => void; promise: Promise<boolean>; priority: boolean };

/** One extraction at a time; replacing background targets never cancels shared work already running. */
export function createMultiviewOriginalQueue() {
  const pending = new Map<number, Job>();
  let active: { frame: number; job: Job; retired?: boolean } | null = null;
  let targets = new Set<number>();
  let paused = false;
  const pump = () => {
    if (active) return;
    const next = Array.from(pending).find(([, job]) => job.priority)
      || (!paused ? Array.from(pending).find(([frame]) => targets.has(frame)) : undefined);
    if (!next) return;
    const [frame, job] = next;
    pending.delete(frame); active = { frame, job };
    void job.run().catch(() => false).then(job.resolve).finally(() => { active = null; pump(); });
  };
  return {
    request(frame: number, run: Job['run'], priority: boolean) {
      if (active?.frame === frame && !active.retired) return active.job.promise;
      const existing = pending.get(frame);
      if (existing) { existing.priority ||= priority; pump(); return existing.promise; }
      let resolve!: Job['resolve'];
      const promise = new Promise<boolean>(done => { resolve = done; });
      pending.set(frame, { run, resolve, promise, priority }); pump(); return promise;
    },
    background(frames: number[], pause = false) {
      targets = new Set(frames); paused = pause;
      for (const [frame, job] of Array.from(pending)) if (!job.priority && !targets.has(frame)) { pending.delete(frame); job.resolve(false); }
      pump();
    },
    clear() {
      targets.clear(); paused = true;
      if (active) active.retired = true;
      for (const job of Array.from(pending.values())) job.resolve(false);
      pending.clear();
    },
  };
}
