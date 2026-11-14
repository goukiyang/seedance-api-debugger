import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import https, { type RequestOptions } from 'node:https';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import sharp from 'sharp';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const verifiedUploadMetadata = (hash: string) => JSON.stringify({ uploadIntegrity: { version: 'verified-upload-v2', hash } });

async function waitUntil(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the actual background display reader');
}

async function main() {
  const root = process.cwd();
  const scratch = path.join(root, '.role-tests');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(scratch, 'trusted-display-cache-'));
  const originals = new Map<string, Buffer>();
  let networkReads = 0;
  let activeReads = 0;
  let maximumActiveReads = 0;
  let clock = 1_800_000_000_000;

  mock.method(Date, 'now', () => clock);
  mock.method(dns, 'lookup', async (hostname: string) => {
    assert.equal(hostname, 'trusted-display.invalid');
    return [{ address: '8.8.8.8', family: 4 }];
  });
  mock.method(https, 'get', (url: URL, options: RequestOptions, receive: (response: PassThrough) => void) => {
    assert.equal(url.hostname, 'trusted-display.invalid');
    assert.ok(options.signal);
    const bytes = originals.get(url.href);
    assert.ok(bytes, `Unexpected controlled remote read: ${url.href}`);
    networkReads += 1;
    activeReads += 1;
    maximumActiveReads = Math.max(maximumActiveReads, activeReads);

    const request = new EventEmitter() as EventEmitter & { reusedSocket: boolean; destroy: (error?: Error) => void };
    request.reusedSocket = true;
    request.destroy = error => {
      if (error) request.emit('error', error);
      request.emit('close');
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      request.emit('socket', socket);
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        complete: boolean;
        setTimeout: (milliseconds: number, callback: () => void) => PassThrough;
      };
      response.statusCode = 200;
      response.headers = { 'content-length': String(bytes.length), 'content-type': 'image/png' };
      response.complete = true;
      response.setTimeout = () => response;
      response.once('end', () => { activeReads -= 1; });
      receive(response);
      setTimeout(() => response.end(bytes), 20);
    });
    return request as never;
  });

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const media = await import('../src/lib/image-studio/media');
    const sourceA = `https://trusted-display.invalid/seedance-direct-uploads/${'a'.repeat(64)}/202610/00000000-0000-4000-8000-000000000001.png`;
    const bytesA = await sharp({ create: { width: 96, height: 72, channels: 3, background: '#345678' } }).png().toBuffer();
    originals.set(sourceA, bytesA);
    const versionA = media.trustedStudioImageVersion({ original_url: sourceA, hash: sha256(bytesA), file_size: bytesA.length });
    assert.ok(versionA);
    assert.equal(versionA.proof, 'candidate', 'A legacy remote upload without integrity metadata starts as a weak candidate');
    assert.equal(media.trustedStudioImageVersion({ original_url: sourceA, hash: sha256(bytesA), file_size: bytesA.length,
      metadata_json: verifiedUploadMetadata(sha256(bytesA)) })?.proof, 'verified-upload-v2');
    assert.equal(media.trustedStudioImageVersion({ original_url: sourceA, hash: null, file_size: bytesA.length }), undefined);
    assert.equal(media.trustedStudioImageVersion({ original_url: '/uploads/assets/local.png', hash: sha256(bytesA), file_size: bytesA.length }), undefined);

    assert.equal(await media.statStudioDisplayImage(sourceA, 'thumbnail', versionA), null);
    assert.equal(await media.statStudioDisplayImage(sourceA, 'preview', versionA), null);
    assert.equal(networkReads, 0, 'Trusted remote stat misses must not start display jobs');

    const thumbnailA = await media.readStudioThumbnail(sourceA, versionA);
    await waitUntil(async () => Boolean(await media.statStudioDisplayImage(sourceA, 'preview', versionA)));
    assert.equal(networkReads, 2, 'Thumbnail and its background preview have separate first derivatives');
    assert.deepEqual(await sharp(thumbnailA).metadata().then(({ width, height }) => ({ width, height })), { width: 96, height: 72 });
    const previewA = await media.readStudioPreview(sourceA, versionA);
    assert.deepEqual(await sharp(previewA).metadata().then(({ width, height }) => ({ width, height })), { width: 96, height: 72 });
    assert.ok(await media.statStudioDisplayImage(sourceA, 'thumbnail', versionA));
    assert.equal(networkReads, 2, 'Trusted remote stat hits only read existing metadata');

    clock += 180_000;
    await media.readStudioThumbnail(sourceA, versionA);
    await media.readStudioPreview(sourceA, versionA);
    assert.equal(networkReads, 2, 'A byte-matched legacy upload promotes each derivative to stable reuse across minutes');

    const dedupSource = 'https://trusted-display.invalid/dedup.png';
    originals.set(dedupSource, bytesA);
    const dedupVersion = media.trustedStudioImageVersion({ original_url: dedupSource, hash: sha256(bytesA), file_size: bytesA.length });
    assert.ok(dedupVersion);
    const beforeDedup = networkReads;
    const dedupOutputs = await Promise.all(Array.from({ length: 6 }, () => media.readStudioDetail(dedupSource, dedupVersion)));
    assert.equal(networkReads - beforeDedup, 1, 'Same trusted source and variant keep the existing in-process job deduplication');
    assert.ok(dedupOutputs.every(output => output.equals(dedupOutputs[0])));

    const bytesB = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#8a451c' } }).png().toBuffer();
    originals.set(sourceA, bytesB);
    const versionB = media.trustedStudioImageVersion({ original_url: sourceA, hash: sha256(bytesB), file_size: bytesB.length });
    assert.ok(versionB);
    const beforeVersionChange = networkReads;
    const previewB = await media.readStudioPreview(sourceA, versionB);
    assert.equal(networkReads - beforeVersionChange, 1, 'A changed trusted content identity rebuilds the requested variant');
    assert.notEqual(sha256(previewA), sha256(previewB));
    assert.ok(await media.statStudioDisplayImage(sourceA, 'preview', versionA), 'The prior version derivative remains readable');
    assert.ok(await media.statStudioDisplayImage(sourceA, 'preview', versionB));

    const mismatchSource = 'https://trusted-display.invalid/mismatch.png';
    originals.set(mismatchSource, bytesA);
    const mismatchedVersion = media.trustedStudioImageVersion({ original_url: mismatchSource,
      hash: sha256(Buffer.from(mismatchSource)), file_size: bytesA.length });
    assert.ok(mismatchedVersion);
    assert.equal(mismatchedVersion.proof, 'candidate');
    const beforeWeakMismatch = networkReads;
    const mismatchDisplay = await media.readStudioDetail(mismatchSource, mismatchedVersion);
    assert.deepEqual(await sharp(mismatchDisplay).metadata().then(({ width, height }) => ({ width, height })), { width: 96, height: 72 });
    assert.equal(networkReads - beforeWeakMismatch, 1, 'A non-byte Asset hash renders from the already downloaded bytes without a second fetch');
    assert.equal(await media.statStudioDisplayImage(mismatchSource, 'detail', mismatchedVersion), null,
      'A weak hash mismatch must not publish a stablev3 derivative');
    await media.readStudioDetail(mismatchSource, mismatchedVersion);
    assert.equal(networkReads - beforeWeakMismatch, 1, 'The weak mismatch reuses the existing bounded derivative within its minute');
    clock += 180_000;
    await media.readStudioDetail(mismatchSource, mismatchedVersion);
    assert.equal(networkReads - beforeWeakMismatch, 2, 'A weak mismatch retains bounded freshness instead of becoming permanently URL-stable');

    const strongMismatchSource = 'https://trusted-display.invalid/verified-mismatch.png';
    originals.set(strongMismatchSource, bytesA);
    const strongMismatchHash = sha256(bytesB);
    const strongMismatchVersion = media.trustedStudioImageVersion({ original_url: strongMismatchSource,
      hash: strongMismatchHash, file_size: bytesA.length, metadata_json: verifiedUploadMetadata(strongMismatchHash) });
    assert.ok(strongMismatchVersion);
    assert.equal(strongMismatchVersion.proof, 'verified-upload-v2');
    await assert.rejects(media.readStudioDetail(strongMismatchSource, strongMismatchVersion), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'download_source_changed');
      return true;
    });
    assert.equal(await media.statStudioDisplayImage(strongMismatchSource, 'detail', strongMismatchVersion), null,
      'A verified-upload-v2 mismatch must fail without publishing a derivative');

    const independentThumbnail = 'https://trusted-display.invalid/independent-thumbnail.png';
    originals.set(independentThumbnail, bytesA);
    const beforeWrongVersion = networkReads;
    await assert.rejects(media.readStudioPreview(independentThumbnail, versionA), /可信图片版本与读取源不一致/);
    assert.equal(networkReads, beforeWrongVersion, 'An original version cannot be borrowed by an independent thumbnail source');
    await media.readStudioPreview(independentThumbnail);
    const afterUnknownFirstRead = networkReads;
    clock += 180_000;
    assert.equal(await media.statStudioDisplayImage(independentThumbnail, 'preview'), null);
    await media.readStudioPreview(independentThumbnail);
    assert.equal(networkReads, afterUnknownFirstRead + 1, 'Unknown remote sources retain the existing bounded minute freshness');

    maximumActiveReads = 0;
    const concurrent = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const source = `https://trusted-display.invalid/concurrent-${index}.png`;
      const bytes = await sharp({ create: { width: 700 + index, height: 500, channels: 3, background: { r: 30 + index, g: 80, b: 120 } } }).png().toBuffer();
      originals.set(source, bytes);
      const version = media.trustedStudioImageVersion({ original_url: source, hash: sha256(bytes), file_size: bytes.length });
      assert.ok(version);
      return media.readStudioDetail(source, version);
    }));
    assert.equal(concurrent.length, 3);
    assert.equal(maximumActiveReads, 2, 'Distinct derivative jobs keep the existing two-slot execution bound');

    const localDirectory = path.join(directory, 'public', 'uploads', 'assets');
    await mkdir(localDirectory, { recursive: true });
    const localFile = path.join(localDirectory, 'original.png');
    await writeFile(localFile, bytesA);
    await media.readStudioPreview('/uploads/assets/original.png');
    const cacheDirectory = path.join(directory, 'storage', 'studio-thumbnails');
    const existingCache = new Set(await readdir(cacheDirectory));
    await media.readStudioDetail(sourceA, versionB);
    const finalCache = new Set(await readdir(cacheDirectory));
    assert.ok(existingCache.size > 0 && Array.from(existingCache).every(file => finalCache.has(file)), 'Existing v2 derivatives are not deleted or migrated');
    assert.equal(sha256(await import('node:fs/promises').then(fs => fs.readFile(localFile))), sha256(bytesA), 'Existing original bytes remain unchanged');

    console.log(JSON.stringify({ schema: 'trusted-display-cache-engineering.v1', completed: true,
      checks: 13, networkReads, maximumActiveReads: 2, applicationDatabaseOpened: false,
      fixtures: { legacyUpload: 'weak-match-stablev3', nonByteHash: 'bounded-fallback', verifiedUploadV2: 'mismatch-rejected' },
      paidRequests: 0, browserRuns: 0, scope: 'Actual display readers in isolated storage with controlled DNS, HTTPS bytes, time, and concurrency' }));
  } finally {
    process.chdir(previousCwd);
    mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
