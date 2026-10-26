export const CANVAS_VIDEO_BATCH_CAPABILITY = 'canvas_video_batch_v1';
export const CANVAS_VIDEO_BATCH_VERSION = 1;
export const CANVAS_VIDEO_BATCH_UPGRADE_URL = '/tools/ultimate-canvas/';
export type CanvasVideoCount = 1 | 2 | 4;
export type CanvasVideoBatchReference = { batch_id: string; child_id: string; contract_version: 1; child_revision: number };
export type CanvasVideoChildState = 'prepared' | 'accepted' | 'queued' | 'running' | 'unconfirmed'
  | 'rejected' | 'succeeded' | 'failed' | 'cancelled';

export function canvasVideoCount(value: unknown): CanvasVideoCount {
  if (value === undefined) return 1;
  if (value !== 1 && value !== 2 && value !== 4) throw new Error('视频数量只能选择 1、2 或 4');
  return value;
}
export function hasCanvasVideoBatchCapability(value: unknown) {
  return Array.isArray(value) && value.includes(CANVAS_VIDEO_BATCH_CAPABILITY);
}
export function canvasBatchObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function canvasBatchId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
export function parseCanvasVideoBatchReference(value: unknown): CanvasVideoBatchReference | null {
  if (value === undefined) return null;
  if (!canvasBatchObject(value) || value.contract_version !== 1 || !canvasBatchId(value.batch_id) || !canvasBatchId(value.child_id)
    || !Number.isSafeInteger(value.child_revision) || Number(value.child_revision) < 1) {
    throw new Error('视频批次身份无效，请查询原批次');
  }
  return { batch_id: value.batch_id, child_id: value.child_id, contract_version: 1, child_revision: Number(value.child_revision) };
}
export function canvasVideoChildState(child: { state: string; task_id: string | null },
  task?: { local_status: string; provider_task_id: string | null; error_code: string | null } | null): CanvasVideoChildState {
  if (!child.task_id) return child.state === 'prepared' ? 'prepared' : child.state === 'cancelled' ? 'cancelled' : 'rejected';
  if (!task) return 'unconfirmed';
  if (task.error_code?.includes('UNCONFIRMED') || !task.provider_task_id
    && !['succeeded', 'failed', 'cancelled'].includes(task.local_status)) return 'unconfirmed';
  if (['succeeded', 'failed', 'cancelled'].includes(task.local_status)) return task.local_status as CanvasVideoChildState;
  if (['running', 'processing'].includes(task.local_status)) return 'running';
  if (task.local_status === 'queued') return 'queued';
  return 'accepted';
}
export function canvasVideoBatchState(states: readonly CanvasVideoChildState[]) {
  if (states.includes('unconfirmed')) return 'unconfirmed';
  if (states.some(state => ['accepted', 'queued', 'running'].includes(state))) return 'processing';
  if (states.every(state => state === 'succeeded')) return 'succeeded';
  if (states.every(state => state === 'prepared')) return 'prepared';
  if (states.some(state => state === 'prepared' || state === 'succeeded' || state === 'failed')) return 'partial';
  return 'stopped';
}
export function canvasVideoBatchIsSettled(states: readonly CanvasVideoChildState[]) {
  return states.every(state => ['succeeded', 'failed', 'cancelled', 'rejected'].includes(state));
}
