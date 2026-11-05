import crypto from 'node:crypto';
import { bridgeSigningPublicKey } from './config';

export const BRIDGE_RELEASE_BASE = 'https://sd2.youdooart.com/ext/mj/sd2b/';
type Artifact = { url: string; sha256: string; size: number; key?: string; platform?: string; arch?: string };
export type BridgeRelease = { version: string; publishedAt: string; notes: string; extension: Artifact; desktop: Artifact[] };

export function parseBridgeRelease(envelope: unknown): BridgeRelease {
  const fail = () => { throw new Error('安装包清单校验失败，请稍后重新读取'); };
  if (!envelope || typeof envelope !== 'object') return fail();
  const signed = envelope as { payload?: unknown; sig?: unknown };
  if (typeof signed.payload !== 'string' || signed.payload.length > 200000 || typeof signed.sig !== 'string') return fail();
  if (!crypto.verify(null, Buffer.from(`sd2b-release\n${signed.payload}`), bridgeSigningPublicKey(), Buffer.from(signed.sig, 'base64'))) return fail();
  const data = JSON.parse(signed.payload);
  if (data.schema !== 1 || !/^\d+(\.\d+){1,3}$/.test(data.version) || typeof data.notes !== 'string'
    || typeof data.publishedAt !== 'string' || !Number.isFinite(Date.parse(data.publishedAt))
    || !Array.isArray(data.extensions) || !Array.isArray(data.desktop)) return fail();
  for (const artifact of [...data.extensions, ...data.desktop]) {
    if (!artifact || typeof artifact.url !== 'string' || !artifact.url.startsWith(`${BRIDGE_RELEASE_BASE}${data.version}/`)
      || new URL(artifact.url).href !== artifact.url || /[?#]/.test(artifact.url) || !artifact.url.endsWith('.zip')
      || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) return fail();
  }
  const extensions = data.extensions.filter((a: Artifact) => typeof a.key === 'string' && a.key.length > 0);
  const platforms = [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']];
  if (extensions.length !== 1 || platforms.some(([platform, arch]) => data.desktop.filter((a: Artifact) => a.platform === platform && a.arch === arch).length !== 1)) return fail();
  return { version: data.version, publishedAt: data.publishedAt, notes: data.notes, extension: extensions[0],
    desktop: platforms.map(([platform, arch]) => data.desktop.find((a: Artifact) => a.platform === platform && a.arch === arch)) };
}

export async function readBridgeRelease() {
  const response = await fetch(`${BRIDGE_RELEASE_BASE}latest.json`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('暂时无法读取最新安装包，请稍后重试');
  return parseBridgeRelease(await response.json());
}
