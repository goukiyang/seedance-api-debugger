import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import sharp from 'sharp';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { isPrivateNetworkHost } from '@/lib/media/public-url';

const MAX_BYTES = 20 * 1024 * 1024;

export function studioAssetUrl(assetId: string) {
  return `/api/image-studio/assets/${encodeURIComponent(assetId)}`;
}

export async function readStudioImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const local = siteUploadPathFromUrl(url);
  if (local) {
    const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
    const file = await fs.realpath(path.resolve(process.cwd(), 'public', local.replace(/^\/+/, '')));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('素材路径无效');
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES || !stat.isFile()) throw new Error('图片文件过大');
    return fs.readFile(file);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateNetworkHost(parsed.hostname)) throw new Error('图片地址不安全');
  const addresses = await lookup(parsed.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(entry => isPrivateNetworkHost(entry.address)
    || /^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|1(9[28])\.0\.0\.|198\.(18|19)\.|2(2[4-9]|[3-5]\d)\.)/.test(entry.address))) throw new Error('图片地址不可访问');
  // Pin the vetted address so DNS cannot change between validation and download.
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      // The vetted lookup returns one IPv4 address, not an auto-family address list.
      family: 4, signal,
      lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('图片读取失败')); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) request.destroy(new Error('图片文件过大'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('图片读取超时')), 30000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

export async function normalizeStudioImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片文件大小无效');
  const png = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).png().toBuffer();
  if (png.length > MAX_BYTES) throw new Error('图片转换后超过 20MB，请压缩后重试');
  return png;
}
