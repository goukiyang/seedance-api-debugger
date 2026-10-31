import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { IMAGE_FEISHU_MAX_BYTES } from '../src/lib/image-studio/feishu-contract';
import { prepareImageFeishuSource } from '../src/lib/image-studio/feishu-source';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const originalCwd = process.cwd();
  const fixtureRoot = process.env.FEISHU_NOTIFICATION_FIXTURE_ROOT;
  assert.ok(fixtureRoot && path.isAbsolute(fixtureRoot) && !fixtureRoot.startsWith('/data/video-api-debugger/'));
  assert.equal(await realpath(fixtureRoot), fixtureRoot);
  const run = await mkdtemp(path.join(fixtureRoot, 'image-preview-'));
  const assets = path.join(run, 'public/uploads/assets');
  await mkdir(assets, { recursive: true });

  const current = async (id: string, bytes: Buffer, mimeType: string, extension: string, dimensions: { width: number; height: number }) => {
    const digest = sha256(bytes);
    await writeFile(path.join(assets, `${digest}.${extension}`), bytes, { mode: 0o600 });
    return {
      actor: {},
      task: { id, owner_id: 'fixture-owner', module_id: 'fixture-module', status: 'succeeded', asset_id: `asset-${id}`,
        deleted_at: null, usage_json: null, finished_at: new Date() },
      asset: { id: `asset-${id}`, owner_id: 'fixture-owner', original_url: `/uploads/assets/${digest}.${extension}`, mime_type: mimeType,
        file_size: bytes.length, hash: digest, width: dimensions.width, height: dimensions.height },
    };
  };

  let cases = 0;
  const done = () => { cases++; };
  try {
    process.chdir(run);

    const small = await sharp({ create: { width: 24, height: 36, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 0.45 } } }).png().toBuffer();
    const smallCurrent = await current('small', small, 'image/png', 'png', { width: 24, height: 36 });
    const smallSource = await prepareImageFeishuSource(smallCurrent as never, 2);
    assert.equal(smallSource.mode, 'image');
    assert.equal(smallSource.presentation?.kind, 'original');
    assert.deepEqual(smallSource.presentation, { kind: 'original', contentHash: sha256(small), width: 24, height: 36,
      originalWidth: 24, originalHeight: 36, mimeType: 'image/png', extension: 'png' });
    assert.deepEqual(Buffer.from(await smallSource.file!.arrayBuffer()), small);
    assert.equal(await smallSource.current(), true);
    done();

    const width = 2496, height = 3312;
    const raw = randomBytes(width * height * 4);
    const large = await sharp(raw, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
    assert.ok(large.length > IMAGE_FEISHU_MAX_BYTES, `large PNG fixture was only ${large.length} bytes`);
    const largeCurrent = await current('large', large, 'image/png', 'png', { width, height });
    const originalHash = sha256(await readFile(path.join(assets, `${sha256(large)}.png`)));
    const legacySource = await prepareImageFeishuSource(largeCurrent as never, 1);
    assert.equal(legacySource.mode, 'link');
    assert.equal(legacySource.reason, 'image_size_link_only');
    assert.equal(legacySource.file, null);
    const previewSource = await prepareImageFeishuSource(largeCurrent as never, 2);
    assert.equal(previewSource.mode, 'image');
    assert.equal(previewSource.reason, null);
    assert.equal(previewSource.presentation?.kind, 'preview');
    assert.equal(previewSource.presentation?.originalWidth, width);
    assert.equal(previewSource.presentation?.originalHeight, height);
    assert.equal(previewSource.presentation?.mimeType, 'image/webp');
    assert.equal(previewSource.presentation?.extension, 'webp');
    assert.ok(previewSource.presentation!.width <= 2048 && previewSource.presentation!.height <= 2048);
    assert.ok(Math.abs(previewSource.presentation!.width / previewSource.presentation!.height - width / height) < 0.001);
    const previewBytes = Buffer.from(await previewSource.file!.arrayBuffer());
    assert.ok(previewBytes.length > 0 && previewBytes.length <= IMAGE_FEISHU_MAX_BYTES);
    assert.equal(sha256(previewBytes), previewSource.presentation?.contentHash);
    const previewMetadata = await sharp(previewBytes).metadata();
    assert.equal(previewMetadata.format, 'webp');
    assert.equal(previewMetadata.hasAlpha, true);
    const previewStats = await sharp(previewBytes).stats();
    assert.ok(previewStats.channels[3].min < 255 && previewStats.channels[3].max > 0);
    assert.equal(sha256(await readFile(path.join(assets, `${sha256(large)}.png`))), originalHash);
    done();

    const repeated = await prepareImageFeishuSource(largeCurrent as never, 2);
    assert.deepEqual(repeated.presentation, previewSource.presentation);
    assert.deepEqual(Buffer.from(await repeated.file!.arrayBuffer()), previewBytes);
    done();

    const corrupt = Buffer.from(small);
    corrupt[Math.floor(corrupt.length / 2)] ^= 1;
    const corruptCurrent = await current('corrupt', small, 'image/png', 'png', { width: 24, height: 36 });
    await writeFile(path.join(assets, `${sha256(small)}.png`), corrupt, { mode: 0o600 });
    await assert.rejects(prepareImageFeishuSource(corruptCurrent as never, 2), (error: { code?: string }) => error.code === 'image_original_unavailable');
    const undecodable = Buffer.from('not a decodable PNG');
    const undecodableCurrent = await current('undecodable', undecodable, 'image/png', 'png', { width: 24, height: 36 });
    await assert.rejects(prepareImageFeishuSource(undecodableCurrent as never, 2), (error: { code?: string }) => error.code === 'image_original_unavailable');
    done();

    const symlinkBytes = await sharp({ create: { width: 18, height: 18, channels: 3, background: '#123456' } }).png().toBuffer();
    const symlinkHash = sha256(symlinkBytes);
    const outside = path.join(run, 'outside.png');
    await writeFile(outside, symlinkBytes, { mode: 0o600 });
    await symlink(outside, path.join(assets, `${symlinkHash}.png`));
    const symlinkCurrent = { actor: {}, task: { id: 'symlink', owner_id: 'fixture-owner', module_id: null, status: 'succeeded',
      asset_id: 'asset-symlink', deleted_at: null, usage_json: null, finished_at: new Date() }, asset: { id: 'asset-symlink', owner_id: 'fixture-owner',
      original_url: `/uploads/assets/${symlinkHash}.png`, mime_type: 'image/png', file_size: symlinkBytes.length, hash: symlinkHash, width: 18, height: 18 } };
    await assert.rejects(prepareImageFeishuSource(symlinkCurrent as never, 2), (error: { code?: string }) => error.code === 'image_original_unavailable');
    done();

    assert.equal(cases, 5);
    console.log(JSON.stringify({ passed: true, cases, originalBytes: large.length, originalWidth: width, originalHeight: height, previewBytes: previewBytes.length, previewWidth: previewMetadata.width, previewHeight: previewMetadata.height, previewAlphaPreserved: true, originalHashPreserved: true, networkCalls: 0, productionWrites: 0 }));
  } finally {
    process.chdir(originalCwd);
    await rm(run, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
