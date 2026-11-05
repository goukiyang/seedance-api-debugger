'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import PricingPageNav from '@/components/pricing/PricingPageNav';
import { RelativeTime } from '@/components/RelativeTime';
import { useOptionalAppSession } from '@/lib/context/AppSessionContext';
import { pricingGuideMoney, type PricingGuideKind, type PricingGuideSnapshot } from '@/lib/pricing/guide';
import styles from './pricing-guide.module.css';

const kinds = [{ id: 'image', label: '图片' }, { id: 'video', label: '视频' }, { id: 'enhance', label: '超分' }] as const;
const fpsTiers = [{ id: 'lte30', label: '≤30 fps' }, { id: 'gt30', label: '>30 且 ≤60 fps' }, { id: 'gt60', label: '>60 且 ≤120 fps' }] as const;
const isKind = (value: unknown): value is PricingGuideKind => kinds.some(kind => kind.id === value);
const isFpsTier = (value: unknown): value is string => fpsTiers.some(tier => tier.id === value);

export default function PricingGuideClient({ actorId, isAdmin }: { actorId: string; isAdmin: boolean }) {
  const params = useSearchParams();
  const [kind, setKind] = useState<PricingGuideKind>(isKind(params.get('tab')) ? params.get('tab') as PricingGuideKind : 'image');
  const [fpsTier, setFpsTier] = useState('lte30');
  const [preferencesOwner, setPreferencesOwner] = useState<string | null>(null);
  const [result, setResult] = useState<{ owner: string; pricing: PricingGuideSnapshot } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const session = useOptionalAppSession();
  const wrongAccount = Boolean(session?.sessionChanged || session?.hasLoadedUser && session.user?.id !== actorId);
  const pricing = !wrongAccount && result?.owner === actorId ? result.pricing : null;
  const storageKey = `sd2:pricing-guide:${actorId}`;

  useEffect(() => {
    let saved: { kind?: unknown; fpsTier?: unknown } = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { /* Preferences do not affect fee data. */ }
    const tab = params.get('tab'), fps = params.get('fps');
    setKind(isKind(tab) ? tab : isKind(saved.kind) ? saved.kind : 'image');
    setFpsTier(isFpsTier(fps) ? fps : isFpsTier(saved.fpsTier) ? saved.fpsTier : 'lte30');
    setPreferencesOwner(actorId);
  }, [actorId, storageKey, params]);
  useEffect(() => {
    if (preferencesOwner !== actorId) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ kind, fpsTier })); } catch { /* The current view remains usable. */ }
  }, [actorId, kind, fpsTier, preferencesOwner, storageKey]);

  const load = useCallback(async () => {
    if (wrongAccount || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/pricing', { cache: 'no-store', signal: controller.signal, headers: { 'x-app-session-user': actorId } });
      const body = await response.json() as { actorId?: string; pricing?: PricingGuideSnapshot; error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || '暂时无法读取费率，请重试');
      if (body.actorId !== actorId || !body.pricing) throw new Error('账号已变化，请重新打开费率说明');
      setResult({ owner: actorId, pricing: body.pricing });
    } catch (failure) {
      if (!controller.signal.aborted) { setResult(null); setError(failure instanceof Error ? failure.message : '暂时无法读取费率，请重试'); }
    } finally {
      if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setLoading(false); }
    }
  }, [actorId, wrongAccount]);
  useEffect(() => {
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      request.current?.abort(); request.current = null;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const items = pricing?.items.filter(item => item.kind === kind && (kind !== 'enhance' || item.fpsTier === fpsTier)) || [];
  return <div className={styles.page}>
    <PricingPageNav active="guide" isAdmin={isAdmin} />
    <header className={styles.heading}>
      <h1>费率说明</h1>
      {pricing?.updatedAt && <span className={styles.updated}>更新于 <RelativeTime value={pricing.updatedAt} /></span>}
    </header>
    {wrongAccount ? <p className={styles.notice} role="status">账号已变化，请重新打开费率说明。</p> : <>
      <section className={styles.standard} aria-label="点数换算标准">
        <h2>{pricing?.pointsPerCny ? <>1 元 <span>=</span> {pricing.pointsPerCny} 点</> : loading ? '正在读取换算标准' : error ? '换算标准读取失败' : '换算标准待确认'}</h2>
        <p>整笔费用换算后，最后四舍五入到整数点。批量任务分别计算后合计。</p>
      </section>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="费率类型">
          {kinds.map((tab, index) => <button key={tab.id} ref={element => { tabs.current[index] = element; }} type="button"
            role="tab" id={`pricing-tab-${tab.id}`} aria-controls="pricing-guide-panel" aria-selected={kind === tab.id} tabIndex={kind === tab.id ? 0 : -1}
            onClick={() => setKind(tab.id)} onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index + 1) % kinds.length : event.key === 'ArrowLeft' ? (index + kinds.length - 1) % kinds.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); setKind(kinds[next].id); tabs.current[next]?.focus();
            }}>{tab.label}</button>)}
        </div>
        {kind === 'enhance' && <label className={styles.fps}>输出帧率<select aria-label="超分输出帧率" value={fpsTier} onChange={event => setFpsTier(event.target.value)}>
          {fpsTiers.map(tier => <option key={tier.id} value={tier.id}>{tier.label}</option>)}
        </select></label>}
      </div>
      <section id="pricing-guide-panel" role="tabpanel" aria-labelledby={`pricing-tab-${kind}`} tabIndex={0} className={styles.panel} aria-busy={loading}>
        <p className={styles.scope}>{kind === 'image' ? '图片按每张展示。' : kind === 'video'
          ? '普通生成、无参考视频，扣点按 5 秒展示。参考视频、草稿及 IP 生成以任务报价为准。'
          : '超分按每秒单价、5 秒参考扣点展示；实际费用随时长和输出规格变化。'}</p>
        {error ? <div className={styles.notice} role="status"><span>{error}</span><button type="button" onClick={() => void load()}><RefreshCw size={15} />重新读取</button></div>
          : loading && !pricing ? <div className={styles.loading} role="status">正在读取费率…</div>
            : items.length ? <table className={styles.table}>
              <caption className={styles.srOnly}>{kinds.find(tab => tab.id === kind)?.label}当前生效费率</caption>
              <thead><tr><th scope="col">模型与规格</th><th scope="col">参考单价</th><th scope="col">{kind === 'image' ? '每张扣点' : '5 秒参考扣点'}</th></tr></thead>
              <tbody>{items.map(item => <tr key={item.id}>
                <th scope="row"><strong>{item.name}</strong>{item.specification && <span>{item.specification}</span>}</th>
                <td>{item.free ? '免费' : item.baseCny !== null ? <>{pricingGuideMoney(item.baseCny)}<small> / {item.unit === 'image' ? '张' : '秒'}</small></> : <span className={styles.muted}>待确认</span>}</td>
                <td>{item.credits !== null ? <strong className={styles.points}>{item.credits}<small> 点</small></strong> : <span className={styles.quote}>以生成前报价为准</span>}</td>
              </tr>)}</tbody>
            </table> : <p className={styles.empty}>暂无已开放的费率项目。</p>}
      </section>
      <section className={styles.rules} aria-labelledby="pricing-rules-title">
        <h2 id="pricing-rules-title">扣点规则</h2>
        <ul>
          <li><strong>先预留，后结算。</strong>成功后扣点，确认失败后释放预留；结果待确认时继续核对。</li>
          <li><strong>提交前看报价。</strong>具体扣点以本次任务确认的报价和结算记录为准。</li>
          <li><strong>旧任务不重算。</strong>调整费率只影响之后的新任务，已受理任务保留原计价规则。</li>
        </ul>
        <p>费用为当前计价参考，供应商实扣以账单为准。</p>
      </section>
    </>}
  </div>;
}
