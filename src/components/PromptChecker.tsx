'use client';

/**
 * PromptChecker — 提示词检测与编辑组件
 * P0-3: 提示词闭环
 * - 解析图片引用（@图片1/@图片 1，兼容旧格式 @图1/图1）
 * - 检测时间冲突（提示词里的秒数 vs 参数选择）
 * - 字数统计
 * - 保留编号格式（#泡泡升标008）
 * - 格式化、复制、清空
 */

import React, { useState, useMemo, useCallback } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 当前素材数量 */
  assetCount: number;
  /** 当前时长参数（秒） */
  duration: number;
  /** 验证结果变化回调（P0-4 用于 PreSubmissionChecker） */
  onValidationChange?: (result: CheckResult) => void;
}

export interface CheckResult {
  valid: boolean;
  charCount: number;
  referencedFigures: number[];
  maxReferenced: number;
  missingFigures: number[];
  maxMissing: number;
  /** 提示词中检测到的秒数（如 10） */
  durationInPrompt: number | null;
  /** 时间冲突：提示词秒数 != 参数秒数 */
  durationConflict: boolean;
  promptDuration: number;
  paramDuration: number;
}

export function checkPrompt(value: string, assetCount: number, paramDuration: number): CheckResult {
  const charCount = value.length;

  // 即梦官方参考格式是 @图片1 / @图片 1；兼容旧 prompt 中的 @图1 / 图1。
  const figureMatches = Array.from(value.matchAll(/@?(?:图片|图)\s*(\d+)/g));
  const unique = Array.from(new Set(figureMatches.map((match) => parseInt(match[1], 10))));
  const referencedFigures = unique.sort((a, b) => a - b);
  const maxReferenced = referencedFigures.length > 0 ? Math.max(...referencedFigures) : 0;
  const missingFigures = referencedFigures.filter((n) => n > assetCount);
  const maxMissing = missingFigures.length > 0 ? Math.max(...missingFigures) : 0;

  // 解析时间描述：X秒、X秒后、第X秒、X秒内
  const durationMatch = value.match(/(?:第?(\d+)秒|(\d+)秒(?:后|内|时))/);
  const durationNumbers = durationMatch
    ? durationMatch.slice(1).map((g) => parseInt(g || '0', 10)).filter((n) => n >= 1 && n <= 15)
    : [];
  // 取最大值作为提示词中的时长
  const durationInPrompt = durationNumbers.length > 0 ? Math.max(...durationNumbers) : null;
  const durationConflict = durationInPrompt !== null && durationInPrompt !== paramDuration;
  const promptDuration = durationInPrompt ?? paramDuration;

  const valid = missingFigures.length === 0;

  return {
    valid,
    charCount,
    referencedFigures,
    maxReferenced,
    missingFigures,
    maxMissing,
    durationInPrompt,
    durationConflict,
    promptDuration,
    paramDuration,
  };
}

export function PromptChecker({ value, onChange, assetCount, duration, onValidationChange }: Props) {
  const [showFormat, setShowFormat] = useState(false);

  const result = useMemo(
    () => checkPrompt(value, assetCount, duration),
    [value, assetCount, duration]
  );

  // P0-4: 通知父组件验证结果变化
  React.useEffect(() => {
    onValidationChange?.(result);
  }, [result, onValidationChange]);

  // 格式化提示词：保留标题编号、清空多余空白
  const handleFormat = useCallback(() => {
    const formatted = value
      // 保留标题格式（#泡泡升标008 等）
      .trim()
      // 合并多余空行（最多保留1个空行）
      .replace(/\n{3,}/g, '\n\n');
    onChange(formatted);
  }, [value, onChange]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
  }, [value]);

  return (
    <div className="space-y-2">
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-3">
          <span className="text-gray-500">{result.charCount} 字</span>

          {result.referencedFigures.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="text-gray-400">已引用：</span>
              {result.referencedFigures.map((n) => (
                <span
                  key={n}
                  className={`px-1.5 py-0.5 rounded text-xs font-mono ${
                    n <= assetCount
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-red-100 text-red-600'
                  }`}
                >
                  图片{n}
                </span>
              ))}
            </span>
          )}

          <span className={result.valid ? 'text-green-600' : 'text-red-500'}>
            {result.valid
              ? result.referencedFigures.length > 0
                ? '✓ 图片引用正常'
                : '✓ 未引用图片'
              : `❌ 引用了不存在的图片`}
          </span>

          {result.durationConflict && (
            <span className="text-orange-500 flex items-center gap-1">
              ⚠️ 提示词写了 {result.promptDuration} 秒，但参数为 {result.paramDuration} 秒
            </span>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-gray-500 hover:text-gray-700"
            onClick={handleCopy}
            title="复制"
          >
            📋 复制
          </button>
          <button
            type="button"
            className="text-xs text-gray-500 hover:text-gray-700"
            onClick={handleFormat}
            title="格式化"
          >
            ✨ 格式化
          </button>
          <button
            type="button"
            className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => onChange('')}
            title="清空"
          >
            清空
          </button>
        </div>
      </div>

      {/* 提示词文本框 */}
      <textarea
        className="form-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="描述你想要生成的视频内容...&#10;使用 @图片1、@图片2 引用上传的素材"
        rows={4}
      />

      {/* 提示词底部提示 */}
      <p className="form-hint">
        使用 <strong>@图片1</strong>、<strong>@图片2</strong> 引用上传的素材。
        {result.durationConflict && (
          <span className="text-orange-500 ml-2">
            提示：提示词提到 {result.promptDuration} 秒，当前参数为 {result.paramDuration} 秒，可考虑统一
          </span>
        )}
      </p>

      {/* 图号不存在的详细警告 */}
      {!result.valid && (
        <div className="alert alert-error">
          <div className="text-xs">
            <strong>提示词引用了不存在的图号：</strong>
            {result.missingFigures.map((n) => (
              <span key={n} className="ml-1 px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-xs">
                图{n}
              </span>
            ))}
            {result.missingFigures.length > 0 && (
            <div className="mt-1">
              请删除未引用的图号，或继续上传 {result.maxMissing - assetCount} 张素材
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
