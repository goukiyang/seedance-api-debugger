const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { load, deps, mocks } = require('./audit-decode-upload-loader.cjs');
const sharp = process.env.AUD_SHARP_MODULES ? require(path.join(process.env.AUD_SHARP_MODULES,'sharp')) : deps('sharp');
const policy = fs.readFile(path.join(process.cwd(),'src/lib/media/image-decoder-policy.cjs'),'utf8');
mocks.set('src/lib/media/sharp.ts', { __esModule: true, default: sharp });
(async () => {
  new Function('require','module',await policy)(name => { assert.equal(name,'sharp'); return sharp; },{exports:{}});
  console.log(`Native sharp version: ${sharp.versions.sharp}`);
  const { openUntrustedImage } = load('src/lib/media/decode-image.ts');
  const png = await sharp({ create: { width: 7, height: 5, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
  for (const bytes of [png, await sharp(png).jpeg().toBuffer(), await sharp(png).webp({ lossless: true }).toBuffer()]) {
    const image = await openUntrustedImage(bytes); const meta = await image.metadata();
    assert.equal(meta.width, 7); assert.equal(meta.height, 5); await image.stats();
  }
  const gif = Buffer.concat([Buffer.from('GIF89a','ascii'),Buffer.from([1,0,1,0,128,0,0,0,0,0,255,255,255]),
    ...[0x44,0x4c].map(code => Buffer.from([0x21,0xf9,4,0,10,0,0,0,0x2c,0,0,0,0,1,0,1,0,0,2,2,code,1,0])),Buffer.from([0x3b])]);
  const animated = await openUntrustedImage(gif, 'ordinary', { animated: true });
  const meta = await animated.metadata(); assert.equal(meta.pages, 2); assert.equal(meta.pageHeight, 1); await animated.stats();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'aud-native-hd-'));
  try {
    const source = path.join(dir,'input.png'); await fs.writeFile(source,png);
    const hd = load('src/lib/media/hd-encoder.ts'); assert.equal(hd.HD_MAX_PIXELS,40000000);
    for(const format of ['webp','avif']) {
      const output=path.join(dir,`output.${format}`);await hd.encodeHdOutput(source,output,format);
      const integrity = await hd.validateHdOutput(source,await sharp(png).metadata(),output,format);
      assert.deepEqual(integrity.failedChecks,[]);
    }
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
  console.log('PASS native synthetic PNG/JPEG/WebP, animated GIF, original-size alpha-preserving HD WebP and AVIF integrity');
})().catch(error => { console.error(error); process.exitCode = 1; });
