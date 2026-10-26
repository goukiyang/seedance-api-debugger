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

export function isProviderFirstFrameRatioError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('first_frame_ratio_required')
    || lower.includes('首尾帧模式的画面比例必须跟随首帧')
    || (lower.includes('invalidparameter.tasktypeconstraint')
      && lower.includes('ratio')
      && lower.includes('output ratio follows the first-frame image'));
}

export function providerReferenceNumberFromError(message: string | null | undefined) {
  const raw = message || '';
  const contentMatch = raw.match(/content\[(\d+)\]/i);
  if (contentMatch) {
    const value = Number(contentMatch[1]);
    if (Number.isInteger(value) && value > 0) return value;
  }

  const imageDataMatch = raw.match(/image data\s+(\d+)/i);
  if (imageDataMatch) {
    const value = Number(imageDataMatch[1]);
    if (Number.isInteger(value) && value > 0) return value;
  }

  return null;
}

function referenceLabel(message: string | null | undefined, fallback: string) {
  const referenceNumber = providerReferenceNumberFromError(message);
  return referenceNumber ? `第${referenceNumber}项参考素材` : fallback;
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

export function isProviderReferenceResourceUnavailableError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return (
    lower.includes('image_url')
    || lower.includes('reference image')
    || lower.includes('参考素材')
  ) && (
    lower.includes('resource download failed')
    || lower.includes('resource not found')
    || lower.includes('timeout while fetching resource')
    || lower.includes('素材链接无法读取')
    || lower.includes('素材链接已失效')
  );
}

export function isProviderReferenceTotalDurationTooLongError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return (
    lower.includes('video total duration')
    && lower.includes('less than or equal to')
  ) || lower.includes('参考素材总时长超过');
}

export function isProviderModelNotOpenError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('modelnotopen')
    || lower.includes('model not exist')
    || (lower.includes('has not activated the model') && lower.includes('ark console'))
    || lower.includes('当前账号未开通所选模型');
}

export function isProviderGatewayTimeoutError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return /(^|\D)524(?!\d)/.test(lower)
    || lower.includes('provider_gateway_timeout')
    || lower.includes('生成服务响应超时');
}

export function isProviderGatewayError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return /(^|\D)554(?!\d)/.test(lower)
    || lower.includes('provider_gateway_error')
    || lower.includes('生成服务网关异常');
}

export function isProviderResponseFormatError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('unexpected end of json input')
    || lower.includes('provider_response_format_error')
    || lower.includes('服务响应格式错误');
}

export function isProviderTransactionConflictError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('transaction api error')
    || lower.includes('transaction not found')
    || lower.includes('系统保存任务时发生数据冲突');
}

export function isProviderMissingTaskIdError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('missing_provider_task_id')
    || lower.includes('missing task id')
    || lower.includes('no task id in create response')
    || lower.includes('任务提交后没有拿到外部任务号');
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

export function isProviderOutputAudioCopyrightError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('outputaudiosensitivecontentdetected.policyviolation')
    || (
      lower.includes('output audio')
      && lower.includes('copyright restriction')
    )
    || lower.includes('输出音频可能涉及版权限制');
}

export function isProviderOutputVideoCopyrightError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('outputvideosensitivecontentdetected.policyviolation')
    || (
      lower.includes('output video')
      && lower.includes('copyright restriction')
    )
    || lower.includes('输出视频可能涉及版权限制');
}

export function isProviderOutputAudioSensitiveError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('outputaudiosensitivecontentdetected')
    || (
      lower.includes('output audio')
      && lower.includes('sensitive information')
    )
    || lower.includes('输出音频可能包含敏感内容');
}

export function isProviderOutputVideoSensitiveError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('outputvideosensitivecontentdetected')
    || (
      lower.includes('output video')
      && lower.includes('sensitive information')
    )
    || lower.includes('输出视频可能包含敏感内容');
}

export function isProviderContentPolicyError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('policyviolation')
    || lower.includes('sensitivecontentdetected')
    || lower.includes('content safety')
    || lower.includes('copyright restriction')
    || lower.includes('内容安全')
    || lower.includes('版权审核');
}

export function isH3GpuOutOfMemoryError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('gpu out of memory')
    || lower.includes('显存不足')
    || lower.includes('显存风险高');
}

export function isProviderTooLittleErrorMessage(message: string | null | undefined) {
  const lower = normalizedLower(message).trim();
  return lower === 'error'
    || lower === 'unknown error'
    || lower === 'failed'
    || lower === 'failure';
}

