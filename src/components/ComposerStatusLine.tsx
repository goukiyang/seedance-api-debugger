'use client';

import React from 'react';

interface Props {
  blockingError: string | null;
  usedRefs: string[];
  hasPrompt: boolean;
  hasAssets: boolean;
  hasBlockingUpload: boolean;
}

export function ComposerStatusLine({ blockingError, usedRefs, hasPrompt, hasAssets, hasBlockingUpload }: Props) {
  // 严重错误
  if (blockingError) {
    return (
      <div className="composer-status-error">
        ⚠ {blockingError}
      </div>
    );
  }

  // 正常状态
  const items: React.ReactNode[] = [];

  if (usedRefs.length > 0) {
    items.push(<span key="refs">已引用：{usedRefs.join('、')}</span>);
  }

  if (!hasAssets) {
    items.push(<span key="noassets" className="text-white/40">无素材</span>);
  }

  if (items.length === 0) {
    items.push(<span key="ready" className="text-white/40">填写提示词并上传素材</span>);
  }

  return (
    <div className="composer-status-ok">
      {items.flatMap((node, i) =>
        i > 0 ? [<span key={`sep-${i}`} className="text-white/25">|</span>, node] : [node]
      )}
    </div>
  );
}
