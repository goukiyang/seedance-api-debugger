import { loadEnvConfig } from '@next/env';
import { processStudioTask, recoverStudioTasks } from '../src/lib/image-studio/worker';
import { prisma } from '../src/lib/prisma';
import { dispatchStudioBatches } from '../src/lib/image-studio/batches';
import { reconcileImageBilling } from '../src/lib/image-studio/billing';
import fs from 'node:fs';
import path from 'node:path';
import packageInfo from '../package.json';
import { IMAGE_BILLING_VERSION } from '../src/lib/image-studio/billing-contract';

loadEnvConfig(process.cwd());
let stopping = false;
let billingWork: Promise<void> | null = null;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  let source = path.basename(process.cwd());
  try { source = fs.readFileSync(path.join(process.cwd(), '.deployed-commit'), 'utf8').trim(); } catch {}
  console.log('[image-studio-source]', JSON.stringify({ source: /^[a-f0-9]{40}$/.test(source) ? source : 'unknown',
    version: packageInfo.version, billingContract: IMAGE_BILLING_VERSION }));
  do {
    if (fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) break;
    if (!billingWork) billingWork = reconcileImageBilling().catch(() => {
      console.error('[image-billing] reconciliation deferred; no supplier generation repeated');
    }).finally(() => { billingWork = null; });
    await recoverStudioTasks();
    if (stopping || fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) break;
    await dispatchStudioBatches();
    if (stopping || fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) break;
    await Promise.all([processStudioTask(), processStudioTask()]);
    if (process.argv.includes('--once')) break;
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 1500));
  } while (!stopping);
  await billingWork;
  await prisma.$disconnect();
}
void main().catch(async () => {
  console.error('Image studio worker stopped; queued tasks retained.');
  await prisma.$disconnect();
  process.exitCode = 1;
});
