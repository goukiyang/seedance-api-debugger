import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeResponseToFile } from '../../src/lib/video/local-cache';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sd2-local-cache-timeout-'));
  const targetPath = path.join(tempDir, 'slow.mp4');

  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        timer = setTimeout(() => {
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        }, 300);
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    }));

    await assert.rejects(
      () => writeResponseToFile(response, targetPath, 0, 50),
      /下载超时/,
    );

    await assert.rejects(() => stat(targetPath));
    console.log('local-cache stream timeout smoke passed');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
