import crypto from 'crypto';
import type { Prisma, User } from '@prisma/client';
import { grantInitialCredits } from '@/lib/credits/policy';
import { prisma } from '@/lib/prisma';
import { getDefaultFeatureProfileId } from '@/lib/users/profiles';
import { hashPassword } from './password';
import { type SessionUser } from './session';
import { completeLogin } from './complete-login';
import { requireSecret } from '@/lib/security/secrets';
import { accountSessionDigest, SESSION_IDLE_MS, type SessionDevice } from './session-store';

const DEFAULT_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const DEFAULT_OPENAPI_BASE_URL = 'https://open.feishu.cn';
const DEFAULT_SCOPE = 'auth:user.id:read user_profile';
const FEISHU_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const TOKEN_CACHE_SKEW_MS = 5 * 60 * 1000;

export const FEISHU_STATE_COOKIE = 'feishu_oauth_state';

type TokenCache = {
  token: string;
  expiresAt: number;
};

type FeishuConfig = {
  enabled: boolean;
  appId: string;
  appSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  openApiBaseUrl: string;
  scope: string;
  autoCreateUser: boolean;
  allowedTenantKey: string | null;
  allowedDepartmentIds: string[];
};

export type FeishuProfile = {
  openId: string;
  userId: string | null;
  unionId: string | null;
  tenantKey: string | null;
  employeeNo: string | null;
  name: string;
  enName: string | null;
  avatarUrl: string | null;
  mobile: string | null;
  email: string | null;
  emailVerified?: boolean;
  departmentIds: string[];
  raw: Record<string, unknown>;
};

export type FeishuOAuthState = {
  state: string;
  next: string;
  binding?: { userId: string; sessionDigest: string };
};

type CompleteLoginOptions = {
  autoCreateUser?: boolean;
  binding?: { userId: string; sessionDigest: string };
  device?: SessionDevice;
  method?: 'feishu_cli';
};

export class FeishuAuthError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'feishu_login_failed',
  ) {
    super(message);
  }
}

let tenantAccessTokenCache: TokenCache | null = null;

function envBool(value: string | undefined, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function isFeishuCliLoginEnabledForHost(hostname: string) {
  return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function splitEnvList(value: string | undefined) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAuthSecret() {
  return requireSecret('feishuState');
}

function signPayload(payload: string) {
  return crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('base64url');
}

function safeRedirectPath(value: unknown, fallback = '') {
  if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  return trimmed;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function extractData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  if (record.data && typeof record.data === 'object') return record.data as Record<string, unknown>;
  return record;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, '');
}

export function getFeishuConfig(requestOrigin?: string): FeishuConfig {
  const redirectUri = process.env.FEISHU_REDIRECT_URI
    || (process.env.NODE_ENV !== 'production' && requestOrigin ? `${requestOrigin}/api/auth/feishu/callback` : '');

  return {
    enabled: envBool(process.env.FEISHU_LOGIN_ENABLED, false),
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    redirectUri,
    authorizeUrl: process.env.FEISHU_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL,
    openApiBaseUrl: normalizeBaseUrl(process.env.FEISHU_OPENAPI_BASE_URL || DEFAULT_OPENAPI_BASE_URL),
    scope: process.env.FEISHU_SCOPE || DEFAULT_SCOPE,
    autoCreateUser: envBool(process.env.FEISHU_AUTO_CREATE_USER, false),
    allowedTenantKey: stringValue(process.env.FEISHU_ALLOWED_TENANT_KEY),
    allowedDepartmentIds: splitEnvList(process.env.FEISHU_ALLOWED_DEPARTMENT_IDS),
  };
}

function assertConfigReady(config: FeishuConfig) {
  if (!config.enabled) throw new FeishuAuthError('飞书登录暂未启用', 503, 'disabled');
  if (!config.appId || !config.appSecret || !config.redirectUri) {
    throw new FeishuAuthError('飞书登录配置不完整', 503, 'not_configured');
  }
}

export function buildFeishuAuthorizeUrl(state: string, requestOrigin?: string) {
  const config = getFeishuConfig(requestOrigin);
  assertConfigReady(config);

  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  if (config.scope) url.searchParams.set('scope', config.scope);
  return url.toString();
}

export function createFeishuOAuthState(nextValue: unknown, binding?: FeishuOAuthState['binding']) {
  const state = crypto.randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    state,
    next: safeRedirectPath(nextValue, ''),
    createdAt: Date.now(),
    ...(binding ? { binding } : {}),
  })).toString('base64url');
  const signature = signPayload(payload);
  return {
    state,
    cookieValue: `${payload}.${signature}`,
    maxAgeSeconds: FEISHU_STATE_MAX_AGE_MS / 1000,
  };
}

