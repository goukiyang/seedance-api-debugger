'use client';

import React from 'react';

interface Props {
  blockingError: string | null;
  usedRefs: string[];
  hasPrompt: boolean;
  hasAssets: boolean;
  hasBlockingUpload: boolean;
  /** 统一参考图数量（workspace + 外部资产） */
  totalRefCount?: number;
}

export function ComposerStatusLine({
  blockingError,
  usedRefs,
  hasPrompt,
  hasAssets,
  hasBlockingUpload,
  totalRefCount = 0,
}: Props) {
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
    items.push(<span key="refs">图集引用：{usedRefs.join('、')}</span>);
  }

  // 统一显示参考图数量（workspace 素材 + 外部资产）
  items.push(
    <span key="refs-count" style={{ color: totalRefCount > 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.25)' }}>
      参考图 {totalRefCount}/9
    </span>
  );

  if (!hasAssets && totalRefCount === 0) {
    items.push(<span key="noassets" className="text-white/40">无图集素材</span>);
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

