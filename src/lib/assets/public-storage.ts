/**
 * 公网上传模块
 *
 * 支持按优先级自动选择：
 * 1. Cloudflare R2
 * 2. 火山引擎 TOS
 * 3. 本地 public 目录（公网需部署后可用）
 * 4. 本地（localhost，仅本地预览）
 *
 * 所有配置均通过环境变量控制，未配置的对象存储自动跳过。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { TosClient } from '@volcengine/tos-sdk';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const PUBLIC_VIDEO_STREAM_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// URL 判断工具
// ============================================================================

/**
 * 基础判断 URL 是否可能公网可访问（不含 100% 准确判断）
 */
export function isPubliclyReachableUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    // 私有网络地址不是公网
    if (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '0.0.0.0' ||
      u.hostname === '[::1]' ||
      u.hostname.startsWith('192.168.') ||
      u.hostname.startsWith('10.') ||
      u.hostname.startsWith('172.16.') ||
      u.hostname.startsWith('172.17.') ||
      u.hostname.startsWith('172.18.') ||
      u.hostname.startsWith('172.19.') ||
      u.hostname.startsWith('172.20.') ||
      u.hostname.startsWith('172.21.') ||
      u.hostname.startsWith('172.22.') ||
      u.hostname.startsWith('172.23.') ||
      u.hostname.startsWith('172.24.') ||
      u.hostname.startsWith('172.25.') ||
      u.hostname.startsWith('172.26.') ||
      u.hostname.startsWith('172.27.') ||
      u.hostname.startsWith('172.28.') ||
      u.hostname.startsWith('172.29.') ||
      u.hostname.startsWith('172.30.') ||
      u.hostname.startsWith('172.31.') ||
      u.hostname.startsWith('127.') ||
      u.hostname.startsWith('169.254.') ||
      u.hostname.endsWith('.local') ||
      u.hostname.match(/^10\.\d+\.\d+\.\d+$/) !== null
    ) {
      return false;
    }
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// ============================================================================
// 配置读取
// ============================================================================

interface StorageConfig {
  provider: 'tos' | 'r2' | 'local-public' | 'local';
  isPubliclyReachable: boolean;
}

function getStorageConfig(): StorageConfig {
  // 优先检查 R2
  if (
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  ) {
    return { provider: 'r2', isPubliclyReachable: true };
  }

  // 检查 TOS
  if (
    process.env.TOS_REGION &&
    process.env.TOS_BUCKET &&
    process.env.TOS_ACCESS_KEY &&
    process.env.TOS_SECRET_KEY
  ) {
    return { provider: 'tos', isPubliclyReachable: true };
  }

  // 检查公网静态目录（已有公网域名）
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || '';
  if (baseUrl && isPubliclyReachableUrl(baseUrl)) {
    return { provider: 'local-public', isPubliclyReachable: true };
  }

  return { provider: 'local', isPubliclyReachable: false };
}

// ============================================================================
// TOS 上传
// ============================================================================

async function uploadToTOS(buffer: Buffer, fileName: string, mimeType: string): Promise<{ publicUrl: string; key: string }> {
  const { TOS_REGION, TOS_BUCKET, TOS_ENDPOINT, TOS_ACCESS_KEY, TOS_SECRET_KEY, TOS_PUBLIC_BASE_URL } = process.env;

  const region = TOS_REGION || 'ap-southeast-1';
  const endpoint = TOS_ENDPOINT || `https://tos-ap-southeast-1.volces.com`;
  const bucket = TOS_BUCKET!;
  const accessKey = TOS_ACCESS_KEY!;
  const secretKey = TOS_SECRET_KEY!;

  const client = new TosClient({
    endpoint,
    region,
    accessKeyId: accessKey,
    accessKeySecret: secretKey,
  });

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = mimeTypeToExt(mimeType);
  const key = `seedance-uploads/${hash.slice(0, 8)}-${Date.now()}.${ext}`;

  await client.putObject({
    bucket,
    key,
    body: buffer,
    contentType: mimeType,
  });

  const publicBase = TOS_PUBLIC_BASE_URL || `https://${bucket}.${endpoint}`;
  const publicUrl = `${publicBase.replace(/\/$/, '')}/${key}`;

  return { publicUrl, key };
}

// ============================================================================
// R2 上传
// ============================================================================

