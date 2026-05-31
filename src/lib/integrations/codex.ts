import crypto from 'crypto';
import { NextRequest } from 'next/server';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';

export const CODEX_VIDEO_SOURCE_TYPE = 'codex_api';
export const CODEX_VIDEO_API_SETTING_KEY = 'codex_video_api_v1';

type UserSelectorType = 'id' | 'email' | 'username';

export type CodexVideoApiSettings = {
  enabled: boolean;
  source_label: string;
  user_selector: {
    type: UserSelectorType;
    value: string;
  };
  token_hash: string | null;
  token_preview: string | null;
};

export type CodexVideoApiSettingsInput = Partial<CodexVideoApiSettings> & {
  token?: unknown;
  clear_token?: unknown;
  user_id?: unknown;
  user_email?: unknown;
  username?: unknown;
};

export type CodexVideoApiSettingsSaveResult = {
  settings: CodexVideoApiSettings;
  token_changed: boolean;
  token_cleared: boolean;
};

export type GenerationRequestSource = {
  source_type: 'web' | typeof CODEX_VIDEO_SOURCE_TYPE;
  source_label: string;
  source_request_id: string | null;
  source_metadata: Record<string, unknown>;
};

export class CodexApiAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

const DEFAULT_CODEX_VIDEO_API_SETTINGS: CodexVideoApiSettings = {
  enabled: false,
  source_label: 'Codex API',
  user_selector: {
    type: 'email',
    value: 'admin@local.test',
  },
  token_hash: null,
  token_preview: null,
};

const CODEX_USER_SELECT = {
  id: true,
  name: true,
  username: true,
  email: true,
  role: true,
  account_type: true,
  user_profile: true,
  feature_profile_id: true,
  status: true,
  expires_at: true,
  mobile: true,
  avatar_url: true,
  feishu_user_id: true,
  feishu_open_id: true,
  feishu_union_id: true,
  feishu_tenant_key: true,
  feishu_employee_no: true,
  feishu_department_ids: true,
  last_feishu_sync_at: true,
} satisfies Prisma.UserSelect;

type CodexLinkedUser = Pick<User,
  | 'id'
  | 'name'
  | 'username'
  | 'email'
  | 'role'
  | 'account_type'
  | 'user_profile'
  | 'feature_profile_id'
  | 'status'
  | 'expires_at'
  | 'mobile'
  | 'avatar_url'
  | 'feishu_user_id'
  | 'feishu_open_id'
  | 'feishu_union_id'
  | 'feishu_tenant_key'
  | 'feishu_employee_no'
  | 'feishu_department_ids'
  | 'last_feishu_sync_at'
>;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSelector(input: unknown): CodexVideoApiSettings['user_selector'] {
  const source = input && typeof input === 'object'
    ? input as Partial<CodexVideoApiSettings['user_selector']>
    : {};
  const type = source.type === 'id' || source.type === 'username' ? source.type : 'email';
  const rawValue = typeof source.value === 'string' ? source.value.trim() : '';
  const fallback = DEFAULT_CODEX_VIDEO_API_SETTINGS.user_selector.value;

  return {
    type,
    value: type === 'email'
      ? (rawValue || fallback).toLowerCase()
      : rawValue,
  };
}

function normalizeTokenHash(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^sha256:[a-f0-9]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeSettings(value: unknown): CodexVideoApiSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<CodexVideoApiSettings>
    : {};
  const selector = normalizeSelector(input.user_selector);

  return {
    enabled: input.enabled === true,
    source_label: cleanString(input.source_label, DEFAULT_CODEX_VIDEO_API_SETTINGS.source_label).slice(0, 80),
    user_selector: selector.value ? selector : DEFAULT_CODEX_VIDEO_API_SETTINGS.user_selector,
    token_hash: normalizeTokenHash(input.token_hash),
    token_preview: cleanString(input.token_preview, '').slice(0, 24) || null,
  };
}

