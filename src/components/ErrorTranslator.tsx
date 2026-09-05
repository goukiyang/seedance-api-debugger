'use client';

/**
 * ErrorTranslator — 错误翻译组件
 * P0-5: 错误翻译系统
 * - 将原始 API 错误码翻译成用户友好的中文
 * - 提供可能原因和操作建议
 * - 支持结构化 _debug 信息（524 + 参考图诊断）
 */

import React, { useCallback, useState } from 'react';

// ---- Types ----

interface RefDiagItem {
  index: number;
  label: string;
  urlType: string;
  urlHost: string;
  mimeType: string;
  fileSizeBytes: number;
  status: string;
  reason?: string;
}

interface ProviderContext {
  httpStatus?: number;
  source?: string;
  code?: string;
  requestId?: string;
  payloadSummary?: unknown;
}

interface DebugInfo {
  providerContext?: ProviderContext;
  referenceImageDiagnostics?: RefDiagItem[];
  base64EstimateKb?: number;
  hasLocalUrls?: boolean;
  hasNonPublicUrls?: boolean;
  providerReferenceField?: string;
}

interface Props {
  error: string;
  /** 原始错误信息 */
  rawError?: string;
  /** 结构化调试信息 */
  debugInfo?: DebugInfo;
  onRetry?: () => void;
  onCopy?: () => void;
}

// ---- Helpers ----

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Error Classification ----

interface TranslatedError {
  code: string;
  title: string;
  reasons: string[];
  actions: Array<{ label: string; action?: 'retry' | 'copy' | 'debug' }>;
  showDiagnostics?: boolean;
  debugInfo?: DebugInfo;
}

function hasStatusCodeToken(error: string, code: number) {
  const pattern = new RegExp(`(^|\\D)${code}(?!\\d)`);
  return pattern.test(error);
}

