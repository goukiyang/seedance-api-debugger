import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import type { HdJob } from './hd-derivatives';
import { procIdentity } from './hd-image-processor';
import { hdDirectory } from './hd-storage-root';

type Groups = Record<string, string[]>;
type Catalog = { schema: 1; release: string; pid: number; startTicks: string; checksum: string; groups: Groups };
const file = () => path.join(hdDirectory(), 'compatibility-v1.json');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (local: string, version: string, preserveText: boolean) => digest(JSON.stringify([local, version, preserveText]));
const keyPattern = /^[a-f0-9]{64}$/;
let cached: { file: string; stamp: string; catalog: Catalog } | undefined;

async function liveStart(pid: number) {
  if (process.platform !== 'linux') return pid === process.pid ? 'local' : undefined;
  const current = await procIdentity(pid);
  return current && !['Z', 'X', 'x'].includes(current.state) ? current.startTicks : undefined;
}

/** The exclusive worker publishes from its existing authoritative reconciliation. */
export async function publishHdCompatibilityIndex(jobs: readonly HdJob[], write: (file: string, value: unknown) => Promise<void>) {
  const groups: Groups = {};
  for (const job of jobs) {
    const local = siteUploadPathFromUrl(job.source);
    if (local) (groups[identity(local, job.version, job.preserveText)] ||= []).push(job.key);
  }
  const startTicks = await liveStart(process.pid);
  if (!startTicks) throw new Error('hd_compat_worker_identity');
  const payload = { schema: 1 as const, release: process.cwd(), pid: process.pid, startTicks, groups };
  const checksum = digest(JSON.stringify(payload));
  const prior = await readCatalog();
  if (prior?.checksum !== checksum) await write(file(), { ...payload, checksum });
}

async function readCatalog(): Promise<Catalog | undefined> {
  const target = file();
  try {
    const info = await fs.stat(target);
    const stamp = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
    if (cached?.file === target && cached.stamp === stamp) return cached.catalog;
    const record = JSON.parse(await fs.readFile(target, 'utf8')) as Catalog;
    const { checksum, ...payload } = record;
    if (record.schema !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 1 || !record.startTicks
      || !record.groups || Array.isArray(record.groups) || typeof record.groups !== 'object'
      || digest(JSON.stringify(payload)) !== checksum
      || !Object.entries(record.groups).every(([group, keys]) => keyPattern.test(group)
        && Array.isArray(keys) && keys.every(key => typeof key === 'string' && keyPattern.test(key)))) return;
    cached = { file: target, stamp, catalog: record };
    return record;
  } catch {
    // Absence, corruption and IO failure do not attest negative coverage.
    return undefined;
  }
}

/** Undefined means use the original compatibility reader and its integrity checks. */
export async function indexedHdCompatibilityKeys(local: string, version: string, preserveText: boolean) {
  const catalog = await readCatalog();
  if (!catalog || catalog.release !== process.cwd()) return;
  // A rollback may have introduced keys that the old catalog never saw.
  if (await liveStart(catalog.pid).catch(() => undefined) !== catalog.startTicks) return;
  return catalog.groups[identity(local, version, preserveText)] || [];
}
