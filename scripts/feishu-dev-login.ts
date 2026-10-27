import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { FeishuProfile } from '../src/lib/auth/feishu';

async function main() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Development-only command');
  const output = process.argv[2] && path.resolve(process.argv[2]);
  if (!output || !output.startsWith(path.resolve('.role-tests') + path.sep)) throw new Error('Provide a new cookie file under .role-tests');
  const req = createRequire(path.resolve('package.json'));
  const loader = req('node:module');
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (this: unknown, name: string, ...args: unknown[]) {
    return name === 'server-only' ? req.resolve('next/dist/compiled/server-only/empty.js') : Reflect.apply(resolve, this, [name, ...args]);
  };
  const { stdout } = await promisify(execFile)(process.env.LARK_CLI_BIN || 'lark-cli', [
    'api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user', '--format', 'json',
  ], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(stdout), data = value.data || value;
  if (typeof data.open_id !== 'string' || !data.open_id) throw new Error('Verified CLI identity unavailable');
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const profile: FeishuProfile = { openId: data.open_id, userId: text(data.user_id), unionId: text(data.union_id),
    tenantKey: text(data.tenant_key), employeeNo: null, name: text(data.name) || data.open_id, enName: text(data.en_name),
    avatarUrl: text(data.avatar_url), mobile: text(data.mobile), email: text(data.email), emailVerified: data.email_verified === true,
    departmentIds: [], raw: data };
  const { loginWithFeishuProfile } = await import('../src/lib/auth/feishu');
  const { SESSION_COOKIE } = await import('../src/lib/auth/session');
  const { prisma } = await import('../src/lib/prisma');
  try {
    const result = await loginWithFeishuProfile(profile, { method: 'feishu_cli' });
    await writeFile(output, `${SESSION_COOKIE}=${result.token}\n`, { mode: 0o600, flag: 'wx' });
  } finally { await prisma.$disconnect(); }
  console.log('Development session written to the requested private cookie file; no private-prompt identity proof was minted.');
}
main().catch(() => { console.error('Development login failed; no credentials printed.'); process.exitCode = 1; });