export function tokenPreview(token: string) {
  const trimmed = token.trim();
  if (trimmed.length <= 8) return '已设置';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function hashCodexApiToken(token: string) {
  return `sha256:${crypto.createHash('sha256').update(token.trim()).digest('hex')}`;
}

function timingSafeEqualString(input: string, expected: string) {
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  return inputBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function bearerToken(request: NextRequest) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim()) return match[1].trim();
  return request.headers.get('x-codex-api-token')?.trim() || '';
}

function sourceRequestId(request: NextRequest) {
  return request.headers.get('x-codex-request-id')?.trim()
    || request.headers.get('x-request-id')?.trim()
    || null;
}

export function hasCodexApiAuthSignal(request: NextRequest) {
  return Boolean(bearerToken(request));
}

export async function getCodexVideoApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<CodexVideoApiSettings> {
  const setting = await client.platformSetting.findUnique({ where: { key: CODEX_VIDEO_API_SETTING_KEY } });
  if (!setting) return DEFAULT_CODEX_VIDEO_API_SETTINGS;

  try {
    return normalizeSettings(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_CODEX_VIDEO_API_SETTINGS;
  }
}

export function buildCodexVideoApiSettingsPatch(
  current: CodexVideoApiSettings,
  input: CodexVideoApiSettingsInput,
): CodexVideoApiSettingsSaveResult {
  const nextInput: Partial<CodexVideoApiSettings> = {
    ...current,
    enabled: input.enabled === true,
    source_label: cleanString(input.source_label, current.source_label),
    user_selector: normalizeSelector(input.user_selector || {
      type: typeof input.user_id === 'string' && input.user_id.trim()
        ? 'id'
        : typeof input.username === 'string' && input.username.trim()
          ? 'username'
          : 'email',
      value: typeof input.user_id === 'string' && input.user_id.trim()
        ? input.user_id
        : typeof input.username === 'string' && input.username.trim()
          ? input.username
          : typeof input.user_email === 'string' && input.user_email.trim()
            ? input.user_email
            : current.user_selector.value,
    }),
  };
  let tokenChanged = false;
  let tokenCleared = false;

  if (input.clear_token === true) {
    nextInput.token_hash = null;
    nextInput.token_preview = null;
    tokenCleared = Boolean(current.token_hash);
  } else if (typeof input.token === 'string' && input.token.trim()) {
    nextInput.token_hash = hashCodexApiToken(input.token);
    nextInput.token_preview = tokenPreview(input.token);
    tokenChanged = nextInput.token_hash !== current.token_hash;
  }

  return {
    settings: normalizeSettings(nextInput),
    token_changed: tokenChanged,
    token_cleared: tokenCleared,
  };
}

export async function saveCodexVideoApiSettings(
  input: CodexVideoApiSettingsInput,
  updatedBy: string,
) {
  const current = await getCodexVideoApiSettings();
  const result = buildCodexVideoApiSettingsPatch(current, input);
  await prisma.platformSetting.upsert({
    where: { key: CODEX_VIDEO_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(result.settings),
      updated_by: updatedBy,
    },
    create: {
      key: CODEX_VIDEO_API_SETTING_KEY,
      value_json: JSON.stringify(result.settings),
      updated_by: updatedBy,
    },
  });
  return result;
}

function selectorWhere(selector: CodexVideoApiSettings['user_selector']): Prisma.UserWhereInput {
  if (selector.type === 'id') return { id: selector.value };
  if (selector.type === 'username') return { username: selector.value };
  return { email: selector.value.toLowerCase() };
}

export async function resolveCodexLinkedUser(
  settings: CodexVideoApiSettings,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  if (!settings.user_selector.value) return null;
  return client.user.findFirst({
    where: selectorWhere(settings.user_selector),
    select: CODEX_USER_SELECT,
  });
}

export function codexRequestSource(
  request: NextRequest,
  settings: Pick<CodexVideoApiSettings, 'source_label'>,
): GenerationRequestSource {
  return {
    source_type: CODEX_VIDEO_SOURCE_TYPE,
    source_label: settings.source_label,
    source_request_id: sourceRequestId(request),
    source_metadata: {
      interface: 'codex',
      auth: 'bearer',
      config_source: 'platform_setting',
      setting_key: CODEX_VIDEO_API_SETTING_KEY,
      user_agent: request.headers.get('user-agent') || null,
      path: request.nextUrl.pathname,
    },
  };
}

export function webRequestSource(request: NextRequest): GenerationRequestSource {
  return {
    source_type: 'web',
    source_label: 'Web UI',
    source_request_id: request.headers.get('x-request-id')?.trim() || null,
    source_metadata: {
      interface: 'web',
      user_agent: request.headers.get('user-agent') || null,
      path: request.nextUrl.pathname,
    },
  };
}

function validateLinkedUser(user: CodexLinkedUser | null): asserts user is CodexLinkedUser {
  if (!user) {
    throw new CodexApiAuthError('Codex 视频接口绑定用户不存在', 503, 'codex_api_user_not_found');
  }
  if (user.status !== 'active') {
    throw new CodexApiAuthError('Codex 视频接口绑定用户不可用', 403, 'codex_api_user_inactive');
  }
  if (user.expires_at && user.expires_at.getTime() <= Date.now()) {
    throw new CodexApiAuthError('Codex 视频接口绑定用户已过期', 403, 'codex_api_user_expired');
  }
  if (user.role !== 'admin' && user.role !== 'user') {
    throw new CodexApiAuthError('Codex 视频接口绑定用户角色无效', 403, 'codex_api_user_invalid_role');
  }
  if (user.account_type !== 'internal' && user.account_type !== 'external') {
    throw new CodexApiAuthError('Codex 视频接口绑定用户类型无效', 403, 'codex_api_user_invalid_account_type');
  }
}

function toSessionUser(user: CodexLinkedUser): SessionUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role as SessionUser['role'],
    account_type: user.account_type as SessionUser['account_type'],
    user_profile: user.user_profile,
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
      department_ids: parseJsonArray(user.feishu_department_ids),
      last_sync_at: user.last_feishu_sync_at,
    },
  };
}

