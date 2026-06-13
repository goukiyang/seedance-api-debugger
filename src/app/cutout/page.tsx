'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import PageBanner from '@/components/PageBanner';

type ModelOption = {
  id: string;
  label: string;
  available?: boolean;
  reason?: string;
};

type CutoutCapabilities = {
  models?: ModelOption[];
  unavailable?: ModelOption[];
  limits?: {
    max_upload_mb?: number;
  };
  success?: boolean;
  error?: string;
  message?: string;
};

type CutoutResult = {
  success?: boolean;
  filename?: string;
  result_url?: string;
  mask_url?: string | null;
  mask_download_url?: string | null;
  result_download_url?: string | null;
  error?: string;
  message?: string;
};

type SplitItem = {
  id: string;
  name?: string;
  filename_trim?: string;
  filename_canvas?: string;
  trim_url?: string | null;
  canvas_url?: string | null;
};

type SplitResult = {
  success?: boolean;
  items?: SplitItem[];
  count?: number;
  contact_sheet_url?: string | null;
  zip_url?: string | null;
  manifest_url?: string | null;
  error?: string;
  message?: string;
};

type CutoutSettings = {
  model_preference: string;
  background_removal: number;
  edge_smooth: number;
  residue_cleanup: number;
};

type Notice = {
  type: 'ok' | 'error' | 'info';
  text: string;
};

const DEFAULT_SETTINGS: CutoutSettings = {
  model_preference: 'auto',
  background_removal: 60,
  edge_smooth: 40,
  residue_cleanup: 55,
};

function normalizeMessage(body: unknown): string {
  if (typeof body === 'string') return compactMessage(body, '请求失败');
  if (!body || typeof body !== 'object') return '请求失败';
  const data = body as Record<string, unknown>;
  if (typeof data.message === 'string') return compactMessage(data.message, '请求失败');
  if (typeof data.detail === 'string') return compactMessage(data.detail, '请求失败');
  if (typeof data.error === 'string') return compactMessage(data.error, '请求失败');
  return '请求失败';
}

function extractHtmlTitle(raw: string): string | null {
  const match = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, ' ').trim() || null;
}

function compactMessage(raw: string, fallback: string) {
  const source = extractHtmlTitle(raw) || raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const text = source.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '';
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function parseJsonBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { message: compactMessage(raw, '服务返回了非 JSON 内容') };
  }
}

