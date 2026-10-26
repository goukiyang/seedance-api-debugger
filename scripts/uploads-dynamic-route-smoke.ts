import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { GET, HEAD } from '../src/app/uploads/[...path]/route';

const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'smoke-runtime');
const fileName = `runtime-${Date.now()}.png`;
const filePath = path.join(uploadDir, fileName);
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/azVx5kAAAAASUVORK5CYII=',
  'base64',
);

fs.mkdirSync(uploadDir, { recursive: true });
fs.writeFileSync(filePath, pngBytes);

async function main() {
  try {
    const request = new NextRequest(`http://localhost/uploads/smoke-runtime/${fileName}`);
    const response = await GET(request, { params: { path: ['smoke-runtime', fileName] } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-length'), String(pngBytes.length));
    assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), pngBytes), 0);

    const headResponse = await HEAD(request, { params: { path: ['smoke-runtime', fileName] } });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get('content-type'), 'image/png');
    assert.equal(headResponse.headers.get('content-length'), String(pngBytes.length));

    const traversal = await GET(request, { params: { path: ['..', 'secret.png'] } });
    assert.equal(traversal.status, 400);
  } finally {
    fs.rmSync(filePath, { force: true });
  }

  console.log('uploads dynamic route smoke passed');
}

main().catch((error) => {
  fs.rmSync(filePath, { force: true });
  console.error(error);
  process.exit(1);
});
