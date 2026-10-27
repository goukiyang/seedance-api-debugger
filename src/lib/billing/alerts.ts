import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { feedbackConfig, validFeedbackRecipient } from '@/lib/feedback/notification';
import { feedbackTenantToken } from '@/lib/feedback/delivery';

const TYPE = 'audit_billing_v1';
export async function queueBillingAlert(tx: Prisma.TransactionClient, key: string, counts: Record<string, number>) {
  const config = feedbackConfig();
  const admins = await tx.user.findMany({ where: { role: 'admin', status: 'active' } });
  for (const admin of admins) {
    const id = createHash('sha256').update(`${TYPE}:${key}:${admin.id}`).digest('hex').slice(0, 32);
    await tx.notification.upsert({ where: { id }, update: {}, create: {
      id, type: TYPE, target_user_id: admin.id, channel: validFeedbackRecipient(admin, config) ? 'feishu' : 'in_app',
      status: validFeedbackRecipient(admin, config) ? 'pending' : 'sent', title: '计费记录需要核对',
      body: Object.entries(counts).map(([name, count]) => `${name}: ${count}`).join('\n'),
      metadata_json: JSON.stringify({ identity: config.identity, appId: config.appId, tenant: config.tenant,
        state: 'pending', firstSendAt: null, leaseUntil: null, attempts: 0 }),
    } });
  }
}

// Reuse the existing pinned administrator/app/tenant identity. Notification
// bodies contain counts only, never prompts, callback URLs, tokens or raw errors.
export async function deliverBillingAlerts(now = new Date()) {
  const config = feedbackConfig();
  if (!config.enabled) return { enabled: false, sent: 0 };
  const jobs = await prisma.notification.findMany({ where: { type: TYPE, channel: 'feishu', status: 'pending' }, take: 10, orderBy: { created_at: 'asc' } });
  let sent = 0;
  for (const job of jobs) {
    const admin = await prisma.user.findUnique({ where: { id: job.target_user_id } });
    if (!validFeedbackRecipient(admin, config)) continue;
    let meta;
    try { meta = JSON.parse(job.metadata_json || ''); } catch { continue; }
    if (meta.identity !== config.identity || meta.appId !== config.appId || meta.tenant !== config.tenant) continue;
    if (meta.leaseUntil && meta.leaseUntil > +now) continue;
    if (meta.firstSendAt && +now - meta.firstSendAt >= 50 * 60_000) {
      await prisma.notification.updateMany({ where: { id: job.id, metadata_json: job.metadata_json }, data: { status: 'failed', error_message: 'billing_alert_delivery_unknown' } });
      continue;
    }
    const next = { ...meta, firstSendAt: meta.firstSendAt || +now, leaseUntil: +now + 90_000, attempts: meta.attempts + 1 };
    const claimed = await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json }, data: { metadata_json: JSON.stringify(next) } });
    if (!claimed.count) continue;
    try {
      const token = await feedbackTenantToken();
      const fresh = await prisma.user.findUnique({ where: { id: job.target_user_id } });
      if (!validFeedbackRecipient(fresh, config)) throw new Error('billing_alert_identity_changed');
      const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: fresh!.feishu_open_id, uuid: job.id, msg_type: 'text', content: JSON.stringify({ text: `${job.title}\n${job.body || ''}` }) }),
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw new Error('billing_alert_unconfirmed');
      await prisma.notification.updateMany({ where: { id: job.id, metadata_json: JSON.stringify(next) }, data: { status: 'sent', sent_at: new Date() } });
      sent++;
    } catch {
      // Keep the same UUID, within Feishu's deduplication window, on recovery.
      console.warn('[BillingAlerts] delivery deferred');
    }
  }
  return { enabled: true, sent };
}