export function isNextServerActionVersionMismatchError(message: string | null | undefined) {
  const lower = normalizedLower(message);
  return lower.includes('failed to find server action')
    || lower.includes('request might be from an older or newer deployment')
    || lower.includes('页面版本已更新')
    || lower.includes('页面版本和服务器版本不一致');
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
    | 'FIRST_FRAME_RATIO_REQUIRED'
    | 'REFERENCE_MEDIA_TOO_SMALL'
    | 'REFERENCE_IMAGE_PRIVACY_SENSITIVE'
    | 'REFERENCE_IMAGE_TOO_LARGE'
    | 'REFERENCE_RESOURCE_UNAVAILABLE'
    | 'REFERENCE_TOTAL_DURATION_TOO_LONG'
    | 'PROVIDER_MODEL_NOT_OPEN'
    | 'OUTPUT_AUDIO_COPYRIGHT_RESTRICTED'
    | 'OUTPUT_VIDEO_COPYRIGHT_RESTRICTED'
    | 'OUTPUT_AUDIO_SENSITIVE'
    | 'OUTPUT_VIDEO_SENSITIVE'
    | 'PROVIDER_CONTENT_POLICY_VIOLATION'
    | 'PROVIDER_HTML_RESPONSE'
    | 'PROVIDER_GATEWAY_TIMEOUT'
    | 'PROVIDER_GATEWAY_ERROR'
    | 'PROVIDER_RESPONSE_FORMAT_ERROR'
    | 'PROVIDER_TRANSACTION_CONFLICT'
    | 'MISSING_PROVIDER_TASK_ID'
    | 'PAGE_VERSION_MISMATCH'
    | 'H3_GPU_OUT_OF_MEMORY'
    | 'H3_UNSUPPORTED_LORA'
    | 'H3_LORA_NOT_FOUND'
    | 'H3_UNSUPPORTED_LORA_NODE_TYPE'
    | 'PROVIDER_EMPTY_ERROR'
    | 'PROVIDER_TASK_FAILED'
    | 'PROVIDER_CREATE_FAILED';
  message: string;
  status: number;
};

function appendRefundText(message: string, includeRefundText: boolean) {
  if (!includeRefundText) return message;
  return message.includes('返还冻结点数') ? message : `${message}已返还冻结点数。`;
}

