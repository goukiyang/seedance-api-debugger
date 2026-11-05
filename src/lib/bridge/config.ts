import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';

/**
 * SD2 生产桥远程配置（插件 0.2.11+ 拉取）。
 * - 规则包：插件发布机离线 Ed25519 签名，服务端只存只转发，并在写入时再验一次签名；
 * - 分组数据：按用户匹配，纯数据（模板、模型名单、开关），插件侧只允许它「关」开关。
 * 存于 PlatformSetting，无需迁移、无需重新部署即可更新。
 */
export const BRIDGE_RULES_KEY = 'bridge_rules_v1';
export const BRIDGE_GROUPS_KEY = 'bridge_groups_v1';
const MAX_BUNDLES = 20;

// 与插件 background/remote-config.js 中 RULES_PUBKEY_B64 一致（公钥，可公开）
const RULES_PUBKEY_B64 = process.env.SD2B_RULES_PUBKEY || 'eYaulGdflO6M5YsUwNJtiuvSWmhPI7xiEqf3tCUag2Y=';

export type SignedBundle = { rules: string; rulesSig: string };
type StoredBundle = SignedBundle & { configVersion: string; minShellVersion: string; channel: string; storedAt: string };
type GroupDef = {
  id: string;
  match?: { emails?: string[]; userIds?: string[]; roles?: string[]; accountTypes?: string[] };
  channel?: 'stable' | 'beta';
  data?: Record<string, unknown>;
};
type GroupsDoc = { default?: { channel?: 'stable' | 'beta'; data?: Record<string, unknown> }; groups?: GroupDef[] };

export function cmpVersion(a: string, b: string) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function bridgeSigningPublicKey() {
  // 32 字节 raw Ed25519 公钥包成 SPKI DER
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(RULES_PUBKEY_B64, 'base64')]), format: 'der', type: 'spki' });
}

export function verifyBundle(b: unknown): { ok: true; bundle: StoredBundle } | { ok: false; error: string } {
  if (!b || typeof b !== 'object') return { ok: false, error: 'bundle 不是对象' };
  const { rules, rulesSig } = b as Record<string, unknown>;
  if (typeof rules !== 'string' || typeof rulesSig !== 'string') return { ok: false, error: '缺 rules / rulesSig' };
  if (rules.length > 200_000) return { ok: false, error: '规则包过大' };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(rules, 'utf8'), bridgeSigningPublicKey(), Buffer.from(rulesSig, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: '签名无效' };
  let pack: Record<string, unknown>;
  try {
    pack = JSON.parse(rules);
  } catch {
    return { ok: false, error: 'rules 不是 JSON' };
  }
  if (pack.schema !== 1 || typeof pack.configVersion !== 'string' || !pack.sites) return { ok: false, error: 'schema/configVersion/sites 不合格' };
  return {
    ok: true,
    bundle: {
      rules,
      rulesSig,
      configVersion: pack.configVersion,
      minShellVersion: typeof pack.minShellVersion === 'string' ? pack.minShellVersion : '0',
      channel: pack.channel === 'beta' ? 'beta' : 'stable',
      storedAt: new Date().toISOString(),
    },
  };
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown, userId: string) {
  const value_json = JSON.stringify(value);
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value_json, updated_by: userId },
    update: { value_json, updated_by: userId },
  });
}

export async function storeBundle(bundle: StoredBundle, userId: string) {
  const list = await readJson<StoredBundle[]>(BRIDGE_RULES_KEY, []);
  const next = [bundle, ...list.filter((b) => !(b.configVersion === bundle.configVersion && b.channel === bundle.channel))].slice(0, MAX_BUNDLES);
  await writeJson(BRIDGE_RULES_KEY, next, userId);
  return next.map(({ configVersion, minShellVersion, channel, storedAt }) => ({ configVersion, minShellVersion, channel, storedAt }));
}

export function parseGroups(doc: unknown): { ok: true; doc: GroupsDoc } | { ok: false; error: string } {
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'groups 不是对象' };
  const d = doc as GroupsDoc;
  if (d.groups && !Array.isArray(d.groups)) return { ok: false, error: 'groups 必须是数组' };
  if (JSON.stringify(d).length > 200_000) return { ok: false, error: '分组数据过大' };
  for (const g of d.groups || []) if (!g || typeof g.id !== 'string') return { ok: false, error: '每个分组需要 id' };
  return { ok: true, doc: d };
}

export async function storeGroups(doc: GroupsDoc, userId: string) {
  await writeJson(BRIDGE_GROUPS_KEY, doc, userId);
}

function matches(g: GroupDef, user: SessionUser) {
  const m = g.match || {};
  const lower = (xs?: string[]) => (xs || []).map((x) => String(x).toLowerCase());
  return (
    lower(m.emails).includes((user.email || '').toLowerCase()) ||
    (m.userIds || []).includes(user.id) ||
    (m.roles || []).includes(user.role) ||
    (m.accountTypes || []).includes(user.account_type)
  );
}

/** 浅合并分组数据；flags 逐项合并 */
function mergeData(base: Record<string, unknown>, extra: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base, ...extra };
  if (base.flags || extra.flags) out.flags = { ...(base.flags as object), ...(extra.flags as object) };
  return out;
}

export async function resolveConfig(user: SessionUser, shellVersion: string, wantChannel: string) {
  const groupsDoc = await readJson<GroupsDoc>(BRIDGE_GROUPS_KEY, {});
  const hit = (groupsDoc.groups || []).filter((g) => matches(g, user));
  let channel: 'stable' | 'beta' = wantChannel === 'beta' ? 'beta' : groupsDoc.default?.channel || 'stable';
  let data: Record<string, unknown> = groupsDoc.default?.data || {};
  for (const g of hit) {
    if (g.channel) channel = g.channel;
    data = mergeData(data, g.data || {});
  }
  const bundles = await readJson<StoredBundle[]>(BRIDGE_RULES_KEY, []);
  const usable = bundles
    .filter((b) => cmpVersion(shellVersion, b.minShellVersion) >= 0)
    .filter((b) => b.channel === 'stable' || channel === 'beta')
    .sort((a, b) => b.storedAt.localeCompare(a.storedAt));
  const pick = usable[0] || null;
  return {
    ok: true,
    schema: 1,
    channel,
    groups: hit.map((g) => g.id),
    ...(pick ? { rules: pick.rules, rulesSig: pick.rulesSig, configVersion: pick.configVersion } : {}),
    data,
  };
}

export async function listBundles() {
  const list = await readJson<StoredBundle[]>(BRIDGE_RULES_KEY, []);
  return list.map(({ configVersion, minShellVersion, channel, storedAt }) => ({ configVersion, minShellVersion, channel, storedAt }));
}
