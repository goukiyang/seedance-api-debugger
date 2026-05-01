'use client';

import React, { useState } from 'react';
import type { AssetCollection } from '@/types';

interface Props {
  collections: AssetCollection[];
  currentCollectionId?: string;
  onLoad: (collectionId: string) => void;
  onSave: (name: string) => void;
  onNew: (name: string) => void;
  loading?: boolean;
}

export function ImageSetToolbar({ collections, currentCollectionId, onLoad, onSave, onNew, loading = false }: Props) {
  const [showLoadMenu, setShowLoadMenu] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [dialogName, setDialogName] = useState('');

  const currentCollection = collections.find((c) => c.id === currentCollectionId);

  const handleSave = () => {
    if (!dialogName.trim()) return;
    onSave(dialogName.trim());
    setDialogName('');
    setShowSaveDialog(false);
  };

  const handleNew = () => {
    if (!dialogName.trim()) return;
    onNew(dialogName.trim());
    setDialogName('');
    setShowNewDialog(false);
  };

  return (
    <>
      <div className="composer-toolbar">
        {/* 左侧：当前图集 */}
        <div className="composer-toolbar-left">
          <button
            type="button"
            className="composer-toolbar-current-set"
            onClick={() => setShowLoadMenu(!showLoadMenu)}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="composer-toolbar-set-name">
              {currentCollection ? currentCollection.name : '当前图集'}
            </span>
            <span className="composer-toolbar-chevron">▼</span>
          </button>

          {/* 加载图集下拉 */}
          {showLoadMenu && (
            <>
              <div className="composer-toolbar-dropdown-backdrop" onClick={() => setShowLoadMenu(false)} />
              <div className="composer-toolbar-dropdown">
                <div className="composer-toolbar-dropdown-title">选择图集</div>
                {collections.length === 0 ? (
                  <div className="composer-toolbar-dropdown-empty">暂无已保存的图集</div>
                ) : (
                  collections.map((col) => (
                    <button
                      key={col.id}
                      type="button"
                      className={`composer-toolbar-dropdown-item ${col.id === currentCollectionId ? 'active' : ''}`}
                      onClick={() => { onLoad(col.id); setShowLoadMenu(false); }}
                    >
                      <span>{col.name}</span>
                      <span className="composer-toolbar-dropdown-item-count">{col._count?.items || 0} 张</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {/* 右侧：操作按钮 */}
        <div className="composer-toolbar-right">
          <button
            type="button"
            className="composer-toolbar-btn"
            onClick={() => setShowLoadMenu(true)}
          >
            加载图集
          </button>
          <button
            type="button"
            className="composer-toolbar-btn"
            onClick={() => setShowSaveDialog(true)}
          >
            保存当前
          </button>
          <button
            type="button"
            className="composer-toolbar-btn"
            onClick={() => setShowNewDialog(true)}
          >
            新建图集
          </button>
        </div>
      </div>

      {/* 保存当前图集对话框 */}
      {showSaveDialog && (
        <div className="composer-dialog-backdrop" onClick={() => setShowSaveDialog(false)}>
          <div className="composer-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="composer-dialog-title">保存当前素材为图集</div>
            <input
              type="text"
              className="composer-dialog-input"
              placeholder="图集名称"
              value={dialogName}
              onChange={(e) => setDialogName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              autoFocus
            />
            <div className="composer-dialog-footer">
              <button type="button" className="composer-dialog-cancel" onClick={() => setShowSaveDialog(false)}>
                取消
              </button>
              <button
                type="button"
                className="composer-dialog-confirm"
                onClick={handleSave}
                disabled={!dialogName.trim() || loading}
              >
                {loading ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建图集对话框 */}
      {showNewDialog && (
        <div className="composer-dialog-backdrop" onClick={() => setShowNewDialog(false)}>
          <div className="composer-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="composer-dialog-title">新建图集</div>
            <input
              type="text"
              className="composer-dialog-input"
              placeholder="图集名称"
              value={dialogName}
              onChange={(e) => setDialogName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNew()}
              autoFocus
            />
            <div className="composer-dialog-footer">
              <button type="button" className="composer-dialog-cancel" onClick={() => setShowNewDialog(false)}>
                取消
              </button>
              <button
                type="button"
                className="composer-dialog-confirm"
                onClick={handleNew}
                disabled={!dialogName.trim() || loading}
              >
                {loading ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
