import fs from 'node:fs/promises';
import os from 'node:os';

export const HD_CONTROL_PROTOCOL = 'hd-control-v2';
export type HdRunState = 'active' | 'resource_wait' | 'manual_pause' | 'hard_pause';
export type HdResourceSample = {
  checkedAt: string; load1: number | null; cpuCount: number | null; availableMemory: number | null;
  capacitySafe: boolean | null; result: 'safe' | 'busy' | 'unknown' | 'unsafe'; reason?: string;
};
export type HdResourceWait = { since: string; stableSince?: string; stableSamples: number; checks: number; nextCheckAt: string };
export type HdControl = {
  paused: boolean; reason?: string; updatedAt?: string; protocol?: string; revision: number; token: string;
  state: HdRunState; wait?: HdResourceWait; resource?: HdResourceSample;
  history?: Array<{ at: string; state: HdRunState; reason?: string; revision: number; resource?: HdResourceSample }>;
};
// Keep admission thresholds, hysteresis, freshness and bounded polling together.
// load1 is the one-minute load average, never a CPU-use percentage.
export const HD_RESOURCE_POLICY = Object.freeze({
  minimumLoad: 4, loadPerCpu: 1.5, exitLoadRatio: 0.75,
  minimumMemory: 1024 ** 3, exitMemory: 1.25 * 1024 ** 3,
  minimumCheckMs: 5_000, maximumCheckMs: 60_000,
  stableWindowMs: 30_000, stableSamples: 3, sampleFreshMs: 15_000, stableGapMs: 90_000,
  discoveryIntervalMs: 30_000, discoveryLimit: 100, isolationRetries: 3,
});
export const hdManualReason = (reason?: string) => ['admin_pause', 'operator_pause'].includes(reason || '');
export function hdRunState(control: { paused: boolean; reason?: string }): HdRunState {
  if (!control.paused) return 'active';
  if (control.reason === 'resource_wait') return 'resource_wait';
  return hdManualReason(control.reason) ? 'manual_pause' : 'hard_pause';
}
export function classifyHdResources(sample: Omit<HdResourceSample, 'result' | 'reason'>, waiting: boolean): HdResourceSample {
  if (sample.capacitySafe !== true) return { ...sample, result: 'unsafe', reason: sample.capacitySafe === false ? 'capacity_guard' : 'storage_check_unknown' };
  if (sample.load1 === null || !Number.isFinite(sample.load1) || sample.load1 < 0
    || sample.cpuCount === null || !Number.isSafeInteger(sample.cpuCount) || sample.cpuCount < 1
    || sample.availableMemory === null || !Number.isFinite(sample.availableMemory) || sample.availableMemory < 0) {
    return { ...sample, result: 'unknown', reason: 'resource_sample_unknown' };
  }
  const enterLoad = Math.max(HD_RESOURCE_POLICY.minimumLoad, sample.cpuCount * HD_RESOURCE_POLICY.loadPerCpu);
  const busy = sample.load1 > enterLoad * (waiting ? HD_RESOURCE_POLICY.exitLoadRatio : 1)
    || sample.availableMemory < (waiting ? HD_RESOURCE_POLICY.exitMemory : HD_RESOURCE_POLICY.minimumMemory);
  return { ...sample, result: busy ? 'busy' : 'safe', ...(busy ? { reason: 'resource_busy' } : {}) };
}
export async function sampleHdResources(capacitySafe: boolean | null, clock = Date.now): Promise<HdResourceSample> {
  let memory: number | null = null, load: number | null = null, cpus: number | null = null;
  try {
    load = os.loadavg()[0]; cpus = os.cpus().length;
    if (process.platform === 'linux') {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await fs.readFile('/proc/meminfo', 'utf8'));
      memory = match ? Number(match[1]) * 1024 : null;
    } else memory = os.freemem();
  } catch { /* Unknown sampling never authorizes a claim. */ }
  return classifyHdResources({ checkedAt: new Date(clock()).toISOString(), load1: load, cpuCount: cpus,
    availableMemory: memory, capacitySafe }, false);
}
export function hdResourceTransition(control: HdControl, observed: HdResourceSample, timestamp: number, allowManualResume = false): Omit<HdControl, 'token'> | null {
  const legacyLoad = control.paused && control.reason === 'load_guard';
  if (control.state === 'hard_pause' && !legacyLoad) return null;
  if (control.state === 'manual_pause' && !allowManualResume) return null;
  const waiting = control.state !== 'active';
  let sample = classifyHdResources(observed, waiting);
  if ((!Number.isFinite(Date.parse(sample.checkedAt)) || timestamp - Date.parse(sample.checkedAt) > HD_RESOURCE_POLICY.sampleFreshMs
    || Date.parse(sample.checkedAt) > timestamp) && sample.result !== 'unsafe') sample = { ...sample, result: 'unknown', reason: 'resource_sample_unknown' };
  // A legacy load stop migrates only after a fresh, fully safe check. Busy legacy
  // stops remain paused, but the worker continues to recheck them.
  if (legacyLoad && sample.result !== 'safe' && sample.result !== 'unsafe') {
    const checks = Math.min(32, (control.wait?.checks || 0) + 1);
    const delay = Math.min(HD_RESOURCE_POLICY.maximumCheckMs, HD_RESOURCE_POLICY.minimumCheckMs * 2 ** Math.min(checks - 1, 4));
    return { ...control, resource: sample, wait: { since: control.wait?.since || control.updatedAt || new Date(timestamp).toISOString(),
      stableSamples: 0, checks, nextCheckAt: new Date(timestamp + delay).toISOString() } };
  }
  if (sample.result === 'unsafe') return { ...control, paused: true, state: 'hard_pause', reason: sample.reason, resource: sample, wait: undefined };
  if (!waiting && sample.result === 'safe') return { ...control, resource: sample };
  const previous = control.wait;
  const contiguous = previous?.stableSince && control.resource
    && timestamp - Date.parse(control.resource.checkedAt) <= HD_RESOURCE_POLICY.stableGapMs;
  const stableSince = sample.result === 'safe' ? (contiguous ? previous!.stableSince : new Date(timestamp).toISOString()) : undefined;
  const distinct = !control.resource || Date.parse(sample.checkedAt) > Date.parse(control.resource.checkedAt);
  const stableSamples = sample.result === 'safe' ? (contiguous ? previous!.stableSamples + (distinct ? 1 : 0) : 1) : 0;
  const checks = Math.min(32, (previous?.checks || 0) + 1);
  if (sample.result === 'safe' && stableSince && stableSamples >= HD_RESOURCE_POLICY.stableSamples
    && timestamp - Date.parse(stableSince) >= HD_RESOURCE_POLICY.stableWindowMs) {
    return { ...control, paused: false, state: 'active', reason: undefined, resource: sample, wait: undefined };
  }
  const delay = sample.result === 'safe' ? HD_RESOURCE_POLICY.minimumCheckMs
    : Math.min(HD_RESOURCE_POLICY.maximumCheckMs, HD_RESOURCE_POLICY.minimumCheckMs * 2 ** Math.min(checks - 1, 4));
  return { ...control, paused: true, state: 'resource_wait', reason: 'resource_wait', resource: sample,
    wait: { since: previous?.since || (legacyLoad ? control.updatedAt : undefined) || new Date(timestamp).toISOString(), stableSince, stableSamples, checks,
      nextCheckAt: new Date(timestamp + delay).toISOString() } };
}