export function verifyFeishuOAuthState(cookieValue: string | undefined, returnedState: string | null): FeishuOAuthState | null {
  if (!cookieValue || !returnedState) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  const expected = signPayload(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      state?: unknown;
      next?: unknown;
      createdAt?: unknown;
      binding?: unknown;
    };
    if (parsed.state !== returnedState) return null;
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) || parsed.createdAt > Date.now() + 1000 || Date.now() - parsed.createdAt >= FEISHU_STATE_MAX_AGE_MS) {
      return null;
    }
    let binding: FeishuOAuthState['binding'];
    if (parsed.binding !== undefined) {
      const value = parsed.binding as { userId?: unknown; sessionDigest?: unknown };
      if (!value || typeof value.userId !== 'string' || !value.userId || typeof value.sessionDigest !== 'string' || !/^[a-f\d]{64}$/.test(value.sessionDigest)) return null;
      binding = { userId: value.userId, sessionDigest: value.sessionDigest };
    }
    return {
      state: returnedState,
      next: safeRedirectPath(parsed.next, ''),
      ...(binding ? { binding } : {}),
    };
  } catch {
    return null;
  }
}

async function feishuJson(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new FeishuAuthError('飞书接口请求失败', 502, 'feishu_http_error');
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.code === 'number' && record.code !== 0) {
      throw new FeishuAuthError('飞书接口返回失败', 502, `feishu_${record.code}`);
    }
  }
  return payload;
}

function cacheToken(token: string, expiresInSeconds: unknown): TokenCache {
  const seconds = typeof expiresInSeconds === 'number' && expiresInSeconds > 0 ? expiresInSeconds : 7200;
  return {
    token,
    expiresAt: Date.now() + seconds * 1000 - TOKEN_CACHE_SKEW_MS,
  };
}

