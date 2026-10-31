import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { getSession, getSessionByToken, type SessionUser } from '@/lib/auth/session';

/**
 * 浮窗工作台短期令牌：插件 SW（带 SD2 Cookie）换取，经 postMessage 交给嵌在浮窗里的 /bridge/panel 页面，
 * 页面用 Authorization: Bearer 调 /api/bridge/*。
 * 令牌 = AES-256-GCM 加密的 { s: 原 session 值, exp, did }，校验时再走 getSessionByToken，
 * 账号停用/改密/过期等现有吊销规则全部继承；令牌本身 15 分钟失效，泄露也拿不到原 session。
 */
const TTL_MS = 15 * 60 * 1000;
const KEY = crypto.createHash('sha256')
  .update(`${process.env.SESSION_SECRET || 'dev-secret-change-in-production'}:sd2b-panel-token:v1`)
  .digest();

export function issuePanelToken(sessionValue: string, deviceId: string) {
  const exp = Date.now() + TTL_MS;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify({ s: sessionValue, exp, did: deviceId.slice(0, 100) }), 'utf8'), c.final()]);
  const token = ['p1', iv.toString('base64url'), body.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
  return { token, expiresAt: exp };
}

function openPanelToken(token: string): { s: string; exp: number; did: string } | null {
  try {
    const [v, iv, body, tag] = token.split('.');
    if (v !== 'p1' || !iv || !body || !tag || token.length > 4096) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const raw = Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
    const p = JSON.parse(raw);
    if (!p || typeof p.s !== 'string' || typeof p.exp !== 'number' || p.exp <= Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

/** bridge 接口统一取用户：优先 Bearer 浮窗令牌，其次 session Cookie */
export async function getBridgeUser(request: NextRequest): Promise<SessionUser | null> {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const p = openPanelToken(auth.slice(7).trim());
    return p ? getSessionByToken(p.s) : null;
  }
  return getSession();
}

/** 只允许扩展发起换令牌：Origin 必须是 chrome-extension://，配置了白名单时还须在名单内 */
export function isAllowedShellOrigin(origin: string | null) {
  if (!origin || !origin.startsWith('chrome-extension://')) return false;
  const allow = (process.env.SD2B_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return true;
  return allow.includes(origin.slice('chrome-extension://'.length).replace(/\/$/, ''));
}
