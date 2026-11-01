'use client';

import React, { useId, useRef, useState } from 'react';
import type { AssetCollection } from '@/types';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useDialogDismiss } from '@/components/useDialogDismiss';

interface ReferenceAlbumOption {
  id: string;
  name: string;
  image_count: number;
  album_type: string;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  project?: { name: string } | null;
  permissions?: { use?: boolean; edit?: boolean };
}

interface Props {
  collections: AssetCollection[];
  currentCollectionId?: string;
  onLoad: (collectionId: string) => void;
  onSave: (name: string) => Promise<void>;
  onNew: (name: string) => Promise<void>;
  onOpenReferenceAlbums?: () => void;
  referenceAlbums?: ReferenceAlbumOption[];
  currentReferenceAlbumId?: string | null;
  currentReferenceAlbumName?: string | null;
  onReferenceAlbumLoad?: (albumId: string, albumName: string) => Promise<void>;
  onReferenceAlbumSaveCurrent?: (name: string) => Promise<void>;
  onReferenceAlbumCreate?: (name: string) => Promise<void>;
  loading?: boolean;
}

export function ImageSetToolbar({
  collections,
  currentCollectionId,
  onLoad,
  onSave,
  onNew,
  onOpenReferenceAlbums,
  referenceAlbums = [],
  currentReferenceAlbumId,
  currentReferenceAlbumName,
  onReferenceAlbumLoad,
  onReferenceAlbumSaveCurrent,
  onReferenceAlbumCreate,
  loading = false,
}: Props) {
  const [showLoadMenu, setShowLoadMenu] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [dialogName, setDialogName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const titleId = useId();
  const closeSave = () => { if (!saveLock.current) setShowSaveDialog(false); };
  const closeNew = () => { if (!saveLock.current) setShowNewDialog(false); };
  const loadMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const loadMenuRef = useRef<HTMLDivElement>(null);
  const saveDialogBackdropRef = useRef<HTMLDivElement>(null);
  const saveDialogRef = useRef<HTMLDivElement>(null);
  const newDialogBackdropRef = useRef<HTMLDivElement>(null);
  const newDialogRef = useRef<HTMLDivElement>(null);

  useDialogDismiss({
    open: showLoadMenu,
    dialogRef: loadMenuRef,
    branchRefs: [loadMenuTriggerRef],
    onDismiss: () => setShowLoadMenu(false),
    modal: false,
  });
  useDialogDismiss({
    open: showSaveDialog,
    dialogRef: saveDialogRef,
    dismissSurfaceRef: saveDialogBackdropRef,
    onDismiss: closeSave,
  });
  useDialogDismiss({
    open: showNewDialog,
    dialogRef: newDialogRef,
    dismissSurfaceRef: newDialogBackdropRef,
    onDismiss: closeNew,
  });

  const currentCollection = collections.find((c) => c.id === currentCollectionId);
  const visibleReferenceAlbums = referenceAlbums.filter((album) => album.image_count > 0);

  const handleSave = async () => {
    if (!dialogName.trim() || loading || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    try {
      setActionError(null);
      if (onReferenceAlbumSaveCurrent) await onReferenceAlbumSaveCurrent(dialogName.trim());
      else await onSave(dialogName.trim());
      setDialogName('');
      setShowSaveDialog(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '保存失败');
    } finally { saveLock.current = false; setSaving(false); }
  };

  const handleNew = async () => {
    if (!dialogName.trim() || loading || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    try {
      setActionError(null);
      if (onReferenceAlbumCreate) await onReferenceAlbumCreate(dialogName.trim());
      else await onNew(dialogName.trim());
      setDialogName('');
      setShowNewDialog(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '创建失败');
    } finally { saveLock.current = false; setSaving(false); }
  };

  return (
    <>
      <div className="composer-toolbar">
        {/* 左侧：当前图集 */}
        <div className="composer-toolbar-left">
          <button
            ref={loadMenuTriggerRef}
            type="button"
            className="composer-toolbar-current-set"
            onClick={() => setShowLoadMenu(!showLoadMenu)}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="composer-toolbar-set-name">
              {currentReferenceAlbumName || currentCollection?.name || '当前图集'}
            </span>
            <span className="composer-toolbar-chevron">▼</span>
          </button>

          {showLoadMenu && (
            <>
              <div className="composer-toolbar-dropdown-backdrop" />
              <div ref={loadMenuRef} className="composer-toolbar-dropdown">
                <div className="composer-toolbar-dropdown-title">选择图集</div>
                {onReferenceAlbumLoad ? (
                  visibleReferenceAlbums.length === 0 ? (
                    <div className="composer-toolbar-dropdown-empty">暂无可用参考图集</div>
                  ) : (
                    visibleReferenceAlbums.map((album) => (
                      <button
                        key={album.id}
                        type="button"
                        className={`composer-toolbar-dropdown-item ${album.id === currentReferenceAlbumId ? 'active' : ''}`}
                        onClick={async () => {
                          try {
                            setActionError(null);
                            await onReferenceAlbumLoad(album.id, album.name);
                            setShowLoadMenu(false);
                          } catch (err) {
                            setActionError(err instanceof Error ? err.message : '切换图集失败');
                          }
                        }}
                      >
                        <span className="composer-toolbar-dropdown-item-main">
                          <UserIdentityBadge user={album.owner} size="sm" avatarOnly />
                          <span className="composer-toolbar-dropdown-item-name">{album.name}</span>
                        </span>
                        <span className="composer-toolbar-dropdown-item-count">{album.image_count || 0} 张</span>
                      </button>
                    ))
                  )
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
          {onOpenReferenceAlbums && (
            <button
              type="button"
              className="composer-toolbar-btn primary"
              onClick={onOpenReferenceAlbums}
            >
              从图集选择参考图
            </button>
          )}
          <button
            type="button"
            className="composer-toolbar-btn"
            onClick={() => { setActionError(null); setShowSaveDialog(true); }}
          >
            保存素材为图集
          </button>
          <button
            type="button"
            className="composer-toolbar-btn"
            onClick={() => { setActionError(null); setShowNewDialog(true); }}
          >
            创建空图集
          </button>
        </div>
      </div>

      {actionError && !showSaveDialog && !showNewDialog && (
        <div className="composer-toolbar-error" role="alert">{actionError}</div>
      )}

      {/* 保存当前素材为图集对话框 */}
      {showSaveDialog && (
        <div ref={saveDialogBackdropRef} className="composer-dialog-backdrop">
          <div ref={saveDialogRef} className="composer-dialog" role="dialog" aria-modal="true" aria-labelledby={`${titleId}-save`} aria-busy={saving}>
            <div id={`${titleId}-save`} className="composer-dialog-title">保存当前素材为图集</div>
            <input
              type="text"
              className="composer-dialog-input"
              placeholder="图集名称"
              value={dialogName}
              onChange={(e) => setDialogName(e.target.value)}
              disabled={saving}
              aria-label="图集名称"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void handleSave(); } }}
              autoFocus
            />
            {actionError && <p role="alert" className="composer-toolbar-error">{actionError}</p>}
            <div className="composer-dialog-footer">
              <button type="button" disabled={saving} className="composer-dialog-cancel" onClick={closeSave}>
                取消
              </button>
              <button
                type="button"
                className="composer-dialog-confirm"
                onClick={() => void handleSave()}
                disabled={!dialogName.trim() || loading || saving}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建空图集对话框 */}
      {showNewDialog && (
        <div ref={newDialogBackdropRef} className="composer-dialog-backdrop">
          <div ref={newDialogRef} className="composer-dialog" role="dialog" aria-modal="true" aria-labelledby={`${titleId}-new`} aria-busy={saving}>
            <div id={`${titleId}-new`} className="composer-dialog-title">创建空图集</div>
            <input
              type="text"
              className="composer-dialog-input"
              placeholder="图集名称"
              value={dialogName}
              onChange={(e) => setDialogName(e.target.value)}
              disabled={saving}
              aria-label="图集名称"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void handleNew(); } }}
              autoFocus
            />
            {actionError && <p role="alert" className="composer-toolbar-error">{actionError}</p>}
            <div className="composer-dialog-footer">
              <button type="button" disabled={saving} className="composer-dialog-cancel" onClick={closeNew}>
                取消
              </button>
              <button
                type="button"
                className="composer-dialog-confirm"
                onClick={() => void handleNew()}
                disabled={!dialogName.trim() || loading || saving}
              >
                {saving ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