async function uploadToR2(buffer: Buffer, fileName: string, mimeType: string): Promise<{ publicUrl: string; key: string }> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = process.env;

  if (!R2_PUBLIC_BASE_URL || !isPubliclyReachableUrl(R2_PUBLIC_BASE_URL)) {
    throw new Error('R2_PUBLIC_BASE_URL 未配置为公网地址，无法生成可被 Seedance 下载的 publicUrl');
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID!,
      secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
  });

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = mimeTypeToExt(mimeType);
  const key = `seedance-uploads/${hash.slice(0, 8)}-${Date.now()}.${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));

  const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;

  return { publicUrl, key };
}

// ============================================================================
// 本地上传（public 目录）
// ============================================================================

const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'assets');

function uploadToLocalPublic(buffer: Buffer, fileName: string, mimeType: string): { publicUrl: string; key: string } {
  if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = mimeTypeToExt(mimeType);
  const storedFileName = `${hash}.${ext}`;
  const filePath = path.join(LOCAL_UPLOAD_DIR, storedFileName);

  // 去重：已存在则跳过写
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }

  const key = `uploads/assets/${storedFileName}`;
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const publicUrl = `${baseUrl}/${key}`;

  return { publicUrl, key };
}

function safeFileStem(fileName: string) {
  const raw = path.basename(fileName, path.extname(fileName)).trim();
  return (raw || 'video')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';
}

function objectKeyForStream(fileName: string, mimeType: string) {
  const ext = mimeTypeToExt(mimeType);
  return `seedance-videos/${safeFileStem(fileName)}-${uuidv4()}.${ext}`;
}

function toNodeReadable(body: NodeJS.ReadableStream | ReadableStream<Uint8Array>): Readable {
  if ('pipe' in body && typeof body.pipe === 'function') {
    return body as Readable;
  }
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

function publicVideoStreamTimeoutMs() {
  const raw = Number(process.env.VIDEO_PUBLIC_STREAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PUBLIC_VIDEO_STREAM_TIMEOUT_MS;
}

async function withPublicVideoStreamTimeout<T>(
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = publicVideoStreamTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} 超时，超过 ${Math.round(timeoutMs / 1000)} 秒未完成`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type SpoolStreamTempFile = {
  path: string;
  size: number;
  cleanup: () => Promise<void>;
};

async function spoolStreamToTempFile(
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  fileName: string,
  signal?: AbortSignal,
): Promise<SpoolStreamTempFile> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'sd2-video-delivery-'));
  const tempPath = path.join(tempDir, `${safeFileStem(fileName)}-${uuidv4()}.bin`);
  await pipeline(toNodeReadable(body), createWriteStream(tempPath), { signal });
  const info = await stat(tempPath);
  return {
    path: tempPath,
    size: info.size,
    cleanup: async () => {
      await unlink(tempPath).catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function uploadStreamToR2(
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  key: string,
  mimeType: string,
  size?: number | null,
  signal?: AbortSignal,
) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = process.env;

  if (!R2_PUBLIC_BASE_URL || !isPubliclyReachableUrl(R2_PUBLIC_BASE_URL)) {
    throw new Error('R2_PUBLIC_BASE_URL 未配置为公网地址，无法生成可被 Seedance 下载的 publicUrl');
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID!,
      secretAccessKey: R2_SECRET_ACCESS_KEY!,
    },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: toNodeReadable(body),
      ContentType: mimeType,
      ...(size && size > 0 ? { ContentLength: size } : {}),
    }),
    { abortSignal: signal },
  );

  return {
    publicUrl: `${R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
    key,
  };
}

async function uploadStreamToTOS(
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  key: string,
  mimeType: string,
) {
  const { TOS_REGION, TOS_BUCKET, TOS_ENDPOINT, TOS_ACCESS_KEY, TOS_SECRET_KEY, TOS_PUBLIC_BASE_URL } = process.env;

  const region = TOS_REGION || 'ap-southeast-1';
  const endpoint = TOS_ENDPOINT || `https://tos-ap-southeast-1.volces.com`;
  const bucket = TOS_BUCKET!;
  const client = new TosClient({
    endpoint,
    region,
    accessKeyId: TOS_ACCESS_KEY!,
    accessKeySecret: TOS_SECRET_KEY!,
  });

  await client.putObject({
    bucket,
    key,
    body: toNodeReadable(body),
    contentType: mimeType,
  });

  const publicBase = TOS_PUBLIC_BASE_URL || `https://${bucket}.${endpoint}`;
  return {
    publicUrl: `${publicBase.replace(/\/$/, '')}/${key}`,
    key,
  };
}

async function uploadStreamToLocalPublic(
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  key: string,
  mimeType: string,
) {
  const targetPath = path.join(process.cwd(), 'public', key);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await pipeline(toNodeReadable(body), createWriteStream(targetPath));
  const info = await stat(targetPath);
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return {
    publicUrl: `${baseUrl}/${key}`,
    key,
    size: info.size,
    mimeType,
  };
}

// ============================================================================
// 工具函数
// ============================================================================

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

// ============================================================================
// 统一上传 API
// ============================================================================

export interface PublicUploadResult {
  /** 公网可访问的 URL */
  publicUrl: string;
  /** 存储 Provider: tos | r2 | local-public | local */
  storageProvider: 'tos' | 'r2' | 'local-public' | 'local';
  /** 对象存储中的 key（如有） */
  storageKey?: string;
  /** 文件大小（bytes） */
  size: number;
  /** MIME 类型 */
  mimeType: string;
  /** 是否公网可访问 */
  isPubliclyReachable: boolean;
  /** 警告信息（如果非公网） */
  warning?: string;
}

export type PublicVideoStreamUploadInput = {
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>;
  fileName: string;
  mimeType: string;
  size?: number | null;
};

