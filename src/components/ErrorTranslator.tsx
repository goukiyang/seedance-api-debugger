'use client';

/**
 * ErrorTranslator — 错误翻译组件
 * - 解析后端返回的结构化错误上下文（ProviderErrorContext）
 * - 翻译 HTTP 状态码为用户友好的中文
 * - 提供可操作按钮：重试 / 复制 / 查看详情
 * - 复制时输出脱敏的 JSON
 */

import React, { useCallback, useState } from 'react';

interface ProviderContext {
  httpStatus: number;
  source: string;
  code: string;
  providerMessage?: string;
  requestId?: string;
  payloadSummary?: {
    endpoint: string;
    model: string;
    generationMode: string;
    promptLength: number;
    contentItemCount: number;
    referenceImageCount: number;
    referenceImageHosts: string[];
    totalPayloadSizeKb: number;
  };
}

interface DebugInfo {
  requestIdLocal?: string;
  snapshot_id?: string;
  providerContext?: ProviderContext;
}

interface Props {
  error: string;
  /** 来自后端 _debug 字段的结构化调试信息 */
  debugInfo?: DebugInfo;
  /** 原始错误信息 */
  rawError?: string;
  /** 重试回调：不清空任何状态，用户可直接重新提交 */
  onRetry?: () => void;
  /** 复制回调 */
  onCopy?: () => void;
}

interface Translation {
  code: string;
  title: string;
  userMessage: string;
  reasons: string[];
  actions: Array<{ label: string; action: 'retry' | 'copy' | 'debug' | 'retry_hint_refs' }>;
}

function translateError(
  errorStr: string,
  ctx?: ProviderContext
): Translation | null {
  const lower = errorStr.toLowerCase();

  // ---- 524: Gateway Timeout（优先用后端传来的上下文）----
  const is524 =
    errorStr.includes('524') ||
    lower.includes('gateway timeout') ||
    lower.includes('timeout') ||
    lower.includes('timeout');

  if (is524) {
    const isGateway = ctx?.source === 'provider_gateway_timeout';
    const isLocalTimeout = ctx?.source === 'local_fetch_timeout';
    const payloadSizeKb = ctx?.payloadSummary?.totalPayloadSizeKb ?? 0;
    const refCount = ctx?.payloadSummary?.referenceImageCount ?? 0;
    const hosts = ctx?.payloadSummary?.referenceImageHosts ?? [];

    if (isLocalTimeout) {
      return {
        code: 'TIMEOUT',
        title: '网络请求超时',
        userMessage: '向 Seedance 发送请求超时（30s），网络或路由可能有问题',
        reasons: [
          `网络连接不稳定或 VPN/代理干扰`,
          `本地服务器到 Seedance 网关路由故障`,
          `payload 过大（${payloadSizeKb}KB）导致发送超时`,
        ],
        actions: [
          { label: '稍后重试', action: 'retry' },
          { label: '复制错误详情', action: 'copy' },
          { label: '查看详情', action: 'debug' },
        ],
      };
    }

    return {
      code: '524',
      title: 'Seedance 服务响应超时 (524)',
      userMessage: 'Seedance 网关超时，生成任务处理超时或服务不可用',
      reasons: [
        `Seedance 服务处理超时（${payloadSizeKb}KB payload，${refCount} 张参考图）`,
        `参考图 host：${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? '...' : ''}`,
        '服务器负载过高或服务临时不可用',
        '网络连接不稳定',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '减少参考图', action: 'retry_hint_refs' },
        { label: '复制错误详情', action: 'copy' },
        { label: '查看详情', action: 'debug' },
      ],
    };
  }

  // ---- 502 / 503 / 504: Gateway Errors ----
  if (errorStr.includes('502') || errorStr.includes('503') || errorStr.includes('504')) {
    const code = errorStr.match(/\b(50[234])\b/)?.[0] || '502';
    return {
      code,
      title: `Seedance 网关异常 (${code})`,
      userMessage: `Seedance 网关返回 ${code}，上游服务不可用`,
      reasons: [
        'Seedance 官方服务临时不可用',
        '上游服务器过载或正在维护',
        '参考图数量过多或 payload 过大',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误详情', action: 'copy' },
        { label: '查看详情', action: 'debug' },
      ],
    };
  }

  // ---- 401: 未授权 ----
  if (errorStr.includes('401') || lower.includes('unauthorized') || lower.includes('未授权')) {
    return {
      code: '401',
      title: 'API 认证失败',
      userMessage: 'API Key 无效或已过期',
      reasons: [
        'API Key 未配置或已过期',
        'API Key 权限不足',
      ],
      actions: [
        { label: '检查 API 配置', action: 'debug' },
        { label: '复制错误详情', action: 'copy' },
      ],
    };
  }

  // ---- 403: 禁止 ----
  if (errorStr.includes('403') || lower.includes('forbidden') || lower.includes('禁止')) {
    return {
      code: '403',
      title: 'API 访问被拒绝',
      userMessage: '账户余额不足或权限不足',
      reasons: [
        '账户余额不足或额度用尽',
        'API Key 没有该接口的访问权限',
        'IP 不在白名单中',
      ],
      actions: [
        { label: '检查 API 配置', action: 'debug' },
        { label: '复制错误详情', action: 'copy' },
      ],
    };
  }

  // ---- 429: 限流 ----
  if (errorStr.includes('429') || lower.includes('rate limit') || lower.includes('限流')) {
    return {
      code: '429',
      title: '请求过于频繁',
      userMessage: '短时间内提交了过多任务',
      reasons: [
        'API 限流策略触发',
        '短时间内提交了过多任务',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误详情', action: 'copy' },
      ],
    };
  }

  // ---- 554: 服务返回错误 ----
  if (errorStr.includes('554')) {
    return {
      code: '554',
      title: '服务返回错误 (554)',
      userMessage: ctx?.providerMessage || 'Seedance 服务处理异常',
      reasons: [
        '参数组合不被服务支持（比例/时长/分辨率不兼容）',
        'API 限流、额度不足或服务异常',
        '服务端处理超时或内部错误',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误详情', action: 'copy' },
        { label: '查看详情', action: 'debug' },
      ],
    };
  }

  // ---- JSON 解析错误 ----
  if (lower.includes('json') || lower.includes('invalid json') || lower.includes('unexpected')) {
    return {
      code: 'JSON',
      title: '服务响应格式错误',
      userMessage: 'API 返回了非 JSON 格式的响应',
      reasons: [
        'API 服务返回了非 JSON 格式的响应',
        '服务临时异常或网关错误',
      ],
      actions: [
        { label: '稍后重试', action: 'retry' },
        { label: '复制错误详情', action: 'copy' },
        { label: '查看详情', action: 'debug' },
      ],
    };
  }

  // ---- 默认未知错误 ----
  return null;
}

