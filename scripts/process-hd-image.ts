// Deliberately no dotenv, Prisma, HD queue or control imports. This process can
// only read one source and write a private run output; publication is parent-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { HD_IMAGE_PROTOCOL, type HdImageMetadata, type HdImageRequest, type HdImageResult } from '../src/lib/media/hd-image-processor';
import { HD_MAX_PIXELS, HdOutputIntegrityError, encodeHdOutput, hdEligibility, hdEncoderParameters, validateHdOutput } from '../src/lib/media/hd-encoder';

const versionOf = (stat: Awaited<ReturnType<typeof fs.stat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const sourceError = (error: unknown): never => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw Object.assign(new Error('source_missing'), { code });
  if (code === 'EACCES') throw Object.assign(new Error('source_unreadable'), { code });
  throw error;
};
let request: HdImageRequest | null = null;
let stage = 'reading';
const send = (message: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
  if (!request || !process.send) { reject(new Error('hd_child_protocol')); return; }
  process.send({ protocol: HD_IMAGE_PROTOCOL, key: request.key, executionId: request.executionId, sourceVersion: request.sourceVersion, ...message }, error => error ? reject(error) : resolve());
});
const finish = () => { if (process.connected) process.disconnect(); };
// An orphan cannot later return a publishable result or wait forever for work.
process.on('disconnect', () => process.exit(0));
const unused = setTimeout(() => process.exit(1), 10_000);
async function run(value: HdImageRequest) {
  clearTimeout(unused);
  request = value;
  if (!value || value.protocol !== HD_IMAGE_PROTOCOL || !/^[a-f0-9]{64}$/.test(value.key)
    || !/^[a-f0-9-]{36}$/.test(value.executionId) || typeof value.sourceVersion !== 'string'
    || !path.isAbsolute(value.inputFile) || !path.isAbsolute(value.workDirectory) || typeof value.preserveText !== 'boolean'
    || !['encode', 'validate', 'verify-original'].includes(value.operation || 'encode')) throw new Error('hd_child_protocol');
  if (await fs.realpath(value.inputFile).catch(sourceError) !== value.inputFile || await fs.realpath(value.workDirectory) !== value.workDirectory) throw new Error('source_boundary');
  const work = await fs.lstat(value.workDirectory);
  if (!work.isDirectory() || work.isSymbolicLink() || work.uid !== process.getuid?.() || (work.mode & 0o077)) throw new Error('hd_child_protocol');
  const before = await fs.stat(value.inputFile).catch(sourceError);
  if (!before.isFile() || !before.size || versionOf(before) !== value.sourceVersion) throw new Error('source_changed');
  sharp.concurrency(2);
  await send({ type: 'stage', stage });
  const meta = await sharp(value.inputFile, { limitInputPixels: false, animated: true }).metadata().catch(error => {
    if (!(error as NodeJS.ErrnoException).code && /unsupported image format|corrupt header|invalid.*(?:image|header)|improper image header|premature end|Input file is missing/i.test((error as Error).message)) throw new Error('source_incompatible');
    return sourceError(error);
  });
  const metadata: HdImageMetadata = { width: meta.width || 0, height: meta.height || 0, originalFormat: meta.format || 'unknown',
    hasAlpha: Boolean(meta.hasAlpha), orientation: meta.orientation || 1, bytes: before.size };
  const common = { protocol: HD_IMAGE_PROTOCOL, type: 'result' as const, key: value.key, executionId: value.executionId,
    sourceVersion: value.sourceVersion, inputFile: value.inputFile, workDirectory: value.workDirectory, metadata, libraries: { ...sharp.versions } } satisfies HdImageResult;
  const reason = hdEligibility(meta);
  if (reason && (value.operation || 'encode') === 'encode') { await send({ ...common, skipped: reason }); finish(); return; }
  await send({ type: 'prepared', metadata });
  await new Promise<void>((resolve, reject) => {
    process.once('message', raw => {
      const next = raw as Record<string, unknown>;
      if (next?.protocol !== HD_IMAGE_PROTOCOL || next.type !== 'proceed' || next.executionId !== value.executionId) reject(new Error('hd_child_protocol'));
      else resolve();
    });
  });
  if (value.operation === 'verify-original') {
    stage = 'validating'; await send({ type: 'stage', stage });
    await sharp(value.inputFile, { limitInputPixels: HD_MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 120 }).stats();
    if (versionOf(await fs.stat(value.inputFile)) !== value.sourceVersion) throw new Error('source_changed');
    await send({ ...common, originalVerified: true }); finish(); return;
  }
  const format = value.operation === 'validate' ? value.candidateFormat : meta.hasAlpha || value.preserveText ? 'webp' : 'avif';
  if (format !== 'webp' && format !== 'avif') throw new Error('hd_child_protocol');
  const output = path.join(value.workDirectory, `output.${format}`);
  if (value.operation === 'validate') {
    const candidate = await fs.lstat(output);
    if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1) throw new Error('hd_child_protocol');
  } else {
    stage = 'encoding'; await send({ type: 'stage', stage });
    await encodeHdOutput(value.inputFile, output, format);
  }
  stage = 'validating'; await send({ type: 'stage', stage });
  const integrity = await validateHdOutput(value.inputFile, meta, output, format);
  if (versionOf(await fs.stat(value.inputFile)) !== value.sourceVersion) throw new Error('source_changed');
  const stat = await fs.lstat(output);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size || meta.width! * meta.height! > HD_MAX_PIXELS) throw new Error('output_integrity');
  const handle = await fs.open(output, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  const result: HdImageResult = { ...common, outputFile: path.basename(output), outputVersion: versionOf(stat), format, bytes: stat.size, integrity, parameters: hdEncoderParameters(format) };
  await send(result);
  finish();
}
process.once('message', value => {
  void run(value as HdImageRequest).catch(async error => {
    const code = (error as NodeJS.ErrnoException).code;
    const message = (error as Error).message;
    const known = ['source_changed', 'source_missing', 'source_unreadable', 'source_incompatible', 'output_integrity'];
    const kind = error instanceof HdOutputIntegrityError ? 'output_integrity' : known.includes(message) ? message
      : ['EAGAIN', 'EBUSY', 'ETIMEDOUT'].includes(code || '') ? 'temporary_io'
      : /timeout|timed out/i.test(message) && stage === 'encoding' ? 'encode_timeout' : 'worker_integrity_failure';
    const safe = String(message).replaceAll(request?.inputFile || '\0', '[source]').replaceAll(request?.workDirectory || '\0', '[output]')
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/\/(?:[^\s'"<>]+\/)*[^\s'"<>]*/g, '[path]')
      .replace(/(?:key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, '[credential]').replace(/[a-zA-Z0-9_=-]{40,}/g, '[identifier]').slice(0, 240);
    await send({ type: 'error', kind, diagnostic: { stage, ...(code && /^[A-Z0-9_]+$/.test(code) ? { code } : {}), message: safe },
      ...(error instanceof HdOutputIntegrityError ? { integrity: error.integrity } : {}) }).catch(() => {});
    process.exitCode = 1; finish();
  });
});
