import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { GET, HEAD } from '../src/app/videos/[...path]/route';

const thumbnailDir = path.join(process.cwd(), 'public', 'videos', 'thumbnails');
const fileName = `runtime-${Date.now()}.jpg`;
const filePath = path.join(thumbnailDir, fileName);
const jpgBytes = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGgP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCcf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8BP//Z',
  'base64',
);

fs.mkdirSync(thumbnailDir, { recursive: true });
fs.writeFileSync(filePath, jpgBytes);

async function main() {
  try {
    const request = new NextRequest(`http://localhost/videos/thumbnails/${fileName}`);
    const response = await GET(request, { params: { path: ['thumbnails', fileName] } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('content-length'), String(jpgBytes.length));
    assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), jpgBytes), 0);

    const headResponse = await HEAD(request, { params: { path: ['thumbnails', fileName] } });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get('content-type'), 'image/jpeg');
    assert.equal(headResponse.headers.get('content-length'), String(jpgBytes.length));

    const rangeRequest = new NextRequest(`http://localhost/videos/thumbnails/${fileName}`, {
      headers: { range: 'bytes=0-9' },
    });
    const rangeResponse = await GET(rangeRequest, { params: { path: ['thumbnails', fileName] } });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get('content-range'), `bytes 0-9/${jpgBytes.length}`);
    assert.equal(rangeResponse.headers.get('content-length'), '10');

    const traversal = await GET(request, { params: { path: ['..', 'secret.mp4'] } });
    assert.equal(traversal.status, 400);
  } finally {
    fs.rmSync(filePath, { force: true });
  }

  console.log('videos dynamic route smoke passed');
}

main().catch((error) => {
  fs.rmSync(filePath, { force: true });
  console.error(error);
  process.exit(1);
});
