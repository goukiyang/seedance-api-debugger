import crypto from 'crypto';
import path from 'path';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import {
  getSiteUploadKind,
  validateSiteUploadDuration,
  validateSiteUploadMetadata,
} from '@/lib/assets/site-upload';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';

const DIRECT_UPLOAD_EXPIRES_SECONDS = 10 * 60;
const DIRECT_UPLOAD_PREFIX = 'seedance-direct-uploads';
const DIRECT_UPLOAD_TOKEN_VERSION = 1;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

type DirectUploadStorageProvider = 'r2';

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

export type DirectUploadUnavailable = {
  directUploadAvailable: false;
  reason: string;
};

export type DirectUploadTicketResult = DirectUploadTicket | DirectUploadUnavailable;

type DirectUploadTokenPayload = {
  version: number;
  storageProvider: DirectUploadStorageProvider;
  ownerHash: string;
  key: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  expiresAt: number;
};

type CreateDirectUploadTicketInput = {
  ownerId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
};

type CompleteDirectUploadInput = {
  ownerId: string;
  uploadToken: string;
  hash: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
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

function encodePath(pathname: string) {
  return pathname
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function formatPresignedUrl(request: {
  protocol?: string;
  hostname: string;
  path: string;
  query?: Record<string, string | Array<string> | null | undefined>;
}) {
  const protocol = request.protocol || 'https:';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query || {})) {
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, String(item)));
    } else if (value !== undefined) {
      query.append(key, String(value));
    }
  }
  const queryString = query.toString();
  return `${protocol}//${request.hostname}${request.path}${queryString ? `?${queryString}` : ''}`;
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

export async function createDirectUploadTicket(input: CreateDirectUploadTicketInput): Promise<DirectUploadTicketResult> {
  const mimeType = input.mimeType.split(';')[0]?.trim().toLowerCase() || '';
  const metadataError = validateSiteUploadMetadata({ mimeType, fileSize: input.fileSize });
  if (metadataError) throw new Error(metadataError);

  const config = getR2DirectUploadConfig();
  if (!config) {
    return {
      directUploadAvailable: false,
      reason: 'R2 直传未配置，已回退到普通上传。',
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
    expiresAt,
  };
  const signer = new SignatureV4({
    service: 's3',
    region: 'auto',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    sha256: Hash.bind(null, 'sha256') as never,
  });
  const request = new HttpRequest({
    protocol: 'https:',
    method: 'PUT',
    hostname: config.endpointHostname,
    path: encodePath(`/${config.bucket}/${key}`),
    headers: {
      host: config.endpointHostname,
      'content-type': mimeType,
    },
  });
  const signed = await signer.presign(request, { expiresIn: DIRECT_UPLOAD_EXPIRES_SECONDS });

  return {
    directUploadAvailable: true,
    storageProvider: 'r2',
    uploadUrl: formatPresignedUrl(signed),
    uploadToken: signToken(payload),
    publicUrl: `${config.publicBaseUrl}/${key}`,
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function completeDirectUpload(input: CompleteDirectUploadInput): Promise<DirectUploadAssetResult> {
  const payload = verifyToken(input.uploadToken, input.ownerId);
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
  const existing = await prisma.asset.findFirst({
    where: { owner_id: input.ownerId, hash },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const activeAsset = existing.status === 'active'
      ? existing
      : await prisma.asset.update({
        where: { id: existing.id },
        data: { status: 'active' },
      });
    return {
      assetId: activeAsset.id,
      originalUrl: activeAsset.original_url,
      thumbnailUrl: activeAsset.thumbnail_url,
      width: activeAsset.width ?? undefined,
      height: activeAsset.height ?? undefined,
      fileName: activeAsset.file_name,
      fileSize: activeAsset.file_size,
      mimeType: activeAsset.mime_type,
      hash: activeAsset.hash ?? hash,
      reused: true,
      isPubliclyReachable: isPubliclyReachableUrl(activeAsset.original_url),
      storageProvider: 'r2',
    };
  }

  const kind = getSiteUploadKind(payload.mimeType) || 'image';
  const width = kind === 'image' ? normalizeOptionalInt(input.width) : null;
  const height = kind === 'image' ? normalizeOptionalInt(input.height) : null;
  const publicUrl = `${config.publicBaseUrl}/${payload.key}`;
  const asset = await prisma.asset.create({
    data: {
      owner_id: input.ownerId,
      type: kind,
      original_url: publicUrl,
      thumbnail_url: kind === 'image' ? publicUrl : null,
      file_name: payload.fileName,
      mime_type: payload.mimeType,
      width,
      height,
      file_size: payload.fileSize,
      hash,
      status: 'active',
    },
  });

  return {
    assetId: asset.id,
    originalUrl: asset.original_url,
    thumbnailUrl: asset.thumbnail_url,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
    fileName: asset.file_name,
    fileSize: asset.file_size,
    mimeType: asset.mime_type,
    hash: asset.hash ?? hash,
    reused: false,
    isPubliclyReachable: true,
    storageProvider: 'r2',
  };
}
