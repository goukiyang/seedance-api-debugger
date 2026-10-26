import { createHash } from 'crypto';
import { uploadH3ReferenceImage, type H3ReferenceImageUploadResult } from './h3';

const MAX_H3_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;

export type H3ReferenceImageRole = 'first_frame' | 'last_frame';

export type H3ReferenceImageTransfer = {
  role: H3ReferenceImageRole;
  source_url: string;
  filename: string;
  h3_filename: string;
  size_bytes: number;
  sha256: string;
  upload: H3ReferenceImageUploadResult;
};

export type H3ReferenceImageTransferOptions = {
  baseUrl?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
};

function filenameFromUrl(url: string, fallback: string) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    return last?.slice(0, 160) || fallback;
  } catch {
    return fallback;
  }
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function fetchH3ReferenceImageBytes(url: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'image/png,image/jpeg,image/webp,image/*' },
  });
  if (!response.ok) {
    throw new Error(`H3 参考图读取失败: HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error('H3 参考图只支持图片类型');
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength <= 0) throw new Error('H3 参考图文件为空');
  if (arrayBuffer.byteLength > MAX_H3_REFERENCE_IMAGE_BYTES) {
    throw new Error('H3 参考图超过 25MB，请先压缩后再上传');
  }
  return Buffer.from(arrayBuffer);
}

async function uploadRoleImage(input: {
  role: H3ReferenceImageRole;
  sourceUrl: string;
  filename: string;
  options: H3ReferenceImageTransferOptions;
}): Promise<H3ReferenceImageTransfer> {
  const bytes = await fetchH3ReferenceImageBytes(input.sourceUrl, input.options.fetchImpl);
  const upload = await uploadH3ReferenceImage({
    filename: input.filename,
    contentB64: bytes.toString('base64'),
  }, {
    baseUrl: input.options.baseUrl,
    apiToken: input.options.apiToken,
    fetchImpl: input.options.fetchImpl,
  });

  return {
    role: input.role,
    source_url: input.sourceUrl,
    filename: input.filename,
    h3_filename: upload.filename,
    size_bytes: bytes.byteLength,
    sha256: upload.sha256 || sha256(bytes),
    upload,
  };
}

export async function uploadH3ReferenceImagesForTask(input: {
  firstFrameUrl?: string | null;
  lastFrameUrl?: string | null;
  options: H3ReferenceImageTransferOptions;
}) {
  const transfers: H3ReferenceImageTransfer[] = [];
  if (input.firstFrameUrl) {
    transfers.push(await uploadRoleImage({
      role: 'first_frame',
      sourceUrl: input.firstFrameUrl,
      filename: filenameFromUrl(input.firstFrameUrl, 'first-frame.png'),
      options: input.options,
    }));
  }
  if (input.lastFrameUrl) {
    transfers.push(await uploadRoleImage({
      role: 'last_frame',
      sourceUrl: input.lastFrameUrl,
      filename: filenameFromUrl(input.lastFrameUrl, 'last-frame.png'),
      options: input.options,
    }));
  }
  return {
    first_frame: transfers.find((item) => item.role === 'first_frame')?.h3_filename || null,
    last_frame: transfers.find((item) => item.role === 'last_frame')?.h3_filename || null,
    transfers,
  };
}
