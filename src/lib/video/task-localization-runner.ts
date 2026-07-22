import { finalizeVideoTaskStatus, isTerminalLocalStatus } from './task-finalizer';

const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RUNTIME_MS = 5 * 60 * 1000;
const DEFAULT_SUCCESS_CACHE_TIMEOUT_MS = 120_000;

type RunnerOptions = {
  initialDelayMs?: number;
  intervalMs?: number;
  maxRuntimeMs?: number;
  cacheTimeoutMs?: number;
};

type LocalizationResultSnapshot = {
  task: {
    id?: string;
    local_status: string | null;
    local_video_path: string | null;
    result_video_url: string | null;
  } | null;
  cacheResult?: { success: boolean; error?: string } | undefined;
  thumbnailResult?: { success: boolean; error?: string } | undefined;
};

const activeRunners = new Map<string, Promise<void>>();

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldContinueLocalization(
  result: LocalizationResultSnapshot,
) {
  const task = result.task;
  if (!task) return false;

  const status = task.local_status || null;
  if (!isTerminalLocalStatus(status)) return true;
  if (status !== 'succeeded') return false;
  if (!task.result_video_url && !task.local_video_path) return false;

  const cacheReady = Boolean(task.local_video_path) || result.cacheResult?.success === true;
  const thumbnailReady = result.thumbnailResult?.success === true;
  return !cacheReady || !thumbnailReady;
}

async function runTaskLocalization(taskId: string, options: RunnerOptions) {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const cacheTimeoutMs = options.cacheTimeoutMs ?? DEFAULT_SUCCESS_CACHE_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;

  await wait(initialDelayMs);

  while (Date.now() - startedAt <= maxRuntimeMs) {
    attempt += 1;
    try {
      const result = await finalizeVideoTaskStatus(taskId, {
        forceProviderRefresh: true,
        cacheOnSuccess: true,
        generateThumbnail: true,
        cacheTimeoutMs,
      });

      const status = result.task?.local_status || null;
      if (!shouldContinueLocalization(result)) {
        console.log('[VideoLocalizationRunner] Finalized task:', {
          taskId,
          status,
          attempts: attempt,
          localVideoPath: result.task?.local_video_path || null,
          cacheSuccess: result.cacheResult?.success ?? null,
          thumbnailSuccess: result.thumbnailResult?.success ?? null,
        });
        return;
      }

      console.log('[VideoLocalizationRunner] Waiting for local assets:', {
        taskId,
        status,
        attempts: attempt,
        localVideoPath: result.task?.local_video_path || null,
        cacheSuccess: result.cacheResult?.success ?? null,
        cacheError: result.cacheResult?.error ?? null,
        thumbnailSuccess: result.thumbnailResult?.success ?? null,
        thumbnailError: result.thumbnailResult?.error ?? null,
      });
    } catch (error) {
      console.warn('[VideoLocalizationRunner] Poll failed:', {
        taskId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await wait(intervalMs);
  }

  console.warn('[VideoLocalizationRunner] Max runtime reached:', {
    taskId,
    maxRuntimeMs,
  });
}

export function startTaskLocalization(taskId: string, options: RunnerOptions = {}) {
  if (activeRunners.has(taskId)) {
    return { started: false, reason: 'already_running' };
  }

  const runner = runTaskLocalization(taskId, options)
    .finally(() => {
      activeRunners.delete(taskId);
    });

  activeRunners.set(taskId, runner);
  return { started: true };
}

export function getActiveTaskLocalizationCount() {
  return activeRunners.size;
}
