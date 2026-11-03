/** One heavy media slot inside the existing cross-release flock owner. */
export class WorkMediaScheduler {
  private active: { kind: 'multiview' | 'preview'; abort: AbortController; done: Promise<void>; release: () => void } | null = null;
  private multiviewWaiting = false;

  private claim(kind: 'multiview' | 'preview') {
    let complete!: () => void;
    const slot = { kind, abort: new AbortController(), done: new Promise<void>(resolve => { complete = resolve; }), release: () => {} };
    slot.release = () => {
      if (this.active === slot) this.active = null;
      complete();
    };
    this.active = slot;
    return slot;
  }

  /** Call only after a real saved output or render intent has been selected. */
  async acquireMultiview() {
    this.multiviewWaiting = true;
    try {
      if (this.active) {
        if (this.active.kind === 'preview') this.active.abort.abort();
        await this.active.done;
      }
      const slot = this.claim('multiview');
      return slot.release;
    } finally { this.multiviewWaiting = false; }
  }

  async preview<T extends { state: string }>(process: (signal: AbortSignal) => Promise<T>): Promise<T | { state: 'paused' }> {
    if (this.active || this.multiviewWaiting) return { state: 'paused' };
    const slot = this.claim('preview');
    try { return await process(slot.abort.signal); }
    finally { slot.release(); }
  }
}
