'use client';

import React, { useCallback } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onFormat?: () => void;
}

const MAX_CHARS = 2000;

export function PromptEditor({ value, onChange, onFormat }: Props) {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    if (text.length <= MAX_CHARS) {
      onChange(text);
    }
  }, [onChange]);

  return (
    <div className="composer-prompt-editor">
      <textarea
        className="composer-prompt-textarea"
        value={value}
        onChange={handleChange}
        maxLength={MAX_CHARS}
        placeholder="描述你想生成的视频内容，可使用图1、图2引用上传素材……"
        rows={4}
      />

      <div className="composer-prompt-footer">
        <div className="composer-prompt-hint">
          输入 @ 使用素材或参考，例如：@图1 的动作，或参考 @视频1 的风格
        </div>
        <div className="composer-prompt-counter">
          {value.length} / {MAX_CHARS}
        </div>
      </div>
    </div>
  );
}
