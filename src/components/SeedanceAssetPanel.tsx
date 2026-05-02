'use client';

import React, { useState, useCallback, useEffect } from 'react';
import type { LocalAssetRecord } from '@/lib/provider/seedance-assets-types';

interface AssetPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function SeedanceAssetPanel({ visible, onClose }: AssetPanelProps) {
  const [assets, setAssets] = useState<LocalAssetRecord[]>([]);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ asset?: LocalAssetRecord; error?: string; providerSyncError?: string } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // 加载列表
  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/assets/list?includeDeleted=${includeDeleted}`);
      const data = await res.json();
      setAssets(data.assets || []);
    } finally {
      setLoading(false);
    }
  }, [includeDeleted]);

  useEffect(() => {
    if (visible) loadAssets();
  }, [visible, loadAssets]);

  // 创建资产
  const handleCreate = useCallback(async () => {
    if (!url.trim() || !name.trim()) return;
    setCreating(true);
    setActionMsg(null);
    try {
      const res = await fetch('/api/assets/create-from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg(`❌ 创建失败：${data.error}`);
      } else {
        setActionMsg(`✅ 创建成功：${data.asset.providerAssetId}`);
        setUrl('');
        setName('');
        await loadAssets();
      }
    } catch {
      setActionMsg('❌ 网络错误');
    } finally {
      setCreating(false);
    }
  }, [url, name, loadAssets]);

  // 查看详情（同步官方）
  const handleGetDetail = useCallback(async (localId: string) => {
    setDetailId(localId);
    setDetail(null);
    try {
      const res = await fetch(`/api/assets/${localId}`);
      const data = await res.json();
      setDetail(data);
    } catch {
      setDetail({ error: '网络错误' });
    }
  }, []);

  // 重命名
  const handleRename = useCallback(async (localId: string) => {
    if (!editName.trim()) return;
    setActionMsg(null);
    try {
      const res = await fetch(`/api/assets/${localId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg(`❌ 重命名失败：${data.error}`);
      } else {
        setActionMsg('✅ 重命名成功');
        setEditId(null);
        await loadAssets();
      }
    } catch {
      setActionMsg('❌ 网络错误');
    }
  }, [editName, loadAssets]);

  // 从列表移除（软删除）
  const handleRemove = useCallback(async (localId: string) => {
    setActionMsg(null);
    try {
      const res = await fetch(`/api/assets/${localId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg(`❌ 移除失败：${data.error}`);
      } else {
        setActionMsg('✅ 已从素材库移除（官方资产保留）');
        if (detailId === localId) { setDetail(null); setDetailId(null); }
        await loadAssets();
      }
    } catch {
      setActionMsg('❌ 网络错误');
    }
  }, [detailId, loadAssets]);

  // 彻底删除官方资产
  const handleProviderDelete = useCallback(async (localId: string) => {
    const ok = window.confirm('确认彻底删除官方 Seedance 资产？此操作不可撤销。');
    if (!ok) return;
    setActionMsg(null);
    try {
      const res = await fetch(`/api/assets/${localId}/provider-delete`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg(`❌ 彻底删除失败：${data.error}`);
      } else {
        setActionMsg('✅ 官方资产已删除');
        if (detailId === localId) { setDetail(null); setDetailId(null); }
        await loadAssets();
      }
    } catch {
      setActionMsg('❌ 网络错误');
    }
  }, [detailId, loadAssets]);

  if (!visible) return null;

  const statusBadge = (s: string) => {
    const cls = s === 'Active' ? 'bg-green-900 text-green-300'
      : s === 'Deleted' ? 'bg-yellow-900 text-yellow-300'
      : s === 'ProviderDeleted' ? 'bg-red-900 text-red-300'
      : s === 'DeleteFailed' ? 'bg-orange-900 text-orange-300'
      : 'bg-gray-700 text-gray-300';
    return <span className={`text-xs px-2 py-0.5 rounded-full font-mono ${cls}`}>{s}</span>;
  };

  return (
    <div style={{
      position: 'fixed', bottom: 24, left: 50, transform: 'translateX(-50%)',
      width: 'calc(100% - 96px)', maxWidth: 900, zIndex: 60,
      backgroundColor: 'rgba(11,18,32,0.98)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 20, padding: 20,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      maxHeight: '70vh', display: 'flex', flexDirection: 'column',
    }}>
      {/* 标题栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'white' }}>Seedance 资产管理（测试）</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={loadAssets}
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', background: 'none', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer' }}
          >
            {loading ? '加载中...' : '刷新列表'}
          </button>
          <button
            onClick={onClose}
            style={{ fontSize: 18, color: 'rgba(255,255,255,0.5)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, overflow: 'hidden', flex: 1, minHeight: 0 }}>
        {/* 左侧：创建 + 列表 */}
        <div style={{ overflowY: 'auto' }}>
          {/* 创建区 */}
          <div style={{ marginBottom: 16, padding: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 10 }}>创建资产（公网 URL）</div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xxx.jpg"
              style={{ width: '100%', padding: '7px 10px', backgroundColor: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: 'white', fontSize: 12, outline: 'none', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="资产名称"
                style={{ flex: 1, padding: '7px 10px', backgroundColor: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: 'white', fontSize: 12, outline: 'none' }}
              />
              <button
                onClick={handleCreate}
                disabled={creating || !url.trim() || !name.trim()}
                style={{ padding: '7px 16px', backgroundColor: creating ? '#1d4ed8' : '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.6 : 1 }}
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
            {actionMsg && (
              <div style={{ fontSize: 11, color: actionMsg.startsWith('✅') ? '#4ade80' : '#f87171', marginTop: 8 }}>{actionMsg}</div>
            )}
          </div>

          {/* 列表 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>
              本地资产列表（{assets.length}）
            </div>
            <button
              onClick={() => { setIncludeDeleted(!includeDeleted); }}
              style={{ fontSize: 10, padding: '2px 8px', backgroundColor: includeDeleted ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: includeDeleted ? '#fbbf24' : 'rgba(255,255,255,0.5)', cursor: 'pointer' }}
            >
              {includeDeleted ? '已显示已删除' : '显示已删除'}
            </button>
          </div>
          {assets.length === 0 ? (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '20px 0' }}>暂无资产，上方创建</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {assets.map((asset) => (
                <div key={asset.localId} style={{ padding: '8px 10px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid rgba(255,255,255,${asset.status === 'Active' ? '0.06' : '0.2'})`, fontSize: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 500 }}>{asset.name}</span>
                    {statusBadge(asset.status)}
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', fontSize: 9, marginBottom: 4, wordBreak: 'break-all' }}>
                    DB: {asset.localId.slice(0, 12)}... | 官方: {asset.providerAssetId}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleGetDetail(asset.localId)}
                      style={{ fontSize: 10, padding: '2px 8px', backgroundColor: 'rgba(37,99,235,0.2)', border: '1px solid rgba(37,99,235,0.4)', borderRadius: 6, color: '#60a5fa', cursor: 'pointer' }}
                    >
                      查详情
                    </button>
                    {editId !== asset.localId ? (
                      <button
                        onClick={() => { setEditId(asset.localId); setEditName(asset.name); }}
                        style={{ fontSize: 10, padding: '2px 8px', backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}
                      >
                        重命名
                      </button>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          style={{ fontSize: 10, padding: '2px 6px', backgroundColor: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: 'white', width: 80 }}
                        />
                        <button onClick={() => handleRename(asset.localId)} style={{ fontSize: 10, padding: '2px 6px', backgroundColor: '#2563eb', border: 'none', borderRadius: 4, color: 'white', cursor: 'pointer' }}>✓</button>
                        <button onClick={() => setEditId(null)} style={{ fontSize: 10, padding: '2px 6px', backgroundColor: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>×</button>
                      </div>
                    )}
                    <button
                      onClick={() => handleRemove(asset.localId)}
                      style={{ fontSize: 10, padding: '2px 8px', backgroundColor: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, color: '#fbbf24', cursor: 'pointer' }}
                    >
                      从列表移除
                    </button>
                    {asset.status !== 'ProviderDeleted' && (
                      <button
                        onClick={() => handleProviderDelete(asset.localId)}
                        style={{ fontSize: 10, padding: '2px 8px', backgroundColor: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#f87171', cursor: 'pointer' }}
                      >
                        彻底删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右侧：详情 */}
        <div style={{ overflowY: 'auto', borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
            官方详情 {detailId ? `#${detailId.slice(0, 8)}` : ''}
          </div>
          {!detail ? (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '40px 0' }}>
              点击「查详情」获取官方同步信息
            </div>
          ) : detail.error ? (
            <div style={{ fontSize: 12, color: '#f87171', padding: 12, backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)' }}>
              官方查询失败：{detail.error}
            </div>
          ) : detail.asset ? (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {detail.providerSyncError && (
                <div style={{ fontSize: 11, color: '#fbbf24', padding: '4px 8px', backgroundColor: 'rgba(245,158,11,0.1)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
                  同步警告：{detail.providerSyncError}
                </div>
              )}
              {[
                ['官方ID', detail.asset.providerAssetId],
                ['名称', detail.asset.name],
                ['类型', detail.asset.assetType],
                ['状态', detail.asset.status],
                ['官方预览', detail.asset.providerPreviewUrl || '(无)'],
                ['用户URL', detail.asset.originalUrl],
                ['创建时间', detail.asset.createdAt],
                ['更新时间', detail.asset.updatedAt],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: 'rgba(255,255,255,0.4)', minWidth: 60 }}>{k}</span>
                  <span style={{ color: 'rgba(255,255,255,0.8)', fontFamily: k.includes('URL') || k === '官方ID' ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{v}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
