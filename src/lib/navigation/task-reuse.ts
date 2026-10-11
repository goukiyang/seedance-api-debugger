import type { GenerationMode } from '@/types';
import { sanitizeOptionalReturnTo } from './return-to';

const GENERATION_MODES = new Set<GenerationMode>([
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
]);

type TaskReuseSource = {
  id?: unknown;
  provider?: unknown;
  generation_mode?: unknown;
  generationMode?: unknown;
  project_id?: unknown;
  projectId?: unknown;
  video_card_id?: unknown;
  videoCardId?: unknown;
  video_branch_id?: unknown;
  videoBranchId?: unknown;
  branch_id?: unknown;
  branchId?: unknown;
};

function optionalId(...values: unknown[]): string | null {
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function queryHref(path: string, values: Array<[string, string | null]>) {
  const params = new URLSearchParams();
  values.forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function taskReuseHref(task: TaskReuseSource, returnTo: string | null | undefined): string | null {
  const id = optionalId(task.id);
  const provider = typeof task.provider === 'string' ? task.provider : '';
  const generationMode = task.generation_mode ?? task.generationMode;

  if (!id || generationMode === 'enhance_video' || provider === 'volcengine_mediakit') return null;
  if (typeof generationMode !== 'string' || !GENERATION_MODES.has(generationMode as GenerationMode)) return null;

  let path: string;
  if (provider === 'volcengine_ark') {
    path = '/generate/ip';
  } else if (provider === 'seedance' || provider === 'h3') {
    path = '/generate';
  } else {
    return null;
  }

  const safeReturnTo = sanitizeOptionalReturnTo(returnTo);
  return queryHref(path, [
    ['reuse_task_id', id],
    ['project_id', optionalId(task.project_id, task.projectId)],
    ['video_card_id', optionalId(task.video_card_id, task.videoCardId)],
    ['video_branch_id', optionalId(task.video_branch_id, task.videoBranchId, task.branch_id, task.branchId)],
    ['return_to', safeReturnTo],
  ]);
}

export function enhanceWorkspaceHref(returnTo: string | null | undefined, sourceTaskId?: string | null): string {
  return queryHref('/generate/enhance', [
    ['return_to', sanitizeOptionalReturnTo(returnTo)],
    ['source_task_id', optionalId(sourceTaskId)],
  ]);
}
