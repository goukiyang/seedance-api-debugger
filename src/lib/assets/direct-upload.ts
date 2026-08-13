import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import {
  getSiteUploadKind,
  localUploadPathFromSiteUploadUrl,
  sameOriginPublicUrlForLocalUpload,
  validateSiteUploadDuration,
  validateSiteUploadMetadata,
} from '@/lib/assets/site-upload';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';

const DIRECT_UPLOAD_EXPIRES_SECONDS = 10 * 60;
const DIRECT_UPLOAD_PREFIX = 'seedance-direct-uploads';
const DIRECT_UPLOAD_TOKEN_VERSION = 1;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const MULTIPART_UPLOAD_EXPIRES_SECONDS = 24 * 60 * 60;
export const MULTIPART_UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;

type DirectUploadStorageProvider = 'r2' | 'tos' | 'local-public' | 'local' | 'unknown';

export type DirectUploadTicket = {
  directUploadAvailable: true;
  storageProvider: DirectUploadStorageProvider;
  uploadUrl: string;
  uploadToken: string;
  publicUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
};

export type DirectUploadProxyTicket = {
  directUploadAvailable: false;
  storageProvider: DirectUploadStorageProvider;
  uploadToken: string;
  publicUrl: string;
  method: 'POST';
  headers: Record<string, string>;
  expiresAt: string;
  reason: string;
};

export type DirectUploadAssetPayload = {
  id: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  width?: number;
  height?: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  hash: string;
  reused: boolean;
  isPubliclyReachable: boolean;
  storageProvider: DirectUploadStorageProvider;
};

export type DirectUploadReusedTicket = {
  directUploadAvailable: false;
  reused: true;
  reason: string;
  asset: DirectUploadAssetPayload;
};

export type DirectUploadUnavailable = {
  directUploadAvailable: false;
  reason: string;
};

export type DirectUploadTicketResult =
  | DirectUploadTicket
  | DirectUploadProxyTicket
  | DirectUploadReusedTicket
  | DirectUploadUnavailable;

export type MultipartUploadTicket = {
  directUploadAvailable: true;
  uploadMode: 'multipart';
  storageProvider: DirectUploadStorageProvider;
  uploadToken: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  expiresAt: string;
};

export type MultipartUploadTicketResult =
  | MultipartUploadTicket
  | DirectUploadReusedTicket
  | DirectUploadUnavailable;

export type MultipartUploadPartTicket = {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  partNumber: number;
  expiresAt: string;
};

type DirectUploadTokenPayload = {
  version: number;
  storageProvider: DirectUploadStorageProvider;
  ownerHash: string;
  key: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  hash: string;
  expiresAt: number;
  uploadMode?: 'single' | 'multipart';
  uploadId?: string;
  partSize?: number;
};

type CreateDirectUploadTicketInput = {
  ownerId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  hash: string;
  width?: number | null;
  height?: number | null;
};

type CompleteDirectUploadInput = {
  ownerId: string;
  uploadToken: string;
  hash: string;
  trustedHash?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
};

type ProxyDirectUploadInput = CompleteDirectUploadInput & {
  body: NonNullable<PutObjectCommandInput['Body']>;
  contentLength?: number | null;
};

type CreateMultipartUploadTicketInput = CreateDirectUploadTicketInput;

type SignMultipartUploadPartInput = {
  ownerId: string;
  uploadToken: string;
  partNumber: number;
};

type CompleteMultipartUploadInput = CompleteDirectUploadInput & {
  parts: Array<{ partNumber: number; eTag: string }>;
};

type AbortMultipartUploadInput = {
  ownerId: string;
  uploadToken: string;
};

export type DirectUploadAssetResult = {
  assetId: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  width?: number;
  height?: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  hash: string;
  reused: boolean;
  isPubliclyReachable: boolean;
  storageProvider: DirectUploadStorageProvider;
};

type DirectUploadAssetRecord = {
  id: string;
  original_url: string;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  file_name: string;
  file_size: number | null;
  mime_type: string;
  hash: string | null;
};

type R2DirectUploadConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  endpointHostname: string;
};

