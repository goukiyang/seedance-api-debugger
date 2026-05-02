/**
 * URL 规范化工具
 * 用于公网 URL 去重时的基础规范化
 */

export function normalizeAssetUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new Error('URL 不能为空');
  }

  let normalized = url.trim();

  // 去掉末尾多余的斜杠（但保留域名后的唯一斜杠）
  // 例如: https://example.com/image.jpg/ → https://example.com/image.jpg
  normalized = normalized.replace(/\/+$/, '');

  // 规范化协议为 https
  if (normalized.startsWith('http://')) {
    normalized = 'https://' + normalized.slice(7);
  }

  // 验证是合法 URL
  try {
    const u = new URL(normalized);
    // 小写 hostname
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    throw new Error(`无效的 URL：${normalized}`);
  }
}
