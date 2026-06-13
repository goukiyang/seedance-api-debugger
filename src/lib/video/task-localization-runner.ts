import { finalizeVideoTaskStatus, isTerminalLocalStatus } from './task-finalizer';

const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_RUNTIME_MS = 20 * 60 * 1000;

type RunnerOptions = {
  initialDelayMs?: number;
  intervalMs?: number;
  maxRuntimeMs?: number;
};

const activeRunners = new Map<string, Promise<void>>();

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTaskLocalization(taskId: string, options: RunnerOptions) {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
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
      });

      const status = result.task?.local_status || null;
      if (!result.task || isTerminalLocalStatus(status)) {
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
