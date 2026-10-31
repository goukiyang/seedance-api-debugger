import { studioOutputMismatchDisposition } from './image-studio/dimension-mismatch';

export type GenerationCompletionKind = 'images' | 'avatar' | 'batch';
export type GenerationCompletionHint = { moduleId?: string; baselineTaskIds?: string[] };
export type GenerationCompletionWatch = { owner: string; id: string; kind: GenerationCompletionKind; count: number;
  receipt: string; baselineSuccess: number; hint?: GenerationCompletionHint };
export type GenerationCompletionTarget = { key: string; owner: string; kind: GenerationCompletionKind; jobId: string;
  taskId: string; assetId: string; moduleId?: string };
export type GenerationCompletionRequest = GenerationCompletionTarget & { requestId: number; automatic: boolean };
type TaskOutput = { id?: string; status?: string; resultDisposition?: string | null; asset?: { id?: string; original_url?: string } | null };
type BatchOutput = { taskId?: string | null; ordinal?: number; image?: { id?: string; url?: string } | null };
type Observation = { tasks?: TaskOutput[]; batch?: { id?: string; moduleId?: string; state?: string;
  active?: number; pending?: number; uncertain?: number; generated?: number; total?: number; failed?: number; items?: BatchOutput[] } };

/** The authorized output URL, rather than a status label, is the completion evidence. */
export function observeGenerationCompletion(job: GenerationCompletionWatch, value: Observation) {
  const batch = value.batch;
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  const terminal = job.kind === 'batch'
    ? Boolean(batch && ['complete', 'cancelled'].includes(batch.state || '') && batch.active === 0 && batch.pending === 0 && batch.uncertain === 0)
    : tasks.length === job.count && tasks.every(task => ['succeeded', 'failed'].includes(task.status || ''));
  const outputs = job.kind === 'batch'
    ? (batch?.items || []).flatMap(item => item.taskId && item.image?.id && item.image.url ? [{ taskId: item.taskId, assetId: item.image.id }] : [])
    : tasks.flatMap(task => task.id && task.asset?.id && task.asset.original_url
      && (task.status === 'succeeded' || studioOutputMismatchDisposition(task.resultDisposition)) ? [{ taskId: task.id, assetId: task.asset.id }] : []);
  const expected = job.kind === 'batch' ? batch?.generated || 0 : tasks.filter(task => task.status === 'succeeded').length;
  const baseline = new Set(job.hint?.baselineTaskIds || []);
  const targets: GenerationCompletionTarget[] = outputs.filter(item => !baseline.has(item.taskId)).map(item => ({ ...item,
    key: `output:${item.taskId}:${item.assetId}`, owner: job.owner, kind: job.kind, jobId: job.id,
    ...(job.hint?.moduleId || batch?.moduleId ? { moduleId: job.hint?.moduleId || batch?.moduleId } : {}) }));
  return { terminal: terminal && outputs.length >= expected, targets,
    success: job.kind === 'batch' ? Boolean(batch && batch.generated === batch.total && batch.failed === 0) : tasks.every(task => task.status === 'succeeded') };
}

export function generationCompletionHref(target: GenerationCompletionTarget) {
  if (target.kind === 'avatar') return '/tools/avatar-studio';
  const query = new URLSearchParams({ type: 'image' });
  if (target.moduleId) query.set('moduleId', target.moduleId);
  return `/template-studio?${query}`;
}

export function completionCardIsVisible(card: HTMLElement) {
  if (!card.hasAttribute('data-result-ready') || !card.isConnected || card.closest('[hidden], [aria-hidden="true"]')) return false;
  const rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height || getComputedStyle(card).visibility === 'hidden') return false;
  const modal = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
  return !modal || modal.contains(card);
}

export function acknowledgeGenerationCompletion(targets: Map<string, GenerationCompletionTarget>, owner: string | null, key: string, taskId: string) {
  const target = targets.get(key);
  return Boolean(target && target.owner === owner && target.taskId === taskId && targets.delete(key));
}
