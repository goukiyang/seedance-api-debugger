import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { HdIntegrity, HdEncoderParameters } from './hd-encoder';

export const HD_IMAGE_PROTOCOL = 'hd-image-process-v1';
// Each existing Sharp operation retains its 120 second limit. The parent also
// bounds metadata, the whole validation phase (two complete decodes), and wall
// time. These are server constants, never request/HTTP parameters.
export type HdImageLimits = { wallMs: number; readingMs: number; encodingMs: number; validatingMs: number; terminateMs: number };
export const HD_IMAGE_LIMITS: Readonly<HdImageLimits> = Object.freeze({ wallMs: 660_000, readingMs: 150_000, encodingMs: 180_000, validatingMs: 300_000, terminateMs: 5_000 });
export type HdImageStage = 'reading' | 'encoding' | 'validating';
export type HdProcessorIdentity = { pid: number; groupId: number; host: string; startTicks: string; executionId: string };
export type HdImageRequest = {
  protocol: typeof HD_IMAGE_PROTOCOL; key: string; executionId: string; sourceVersion: string;
  inputFile: string; workDirectory: string; preserveText: boolean;
  operation?: 'encode' | 'validate' | 'verify-original'; candidateFormat?: 'avif' | 'webp';
};
export type HdImageMetadata = { width: number; height: number; originalFormat: string; hasAlpha: boolean; orientation: number; bytes: number };
export type HdImageResult = {
  protocol: typeof HD_IMAGE_PROTOCOL; type: 'result'; key: string; executionId: string; sourceVersion: string;
  inputFile: string; workDirectory: string; outputFile?: string; outputVersion?: string; format?: 'avif' | 'webp'; bytes?: number;
  metadata: HdImageMetadata; skipped?: string; integrity?: HdIntegrity; parameters?: HdEncoderParameters;
  libraries: Record<string, string>; originalVerified?: boolean;
};
export class HdProcessorError extends Error {
  constructor(readonly kind: string, readonly exited: boolean, readonly diagnostic?: { stage: string; code?: string; message?: string }, readonly integrity?: HdIntegrity) { super(kind); }
}
type ProcIdentity = { state: string; group: number; session: number; startTicks: string };
async function procIdentity(pid: number): Promise<ProcIdentity | null> {
  try {
    const value = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error('hd_child_exit_unknown');
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19] };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
}
async function groupRunning(group: number): Promise<boolean> {
  if (process.platform !== 'linux') {
    try { process.kill(-group, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }
  for (const pid of (await fs.readdir('/proc')).filter(value => /^\d+$/.test(value))) {
    const identity = await procIdentity(Number(pid));
    if (identity?.group === group && identity.state !== 'Z' && identity.state !== 'X') return true;
  }
  return false;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitGroupExit(group: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  do { if (!await groupRunning(group)) return true; await pause(25); } while (Date.now() < until);
  return !await groupRunning(group);
}
async function terminateGroup(group: number, graceMs = HD_IMAGE_LIMITS.terminateMs) {
  try { process.kill(-group, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  if (await waitGroupExit(group, graceMs)) return;
  try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  if (!await waitGroupExit(group, graceMs)) throw new Error('hd_child_exit_unknown');
}
// Called before reclaiming an interrupted run. Never infer exit from elapsed
// time, a missing lease heartbeat, or a new supervisor PID.
export async function assertHdExecutionExited(identity: HdProcessorIdentity) {
  if (identity.host !== os.hostname() || identity.pid !== identity.groupId
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || !/^\d+$/.test(identity.startTicks)) throw new Error('hd_child_exit_unknown');
  if (process.platform !== 'linux') {
    // Local engineering on macOS has no /proc start identity. It may prove an
    // already-dead process/group, but never kill a live PID on that assumption.
    try { process.kill(identity.pid, 0); throw new Error('hd_child_exit_unknown'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (await groupRunning(identity.groupId)) throw new Error('hd_child_exit_unknown');
    return;
  }
  const current = await procIdentity(identity.pid);
  if (current && (current.startTicks !== identity.startTicks || current.group !== identity.groupId || current.session !== identity.groupId)) throw new Error('hd_child_exit_unknown');
  if (current && current.state !== 'Z' && current.state !== 'X') await terminateGroup(identity.groupId);
  if (await groupRunning(identity.groupId)) throw new Error('hd_child_exit_unknown');
}
const active = new Set<ChildProcess>();
let stopping = false;
export const hdImageProcessorStopping = () => stopping;
export async function stopHdImageProcessors() {
  stopping = true;
  await Promise.all(Array.from(active).map(async child => { if (child.pid) await terminateGroup(child.pid); }));
}
export function validateHdImageResult(value: unknown, request: HdImageRequest): value is HdImageResult {
  const result = value as HdImageResult | null;
  if (!result || result.protocol !== HD_IMAGE_PROTOCOL || result.type !== 'result' || result.key !== request.key
    || result.executionId !== request.executionId || result.sourceVersion !== request.sourceVersion
    || result.inputFile !== request.inputFile || result.workDirectory !== request.workDirectory
    || !result.metadata || !Number.isSafeInteger(result.metadata.width) || result.metadata.width < 0
    || !Number.isSafeInteger(result.metadata.height) || result.metadata.height < 0
    || !Number.isSafeInteger(result.metadata.bytes) || result.metadata.bytes <= 0 || typeof result.metadata.originalFormat !== 'string'
    || typeof result.metadata.hasAlpha !== 'boolean' || !Number.isInteger(result.metadata.orientation)
    || !result.libraries || typeof result.libraries !== 'object') return false;
  if (request.operation === 'verify-original') return result.originalVerified === true && !result.outputFile && !result.format;
  if (result.skipped) return ['existing_webp', 'multi_frame', 'pixel_limit', 'high_bit_depth', 'wide_gamut', 'unverified_color_profile'].includes(result.skipped)
    && !result.outputFile && !result.integrity;
  return result.metadata.width > 0 && result.metadata.height > 0 && ['avif', 'webp'].includes(result.format || '') && result.outputFile === `output.${result.format}`
    && typeof result.outputVersion === 'string' && /^\d+:\d+:\d+:[0-9.]+:[0-9.]+$/.test(result.outputVersion)
    && Number.isSafeInteger(result.bytes) && result.bytes! > 0 && result.integrity?.version === 'hd-output-integrity-v2'
    && Array.isArray(result.integrity.failedChecks) && result.integrity.failedChecks.length === 0
    && Boolean(result.integrity.checks)
    && ['output_metadata', 'width', 'height', 'alpha', 'pages', 'color', 'bitdepth', 'depth', 'format', 'output_full_decode'].every(name => result.integrity!.checks[name]?.ok === true)
    && Object.values(result.integrity.checks).every(check => check && check.ok === true);
}
export async function runHdImageProcessor(request: HdImageRequest, options: {
  onSpawn?: (identity: HdProcessorIdentity) => Promise<void>;
  onStage?: (stage: HdImageStage) => Promise<void>;
  onPrepared?: (metadata: HdImageMetadata) => Promise<boolean>;
  // Only the offline engineering fixture supplies these dependency overrides.
  script?: string; applicationRoot?: string; limits?: Readonly<HdImageLimits>;
} = {}): Promise<HdImageResult> {
  if (stopping) throw new HdProcessorError('hd_shutdown', true);
  if (active.size) throw new HdProcessorError('hd_processor_busy', false);
  const limits = options.limits || HD_IMAGE_LIMITS;
  const applicationRoot = options.applicationRoot || process.cwd();
  const loader = createRequire(path.join(applicationRoot, 'package.json')).resolve('tsx');
  const child = fork(options.script || path.join(applicationRoot, 'scripts/process-hd-image.ts'), [], {
    execArgv: ['--import', loader], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { NODE_ENV: 'production', PATH: process.env.PATH || '', TMPDIR: request.workDirectory },
    serialization: 'json',
  });
  active.add(child);
  let phase: HdImageStage = 'reading';
  let readingSeen = false, preparedSeen = false;
  let settled = false, result: HdImageResult | undefined, failure: HdProcessorError | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let processingMessages = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  let notifyStopped!: () => void;
  const stopped = new Promise<void>(resolve => { notifyStopped = resolve; });
  const stop = (error: HdProcessorError) => {
    failure ||= error;
    if (!stopPromise && child.pid) stopPromise = terminateGroup(child.pid, limits.terminateMs)
      .catch(() => { failure = new HdProcessorError('hd_child_exit_unknown', false); }).finally(notifyStopped);
  };
  const arm = () => {
    clearTimeout(timeout);
    const duration = phase === 'reading' ? limits.readingMs : phase === 'encoding' ? limits.encodingMs : limits.validatingMs;
    timeout = setTimeout(() => stop(new HdProcessorError('encode_timeout', false, { stage: phase, message: 'phase_deadline' })), duration);
  };
  const wall = setTimeout(() => stop(new HdProcessorError('encode_timeout', false, { stage: phase, message: 'wall_deadline' })), limits.wallMs);
  arm();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => stop(new HdProcessorError('hd_child_spawn_failure', false)));
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal }); });
  });
  child.on('message', raw => {
    processingMessages = processingMessages.then(async () => {
      if (failure) return;
      const message = raw as Record<string, unknown>;
      if (!message || message.protocol !== HD_IMAGE_PROTOCOL || message.key !== request.key || message.executionId !== request.executionId
        || message.sourceVersion !== request.sourceVersion) throw new Error('hd_child_protocol');
      if (message.type === 'stage') {
        const next = message.stage as HdImageStage;
        const order = ['reading', 'encoding', 'validating'];
        if (!order.includes(next) || order.indexOf(next) < order.indexOf(phase) || next === phase && (phase !== 'reading' || readingSeen)) throw new Error('hd_child_protocol');
        if (next === 'reading') readingSeen = true;
        phase = next; arm(); await options.onStage?.(phase);
      } else if (message.type === 'prepared') {
        if (phase !== 'reading' || preparedSeen) throw new Error('hd_child_protocol');
        preparedSeen = true;
        const metadata = message.metadata as HdImageMetadata;
        if (!metadata || !Number.isSafeInteger(metadata.width) || metadata.width <= 0 || !Number.isSafeInteger(metadata.height) || metadata.height <= 0
          || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0) throw new Error('hd_child_protocol');
        if (options.onPrepared && !await options.onPrepared(metadata)) { stop(new HdProcessorError('capacity_guard', false)); return; }
        child.send({ protocol: HD_IMAGE_PROTOCOL, type: 'proceed', executionId: request.executionId });
      } else if (message.type === 'result') {
        if (!validateHdImageResult(message, request) || result || !message.skipped && phase !== 'validating') throw new Error('hd_child_protocol');
        result = message;
      } else if (message.type === 'error') {
        const allowed = ['source_missing', 'source_unreadable', 'source_changed', 'source_incompatible', 'temporary_io', 'encode_timeout', 'output_integrity', 'worker_integrity_failure'];
        const kind = typeof message.kind === 'string' && allowed.includes(message.kind) ? message.kind : 'worker_integrity_failure';
        const diagnostic = message.diagnostic as HdProcessorError['diagnostic'];
        failure = new HdProcessorError(kind, false, diagnostic, message.integrity as HdIntegrity | undefined);
      } else throw new Error('hd_child_protocol');
    }).catch(() => { stop(new HdProcessorError('hd_child_protocol', false)); });
  });
  try {
    if (!child.pid) throw new HdProcessorError('hd_child_spawn_failure', false);
    const identity = process.platform === 'linux' ? await procIdentity(child.pid) : null;
    if (process.platform === 'linux' && (!identity || identity.group !== child.pid || identity.session !== child.pid)) throw new HdProcessorError('hd_child_exit_unknown', false);
    await options.onSpawn?.({ pid: child.pid, groupId: child.pid, host: os.hostname(), startTicks: identity?.startTicks || '0', executionId: request.executionId });
    if (stopping) stop(new HdProcessorError('hd_shutdown', false));
    else child.send(request);
    const outcome = await Promise.race([exited.then(exit => ({ exit })), stopped.then(() => ({ exit: null }))]);
    await processingMessages;
    await stopPromise;
    if (!outcome.exit && !settled) {
      if (child.pid && !await groupRunning(child.pid)) {
        // Group exit itself is proof even if a broken IPC close callback has
        // not arrived. It is still a failed run, never a publishable result.
        throw new HdProcessorError(failure?.kind || 'hd_child_abnormal_exit', true, failure?.diagnostic, failure?.integrity);
      }
      throw new HdProcessorError('hd_child_exit_unknown', false);
    }
    const exit = outcome.exit;
    if (await groupRunning(child.pid)) {
      await terminateGroup(child.pid, limits.terminateMs);
      if (await groupRunning(child.pid)) throw new HdProcessorError('hd_child_exit_unknown', false);
    }
    if (stopping) throw new HdProcessorError('hd_shutdown', true);
    if (failure) throw new HdProcessorError(failure.kind, failure.kind !== 'hd_child_exit_unknown', failure.diagnostic, failure.integrity);
    if (!exit || exit.code !== 0 || exit.signal || !result) throw new HdProcessorError('hd_child_abnormal_exit', true, { stage: phase, message: exit?.signal || `exit_${exit?.code}` });
    return result;
  } catch (error) {
    if (!settled && child.pid && !(error instanceof HdProcessorError && (error.kind === 'hd_child_exit_unknown' || error.exited))) {
      try { await terminateGroup(child.pid, limits.terminateMs); }
      catch { throw new HdProcessorError('hd_child_exit_unknown', false); }
    }
    throw error;
  } finally {
    clearTimeout(wall); clearTimeout(timeout); active.delete(child);
  }
}