export default function CutoutPage() {
  const [loadingCap, setLoadingCap] = useState(false);
  const [capabilityMessage, setCapabilityMessage] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [maxUploadMb, setMaxUploadMb] = useState(15);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [resultUrl, setResultUrl] = useState('');
  const [resultDownloadUrl, setResultDownloadUrl] = useState('');
  const [maskUrl, setMaskUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settings, setSettings] = useState<CutoutSettings>(DEFAULT_SETTINGS);
  const [splitItems, setSplitItems] = useState<SplitItem[]>([]);
  const [contactSheetUrl, setContactSheetUrl] = useState('');
  const [zipUrl, setZipUrl] = useState('');
  const [manifestUrl, setManifestUrl] = useState('');
  const [filename, setFilename] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let isActive = true;
    setLoadingCap(true);
    setCapabilityMessage(null);

    (async () => {
      try {
        const res = await fetch('/api/cutout/capabilities', { cache: 'no-store' });
        const raw = await res.text();
        const body = parseJsonBody(raw);
        const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;

        if (!isActive) return;
        if (!res.ok || (bodyRecord && bodyRecord.success === false)) {
          setCapabilityMessage(normalizeMessage(body));
          return;
        }

        const cap = body as CutoutCapabilities;
        const incoming: ModelOption[] = [
          ...(Array.isArray(cap.models) ? cap.models : []),
          ...(Array.isArray(cap.unavailable) ? cap.unavailable.filter((item) => item.id) : []),
        ];

        const unique: ModelOption[] = [];
        const used = new Set<string>();
        incoming.forEach((item) => {
          const id = item.id?.trim();
          if (!id || used.has(id)) return;
          used.add(id);
          unique.push({
            id,
            label: item.label?.trim() || id,
            available: item.available,
            reason: item.reason,
          });
        });

        setModels(unique);
        if (Number.isFinite(cap?.limits?.max_upload_mb || NaN)) {
          setMaxUploadMb(cap.limits!.max_upload_mb!);
        }
        if (unique.length > 0 && (!settings.model_preference || !unique.some((item) => item.id === settings.model_preference))) {
          const first = unique.find((item) => item.available !== false) || unique[0];
          if (first) {
            setSettings((prev) => ({ ...prev, model_preference: first.id }));
          }
        }
      } catch (error) {
        if (!isActive) return;
        setCapabilityMessage(error instanceof Error ? error.message : '能力查询失败');
      } finally {
        if (isActive) setLoadingCap(false);
      }
    })();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setFilename(file.name);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const maxUploadBytes = useMemo(() => maxUploadMb * 1024 * 1024, [maxUploadMb]);

  const selectedModel = settings.model_preference;

  const supportedModelIds = useMemo(() => {
    return new Set(models.map((model) => model.id));
  }, [models]);

  const setFileFromClipboardOrDrop = (candidate: File | null) => {
    if (!candidate) return;
    if (!candidate.type.startsWith('image/')) {
      setNotice({ type: 'error', text: '只支持图片文件。' });
      return;
    }
    if (candidate.size > maxUploadBytes) {
      setNotice({ type: 'error', text: `文件超过上限，当前限制 ${formatBytes(maxUploadBytes)}。` });
      return;
    }
    setNotice(null);
    setResultUrl('');
    setResultDownloadUrl('');
    setMaskUrl('');
    setSplitItems([]);
    setContactSheetUrl('');
    setZipUrl('');
    setManifestUrl('');
    setFile(candidate);
  };

  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] || null;
    setFileFromClipboardOrDrop(next);
    event.target.value = '';
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const dropped = event.dataTransfer.files?.[0] || null;
    setFileFromClipboardOrDrop(dropped);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const pasted = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/')) || null;
    if (pasted) {
      setFileFromClipboardOrDrop(pasted);
    }
  };

  const onDragOver = (event: React.DragEvent) => event.preventDefault();

  const postFormData = async <T,>(path: string, payload: FormData): Promise<T> => {
    const res = await fetch(path, { method: 'POST', body: payload });
    const raw = await res.text();
    const body = parseJsonBody(raw) as T;
    if (!res.ok) {
      throw new Error(normalizeMessage(body));
    }
    if (!raw && res.status >= 300) throw new Error(`请求失败（${res.status}）`);
    if (typeof body !== 'object' && typeof body !== 'string' && body !== null) {
      throw new Error('返回结果格式异常');
    }
    return body;
  };

  const runCutout = async () => {
    if (!file) {
      setNotice({ type: 'error', text: '请先选择一张图片。' });
      return;
    }

    setBusy(true);
    setNotice({ type: 'info', text: '抠图中，请稍候。' });
    setResultUrl('');
    setResultDownloadUrl('');
    setMaskUrl('');

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('settings', JSON.stringify(settings));
      const result = await postFormData<CutoutResult>('/api/cutout/cutout', form);
      if (!result.success) {
        throw new Error(normalizeMessage(result));
      }
      setResultUrl(result.result_url || '');
      setResultDownloadUrl(result.result_download_url || result.result_url || '');
      setMaskUrl(result.mask_url || result.mask_download_url || '');
      setNotice({ type: 'ok', text: `抠图完成：${result.filename || 'result.png'}` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '抠图失败' });
    } finally {
      setBusy(false);
    }
  };

  const runCharacterSplit = async () => {
    if (!file) {
      setNotice({ type: 'error', text: '请先选择一张图片。' });
      return;
    }

    setSplitBusy(true);
    setNotice({ type: 'info', text: '角色拆图中，请稍候。' });
    setSplitItems([]);

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('settings', JSON.stringify({
        ...settings,
        model_preference: settings.model_preference,
      }));
      const result = await postFormData<SplitResult>('/api/cutout/characters/split-cutout', form);
      if (!result.success) {
        throw new Error(normalizeMessage(result));
      }
      setSplitItems(result.items || []);
      setContactSheetUrl(result.contact_sheet_url || '');
      setZipUrl(result.zip_url || '');
      setManifestUrl(result.manifest_url || '');
      setNotice({
        type: 'ok',
        text: `角色拆图完成：${result.count || result.items?.length || 0} 个角色。`,
      });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '角色拆图失败' });
    } finally {
      setSplitBusy(false);
    }
  };

  const onDownload = (url: string, fallback: string) => {
    const target = url || fallback;
    if (!target) return;
    const link = document.createElement('a');
    link.href = target;
    link.download = `cutout-${Date.now()}.png`;
    link.rel = 'noreferrer';
    link.click();
  };

  const onCopy = async (url: string, fallback: string) => {
    const target = url || fallback;
    if (!target) return;
    try {
      const response = await fetch(target);
      const blob = await response.blob();
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        setNotice({ type: 'ok', text: '图片已复制到剪贴板。' });
        return;
      }
    } catch (error) {
      // fallback to link copy
    }
    await navigator.clipboard.writeText(target);
    setNotice({ type: 'ok', text: '链接已复制到剪贴板。' });
  };

  const onReset = () => {
    setSettings(DEFAULT_SETTINGS);
    setNotice(null);
    setResultUrl('');
    setResultDownloadUrl('');
    setMaskUrl('');
    setSplitItems([]);
    setContactSheetUrl('');
    setZipUrl('');
    setManifestUrl('');
  };

  const triggerUploadInput = () => fileInputRef.current?.click();

  return (
    <div>
      <PageBanner
        eyebrow="抠图工具"
        title="AI 抠图独立工具"
        description="上传或粘贴图片，使用后台 /api/cutout 代理调用官方抠图服务；不直接返回本地 IP 地址。"
      />

      <div className="card">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            输入源
          </h2>
          <button className="btn btn-secondary" type="button" onClick={() => {
            setFile(null);
            setPreviewUrl('');
            setResultUrl('');
            setResultDownloadUrl('');
            setMaskUrl('');
          }}>
            清空
          </button>
        </div>
        <div
          className="cutout-dropzone"
          tabIndex={0}
          role="button"
          onDrop={onDrop}
          onDragOver={onDragOver}
          onPaste={onPaste}
          onClick={triggerUploadInput}
          style={{
            border: '1px dashed #94a3b8',
            borderRadius: 10,
            padding: '24px',
            background: '#f8fafc',
            cursor: 'pointer',
          }}
        >
          <p className="text-gray" style={{ marginBottom: 8 }}>
            点击选择图片，或拖拽 / 粘贴图片（⌘/Ctrl + V）
          </p>
          <p className="text-gray" style={{ fontSize: 12 }}>
            支持 PNG/JPG/WebP，当前限制 {formatBytes(maxUploadBytes)}
            {loadingCap ? '，正在读取能力配置...' : ''}
          </p>
          {capabilityMessage && <p className="text-red">服务状态：{capabilityMessage}</p>}
          {filename && <p>已选：{filename}</p>}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="mt-4"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
      </div>

      <div className="card">
        <h2 className="section-title">参数设置</h2>
        <div className="form-group">
          <label className="form-label">模型</label>
          <select
            className="form-select"
            value={selectedModel}
            onChange={(event) => setSettings((prev) => ({ ...prev, model_preference: event.target.value }))}
          >
            {models.length > 0 ? (
              models.map((model) => {
                const disabled = model.available === false;
                return (
                  <option key={model.id} value={model.id} disabled={disabled}>
                    {model.label || model.id}{disabled ? `（不可用：${model.reason || '服务未就绪'}）` : ''}
                  </option>
                );
              })
            ) : (
              <option value="auto">auto</option>
            )}
          </select>
          {supportedModelIds.size > 0 && !supportedModelIds.has(selectedModel) && (
            <div className="form-hint">当前模型不在可用列表中，已按文本回退。</div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">前景保留: {settings.background_removal}</label>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.background_removal}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSettings((prev) => ({ ...prev, background_removal: next }));
            }}
          />
        </div>

        <div className="form-group">
          <label className="form-label">边缘柔化: {settings.edge_smooth}</label>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.edge_smooth}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSettings((prev) => ({ ...prev, edge_smooth: next }));
            }}
          />
        </div>

        <div className="form-group">
          <label className="form-label">噪点清理: {settings.residue_cleanup}</label>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.residue_cleanup}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSettings((prev) => ({ ...prev, residue_cleanup: next }));
            }}
          />
        </div>

        <div className="flex" style={{ gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" type="button" onClick={onReset}>
            重置
          </button>
          <button className="btn btn-primary" type="button" disabled={busy || !file} onClick={runCutout}>
            {busy ? '处理中…' : '确认抠图'}
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={!file || busy || splitBusy}
            onClick={runCharacterSplit}
          >
            {splitBusy ? '角色识别中…' : '角色拆图'}
          </button>
        </div>
      </div>

      {notice && (
        <div
          className="alert"
          style={{
            backgroundColor:
              notice.type === 'error'
                ? '#fee2e2'
                : notice.type === 'ok'
                  ? '#d1fae5'
                  : '#dbeafe',
            color:
              notice.type === 'error'
                ? '#991b1b'
                : notice.type === 'ok'
                  ? '#065f46'
                  : '#1e3a8a',
            border: '1px solid',
            borderColor:
              notice.type === 'error'
                ? '#fecaca'
                : notice.type === 'ok'
                  ? '#a7f3d0'
                  : '#bfdbfe',
          }}
        >
          {notice.text}
        </div>
      )}

      <div className="card" style={{ display: 'grid', gap: 16 }}>
        <h2 className="section-title">结果预览</h2>
        <div className="shell-link-grid">
          <div className="card" style={{ minHeight: 170 }}>
            <h3 className="section-title" style={{ fontSize: 16, marginBottom: 8 }}>
              原图
            </h3>
            {previewUrl ? <img src={previewUrl} alt="原图预览" style={{ width: '100%', borderRadius: 6 }} /> : <p className="text-gray">未选择图片</p>}
          </div>
          <div className="card" style={{ minHeight: 170 }}>
            <h3 className="section-title" style={{ fontSize: 16, marginBottom: 8 }}>
              抠图结果
            </h3>
            {resultUrl ? (
              <>
                <img src={resultUrl} alt="抠图结果" style={{ width: '100%', borderRadius: 6 }} />
                <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" type="button" onClick={() => onDownload(resultDownloadUrl || resultUrl, resultDownloadUrl || resultUrl)}>
                    下载 PNG
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => onCopy(resultDownloadUrl || resultUrl, resultDownloadUrl || resultUrl)}>
                    复制链接
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => window.open(resultUrl, '_blank')} disabled={!resultUrl}>
                    新窗口查看
                  </button>
                </div>
              </>
            ) : (
              <p className="text-gray">尚未生成</p>
            )}
          </div>
          <div className="card" style={{ minHeight: 170 }}>
            <h3 className="section-title" style={{ fontSize: 16, marginBottom: 8 }}>
              Mask
            </h3>
            {maskUrl ? <img src={maskUrl} alt="掩码图" style={{ width: '100%', borderRadius: 6 }} /> : <p className="text-gray">当前无掩码</p>}
          </div>
        </div>
      </div>

      {(splitItems.length > 0 || contactSheetUrl || zipUrl || manifestUrl) && (
        <div className="card">
          <h2 className="section-title">角色拆图结果</h2>
          <div className="shell-link-grid" style={{ marginBottom: 12 }}>
            {contactSheetUrl && <a className="link" href={contactSheetUrl} target="_blank" rel="noreferrer">查看角色拼图</a>}
            {zipUrl && <a className="link" href={zipUrl} target="_blank" rel="noreferrer">下载 ZIP</a>}
            {manifestUrl && <a className="link" href={manifestUrl} target="_blank" rel="noreferrer">下载清单</a>}
          </div>
          {splitItems.map((item) => (
            <div key={item.id} className="card" style={{ marginBottom: 12 }}>
              <p className="section-title" style={{ marginBottom: 6 }}>
                {item.name || item.id}
              </p>
              <div className="flex" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {item.trim_url && <img src={item.trim_url} alt={item.name || '角色' } style={{ width: 120, borderRadius: 4 }} />}
                {item.canvas_url && <img src={item.canvas_url} alt={item.name || '角色底图' } style={{ width: 120, borderRadius: 4 }} />}
              </div>
              <div className="flex" style={{ gap: 8, marginTop: 8 }}>
                {item.trim_url && <a className="btn btn-secondary" href={item.trim_url} target="_blank" rel="noreferrer">trim</a>}
                {item.canvas_url && <a className="btn btn-secondary" href={item.canvas_url} target="_blank" rel="noreferrer">canvas</a>}
                {item.filename_trim && <span className="text-gray">{item.filename_trim}</span>}
                {item.filename_canvas && <span className="text-gray">{item.filename_canvas}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
