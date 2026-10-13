// A reuse intent is a request to fill the composer, never a generation command.
// In particular, an unconfirmed POST must not become an automatic retry.
export type TaskReuseIntentPhase = 'waiting' | 'blocked' | 'confirming' | 'sending' | 'applying' | 'failed' | 'unknown' | 'done';

export interface TaskReuseIntent {
  taskId: string;
  accountId: string;
  fromUrl: boolean;
  phase: TaskReuseIntentPhase;
  editEpoch: number;
}

export interface TaskReuseContext {
  accountId: string | null;
  workspaceBridgeKey: string;
  tabId: string; // Empty only when the tab cannot be read; it is never a usable fallback.
  projectId: string;
  videoCardId: string;
  videoBranchId: string;
  editEpoch: number;
  initializing: boolean;
  conflict: string | null;
  busy: boolean;
}

export interface ComposerReuseState {
  initializing: boolean;
  conflict: boolean;
  editRevision: number;
}

// Only an unresolved result fence is stored, never the input or a replayable command.
export function taskReuseReceiptKey(accountId: string, tabId: string, taskId: string): string {
  return `sd2:task-reuse-unconfirmed:v1:${JSON.stringify([accountId, tabId, taskId])}`;
}

export function readTaskReuseTabId(read: () => string | null): string | null {
  try { return read() || 'default'; }
  catch { return null; }
}

export function transitionTaskReuseQuery(url: URL, taskId: string, target: 'unconfirmed' | 'retryable' | 'consumed'): boolean {
  const executable = url.searchParams.get('reuse_task_id');
  const unconfirmed = url.searchParams.get('reuse_unconfirmed_task_id');
  if (target === 'consumed') {
    if (executable !== taskId && unconfirmed !== taskId) return false;
    if (executable === taskId) url.searchParams.delete('reuse_task_id');
    if (unconfirmed === taskId) url.searchParams.delete('reuse_unconfirmed_task_id');
    return true;
  }
  // A late result must never replace a different explicit source.
  if ((executable && executable !== taskId) || (unconfirmed && unconfirmed !== taskId)) return false;
  if (target === 'unconfirmed') {
    url.searchParams.delete('reuse_task_id');
    url.searchParams.set('reuse_unconfirmed_task_id', taskId);
  } else {
    url.searchParams.delete('reuse_unconfirmed_task_id');
    url.searchParams.set('reuse_task_id', taskId);
  }
  return true;
}

export function taskReuseAutoAction(intent: TaskReuseIntent, context: TaskReuseContext): 'wait' | 'block' | 'confirm' | 'none' {
  if (intent.phase !== 'waiting' || intent.accountId !== context.accountId) return 'none';
  if (!context.tabId || context.conflict || intent.editEpoch !== context.editEpoch) return 'block';
  if (context.initializing || context.busy) return 'wait';
  return 'confirm';
}

export function taskReuseContextMatches(captured: TaskReuseContext, current: TaskReuseContext): boolean {
  return !current.busy
    && Boolean(captured.tabId && current.tabId)
    && !current.initializing
    && !current.conflict
    && captured.accountId === current.accountId
    && captured.workspaceBridgeKey === current.workspaceBridgeKey
    && captured.tabId === current.tabId
    && captured.projectId === current.projectId
    && captured.videoCardId === current.videoCardId
    && captured.videoBranchId === current.videoBranchId
    && captured.editEpoch === current.editEpoch;
}

export function shouldConsumeTaskReuseQuery(outcome: 'applied' | 'cancelled' | 'unrecoverable' | 'waiting' | 'failed' | 'unknown'): boolean {
  return outcome === 'applied' || outcome === 'cancelled' || outcome === 'unrecoverable';
}
