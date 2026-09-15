import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma';
import { creditRequestsConfigured } from './requests';

async function feishuJson(path: string, body: unknown, token?: string) {
  const response = await fetch(`https://open.feishu.cn/open-apis/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000), cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(`feishu_${Number(result.code) || response.status}`);
  return result;
}

export async function processCreditDeliveries(limit = 10) {
  if (!creditRequestsConfigured()) return { enabled: false, processed: 0 };
  const due = await prisma.creditRequestDelivery.findMany({ where: {
    status: { in: ['pending', 'retry'] }, next_attempt: { lte: new Date() },
    OR: [{ lease_until: null }, { lease_until: { lt: new Date() } }],
  }, orderBy: { next_attempt: 'asc' }, take: limit });
  let processed = 0;
  for (const job of due) {
    const lease = randomUUID();
    const claimed = await prisma.creditRequestDelivery.updateMany({ where: {
      id: job.id, status: { in: ['pending', 'retry'] }, OR: [{ lease_until: null }, { lease_until: { lt: new Date() } }],
    }, data: { lease_until: new Date(Date.now() + 60_000), lease_token: lease, attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      const request = await prisma.creditRequest.findUniqueOrThrow({ where: { id: job.request_id }, include: { requester: true, approver: true } });
      if (job.kind === 'approval' && request.status !== 'pending') {
        await prisma.creditRequestDelivery.updateMany({ where: { id: job.id, lease_token: lease }, data: { status: 'cancelled', lease_until: null, lease_token: null } }); continue;
      }
      if (request.app_id !== process.env.FEISHU_APP_ID || request.tenant_key !== process.env.FEISHU_ALLOWED_TENANT_KEY
        || request.requester.feishu_open_id !== request.applicant_open_id || request.requester.status !== 'active'
        || request.approver.feishu_open_id !== request.approver_open_id || request.approver.status !== 'active'
        || request.approver.role !== 'admin' || request.approver_id !== process.env.CREDIT_REQUEST_APPROVER_ID) throw new Error('identity_changed');
      const auth = await feishuJson('auth/v3/tenant_access_token/internal', { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
      if (typeof auth.tenant_access_token !== 'string') throw new Error('token_unavailable');
      await feishuJson('im/v1/messages?receive_id_type=open_id', { ...JSON.parse(job.payload_json), uuid: job.id }, auth.tenant_access_token);
      await prisma.creditRequestDelivery.updateMany({ where: { id: job.id, lease_token: lease }, data: { status: 'sent', sent_at: new Date(), lease_until: null, lease_token: null, error_code: null } });
      processed++;
    } catch (error) {
      const code = error instanceof Error && /^(feishu_\d+|identity_changed|token_unavailable)$/.test(error.message) ? error.message : 'delivery_unavailable';
      await prisma.creditRequestDelivery.updateMany({ where: { id: job.id, lease_token: lease }, data: {
        status: 'retry', lease_until: null, lease_token: null, error_code: code,
        next_attempt: new Date(Date.now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(job.attempts, 8))),
      } });
    }
  }
  return { enabled: true, processed };
}
