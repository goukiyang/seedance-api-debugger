import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { feedbackConfig, validFeedbackRecipient } from '@/lib/feedback/notification';
import { feedbackTenantToken } from '@/lib/feedback/delivery';
import type { DatabaseMinute } from './observations';

const TYPE = 'audit_database_v1';
type Report = Omit<DatabaseMinute, 'reporter'> & { reporter: { id: string; pid: number; consumer: 'application-writer' | 'readonly' | 'unknown' } };
type Delivery = { minute: string; p1008: number; transactions: number; maxTransactionMs: number;
  identity: string; appId: string; tenant: string; firstSendAt: number | null; leaseUntil: number | null; attempts: number;
  version?: 2; reports?: Report[]; reportsTruncated?: boolean; deliveryText?: string };
const REPORT_LIMIT = 16;
const validCounts = (row: DatabaseMinute | Delivery) => Number.isFinite(Date.parse(row.minute))
  && [row.p1008, row.transactions, row.maxTransactionMs].every(value => Number.isSafeInteger(value) && value >= 0);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
function mergeSnapshot(previous: Report, incoming: Report): Report {
  const fields = ['p1008', 'p2028', 'p2024', 'transactions', 'transactionMs', 'maxTransactionMs', 'succeeded', 'failed', 'outcomeUnknown'] as const;
  const result = { ...incoming };
  // One process/minute is cumulative. Late snapshots must not erase evidence or
  // add the same counters twice. Different processes always remain separate.
  for (const field of fields) result[field] = Math.max(count(previous[field]), count(incoming[field]));
  const dimensions = (previous.dimensions || []).map(item => ({ ...item }));
  for (const item of incoming.dimensions || []) {
    const prior = dimensions.find(value => value.scope === item.scope && value.category === item.category);
    if (prior) for (const field of fields) prior[field] = Math.max(count(prior[field]), count(item[field]));
    else if (dimensions.length < 25) dimensions.push({ ...item });
  }
  return { ...result, dimensions };
}
function report(row: DatabaseMinute): Report {
  const reporter = row.reporter;
  return { minute: row.minute, p1008: row.p1008, p2028: count(row.p2028), p2024: count(row.p2024), transactions: row.transactions,
    transactionMs: count(row.transactionMs), maxTransactionMs: row.maxTransactionMs,
    succeeded: count(row.succeeded), failed: count(row.failed), outcomeUnknown: row.outcomeUnknown === undefined ? row.transactions : count(row.outcomeUnknown),
    reporter: reporter && /^[a-f0-9-]{36}$/.test(reporter.id) && Number.isSafeInteger(reporter.pid) && reporter.pid > 0
      ? { id: reporter.id, pid: reporter.pid, consumer: reporter.consumer === 'readonly' ? 'readonly' : 'application-writer' }
      : { id: 'legacy-unknown', pid: 0, consumer: 'unknown' },
    dimensions: (row.dimensions || []).slice(0, 25).map(item => ({
      scope: ['unscoped', 'image-studio.shared', 'video-task.create', 'video-task.draft-upgrade', 'other'].includes(item.scope) ? item.scope : 'other',
      category: ['interactive', 'batch', 'query', 'initialization', 'unknown'].includes(item.category) ? item.category : 'unknown',
      p1008: count(item.p1008), p2028: count(item.p2028), p2024: count(item.p2024), transactions: count(item.transactions),
      transactionMs: count(item.transactionMs), maxTransactionMs: count(item.maxTransactionMs), succeeded: count(item.succeeded), failed: count(item.failed), outcomeUnknown: count(item.outcomeUnknown),
    })) };
}
const body = (row: Delivery) => {
  const reports = row.reports?.slice(0, REPORT_LIMIT) || [report({ ...row, transactionMs: 0 })];
  return `Scope: reported process snapshots; not site/global totals\nDatabase minute: ${row.minute}\nCall wall ms include queue, execution and failure; SQL held-lock time is not measured.\n`
    + reports.map(item => `Process ${item.reporter.id} pid=${item.reporter.pid} consumer=${item.reporter.consumer}: P1008=${item.p1008} P2028=${item.p2028} P2024=${item.p2024}; calls=${item.transactions} succeeded=${item.succeeded} failed=${item.failed} unknown=${item.outcomeUnknown}; max wall ms=${item.maxTransactionMs}`).join('\n')
    + (row.reportsTruncated ? '\nMore reporters observed; details capped, no complete total available.' : '')
    + '\nOne notification per minute/recipient. Later reports remain in notification metadata, not resent.';
};
function deliveryText(row: Delivery) {
  if (row.deliveryText) return row.deliveryText;
  // v1 unknown sends already used this exact payload. Keep it with the same UUID.
  if (row.version !== 2 && row.firstSendAt !== null) return `SQLite contention observed\nScope: reporting process (minute deduplicated)\nSQLite minute: ${row.minute}\nP1008: ${row.p1008}\nTransactions: ${row.transactions}\nMax transaction ms: ${row.maxTransactionMs}`;
  return `Database latency/errors observed\n${body(row)}`;
}

