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

export function isProviderReferenceImagePrivacySensitiveError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('inputimagesensitivecontentdetected.privacyinformation')
    || (
      lower.includes('input image')
      && lower.includes('may contain real person')
    )
    || (
      lower.includes('privacyinformation')
      && lower.includes('content[')
    )
    || lower.includes('参考图可能包含真实人物')
    || lower.includes('参考图包含真实人物隐私');
}

export function isH3UnsupportedLoraError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('unsupported_lora')
    || lower.includes('lora is not in the h3 allowlist')
    || lower.includes('lora 不在 h3 白名单');
}

export function isH3LoraNotFoundError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('lora_not_found')
    || lower.includes('lora file does not exist on the h3 machine')
    || lower.includes('找不到这个 lora 文件');
}

export function isH3UnsupportedLoraNodeTypeError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('unsupported_lora_node_type')
    || lower.includes('only minimaxh3turbolora is supported')
    || lower.includes('minimaxh3turbolora 类型');
}

export type ProviderCreateFailureUserMessage = {
  code:
    | 'REFERENCE_MEDIA_TOO_SMALL'
    | 'REFERENCE_IMAGE_PRIVACY_SENSITIVE'
    | 'REFERENCE_IMAGE_TOO_LARGE'
    | 'PROVIDER_HTML_RESPONSE'
    | 'H3_UNSUPPORTED_LORA'
    | 'H3_LORA_NOT_FOUND'
    | 'H3_UNSUPPORTED_LORA_NODE_TYPE'
    | 'PROVIDER_CREATE_FAILED';
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

  if (isProviderReferenceImagePrivacySensitiveError(rawMessage)) {
    return {
      code: 'REFERENCE_IMAGE_PRIVACY_SENSITIVE',
      status: 400,
      message: '参考图可能包含真实人物或隐私信息，视频生成服务已拒绝使用这张图。请更换为非真人、已授权或隐私风险更低的参考图后重新提交。已返还冻结点数。',
    };
  }

  if (isProviderHtmlResponseError(rawMessage)) {
    return {
      code: 'PROVIDER_HTML_RESPONSE',
      status: 502,
      message: '生成服务临时返回了异常页面，系统没有拿到有效创建结果。已返还冻结点数。请稍后重试；如果连续出现，请联系管理员查看生成服务状态。',
    };
  }

  if (isH3UnsupportedLoraError(rawMessage)) {
    return {
      code: 'H3_UNSUPPORTED_LORA',
      status: 400,
      message: '当前选择的 H3 LoRA 不在 H3 服务白名单里，系统已取消提交并返还冻结点数。请切换为下拉菜单里可用的 LoRA 后重试；如果下拉仍出现该选项，请刷新页面。',
    };
  }

  if (isH3LoraNotFoundError(rawMessage)) {
    return {
      code: 'H3_LORA_NOT_FOUND',
      status: 400,
      message: 'H3 机器上找不到当前选择的 LoRA 文件，系统已取消提交并返还冻结点数。请切换为其他 LoRA，或联系管理员同步模型文件和白名单。',
    };
  }

  if (isH3UnsupportedLoraNodeTypeError(rawMessage)) {
    return {
      code: 'H3_UNSUPPORTED_LORA_NODE_TYPE',
      status: 400,
      message: 'H3 当前只支持 MiniMaxH3TurboLoRA 类型的 LoRA，系统已取消提交并返还冻结点数。请切换为系统内置 LoRA 后重试。',
    };
  }

  return {
    code: 'PROVIDER_CREATE_FAILED',
    status: 502,
    message: '视频生成服务返回了未知异常，系统已记录错误摘要用于排查和补充规则。已返还冻结点数，请稍后重试；如果连续出现，请联系管理员查看生成服务日志。',
  };
}
