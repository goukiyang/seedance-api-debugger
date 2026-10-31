import { randomUUID } from 'node:crypto';
import { SAFE_RETRY_WRITES_ENABLED } from './build-mode';
import { prisma } from '@/lib/prisma';
import { finishStudioTask } from '@/lib/image-studio/tasks';
import { studioTaskState } from '@/lib/image-studio/pricing-state';
import { readRetry, writeRetry, publicRetry, retryConfig } from './store';

export async function stopTaskRetries(kind: 'image' | 'video', id: string, owner: string) {
  const result = await prisma.$transaction(async tx => {
    const prior = await readRetry(kind, id, tx);
    if (!prior || prior.value.ownerId !== owner) throw new Error('retry_not_found');
    const value = structuredClone(prior.value);
    value.stopped = true;
    const last = value.attempts.at(-1)!;
    if (value.state === 'wait' || value.state === 'active' && kind === 'video' && (last.state === 'free_failed' || last.state === 'prepared' && last.ordinal > 0)) {
      value.state = 'failed';
      if (last.state === 'prepared') last.state = 'failed';
      if (kind === 'image') {
        const task = await tx.imageStudioTask.findFirst({ where: { id, owner_id: owner, status: 'sr_retry_wait',
          OR: [{ lease_token: null }, { lease_until: { lt: new Date() } }] } });
        if (!task) throw new Error('retry_state_changed');
        const active = { ...task, status: studioTaskState({ ...task, status: 'sr_queued' }, value.scope.channel === 'original' ? 'running' : 'channel_running'),
          lease_token: randomUUID(), lease_until: new Date(Date.now() + 60000) };
        await tx.imageStudioTask.update({ where: { id }, data: { status: active.status, lease_token: active.lease_token, lease_until: active.lease_until } });
        await writeRetry(tx, prior, value);
        await finishStudioTask(active, 'failed', { error: '后续重试已停止；未取消供应商执行。' }, tx);
        return publicRetry(value);
      }
      const changed = await tx.videoTask.updateMany({ where: { id, local_status: { in: ['retry_wait', 'retry_submitting'] } }, data: {
        local_status: 'failed', error_message: '后续重试已停止；未取消供应商执行。', completed_at: new Date() } });
      const task = await tx.videoTask.findUniqueOrThrow({ where: { id } });
      if (!changed.count && task.local_status !== 'failed') throw new Error('retry_state_changed');
      await (await import('@/lib/video/task-finalizer')).settleTask(id, task.user_id!, task.frozen_cost || 0, 'failed', tx);
    }
    await writeRetry(tx, prior, value); return publicRetry(value);
  }, { timeout: 15000 });
  return result;
}

export async function closeDisabledRetryWaits() {
  const config = await retryConfig();
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: 'safe-generation-retry:task:v1:' },
    value_json: { contains: '"state":"wait"' } }, orderBy: { updated_at: 'asc' }, take: 50 });
  for (const row of rows) {
    const value = JSON.parse(row.value_json) as import('./store').RetryRecord;
    const last = value.attempts.at(-1)!;
    const image = value.kind === 'image' ? await prisma.imageStudioTask.findUnique({ where: { id: value.taskId } }) : null;
    if (value.stopped || !SAFE_RETRY_WRITES_ENABLED || process.env.SAFE_GENERATION_RETRY_DISABLED === '1' || !last.rule || !config.enabledIds.includes(last.rule.id)
      || image?.billing_deadline && image.billing_deadline <= new Date()) {
      await stopTaskRetries(value.kind, value.taskId, value.ownerId);
    }
  }
}
