'use client';

import React, { useState, useCallback, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface SeedanceAssetRecord {
  id: string;
  provider: string;
  providerAssetId: string;
  assetType: string;
  name: string;
  originalUrl: string;
  providerPreviewUrl: string | null;
  providerStatus: string | null;
  localStatus: string;
  storageProvider: string | null;
  createdAt: string;
}

export interface SelectedReferenceAsset {
  localAssetId: string;
  provider: 'seedance';
  providerAssetId: string;
  name: string;
  originalUrl: string;
  providerPreviewUrl?: string | null;
  providerStatus?: string | null;
  order: number;
}

interface SeedanceAssetSelectorProps {
  value: SelectedReferenceAsset[];
  onChange: (assets: SelectedReferenceAsset[]) => void;
  max?: number;
}

const MAX_ASSETS_DEFAULT = 9;

// ============================================================================
// ThumbnailCard (内部用)
// ============================================================================

function ThumbnailCard({
  asset,
  isSelected,
  onSelect,
  onRemove,
  order,
  showRemove,
}: {
  asset: SeedanceAssetRecord;
  isSelected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  order?: number;
  showRemove?: boolean;
}) {
  const thumbUrl =
    asset.providerPreviewUrl || asset.originalUrl;

  return (
    <div
      className="relative flex-shrink-0 cursor-pointer group"
      style={{ width: 52, height: 68 }}
      onClick={onSelect}
      title={asset.name}
    >
      <img
        src={thumbUrl}
        alt={asset.name}
        className="w-full h-full object-cover rounded"
        style={{
          border: isSelected
            ? '2px solid #3b82f6'
            : '1px solid rgba(255,255,255,0.15)',
          background: 'rgba(255,255,255,0.05)',
        }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      {isSelected && (
        <div
          className="absolute top-0 left-0 w-full h-full rounded flex items-center justify-center"
          style={{ background: 'rgba(59,130,246,0.6)' }}
        >
          {order !== undefined && (
            <span className="text-white font-bold text-sm">{order + 1}</span>
          )}
        </div>
      )}
      {showRemove && !isSelected && (
        <button
          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ============================================================================
// AssetGrid (资产选择弹窗)
// ============================================================================

function AssetGrid({
  onSelect,
  onClose,
}: {
  onSelect: (asset: SeedanceAssetRecord) => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<SeedanceAssetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/assets/list')
      .then((r) => r.json())
      .then((d) => {
        const imageAssets = (d.assets || []).filter(
          (a: SeedanceAssetRecord) =>
            a.assetType === 'Image' && a.localStatus === 'Active'
        );
        setAssets(imageAssets);
      })
      .catch(() => setError('加载失败'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.6)' }}
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-[#1a1a2e] rounded-xl border border-white/10 shadow-2xl pointer-events-auto w-full max-w-2xl max-h-[70vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
            <div>
              <h3 className="text-white font-semibold">选择 Seedance 资产作为参考图</h3>
              <p className="text-xs text-white/40 mt-0.5">
                仅显示图片类型的有效资产
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white/50 hover:text-white text-xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {loading && (
              <div className="text-center text-white/50 py-8">加载中...</div>
            )}
            {error && (
              <div className="text-center text-red-400 py-8">{error}</div>
            )}
            {!loading && !error && assets.length === 0 && (
              <div className="text-center text-white/40 py-8">
                暂无可用资产，请先在「资产管理」中上传
              </div>
            )}
            {!loading && !error && assets.length > 0 && (
              <div className="grid grid-cols-5 gap-3">
                {assets.map((asset) => (
                  <div key={asset.id} className="flex flex-col items-center gap-1.5">
                    <ThumbnailCard
                      asset={asset}
                      isSelected={false}
                      onSelect={() => {
                        onSelect(asset);
                        onClose();
                      }}
                      onRemove={undefined}
                      order={undefined}
                      showRemove={false}
                    />
                    <span
                      className="text-white/60 text-xs text-center truncate w-full px-1"
                      title={asset.name}
                    >
                      {asset.name}
                    </span>
                    <span className="text-white/30 text-xs truncate w-full px-1">
                      {asset.providerAssetId}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// SeedanceAssetSelector
// ============================================================================

export function SeedanceAssetSelector({
  value,
  onChange,
  max = MAX_ASSETS_DEFAULT,
}: SeedanceAssetSelectorProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [showWarning, setShowWarning] = useState(false);

  // 处理选择资产
  const handleSelect = useCallback(
    (asset: SeedanceAssetRecord) => {
      if (value.length >= max) {
        setShowWarning(true);
        setTimeout(() => setShowWarning(false), 2000);
        return;
      }
      const newAsset: SelectedReferenceAsset = {
        localAssetId: asset.id,
        provider: 'seedance',
        providerAssetId: asset.providerAssetId,
        name: asset.name,
        originalUrl: asset.originalUrl,
        providerPreviewUrl: asset.providerPreviewUrl,
        providerStatus: asset.providerStatus,
        order: value.length,
      };
      onChange([...value, newAsset]);
    },
    [value, onChange, max]
  );

  // 移除资产
  const handleRemove = useCallback(
    (localAssetId: string) => {
      const filtered = value.filter((a) => a.localAssetId !== localAssetId);
      // 重新排序
      onChange(filtered.map((a, i) => ({ ...a, order: i })));
    },
    [value, onChange]
  );

  // 上移
  const handleMoveUp = useCallback(
    (index: number) => {
      if (index === 0) return;
      const newList = [...value];
      [newList[index - 1], newList[index]] = [newList[index], newList[index - 1]];
      onChange(newList.map((a, i) => ({ ...a, order: i })));
    },
    [value, onChange]
  );

  // 下移
  const handleMoveDown = useCallback(
    (index: number) => {
      if (index === value.length - 1) return;
      const newList = [...value];
      [newList[index], newList[index + 1]] = [newList[index + 1], newList[index]];
      onChange(newList.map((a, i) => ({ ...a, order: i })));
    },
    [value, onChange]
  );

  return (
    <>
      <div className="flex flex-col gap-2">
        {/* 标签行 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/50">Seedance 参考图资产</span>
          <span className="text-xs text-white/30">
            {value.length}/{max} 张
          </span>
        </div>

        {/* 资产条 */}
        <div className="flex items-center gap-2 flex-wrap">
          {value.map((asset, index) => (
            <div
              key={asset.localAssetId}
              className="relative group"
            >
              <div
                className="relative"
                style={{ width: 52, height: 68 }}
              >
                <img
                  src={asset.providerPreviewUrl || asset.originalUrl}
                  alt={asset.name}
                  className="w-full h-full object-cover rounded"
                  style={{
                    border: '2px solid #3b82f6',
                    background: 'rgba(255,255,255,0.05)',
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                {/* 序号 */}
                <div
                  className="absolute top-0 left-0 w-full h-full rounded flex items-center justify-center"
                  style={{ background: 'rgba(59,130,246,0.5)' }}
                >
                  <span className="text-white font-bold text-sm">{index + 1}</span>
                </div>
              </div>

              {/* 删除按钮 */}
              <button
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => handleRemove(asset.localAssetId)}
                title="移除"
              >
                ×
              </button>

              {/* 排序按钮 */}
              <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  className="w-3.5 h-3 rounded bg-black/60 text-white/70 text-xs flex items-center justify-center hover:bg-black/80"
                  onClick={() => handleMoveUp(index)}
                  disabled={index === 0}
                  style={{ opacity: index === 0 ? 0.2 : undefined }}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  className="w-3.5 h-3 rounded bg-black/60 text-white/70 text-xs flex items-center justify-center hover:bg-black/80"
                  onClick={() => handleMoveDown(index)}
                  disabled={index === value.length - 1}
                  style={{ opacity: index === value.length - 1 ? 0.2 : undefined }}
                  title="下移"
                >
                  ↓
                </button>
              </div>
            </div>
          ))}

          {/* 添加按钮 */}
          <button
            className="flex-shrink-0 flex items-center justify-center rounded border border-dashed border-white/20 text-white/40 hover:border-white/40 hover:text-white/60 transition-colors"
            style={{ width: 52, height: 68 }}
            onClick={() => setShowPicker(true)}
            title="添加 Seedance 资产"
          >
            <span className="text-lg">+</span>
          </button>
        </div>

        {/* 警告 */}
        {showWarning && (
          <div className="text-xs text-red-400">最多选择 {max} 张参考图</div>
        )}

        {/* 说明 */}
        {value.length === 0 && (
          <div className="text-xs text-white/25">
            点击 + 从 Seedance 资产中选择参考图，生成的视频任务会记录这些资产的引用关系
          </div>
        )}
      </div>

      {/* 资产选择弹窗 */}
      {showPicker && (
        <AssetGrid
          onSelect={handleSelect}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
