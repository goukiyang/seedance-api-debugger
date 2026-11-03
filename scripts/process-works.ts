import './server-runtime.cjs';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const { processWorksRegistrationPass } = await import('../src/lib/works/ingestion');
  const { setWorksControl } = await import('../src/lib/works/source-policy');
  try {
    const action = process.argv.find(value => ['activate-policy', 'pause', 'resume'].includes(value)) as 'activate-policy' | 'pause' | 'resume' | undefined;
    if (action) { console.log('[works]', JSON.stringify(await setWorksControl(action))); return; }
    do {
      const result = await processWorksRegistrationPass({ shouldStop: () => stopping });
      console.log('[works]', JSON.stringify(result));
      if (process.argv.includes('--once')) break;
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 15_000));
    } while (!stopping);
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error('[works] directory pass deferred; original tasks and billing retained'); process.exitCode = 1; });