export async function authenticateCodexVideoApi(request: NextRequest) {
  const settings = await getCodexVideoApiSettings();
  if (!settings.enabled) {
    throw new CodexApiAuthError('Codex 视频接口未在后台启用', 503, 'codex_api_disabled');
  }
  if (!settings.token_hash) {
    throw new CodexApiAuthError('Codex 视频接口未在后台配置 token', 503, 'codex_api_not_configured');
  }

  const token = bearerToken(request);
  const tokenHash = token ? hashCodexApiToken(token) : '';
  if (!token || !timingSafeEqualString(tokenHash, settings.token_hash)) {
    throw new CodexApiAuthError('Codex 视频接口 token 无效', 401, 'codex_api_invalid_token');
  }

  const user = await resolveCodexLinkedUser(settings);
  validateLinkedUser(user);

  return {
    user: toSessionUser(user),
    source: codexRequestSource(request, settings),
    settings,
  };
}

export async function codexVideoApiStatus() {
  const settings = await getCodexVideoApiSettings();
  const linkedUser = await resolveCodexLinkedUser(settings);
  return {
    enabled: settings.enabled,
    ready: settings.enabled && Boolean(settings.token_hash) && Boolean(linkedUser && linkedUser.status === 'active'),
    source_type: CODEX_VIDEO_SOURCE_TYPE,
    source_label: settings.source_label,
    token_configured: Boolean(settings.token_hash),
    token_preview: settings.token_preview,
    user_selector: settings.user_selector,
    linked_user: linkedUser ? {
      id: linkedUser.id,
      username: linkedUser.username,
      email: linkedUser.email,
      role: linkedUser.role,
      status: linkedUser.status,
    } : null,
  };
}