function getR2DirectUploadConfig(): R2DirectUploadConfig | null {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    R2_PUBLIC_BASE_URL,
  } = process.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return null;
  }
  if (!R2_PUBLIC_BASE_URL || !isPubliclyReachableUrl(R2_PUBLIC_BASE_URL)) {
    return null;
  }

  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
    publicBaseUrl: R2_PUBLIC_BASE_URL.replace(/\/$/, ''),
    endpointHostname: `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  };
}

function envFlagEnabled(value: string | undefined) {
  const flag = (value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(flag);
}

function isR2DirectUploadCorsVerified() {
  return envFlagEnabled(process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED);
}

function isBrowserDirectUploadEnabled() {
  return envFlagEnabled(process.env.R2_DIRECT_UPLOAD_ENABLED) && isR2DirectUploadCorsVerified();
}

function browserDirectUploadUnavailableReason() {
  if (!envFlagEnabled(process.env.R2_DIRECT_UPLOAD_ENABLED)) {
    return '浏览器直传 R2 未开启或桶 CORS 未验证，已改用本站服务端中转上传。';
  }
  if (!isR2DirectUploadCorsVerified()) {
    return 'R2 直传开关已开启，但桶 CORS 尚未标记验收通过，已改用本站服务端中转上传。';
  }
  return '浏览器直传 R2 暂不可用，已改用本站服务端中转上传。';
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  };
  return map[mimeType] || 'bin';
}

function safeFileName(fileName: string) {
  const clean = path.basename(fileName || 'upload.bin').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
  return clean || 'upload.bin';
}

function userUploadPrefix(ownerId: string) {
  return `${DIRECT_UPLOAD_PREFIX}/${userUploadOwnerHash(ownerId)}`;
}

function userUploadOwnerHash(ownerId: string) {
  return crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
}

function createObjectKey(ownerId: string, mimeType: string) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${userUploadPrefix(ownerId)}/${yyyy}${mm}/${uuidv4()}.${mimeTypeToExt(mimeType)}`;
}

function signToken(payload: DirectUploadTokenPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token: string, ownerId: string): DirectUploadTokenPayload {
  const [body, signature] = token.split('.');
  if (!body || !signature) throw new Error('上传票据格式无效，请重新上传。');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error('上传票据校验失败，请重新上传。');
  }

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DirectUploadTokenPayload;
  if (payload.version !== DIRECT_UPLOAD_TOKEN_VERSION) throw new Error('上传票据版本无效，请重新上传。');
  if (payload.ownerHash !== userUploadOwnerHash(ownerId)) {
    throw new Error('上传票据不属于当前账号，请重新登录后重试。');
  }
  if (payload.expiresAt <= Date.now()) throw new Error('上传票据已过期，请重新上传。');
  if (!payload.key.startsWith(`${userUploadPrefix(ownerId)}/`)) {
    throw new Error('上传对象路径无效，请重新上传。');
  }
  return payload;
}

function verifySingleUploadToken(token: string, ownerId: string) {
  const payload = verifyToken(token, ownerId);
  if (payload.uploadMode === 'multipart') {
    throw new Error('上传票据类型不匹配，请重新上传。');
  }
  return payload;
}

function verifyMultipartUploadToken(token: string, ownerId: string) {
  const payload = verifyToken(token, ownerId);
  if (payload.uploadMode !== 'multipart' || !payload.uploadId || !payload.partSize) {
    throw new Error('分块上传票据无效，请重新上传。');
  }
  return payload;
}

function normalizeOptionalInt(value: number | null | undefined) {
  if (!Number.isFinite(value) || value == null) return null;
  const next = Math.floor(value);
  return next > 0 && next < 100000 ? next : null;
}

function assertSha256Hash(hash: string) {
  const normalized = hash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('文件校验信息无效，请重新上传。');
  }
  return normalized;
}

