'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { requestJsonWithUploadProgress, type UploadProgressSnapshot } from '@/lib/http/upload-progress';
import type { LocalAssetRecord } from '@/lib/provider/seedance-assets-types';

interface AssetPanelProps {
  visible: boolean;
  onClose: () => void;
}

type AssetUploadProgress = {
  label: string;
  detail: string;
  percent?: number;
};

type UploadAndCreateResponse = {
  error?: string;
  message?: string;
  reused?: boolean;
  closedLoop?: boolean;
  providerAssetId?: string;
  storageProvider?: string;
  publicUrl?: string;
  reason?: string;
  warning?: string;
};

function buildAssetUploadProgress(file: File, progress: UploadProgressSnapshot): AssetUploadProgress {
  return {
    label: progress.label,
    detail: file.name,
    ...(progress.percent != null ? { percent: progress.percent } : {}),
  };
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

  // 本地上传相关
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<AssetUploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      } else if (data.reused === true) {
        // 复用已有资产
        setActionMsg(`🔄 ${data.message}`);
        await loadAssets();
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

  // 本地上传 + 创建 Seedance Asset
  const handleLocalUpload = useCallback(async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadMsg(null);
    setUploadProgress({ label: '准备上传', detail: uploadFile.name });
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      if (uploadName.trim()) formData.append('name', uploadName.trim());
      const result = await requestJsonWithUploadProgress<UploadAndCreateResponse>({
        url: '/api/assets/upload-and-create',
        method: 'POST',
        body: formData,
        invalidJsonMessage: '资产上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。',
        connectionMessage: '资产上传连接中断，系统没有拿到有效上传结果。请重新上传；如果文件较大，请压缩后重试。',
        progress: {
          phase: 'seedance-asset',
          label: '正在上传并创建资产',
        },
        onProgress: (progress) => setUploadProgress(buildAssetUploadProgress(uploadFile, progress)),
      });
      const data = result.data;
      if (!result.ok) {
        setUploadMsg(`❌ ${data.error || data.message || '上传失败'}`);
      } else if (data.reused === true) {
        // 复用已有资产
        setUploadMsg(
          `🔄 ${data.message}\n` +
          `providerAssetId: ${data.providerAssetId}`
        );
        setUploadFile(null);
        setUploadName('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        await loadAssets();
      } else if (data.closedLoop === false) {
        // 公网上传未闭环
        const provider = data.storageProvider || 'local';
        const msgs = [
          `✅ 文件上传成功 (${provider})`,
          `URL: ${(data.publicUrl || '').slice(0, 60)}...`,
        ];
        if (data.reason === 'URL_NOT_PUBLIC') {
          msgs.push('⚠️ 当前 URL 不是公网，Seedance 官方无法访问。');
          msgs.push('请配置公网对象存储（TOS/R2）以完成闭环。');
        } else if (data.reason === 'PROVIDER_CREATE_FAILED') {
          msgs.push(`❌ 官方 create 失败：${data.error}`);
        }
        setUploadMsg(msgs.join('\n'));
        // 半闭环也刷新列表
        await loadAssets();
      } else {
        // 完整闭环（新建）
        setUploadMsg(
          `✅ 上传成功，Seedance Asset 创建成功 (${data.storageProvider || 'local'})\n` +
          `providerAssetId: ${data.providerAssetId}\n` +
          `publicUrl: ${(data.publicUrl || '').slice(0, 60)}...` +
          (data.warning ? `\n⚠️ ${data.warning}` : '')
        );
        setUploadFile(null);
        setUploadName('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        await loadAssets();
      }
    } catch (uploadError) {
      setUploadMsg(`❌ ${uploadError instanceof Error ? uploadError.message : '网络错误'}`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [uploadFile, uploadName, loadAssets]);

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
    <div data-testid="seedance-asset-panel" style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      width: 'calc(100% - 96px)', maxWidth: 900, zIndex: 1000,
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
              placeholder="https://xxx.jpg / xxx.mp4 / xxx.mp3"
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

          {/* 本地上传测试区 */}
          <div style={{ marginBottom: 16, padding: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 10 }}>本地上传图片/视频/音频 → 自动创建资产</div>
            <div style={{ marginBottom: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/ogg"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setUploadFile(f);
                  setUploadProgress(null);
                  if (f && !uploadName) setUploadName(f.name.replace(/\.[^.]+$/, ''));
                }}
                style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}
              />
              {uploadFile && (
                <span style={{ fontSize: 11, color: '#4ade80', marginLeft: 8 }}>
                  已选: {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)}KB)
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="资产名称（默认用文件名）"
                style={{ flex: 1, padding: '7px 10px', backgroundColor: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: 'white', fontSize: 12, outline: 'none' }}
              />
              <button
                onClick={handleLocalUpload}
                disabled={uploading || !uploadFile}
                style={{ padding: '7px 16px', backgroundColor: uploading ? '#1d4ed8' : '#059669', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, cursor: uploading || !uploadFile ? 'not-allowed' : 'pointer', opacity: (uploading || !uploadFile) ? 0.6 : 1 }}
              >
                {uploading ? '上传中...' : '上传并创建'}
              </button>
            </div>
            {uploadProgress && (
              <UploadProgressIndicator
                label={uploadProgress.label}
                detail={uploadProgress.detail}
                percent={uploadProgress.percent}
                variant="dark"
                className="seedance-asset-upload-progress"
              />
            )}
            {uploadMsg && (
              <div style={{ fontSize: 11, color: uploadMsg.startsWith('✅') ? '#4ade80' : uploadMsg.includes('⚠️') ? '#fbbf24' : '#f87171', marginTop: 8, whiteSpace: 'pre-line' }}>{uploadMsg}</div>
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
              {assets.map((asset) => {
                const previewUrl = asset.providerPreviewUrl || asset.originalUrl;

                return (
                <div key={asset.localId} data-testid="seedance-asset-row" style={{ padding: '8px 10px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid rgba(255,255,255,${asset.status === 'Active' ? '0.06' : '0.2'})`, fontSize: 11 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ position: 'relative', flex: '0 0 auto', width: 44, height: 44, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 9, fontFamily: 'monospace' }}>
                      <span>IMG</span>
                      {previewUrl && (
                        <img
                          src={previewUrl}
                          alt={asset.name}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', backgroundColor: 'rgba(255,255,255,0.06)' }}
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                        <span style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
                        {statusBadge(asset.status)}
                      </div>
                      <div style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', fontSize: 9, marginBottom: 4, wordBreak: 'break-all' }}>
                        DB: {asset.localId.slice(0, 12)}... | 官方: {asset.providerAssetId}
                      </div>
                      <div style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', fontSize: 9, marginBottom: 4, wordBreak: 'break-all' }}>
                        官方状态: {asset.providerStatus || '(未同步)'} | 预览: {previewUrl || '(无)'}
                      </div>
                      <div style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', fontSize: 9, marginBottom: 4, wordBreak: 'break-all' }}>
                        原始URL: {asset.originalUrl || '(无)'}
                      </div>
                    </div>
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
                );
              })}
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
                ['本地状态', detail.asset.status],
                ['官方状态', detail.asset.providerStatus || '(无)'],
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
