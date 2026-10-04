'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';

type Config = { enabled: boolean; ready: boolean; base_url: string; api_key_configured: boolean };
const endpoint = '/api/admin/integrations/banana-image';

export default function BananaImageChannel({ onDirtyChange, onSaveStart, onSaveFinish }: {
  onDirtyChange(dirty: boolean): void; onSaveStart(): boolean; onSaveFinish(saved: boolean): void;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const baseline = useRef('');
  const signature = JSON.stringify(config);
  useEffect(() => { onDirtyChange(Boolean(config && (signature !== baseline.current || apiKey || clearKey))); }, [signature, apiKey, clearKey, config, onDirtyChange]);
  const load = async () => {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || '读取通道失败');
      baseline.current = JSON.stringify(data.config);
      setConfig(data.config); setNotice(null);
    } catch { setNotice({ error: true, text: '读取 Banana 通道失败，请重试' }); }
  };
  useEffect(() => { void load(); }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || saving || !onSaveStart()) return;
    let saved = false;
    setSaving(true); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: config.enabled, base_url: config.base_url, api_key: apiKey, clear_api_key: clearKey }) });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || '保存失败，请重试');
      baseline.current = JSON.stringify(data.config);
      setConfig(data.config); setApiKey(''); setClearKey(false);
      onDirtyChange(false);
      saved = true;
      setNotice({ error: false, text: data.config.ready ? '已保存，新发起的 Banana 请求将使用此通道。' : '已保存，Banana 通道未启用。' });
    } catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : '保存失败，请重试' }); }
    finally { setSaving(false); onSaveFinish(saved); }
  };
  return <form id="banana-image-channel" className="card codex-config-form" onSubmit={save}>
    <div className="codex-config-head">
      <div><h2 className="section-title mb-0">Banana 专用通道</h2><p className="text-gray text-sm mt-2">仅用于 Banana 2 和 Banana Pro；不影响 GPT Image 与 GPT-5.5。</p></div>
      {config && <label className="toggle-switch" aria-label="启用 Banana 专用通道"><input type="checkbox" checked={config.enabled} disabled={saving} onChange={event => setConfig({ ...config, enabled: event.target.checked })} /><span className="toggle-slider" /></label>}
    </div>
    {!config ? <div role="status">{notice ? <button type="button" className="btn btn-secondary" onClick={() => void load()}>重新读取</button> : '正在读取通道设置…'}</div> : <>
      <div className="codex-config-grid">
        <div className="form-group"><label className="form-label" htmlFor="banana-base-url">API 地址</label><input id="banana-base-url" type="url" className="input" required value={config.base_url} disabled={saving} autoComplete="off" onChange={event => setConfig({ ...config, base_url: event.target.value })} /></div>
        <div className="form-group"><label className="form-label" htmlFor="banana-api-key">Banana 专用 API Key</label><input id="banana-api-key" type="password" className="input" value={apiKey} disabled={saving} autoComplete="new-password" placeholder={config.api_key_configured ? '已设置，留空保留原 Key' : '输入这两个模型专用的 Key'} onChange={event => { setApiKey(event.target.value); if (event.target.value.trim()) { setClearKey(false); setConfig({ ...config, enabled: true }); } }} /></div>
      </div>
      <div className="codex-config-status"><div><span className="info-label">API Key</span><strong>{config.api_key_configured ? '已设置' : '未设置'}</strong></div><div><span className="info-label">Banana 2</span><strong>gemini-3.1-flash-image-preview</strong></div><div><span className="info-label">Banana Pro</span><strong>gemini-3-pro-image-preview</strong></div></div>
      <div className="codex-config-actions"><label className="codex-clear-token"><input type="checkbox" checked={clearKey} disabled={saving || !config.api_key_configured || Boolean(apiKey.trim())} onChange={event => setClearKey(event.target.checked)} />清除此通道 Key</label><button type="submit" className="btn btn-primary" disabled={saving}><Save size={16} aria-hidden="true" />{saving ? '正在保存' : '保存 Banana 通道'}</button></div>
    </>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`codex-config-test-result ${notice.error ? 'is-error' : 'is-success'}`}>{notice.text}</p>}
  </form>;
}
