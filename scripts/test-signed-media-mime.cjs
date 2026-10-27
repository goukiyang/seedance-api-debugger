const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-signed-mime-secret-not-production' });
require('tsx/cjs');
const { signUserMedia, signSupplierMedia, verifyMediaTicket } = require('../src/lib/media/signed-media.ts');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-signed-mime-')));
process.env.MEDIA_DATA_ROOT = root;
(async () => {
  try {
    for (const folder of ['uploads', 'storage/supplier-media']) fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, 'uploads/synthetic.bin'), 'synthetic-fixture-not-user-media');
    fs.writeFileSync(path.join(root, 'storage/supplier-media/synthetic.bin'), 'synthetic-provider-fixture');
    const issue = mime => signUserMedia('owner', { type: 'asset', id: 'synthetic' }, 'original',
      { root: 'uploads', relative: 'synthetic.bin' }, mime, 'synthetic');
    for (const mime of ['image/svg+xml', 'application/xhtml+xml', 'application/javascript', 'application/xml', 'text/html']) {
      await assert.rejects(issue(mime), error => error?.status === 403, `Active MIME cannot be signed as same-origin media: ${mime}`);
      await assert.rejects(signSupplierMedia('synthetic', 'synthetic.bin', mime, 'synthetic'), error => error?.status === 403);
    }
    for (const mime of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'audio/mpeg', 'application/octet-stream']) {
      const url = new URL(await issue(mime), 'https://synthetic.invalid');
      assert.equal(verifyMediaTicket(url, 'owner')?.mime, mime);
    }
    console.log('PASS actual signed user/supplier media refuses active content MIME while retaining bitmap/video/audio/binary delivery');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
