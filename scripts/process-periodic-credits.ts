import { loadEnvConfig } from '@next/env';

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.DATABASE_URL?.startsWith('file:')) throw new Error('周期额度进程需要SQLite配置');
  const { prisma } = await import('@/lib/prisma');
  const { quotaWorkerTick } = await import('@/lib/credits/periodic');
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  let cursor: string | undefined;
  try {
    do {
      try { cursor = await quotaWorkerTick(cursor); }
      catch { console.error('[periodic-credits] cycle failed; will retry safely'); }
      if (process.argv.includes('--once')) break;
      for (let i = 0; i < (cursor ? 2 : 60) && !stopping; i++) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error('[periodic-credits] startup failed'); process.exitCode = 1; });
