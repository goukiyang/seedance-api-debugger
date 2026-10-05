import { loadEnvConfig } from '@next/env';
import { processStudioTask, recoverStudioTasks } from '../src/lib/image-studio/worker';
import { prisma } from '../src/lib/prisma';
import { dispatchStudioBatches } from '../src/lib/image-studio/batches';
import fs from 'node:fs';
import path from 'node:path';

loadEnvConfig(process.cwd());
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  do {
    if (fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) break;
    await recoverStudioTasks();
    if (stopping || fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) break;
    await dispatchStudioBatches();
    if (stopping || fs.existsSync(path.join(process.cwd(), 'storage', 'image-studio-drain'))) break;
    await Promise.all([processStudioTask(), processStudioTask()]);
    if (process.argv.includes('--once')) break;
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 1500));
  } while (!stopping);
  await prisma.$disconnect();
}
void main().catch(async () => {
  console.error('Image studio worker stopped; queued tasks retained.');
  await prisma.$disconnect();
  process.exitCode = 1;
});
