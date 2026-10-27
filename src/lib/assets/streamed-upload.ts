import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

export class UploadStreamError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
export function createUploadHash(expectedBytes?: number, maxBytes = expectedBytes || 200 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxBytes)) throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', '上传大小信息无效');
  const hash = createHash('sha256'); let bytes = 0, finalized = false;
  return {
    update(chunk: Uint8Array) { bytes += chunk.byteLength;
      if (bytes > maxBytes || expectedBytes !== undefined && bytes > expectedBytes) throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', '实际上传大小超出限制');
      hash.update(chunk);
    },
    byteLength: () => bytes,
    digest() {
      if (finalized) throw new UploadStreamError('UPLOAD_HASH_MISMATCH', '上传校验信息已读取');
      finalized = true;
      if (!bytes || expectedBytes !== undefined && bytes !== expectedBytes) throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', '文件没有完整上传');
      return hash.digest('hex');
    },
  };
}
type UploadSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
type ReceiveOptions = { expectedBytes?: number; expectedHash?: string; maxBytes: number; directory?: string; signal?: AbortSignal; timeoutMs?: number };
export type TemporaryUpload = { file: string; bytes: number; hash: string; cleanup: () => Promise<void> };
function nodeSource(body: UploadSource) {
  return 'getReader' in body ? Readable.fromWeb(body as import('node:stream/web').ReadableStream) : Readable.from(body, { objectMode: false, highWaterMark: 65536 });
}
export async function streamToTemporaryUpload(body: UploadSource, options: ReceiveOptions): Promise<TemporaryUpload> {
  const hash = createUploadHash(options.expectedBytes, options.maxBytes);
  const owned = !options.directory;
  const directory = options.directory || await mkdtemp(path.join(os.tmpdir(), 'sd2-upload-receive-'));
  const file = path.join(directory, `${randomUUID()}.upload`);
  const cleanup = async () => { await rm(owned ? directory : file, { force: true, recursive: owned }); };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs || 180000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) {
    try { hash.update(chunk); done(null, chunk); } catch (error) { done(error as Error); }
  } });
  try {
    await pipeline(nodeSource(body), hashing, createWriteStream(file, { flags: 'wx', mode: 0o600, highWaterMark: 65536 }), { signal });
    const digest = hash.digest();
    if (options.expectedHash !== undefined && digest !== options.expectedHash) throw new UploadStreamError('UPLOAD_HASH_MISMATCH', '实际上传内容与原准备信息不一致');
    return { file, bytes: hash.byteLength(), hash: digest, cleanup };
  } catch (error) {
    await cleanup();
    if (signal.aborted) throw new UploadStreamError(deadline.signal.aborted ? 'UPLOAD_BODY_TIMEOUT' : 'UPLOAD_BODY_INTERRUPTED', '上传接收已停止，尚未保存', deadline.signal.aborted ? 408 : 400);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function readMultipartUpload(request: Request, expectedBytes: number, maxBytes: number) {
  if (!request.body) throw new UploadStreamError('UPLOAD_BODY_MISSING', '没有收到上传文件');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180000)]);
  const total = createUploadHash(expectedBytes, maxBytes);
  const parser = Busboy({ headers: { 'content-type': request.headers.get('content-type') || '' }, defParamCharset: 'utf8',
    limits: { files: 1, fields: 16, parts: 17, fileSize: maxBytes, fieldSize: 8192 }, highWaterMark: 65536, fileHwm: 65536 });
  let pending: Promise<TemporaryUpload> | undefined;
  let fileName = '', mimeType = '';
  parser.on('file', (field, file, info) => {
    if (field !== 'file') { file.resume(); return; }
    fileName = info.filename || 'upload.bin'; mimeType = info.mimeType;
    file.once('limit', () => file.destroy(new UploadStreamError('UPLOAD_SIZE_MISMATCH', '上传文件过大')));
    pending = streamToTemporaryUpload(file, { maxBytes, signal });
    pending.catch(error => { parser.destroy(error); });
  });
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) parser.on(event, () => parser.destroy(new UploadStreamError('UPLOAD_SIZE_MISMATCH', '表单上传内容超出限制')));
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    try { total.update(chunk); done(null, chunk); } catch (error) { done(error as Error); }
  }, flush(done) { try { total.digest(); done(); } catch (error) { done(error as Error); } } });
  try {
    await pipeline(nodeSource(request.body), limiter, parser, { signal });
    if (!pending) throw new UploadStreamError('UPLOAD_BODY_MISSING', '没有收到上传文件');
    const received = await pending;
    return { ...received, fileName, mimeType, fileSize: received.bytes };
  } catch (error) {
    const received = await pending?.catch(() => null); await received?.cleanup();
    if (signal.aborted) throw new UploadStreamError('UPLOAD_BODY_INTERRUPTED', '上传接收已停止，尚未保存');
    throw error;
  }
}
