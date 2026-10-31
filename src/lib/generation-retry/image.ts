import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageStudioTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { studioTaskState, studioBillingState } from '@/lib/image-studio/pricing-state';
import { requestStudioImages } from '@/lib/image-studio/provider';
import { beginRetry, markRetrySent, acceptRetry, planRetry, readRetry, retryHash, advanceRetry } from './store';
import type { RetryFailure } from './contracts';

export class RetryScheduled extends Error {}
export class RetryExhausted extends Error {}
export function imageRetryGenerator(task: ImageStudioTask, generate: typeof requestStudioImages): typeof requestStudioImages {
  if (!task.status.startsWith('sr_')) return generate;
  return async params => {
    let value;
    if (!params.resumeAsync) {
      const snapshot = JSON.parse(task.snapshot_json || '{}'), frozen = snapshot.imageChannel;
      const inputHash = retryHash(JSON.stringify({ prompt: params.prompt, model: params.model, size: params.size, ratio: params.ratio,
        quality: params.quality, images: params.images.map(image => retryHash(Buffer.from(image.bytes).toString('base64'))) }));
      try {
        value = await beginRetry({ kind: 'image', taskId: task.id, ownerId: task.owner_id, inputHash,
          scope: { provider: params.provider || 'musk', protocol: params.protocol || 'openai_images',
            endpoint: params.protocol === 'gemini_native' ? 'generateContent' : params.images.length ? 'edits' : 'generations', model: params.model,
            channel: frozen?.channelId || 'original', revision: frozen?.configRevision || String(task.revision),
            credential: retryHash(`${params.baseUrl}\n${params.apiKey}`) } }, prisma, snapshot.safeRetryRuleIds || []);
        if (value.attempts.length > 1) {
          const allocations = JSON.parse(task.freeze_snapshot || '[]') as Array<{ expires_at?: string | null }>;
          const owner = await prisma.user.findUnique({ where: { id: task.owner_id }, select: { expires_at: true } });
          if (owner?.expires_at && owner.expires_at <= new Date()
            || allocations.some(a => a.expires_at && Date.parse(a.expires_at) <= Date.now())) throw new RetryExhausted();
        }
        await markRetrySent('image', task.id);
      } catch (error) {
        const current = await readRetry('image', task.id);
        if (current?.value.attempts.at(-1)?.state === 'prepared' && current.value.attempts.length > 1) throw new RetryExhausted();
        throw error;
      }
    }
    try {
      return await generate({ ...params, idempotencyKey: value?.attempts.at(-1)!.key || params.idempotencyKey,
        onAsyncAccepted: params.onAsyncAccepted ? async receipt => { await params.onAsyncAccepted!(receipt); await acceptRetry('image', task.id, receipt.taskId); } : undefined });
    } catch (error) {
      const failure = (error as { retryFailure?: RetryFailure }).retryFailure;
      if (failure) {
        const scheduled = await prisma.$transaction(async tx => {
          const fresh = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
          if (!fresh || fresh.status !== task.status || fresh.lease_token !== task.lease_token || !fresh.lease_until || fresh.lease_until <= new Date()) return false;
          if (!await planRetry(tx, 'image', task.id, failure, !fresh.billing_settled_at
            && (!fresh.billing_deadline || fresh.billing_deadline > new Date()))) return false;
          const scheduled = await readRetry('image', task.id, tx);
          await tx.imageStudioTask.update({ where: { id: task.id }, data: { status: 'sr_retry_wait', lease_token: null,
            lease_until: new Date(scheduled!.value.dueAt!),
            error: '等待安全自动重试；保留原费用预留。' } });
          return true;
        });
        if (scheduled) throw new RetryScheduled();
        const final = await readRetry('image', task.id);
        if (final?.value.state === 'failed' && final.value.attempts.at(-1)!.state === 'free_failed') throw new RetryExhausted();
      }
      throw error;
    }
  };
}

/** Archive only a contract-proven closed attempt; never delete its receipts. */
export async function promoteImageRetry() {
  await (await import('./control')).closeDisabledRetryWaits();
  const task = await prisma.imageStudioTask.findFirst({ where: { status: 'sr_retry_wait',
    OR: [{ lease_until: null }, { lease_until: { lte: new Date() } }] }, orderBy: { updated_at: 'asc' } });
  if (!task) return;
  const prior = await readRetry('image', task.id);
  if (!prior || Date.parse(prior.value.dueAt!) > Date.now()) return;
  const last = prior.value.attempts.at(-1)!;
  if (last.state !== 'free_failed') throw new Error('retry_image_prior_not_closed');
  // Claim the parent before moving any files. An expired claim resumes archive,
  // not generation; the attempt ordinal changes only in the final transaction.
  const lease = new Date(Date.now() + 60000);
  const claim = await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: 'sr_retry_wait', lease_token: task.lease_token,
    lease_until: task.lease_until }, data: { lease_until: lease, lease_token: 'safe-retry-archive' } });
  if (!claim.count) return;
  for (const folder of ['studio-delivery', 'studio-billing']) {
    const source = path.join(process.cwd(), 'storage', folder, task.id);
    const parent = path.join(process.cwd(), 'storage', 'generation-retry', task.id, String(last.ordinal));
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    try { await fs.rename(source, path.join(parent, folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await prisma.$transaction(async tx => {
    const fresh = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!fresh || fresh.status !== 'sr_retry_wait' || fresh.lease_until?.getTime() !== lease.getTime()) return;
    const advanced = await advanceRetry(tx, 'image', task.id);
    if (!advanced) { await tx.imageStudioTask.update({ where: { id: task.id }, data: { lease_until: null, lease_token: null } }); return; }
    const channel = advanced.scope.channel !== 'original';
    await tx.imageStudioTask.update({ where: { id: task.id }, data: { status: studioTaskState({ ...task, status: 'sr_queued' }, channel ? 'channel_queued' : 'queued'),
      gateway_request_id: null, billing_status: studioBillingState(task, channel ? 'channel_awaiting_response' : 'awaiting_response'),
      billing_next_check_at: null, lease_until: null, lease_token: null, error: null } });
  });
}
