import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { feedbackConfig, validFeedbackRecipient } from '@/lib/feedback/notification';
import { feedbackTenantToken } from '@/lib/feedback/delivery';
import type { DatabaseMinute } from './observations';

const TYPE = 'audit_database_v1';
type Delivery = { minute: string; p1008: number; transactions: number; maxTransactionMs: number;
  identity: string; appId: string; tenant: string; firstSendAt: number | null; leaseUntil: number | null; attempts: number };
const validCounts = (row: DatabaseMinute | Delivery) => Number.isFinite(Date.parse(row.minute))
  && [row.p1008, row.transactions, row.maxTransactionMs].every(value => Number.isSafeInteger(value) && value >= 0);
const body = (row: Delivery) => `Scope: reporting process (minute deduplicated)\nSQLite minute: ${row.minute}\nP1008: ${row.p1008}\nTransactions: ${row.transactions}\nMax transaction ms: ${row.maxTransactionMs}`;

// Same pinned administrator/app/tenant and token flow as existing billing alerts.
// Minute IDs and the original UUID survive unknown sends; never resend after 50m.
export async function flushDatabaseAlerts(minutes: DatabaseMinute[], now = new Date()) {
  const config = feedbackConfig();
  if (!config.enabled) return;
  const admin = await prisma.user.findUnique({ where: { id: config.recipientId } });
  if (!validFeedbackRecipient(admin, config)) return;
  const currentMinute = new Date(Math.floor(+now / 60000) * 60000).toISOString();
  for (const row of minutes.slice(-60)) {
    if (!validCounts(row) || row.minute >= currentMinute || +now - Date.parse(row.minute) > 50 * 60000
      || !row.p1008 && row.maxTransactionMs < 1000) continue;
    const id = createHash('sha256').update(`${TYPE}:${row.minute}:${admin!.id}`).digest('hex').slice(0, 32);
    const meta: Delivery = { minute: row.minute, p1008: row.p1008, transactions: row.transactions, maxTransactionMs: row.maxTransactionMs,
      identity: config.identity, appId: config.appId, tenant: config.tenant, firstSendAt: null, leaseUntil: null, attempts: 0 };
    await prisma.notification.upsert({ where: { id }, update: {}, create: { id, target_user_id: admin!.id, type: TYPE,
      channel: 'feishu', status: 'pending', title: 'SQLite contention observed', body: body(meta), metadata_json: JSON.stringify(meta) } });
  }
  const jobs = await prisma.notification.findMany({ where: { type: TYPE, channel: 'feishu', status: 'pending' },
    take: 10, orderBy: { created_at: 'asc' } });
  for (const job of jobs) {
    let meta: Delivery;
    try { meta = JSON.parse(job.metadata_json || ''); } catch { continue; }
    if (!meta || !validCounts(meta) || !Number.isSafeInteger(meta.attempts) || meta.attempts < 0
      || meta.identity !== config.identity || meta.appId !== config.appId || meta.tenant !== config.tenant
      || job.target_user_id !== admin!.id || meta.leaseUntil !== null && (!Number.isFinite(meta.leaseUntil) || meta.leaseUntil > +now)
      || meta.firstSendAt !== null && !Number.isFinite(meta.firstSendAt)) continue;
    if (meta.firstSendAt !== null && +now - meta.firstSendAt >= 50 * 60000) {
      await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json },
        data: { status: 'failed', error_message: 'database_alert_delivery_unknown' } });
      continue;
    }
    const next = { ...meta, firstSendAt: meta.firstSendAt ?? +now, leaseUntil: +now + 90000, attempts: meta.attempts + 1 };
    const claimed = await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json },
      data: { metadata_json: JSON.stringify(next) } });
    if (!claimed.count) continue;
    try {
      const token = await feedbackTenantToken();
      const freshConfig = feedbackConfig(), fresh = await prisma.user.findUnique({ where: { id: job.target_user_id } });
      if (freshConfig.identity !== meta.identity || freshConfig.appId !== meta.appId || freshConfig.tenant !== meta.tenant
        || !freshConfig.enabled || !validFeedbackRecipient(fresh, freshConfig)) continue;
      // Trusted semantic constant, never an untrusted resource URL.
      const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: fresh!.feishu_open_id, uuid: job.id, msg_type: 'text',
          content: JSON.stringify({ text: `SQLite contention observed\n${body(meta)}` }) }),
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) continue;
      await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: JSON.stringify(next) },
        data: { status: 'sent', sent_at: now } });
    } catch { /* Ambiguous delivery keeps the same durable UUID and bounded window. */ }
  }
}