export async function uploadPublicVideoStream(input: PublicVideoStreamUploadInput): Promise<PublicUploadResult> {
  const config = getStorageConfig();
  const key = objectKeyForStream(input.fileName, input.mimeType);
  const size = input.size && input.size > 0 ? input.size : null;

  switch (config.provider) {
    case 'r2': {
      const tempFileRef: { current: SpoolStreamTempFile | null } = { current: null };
      try {
        return await withPublicVideoStreamTimeout('R2 视频稳定下载转存', async (signal) => {
          let uploadBody: NodeJS.ReadableStream | ReadableStream<Uint8Array> = input.body;
          let uploadSize = size;
          if (!uploadSize) {
            tempFileRef.current = await spoolStreamToTempFile(input.body, input.fileName, signal);
            uploadBody = createReadStream(tempFileRef.current.path);
            uploadSize = tempFileRef.current.size;
          }
          const result = await uploadStreamToR2(uploadBody, key, input.mimeType, uploadSize, signal);
          return {
            publicUrl: result.publicUrl,
            storageProvider: 'r2',
            storageKey: result.key,
            size: uploadSize || 0,
            mimeType: input.mimeType,
            isPubliclyReachable: true,
          };
        });
      } catch (err) {
        console.error('[PublicStorage] R2 video stream upload failed:', err);
        throw new Error(`R2 视频流式上传失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await tempFileRef.current?.cleanup();
      }
    }
    case 'tos': {
      try {
        const result = await uploadStreamToTOS(input.body, key, input.mimeType);
        return {
          publicUrl: result.publicUrl,
          storageProvider: 'tos',
          storageKey: result.key,
          size: size || 0,
          mimeType: input.mimeType,
          isPubliclyReachable: true,
        };
      } catch (err) {
        console.error('[PublicStorage] TOS video stream upload failed:', err);
        throw new Error(`TOS 视频流式上传失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    case 'local-public': {
      const result = await uploadStreamToLocalPublic(input.body, key, input.mimeType);
      const reachable = isPubliclyReachableUrl(result.publicUrl);
      return {
        publicUrl: result.publicUrl,
        storageProvider: 'local-public',
        storageKey: result.key,
        size: result.size,
        mimeType: result.mimeType,
        isPubliclyReachable: reachable,
        warning: !reachable
          ? '当前 BASE_URL 未配置为公网域名，本地预览可用，Seedance 官方可能无法访问。'
          : undefined,
      };
    }
    case 'local':
    default: {
      const result = await uploadStreamToLocalPublic(input.body, key, input.mimeType);
      return {
        publicUrl: result.publicUrl,
        storageProvider: 'local',
        storageKey: result.key,
        size: result.size,
        mimeType: result.mimeType,
        isPubliclyReachable: false,
        warning: '未配置公网对象存储，视频仅保存到本地公开目录，稳定下载不会走 CDN。',
      };
    }
  }
}

/**
 * 统一公网上传函数
 *
 * 按优先级自动选择 R2 > TOS > local-public > local
 * - 如果有公网对象存储：上传并返回公网 URL
 * - 如果只有本地上传：返回 localhost URL，标记 warning
 *
 * @param buffer 文件二进制内容
 * @param fileName 原始文件名
 * @param mimeType MIME 类型
 */
export async function uploadPublicAsset(
  buffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<PublicUploadResult> {
  const config = getStorageConfig();
  const size = buffer.length;

  switch (config.provider) {
    case 'tos': {
      try {
        const result = await uploadToTOS(buffer, fileName, mimeType);
        return {
          publicUrl: result.publicUrl,
          storageProvider: 'tos',
          storageKey: result.key,
          size,
          mimeType,
          isPubliclyReachable: true,
        };
      } catch (err) {
        console.error('[PublicStorage] TOS upload failed:', err);
        throw new Error(`TOS 上传失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    case 'r2': {
      try {
        const result = await uploadToR2(buffer, fileName, mimeType);
        return {
          publicUrl: result.publicUrl,
          storageProvider: 'r2',
          storageKey: result.key,
          size,
          mimeType,
          isPubliclyReachable: true,
        };
      } catch (err) {
        console.error('[PublicStorage] R2 upload failed:', err);
        throw new Error(`R2 上传失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    case 'local-public': {
      const result = uploadToLocalPublic(buffer, fileName, mimeType);
      const reachable = isPubliclyReachableUrl(result.publicUrl);
      return {
        publicUrl: result.publicUrl,
        storageProvider: 'local-public',
        storageKey: result.key,
        size,
        mimeType,
        isPubliclyReachable: reachable,
        warning: !reachable
          ? '当前 BASE_URL 未配置为公网域名，本地预览可用，Seedance 官方可能无法访问。'
          : undefined,
      };
    }

    case 'local':
    default: {
      // 最后 fallback：尝试本地上传（即使不可公网访问）
      const result = uploadToLocalPublic(buffer, fileName, mimeType);
      return {
        publicUrl: result.publicUrl,
        storageProvider: 'local',
        storageKey: result.key,
        size,
        mimeType,
        isPubliclyReachable: false,
        warning:
          '未配置公网对象存储，图片仅保存到本地。Seedance 官方无法访问此 URL。' +
          '请配置 TOS / R2 / 公网域名以实现完整闭环。',
      };
    }
  }
}
