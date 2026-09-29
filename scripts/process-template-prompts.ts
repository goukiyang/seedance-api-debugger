import { loadEnvConfig } from '@next/env';

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.DATABASE_URL?.startsWith('file:')) {
    throw new Error('模板提示词 worker 需要显式 SQLite DATABASE_URL');
  }

  const [{ prisma }, { runStudioPromptWorker }] = await Promise.all([
    import('@/lib/prisma'),
    import('@/lib/template-studio/worker'),
  ]);

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { stopping = true; });
  }

  try {
    await runStudioPromptWorker({ shouldStop: () => stopping }, { once: process.argv.includes('--once') });
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('[template-studio-worker] worker failed:', error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});
