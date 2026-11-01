import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { cmpVersion } from '@/lib/bridge/config';

/**
 * 插件自更新安装包（开发者模式安装的同事用）：管理员上传签名过的 zip，插件下载后再验签才写盘。
 * 签名内容 = `sd2b-ext\n<version>\n<sha256 hex>`，用与规则包相同的 Ed25519 私钥离线签名。
 * 存 PlatformSetting：bridge_ext_meta_v1（版本/摘要/签名/说明）、bridge_ext_zip_v1（base64 zip）。
 */
const META_KEY = 'bridge_ext_meta_v1';
const ZIP_KEY = 'bridge_ext_zip_v1';
const MAX_ZIP = 3 * 1024 * 1024;
const RULES_PUBKEY_B64 = process.env.SD2B_RULES_PUBKEY || 'eYaulGdflO6M5YsUwNJtiuvSWmhPI7xiEqf3tCUag2Y=';

export type ExtMeta = { version: string; sha256: string; sig: string; notes: string; size: number; minVersion: string; uploadedAt: string };

function publicKey() {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(RULES_PUBKEY_B64, 'base64')]), format: 'der', type: 'spki' });
}

export function signedText(version: string, sha256: string) {
  return `sd2b-ext\n${version}\n${sha256}`;
}

export async function readExtMeta(): Promise<ExtMeta | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: META_KEY } });
  if (!row) return null;
  try { return JSON.parse(row.value_json) as ExtMeta; } catch { return null; }
}

export async function readExtZip(): Promise<Buffer | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: ZIP_KEY } });
  if (!row) return null;
  try { return Buffer.from(JSON.parse(row.value_json) as string, 'base64'); } catch { return null; }
}

export async function storeExtPackage(input: unknown, userId: string): Promise<{ ok: true; meta: ExtMeta } | { ok: false; error: string }> {
  if (!input || typeof input !== 'object') return { ok: false, error: '参数不是对象' };
  const b = input as Record<string, unknown>;
  const version = typeof b.version === 'string' ? b.version.trim() : '';
  const sig = typeof b.sig === 'string' ? b.sig : '';
  const zipB64 = typeof b.zip === 'string' ? b.zip : '';
  if (!/^\d+(\.\d+){1,3}$/.test(version)) return { ok: false, error: '版本号格式不对' };
  const zip = Buffer.from(zipB64, 'base64');
  if (!zip.length || zip.length > MAX_ZIP) return { ok: false, error: '安装包为空或超过 3MB' };
  if (zip.readUInt32LE(0) !== 0x04034b50) return { ok: false, error: '不是 zip 文件' };
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(signedText(version, sha256)), publicKey(), Buffer.from(sig, 'base64')); } catch { valid = false; }
  if (!valid) return { ok: false, error: '签名无效（请用 tools/publish-ext.mjs 生成）' };
  const prev = await readExtMeta();
  if (prev && cmpVersion(version, prev.version) < 0 && b.allowDowngrade !== true) return { ok: false, error: `版本 ${version} 低于当前 ${prev.version}` };
  const meta: ExtMeta = {
    version, sha256, sig, size: zip.length,
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : '',
    minVersion: typeof b.minVersion === 'string' ? b.minVersion : '0.2.13',
    uploadedAt: new Date().toISOString(),
  };
  await prisma.$transaction([
    prisma.platformSetting.upsert({ where: { key: ZIP_KEY }, create: { key: ZIP_KEY, value_json: JSON.stringify(zipB64), updated_by: userId }, update: { value_json: JSON.stringify(zipB64), updated_by: userId } }),
    prisma.platformSetting.upsert({ where: { key: META_KEY }, create: { key: META_KEY, value_json: JSON.stringify(meta), updated_by: userId }, update: { value_json: JSON.stringify(meta), updated_by: userId } }),
  ]);
  return { ok: true, meta };
}
