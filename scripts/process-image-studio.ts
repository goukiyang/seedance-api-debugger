import { loadEnvConfig } from '@next/env';
import { processStudioTask, recoverStudioTasks } from '../src/lib/image-studio/worker';
import { prisma } from '../src/lib/prisma';

loadEnvConfig(process.cwd());
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  do {
    await recoverStudioTasks();
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
