// A reuse intent is a request to fill the composer, never a generation command.
// In particular, an unconfirmed POST must not become an automatic retry.
export type TaskReuseIntentPhase = 'waiting' | 'blocked' | 'confirming' | 'sending' | 'applying' | 'failed' | 'unknown' | 'done';

export type TaskReuseWorkspaceItem = { id: string; assetId: string; referenceImageId: string | null; role: string | null; sortOrder: number };
export type TaskReuseOperationRequest = { protocolVersion: 2; requestId: string; nonce: string; requestHash: string;
  surface: 'normal' | 'ip'; tabId: string; workspaceId: string; expectedWorkspaceAssets: TaskReuseWorkspaceItem[] };
export type TaskReuseOperationStatus = { protocolVersion: 2; requestId: string; nonce: string; requestHash: string;
  sourceTaskId: string; surface: 'normal' | 'ip'; tabId: string; workspaceId: string;
  status: 'applied' | 'rejected' | 'closed' | 'unknown'; canClose: boolean; code?: string; message?: string };
export function parseTaskReuseOperationRequest(value: unknown): TaskReuseOperationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as TaskReuseOperationRequest;
  const id = (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item);
  if (body.protocolVersion !== 2 || !id(body.requestId) || !id(body.nonce) || !/^[a-f0-9]{64}$/.test(body.requestHash || '')
    || !['normal', 'ip'].includes(body.surface) || !id(body.tabId) || body.tabId.length > 96 || !id(body.workspaceId)
    || !Array.isArray(body.expectedWorkspaceAssets) || body.expectedWorkspaceAssets.length > 80
    || body.expectedWorkspaceAssets.some(item => !item || !id(item.id) || !id(item.assetId)
      || item.referenceImageId !== null && !id(item.referenceImageId)
      || item.role !== null && (typeof item.role !== 'string' || item.role.length > 64)
      || !Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0 || item.sortOrder > 1000000)
    || new Set(body.expectedWorkspaceAssets.map(item => item.id)).size !== body.expectedWorkspaceAssets.length
    || new Set(body.expectedWorkspaceAssets.map(item => item.assetId)).size !== body.expectedWorkspaceAssets.length) return null;
  return { protocolVersion: 2, requestId: body.requestId, nonce: body.nonce, requestHash: body.requestHash,
    surface: body.surface, tabId: body.tabId, workspaceId: body.workspaceId,
    expectedWorkspaceAssets: body.expectedWorkspaceAssets.map(({ id, assetId, referenceImageId, role, sortOrder }) => ({ id, assetId, referenceImageId, role, sortOrder })) };
}
export function canonicalTaskReuseOperation(accountId: string, sourceTaskId: string, input: Omit<TaskReuseOperationRequest, 'requestHash'>) {
  return JSON.stringify([2, accountId, sourceTaskId, input.requestId, input.nonce, input.surface, input.tabId, input.workspaceId,
    [...input.expectedWorkspaceAssets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(item => [item.id, item.assetId, item.referenceImageId, item.role, item.sortOrder])]);
}
export async function buildTaskReuseOperationRequest(accountId: string, sourceTaskId: string,
  input: Pick<TaskReuseOperationRequest, 'surface' | 'tabId' | 'workspaceId' | 'expectedWorkspaceAssets'> & Partial<Pick<TaskReuseOperationRequest, 'requestId' | 'nonce'>>): Promise<TaskReuseOperationRequest> {
  const body = { ...input, protocolVersion: 2 as const, requestId: input.requestId || crypto.randomUUID(), nonce: input.nonce || crypto.randomUUID() };
  const bytes = new TextEncoder().encode(canonicalTaskReuseOperation(accountId, sourceTaskId, body));
  const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const parsed = parseTaskReuseOperationRequest({ ...body, requestHash });
  if (!parsed) throw new Error('复用现场无法安全保存，当前输入未改变');
  return parsed;
}

export interface TaskReuseIntent {
  taskId: string;
  accountId: string;
  fromUrl: boolean;
  phase: TaskReuseIntentPhase;
  editEpoch: number;
  context?: Pick<TaskReuseContext, 'workspaceBridgeKey' | 'tabId'> & Partial<Pick<TaskReuseContext, 'projectId' | 'videoCardId' | 'videoBranchId'>>;
  readRetried?: boolean;
  expiresAt?: number;
}

export type ComposerReuseReason = 'loading' | 'pending-attach' | 'uploading' | 'upload-failed' | 'read-error'
  | 'saving' | 'picker-open' | 'agent-running' | 'recovery-pending' | null;

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
  reason?: ComposerReuseReason;
  busy: boolean;
}

