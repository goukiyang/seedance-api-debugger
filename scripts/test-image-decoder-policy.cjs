'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('./server-runtime.cjs');
const sharp = require('sharp');

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd2-decoder-'));
  try {
    for (const format of ['png', 'jpeg', 'webp', 'gif', 'avif']) {
      const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#278043' } }).toFormat(format).toBuffer();
      const file = path.join(directory, `fixture.${format}`);
      await writeFile(file, bytes);
      for (const source of [bytes, file]) {
        const { info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.width, 3);
        assert.equal(info.height, 2);
      }
    }
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="red"/></svg>');
    const disguised = path.join(directory, 'disguised.png');
    await writeFile(disguised, svg);
    for (const source of [svg, disguised]) {
      await assert.rejects(() => sharp(source).raw().toBuffer(), /blocked|unsupported|disabled/i,
        'SVG must be refused by the process-wide decoder, regardless of filename');
    }
    console.log('PASS process-wide decoder policy: allowed bitmaps and disguised SVG');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