function storageProviderForAssetUrl(url: string): DirectUploadStorageProvider {
  const siteUploadPath = localUploadPathFromSiteUploadUrl(url);
  const normalizedUrl = siteUploadPath ? (sameOriginPublicUrlForLocalUpload(url) || url) : url;
  const siteBaseUrl = (process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const r2BaseUrl = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const tosBaseUrl = (process.env.TOS_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

  if (siteUploadPath) return 'local-public';
  if (siteBaseUrl && normalizedUrl.startsWith(`${siteBaseUrl}/uploads/`)) return 'local-public';
  if (r2BaseUrl && normalizedUrl.startsWith(`${r2BaseUrl}/`)) return 'r2';
  if (tosBaseUrl && normalizedUrl.startsWith(`${tosBaseUrl}/`)) return 'tos';
  if (normalizedUrl.includes('.r2.cloudflarestorage.com/')) return 'r2';
  if (isPubliclyReachableUrl(normalizedUrl)) return 'unknown';
  return 'local';
}

function publicUrlForAssetUrl(url: string) {
  return sameOriginPublicUrlForLocalUpload(url) || url;
}

function localUploadUrlFromAssetUrl(url: string) {
  return localUploadPathFromSiteUploadUrl(url);
}

function assetUrlCanBeReusedWithoutBody(url: string) {
  const localUploadUrl = localUploadUrlFromAssetUrl(url);
  if (!localUploadUrl) return true;
  const publicRoot = path.resolve(process.cwd(), 'public');
  const resolvedPath = path.resolve(publicRoot, localUploadUrl.replace(/^\/+/, ''));
  if (!resolvedPath.startsWith(`${publicRoot}${path.sep}`)) return false;
  return fs.existsSync(resolvedPath);
}

function createR2Client(config: R2DirectUploadConfig) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.endpointHostname}`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function assetRecordToPayload(
  asset: DirectUploadAssetRecord,
  reused: boolean,
): DirectUploadAssetPayload {
  const originalUrl = publicUrlForAssetUrl(asset.original_url);
  const thumbnailUrl = asset.thumbnail_url ? publicUrlForAssetUrl(asset.thumbnail_url) : null;
  return {
    id: asset.id,
    originalUrl,
    thumbnailUrl,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
    fileName: asset.file_name,
    fileSize: asset.file_size ?? 0,
    mimeType: asset.mime_type,
    hash: asset.hash ?? '',
    reused,
    isPubliclyReachable: isPubliclyReachableUrl(originalUrl),
    storageProvider: storageProviderForAssetUrl(asset.original_url),
  };
}

function assetRecordToResult(
  asset: DirectUploadAssetRecord,
  reused: boolean,
): DirectUploadAssetResult {
  const payload = assetRecordToPayload(asset, reused);
  return {
    assetId: payload.id,
    originalUrl: payload.originalUrl,
    thumbnailUrl: payload.thumbnailUrl,
    width: payload.width,
    height: payload.height,
    fileName: payload.fileName,
    fileSize: payload.fileSize,
    mimeType: payload.mimeType,
    hash: payload.hash,
    reused: payload.reused,
    isPubliclyReachable: payload.isPubliclyReachable,
    storageProvider: payload.storageProvider,
  };
}

async function fillMissingAssetDimensions(
  asset: DirectUploadAssetRecord,
  width: number | null,
  height: number | null,
): Promise<DirectUploadAssetRecord> {
  const data: { width?: number; height?: number } = {};
  if (width != null && asset.width == null) data.width = width;
  if (height != null && asset.height == null) data.height = height;
  if (Object.keys(data).length === 0) return asset;

  return prisma.asset.update({
    where: { id: asset.id },
    data,
    select: {
      id: true,
      original_url: true,
      thumbnail_url: true,
      width: true,
      height: true,
      file_name: true,
      file_size: true,
      mime_type: true,
      hash: true,
    },
  });
}

async function findActiveAssetByTrustedHash(ownerId: string, trustedHash: string, mimeType?: string | null) {
  const mimeTypeWhere = mimeType ? { mime_type: mimeType } : {};
  const ownAsset = await prisma.asset.findFirst({
    where: {
      owner_id: ownerId,
      hash: trustedHash,
      ...mimeTypeWhere,
    },
    orderBy: [
      { created_at: 'desc' },
    ],
  });
  if (ownAsset) {
    if (!assetUrlCanBeReusedWithoutBody(ownAsset.original_url)) return null;
    if (ownAsset.status === 'active') return ownAsset;
    return prisma.asset.update({
      where: { id: ownAsset.id },
      data: { status: 'active' },
    });
  }

  const sharedAsset = await prisma.asset.findFirst({
    where: {
      hash: trustedHash,
      status: 'active',
      ...mimeTypeWhere,
    },
    orderBy: [
      { created_at: 'desc' },
    ],
  });
  if (!sharedAsset || !assetUrlCanBeReusedWithoutBody(sharedAsset.original_url)) return null;

  return prisma.asset.create({
    data: {
      id: uuidv4(),
      owner_id: ownerId,
      type: getSiteUploadKind(sharedAsset.mime_type) || 'image',
      original_url: sharedAsset.original_url,
      thumbnail_url: sharedAsset.thumbnail_url,
      file_name: sharedAsset.file_name,
      mime_type: sharedAsset.mime_type,
      width: sharedAsset.width,
      height: sharedAsset.height,
      file_size: sharedAsset.file_size,
      hash: trustedHash,
      status: 'active',
    },
  });
}

async function createAssetFromCompletedUpload(input: {
  ownerId: string;
  payload: DirectUploadTokenPayload;
  width?: number | null;
  height?: number | null;
  trustedHash?: string | null;
  reused?: boolean;
  config: R2DirectUploadConfig;
}): Promise<DirectUploadAssetResult> {
  const trustedHash = input.trustedHash ? assertSha256Hash(input.trustedHash) : null;
  if (trustedHash && trustedHash !== input.payload.hash) {
    throw new Error('上传文件内容和上传票据不一致，请重新上传。');
  }
  const kind = getSiteUploadKind(input.payload.mimeType) || 'image';
  const width = kind === 'audio' ? null : normalizeOptionalInt(input.width);
  const height = kind === 'audio' ? null : normalizeOptionalInt(input.height);

  if (trustedHash) {
    const existingAsset = await findActiveAssetByTrustedHash(input.ownerId, trustedHash, input.payload.mimeType);
    if (existingAsset) {
      const updatedAsset = await fillMissingAssetDimensions(existingAsset, width, height);
      return assetRecordToResult(updatedAsset, true);
    }
  }

  const publicUrl = `${input.config.publicBaseUrl}/${input.payload.key}`;
  const ownAsset = await prisma.asset.findFirst({
    where: {
      owner_id: input.ownerId,
      hash: trustedHash,
      mime_type: input.payload.mimeType,
    },
    orderBy: [
      { created_at: 'desc' },
    ],
  });
  if (ownAsset) {
    const updatedAsset = await prisma.asset.update({
      where: { id: ownAsset.id },
      data: {
        type: kind,
        original_url: publicUrl,
        thumbnail_url: kind === 'image' ? publicUrl : null,
        file_name: input.payload.fileName,
        mime_type: input.payload.mimeType,
        width,
        height,
        file_size: input.payload.fileSize,
        hash: trustedHash,
        status: 'active',
      },
    });
    return assetRecordToResult(updatedAsset, input.reused || false);
  }

  const asset = await prisma.asset.create({
    data: {
      owner_id: input.ownerId,
      type: kind,
      original_url: publicUrl,
      thumbnail_url: kind === 'image' ? publicUrl : null,
      file_name: input.payload.fileName,
      mime_type: input.payload.mimeType,
      width,
      height,
      file_size: input.payload.fileSize,
      hash: trustedHash,
      status: 'active',
    },
  });

  return assetRecordToResult(asset, input.reused || false);
}

function createHashingUploadBody(body: NonNullable<PutObjectCommandInput['Body']>) {
  const hash = crypto.createHash('sha256');
  let byteLength = 0;
  let finalized = false;

  const updateHash = (chunk: Buffer) => {
    byteLength += chunk.length;
    hash.update(chunk);
  };

  const digest = () => {
    if (finalized) throw new Error('上传文件校验信息已读取，请重新上传。');
    finalized = true;
    return hash.digest('hex');
  };

  if (Buffer.isBuffer(body)) {
    updateHash(body);
    return { body, digest, byteLength: () => byteLength };
  }

  if (body instanceof Uint8Array) {
    const buffer = Buffer.from(body);
    updateHash(buffer);
    return { body, digest, byteLength: () => byteLength };
  }

  if (typeof body === 'string') {
    const buffer = Buffer.from(body);
    updateHash(buffer);
    return { body, digest, byteLength: () => byteLength };
  }

  const source = body as NodeJS.ReadableStream;
  if (!source || typeof source.pipe !== 'function') {
    throw new Error('上传文件内容不可读取，请重新上传。');
  }

  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      updateHash(buffer);
      callback(null, chunk);
    },
  });

  return {
    body: source.pipe(hashingStream) as NonNullable<PutObjectCommandInput['Body']>,
    digest,
    byteLength: () => byteLength,
  };
}

export async function createDirectUploadTicket(input: CreateDirectUploadTicketInput): Promise<DirectUploadTicketResult> {
  const mimeType = input.mimeType.split(';')[0]?.trim().toLowerCase() || '';
  const metadataError = validateSiteUploadMetadata({ mimeType, fileSize: input.fileSize });
  if (metadataError) throw new Error(metadataError);
  const hash = assertSha256Hash(input.hash);
  const kind = getSiteUploadKind(mimeType) || 'image';
  const width = kind === 'audio' ? null : normalizeOptionalInt(input.width);
  const height = kind === 'audio' ? null : normalizeOptionalInt(input.height);

  const existingAsset = await findActiveAssetByTrustedHash(input.ownerId, hash, mimeType);
  if (existingAsset) {
    const updatedAsset = await fillMissingAssetDimensions(existingAsset, width, height);
    return {
      directUploadAvailable: false,
      reused: true,
      reason: '已检测到相同素材，已复用上传历史中的文件。',
      asset: assetRecordToPayload(updatedAsset, true),
    };
  }

  const config = getR2DirectUploadConfig();
  if (!config) {
    return {
      directUploadAvailable: false,
      reason: 'R2 直传未启用或桶 CORS 未配置，已回退到普通上传。',
    };
  }

  const key = createObjectKey(input.ownerId, mimeType);
  const expiresAt = Date.now() + DIRECT_UPLOAD_EXPIRES_SECONDS * 1000;
  const payload: DirectUploadTokenPayload = {
    version: DIRECT_UPLOAD_TOKEN_VERSION,
    storageProvider: 'r2',
    ownerHash: userUploadOwnerHash(input.ownerId),
    key,
    fileName: safeFileName(input.fileName),
    mimeType,
    fileSize: input.fileSize,
    hash,
    expiresAt,
  };
  const client = createR2Client(config);
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: mimeType,
  });

  if (!isBrowserDirectUploadEnabled()) {
    return {
      directUploadAvailable: false,
      storageProvider: 'r2',
      uploadToken: signToken(payload),
      publicUrl: `${config.publicBaseUrl}/${key}`,
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      expiresAt: new Date(expiresAt).toISOString(),
      reason: browserDirectUploadUnavailableReason(),
    };
  }

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: DIRECT_UPLOAD_EXPIRES_SECONDS });

  return {
    directUploadAvailable: true,
    storageProvider: 'r2',
    uploadUrl,
    uploadToken: signToken(payload),
    publicUrl: `${config.publicBaseUrl}/${key}`,
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function completeDirectUpload(input: CompleteDirectUploadInput): Promise<DirectUploadAssetResult> {
  const payload = verifySingleUploadToken(input.uploadToken, input.ownerId);
  const config = getR2DirectUploadConfig();
  if (!config) throw new Error('R2 直传配置不可用，请刷新后重试。');

  const durationError = validateSiteUploadDuration(payload.mimeType, input.durationSeconds);
  if (durationError) throw new Error(durationError);

  const client = createR2Client(config);
  const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: payload.key }));
  if (head.ContentLength != null && head.ContentLength !== payload.fileSize) {
    throw new Error('上传文件大小和票据不一致，请重新上传。');
  }
  const actualMimeType = (head.ContentType || payload.mimeType).split(';')[0]?.trim().toLowerCase();
  if (actualMimeType && actualMimeType !== payload.mimeType) {
    throw new Error('上传文件类型和票据不一致，请重新上传。');
  }

  const hash = assertSha256Hash(input.hash);
  if (hash !== payload.hash) {
    throw new Error('文件校验信息和上传票据不一致，请重新上传。');
  }
  const trustedHash = input.trustedHash ? assertSha256Hash(input.trustedHash) : null;
  if (trustedHash && trustedHash !== payload.hash) {
    throw new Error('上传文件内容和上传票据不一致，请重新上传。');
  }
  return createAssetFromCompletedUpload({
    ownerId: input.ownerId,
    payload,
    width: input.width,
    height: input.height,
    trustedHash,
    config,
  });
}

export async function proxyDirectUploadToStorage(input: ProxyDirectUploadInput): Promise<DirectUploadAssetResult> {
  const payload = verifySingleUploadToken(input.uploadToken, input.ownerId);
  const config = getR2DirectUploadConfig();
  if (!config) throw new Error('R2 直传配置不可用，请刷新后重试。');

  const hash = assertSha256Hash(input.hash);
  if (hash !== payload.hash) {
    throw new Error('文件校验信息和上传票据不一致，请重新上传。');
  }

  if (input.contentLength != null && input.contentLength !== payload.fileSize) {
    throw new Error('上传文件大小和票据不一致，请重新上传。');
  }

  const durationError = validateSiteUploadDuration(payload.mimeType, input.durationSeconds);
  if (durationError) throw new Error(durationError);

  const client = createR2Client(config);
  const hashingBody = createHashingUploadBody(input.body);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: payload.key,
    ContentType: payload.mimeType,
    ContentLength: payload.fileSize,
    Body: hashingBody.body,
  }));
  if (hashingBody.byteLength() !== payload.fileSize) {
    throw new Error('上传文件大小和票据不一致，请重新上传。');
  }
  const trustedHash = hashingBody.digest();
  if (trustedHash !== hash) {
    throw new Error('上传文件内容和文件校验信息不一致，请重新上传。');
  }

  return completeDirectUpload({ ...input, hash: trustedHash, trustedHash });
}

export async function createMultipartUploadTicket(input: CreateMultipartUploadTicketInput): Promise<MultipartUploadTicketResult> {
  const mimeType = input.mimeType.split(';')[0]?.trim().toLowerCase() || '';
  const metadataError = validateSiteUploadMetadata({ mimeType, fileSize: input.fileSize });
  if (metadataError) throw new Error(metadataError);
  const hash = assertSha256Hash(input.hash);
  const kind = getSiteUploadKind(mimeType) || 'image';
  const width = kind === 'audio' ? null : normalizeOptionalInt(input.width);
  const height = kind === 'audio' ? null : normalizeOptionalInt(input.height);

  const existingAsset = await findActiveAssetByTrustedHash(input.ownerId, hash, mimeType);
  if (existingAsset) {
    const updatedAsset = await fillMissingAssetDimensions(existingAsset, width, height);
    return {
      directUploadAvailable: false,
      reused: true,
      reason: '已检测到相同素材，已复用上传历史中的文件。',
      asset: assetRecordToPayload(updatedAsset, true),
    };
  }

  const config = getR2DirectUploadConfig();
  if (!config) {
    return {
      directUploadAvailable: false,
      reason: 'R2 分块上传配置不可用，请先配置 R2 存储。',
    };
  }
  if (!isBrowserDirectUploadEnabled()) {
    return {
      directUploadAvailable: false,
      reason: '大文件分块上传需要 R2 浏览器直传和 CORS 验收通过，当前已改用普通上传链路。',
    };
  }

  const key = createObjectKey(input.ownerId, mimeType);
  const expiresAt = Date.now() + MULTIPART_UPLOAD_EXPIRES_SECONDS * 1000;
  const client = createR2Client(config);
  const multipart = await client.send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: mimeType,
  }));
  if (!multipart.UploadId) {
    throw new Error('分块上传初始化失败，请重新上传。');
  }

  const payload: DirectUploadTokenPayload = {
    version: DIRECT_UPLOAD_TOKEN_VERSION,
    storageProvider: 'r2',
    ownerHash: userUploadOwnerHash(input.ownerId),
    key,
    fileName: safeFileName(input.fileName),
    mimeType,
    fileSize: input.fileSize,
    hash,
    expiresAt,
    uploadMode: 'multipart',
    uploadId: multipart.UploadId,
    partSize: MULTIPART_UPLOAD_PART_SIZE_BYTES,
  };

  return {
    directUploadAvailable: true,
    uploadMode: 'multipart',
    storageProvider: 'r2',
    uploadToken: signToken(payload),
    uploadId: multipart.UploadId,
    partSize: MULTIPART_UPLOAD_PART_SIZE_BYTES,
    partCount: Math.ceil(input.fileSize / MULTIPART_UPLOAD_PART_SIZE_BYTES),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function signMultipartUploadPart(input: SignMultipartUploadPartInput): Promise<MultipartUploadPartTicket> {
  const payload = verifyMultipartUploadToken(input.uploadToken, input.ownerId);
  const config = getR2DirectUploadConfig();
  if (!config) throw new Error('R2 分块上传配置不可用，请重新上传。');
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 10000) {
    throw new Error('分块序号无效，请重新上传。');
  }

  const partCount = Math.ceil(payload.fileSize / payload.partSize!);
  if (input.partNumber > partCount) {
    throw new Error('分块序号超出文件大小，请重新上传。');
  }

  const client = createR2Client(config);
  const command = new UploadPartCommand({
    Bucket: config.bucket,
    Key: payload.key,
    UploadId: payload.uploadId,
    PartNumber: input.partNumber,
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: DIRECT_UPLOAD_EXPIRES_SECONDS });

  return {
    uploadUrl,
    method: 'PUT',
    headers: {},
    partNumber: input.partNumber,
    expiresAt: new Date(Date.now() + DIRECT_UPLOAD_EXPIRES_SECONDS * 1000).toISOString(),
  };
}

export async function completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<DirectUploadAssetResult> {
  const payload = verifyMultipartUploadToken(input.uploadToken, input.ownerId);
  const config = getR2DirectUploadConfig();
  if (!config) throw new Error('R2 分块上传配置不可用，请重新上传。');

  const durationError = validateSiteUploadDuration(payload.mimeType, input.durationSeconds);
  if (durationError) throw new Error(durationError);

  const hash = assertSha256Hash(input.hash);
  if (hash !== payload.hash) {
    throw new Error('文件校验信息和上传票据不一致，请重新上传。');
  }

  const partCount = Math.ceil(payload.fileSize / payload.partSize!);
  const parts = normalizeCompletedParts(input.parts, partCount);
  const client = createR2Client(config);
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: config.bucket,
    Key: payload.key,
    UploadId: payload.uploadId,
    MultipartUpload: {
      Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag })),
    },
  }));

  const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: payload.key }));
  if (head.ContentLength != null && head.ContentLength !== payload.fileSize) {
    throw new Error('分块上传文件大小和票据不一致，请重新上传。');
  }

  return createAssetFromCompletedUpload({
    ownerId: input.ownerId,
    payload,
    width: input.width,
    height: input.height,
    trustedHash: null,
    config,
  });
}

export async function abortMultipartUpload(input: AbortMultipartUploadInput) {
  const payload = verifyMultipartUploadToken(input.uploadToken, input.ownerId);
  const config = getR2DirectUploadConfig();
  if (!config) throw new Error('R2 分块上传配置不可用，请重新上传。');

  const client = createR2Client(config);
  await client.send(new AbortMultipartUploadCommand({
    Bucket: config.bucket,
    Key: payload.key,
    UploadId: payload.uploadId,
  }));
}

function normalizeCompletedParts(parts: Array<{ partNumber: number; eTag: string }>, expectedPartCount: number) {
  if (!Array.isArray(parts) || parts.length !== expectedPartCount) {
    throw new Error('分块上传结果不完整，请重新上传。');
  }
  const seen = new Set<number>();
  const normalized = parts.map((part) => {
    const partNumber = Number(part.partNumber);
    const eTag = typeof part.eTag === 'string' ? part.eTag.trim() : '';
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedPartCount || seen.has(partNumber)) {
      throw new Error('分块上传结果无效，请重新上传。');
    }
    if (!eTag || eTag.length > 256) {
      throw new Error('分块上传结果缺少 ETag，请确认 R2 CORS 暴露 ETag 后重试。');
    }
    seen.add(partNumber);
    return { partNumber, eTag };
  });
  return normalized.sort((a, b) => a.partNumber - b.partNumber);
}
