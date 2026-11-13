import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** A temporary attestation copy never keeps permissions after a live policy change. */
export function releasePrivatePolicyFresh() {
  const active = '/etc/video-api-debugger/private-prompts/policy-active.json';
  if (!process.env.SD2_SEAMLESS_RUN_ID || process.env.PRIVATE_PROMPTS_POLICY_FILE === active) return true;
  const expected = process.env.SD2_SEAMLESS_POLICY_SHA256;
  return Boolean(expected && /^[a-f0-9]{64}$/.test(expected)
    && createHash('sha256').update(fs.readFileSync(active)).digest('hex') === expected);
}

/** Temporary web/worker pairs never overwrite the running version's heartbeat. */
export function releaseWorkerKey(key: string) {
  const runId = process.env.SD2_SEAMLESS_RUN_ID;
  if (!runId) return key;
  const source = fs.readFileSync(process.cwd() + '/.deployed-commit', 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^[a-f0-9]{40}$/.test(source)) throw new Error('发布进程身份无法核对');
  return `${key}:${source}`;
}

/** Separate metadata: legacy admission rows, capacity and receipts stay v1. */
export function synchronousProcessProvenance() {
  const runId = process.env.SD2_SEAMLESS_RUN_ID;
  if (!runId) return null;
  if (process.platform !== 'linux' || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('发布进程身份无法核对，未派发生成');
  const root = fs.realpathSync(process.cwd());
  const source = fs.readFileSync(root + '/.deployed-commit', 'utf8').trim();
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
  const cgroup = /^0::([^\n]+)$/m.exec(fs.readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
  if (!/^[a-f0-9]{40}$/.test(source) || root !== '/data/video-api-debugger/managed-releases/' + source
    || !/^\d+$/.test(startTicks) || cgroup !== '/system.slice/sd2-release-main-' + runId + '.service') {
    throw new Error('发布进程身份无法核对，未派发生成');
  }
  return { schema: 'image.sync-process.v1', runId, source, root, pid: process.pid, startTicks, cgroup };
}