async function getTenantAccessToken(config: FeishuConfig) {
  if (tenantAccessTokenCache && tenantAccessTokenCache.expiresAt > Date.now()) return tenantAccessTokenCache.token;

  const payload = await feishuJson(`${config.openApiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret,
    }),
  });
  const data = extractData(payload);
  const token = stringValue(data.tenant_access_token);
  if (!token) throw new FeishuAuthError('飞书 tenant_access_token 获取失败', 502, 'tenant_token_missing');

  tenantAccessTokenCache = cacheToken(token, data.expire ?? data.expires_in);
  return token;
}

async function exchangeCodeForUserAccessToken(code: string, config: FeishuConfig) {
  const payload = await feishuJson(`${config.openApiBaseUrl}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const data = extractData(payload);
  const token = stringValue(data.access_token);
  if (!token) throw new FeishuAuthError('飞书 user_access_token 获取失败', 502, 'user_token_missing');
  return token;
}

function normalizeProfile(rawValue: unknown): FeishuProfile {
  const raw = extractData(rawValue);
  const openId = stringValue(raw.open_id) || stringValue(raw.sub);
  if (!openId) throw new FeishuAuthError('飞书用户信息缺少 open_id', 502, 'open_id_missing');

  const name = stringValue(raw.name)
    || stringValue(raw.en_name)
    || stringValue(raw.email)
    || stringValue(raw.mobile)
    || openId;

  return {
    openId,
    userId: stringValue(raw.user_id),
    unionId: stringValue(raw.union_id),
    tenantKey: stringValue(raw.tenant_key),
    employeeNo: stringValue(raw.employee_no),
    name,
    enName: stringValue(raw.en_name),
    avatarUrl: stringValue(raw.avatar_url) || stringValue(raw.picture),
    mobile: stringValue(raw.mobile),
    email: stringValue(raw.email)?.toLowerCase() || null,
    emailVerified: raw.email_verified === true,
    departmentIds: stringArray(raw.department_ids),
    raw,
  };
}

async function getFeishuUserInfo(userAccessToken: string, config: FeishuConfig) {
  const payload = await feishuJson(`${config.openApiBaseUrl}/open-apis/authen/v1/user_info`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  return normalizeProfile(payload);
}

function mergeContactProfile(base: FeishuProfile, contactRaw: Record<string, unknown>): FeishuProfile {
  const user = contactRaw.user && typeof contactRaw.user === 'object'
    ? contactRaw.user as Record<string, unknown>
    : contactRaw;

  const avatar = user.avatar && typeof user.avatar === 'object'
    ? user.avatar as Record<string, unknown>
    : {};

  return {
    ...base,
    userId: stringValue(user.user_id) || base.userId,
    unionId: stringValue(user.union_id) || base.unionId,
    employeeNo: stringValue(user.employee_no) || base.employeeNo,
    name: stringValue(user.name) || base.name,
    enName: stringValue(user.en_name) || base.enName,
    avatarUrl: stringValue(user.avatar_url)
      || stringValue(avatar.avatar_640)
      || stringValue(avatar.avatar_240)
      || stringValue(avatar.avatar_72)
      || base.avatarUrl,
    mobile: stringValue(user.mobile) || base.mobile,
    // Contact-directory email alone is not proof of mailbox verification.
    email: base.email,
    departmentIds: stringArray(user.department_ids).length > 0
      ? stringArray(user.department_ids)
      : base.departmentIds,
    raw: {
      ...base.raw,
      contact_user: user,
    },
  };
}

async function enrichFeishuProfile(profile: FeishuProfile, config: FeishuConfig) {
  const userId = profile.userId || profile.openId;
  const userIdType = profile.userId ? 'user_id' : 'open_id';
  const tenantAccessToken = await getTenantAccessToken(config);
  const url = new URL(`${config.openApiBaseUrl}/open-apis/contact/v3/users/${encodeURIComponent(userId)}`);
  url.searchParams.set('user_id_type', userIdType);
  url.searchParams.set('department_id_type', 'open_department_id');

  const payload = await feishuJson(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  return mergeContactProfile(profile, extractData(payload));
}

function enforceFeishuAccessPolicy(profile: FeishuProfile, config: FeishuConfig) {
  if (process.env.NODE_ENV === 'production' && !config.allowedTenantKey) {
    throw new FeishuAuthError('飞书登录配置不完整', 503, 'tenant_not_configured');
  }
  if (config.allowedTenantKey && profile.tenantKey !== config.allowedTenantKey) {
    throw new FeishuAuthError('当前飞书企业未被允许登录', 403, 'tenant_not_allowed');
  }

  if (config.allowedDepartmentIds.length > 0) {
    const departmentSet = new Set(profile.departmentIds);
    const allowed = config.allowedDepartmentIds.some((departmentId) => departmentSet.has(departmentId));
    if (!allowed) throw new FeishuAuthError('当前飞书部门未被允许登录', 403, 'department_not_allowed');
  }
}

function maskValue(value: string, visiblePrefix = 2, visibleSuffix = 2) {
  if (value.length <= visiblePrefix + visibleSuffix) return '*'.repeat(value.length);
  return `${value.slice(0, visiblePrefix)}***${value.slice(-visibleSuffix)}`;
}

function redactRawProfile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRawProfile);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (typeof item === 'string' && lowerKey.includes('mobile')) {
      result[key] = maskValue(item, 3, 2);
    } else if (typeof item === 'string' && lowerKey.includes('email')) {
      const [name, domain] = item.split('@');
      result[key] = domain ? `${maskValue(name, 1, 1)}@${domain}` : maskValue(item);
    } else if (lowerKey.includes('token') || lowerKey.includes('secret')) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactRawProfile(item);
    }
  }
  return result;
}

