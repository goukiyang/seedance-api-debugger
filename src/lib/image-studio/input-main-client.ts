import type { StudioInputMainResponse, StudioInputMainSource } from './input-main';
import { readJsonResponse } from '@/lib/http/json-response';
import { MAX_REFERENCE_IMAGES } from './limits';
export async function readReadyStudioInputMain(source: StudioInputMainSource): Promise<StudioInputMainResponse> {
  const url = source.kind === 'task' ? `/api/image-studio/tasks/${encodeURIComponent(source.taskId)}/input-main`
    : `/api/image-studio/batches?${new URLSearchParams({ mode: 'input-main', id: source.batchId, ordinal: String(source.ordinal) })}`;
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const result = await readJsonResponse<StudioInputMainResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(result.error || '本次输入主图暂不可读');
  const actual = result.source;
  const matches = actual?.kind === source.kind && (source.kind === 'task'
    ? actual.kind === 'task' && actual.taskId === source.taskId
    : actual.kind === 'batch-item' && actual.batchId === source.batchId && actual.ordinal === source.ordinal && actual.attempt === source.attempt);
  if (!matches || !['ready', 'none', 'unknown', 'unavailable'].includes(result.state) || !Array.isArray(result.images) || typeof result.snapshotToken !== 'string') throw new Error('这次生成的输入来源未能确认，当前主图保留');
  if (result.state !== 'ready') throw new Error(result.state === 'none' ? '这次生成没有输入主图，当前主图保留'
    : result.state === 'unavailable' ? '这次生成的输入主图已不可用或无权读取，当前主图保留' : '旧记录未明确保存输入主图角色，不能猜测或改用生成图；当前主图保留');
  if (!result.images.length || result.images.length > MAX_REFERENCE_IMAGES || result.images.some(image => !image?.id || !image.originalUrl)
    || new Set(result.images.map(image => image.id)).size !== result.images.length) throw new Error('输入主图记录不完整，当前主图保留');
  return result;
}
