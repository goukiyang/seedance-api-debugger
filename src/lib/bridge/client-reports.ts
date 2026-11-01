import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';

/**
 * SD2 生产桥插件「出错自动上报」。
 * 存在现有 OperationLog（action = bridge_client_report），无需迁移、不新增表。
 * - 同一用户 + 同一 fingerprint 一天只存一条
 * - 单用户 10 分钟最多 30 条；单条 detail ≤ 48KB（UTF-8）
 * - 仅持久化定位错误所需的技术字段，自由文本只留摘要
 */
export const CLIENT_REPORT_ACTION = 'bridge_client_report';
const MAX_DETAIL_BYTES = 48 * 1024;
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_MAX = 30;
const MAX_REPORT_ITEMS = 41;
const MAX_DOM_NODES = 120;
const TRUSTED_ERROR_TYPES = [
  'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'Error',
  'DOMException', 'AbortError', 'DataCloneError', 'EncodingError', 'HierarchyRequestError', 'IndexSizeError',
  'InvalidCharacterError', 'InvalidStateError', 'NetworkError', 'NotAllowedError', 'NotFoundError',
  'NotReadableError', 'NotSupportedError', 'OperationError', 'QuotaExceededError', 'SecurityError', 'TimeoutError',
] as const;
const hits = new Map<string, number[]>();

export function rateLimited(userId: string, now = Date.now()) {
  const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= WINDOW_MAX) { hits.set(userId, arr); return true; }
  arr.push(now);
  hits.set(userId, arr);
  return false;
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function textSummary(value: string) {
  const errorType = TRUSTED_ERROR_TYPES.find((type) => new RegExp(`\\b${type}\\b`).test(value));
  const httpStatus = value.match(/\bHTTP\s+([1-5]\d{2})\b/i)?.[1];
  return {
    redacted: true as const,
    length: value.length,
    sha256: digest(value),
    ...(errorType ? { error_type: errorType } : {}),
    ...(httpStatus ? { http_status: Number(httpStatus) } : {}),
  };
}

function safeTechnicalPart(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  const v = value.slice(0, max);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) ? v : '';
}

function safeManifestVersion(value: unknown) {
  if (typeof value !== 'string' || value.length > 20 || !/^\d+(?:\.\d+){0,3}$/.test(value)) return '';
  const parts = value.split('.');
  return parts.every((part) => (part === '0' || !part.startsWith('0')) && Number(part) <= 65535) ? value : '';
}

function safeSite(value: unknown) {
  if (typeof value !== 'string') return '';
  const v = value.slice(0, 80).toLowerCase();
  return v === 'sw' || /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.test(v) ? v : '';
}

function normalizeTechnicalIdentity(body: Record<string, unknown>) {
  const raw = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 160) : '';
  if (!raw) return null;
  const parts = raw.split(':');
  const module = safeTechnicalPart(parts[0], 40);
  const event = safeTechnicalPart(parts[1], 80);
  const version = parts.length === 3 ? safeManifestVersion(parts[2]) : '';
  if (parts.length === 3 && module && event && version) {
    return { fingerprint: `${module}:${event}:${version}`, kind: `${module}:${event}`, version };
  }
  const fallback = `invalid:${digest(raw).slice(0, 32)}`;
  return { fingerprint: fallback, kind: 'invalid', version: safeManifestVersion(body.version) };
}

function cleanUrl(value: string) {
  if (/^data:/i.test(value)) return null;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
    const url = new URL(value, 'https://bridge.invalid');
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return absolute ? `${url.origin}${url.pathname}` : url.pathname;
  } catch {
    return null;
  }
}

type StoredDiagnostic = null | boolean | number | string | ReturnType<typeof textSummary>
  | StoredDiagnostic[] | { [key: string]: StoredDiagnostic };

function diagnosticValue(value: unknown, depth = 0): StoredDiagnostic {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/\bdata:/i.test(value)) return { redacted: true, kind: 'data', length: value.length };
    if (/^https?:\/\//i.test(value)) return cleanUrl(value) || textSummary(value);
    return textSummary(value);
  }
  if (depth >= 3) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => diagnosticValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: { [key: string]: StoredDiagnostic } = {};
    for (const [rawKey, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      const key = safeTechnicalPart(rawKey, 64);
      if (!key) continue;
      out[key] = /token|cookie|password|secret|authorization/i.test(key)
        ? { redacted: true, length: 0, sha256: digest('') }
        : diagnosticValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeIsoTime(value: unknown) {
  if (typeof value !== 'string' || value.length > 40) return '';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '' : time.toISOString();
}

function sanitizeItems(items: unknown[]) {
  return items.slice(-MAX_REPORT_ITEMS).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const module = safeTechnicalPart(item.m, 40);
    const event = safeTechnicalPart(item.e, 80);
    if (!module || !event) return [];
    const level = typeof item.lv === 'string' && ['info', 'warn', 'error'].includes(item.lv) ? item.lv : 'info';
    return [{
      t: normalizeIsoTime(item.t),
      lv: level,
      at: safeSite(item.at),
      m: module,
      e: event,
      ...(item.d === undefined ? {} : { d: diagnosticValue(item.d) }),
    }];
  });
}

