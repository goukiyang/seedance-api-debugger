import assert from 'node:assert/strict';
import http from 'node:http';
import { cacheTaskVideoToLocal } from '../../src/lib/video/local-cache';

async function main() {
  const server = http.createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.write(Buffer.from([1, 2, 3]));
    setTimeout(() => {
      response.write(Buffer.from([4, 5, 6]));
      response.end();
    }, 300);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    const result = await cacheTaskVideoToLocal({
      id: `timeout-smoke-${Date.now()}`,
      local_status: 'succeeded',
      provider_task_id: 'provider-timeout-smoke',
      result_video_url: `http://127.0.0.1:${address.port}/slow.mp4`,
      result_last_frame_url: null,
      local_video_path: null,
    }, { timeoutMs: 50, refreshOnForbidden: false });

    assert.equal(result.success, false);
    assert.equal(result.status, 408);
    assert.equal(result.error, 'Download timeout');
  } finally {
    server.close();
  }

  console.log('local-cache result timeout smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
