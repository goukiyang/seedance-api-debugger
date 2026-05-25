import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';
import { FeishuAuthError, loginWithFeishuProfile, type FeishuProfile } from '@/lib/auth/feishu';
import { setSessionCookie } from '@/lib/auth/session-cookie';

export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

function envBool(value: string | undefined, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function isLocalRequest(request: NextRequest) {
  const host = request.nextUrl.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isCliLoginEnabled(request: NextRequest) {
  const explicit = process.env.FEISHU_CLI_LOGIN_ENABLED;
  if (explicit != null && explicit !== '') return envBool(explicit);
  return process.env.NODE_ENV !== 'production' && isLocalRequest(request);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseUserInfo(raw: string): FeishuProfile {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const data = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : payload;

  const openId = stringValue(data.open_id);
  if (!openId) throw new FeishuAuthError('飞书 CLI 未返回 open_id', 502, 'cli_open_id_missing');

  return {
    openId,
    userId: stringValue(data.user_id),
    unionId: stringValue(data.union_id),
    tenantKey: stringValue(data.tenant_key),
    employeeNo: null,
    name: stringValue(data.name) || stringValue(data.en_name) || openId,
    enName: stringValue(data.en_name),
    avatarUrl: stringValue(data.avatar_url)
      || stringValue(data.avatar_big)
      || stringValue(data.avatar_middle)
      || stringValue(data.avatar_thumb),
    mobile: stringValue(data.mobile),
    email: stringValue(data.email)?.toLowerCase() || null,
    departmentIds: [],
    raw: data,
  };
}

async function getCliUserProfile() {
  const cliBin = process.env.LARK_CLI_BIN || 'lark-cli';
  const { stdout } = await execFileAsync(cliBin, [
    'api',
    'GET',
    '/open-apis/authen/v1/user_info',
    '--as',
    'user',
    '--format',
    'json',
  ], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return parseUserInfo(stdout);
}

export async function POST(request: NextRequest) {
  if (!isCliLoginEnabled(request)) {
    return NextResponse.json({ error: '飞书 CLI 登录未启用', code: 'cli_login_disabled' }, { status: 403 });
  }

  try {
    const result = await loginWithFeishuProfile(await getCliUserProfile(), {
      autoCreateUser: envBool(process.env.FEISHU_CLI_AUTO_CREATE_USER, true),
    });
    const response = NextResponse.json({ user: result.user });
    return setSessionCookie(response, result.token);
  } catch (error) {
    if (error instanceof FeishuAuthError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[Feishu CLI login]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: '飞书 CLI 登录失败', code: 'cli_login_failed' }, { status: 500 });
  }
}
