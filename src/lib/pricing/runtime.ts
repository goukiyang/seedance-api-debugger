import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { assertPricingWriterIsolation } from './isolation';

export const PRICING_RUNTIME_PROTOCOL = 'pricing-policy-v1';
export const PRICING_IMAGE_CAPABILITY_KEY = 'pricing_worker_capability_v1:image';
const TTL_MS = 90_000;
type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;

type ProcessIdentity = { pid: number; start: string; cwd: string; parentPid: number };
export type PricingWorkerCapability = {
  protocol: typeof PRICING_RUNTIME_PROTOCOL;
  consumer: 'image';
  workerId: string;
  source: string;
  instance: ProcessIdentity;
  parent: { pid: number; start: string };
  loadedModuleSha: Record<string, string>;
  issuedAt: string;
  expiresAt: string;
};

export class PricingRuntimeError extends Error {
  readonly status = 503;
  readonly code = 'pricing_consumer_unavailable';
  constructor() {
    super('新版收费处理服务尚未就绪，原价格和已有任务不变；请稍后重新预览');
  }
}

function processIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new PricingRuntimeError();
  process.kill(pid, 0);
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] || '')) throw new PricingRuntimeError();
    if (!/^\d+$/.test(fields[1] || '')) throw new PricingRuntimeError();
    return { pid, start: fields[19], cwd: fs.realpathSync(`/proc/${pid}/cwd`), parentPid: Number(fields[1]) };
  }
  // Local engineering fixtures use the same live-process check without /proc.
  const start = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  if (!start) throw new PricingRuntimeError();
  if (pid !== process.pid) throw new PricingRuntimeError();
  return { pid, start, cwd: fs.realpathSync(process.cwd()), parentPid: process.ppid };
}

function parentIdentity(pid: number) {
  process.kill(pid, 0);
  const start = process.platform === 'linux'
    ? fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').trim().split(/\s+/)[19]
    : execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  if (!start) throw new PricingRuntimeError();
  return { pid, start };
}

export function pricingRuntimeSourceFiles(root = process.cwd()) {
  const groups = ['src/lib/pricing', 'src/lib/image-studio'];
  const files = groups.flatMap(directory => fs.readdirSync(path.join(root, directory))
    .filter(file => file.endsWith('.ts')).map(file => `${directory}/${file}`));
  return [...files, 'scripts/process-image-studio.ts', 'src/lib/credits/policy.ts',
    'src/lib/credits/precision.ts', 'src/lib/projects/budget.ts', 'src/lib/tools/toolflow-runtime.ts',
    'src/lib/integrations/image-generation.ts', 'src/lib/integrations/image-generation-channel.ts',
    'src/lib/integrations/image-generation-defaults.ts', 'package.json', '.deployed-commit'].sort();
}

export function pricingRuntimeModuleHashes(root = process.cwd()) {
  return Object.fromEntries(pricingRuntimeSourceFiles(root).map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}

export function capturePricingWorkerCapability(source: string): PricingWorkerCapability {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new PricingRuntimeError();
  if (fs.readFileSync(path.join(process.cwd(), '.deployed-commit'), 'utf8').trim() !== source) throw new PricingRuntimeError();
  const now = Date.now();
  return { protocol: PRICING_RUNTIME_PROTOCOL, consumer: 'image', workerId: randomUUID(), source,
    instance: processIdentity(process.pid), parent: parentIdentity(process.ppid),
    loadedModuleSha: pricingRuntimeModuleHashes(), issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString() };
}

export async function renewPricingWorkerCapability(client: Client, captured: PricingWorkerCapability) {
  const instance = processIdentity(captured.instance.pid);
  if (instance.start !== captured.instance.start || instance.cwd !== captured.instance.cwd
    || JSON.stringify(pricingRuntimeModuleHashes()) !== JSON.stringify(captured.loadedModuleSha)) throw new PricingRuntimeError();
  const value = { ...captured, expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
  await client.platformSetting.upsert({ where: { key: PRICING_IMAGE_CAPABILITY_KEY },
    create: { key: PRICING_IMAGE_CAPABILITY_KEY, value_json: JSON.stringify(value) },
    update: { value_json: JSON.stringify(value) } });
}

export async function revokePricingWorkerCapability(client: Client, captured: PricingWorkerCapability) {
  const row = await client.platformSetting.findUnique({ where: { key: PRICING_IMAGE_CAPABILITY_KEY } });
  if (!row) return;
  try {
    const current = JSON.parse(row.value_json) as PricingWorkerCapability;
    if (current.workerId !== captured.workerId) return;
    await client.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
      data: { value_json: JSON.stringify({ ...current, expiresAt: new Date(0).toISOString() }) } });
  } catch { /* An unreadable receipt already denies all new contracts. */ }
}

export async function assertPricingImageConsumerReady(client: Client) {
  assertPricingWriterIsolation();
  const row = await client.platformSetting.findUnique({ where: { key: PRICING_IMAGE_CAPABILITY_KEY } });
  try {
    const value = JSON.parse(row?.value_json || 'null') as PricingWorkerCapability;
    const now = Date.now();
    if (!value || value.protocol !== PRICING_RUNTIME_PROTOCOL || value.consumer !== 'image'
      || !/^[a-f0-9-]{36}$/.test(value.workerId) || !/^[a-f0-9]{40}$/.test(value.source)
      || !Number.isFinite(Date.parse(value.issuedAt)) || Date.parse(value.issuedAt) > now
      || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now
      || Date.parse(value.expiresAt) > now + TTL_MS) throw new PricingRuntimeError();
    const current = processIdentity(value.instance.pid);
    if (current.start !== value.instance.start || current.cwd !== value.instance.cwd || current.parentPid !== value.parent.pid
      || fs.readFileSync(path.join(process.cwd(), '.deployed-commit'), 'utf8').trim() !== value.source
      || parentIdentity(value.parent.pid).start !== value.parent.start) throw new PricingRuntimeError();
    const expected = pricingRuntimeModuleHashes();
    const actual = pricingRuntimeModuleHashes(current.cwd);
    if (JSON.stringify(expected) !== JSON.stringify(value.loadedModuleSha)
      || JSON.stringify(actual) !== JSON.stringify(value.loadedModuleSha)) throw new PricingRuntimeError();
    return { workerId: value.workerId, source: value.source, expiresAt: value.expiresAt };
  } catch { throw new PricingRuntimeError(); }
}

export async function pricingImageConsumerState(client: Client) {
  try { return { ready: true, ...await assertPricingImageConsumerReady(client) }; }
  catch { return { ready: false, reason: new PricingRuntimeError().message }; }
}
