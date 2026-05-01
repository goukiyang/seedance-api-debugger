'use client';

/**
 * PreSubmissionChecker — 生成前检查系统
 * P0-4: 提交前检查闭环
 * - 实时检查所有条件
 * - 严重错误阻止提交
 * - 轻微冲突允许提交但提示
 */

import React from 'react';
import type { GenerationMode } from '@/types';

interface CheckItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

interface Props {
  /** 当前素材数量 */
  assetCount: number;
  /** 当前生成模式 */
  generationMode: GenerationMode;
  /** 提示词是否有效（图号引用） */
  promptValid: boolean;
  /** 提示词字数 */
  promptCharCount: number;
  /** 时间冲突 */
  durationConflict: boolean;
  /** 当前时长 */
  duration: number;
  /** 提示词中的时长 */
  promptDuration: number | null;
  /** 是否已填写提示词 */
  hasPrompt: boolean;
  /** 状态变化回调（P0-6 用于 StickySubmitBar） */
  onStatusChange?: (canSubmit: boolean) => void;
}

export function PreSubmissionChecker({
  assetCount,
  generationMode,
  promptValid,
  promptCharCount,
  durationConflict,
  duration,
  promptDuration,
  hasPrompt,
  onStatusChange,
}: Props) {
  const checks: CheckItem[] = [];

  // 1. 素材检查
  if (generationMode === 'first_last_frame') {
    if (assetCount >= 2) {
      checks.push({ id: 'asset', label: '素材数量', status: 'ok', message: `${assetCount} 张素材，满足首尾帧要求` });
    } else {
      checks.push({ id: 'asset', label: '素材数量', status: 'error', message: `首尾帧模式需要至少 2 张（当前 ${assetCount} 张）` });
    }
  } else if (generationMode === 'smart_multi_frame') {
    if (assetCount >= 3) {
      checks.push({ id: 'asset', label: '素材数量', status: 'ok', message: `${assetCount} 张素材，满足智能多帧要求` });
    } else {
      checks.push({ id: 'asset', label: '素材数量', status: 'error', message: `智能多帧模式需要至少 3 张（当前 ${assetCount} 张）` });
    }
  } else {
    if (assetCount >= 1) {
      checks.push({ id: 'asset', label: '素材数量', status: 'ok', message: `${assetCount} 张素材` });
    } else {
      checks.push({ id: 'asset', label: '素材数量', status: 'warn', message: '全能参考模式建议上传素材，当前无素材' });
    }
  }

  // 2. 提示词检查
  if (!hasPrompt) {
    checks.push({ id: 'prompt', label: '提示词', status: 'error', message: '请填写提示词' });
  } else if (!promptValid) {
    checks.push({ id: 'prompt', label: '图号引用', status: 'error', message: '提示词引用了不存在的图号' });
  } else {
    checks.push({ id: 'prompt', label: '图号引用', status: 'ok', message: '图号引用正常' });
  }

  // 3. 时间冲突检查
  if (hasPrompt && durationConflict && promptDuration) {
    checks.push({
      id: 'duration',
      label: '时长冲突',
      status: 'warn',
      message: `提示词写了 ${promptDuration} 秒，参数选择 ${duration} 秒`,
    });
  } else if (hasPrompt) {
    checks.push({ id: 'duration', label: '时长', status: 'ok', message: `${duration} 秒` });
  }

  // 判断是否可以提交
  const hasError = checks.some((c) => c.status === 'error');
  const canSubmit = !hasError;
  const hasWarn = checks.some((c) => c.status === 'warn');

  // P0-6: 通知父组件 canSubmit 状态变化
  React.useEffect(() => {
    onStatusChange?.(canSubmit);
  }, [canSubmit, onStatusChange]);

  return (
    <div className="pre-check">
      <div className="pre-check-title">
        生成前检查
        {hasError && <span className="pre-check-badge pre-check-badge-error">有错误</span>}
        {!hasError && hasWarn && <span className="pre-check-badge pre-check-badge-warn">有提示</span>}
        {!hasError && !hasWarn && <span className="pre-check-badge pre-check-badge-ok">全部通过</span>}
      </div>
      <div className="pre-check-list">
        {checks.map((check) => (
          <div key={check.id} className={`pre-check-item pre-check-item-${check.status}`}>
            <span className="pre-check-icon">
              {check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️' : '❌'}
            </span>
            <span className="pre-check-label">{check.label}</span>
            <span className="pre-check-msg">{check.message}</span>
          </div>
        ))}
      </div>
      {hasError && (
        <div className="pre-check-footer">
          请修正以上错误后提交
        </div>
      )}
    </div>
  );
}
