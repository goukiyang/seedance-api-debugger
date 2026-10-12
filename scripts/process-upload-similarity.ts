import 'dotenv/config';
import os from 'node:os';
import fs from 'node:fs/promises';
import v8 from 'node:v8';
import { prisma } from '../src/lib/prisma';
import { processOneUploadSimilarity } from '../src/lib/assets/upload-similarity';

async function main() {
  if (v8.getHeapStatistics().heap_size_limit > 512 * 1024 ** 2 || process.env.UV_THREADPOOL_SIZE !== '2' || process.env.VIPS_CONCURRENCY !== '2') throw new Error('similarity_node_resource_guard');
  const mode = process.argv[2] || 'once';
  if (!['once', 'worker'].includes(mode)) throw new Error('similarity_mode_invalid');
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  do {
    const available = process.platform === 'linux'
      ? Number((await fs.readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0) * 1024 : os.freemem();
    if (available < 1024 ** 3 || os.loadavg()[0] > Math.max(4, os.cpus().length * 1.5)) {
      if (mode === 'once') throw new Error('similarity_load_guard');
    } else {
      const processed = await processOneUploadSimilarity();
      if (mode === 'once') { console.log(JSON.stringify({ processed })); return; }
      if (processed) continue;
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 3000));
  } while (mode === 'worker' && !stopping);
}
main().catch(() => { console.error('similarity_worker_unavailable'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
