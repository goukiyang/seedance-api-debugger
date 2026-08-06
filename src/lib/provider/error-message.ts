const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 4000;
const MIN_PROVIDER_REFERENCE_PIXELS = 409_600;

function stringFromScalar(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function truncateMessage(message: string) {
  if (message.length <= MAX_PROVIDER_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH)}...`;
}

export function normalizeProviderErrorMessage(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  const scalar = stringFromScalar(value);
  if (scalar) return truncateMessage(scalar);

  if (value instanceof Error) {
    const errorText = value.message || value.name;
    return errorText ? truncateMessage(errorText) : undefined;
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((item) => normalizeProviderErrorMessage(item))
      .filter((item): item is string => Boolean(item))
      .join('；');
    return combined ? truncateMessage(combined) : undefined;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const code = stringFromScalar(record.code ?? record.error_code ?? record.errorCode ?? record.name ?? record.type);
    const message = stringFromScalar(
      record.message ??
      record.error_message ??
      record.errorMessage ??
      record.msg ??
      record.detail ??
      record.reason,
    );

    if (code && message) return truncateMessage(`[${code}] ${message}`);
    if (message) return truncateMessage(message);
    if (code) return truncateMessage(code);

    try {
      const json = JSON.stringify(value);
      return json ? truncateMessage(json) : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function normalizedLower(message: string | null | undefined) {
  return (message || '').toLowerCase();
}

export function isProviderHtmlResponseError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('invalid json response')
    || lower.includes('生成服务返回异常页面')
    || lower.includes('text/html')
    || lower.includes('<!doctype')
    || lower.includes('<html')
    || lower.includes('<!--[if ');
}

export function isProviderReferenceImageTooLargeError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('reference_image_too_large')
    || lower.includes('参考图尺寸过大')
    || lower.includes('图片尺寸过大')
    || lower.includes('maximum allowed total pixels')
    || lower.includes('image exceeds the maximum allowed')
    || lower.includes('exceeds the maximum allowed');
}

export function isProviderReferenceMediaTooSmallError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('pixel count')
    && lower.includes('greater than or equal to')
    && (lower.includes(String(MIN_PROVIDER_REFERENCE_PIXELS)) || lower.includes('content['));
}

export type ProviderCreateFailureUserMessage = {
  code: 'REFERENCE_MEDIA_TOO_SMALL' | 'REFERENCE_IMAGE_TOO_LARGE' | 'PROVIDER_HTML_RESPONSE' | 'PROVIDER_CREATE_FAILED';
  message: string;
  status: number;
};

export function providerCreateFailureUserMessage(rawMessage: string | null | undefined): ProviderCreateFailureUserMessage {
  if (isProviderReferenceMediaTooSmallError(rawMessage)) {
    return {
      code: 'REFERENCE_MEDIA_TOO_SMALL',
      status: 400,
      message: `参考素材分辨率太低，低于视频生成服务的最低要求（至少 ${MIN_PROVIDER_REFERENCE_PIXELS} 像素，约等于 640×640）。请换更清晰的图片或视频，或先放大/重新导出后再提交。已返还冻结点数。`,
    };
  }

  if (isProviderReferenceImageTooLargeError(rawMessage)) {
    return {
      code: 'REFERENCE_IMAGE_TOO_LARGE',
      status: 400,
      message: '参考图尺寸过大，已超过视频生成服务允许的图片大小。系统会优先自动压缩到合规尺寸；如果自动处理仍失败，请换一张更小的图或先压缩后再提交。已返还冻结点数。',
    };
  }

  if (isProviderHtmlResponseError(rawMessage)) {
    return {
      code: 'PROVIDER_HTML_RESPONSE',
      status: 502,
      message: '生成服务临时返回了异常页面，系统没有拿到有效创建结果。已返还冻结点数。请稍后重试；如果连续出现，请联系管理员查看生成服务状态。',
    };
  }

  return {
    code: 'PROVIDER_CREATE_FAILED',
    status: 502,
    message: '视频生成服务异常，已返还冻结点数。',
  };
}