export function providerFailureUserMessage(
  rawMessage: string | null | undefined,
  options: { includeRefundText?: boolean; fallbackCode?: 'PROVIDER_CREATE_FAILED' | 'PROVIDER_TASK_FAILED' } = {},
): ProviderCreateFailureUserMessage {
  const includeRefundText = options.includeRefundText === true;

  if (isProviderFirstFrameRatioError(rawMessage)) {
    return {
      code: 'FIRST_FRAME_RATIO_REQUIRED',
      status: 400,
      message: appendRefundText('首帧或首尾帧模式的画面比例必须跟随首帧，不能指定固定比例。请使用“跟随首帧”后重新提交；如需固定比例，请先将首帧图片调整为目标比例。', includeRefundText),
    };
  }

  if (isProviderReferenceMediaTooSmallError(rawMessage)) {
    const subject = referenceLabel(rawMessage, '参考素材');
    return {
      code: 'REFERENCE_MEDIA_TOO_SMALL',
      status: 400,
      message: appendRefundText(
        `${subject}分辨率太低，低于视频生成服务的最低要求（至少 ${MIN_PROVIDER_REFERENCE_PIXELS} 像素，约等于 640×640）。请换更清晰的图片或视频，或先放大/重新导出后再提交。`,
        includeRefundText,
      ),
    };
  }

  if (isProviderReferenceImageTooLargeError(rawMessage)) {
    const subject = referenceLabel(rawMessage, '参考图');
    return {
      code: 'REFERENCE_IMAGE_TOO_LARGE',
      status: 400,
      message: appendRefundText(
        `${subject}尺寸过大，已超过视频生成服务允许的图片大小。系统会优先自动压缩到合规尺寸；如果自动处理仍失败，请换一张更小的图或先压缩后再提交。`,
        includeRefundText,
      ),
    };
  }

  if (isProviderReferenceImagePrivacySensitiveError(rawMessage)) {
    const referenceNumber = providerReferenceNumberFromError(rawMessage);
    const subject = referenceNumber ? `第${referenceNumber}张参考图` : '参考图';
    return {
      code: 'REFERENCE_IMAGE_PRIVACY_SENSITIVE',
      status: 400,
      message: appendRefundText(
        `${subject}上传服务方人像库失败，服务方判断它可能包含真实人物或隐私信息。请更换为非真人、已授权或隐私风险更低的参考图后重新提交。`,
        includeRefundText,
      ),
    };
  }

  if (isProviderReferenceResourceUnavailableError(rawMessage)) {
    const subject = referenceLabel(rawMessage, '参考素材');
    return {
      code: 'REFERENCE_RESOURCE_UNAVAILABLE',
      status: 400,
      message: appendRefundText(
        `${subject}暂时无法被视频生成服务读取，可能是素材链接已失效、无法访问或读取超时。请重新上传这项素材后再提交。`,
        includeRefundText,
      ),
    };
  }

  if (isProviderReferenceTotalDurationTooLongError(rawMessage)) {
    return {
      code: 'REFERENCE_TOTAL_DURATION_TOO_LONG',
      status: 400,
      message: appendRefundText(
        '参考视频或音频的总时长超过视频生成服务允许的上限（15.2 秒）。请裁短或减少参考素材后重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isProviderModelNotOpenError(rawMessage)) {
    return {
      code: 'PROVIDER_MODEL_NOT_OPEN',
      status: 403,
      message: appendRefundText(
        '当前生成服务账号尚未开通所选视频模型，或该模型已不可用。这不是素材问题，请切换为可用模型，或联系管理员开通模型权限。',
        includeRefundText,
      ),
    };
  }

  if (isProviderOutputAudioCopyrightError(rawMessage)) {
    return {
      code: 'OUTPUT_AUDIO_COPYRIGHT_RESTRICTED',
      status: 400,
      message: appendRefundText(
        '输出音频可能涉及版权限制，视频生成服务已拒绝生成。请关闭音频生成，或避免使用歌曲、歌词、知名旋律、影视配乐、歌手/乐队名称、版权音乐风格等描述后重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isProviderOutputVideoCopyrightError(rawMessage)) {
    return {
      code: 'OUTPUT_VIDEO_COPYRIGHT_RESTRICTED',
      status: 400,
      message: appendRefundText(
        '输出视频可能涉及版权限制，视频生成服务已拒绝生成。请替换参考素材，或避免使用影视 IP、知名角色、品牌标识、受版权保护的画面风格等描述后重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isProviderOutputAudioSensitiveError(rawMessage)) {
    return {
      code: 'OUTPUT_AUDIO_SENSITIVE',
      status: 400,
      message: appendRefundText(
        '输出音频可能包含敏感内容，视频生成服务已拒绝生成。请调整音频相关提示词，避免危险、违规、隐私或不适合公开生成的声音内容后重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isProviderOutputVideoSensitiveError(rawMessage)) {
    return {
      code: 'OUTPUT_VIDEO_SENSITIVE',
      status: 400,
      message: appendRefundText(
        '输出视频可能包含敏感内容，视频生成服务已拒绝生成。请调整提示词或参考素材，避开违规、敏感、隐私或不适合公开生成的画面内容后重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isProviderContentPolicyError(rawMessage)) {
    return {
      code: 'PROVIDER_CONTENT_POLICY_VIOLATION',
      status: 400,
      message: appendRefundText(
        '生成内容未通过视频生成服务的内容安全或版权审核。请调整提示词、参考素材和授权信息后重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isH3GpuOutOfMemoryError(rawMessage)) {
    return {
      code: 'H3_GPU_OUT_OF_MEMORY',
      status: 503,
      message: appendRefundText(
        'H3 机器显存不足，本次视频没有生成成功。请降低分辨率、缩短时长、换低显存预设，或稍后再试。',
        includeRefundText,
      ),
    };
  }

  if (isProviderHtmlResponseError(rawMessage)) {
    return {
      code: 'PROVIDER_HTML_RESPONSE',
      status: 502,
      message: appendRefundText(
        '生成服务临时返回了异常页面，系统没有拿到有效创建结果。请稍后重试；如果连续出现，请联系管理员查看生成服务状态。',
        includeRefundText,
      ),
    };
  }

  if (isProviderGatewayTimeoutError(rawMessage)) {
    return {
      code: 'PROVIDER_GATEWAY_TIMEOUT',
      status: 504,
      message: appendRefundText(
        '视频生成服务响应超时，系统没有拿到明确的创建结果。请先刷新任务列表确认是否已经生成任务；确认没有任务后再重新提交，避免重复创建。',
        includeRefundText,
      ),
    };
  }

  if (isProviderGatewayError(rawMessage)) {
    return {
      code: 'PROVIDER_GATEWAY_ERROR',
      status: 502,
      message: appendRefundText(
        '视频生成服务网关临时异常，系统没有拿到有效创建结果。请稍后刷新页面再试；如果连续出现，请联系管理员查看生成服务状态。',
        includeRefundText,
      ),
    };
  }

  if (isProviderResponseFormatError(rawMessage)) {
    return {
      code: 'PROVIDER_RESPONSE_FORMAT_ERROR',
      status: 502,
      message: appendRefundText(
        '视频生成服务返回的数据不完整，系统无法确认创建结果。请先刷新任务列表确认是否已有任务；确认没有后再重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isProviderTransactionConflictError(rawMessage)) {
    return {
      code: 'PROVIDER_TRANSACTION_CONFLICT',
      status: 503,
      message: appendRefundText(
        '系统保存任务时发生短暂数据冲突，本次请求没有正常完成。请刷新页面后重试；如果连续出现，请联系管理员按提交时间排查。',
        includeRefundText,
      ),
    };
  }

  if (isProviderMissingTaskIdError(rawMessage)) {
    return {
      code: 'MISSING_PROVIDER_TASK_ID',
      status: 502,
      message: appendRefundText(
        '视频生成服务没有返回任务号，系统无法确认任务是否创建成功。请先刷新任务列表确认；确认没有任务后再重新提交。',
        includeRefundText,
      ),
    };
  }

  if (isNextServerActionVersionMismatchError(rawMessage)) {
    return {
      code: 'PAGE_VERSION_MISMATCH',
      status: 409,
      message: appendRefundText(
        '页面版本已更新，当前浏览器还停留在旧页面，和服务器新版本对不上。请刷新页面后重新提交；刷新前不要重复点击提交。',
        includeRefundText,
      ),
    };
  }

  if (isH3UnsupportedLoraError(rawMessage)) {
    return {
      code: 'H3_UNSUPPORTED_LORA',
      status: 400,
      message: appendRefundText(
        '当前选择的 H3 LoRA 不在 H3 服务白名单里，系统已取消提交。请切换为下拉菜单里可用的 LoRA 后重试；如果下拉仍出现该选项，请刷新页面。',
        includeRefundText,
      ),
    };
  }

  if (isH3LoraNotFoundError(rawMessage)) {
    return {
      code: 'H3_LORA_NOT_FOUND',
      status: 400,
      message: appendRefundText(
        'H3 机器上找不到当前选择的 LoRA 文件，系统已取消提交。请切换为其他 LoRA，或联系管理员同步模型文件和白名单。',
        includeRefundText,
      ),
    };
  }

  if (isH3UnsupportedLoraNodeTypeError(rawMessage)) {
    return {
      code: 'H3_UNSUPPORTED_LORA_NODE_TYPE',
      status: 400,
      message: appendRefundText(
        'H3 当前只支持 MiniMaxH3TurboLoRA 类型的 LoRA，系统已取消提交。请切换为系统内置 LoRA 后重试。',
        includeRefundText,
      ),
    };
  }

  if (isProviderTooLittleErrorMessage(rawMessage)) {
    return {
      code: 'PROVIDER_EMPTY_ERROR',
      status: 502,
      message: appendRefundText(
        '视频生成服务只返回了“失败”状态，没有给出具体原因。系统已记录原始响应，管理员可以按任务 ID 到后台继续排查。',
        includeRefundText,
      ),
    };
  }

  return {
    code: options.fallbackCode || 'PROVIDER_CREATE_FAILED',
    status: 502,
    message: appendRefundText(
      '视频生成服务返回了暂未归类的异常，系统已记录错误摘要用于排查和补充中文规则。请稍后重试；如果连续出现，请联系管理员查看生成服务日志。',
      includeRefundText,
    ),
  };
}

export function providerCreateFailureUserMessage(rawMessage: string | null | undefined): ProviderCreateFailureUserMessage {
  return providerFailureUserMessage(rawMessage, {
    includeRefundText: true,
    fallbackCode: 'PROVIDER_CREATE_FAILED',
  });
}

export function visibleProviderErrorMessage(message: string | null | undefined) {
  const trimmed = message?.trim();
  if (!trimmed) return message || null;
  const translated = providerFailureUserMessage(trimmed, {
    fallbackCode: 'PROVIDER_TASK_FAILED',
  });
  if (translated.code === 'PROVIDER_TASK_FAILED' && /[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed;
  }
  return translated.message;
}