export interface ComposerReuseState {
  initializing: boolean;
  reason: ComposerReuseReason;
  editRevision: number;
}

export function captureTaskReuseScope(context: TaskReuseContext): NonNullable<TaskReuseIntent['context']> {
  return {
    workspaceBridgeKey: context.workspaceBridgeKey, tabId: context.tabId,
    ...(!context.initializing ? { projectId: context.projectId, videoCardId: context.videoCardId, videoBranchId: context.videoBranchId } : {}),
  };
}

const EXPLICIT_INTENT_KEY = 'sd2:task-reuse-explicit:v1';
const EXPLICIT_INTENT_TTL = 5 * 60 * 1000;

export interface TaskReuseNavigationIntent {
  token: string;
  taskId: string;
  accountId: string;
  tabId: string;
  target: string;
  expiresAt: number;
}

export function taskReuseNavigationTarget(url: URL): string {
  return JSON.stringify([url.pathname, ...['project_id', 'video_card_id', 'video_branch_id'].map(key => url.searchParams.get(key) || '')]);
}

export function validTaskReuseNavigationIntent(value: unknown, url: URL, accountId: string, tabId: string, now: number): value is TaskReuseNavigationIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<TaskReuseNavigationIntent>;
  return Boolean(intent.token && intent.token === url.searchParams.get('reuse_intent')
    && intent.taskId && intent.taskId === url.searchParams.get('reuse_task_id')
    && intent.accountId === accountId && intent.tabId === tabId
    && intent.target === taskReuseNavigationTarget(url)
    && typeof intent.expiresAt === 'number' && intent.expiresAt > now && intent.expiresAt <= now + EXPLICIT_INTENT_TTL);
}

// Session storage contains only a bounded explicit click, never inputs or a durable replay command.
export function issueTaskReuseNavigationIntent(url: URL, accountId: string): boolean {
  const taskId = url.searchParams.get('reuse_task_id');
  if (!taskId || !accountId || !['/generate', '/generate/ip'].includes(url.pathname)) return false;
  try {
    const tabId = readTaskReuseTabId(() => sessionStorage.getItem('workspace_tab_id'));
    if (!tabId) return false;
    const token = crypto.randomUUID();
    const intent: TaskReuseNavigationIntent = {
      token, taskId, accountId, tabId, target: taskReuseNavigationTarget(url), expiresAt: Date.now() + EXPLICIT_INTENT_TTL,
    };
    sessionStorage.setItem(EXPLICIT_INTENT_KEY, JSON.stringify(intent));
    url.searchParams.set('reuse_intent', token);
    return true;
  } catch { return false; }
}

export function claimTaskReuseNavigationIntent(url: URL, accountId: string, tabId: string): boolean {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(EXPLICIT_INTENT_KEY) || 'null');
    const valid = validTaskReuseNavigationIntent(value, url, accountId, tabId, Date.now());
    sessionStorage.removeItem(EXPLICIT_INTENT_KEY);
    return valid;
  } catch { return false; }
}