function safeProfileJson(profile: FeishuProfile) {
  const json = JSON.stringify(redactRawProfile(profile.raw));
  return json.length > 12000 ? `${json.slice(0, 12000)}...` : json;
}

function usernameBase(profile: FeishuProfile) {
  const rawBase = profile.email?.split('@')[0]
    || profile.mobile
    || profile.employeeNo
    || profile.userId
    || profile.openId;
  const normalized = rawBase.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || `feishu_${profile.openId.slice(-8).toLowerCase()}`;
}

async function generateUniqueUsername(tx: Prisma.TransactionClient, profile: FeishuProfile) {
  const base = usernameBase(profile);
  for (let index = 0; index < 50; index += 1) {
    const candidate = index === 0 ? base : `${base}${index + 1}`;
    const existing = await tx.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function fallbackEmail(profile: FeishuProfile) {
  const identifier = (profile.userId || profile.openId).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `feishu_${identifier}@feishu.local`;
}

async function resolveCreateEmail(tx: Prisma.TransactionClient, profile: FeishuProfile) {
  if (profile.email) {
    const conflict = await tx.user.findUnique({ where: { email: profile.email }, select: { id: true } });
    if (!conflict) return profile.email;
  }

  const base = fallbackEmail(profile);
  const [name, domain] = base.split('@');
  for (let index = 0; index < 50; index += 1) {
    const candidate = index === 0 ? base : `${name}${index + 1}@${domain}`;
    const existing = await tx.user.findUnique({ where: { email: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  return `${name}_${Date.now().toString(36)}@${domain}`;
}

async function findFeishuUser(tx: Prisma.TransactionClient, profile: FeishuProfile, binding?: CompleteLoginOptions['binding']) {
  const conditions: Prisma.UserWhereInput[] = [
    ...(profile.userId ? [{ feishu_user_id: profile.userId }] : []),
    { feishu_open_id: profile.openId },
  ];
  const matches = await tx.user.findMany({
    where: { OR: conditions },
    take: 2,
  });
  if (matches.length > 1) {
    throw new FeishuAuthError('飞书身份已绑定到多个账号，请联系管理员', 409, 'identity_conflict');
  }
  if (matches[0]) {
    const user = matches[0];
    if ((user.feishu_tenant_key && user.feishu_tenant_key !== profile.tenantKey)
      || (!user.feishu_open_id && user.feishu_tenant_key !== profile.tenantKey)
      || (user.feishu_open_id && user.feishu_open_id !== profile.openId)
      || (user.feishu_user_id && user.feishu_user_id !== profile.userId)
      || (binding && binding.userId !== user.id)) {
      throw new FeishuAuthError('飞书身份绑定不一致，请联系管理员', 409, 'identity_conflict');
    }
    return user;
  }

  if (binding) {
    const current = await tx.userSession.findUnique({ where: { token_digest: binding.sessionDigest }, include: { user: true } });
    const now = new Date();
    if (!current || current.user_id !== binding.userId || current.revoked_at || current.expires_at <= now
      || current.last_activity_at.getTime() <= now.getTime() - SESSION_IDLE_MS
      || current.account_digest !== accountSessionDigest(current.user)) {
      throw new FeishuAuthError('请重新登录原账号后确认绑定', 401, 'binding_session_expired');
    }
    if (current.user.feishu_open_id || current.user.feishu_user_id) {
      throw new FeishuAuthError('原账号已绑定其他飞书身份', 409, 'identity_conflict');
    }
    return current.user;
  }

  if (profile.email) {
    const emailUser = await tx.user.findUnique({ where: { email: profile.email } });
    if (emailUser) {
      if (
        (emailUser.feishu_user_id && emailUser.feishu_user_id !== profile.userId) ||
        (emailUser.feishu_open_id && emailUser.feishu_open_id !== profile.openId)
      ) {
        throw new FeishuAuthError('邮箱对应账号已绑定其他飞书身份，请联系管理员', 409, 'identity_conflict');
      }
      if (emailUser.auth_origin === 'admin' && profile.emailVerified === true && profile.tenantKey === process.env.FEISHU_ALLOWED_TENANT_KEY) return emailUser;
      throw new FeishuAuthError('请先登录原账号，再在个人资料中确认绑定飞书', 409, 'binding_required');
    }
  }

  return null;
}

async function syncExistingUser(tx: Prisma.TransactionClient, user: User, profile: FeishuProfile) {
  if (user.status === 'disabled') throw new FeishuAuthError('账号已被禁用', 403, 'user_disabled');
  if (user.status === 'expired') throw new FeishuAuthError('账号已过期', 403, 'user_expired');
  if (user.status !== 'active') throw new FeishuAuthError('账号暂不可登录', 403, 'user_not_active');
  if (user.expires_at && user.expires_at.getTime() <= Date.now()) {
    throw new FeishuAuthError('账号已过期', 403, 'user_expired');
  }

  const data: Prisma.UserUpdateInput = {
    name: profile.name,
    mobile: profile.mobile,
    // A custom or initials avatar chosen by the user survives Feishu sign-in.
    ...(user.avatar_source === 'custom' || user.avatar_source === 'initials' ? {} : { avatar_url: profile.avatarUrl }),
    feishu_avatar_url: profile.avatarUrl,
    feishu_user_id: profile.userId,
    feishu_open_id: profile.openId,
    feishu_union_id: profile.unionId,
    feishu_tenant_key: profile.tenantKey,
    feishu_employee_no: profile.employeeNo,
    feishu_department_ids: JSON.stringify(profile.departmentIds),
    feishu_raw_profile: safeProfileJson(profile),
    last_feishu_sync_at: new Date(),
    last_login_at: new Date(),
  };

  if (profile.emailVerified === true && profile.email && profile.email !== user.email) {
    const conflict = await tx.user.findUnique({ where: { email: profile.email }, select: { id: true } });
    if (!conflict) data.email = profile.email;
  }

  const updated = await tx.user.update({
    where: { id: user.id },
    data,
  });

  await tx.operationLog.create({
    data: {
      operator_id: user.id,
        action: 'feishu_profile_sync',
      target_type: 'User',
      target_id: user.id,
      detail: JSON.stringify({
        source: 'feishu',
        auto_created: false,
        tenant_key: profile.tenantKey,
        department_ids: profile.departmentIds,
      }),
    },
  });

  return updated;
}

async function createFeishuUser(tx: Prisma.TransactionClient, profile: FeishuProfile, passwordHash: string) {
  const username = await generateUniqueUsername(tx, profile);
  const email = await resolveCreateEmail(tx, profile);
  const featureProfileId = getDefaultFeatureProfileId('internal', 'other');

  const user = await tx.user.create({
    data: {
      name: profile.name,
      username,
      email,
      password_hash: passwordHash,
      auth_origin: 'feishu',
      email_verified_at: profile.emailVerified ? new Date() : null,
      role: 'user',
      account_type: 'internal',
      user_profile: 'other',
      feature_profile_id: featureProfileId,
      status: 'active',
      mobile: profile.mobile,
      avatar_url: profile.avatarUrl,
      feishu_avatar_url: profile.avatarUrl,
      feishu_user_id: profile.userId,
      feishu_open_id: profile.openId,
      feishu_union_id: profile.unionId,
      feishu_tenant_key: profile.tenantKey,
      feishu_employee_no: profile.employeeNo,
      feishu_department_ids: JSON.stringify(profile.departmentIds),
      feishu_raw_profile: safeProfileJson(profile),
      last_feishu_sync_at: new Date(),
      last_login_at: new Date(),
    },
  });

  await tx.creditAccount.create({
    data: {
      user_id: user.id,
      balance: 0,
      frozen_credits: 0,
    },
  });

  await grantInitialCredits(tx, user, 'feishu_auto_create', {
    operatorId: user.id,
    reason: '飞书新用户初始点数',
  });

  const project = await tx.project.create({
    data: {
      name: '我的默认项目',
      description: '系统自动创建的个人默认项目',
      type: 'personal',
      visibility: 'private',
      owner_user_id: user.id,
      created_by: user.id,
      status: 'active',
    },
  });

  await tx.projectMember.create({
    data: {
      project_id: project.id,
      user_id: user.id,
      role: 'project_owner',
      joined_by: user.id,
    },
  });

  await tx.operationLog.createMany({
    data: [
      {
        operator_id: user.id,
        action: 'feishu_auto_create_user',
        target_type: 'User',
        target_id: user.id,
        detail: JSON.stringify({
          source: 'feishu',
          account_type: 'internal',
          user_profile: 'other',
          feature_profile_id: featureProfileId,
          tenant_key: profile.tenantKey,
          department_ids: profile.departmentIds,
        }),
      },
      {
        operator_id: user.id,
        action: 'project_create_default',
        target_type: 'project',
        target_id: project.id,
        detail: JSON.stringify({ type: 'personal', source: 'feishu_auto_create_user' }),
      },
    ],
  });

  return user;
}

function parseDepartmentIds(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role === 'admin' ? 'admin' : 'user',
    account_type: user.account_type === 'external' ? 'external' : 'internal',
    user_profile: user.user_profile || 'other',
    feature_profile_id: user.feature_profile_id,
    status: 'active',
    expires_at: user.expires_at,
    mobile: user.mobile,
    avatar_url: user.avatar_url,
    feishu: {
      user_id: user.feishu_user_id,
      open_id: user.feishu_open_id,
      union_id: user.feishu_union_id,
      tenant_key: user.feishu_tenant_key,
      employee_no: user.feishu_employee_no,
      department_ids: parseDepartmentIds(user.feishu_department_ids),
      last_sync_at: user.last_feishu_sync_at,
    },
  };
}

async function completeFeishuLogin(profileInput: FeishuProfile, config: FeishuConfig, options?: CompleteLoginOptions) {
  let profile = profileInput;
  try {
    profile = await enrichFeishuProfile(profile, config);
  } catch (error) {
    if (config.allowedDepartmentIds.length > 0) {
      throw new FeishuAuthError('无法校验飞书部门权限', 502, 'department_check_unavailable');
    }
    console.warn('[Feishu login] contact profile sync skipped', error instanceof Error ? error.message : 'unknown error');
  }

  enforceFeishuAccessPolicy(profile, config);

  const passwordHash = await hashPassword(crypto.randomBytes(32).toString('base64url'));
  return prisma.$transaction(async (tx) => {
    const existing = await findFeishuUser(tx, profile, options?.binding);
    if (existing) {
      const user = await syncExistingUser(tx, existing, profile);
      return completeLogin({ userId: user.id, device: options?.device }, options?.binding ? 'feishu_bind' : options?.method || 'feishu', tx);
    }
    const autoCreateUser = options?.autoCreateUser ?? config.autoCreateUser;
    if (!autoCreateUser) {
      throw new FeishuAuthError('飞书账号未开通，请联系管理员', 403, 'not_provisioned');
    }
    const user = await createFeishuUser(tx, profile, passwordHash);
    return completeLogin({ userId: user.id, device: options?.device }, options?.method || 'feishu', tx);
  });
}

export async function loginWithFeishuProfile(profile: FeishuProfile, options?: CompleteLoginOptions) {
  const config = getFeishuConfig();
  return completeFeishuLogin(profile, config, options);
}

export async function loginWithFeishuCode(code: string, requestOrigin?: string, options?: CompleteLoginOptions) {
  const config = getFeishuConfig(requestOrigin);
  assertConfigReady(config);

  const userAccessToken = await exchangeCodeForUserAccessToken(code, config);
  const profile = await getFeishuUserInfo(userAccessToken, config);
  const result = await completeFeishuLogin(profile, config, options);
  const { signVerifiedFeishuIdentity } = await import('@/lib/security/private-prompt-identity.server');
  let privateIdentityProof: string | null = null;
  try {
    privateIdentityProof = signVerifiedFeishuIdentity({ userId: result.user.id, role: result.user.role,
      tenant: profile.tenantKey, subject: profile.openId }, result.token);
  } catch {
    // Unavailable private storage must not block ordinary account login.
  }
  return { ...result, privateIdentityProof };
}
