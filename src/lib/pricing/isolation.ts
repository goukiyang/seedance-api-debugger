import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PRICING_ISOLATION_SCHEMA = 'pricing-writer-isolation.v1';
export const PRICING_ISOLATION_PROTOCOL = 'pricing-policy-v1';
export type PricingWriterIsolation = {
  schema: typeof PRICING_ISOLATION_SCHEMA;
  protocol: typeof PRICING_ISOLATION_PROTOCOL;
  guard: 'reject-legacy-image-writers';
  installedAt: string;
};

export function pricingIsolationMarkerValid(value: unknown): value is PricingWriterIsolation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as PricingWriterIsolation;
  return marker.schema === PRICING_ISOLATION_SCHEMA && marker.protocol === PRICING_ISOLATION_PROTOCOL
    && marker.guard === 'reject-legacy-image-writers' && Number.isFinite(Date.parse(marker.installedAt))
    && Date.parse(marker.installedAt) <= Date.now()
    && Object.keys(marker).sort().join(',') === 'guard,installedAt,protocol,schema';
}

export function readPricingWriterIsolation(root = process.cwd()): PricingWriterIsolation | null {
  const file = path.join(root, 'storage', 'image-studio-drain');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || stat.size === 0
      || stat.mode & 0o022 || process.platform === 'linux' && stat.uid !== 0) return null;
    // A writable storage directory can unlink a root-owned read-only file.
    // Linux immutable protects that deletion boundary without changing directory permissions.
    if (process.platform === 'linux') {
      const attributes = execFileSync('lsattr', ['-d', '--', file], { encoding: 'utf8', timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const split = /^(\S+)\s+([\s\S]+)$/.exec(attributes);
      if (!split || !split[1].includes('i') || split[2] !== file) return null;
    }
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pricingIsolationMarkerValid(value) ? value : null;
  } catch { return null; }
}

/** A normal release drain is never bypassed. Only the exact root-installed isolation barrier allows new code. */
export function isImageStudioDraining(root = process.cwd()) {
  const file = path.join(root, 'storage', 'image-studio-drain');
  return fs.existsSync(file) && readPricingWriterIsolation(root) === null;
}

export function assertPricingWriterIsolation(root = process.cwd()) {
  if (!readPricingWriterIsolation(root)) throw new Error('新版收费写入隔离尚未就绪；原价格和已有请求保持');
}
