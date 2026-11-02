import { prisma } from '@/lib/prisma';
import { siteUploadBaseUrls, siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { readStudioImage } from '@/lib/image-studio/media';
import type { MuskChatContentPart, MuskChatMessage } from './musk';

const MAX_MUSK_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;

export type MuskChatInputImage = {
  id?: string;
  url: string;
};

export type MuskChatInputMessage = {
  role: MuskChatMessage['role'];
  content: string;
  images?: MuskChatInputImage[];
};

type OwnedImageAsset = {
  id: string;
  original_url: string;
  mime_type: string;
  file_size: number;
};

export type MuskChatImageDependencies = {
  findAsset(input: { id?: string; ownerId: string; urlCandidates: string[] }): Promise<OwnedImageAsset | null>;
  readImage(url: string, signal?: AbortSignal): Promise<Buffer>;
};

export class MuskChatImageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

function sameSiteUrlCandidates(pathname: string) {
  return Array.from(new Set([
    pathname,
    ...siteUploadBaseUrls().map((baseUrl) => `${baseUrl}${pathname}`),
  ]));
}

const defaultDependencies: MuskChatImageDependencies = {
  findAsset: ({ id, ownerId, urlCandidates }) => prisma.asset.findFirst({
    where: {
      ...(id ? { id } : { original_url: { in: urlCandidates } }),
      owner_id: ownerId,
      type: 'image',
      status: 'active',
    },
    select: {
      id: true,
      original_url: true,
      mime_type: true,
      file_size: true,
    },
  }),
  readImage: readStudioImage,
};

async function inlineOwnedImage(
  image: MuskChatInputImage,
  ownerId: string,
  signal: AbortSignal | undefined,
  dependencies: MuskChatImageDependencies,
) {
  const requestedPath = siteUploadPathFromUrl(image.url);
  if (!requestedPath) return image.url;

  signal?.throwIfAborted();
  const asset = await dependencies.findAsset({
    id: image.id,
    ownerId,
    urlCandidates: sameSiteUrlCandidates(requestedPath),
  });
  if (!asset || siteUploadPathFromUrl(asset.original_url) !== requestedPath) {
    throw new MuskChatImageError('图片不存在或无权读取', 403, 'musk_chat_image_forbidden');
  }
  if (asset.file_size > MAX_MUSK_CHAT_IMAGE_BYTES) {
    throw new MuskChatImageError('图片太大（单张不能超过 8MB）', 413, 'musk_chat_image_too_large');
  }
  if (!/^image\/[a-z0-9.+-]+$/i.test(asset.mime_type)) {
    throw new MuskChatImageError('图片格式不可用', 400, 'musk_chat_image_invalid_mime');
  }

  let bytes: Buffer;
  try {
    bytes = await dependencies.readImage(asset.original_url, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MuskChatImageError('图片读取失败', 422, 'musk_chat_image_unreadable');
  }
  if (bytes.length > MAX_MUSK_CHAT_IMAGE_BYTES) {
    throw new MuskChatImageError('图片太大（单张不能超过 8MB）', 413, 'musk_chat_image_too_large');
  }
  return `data:${asset.mime_type};base64,${bytes.toString('base64')}`;
}

export async function prepareMuskChatMessages(
  messages: MuskChatInputMessage[],
  ownerId: string,
  signal?: AbortSignal,
  dependencies: MuskChatImageDependencies = defaultDependencies,
): Promise<MuskChatMessage[]> {
  return Promise.all(messages.map(async (message) => {
    const images = message.images || [];
    if (!images.length) return { role: message.role, content: message.content };

    const resolved = await Promise.all(images.map(async (image) => ({
      ...image,
      url: await inlineOwnedImage(image, ownerId, signal, dependencies),
    })));
    const parts: MuskChatContentPart[] = [
      { type: 'text', text: message.content },
      ...resolved.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: image.url },
      })),
    ];
    const imageLines = resolved.map((image, index) => {
      const label = `image${index + 1}${image.id ? ` (id=${image.id})` : ''}`;
      return image.url.startsWith('data:')
        ? `- ${label}: 已安全内联本人图片`
        : `- ${label}: ${image.url}`;
    });
    parts[0] = {
      type: 'text',
      text: `${message.content}\n\n[Attached images]\n${imageLines.join('\n')}`,
    };
    return { role: message.role, content: parts };
  }));
}
