import { prisma } from '@/lib/prisma';
import { STUDIO_SHARED_WORKER_KEY } from './tasks';

/** Actual worker heartbeat writer, also used against an isolated database by the release fixture. */
export async function publishStudioWorkerReadiness(input: { acceptedOnly: boolean; workerId: string; source: string;
  loadedModuleSha: Record<string, string>; now?: number }, client: Pick<typeof prisma, 'platformSetting'> = prisma) {
  if (input.acceptedOnly) return false;
  const value = { protocol: 'shared-live-v1', workerId: input.workerId, source: input.source,
    loadedModuleSha: input.loadedModuleSha, expiresAt: new Date((input.now ?? Date.now()) + 90_000).toISOString() };
  await client.platformSetting.upsert({ where: { key: STUDIO_SHARED_WORKER_KEY },
    create: { key: STUDIO_SHARED_WORKER_KEY, value_json: JSON.stringify(value) }, update: { value_json: JSON.stringify(value) } });
  return true;
}

/** Server process configuration only. Never derive this mode from an HTTP request. */
export function assertStudioWorkerMode(input: { version: string; acceptedOnlyEnv: string | undefined; draining: boolean; releaseHoldEnv?: string }) {
  const guard = /\+trace03-guard\.\d+$/.test(input.version);
  if (guard && input.acceptedOnlyEnv !== '1') throw new Error('image_guard_requires_accepted_only');
  const acceptedOnly = guard || input.acceptedOnlyEnv === '1';
  if (acceptedOnly && !input.draining) throw new Error('image_accepted_only_requires_shared_drain');
  return { acceptedOnly, initialHold: !acceptedOnly && input.releaseHoldEnv === '1' && input.draining };
}

/** Global billing scans are normal-worker work, never accepted-only or startup-hold work. */
export function studioWorkerBillingEnabled(input: { acceptedOnly: boolean; initialHold: boolean }) {
  return !input.acceptedOnly && !input.initialHold;
}

/** The same cycle used by the real worker and the isolated no-new-POST fixture. */
export async function runStudioWorkerCycle(input: {
  acceptedOnly: boolean; initialHold?: boolean; draining: () => boolean; stopping: () => boolean;
  recover: (options: { acceptedOnly: boolean }) => Promise<void>;
  dispatchBatches: () => Promise<unknown>; dispatchToolflows: () => Promise<unknown>; processQueued: () => Promise<unknown>;
}) {
  if (input.stopping()) return false;
  if (input.acceptedOnly) {
    if (!input.draining()) throw new Error('image_accepted_only_requires_shared_drain');
    await input.recover({ acceptedOnly: true });
    return !input.stopping();
  }
  if (input.initialHold && input.draining()) return true; // Heartbeat only; no supplier/accounting/producer work.
  const blocked = () => input.stopping() || input.draining();
  if (blocked()) return false;
  await input.recover({ acceptedOnly: false });
  if (blocked()) return false;
  await input.dispatchBatches();
  if (blocked()) return false;
  await input.dispatchToolflows();
  if (blocked()) return false;
  await input.processQueued();
  return true;
}