export function translateError(error: string, debugInfo?: DebugInfo): TranslatedError | null {
  const lower = error.toLowerCase();
  const ctx = debugInfo?.providerContext;
  const diags = debugInfo?.referenceImageDiagnostics;
  const hasLocalUrls = debugInfo?.hasLocalUrls;
  const hasNonPublic = debugInfo?.hasNonPublicUrls;

  if (
    lower.includes('reference_media_too_small')
    || (
      lower.includes('pixel count')
      && lower.includes('greater than or equal to')
      && (lower.includes('409600') || lower.includes('content['))
    )
    || lower.includes('参考素材分辨率太低')
  ) {
    return {
      code: 'REFERENCE_MEDIA_TOO_SMALL',
      title: '参考素材分辨率太低',
      reasons: [
        '这不是系统整体故障，是当前某个参考图片或视频分辨率低于生成服务要求',
        '请换更清晰的素材，或先放大、重新导出后再提交',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('reference_video_duration_unsupported')
    || (lower.includes('参考视频') && lower.includes('时长'))
  ) {
    return {
      code: 'REFERENCE_VIDEO_DURATION_UNSUPPORTED',
      title: '参考视频时长不符合要求',
      reasons: [
        '这不是 API Key 或点数问题，是当前参考视频时长超过了生成服务允许范围',
        'Seedance 2.0 参考视频需要 2-15 秒；请把视频裁到 15 秒以内后重新上传',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('reference_audio_duration_unsupported')
    || (lower.includes('参考音频') && lower.includes('时长'))
  ) {
    return {
      code: 'REFERENCE_AUDIO_DURATION_UNSUPPORTED',
      title: '参考音频时长不符合要求',
      reasons: [
        '这不是 API Key 或点数问题，是当前参考音频时长超过了生成服务允许范围',
        'Seedance 2.0 参考音频需要 2-15 秒；请裁剪后重新上传',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('reference_video_format_unsupported')
    || (lower.includes('参考视频') && lower.includes('格式'))
  ) {
    return {
      code: 'REFERENCE_VIDEO_FORMAT_UNSUPPORTED',
      title: '参考视频格式不符合要求',
      reasons: [
        '当前参考视频格式不适合直接用于 Seedance 2.0 生成',
        '请转成 MP4 或 MOV 后重新上传',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('reference_image_too_large')
    || lower.includes('参考图尺寸过大')
    || lower.includes('图片尺寸过大')
    || lower.includes('maximum allowed total pixels')
    || lower.includes('image exceeds the maximum allowed')
  ) {
    return {
      code: 'REFERENCE_IMAGE_TOO_LARGE',
      title: '参考图尺寸过大',
      reasons: [
        '这不是系统整体故障，是当前选择的参考图超过了视频生成服务允许的图片大小',
        '系统会优先自动压缩到合规尺寸；如果自动处理仍失败，需要换一张更小的图或先压缩后再提交',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('reference_image_privacy_sensitive')
    || lower.includes('inputimagesensitivecontentdetected.privacyinformation')
    || (lower.includes('input image') && lower.includes('may contain real person'))
    || lower.includes('参考图可能包含真实人物')
    || lower.includes('参考图包含真实人物隐私')
  ) {
    return {
      code: 'REFERENCE_IMAGE_PRIVACY_SENSITIVE',
      title: '参考图存在真人隐私风险',
      reasons: [
        '这不是系统整体故障，是视频生成服务拒绝了当前某张参考图',
        '通常是参考图被识别为可能包含真实人物或隐私信息',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('output_audio_copyright_restricted')
    || lower.includes('outputaudiosensitivecontentdetected.policyviolation')
    || (lower.includes('output audio') && lower.includes('copyright restriction'))
    || lower.includes('输出音频可能涉及版权限制')
  ) {
    return {
      code: 'OUTPUT_AUDIO_COPYRIGHT_RESTRICTED',
      title: '输出音频可能涉及版权限制',
      reasons: [
        '这不是网站上传失败，是视频生成服务拒绝了本次要生成的音频内容',
        '请关闭音频生成，或避开歌曲、歌词、知名旋律、影视配乐、歌手/乐队名称、版权音乐风格等描述',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('output_video_copyright_restricted')
    || lower.includes('outputvideosensitivecontentdetected.policyviolation')
    || (lower.includes('output video') && lower.includes('copyright restriction'))
    || lower.includes('输出视频可能涉及版权限制')
  ) {
    return {
      code: 'OUTPUT_VIDEO_COPYRIGHT_RESTRICTED',
      title: '输出视频可能涉及版权限制',
      reasons: [
        '这不是网站上传失败，是视频生成服务拒绝了本次要生成的视频画面',
        '请替换参考素材，或避开影视 IP、知名角色、品牌标识、受版权保护的画面风格等描述',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('output_audio_sensitive')
    || lower.includes('outputaudiosensitivecontentdetected')
    || (lower.includes('output audio') && lower.includes('sensitive information'))
    || lower.includes('输出音频可能包含敏感内容')
  ) {
    return {
      code: 'OUTPUT_AUDIO_SENSITIVE',
      title: '输出音频可能包含敏感内容',
      reasons: [
        '视频生成服务认为本次要生成的音频存在敏感风险',
        '请调整音频相关提示词，避开危险、违规、隐私或不适合公开生成的声音内容',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('output_video_sensitive')
    || lower.includes('outputvideosensitivecontentdetected')
    || (lower.includes('output video') && lower.includes('sensitive information'))
    || lower.includes('输出视频可能包含敏感内容')
  ) {
    return {
      code: 'OUTPUT_VIDEO_SENSITIVE',
      title: '输出视频可能包含敏感内容',
      reasons: [
        '视频生成服务认为本次要生成的画面存在敏感风险',
        '请调整提示词或参考素材，避开违规、敏感、隐私或不适合公开生成的画面内容',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('provider_content_policy_violation')
    || lower.includes('policyviolation')
    || lower.includes('sensitivecontentdetected')
    || lower.includes('content safety')
    || lower.includes('copyright restriction')
  ) {
    return {
      code: 'PROVIDER_CONTENT_POLICY_VIOLATION',
      title: '内容安全或版权审核未通过',
      reasons: [
        '视频生成服务认为本次提示词、参考素材或输出内容存在合规风险',
        '请调整提示词、参考素材和授权信息后重新提交',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('h3_gpu_out_of_memory')
    || lower.includes('gpu out of memory')
    || lower.includes('显存不足')
    || lower.includes('显存风险高')
  ) {
    return {
      code: 'H3_GPU_OUT_OF_MEMORY',
      title: 'H3 机器显存不足',
      reasons: [
        '本次视频参数对当前 H3 机器来说太重，没有生成成功',
        '请降低分辨率、缩短时长、换低显存预设，或稍后再试',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  if (
    lower.includes('provider_html_response')
    || lower.includes('服务临时返回了异常页面')
    || lower.includes('生成服务临时返回了异常页面')
    || lower.includes('<!doctype')
    || lower.includes('<html')
    || lower.includes('<!--[if ')
  ) {
    return {
      code: 'PROVIDER_HTML_RESPONSE',
      title: '生成服务临时异常',
      reasons: [
        '生成服务或中间网关返回了异常页面，系统没有拿到有效创建结果',
        '这类问题通常需要稍后重试；如果连续出现，需要管理员查看生成服务状态',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  // 524 超时 — 重点处理
  if (hasStatusCodeToken(error, 524) || ctx?.httpStatus === 524) {
    const reasons: string[] = [];
    if (hasLocalUrls) {
      reasons.push('参考图中包含本地图片（需转 base64），大图导致 JSON payload 过大 → 网关超时');
    }
    if (hasNonPublic) {
      reasons.push('参考图 URL 不是公网可访问地址，Seedance 无法下载');
    }
    if (!hasLocalUrls && !hasNonPublic) {
      reasons.push('Seedance 服务端网关超时，可能因并发过高或上游处理超时');
    }
    if (diags?.length) {
      const largeImages = diags.filter((d) => d.fileSizeBytes > 2 * 1024 * 1024);
      if (largeImages.length) {
        reasons.push(`包含 ${largeImages.length} 张超过 2MB 的图片，建议压缩后使用`);
      }
    }

    return {
      code: '524',
      title: '创建失败：Seedance 服务响应超时',
      reasons,
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
        { label: '查看诊断', action: 'debug' },
      ],
      showDiagnostics: true,
      debugInfo,
    };
  }

  // 554 错误
  if (hasStatusCodeToken(error, 554) || ctx?.httpStatus === 554) {
    return {
      code: '554',
      title: '服务返回错误 (554)',
      reasons: [
        '当前参数组合不被服务支持',
        'API 限流、额度不足或服务异常',
        '服务端处理超时或内部错误',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
        { label: '查看调试信息', action: 'debug' },
      ],
      showDiagnostics: !!debugInfo,
      debugInfo,
    };
  }

  // 401 未授权
  if (hasStatusCodeToken(error, 401) || ctx?.httpStatus === 401 || lower.includes('unauthorized') || lower.includes('未授权')) {
    return {
      code: '401',
      title: 'API 认证失败',
      reasons: [
        'API Key 未配置或已过期',
        'API Key 权限不足',
      ],
      actions: [
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // 403 禁止
  if (hasStatusCodeToken(error, 403) || ctx?.httpStatus === 403 || lower.includes('forbidden') || lower.includes('禁止')) {
    return {
      code: '403',
      title: 'API 访问被拒绝',
      reasons: [
        'API Key 没有该接口的访问权限',
        '账户余额不足或额度用尽',
      ],
      actions: [
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // 429 限流
  if (hasStatusCodeToken(error, 429) || ctx?.httpStatus === 429 || lower.includes('rate limit') || lower.includes('限流')) {
    return {
      code: '429',
      title: '请求过于频繁',
      reasons: [
        '短时间内提交了过多任务',
        'API 限流策略触发',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // 素材上传失败
  if (lower.includes('asset') || lower.includes('upload') || lower.includes('素材')) {
    return {
      code: 'ASSET',
      title: '素材上传失败',
      reasons: [
        '文件格式不支持（仅支持 JPG/PNG/GIF/WebP/MP4）',
        '文件体积过大',
        '上传接口异常',
      ],
      actions: [
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // JSON 解析错误
  if (lower.includes('json') || lower.includes('unexpected end')) {
    return {
      code: 'JSON',
      title: '服务响应格式错误',
      reasons: [
        '服务返回的数据格式不符合系统预期',
        '请刷新后重试；如果连续出现，需要管理员查看接口日志',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // 默认未知错误
  return {
    code: 'UNCLASSIFIED_ERROR',
    title: '创建失败',
    reasons: [
      '系统已经记录原始错误，管理员可以按任务 ID 到后台继续排查',
      '如果连续出现，请先换素材或稍后重试，再联系管理员补充中文规则',
    ],
    actions: [
      { label: '重新提交', action: 'retry' },
      { label: '复制错误', action: 'copy' },
    ],
    showDiagnostics: !!debugInfo,
    debugInfo,
  };
}

// ---- Diagnostics Panel ----

function DiagnosticsPanel({ debugInfo }: { debugInfo: DebugInfo }) {
  const [expanded, setExpanded] = useState(false);
  const ctx = debugInfo.providerContext;
  const diags = debugInfo.referenceImageDiagnostics;

  return (
    <div className="mt-3 border border-gray-700 rounded p-2 bg-gray-900/50">
      <button
        className="w-full text-left text-xs text-gray-400 flex items-center justify-between"
        onClick={() => setExpanded((p) => !p)}
      >
        <span>📊 参考图诊断 ({diags?.length ?? 0} 张)</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {ctx && (
            <div className="text-xs text-gray-500 mb-2">
              HTTP {ctx.httpStatus} · {ctx.source} · {ctx.code}
              {ctx.requestId && <span className="ml-2 text-gray-600">RequestId: {ctx.requestId}</span>}
              {debugInfo.base64EstimateKb && (
                <span className="ml-2">· base64 估算 ~{debugInfo.base64EstimateKb} KB</span>
              )}
              {debugInfo.hasLocalUrls && <span className="ml-2 text-yellow-500">⚠ 含本地图片</span>}
              {debugInfo.hasNonPublicUrls && <span className="ml-2 text-red-400">⚠ 含不可公网访问的 URL</span>}
            </div>
          )}

          {diags?.map((d) => (
            <div key={d.index} className={`text-xs p-1.5 rounded ${d.status === 'ok' ? 'bg-gray-800' : d.status === 'warning' ? 'bg-yellow-900/30 border border-yellow-700' : 'bg-red-900/30 border border-red-700'}`}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-300">[{d.index}] {d.label}</span>
                <span className="text-gray-500">{d.urlType}</span>
                <span className="text-gray-400">{d.urlHost}</span>
                <span className="text-gray-500">{d.mimeType}</span>
                {d.fileSizeBytes > 0 && <span className="text-gray-500">{formatBytes(d.fileSizeBytes)}</span>}
                <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${d.status === 'ok' ? 'bg-green-900 text-green-400' : d.status === 'warning' ? 'bg-yellow-900 text-yellow-400' : 'bg-red-900 text-red-400'}`}>
                  {d.status}
                </span>
              </div>
              {d.reason && (
                <div className="mt-0.5 text-gray-400">{d.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main Component ----

export function ErrorTranslator({ error, rawError, debugInfo, onRetry, onCopy }: Props) {
  const translated = translateError(error, debugInfo);
  const [showAllDebug, setShowAllDebug] = useState(false);

  const handleCopy = useCallback(() => {
    const content = JSON.stringify({ error, debugInfo }, null, 2);
    navigator.clipboard.writeText(content).catch(() => {});
    onCopy?.();
  }, [error, debugInfo, onCopy]);

  if (!translated) {
    return (
      <div className="alert alert-error">
        <div className="text-xs font-medium mb-1">创建失败</div>
        <div className="text-xs">{error}</div>
        <div className="mt-2 flex gap-2">
          {onRetry && (
            <button className="btn btn-sm btn-danger" onClick={onRetry}>重新提交</button>
          )}
          <button className="btn btn-sm btn-secondary" onClick={handleCopy}>复制错误</button>
        </div>
        {debugInfo && (
          <details className="mt-2" onToggle={(e) => setShowAllDebug((e.target as HTMLDetailsElement).open)}>
            <summary className="text-xs text-gray-400 cursor-pointer">展开调试信息</summary>
            <pre className="mt-1 bg-gray-900 p-2 rounded text-xs text-gray-400 overflow-x-auto max-h-48">
              {JSON.stringify(debugInfo, null, 2)}
            </pre>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="error-translate">
      <div className="error-translate-title">{translated.title}</div>
      <div className="error-translate-reasons">
        <div>可能原因：</div>
        <ol>
          {translated.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ol>
      </div>
      <div className="error-translate-actions">
        {translated.actions.map((action, i) => {
          if (action.action === 'retry') {
            return (
              <button key={i} className="btn btn-sm btn-primary" onClick={() => { onRetry?.(); }}>
                {action.label}
              </button>
            );
          }
          if (action.action === 'copy') {
            return (
              <button key={i} className="btn btn-sm btn-secondary" onClick={handleCopy}>
                {action.label}
              </button>
            );
          }
          return null;
        })}
      </div>

      {translated.showDiagnostics && debugInfo && (
        <DiagnosticsPanel debugInfo={debugInfo} />
      )}

      {/* 展开原始错误 */}
      {rawError && (
        <details className="mt-2">
          <summary className="text-xs text-gray-400 cursor-pointer">展开原始错误</summary>
          <div className="mt-1 bg-gray-900 p-2 rounded text-xs font-mono text-gray-500 max-h-40 overflow-y-auto break-all">
            {rawError}
          </div>
        </details>
      )}
    </div>
  );
}
