import type { H3JobOutput } from '@/lib/provider/h3';

type DiagnosticInput = {
  phase: string;
  taskId?: string | null;
  jobId?: string | null;
  presetId?: string | null;
  durationSec?: number | null;
  aspectRatio?: string | null;
  providerStatus?: string | null;
  localStatus?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
  health?: unknown;
  queue?: unknown;
  outputs?: unknown;
  raw?: unknown;
};

const SENSITIVE_KEY_PATTERN = /(token|authorization|cookie|secret|base_?url|worker_?url|public_?base_?url|headers?)/i;

function cleanString(value: unknown, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectKeys(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).slice(0, 40)
    : [];
}

function sanitizeRecord(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[max_depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeRecord(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = sanitizeRecord(rawValue, depth + 1);
  }
  return result;
}

function summarizeOutputs(outputs: unknown) {
  const list = Array.isArray(outputs) ? outputs : [];
  return {
    count: list.length,
    videos: list
      .filter((item): item is H3JobOutput => Boolean(item) && typeof item === 'object')
      .slice(0, 5)
      .map((item) => ({
        index: finiteNumber(item.index),
        kind: cleanString(item.kind),
        filename: cleanString(item.filename),
        content_type: cleanString(item.content_type),
        size_bytes: finiteNumber(item.size_bytes),
        duration_sec: finiteNumber(item.duration_sec),
        width: finiteNumber(item.width),
        height: finiteNumber(item.height),
        fps: finiteNumber(item.fps),
        sha256: cleanString(item.sha256, 80),
        has_download_url: Boolean(item.download_url),
      })),
  };
}

function summarizeHealth(health: unknown) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) return null;
  const healthRecord = health as Record<string, unknown>;
  const workerValue = healthRecord.worker;
  const workerRecord = workerValue && typeof workerValue === 'object' && !Array.isArray(workerValue)
    ? workerValue as Record<string, unknown>
    : {};
  return {
    api: cleanString(healthRecord.api),
    version: cleanString(healthRecord.version),
    worker: cleanString(workerRecord.worker ?? healthRecord.worker),
    comfyui: cleanString(workerRecord.comfyui ?? healthRecord.comfyui),
    preset_count: finiteNumber(healthRecord.preset_count),
    billing: healthRecord.billing && typeof healthRecord.billing === 'object' && !Array.isArray(healthRecord.billing) ? {
      charged: typeof (healthRecord.billing as Record<string, unknown>).charged === 'boolean'
        ? (healthRecord.billing as Record<string, boolean>).charged
        : null,
      cost: finiteNumber((healthRecord.billing as Record<string, unknown>).cost),
      currency: cleanString((healthRecord.billing as Record<string, unknown>).currency),
      cost_model: cleanString((healthRecord.billing as Record<string, unknown>).cost_model),
    } : null,
  };
}

function summarizeQueue(queue: unknown) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return null;
  const queueRecord = queue as Record<string, unknown>;
  return {
    paused: typeof queueRecord.paused === 'boolean' ? queueRecord.paused : null,
    pending: finiteNumber(queueRecord.pending),
    running: finiteNumber(queueRecord.running),
    max_pending_jobs: finiteNumber(queueRecord.max_pending_jobs),
    active: finiteNumber(queueRecord.active),
    max_active_jobs: finiteNumber(queueRecord.max_active_jobs),
  };
}

export function buildH3DiagnosticSnapshot(input: DiagnosticInput) {
  const rawRecord = input.raw && typeof input.raw === 'object' ? input.raw as Record<string, unknown> : null;
  const rawOutputs = input.outputs ?? rawRecord?.outputs;

  return {
    provider: 'h3',
    generated_at: new Date().toISOString(),
    phase: input.phase,
    task_id: input.taskId || null,
    job_id: input.jobId || null,
    request: {
      preset_id: input.presetId || null,
      duration_sec: input.durationSec ?? null,
      aspect_ratio: input.aspectRatio || null,
    },
    status: {
      provider_status: input.providerStatus || null,
      local_status: input.localStatus || null,
      error_code: input.errorCode || null,
      error_message: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
      http_status: input.httpStatus ?? null,
      retry_after_seconds: input.retryAfterSeconds ?? null,
    },
    health: summarizeHealth(input.health),
    queue: summarizeQueue(input.queue || (
      input.health && typeof input.health === 'object' && !Array.isArray(input.health)
        ? (input.health as Record<string, unknown>).queue
        : null
    )),
    outputs: summarizeOutputs(rawOutputs),
    raw_summary: {
      keys: objectKeys(input.raw),
      sanitized: sanitizeRecord(input.raw),
    },
  };
}
