import { loadEnvConfig } from '@next/env';
import {
  createH3VideoJob,
  downloadH3JobOutput,
  getH3Health,
  getH3TaskStatus,
  listH3JobOutputs,
  listH3Presets,
  postH3AdminAction,
} from '../src/lib/provider/h3';
import { getH3ApiSettings } from '../src/lib/integrations/h3';

loadEnvConfig(process.cwd());

const timeoutMs = Number(process.env.H3_LIVE_SMOKE_TIMEOUT_MS || 180000);
const pollMs = Number(process.env.H3_LIVE_SMOKE_POLL_MS || 5000);
const presetId = process.env.H3_LIVE_SMOKE_PRESET || 'lightx2v_4step_turbo';
const durationSec = Number(process.env.H3_LIVE_SMOKE_DURATION || 5);
const prompt = process.env.H3_LIVE_SMOKE_PROMPT
  || 'A clean five second cinematic test shot of a small racing car driving through a bright studio track, smooth camera, 720p.';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueSummary(queue: unknown) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return null;
  const raw = queue as Record<string, unknown>;
  return {
    paused: raw.paused ?? null,
    pending: raw.pending ?? null,
    running: raw.running ?? null,
    active: raw.active ?? null,
    max_pending_jobs: raw.max_pending_jobs ?? null,
  };
}

function rawObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function stopJob(jobId: string, settings: Awaited<ReturnType<typeof getH3ApiSettings>>) {
  if (!settings.admin_token) return { skipped: true, reason: 'admin_token_not_configured' };
  try {
    const stopped = await postH3AdminAction(
      `/api/h3/jobs/${encodeURIComponent(jobId)}/stop`,
      { confirm: true, reason: 'sd2 h3 live smoke timeout' },
      { baseUrl: settings.base_url, adminToken: settings.admin_token },
    );
    return { skipped: false, result_type: typeof stopped };
  } catch (error) {
    return {
      skipped: false,
      error: error instanceof Error ? error.message : 'stop_failed',
    };
  }
}

async function main() {
  const settings = await getH3ApiSettings();
  if (!settings.api_token) throw new Error('H3 API token is not configured');

  const requestOptions = {
    baseUrl: settings.base_url,
    apiToken: settings.api_token,
  };

  const health = await getH3Health({ baseUrl: settings.base_url });
  const presets = await listH3Presets(requestOptions);
  const presetCount = Array.isArray(presets)
    ? presets.length
    : Array.isArray(rawObject(presets).presets)
      ? (rawObject(presets).presets as unknown[]).length
      : null;

  console.log(JSON.stringify({
    phase: 'preflight',
    health: {
      api: health.api ?? null,
      worker: health.worker?.worker ?? null,
      comfyui: health.worker?.comfyui ?? null,
      billing: health.billing ? {
        charged: health.billing.charged ?? null,
        cost: health.billing.cost ?? null,
        cost_model: health.billing.cost_model ?? null,
      } : null,
      queue: queueSummary(health.queue),
    },
    preset_count: presetCount,
  }));

  const created = await createH3VideoJob({
    preset_id: presetId,
    prompt,
    aspect_ratio: '16:9',
    duration_sec: durationSec,
    seed: -1,
    metadata: {
      external_request_id: `sd2-h3-live-smoke-${Date.now()}`,
      smoke: true,
    },
  }, {
    ...requestOptions,
    idempotencyKey: `sd2-h3-live-smoke-${Date.now()}`,
  });

  const jobId = created.provider_task_id;
  console.log(JSON.stringify({ phase: 'created', job_id: jobId, preset_id: presetId, duration_sec: durationSec }));

  const startedAt = Date.now();
  let lastProgress: unknown = null;
  let unchangedProgressSince = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    const status = await getH3TaskStatus(jobId, requestOptions);
    const raw = rawObject(status.raw);
    const progress = raw.progress ?? raw.percent ?? null;
    if (progress !== lastProgress) {
      lastProgress = progress;
      unchangedProgressSince = Date.now();
    }

    console.log(JSON.stringify({
      phase: 'poll',
      job_id: jobId,
      provider_status: status.provider_status,
      local_status: status.local_status,
      progress,
      elapsed_sec: Math.round((Date.now() - startedAt) / 1000),
    }));

    if (status.local_status === 'succeeded') {
      const outputs = await listH3JobOutputs(jobId, requestOptions);
      if (outputs.outputs.length === 0) throw new Error('H3 succeeded without outputs');
      const first = outputs.outputs[0];
      const downloaded = await downloadH3JobOutput(jobId, first.index || 0, requestOptions);
      console.log(JSON.stringify({
        phase: 'done',
        job_id: jobId,
        outputs: outputs.outputs.map((item) => ({
          index: item.index,
          kind: item.kind ?? null,
          content_type: item.content_type ?? null,
          size_bytes: item.size_bytes ?? null,
          duration_sec: item.duration_sec ?? null,
          width: item.width ?? null,
          height: item.height ?? null,
          fps: item.fps ?? null,
          sha256_present: Boolean(item.sha256),
        })),
        downloaded: {
          content_type: downloaded.contentType,
          size_bytes: downloaded.data.byteLength,
        },
      }));
      return;
    }

    if (status.local_status === 'failed' || status.local_status === 'cancelled') {
      throw new Error(`H3 terminal status: ${status.local_status}; ${status.error_message || 'no error message'}`);
    }

    if (progress === 0.5 && Date.now() - unchangedProgressSince > 90000) {
      const stopped = await stopJob(jobId, settings);
      console.log(JSON.stringify({ phase: 'stopped_stale_progress', job_id: jobId, stopped }));
      process.exit(2);
    }
  }

  const stopped = await stopJob(jobId, settings);
  console.log(JSON.stringify({ phase: 'timeout_stopped', job_id: jobId, stopped }));
  process.exit(2);
}

main().catch((error) => {
  console.error(JSON.stringify({
    phase: 'failed',
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
