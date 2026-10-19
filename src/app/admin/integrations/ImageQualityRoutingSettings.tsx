'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Pencil, RefreshCw, Save } from 'lucide-react';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import type { ImageGenerationDefaultRoutesDto } from '@/lib/integrations/image-generation-defaults';
import type { ImageGenerationManagedChannelDto, ImageGenerationModelCapabilityDto } from '@/lib/integrations/image-generation-channel';
import { IMAGE_25_QUALITY_MODEL, IMAGE_25_QUALITIES, type Image25Quality } from '@/lib/image-studio/quality-routing';

type Provider = ImageGenerationManagedChannelDto & { price: ImageGenerationModelCapabilityDto | null };
type Data = { routes: ImageGenerationDefaultRoutesDto; providers: Provider[]; writesEnabled: boolean };
type Draft = { channelId: string; edit: boolean; baseUrl: string; apiKey: string; maxReferences: string; resolutions: string[] };
const endpoint = '/api/admin/integrations/image-generation';
const label = (quality: Image25Quality) => quality === 'medium' ? '中等' : '最高';

export default function ImageQualityRoutingSettings({ accountId }: { accountId: string | null }) {
  const [data, setData] = useState<Data | null>(null), [drafts, setDrafts] = useState<Partial<Record<Image25Quality, Draft>>>({});
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<string | null>(null);
  const epoch = useRef(0), sequence = useRef(0), lock = useRef(false), account = useRef(accountId); account.current = accountId;
  const storageKey = `sd2:image-quality-operation:${accountId}`;
  usePageExitRisk({ unsaved: [], busy: busy || pending ? ['图片质量配置保存结果待确认'] : [], revision: pending || '' });
  async function read() {
    const generation = epoch.current, seq = ++sequence.current, owner = account.current;
    const response = await fetch(`${endpoint}?view=quality-routes`, { cache: 'no-store' });
    const result = await response.json();
    if (generation !== epoch.current || seq !== sequence.current || owner !== account.current) return;
    if (!response.ok || !result.ok || !Array.isArray(result.providers) || !Number.isSafeInteger(result.routes?.revision)) throw new Error(result.error || '读取质量 API 失败，原输入仍保留');
    setData(result);
  }
  useEffect(() => {
    epoch.current++; setData(null); setDrafts({}); setMessage(''); setBusy(false); lock.current = false; setPending(null);
    const generation = epoch.current;
    if (accountId) {
      try { const id = localStorage.getItem(storageKey); if (id && /^[A-Za-z0-9_-]{1,120}$/.test(id)) setPending(id); } catch {}
      void read().catch(error => { if (epoch.current === generation) setMessage(error.message); });
    }
    return () => { epoch.current = generation + 1; };
  }, [accountId, storageKey]);
  const draftFor = (quality: Image25Quality): Draft => {
    if (drafts[quality]) return drafts[quality]!;
    const id = data?.routes.qualityRoutes?.[IMAGE_25_QUALITY_MODEL]?.[quality] || '';
    const provider = data?.providers.find(item => item.id === id), model = provider?.models[IMAGE_25_QUALITY_MODEL];
    return { channelId: id, edit: false, baseUrl: model?.baseUrl || provider?.baseUrl || '', apiKey: '',
      maxReferences: String(model?.maxReferences ?? ''), resolutions: model?.resolutions || [] };
  };
  function change(quality: Image25Quality, patch: Partial<Draft>) {
    setDrafts(current => ({ ...current, [quality]: { ...draftFor(quality), ...patch } }));
  }
  async function query() {
    if (!pending || lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true);
    try {
      const response = await fetch(`${endpoint}?quality_operation_id=${encodeURIComponent(pending)}`, { cache: 'no-store' });
      const result = await response.json();
      if (generation !== epoch.current) return;
      if (!response.ok || !result.ok || result.receipt?.operationId !== pending || result.receipt.state !== 'succeeded') throw new Error(result.error || '原保存尚未确认，请稍后继续查询；不会重复保存');
      localStorage.removeItem(storageKey); setPending(null); setDrafts({}); setMessage('已保存，仅影响之后的新请求。'); await read();
    } catch (error) { if (generation === epoch.current) setMessage(error instanceof Error ? error.message : '原保存尚未确认'); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  }
  async function save(quality: Image25Quality) {
    if (!data || !accountId || lock.current || pending || !data.writesEnabled) return;
    const draft = draftFor(quality), provider = data.providers.find(item => item.id === draft.channelId);
    if (!provider?.configRevision) return;
    const operationId = crypto.randomUUID(), generation = epoch.current;
    const body = { channel_action: 'save-quality-route', operationId, quality, channelId: draft.channelId,
      expectedRevision: data.routes.revision, expectedConfigRevision: provider.configRevision,
      ...(draft.edit ? { api: { baseUrl: draft.baseUrl, apiKey: draft.apiKey,
        maxReferences: Number(draft.maxReferences), resolutions: draft.resolutions } } : {}) };
    lock.current = true; setBusy(true); setMessage('');
    try { localStorage.setItem(storageKey, operationId); } catch {}
    let knownRejected = false;
    try {
      const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (generation !== epoch.current) return;
      knownRejected = !response.ok && response.status < 500;
      if (!response.ok || result.receipt?.operationId !== operationId || result.receipt?.state !== 'succeeded') throw new Error(result.error || '保存结果待确认，请查询原操作');
      try { localStorage.removeItem(storageKey); } catch {}
      setDrafts(current => { const next = { ...current }; delete next[quality]; return next; });
      setMessage('已保存。API 或费率未就绪时该档不能生成，已受理任务保持原配置。'); await read();
    } catch (error) {
      if (generation === epoch.current) {
        if (knownRejected) { try { localStorage.removeItem(storageKey); } catch {} }
        else setPending(operationId);
        setMessage(error instanceof Error ? error.message : '保存结果待确认，输入已保留');
      }
    } finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  }
  return <section aria-labelledby="image-quality-routing-title" style={{ padding: '24px 0', borderTop: '1px solid var(--border-color)', minWidth: 0 }}>
    <h2 id="image-quality-routing-title" className="section-title">Image 2.5 质量路由</h2>
    <p className="text-gray text-sm">Sunburst · 两档分别设置 API，仅影响新请求。费用在 <Link href="/admin/pricing">点数与费率</Link> 调整。</p>
    <button type="button" title="重新读取质量API" aria-label="重新读取质量API" disabled={busy || Boolean(pending)} onClick={() => void read().catch(error => setMessage(error.message))}><RefreshCw size={16} /></button>
    {!data && <p className="text-gray text-sm">正在读取质量 API</p>}
    {data && IMAGE_25_QUALITIES.map(quality => {
      const draft = draftFor(quality), provider = data.providers.find(item => item.id === draft.channelId), model = provider?.models[IMAGE_25_QUALITY_MODEL];
      return <fieldset key={quality} disabled={busy || Boolean(pending) || !data.writesEnabled} style={{ border: 0, borderBottom: '1px solid var(--border-color)', padding: '16px 0', minWidth: 0 }}>
        <legend><strong>{label(quality)}</strong></legend>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <select aria-label={`${label(quality)}API`} className="input" style={{ maxWidth: 360 }} value={draft.channelId} onChange={event => {
            const next = data.providers.find(item => item.id === event.target.value), capability = next?.models[IMAGE_25_QUALITY_MODEL];
            change(quality, { channelId: event.target.value, edit: false, baseUrl: capability?.baseUrl || next?.baseUrl || '', apiKey: '',
              maxReferences: String(capability?.maxReferences ?? ''), resolutions: capability?.resolutions || [] });
          }}><option value="">尚未配置</option>{data.providers.map(item => <option key={item.id} value={item.id} disabled={item.deleted}>{item.label}{!item.enabled ? '（停用）' : ''}</option>)}</select>
          <span className="text-sm">{provider?.price?.ready ? provider.price.fixedPoints == null ? '按规格报价' : `${provider.price.fixedPoints}点/张` : provider?.price?.disabledReason || 'API或费率未就绪'}</span>
          {provider && <Link href={`/admin/pricing?channelId=${encodeURIComponent(provider.id)}`}>调整费率</Link>}
          <button type="button" title={`编辑${label(quality)}API`} aria-label={`编辑${label(quality)}API`} disabled={!provider} onClick={() => change(quality, { edit: !draft.edit })}><Pencil size={16} /></button>
          <button type="button" title={`保存${label(quality)}设置`} aria-label={`保存${label(quality)}设置`} disabled={!provider} onClick={() => void save(quality)}><Save size={16} /></button>
        </div>
        {draft.edit && <div style={{ display: 'grid', gap: 12, marginTop: 12, maxWidth: 600 }}>
          <label>API 地址<input className="input" type="url" value={draft.baseUrl} onChange={event => change(quality, { baseUrl: event.target.value })} /></label>
          <label>API Key<input className="input" type="password" autoComplete="new-password" value={draft.apiKey} placeholder={model?.apiKeyConfigured ? '已设置，留空保留' : '尚未设置'} onChange={event => change(quality, { apiKey: event.target.value })} /></label>
          <label>参考图总上限<input className="input" type="number" min={0} max={quality === 'medium' ? 7 : 32} value={draft.maxReferences} onChange={event => change(quality, { maxReferences: event.target.value })} /></label>
          <div style={{ display: 'flex', gap: 16 }}>{['1K', '2K', '4K'].map(resolution => <label key={resolution}><input type="checkbox" checked={draft.resolutions.includes(resolution)} onChange={event => change(quality, { resolutions: event.target.checked ? [...draft.resolutions, resolution] : draft.resolutions.filter(value => value !== resolution) })} />{resolution}</label>)}</div>
          <p className="text-gray text-sm">请求质量：{quality} · 型号：{IMAGE_25_QUALITY_MODEL} · {model?.protocol || '协议待配置'}</p>
        </div>}
      </fieldset>;
    })}
    {pending && <button type="button" disabled={busy} onClick={() => void query()}>查询原保存</button>}
    {message && <p role="status" className="text-gray text-sm">{message}</p>}
  </section>;
}
