'use client';

/**
 * ErrorTranslator — 错误翻译组件
 * P0-5: 错误翻译系统
 * - 将原始 API 错误码翻译成用户友好的中文
 * - 提供可能原因和操作建议
 */

import React, { useCallback } from 'react';

interface Props {
  error: string;
  /** 原始错误信息 */
  rawError?: string;
  onRetry?: () => void;
  onCopy?: () => void;
}

/** 错误码翻译表 */
function translateError(error: string): {
  code: string;
  title: string;
  reasons: string[];
  actions: Array<{ label: string; action?: 'retry' | 'copy' | 'debug' }>;
} | null {
  const lower = error.toLowerCase();

  // 554 错误
  if (error.includes('554') || error.includes('554') || lower.includes('554')) {
    return {
      code: '554',
      title: '服务返回错误 (554)',
      reasons: [
        '当前参数组合不被服务支持（如比例/时长/分辨率不兼容）',
        '素材上传成功但生成接口引用失败',
        'API 限流、额度不足或服务异常',
        '当前模式与素材数量不匹配',
        '服务端处理超时或内部错误',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
        { label: '查看调试信息', action: 'debug' },
      ],
    };
  }

  // 401 未授权
  if (error.includes('401') || lower.includes('unauthorized') || lower.includes('未授权')) {
    return {
      code: '401',
      title: 'API 认证失败',
      reasons: [
        'API Key 未配置或已过期',
        'API Key 权限不足',
        '请求头格式错误',
      ],
      actions: [
        { label: '检查 API 配置', action: 'debug' },
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // 403 禁止
  if (error.includes('403') || lower.includes('forbidden') || lower.includes('禁止')) {
    return {
      code: '403',
      title: 'API 访问被拒绝',
      reasons: [
        'API Key 没有该接口的访问权限',
        '账户余额不足或额度用尽',
        '当前 IP 不在白名单中',
      ],
      actions: [
        { label: '检查 API 配置', action: 'debug' },
        { label: '复制错误', action: 'copy' },
      ],
    };
  }

  // 429 限流
  if (error.includes('429') || lower.includes('rate limit') || lower.includes('限流')) {
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
        { label: '检查素材', action: 'debug' },
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
        'API 服务返回了非 JSON 格式的响应',
        '服务临时异常',
      ],
      actions: [
        { label: '重新提交', action: 'retry' },
        { label: '复制错误', action: 'copy' },
        { label: '查看调试信息', action: 'debug' },
      ],
    };
  }

  // 默认未知错误
  return null;
}

export function ErrorTranslator({ error, rawError, onRetry, onCopy }: Props) {
  const translated = translateError(error);

  if (!translated) {
    // 无匹配翻译，显示原始错误
    return (
      <div className="alert alert-error">
        <div className="text-xs font-medium mb-1">创建失败</div>
        <div className="text-xs">{error}</div>
        <div className="mt-2 flex gap-2">
          {onRetry && (
            <button className="btn btn-sm btn-danger" onClick={onRetry}>重新提交</button>
          )}
          {onCopy && (
            <button className="btn btn-sm btn-secondary" onClick={onCopy}>复制错误</button>
          )}
        </div>
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
              <button key={i} className="btn btn-sm btn-secondary" onClick={onCopy}>
                {action.label}
              </button>
            );
          }
          return null;
        })}
      </div>
      {/* 调试信息折叠 */}
      {rawError && (
        <details className="mt-3">
          <summary className="text-xs text-gray-400 cursor-pointer">展开原始错误</summary>
          <div className="mt-2 bg-gray-50 p-2 rounded text-xs font-mono break-all text-gray-600 max-h-40 overflow-y-auto">
            {rawError}
          </div>
        </details>
      )}
    </div>
  );
}
