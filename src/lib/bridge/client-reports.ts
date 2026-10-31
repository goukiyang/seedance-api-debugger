import { prisma } from '@/lib/prisma';

/**
 * SD2 生产桥插件「出错自动上报」。
 * 存在现有 OperationLog（action = bridge_client_report），无需迁移、不新增表。
 * - 同一用户 + 同一 fingerprint 一天只存一条（重复的只计数到内存，不写库）
 * - 单用户 10 分钟最多 30 条；单条 detail ≤ 48KB
 * - 服务端再做一层脱敏：截断字符串、去 data: 内容、去 token 类字段
 */
export const CLIENT_REPORT_ACTION = 'bridge_client_report';
const MAX_DETAIL = 48 * 1024;
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_MAX = 30;
const hits = new Map<string, number[]>();

export function rateLimited(userId: string, now = Date.now()) {
  const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= WINDOW_MAX) { hits.set(userId, arr); return true; }
  arr.push(now);
  hits.set(userId, arr);
  return false;
}

function clean(v: unknown, depth = 0): unknown {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (v.startsWith('data:')) return `[data ${Math.round(v.length / 1024)}KB]`;
    return v.length > 600 ? v.slice(0, 600) + '…' : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 6) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 120).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).slice(0, 60)) {
      out[k] = /token|cookie|password|secret|authorization/i.test(k) ? '[隐藏]' : clean((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return String(v);
}

export interface ClientReportInput {
  fingerprint: string;
  kind: string;
  version: string;
  site: string;
  message: string;
  items: unknown[];
  dom: unknown;
  ua: string;
}

export function normalizeReport(body: unknown): ClientReportInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : '');
  const fingerprint = s(b.fingerprint, 160).replace(/[^\w.:\-/ 一-龥]/g, '');
  if (!fingerprint) return null;
  return {
    fingerprint,
    kind: s(b.kind, 80),
    version: s(b.version, 20),
    site: s(b.site, 80),
    message: s(b.message, 600),
    items: Array.isArray(b.items) ? b.items.slice(-80) : [],
    dom: b.dom ?? null,
    ua: s(b.ua, 300),
  };
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export async function saveClientReport(userId: string, r: ClientReportInput) {
  const existing = await prisma.operationLog.findFirst({
    where: { operator_id: userId, action: CLIENT_REPORT_ACTION, target_id: r.fingerprint, created_at: { gte: startOfDay() } },
    select: { id: true },
  });
  if (existing) return { stored: false, deduplicated: true, id: existing.id };
  let detail = JSON.stringify(clean(r));
  if (detail.length > MAX_DETAIL) {
    detail = JSON.stringify(clean({ ...r, items: r.items.slice(-20), dom: '[过大已省略]' }));
    if (detail.length > MAX_DETAIL) detail = detail.slice(0, MAX_DETAIL);
  }
  const row = await prisma.operationLog.create({
    data: { operator_id: userId, action: CLIENT_REPORT_ACTION, target_type: 'BridgeClient', target_id: r.fingerprint, detail },
    select: { id: true },
  });
  return { stored: true, deduplicated: false, id: row.id };
}

export async function listClientReports(opts: { since?: Date; limit?: number; kind?: string }) {
  const rows = await prisma.operationLog.findMany({
    where: {
      action: CLIENT_REPORT_ACTION,
      ...(opts.since ? { created_at: { gte: opts.since } } : {}),
      ...(opts.kind ? { target_id: { startsWith: opts.kind } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: Math.min(Math.max(opts.limit || 50, 1), 200),
    select: { id: true, operator_id: true, target_id: true, detail: true, created_at: true, operator: { select: { name: true } } },
  });
  return rows.map((r) => {
    let detail: unknown = r.detail;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* 原样返回 */ }
    return { id: r.id, user: r.operator?.name || r.operator_id, fingerprint: r.target_id, created_at: r.created_at, detail };
  });
}
