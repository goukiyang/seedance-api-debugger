import { loadEnvConfig } from '@next/env';
import { processStudioTask, recoverStudioTasks } from '../src/lib/image-studio/worker';
import { prisma } from '../src/lib/prisma';
import { dispatchStudioBatches } from '../src/lib/image-studio/batches';
import { dispatchWaitingToolFlowRuns } from '../src/lib/tools/toolflow-runtime';
import { reconcileImageBilling } from '../src/lib/image-studio/billing';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import packageInfo from '../package.json';
import { IMAGE_BILLING_VERSION } from '../src/lib/image-studio/billing-contract';
import { STUDIO_SHARED_WORKER_KEY, STUDIO_SHARED_WORKER_FILES } from '../src/lib/image-studio/tasks';
import { assertStudioWorkerMode, runStudioWorkerCycle, publishStudioWorkerReadiness, studioWorkerBillingEnabled } from '../src/lib/image-studio/worker-mode';

loadEnvConfig(process.cwd());
let stopping = false;
let billingWork: Promise<void> | null = null;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  const draining = () => fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'));
  const mode = assertStudioWorkerMode({ version: packageInfo.version, acceptedOnlyEnv: process.env.STUDIO_ACCEPTED_ONLY,
    releaseHoldEnv: process.env.STUDIO_RELEASE_HOLD, draining: draining() });
  const { acceptedOnly } = mode;
  let initialHold = mode.initialHold;
  let source = path.basename(process.cwd());
  try { source = fs.readFileSync(path.join(process.cwd(), '.deployed-commit'), 'utf8').trim(); } catch {}
  const loadedModuleSha = Object.fromEntries(Array.from(new Set([
    'scripts/process-image-studio.ts',
    'src/lib/image-studio/worker.ts', 'src/lib/image-studio/provider.ts',
    'src/lib/image-studio/provider-wait.ts', 'src/lib/image-studio/worker-mode.ts',
    'src/lib/image-studio/delivery.ts', 'src/lib/image-studio/async-recovery.ts',
    'src/lib/image-studio/response-diagnostics.ts', 'src/lib/image-studio/response-evidence.ts',
    'src/lib/image-generation/output-plan.ts',
    'src/lib/image-studio/dimension-rejection.ts',
    'src/lib/integrations/image-generation.ts', 'src/lib/integrations/image-generation-defaults.ts',
    'src/lib/integrations/image-generation-channel.ts',
    'src/lib/image-studio/batches.ts',
    'src/lib/image-studio/billing.ts', 'src/lib/tools/toolflow-runtime.ts',
    ...STUDIO_SHARED_WORKER_FILES,
    'src/lib/image-studio/billing-quote-service.ts', 'src/lib/image-studio/billing-quote-store.ts',
    'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/image-studio/batch-contract.ts',
    ...fs.readdirSync(path.join(process.cwd(), 'src/lib/canvas-roles')).filter(file => file.endsWith('.ts'))
      .sort().map(file => `src/lib/canvas-roles/${file}`),
  ])).map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), file))).digest('hex')]));
  console.log('[image-studio-source]', JSON.stringify({ source: /^[a-f0-9]{40}$/.test(source) ? source : 'unknown',
    version: packageInfo.version, billingContract: IMAGE_BILLING_VERSION, sharedContract: 'shared-live-v1', loadedModuleSha }));
  const workerId = randomUUID();
  let readinessWork: Promise<void> | null = null;
  const renewReadiness = async () => {
    await publishStudioWorkerReadiness({ acceptedOnly, workerId, source, loadedModuleSha });
  };
  if (!acceptedOnly) await renewReadiness();
  const readinessTimer = setInterval(() => {
    if (acceptedOnly || stopping || readinessWork) return;
    readinessWork = renewReadiness().catch(() => {
      console.error('[image-studio-shared] readiness unavailable; new shared requests must remain blocked');
    }).finally(() => { readinessWork = null; });
  }, 30_000);
  try {
    do {
      if (acceptedOnly && !draining()) throw new Error('image_accepted_only_requires_shared_drain');
      if (initialHold && !draining()) initialHold = false;
      if (!acceptedOnly && !initialHold && draining()) break;
      if (studioWorkerBillingEnabled({ acceptedOnly, initialHold }) && !billingWork) billingWork = reconcileImageBilling().catch(() => {
        console.error('[image-billing] reconciliation deferred; no supplier generation repeated');
      }).finally(() => { billingWork = null; });
      const continued = await runStudioWorkerCycle({ acceptedOnly, initialHold, draining, stopping: () => stopping,
        recover: recoverStudioTasks, dispatchBatches: dispatchStudioBatches, dispatchToolflows: dispatchWaitingToolFlowRuns,
        processQueued: () => Promise.all([processStudioTask(), processStudioTask()]) });
      if (!continued) break;
      if (process.argv.includes('--once')) break;
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 1500));
    } while (!stopping);
    await billingWork;
  } finally {
    clearInterval(readinessTimer);
    await readinessWork;
    const row = await prisma.platformSetting.findUnique({ where: { key: STUDIO_SHARED_WORKER_KEY } });
    if (row) {
      try {
        const value = JSON.parse(row.value_json);
        if (value.workerId === workerId) await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
          data: { value_json: JSON.stringify({ ...value, expiresAt: new Date(0).toISOString() }) } });
      } catch {}
    }
  }
  await prisma.$disconnect();
}
void main().catch(async () => {
  console.error('Image studio worker stopped; queued tasks retained.');
  await prisma.$disconnect();
  process.exitCode = 1;
});
