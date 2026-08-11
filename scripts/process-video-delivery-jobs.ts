import { loadEnvConfig } from '@next/env';
import { processVideoDeliveryQueueBatch } from '../src/lib/video/delivery-worker';
import { prisma } from '../src/lib/prisma';

loadEnvConfig(process.cwd());

function numberArg(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function hasArg(name: string) {
  return process.argv.includes(name);
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const once = hasArg('--once');
  const limit = numberArg('--limit', 5);
  const intervalMs = numberArg('--interval-ms', 10_000);
  const workerId = `video-delivery-script-${process.pid}`;

  do {
    const result = await processVideoDeliveryQueueBatch({ workerId, limit });
    console.log('[video-delivery-worker] batch', result);
    if (once) break;
    await wait(intervalMs);
  } while (true);

  await prisma.$disconnect();
  if (once) {
    process.exit(0);
  }
}

main().catch(async (error) => {
  console.error('[video-delivery-worker] fatal:', error instanceof Error ? error.message : String(error));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