export function taskReuseReasonMessage(reason: ComposerReuseReason): string {
  switch (reason) {
    case 'pending-attach': return '素材加入参考区尚未完成，请在参考区核对或重试原操作；完成后会接着复用。';
    case 'uploading': return '参考素材正在上传，完成后会接着复用。';
    case 'upload-failed': return '参考素材上传失败，请在参考区处理失败项；完成后会接着复用。';
    case 'read-error': return '参考区读取失败，请重新读取；成功后会接着复用。';
    case 'saving': return '正在保存当前素材或设置，完成后会接着复用。';
    case 'agent-running': return '输入内容仍在生成，完成后会接着复用。';
    case 'picker-open': return '请先保存或关闭模板编辑，随后会接着复用。';
    case 'recovery-pending': return '原输入恢复尚未完成，请先在恢复入口核对原操作。';
    default: return '正在准备输入';
  }
}

// Legacy fences and versioned receipts are discovery records; this helper never replays either.
export function taskReuseReceiptKey(accountId: string, tabId: string, taskId: string): string {
  return `sd2:task-reuse-unconfirmed:v1:${JSON.stringify([accountId, tabId, taskId])}`;
}

export function unresolvedTaskReuseSource(accountId: string, tabId: string): string | null {
  const prefix = 'sd2:task-reuse-unconfirmed:v1:';
  for (const storage of [sessionStorage, localStorage]) for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix) || !storage.getItem(key)) continue;
    try {
      const scope: unknown = JSON.parse(key.slice(prefix.length));
      if (Array.isArray(scope) && scope.length === 3 && scope[0] === accountId && scope[1] === tabId
        && typeof scope[2] === 'string' && scope[2].length > 0 && scope[2].length <= 200) return scope[2];
    } catch { /* Other storage records are not reuse receipts. */ }
  }
  return null;
}

export function readTaskReuseTabId(read: () => string | null): string | null {
  try { return read() || 'default'; }
  catch { return null; }
}

export function transitionTaskReuseQuery(url: URL, taskId: string, target: 'unconfirmed' | 'retryable' | 'consumed'): boolean {
  const executable = url.searchParams.get('reuse_task_id');
  const unconfirmed = url.searchParams.get('reuse_unconfirmed_task_id');
  const source = url.searchParams.get('reuse_source_task_id');
  if (target === 'consumed') {
    if (executable !== taskId && unconfirmed !== taskId && source !== taskId) return false;
    if (executable === taskId) url.searchParams.delete('reuse_task_id');
    if (unconfirmed === taskId) url.searchParams.delete('reuse_unconfirmed_task_id');
    if (executable === taskId) url.searchParams.delete('reuse_intent');
    if (source === taskId) url.searchParams.delete('reuse_source_task_id');
    return true;
  }
  // A late result must never replace a different explicit source.
  if ((executable && executable !== taskId) || (unconfirmed && unconfirmed !== taskId)) return false;
  if (target === 'unconfirmed') {
    url.searchParams.delete('reuse_task_id');
    url.searchParams.delete('reuse_intent');
    url.searchParams.set('reuse_unconfirmed_task_id', taskId);
  } else {
    url.searchParams.delete('reuse_unconfirmed_task_id');
    url.searchParams.set('reuse_task_id', taskId);
  }
  return true;
}

export function taskReuseAutoAction(intent: TaskReuseIntent, context: TaskReuseContext, now = Date.now()): 'wait' | 'block' | 'apply' | 'none' {
  if (intent.phase !== 'waiting' || intent.accountId !== context.accountId) return 'none';
  if (intent.expiresAt !== undefined && intent.expiresAt <= now) return 'block';
  if (!context.tabId || context.conflict || intent.editEpoch !== context.editEpoch) return 'block';
  if (intent.context && (intent.context.workspaceBridgeKey !== context.workspaceBridgeKey || intent.context.tabId !== context.tabId)) return 'block';
  if (!context.initializing && intent.context && (['projectId', 'videoCardId', 'videoBranchId'] as const)
    .some(key => intent.context![key] !== undefined && intent.context![key] !== context[key])) return 'block';
  if (context.initializing || context.busy) return 'wait';
  return 'apply';
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
