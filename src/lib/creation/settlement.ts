import { canvasVideoBatchIsSettled, canvasVideoBatchState, canvasVideoChildState } from '@/lib/canvas-video-batch-contract';
import type { CreationDb } from './context';
/** Called only in existing terminal/stop transactions. No fee, Usage, provider or GET side effects. */
export async function settleVideoCreationBatch(db: CreationDb, source: string | { batchId: string }) {
  const child = typeof source === 'string' ? await db.canvasVideoBatchChild.findUnique({ where: { task_id: source }, select: { batch_id: true } }) : null;
  const batchId = typeof source === 'string' ? child?.batch_id : source.batchId;
  if (!batchId) return;
  const batch = await db.canvasVideoBatch.findUnique({ where: { id: batchId }, include: { children: true } });
  if (!batch || batch.contract_version !== 2 || !batch.creation_intent_id || batch.children.length !== batch.count) return;
  const tasks = await db.videoTask.findMany({ where: { id: { in: batch.children.flatMap(row => row.task_id ? [row.task_id] : []) } }, select: { id: true, local_status: true, provider_task_id: true, error_code: true } });
  const states = batch.children.map(row => canvasVideoChildState(row, tasks.find(task => task.id === row.task_id)));
  if (!canvasVideoBatchIsSettled(states)) return;
  const intent = await db.videoCreationIntent.findUnique({ where: { id: batch.creation_intent_id } });
  if (!intent || intent.batch_id !== batch.id || intent.state !== 'batch_active') return;
  const updated = await db.canvasVideoBatch.updateMany({ where: { id: batch.id, revision: batch.revision }, data: { active_node_key: null, state: canvasVideoBatchState(states), revision: { increment: 1 } } });
  if (updated.count !== 1) throw new Error('原批次收尾发生并发变化，未覆盖原状态');
  const settled = await db.videoCreationIntent.updateMany({ where: { id: intent.id, revision: intent.revision, batch_id: batch.id, state: 'batch_active' }, data: { state: 'batch_settled' } });
  if (settled.count !== 1) throw new Error('原创作意图收尾发生并发变化，未覆盖原回执');
}