// Merge metadata with CAS even after send. Never sum snapshots or alter a send's
// frozen payload/UUID when another process reports during the request.
async function editJob(id: string, change: (meta: Delivery) => { meta: Delivery; status?: string; error_message?: string; sent_at?: Date } | null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await prisma.notification.findUnique({ where: { id } });
    if (!job || job.type !== TYPE) return false;
    let meta: Delivery; try { meta = JSON.parse(job.metadata_json || ''); } catch { return false; }
    if (!meta || !validCounts(meta)) return false;
    const update = change(meta); if (!update) return false;
    const { meta: next, ...fields } = update;
    const updated = await prisma.notification.updateMany({ where: { id, status: job.status, metadata_json: job.metadata_json },
      data: { ...fields, metadata_json: JSON.stringify(next), body: body(next) } });
    if (updated.count) return true;
  }
  throw new Error('database_alert_metadata_conflict'); // retained minute snapshots are retried by the existing scheduler
}

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
      || !row.p1008 && !row.p2028 && !row.p2024 && row.maxTransactionMs < 1000) continue;
    const id = createHash('sha256').update(`${TYPE}:${row.minute}:${admin!.id}`).digest('hex').slice(0, 32);
    const incoming = report(row);
    const meta: Delivery = { version: 2, reports: [incoming], minute: row.minute, p1008: row.p1008, transactions: row.transactions, maxTransactionMs: row.maxTransactionMs,
      identity: config.identity, appId: config.appId, tenant: config.tenant, firstSendAt: null, leaseUntil: null, attempts: 0 };
    await prisma.notification.upsert({ where: { id }, update: {}, create: { id, target_user_id: admin!.id, type: TYPE,
      channel: 'feishu', status: 'pending', title: 'Database latency/errors observed', body: body(meta), metadata_json: JSON.stringify(meta) } });
    await editJob(id, current => {
      if (current.identity !== config.identity || current.appId !== config.appId || current.tenant !== config.tenant) return null;
      const reports = (current.reports || [report({ ...current, transactionMs: 0 })]).slice(0, REPORT_LIMIT);
      const index = reports.findIndex(item => item.reporter.id === incoming.reporter.id);
      if (index >= 0) reports[index] = mergeSnapshot(reports[index], incoming); else if (reports.length < REPORT_LIMIT) reports.push(incoming);
      return { meta: { ...current, ...(current.firstSendAt !== null ? { deliveryText: deliveryText(current) } : {}),
        version: 2, reports, reportsTruncated: current.reportsTruncated || index < 0 && reports.length === REPORT_LIMIT && !reports.includes(incoming) } };
    });
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
    const next = { ...meta, deliveryText: deliveryText(meta), firstSendAt: meta.firstSendAt ?? +now, leaseUntil: +now + 90000, attempts: meta.attempts + 1 };
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
          content: JSON.stringify({ text: next.deliveryText }) }),
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) continue;
      await editJob(job.id, current => current.firstSendAt === next.firstSendAt && current.attempts === next.attempts && current.leaseUntil === next.leaseUntil
        ? { meta: current, status: 'sent', sent_at: now } : null);
    } catch { /* Ambiguous delivery keeps the same durable UUID and bounded window. */ }
  }
}
