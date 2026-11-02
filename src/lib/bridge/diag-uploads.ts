import { randomInt } from 'node:crypto';
import { prisma, retrySqliteBusy } from '@/lib/prisma';

export const DIAG_UPLOAD_ACTION = 'bridge_diag_upload';
export const MAX_DIAG_BYTES = 600 * 1024;
const WINDOW_MS = 60 * 60 * 1000;
const WINDOW_MAX = 20;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SECRET_KEY = /token|cookie|password|secret|authorization/i;

export function generateDiagCode(pick: (max: number) => number = randomInt) {
  return Array.from({ length: 6 }, () => ALPHABET[pick(ALPHABET.length)]).join('');
}

export function uploadSizeStatus(bytes: number) {
  return bytes > MAX_DIAG_BYTES ? 413 : null;
}

export function uploadBodyStatus(body: unknown) {
  return !body || typeof body !== 'object' || Array.isArray(body)
    || !Array.isArray((body as Record<string, unknown>).items) ? 400 : null;
}

export function redactDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') {
    return /^data:/i.test(value) ? `[data 约 ${Math.ceil(Buffer.byteLength(value, 'utf8') / 1024)}KB]` : value;
  }
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_KEY.test(key) ? '[隐藏]' : redactDiagnostic(item),
    ]));
  }
  return value;
}

export function encodeDiagDetail(body: Record<string, unknown>) {
  const safe = redactDiagnostic(body) as Record<string, unknown>;
  const items = safe.items as unknown[];
  // SQLite TEXT has no 600KB column limit. Keep this upload's stored JSON within
  // the same budget, including the server-added trimmed counter.
  // 插件端可能已先删过一批（body.trimmed），这里累加
  const before = Number(safe.trimmed) || 0;
  const encode = (trimmed: number) => JSON.stringify({ ...safe, items: items.slice(trimmed), trimmed: before + trimmed });
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(encode(mid), 'utf8') > MAX_DIAG_BYTES) lo = mid + 1;
    else hi = mid;
  }
  const detail = encode(lo);
  if (Buffer.byteLength(detail, 'utf8') > MAX_DIAG_BYTES) return null;
  return detail;
}

export async function saveDiagUpload(userId: string, detail: string) {
  return retrySqliteBusy(() => prisma.$transaction(async (tx) => {
    const since = new Date(Date.now() - WINDOW_MS);
    const count = await tx.operationLog.count({
      where: { operator_id: userId, action: DIAG_UPLOAD_ACTION, created_at: { gte: since } },
    });
    if (count >= WINDOW_MAX) return null;

    for (let attempt = 0; attempt < 12; attempt++) {
      const code = generateDiagCode();
      const existing = await tx.operationLog.findFirst({
        where: { action: DIAG_UPLOAD_ACTION, target_type: 'BridgeDiag', target_id: code },
        select: { id: true },
      });
      if (existing) continue;
      const row = await tx.operationLog.create({
        data: { operator_id: userId, action: DIAG_UPLOAD_ACTION, target_type: 'BridgeDiag', target_id: code, detail },
        select: { id: true, created_at: true },
      });
      return { code, id: row.id, createdAt: row.created_at };
    }
    throw new Error('无法分配诊断编号');
  }));
}

const diagWhere = { action: DIAG_UPLOAD_ACTION, target_type: 'BridgeDiag' };

export async function readDiagUpload(code?: string) {
  const row = await prisma.operationLog.findFirst({
    where: { ...diagWhere, ...(code ? { target_id: code } : {}) },
    orderBy: { created_at: 'desc' },
    select: { id: true, target_id: true, detail: true, created_at: true, operator_id: true, operator: { select: { name: true } } },
  });
  return row ? {
    code: row.target_id, id: row.id, createdAt: row.created_at,
    uploadedBy: row.operator?.name || row.operator_id,
    detail: row.detail ? JSON.parse(row.detail) : null,
  } : null;
}

export async function listDiagUploads() {
  const rows = await prisma.operationLog.findMany({
    where: diagWhere, orderBy: { created_at: 'desc' }, take: 20,
    select: { id: true, target_id: true, detail: true, created_at: true, operator_id: true, operator: { select: { name: true } } },
  });
  return rows.map((row) => {
    const detail = row.detail ? JSON.parse(row.detail) as Record<string, unknown> : {};
    const instance = detail.instance && typeof detail.instance === 'object' && !Array.isArray(detail.instance)
      ? detail.instance as Record<string, unknown> : {};
    return {
      code: row.target_id, uploadedBy: row.operator?.name || row.operator_id,
      createdAt: row.created_at, version: detail.version ?? null,
      profileName: instance.profileName ?? null, count: detail.count ?? null,
    };
  });
}