function safeDomAttribute(value: unknown, max: number, pattern: RegExp) {
  if (typeof value !== 'string') return '';
  const v = value.slice(0, max);
  return pattern.test(v) ? v : '';
}

function sanitizeDom(value: unknown) {
  let nodes = 0;
  const walk = (candidate: unknown, depth: number): Record<string, unknown> | null => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || depth > 6 || nodes >= MAX_DOM_NODES) return null;
    nodes += 1;
    const input = candidate as Record<string, unknown>;
    const tag = safeDomAttribute(input.tag, 24, /^(?:[a-z][a-z0-9-]*|#)$/);
    if (!tag) return null;
    const output: Record<string, unknown> = { tag };
    const testid = safeDomAttribute(input.testid, 80, /^[A-Za-z0-9_.:-]+$/);
    const role = safeDomAttribute(input.role, 40, /^[A-Za-z0-9_.:-]+$/);
    const cls = safeDomAttribute(input.cls, 80, /^[A-Za-z0-9_:@.!%#()=\-/\[\] ]+$/);
    const src = safeSite(input.src);
    const color = safeDomAttribute(input.color, 64, /^[A-Za-z0-9#(),.%\- ]+$/);
    const fill = safeDomAttribute(input.fill, 64, /^[A-Za-z0-9#(),.%\- ]+$/);
    if (testid) output.testid = testid;
    if (role) output.role = role;
    if (cls) output.cls = cls;
    if (typeof input.href === 'string') {
      const href = cleanUrl(input.href.slice(0, 240));
      if (href) output.href = href;
    }
    if (src) output.src = src;
    if (color) output.color = color;
    if (fill) output.fill = fill;
    if (typeof input.kids === 'number' && Number.isSafeInteger(input.kids) && input.kids >= 0) output.kids = Math.min(input.kids, 10000);
    if (Array.isArray(input.c)) {
      const children = input.c.slice(0, 40).map((child) => walk(child, depth + 1)).filter(Boolean);
      if (children.length) output.c = children;
    }
    return output;
  };
  return walk(value, 0);
}

function summarizeUserAgent(value: string) {
  const browser = value.match(/\b(Edg|Chrome|Firefox|Version)\/(\d+)/);
  const platform = /Android/i.test(value) ? 'Android'
    : /iPhone|iPad/i.test(value) ? 'iOS'
      : /Macintosh/i.test(value) ? 'macOS'
        : /Windows/i.test(value) ? 'Windows'
          : /Linux/i.test(value) ? 'Linux' : 'unknown';
  return {
    redacted: true as const,
    length: value.length,
    sha256: digest(value),
    ...(browser ? { family: browser[1] === 'Version' ? 'Safari' : browser[1], major: Number(browser[2]) } : {}),
    platform,
  };
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
  const identity = normalizeTechnicalIdentity(b);
  if (!identity) return null;
  return {
    ...identity,
    site: safeSite(b.site),
    message: typeof b.message === 'string' ? b.message.slice(0, 600) : '',
    items: Array.isArray(b.items) ? b.items.slice(-MAX_REPORT_ITEMS) : [],
    dom: b.dom ?? null,
    ua: typeof b.ua === 'string' ? b.ua.slice(0, 300) : '',
  };
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function encodeDetail(r: ClientReportInput) {
  const stored = {
    fingerprint: r.fingerprint,
    kind: r.kind,
    version: r.version,
    site: r.site,
    message: textSummary(r.message),
    items: sanitizeItems(r.items),
    dom: sanitizeDom(r.dom),
    ua: summarizeUserAgent(r.ua),
  };
  const variants = [
    stored,
    { ...stored, items: stored.items.slice(-20), dom: null },
    { ...stored, items: stored.items.slice(-10).map(({ d: _detail, ...item }) => item), dom: null },
    { ...stored, items: [], dom: null },
  ];
  for (const candidate of variants) {
    const detail = JSON.stringify(candidate);
    if (Buffer.byteLength(detail, 'utf8') <= MAX_DETAIL_BYTES) return detail;
  }
  throw new Error('上报摘要超过存储上限');
}

export async function saveClientReport(userId: string, r: ClientReportInput) {
  const existing = await prisma.operationLog.findFirst({
    where: { operator_id: userId, action: CLIENT_REPORT_ACTION, target_id: r.fingerprint, created_at: { gte: startOfDay() } },
    select: { id: true },
  });
  if (existing) return { stored: false, deduplicated: true, id: existing.id };
  const detail = encodeDetail(r);
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
