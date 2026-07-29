'use client';

/**
 * ModeSelector — 生成模式选择器组件
 * P0-2: 模式闭环
 * - 展示每个模式的说明、素材要求、引用逻辑
 * - 切换模式时自动校验素材数量并给出反馈
 * - 不满足条件时显示警告，阻止提交
 */

import React from 'react';
import type { GenerationMode } from '@/types';

interface Props {
  value: GenerationMode;
  onChange: (mode: GenerationMode) => void;
  /** 当前素材数量 */
  assetCount: number;
  /** 当前图片参考数量；首尾帧和智能多帧只按图片参考校验 */
  imageAssetCount?: number;
}

const MODE_INFO: Record<GenerationMode, {
  label: string;
  subtitle: string;
 适用场景: string;
  素材要求: string;
  引用逻辑: string;
  最小素材: number;
  icon: string;
}> = {
  all_in_one_reference: {
    label: '全能参考',
    subtitle: '图片、视频和音频作为整体参考',
    适用场景: '上传图片、视频或音频作为整体参考，AI 根据参考素材生成视频',
    素材要求: '1 个以上，音频需要配图片或视频',
    引用逻辑: '图片可用 @图片1、@图片2 引用；视频和音频会自动作为参考素材传入',
    最小素材: 1,
    icon: '🎯',
  },
  first_last_frame: {
    label: '首尾帧',
    subtitle: '指定开头和结尾画面',
    适用场景: '上传首帧和尾帧图，AI 补全中间过渡动画',
    素材要求: '至少 2 个图片参考',
    引用逻辑: '@图片1 = 首帧（视频开头），@图片2 = 尾帧（视频结尾）',
    最小素材: 2,
    icon: '↔️',
  },
  smart_multi_frame: {
    label: '智能多帧',
    subtitle: '多张图按顺序推进',
    适用场景: '上传多张图，AI 按顺序生成图与图之间的过渡视频',
    素材要求: '至少 3 个图片参考',
    引用逻辑: '@图片1 → @图片2 → @图片3 → ... 按顺序推进',
    最小素材: 3,
    icon: '🎬',
  },
};

function getValidationCount(mode: GenerationMode, assetCount: number, imageAssetCount?: number) {
  if (mode === 'first_last_frame' || mode === 'smart_multi_frame') {
    return imageAssetCount ?? assetCount;
  }
  return assetCount;
}

export function ModeSelector({ value, onChange, assetCount, imageAssetCount }: Props) {
  const info = MODE_INFO[value];
  const validationCount = getValidationCount(value, assetCount, imageAssetCount);
  const isValid = validationCount >= info.最小素材;
  const missing = info.最小素材 - validationCount;

  return (
    <div className="space-y-3">
      {/* 模式选项 */}
      <div className="radio-group flex-col gap-2">
        {(Object.keys(MODE_INFO) as GenerationMode[]).map((mode) => {
          const m = MODE_INFO[mode];
          const meets = getValidationCount(mode, assetCount, imageAssetCount) >= m.最小素材;

          return (
            <label
              key={mode}
              className={[
                'mode-option',
                value === mode ? 'mode-option-selected' : '',
              ].join(' ')}
            >
              <input
                type="radio"
                name="generation_mode"
                value={mode}
                checked={value === mode}
                onChange={() => onChange(mode)}
                className="sr-only"
              />
              <div className="flex items-start gap-3 w-full">
                <span className="text-lg flex-shrink-0 mt-0.5">{m.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-gray-900">{m.label}</span>
                    <span className="text-xs text-gray-500">{m.subtitle}</span>
                    {value === mode && (
                      <span className="ml-auto text-xs text-blue-600 font-medium">已选择</span>
                    )}
                  </div>
                  {/* 选中时展开详情 */}
                  {value === mode && (
                    <div className="mt-2 text-xs text-gray-600 space-y-1">
                      <div><span className="text-gray-400">适用场景：</span>{m.适用场景}</div>
                      <div><span className="text-gray-400">素材要求：</span>{m.素材要求}</div>
                      <div><span className="text-gray-400">引用逻辑：</span>{m.引用逻辑}</div>
                    </div>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* 素材数量校验反馈 */}
      {value === 'first_last_frame' && (
        <div className={`mode-feedback ${isValid ? 'mode-feedback-ok' : 'mode-feedback-warn'}`}>
          {isValid ? (
            <>
              <span className="mode-feedback-icon">✅</span>
              <span>首尾帧模式已启用</span>
              <span className="text-gray-400 ml-1">
                @图片1 将作为视频开头，@图片2 将作为视频结尾
              </span>
            </>
          ) : (
            <>
              <span className="mode-feedback-icon">⚠️</span>
              <span>
                首尾帧模式至少需要 <strong>2 个图片参考</strong>
                {missing > 0 && <span className="text-red-500 ml-1">（还差 {missing} 个）</span>}
              </span>
            </>
          )}
        </div>
      )}

      {value === 'smart_multi_frame' && (
        <div className={`mode-feedback ${isValid ? 'mode-feedback-ok' : 'mode-feedback-warn'}`}>
          {isValid ? (
            <>
              <span className="mode-feedback-icon">✅</span>
              <span>智能多帧模式已启用</span>
              <span className="text-gray-400 ml-1">
                @图片1 → @图片2 → @图片3 按顺序推进
              </span>
            </>
          ) : (
            <>
              <span className="mode-feedback-icon">⚠️</span>
              <span>
                智能多帧模式至少需要 <strong>3 个图片参考</strong>
                {missing > 0 && <span className="text-red-500 ml-1">（还差 {missing} 个）</span>}
              </span>
            </>
          )}
        </div>
      )}

      {value === 'all_in_one_reference' && (
        <div className="mode-feedback mode-feedback-ok">
          <span className="mode-feedback-icon">✅</span>
          <span>全能参考模式已启用</span>
          <span className="text-gray-400 ml-1">
            所有上传素材均作为参考素材，音频需配图片或视频一起使用
          </span>
        </div>
      )}
    </div>
  );
}