export function ErrorTranslator({ error, debugInfo, rawError, onRetry, onCopy }: Props) {
  const [showDebug, setShowDebug] = useState(false);
  const ctx = debugInfo?.providerContext;
  const translated = translateError(error, ctx);

  // 构建复制内容（脱敏 JSON）
  const getCopyContent = useCallback((): string => {
    const obj: Record<string, unknown> = {
      error,
      requestIdLocal: debugInfo?.requestIdLocal,
      snapshotId: debugInfo?.snapshot_id,
    };
    if (ctx) {
      obj.providerContext = {
        httpStatus: ctx.httpStatus,
        source: ctx.source,
        code: ctx.code,
        providerMessage: ctx.providerMessage,
        requestId: ctx.requestId,
        payloadSummary: ctx.payloadSummary ? {
          model: ctx.payloadSummary.model,
          generationMode: ctx.payloadSummary.generationMode,
          promptLength: ctx.payloadSummary.promptLength,
          contentItemCount: ctx.payloadSummary.contentItemCount,
          referenceImageCount: ctx.payloadSummary.referenceImageCount,
          referenceImageHosts: ctx.payloadSummary.referenceImageHosts,
          totalPayloadSizeKb: ctx.payloadSummary.totalPayloadSizeKb,
          // 不包含 API Key
        } : undefined,
      };
    }
    return JSON.stringify(obj, null, 2);
  }, [error, debugInfo, ctx]);

  if (!translated) {
    // 无匹配翻译：显示原始错误（友好兜底）
    return (
      <div className="error-translate">
        <div className="error-translate-title">创建失败</div>
        <div className="error-translate-user-msg">
          {error.includes('524') || error.toLowerCase().includes('timeout')
            ? 'Seedance 服务响应超时，请稍后重试或减少参考图数量'
            : '创建视频任务时遇到问题，请查看详情或稍后重试'}
        </div>
        <div className="error-translate-actions">
          {onRetry && (
            <button className="btn btn-sm btn-primary" onClick={onRetry}>
              重新提交
            </button>
          )}
          <button className="btn btn-sm btn-secondary" onClick={() => navigator.clipboard.writeText(getCopyContent())}>
            复制错误
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setShowDebug(!showDebug)}>
            {showDebug ? '收起' : '查看详情'}
          </button>
        </div>
        {showDebug && (
          <pre className="error-debug-pre">{getCopyContent()}</pre>
        )}
      </div>
    );
  }

  return (
    <div className="error-translate">
      <div className="error-translate-title">{translated.title}</div>
      <div className="error-translate-user-msg">{translated.userMessage}</div>

      {ctx?.requestId && (
        <div className="error-translate-request-id">
          RequestId: <code>{ctx.requestId}</code>
        </div>
      )}

      <div className="error-translate-reasons">
        <div className="reasons-label">可能原因：</div>
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
              <button key={i} className="btn btn-sm btn-primary" onClick={onRetry}>
                {action.label}
              </button>
            );
          }
          if (action.action === 'retry_hint_refs') {
            return (
              <button key={i} className="btn btn-sm btn-secondary" onClick={onRetry}>
                {action.label}
              </button>
            );
          }
          if (action.action === 'copy') {
            return (
              <button key={i} className="btn btn-sm btn-secondary" onClick={() => navigator.clipboard.writeText(getCopyContent())}>
                {action.label}
              </button>
            );
          }
          if (action.action === 'debug') {
            return (
              <button key={i} className="btn btn-sm btn-ghost" onClick={() => setShowDebug(!showDebug)}>
                {showDebug ? '收起' : action.label}
              </button>
            );
          }
          return null;
        })}
      </div>

      {showDebug && (
        <pre className="error-debug-pre">{getCopyContent()}</pre>
      )}
    </div>
  );
}
