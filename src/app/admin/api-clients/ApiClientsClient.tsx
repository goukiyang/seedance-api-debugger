'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, KeyRound, Plus, RefreshCw, Save, ShieldOff, X } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import { RelativeTime } from '@/components/RelativeTime';
import { useProductDialog } from '@/components/useProductDialog';
import styles from './api-clients.module.css';

type Configuration = { enabled: boolean; license_confirmed: boolean; concurrency_limit: number | null; storage_limit_bytes: string | null; max_output_bytes: string | null; revision: number };
type Row = { id: string; name: string; create_enabled: boolean; read_enabled: boolean; balance_points: number; frozen_points: number; daily_points: number | null; monthly_points: number | null; last_used_at: string | null };
type KeyRow = { id: string; name: string; prefix: string; active: boolean; expires_at: string; scopes_json: string; requests_per_minute: number; last_used_at: string | null };
type Rate = { resolution: string; cny_per_second: number | null; enabled: boolean };
type Customer = { id: string; user_id: string; name: string; revision: number; create_enabled: boolean; read_enabled: boolean; license_confirmed: boolean;
  timezone: string; models_json: string; points_per_cny: number | null; max_task_points: number | null; daily_points: number | null; monthly_points: number | null;
  concurrency_limit: number | null; storage_limit_bytes: string | null; upload_limit_bytes: string | null; retention_policy: string | null; rates: Rate[]; keys: KeyRow[]; keys_next_cursor: string | null };
type Usage = { balance_points: number; frozen_points: number; day_used_points: number; month_used_points: number; storage_bytes: string;
  records: Array<{ id: string; request_id: string; reserved_points: number; charged_points: number; fee_status: string; created_at: string }>; next_cursor: string | null };
type Snapshot = { actor_id: string; configuration: Configuration; customers?: Row[]; next_cursor?: string | null; customer?: Customer; usage?: Usage };
type Fields = Record<string, string | boolean>;
type Draft = { revision: number; fields: Fields };
const endpoint = '/api/admin/api-clients', model = 'seedance-2.5-ip', MiB = 1024 * 1024;
const scopeLabels: Record<string, string> = { 'models:read': '查看型号', 'assets:write': '上传素材', 'video:write': '报价与生成', 'video:read': '查询任务', 'content:read': '下载成品', 'usage:read': '查看用量' };
const feeLabels: Record<string, string> = { reserved: '已冻结', charged: '已扣点', refunded: '已退回' };
const value = (v: unknown) => v == null ? '' : String(v);
const mb = (v: string | null) => v == null ? '' : String(Number(v) / MiB);
const toBytes = (v: string | boolean) => v === '' ? null : String(Number(v) * MiB);
function customerFields(c: Customer): Fields {
  const fields: Fields = { name: c.name, create_enabled: c.create_enabled, read_enabled: c.read_enabled, license_confirmed: c.license_confirmed,
    model_enabled: JSON.parse(c.models_json).includes(model), points_per_cny: value(c.points_per_cny), max_task_points: value(c.max_task_points),
    daily_points: value(c.daily_points), monthly_points: value(c.monthly_points), concurrency_limit: value(c.concurrency_limit),
    storage_mb: mb(c.storage_limit_bytes), upload_mb: mb(c.upload_limit_bytes), retention_policy: c.retention_policy || '' };
  for (const resolution of ['480p', '720p', '1080p']) { const rate = c.rates.find(r => r.resolution === resolution); fields[`rate_${resolution}`] = value(rate?.cny_per_second); fields[`enabled_${resolution}`] = rate?.enabled === true; }
  return fields;
}
function globalFields(c: Configuration): Fields { return { enabled: c.enabled, license_confirmed: c.license_confirmed, concurrency_limit: value(c.concurrency_limit), storage_mb: mb(c.storage_limit_bytes), output_mb: mb(c.max_output_bytes) }; }

export default function ApiClientsClient({ actorId }: { actorId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [selected, setSelected] = useState('');
  const [fields, setFields] = useState<Fields>({}), [globalDraft, setGlobalDraft] = useState<Fields>({});
  const [baseRevision, setBaseRevision] = useState(0);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [notice, setNotice] = useState(''), [token, setToken] = useState(''), [newOpen, setNewOpen] = useState(false), [denied, setDenied] = useState(false);
  const [name, setName] = useState(''), [timezone, setTimezone] = useState(''), [keyName, setKeyName] = useState(''), [expires, setExpires] = useState(''), [rpm, setRpm] = useState('');
  const [scopes, setScopes] = useState<string[]>(Object.keys(scopeLabels));
  const alive = useRef(true), readSequence = useRef(0), writeLock = useRef(false);
  const { confirm, productDialog } = useProductDialog();
  const operationStorage = `customer-api-admin:${actorId}:operation`;
  const draftStorage = (id: string) => `customer-api-admin:${actorId}:draft:${id}`;

  const load = useCallback(async (id = '', cursor?: string, append = false, discardDraft = false) => {
    const sequence = ++readSequence.current; setReading(true);
    try {
      const query = new URLSearchParams(); if (id) query.set('id', id); if (cursor) query.set('cursor', cursor);
      const response = await fetch(`${endpoint}?${query}`, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
      const data = await response.json();
      if (!alive.current || sequence !== readSequence.current) return;
      if ([401, 403].includes(response.status) || data.actor_id && data.actor_id !== actorId) { setDenied(true); setToken(''); setSnapshot(null); throw new Error('管理员身份已变化，请重新登录。'); }
      if (!response.ok) throw new Error(data.error || '读取失败，原输入已保留。');
      const next = data as Snapshot;
      setSnapshot(old => append && old ? { ...next, customers: id ? next.customers : [...(old.customers || []), ...(next.customers || [])],
        usage: id && old.usage && next.usage ? { ...next.usage, records: [...old.usage.records, ...next.usage.records] } : next.usage } : next);
      setSelected(id);
      if (!append) {
        let restored: Draft | null = null;
        try { if (!discardDraft) restored = JSON.parse(sessionStorage.getItem(`customer-api-admin:${actorId}:draft:${id}`) || 'null'); } catch { /* A broken local draft never changes saved settings. */ }
        if (!restored?.fields || !Number.isInteger(restored.revision)) restored = null;
        const revision = next.customer?.revision ?? next.configuration.revision;
        setBaseRevision(restored?.revision ?? revision);
        if (restored && restored.revision !== revision) setNotice('设置已被更新，旧草稿仍保留。请读取最新设置后重新编辑。');
        if (next.customer) setFields(restored?.fields || customerFields(next.customer));
        else setGlobalDraft(restored?.fields || globalFields(next.configuration));
      }
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : '读取失败。'); }
    finally { if (alive.current && sequence === readSequence.current) setReading(false); }
  }, [actorId]);

  useEffect(() => {
    alive.current = true;
    try { const saved = JSON.parse(sessionStorage.getItem(operationStorage) || 'null'); if (saved) { setPending(saved); setNotice('有一笔管理操作结果待确认，请先核对原操作。'); } }
    catch { setNotice('本机原操作记录无法读取，请先联系管理员核对。'); setDenied(true); }
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const target = new URL(window.location.href).searchParams.get('customer') || '';
    void load(target);
    return () => { alive.current = false; readSequence.current++; };
  }, [load, operationStorage]);

  function update(key: string, next: string | boolean, global = false) {
    const updated = { ...(global ? globalDraft : fields), [key]: next };
    if (global) setGlobalDraft(updated); else setFields(updated);
    try { sessionStorage.setItem(draftStorage(global ? '' : selected), JSON.stringify({ revision: baseRevision, fields: updated })); }
    catch { setNotice('本机草稿无法保存；当前输入仍在，请不要关闭页面。'); }
  }
  function navigate(id: string) {
    setToken(''); const url = new URL(window.location.href); if (id) url.searchParams.set('customer', id); else url.searchParams.delete('customer');
    window.history.replaceState({}, '', url); void load(id);
  }
  async function loadMoreKeys() {
    const c = snapshot?.customer; if (!c?.keys_next_cursor) return;
    const sequence = readSequence.current; setReading(true);
    try {
      const query = new URLSearchParams({ id: c.id, key_cursor: c.keys_next_cursor });
      const response = await fetch(`${endpoint}?${query}`, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
      const data = await response.json();
      if (!alive.current || sequence !== readSequence.current) return;
      if ([401, 403].includes(response.status) || data.actor_id !== actorId) { setDenied(true); setToken(''); throw new Error('管理员身份已变化，请重新登录。'); }
      if (!response.ok) throw new Error(data.error || '读取 Key 失败。');
      setSnapshot(old => old?.customer?.id === c.id ? { ...old, customer: { ...old.customer,
        keys: [...old.customer.keys, ...data.customer.keys.filter((key: KeyRow) => !old.customer!.keys.some(k => k.id === key.id))], keys_next_cursor: data.customer.keys_next_cursor } } : old);
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : '读取失败。'); }
    finally { if (alive.current && sequence === readSequence.current) setReading(false); }
  }
  async function write(body: Record<string, unknown>, replay = false) {
    if (writeLock.current || denied || pending && !replay) return;
    const operation = replay ? body : { ...body, operation_id: crypto.randomUUID() };
    try { sessionStorage.setItem(operationStorage, JSON.stringify(operation)); }
    catch { setNotice('无法保存原操作号，尚未提交。'); return; }
    writeLock.current = true; setBusy(true); setPending(operation); setNotice('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': actorId }, body: JSON.stringify(operation) });
      const result = await response.json();
      if (!alive.current) return;
      if ([401, 403].includes(response.status)) { setDenied(true); setToken(''); }
      if (!response.ok) {
        if (response.status < 500 && result.code !== 'OPERATION_UNKNOWN') { sessionStorage.removeItem(operationStorage); setPending(null); }
        throw new Error(result.error || '结果未确认，请核对原操作。');
      }
      sessionStorage.removeItem(operationStorage); setPending(null);
      if (result.token) setToken(result.token);
      setNotice(result.issued && !result.token ? '原 Key 已创建，明文不能找回。核对前缀后可吊销并另发。' : '已保存。');
      if (operation.action === 'create') { setNewOpen(false); setName(''); navigate(result.customer_id); }
      else {
        if (['save', 'global'].includes(String(operation.action))) sessionStorage.removeItem(draftStorage(operation.action === 'global' ? '' : String(operation.customer_id)));
        await load(String(operation.customer_id || ''), undefined, false, ['save', 'global'].includes(String(operation.action)));
      }
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : '操作结果尚未确认。'); }
    finally { writeLock.current = false; if (alive.current) setBusy(false); }
  }

  async function saveCustomer(event: FormEvent) {
    event.preventDefault(); const c = snapshot?.customer; if (!c) return;
    let confirmed = false;
    if (fields.create_enabled && !c.create_enabled) {
      confirmed = await confirm(`开通「${fields.name}」的新生成？单笔上限 ${fields.max_task_points || '未设置'} 点，日预算 ${fields.daily_points || '未设置'} 点，月预算 ${fields.monthly_points || '未设置'} 点。仅按下方已启用规格售价收费。`, { title: '确认客户开通', confirmLabel: '确认开通' });
      if (!confirmed) return;
    }
    const { model_enabled, storage_mb, upload_mb, ...rest } = fields;
    for (const resolution of ['480p', '720p', '1080p']) { delete rest[`rate_${resolution}`]; delete rest[`enabled_${resolution}`]; }
    await write({ action: 'save', customer_id: c.id, revision: baseRevision, ...rest, models: model_enabled ? [model] : [],
      storage_limit_bytes: toBytes(storage_mb), upload_limit_bytes: toBytes(upload_mb), confirm_enable: confirmed,
      rates: ['480p', '720p', '1080p'].map(resolution => ({ resolution, cny_per_second: fields[`rate_${resolution}`], enabled: fields[`enabled_${resolution}`] })) });
  }
  async function saveGlobal(event: FormEvent) {
    event.preventDefault(); if (!snapshot) return;
    let confirmed = false;
    if (globalDraft.enabled && !snapshot.configuration.enabled) {
      confirmed = await confirm('启用后，已单独开通并配置完整的客户可提交收费生成。确认已取得供应商许可并预留站内容量？', { title: '开放客户 API', confirmLabel: '确认启用' });
      if (!confirmed) return;
    }
    await write({ action: 'global', revision: baseRevision, enabled: globalDraft.enabled, license_confirmed: globalDraft.license_confirmed,
      concurrency_limit: globalDraft.concurrency_limit, storage_limit_bytes: toBytes(globalDraft.storage_mb), max_output_bytes: toBytes(globalDraft.output_mb), confirm_enable: confirmed });
  }
  const input = (key: string, label: string, global = false, type = 'number', step = '0.1') => <label className={styles.field} key={key}><span>{label}</span><input className="input" type={type} step={step} min={type === 'number' ? 0 : undefined}
    value={String((global ? globalDraft : fields)[key] ?? '')} onChange={e => update(key, e.target.value, global)} placeholder={type === 'number' ? '未设置' : undefined} /></label>;
  const toggle = (key: string, label: string, global = false) => <label className={styles.check} key={key}><input type="checkbox" checked={(global ? globalDraft : fields)[key] === true} onChange={e => update(key, e.target.checked, global)} />{label}</label>;
  const c = snapshot?.customer, usage = snapshot?.usage;
  return <div className={styles.page}>
    {productDialog}
    <PageBanner eyebrow="外部接入" title="客户 API" actions={<Link className="btn btn-secondary" href="/admin/integrations"><ArrowLeft size={16} />API 设置</Link>} />
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {pending && <div className={styles.notice}><span>原操作结果待确认</span><button className="btn btn-secondary" disabled={busy || denied} onClick={() => void write(pending, true)}><RefreshCw size={16} />核对原操作</button></div>}
    {token && <section className={styles.secret} aria-label="新 Key"><div className={styles.toolbar}><strong>新 Key，仅展示这一次</strong><button type="button" className="btn btn-icon" aria-label="关闭 Key" title="关闭 Key" onClick={() => setToken('')}><X size={18} /></button></div>
      <textarea className="input" aria-label="新 Key 明文" readOnly value={token} autoComplete="off" spellCheck={false} />
      <button className="btn btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(token); setNotice('Key 已复制。'); } catch { setNotice('复制失败，请选择明文后复制。'); } }}><Copy size={16} />复制 Key</button>
    </section>}
    {!snapshot && reading && <div className={styles.skeleton} aria-label="正在读取客户" />}
    <fieldset className={styles.work} disabled={busy || Boolean(pending) || denied || reading}>
      {snapshot && baseRevision !== (snapshot.customer?.revision ?? snapshot.configuration.revision) && <button className="btn btn-secondary" onClick={async () => {
        if (await confirm('放弃本机旧草稿并读取最新设置？', { title: '读取最新设置', confirmLabel: '放弃旧草稿并读取' })) {
          sessionStorage.removeItem(draftStorage(selected)); await load(selected, undefined, false, true);
        }
      }}><RefreshCw size={16} />读取最新设置</button>}
      {!selected && snapshot && <>
        <div className={styles.toolbar}><span>{snapshot.configuration.enabled ? '全局已启用' : '全局未开放'}</span><div className={styles.actions}>
          <button type="button" className="btn btn-icon" title="刷新客户" aria-label="刷新客户" onClick={() => void load()}><RefreshCw size={17} /></button>
          <button type="button" className="btn btn-primary" onClick={() => setNewOpen(v => !v)}><Plus size={16} />创建客户接入</button></div></div>
        {newOpen && <form className={styles.inlineForm} onSubmit={e => { e.preventDefault(); void write({ action: 'create', name, timezone }); }}>
          <label className={styles.field}><span>客户名称</span><input className="input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
          <label className={styles.field}><span>固定预算时区</span><input className="input" required value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
          <button className="btn btn-primary" type="submit">创建</button><button className="btn btn-secondary" type="button" onClick={() => setNewOpen(false)}>取消</button>
        </form>}
        <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>客户</th><th>状态</th><th>余额 / 冻结</th><th>日 / 月预算</th><th>最近使用</th></tr></thead><tbody>
          {snapshot.customers?.map(row => <tr key={row.id}><td><button className={styles.name} onClick={() => navigate(row.id)}>{row.name}</button></td><td>{!row.read_enabled ? '访问封禁' : row.create_enabled ? '可新建' : '只读 / 待开通'}</td>
            <td>{row.balance_points} / {row.frozen_points} 点</td><td>{row.daily_points ?? '未设置'} / {row.monthly_points ?? '未设置'}</td><td>{row.last_used_at ? <RelativeTime value={row.last_used_at} /> : '未使用'}</td></tr>)}
        </tbody></table></div>
        {!snapshot.customers?.length && <p className={styles.empty}>尚无客户接入。</p>}
        {snapshot.next_cursor && <button className="btn btn-secondary" onClick={() => void load('', snapshot.next_cursor!, true)}>加载更多客户</button>}
        <details className={styles.section}><summary>全局开放与容量</summary><form onSubmit={saveGlobal}>
          <div className={styles.options}>{toggle('enabled', '允许客户新请求', true)}{toggle('license_confirmed', '供应商转售许可已核实', true)}</div>
          <div className={styles.grid}>{input('concurrency_limit', 'API 总并发', true, 'number', '1')}{input('storage_mb', 'API 总存储上限（MiB）', true, 'number', '1')}{input('output_mb', '单任务成品上限（MiB，最多 200）', true, 'number', '1')}</div>
          <button className="btn btn-primary" type="submit"><Save size={16} />保存全局设置</button>
        </form></details>
      </>}
      {c && usage && <>
        <div className={styles.toolbar}><button className="btn btn-secondary" onClick={() => navigate('')}><ArrowLeft size={16} />客户列表</button><h2>{c.name}</h2><Link className="btn btn-secondary" href={`/admin/users?owner_user_id=${encodeURIComponent(c.user_id)}`}>账户与点数</Link></div>
        <div className={styles.summary}><span>余额 {usage.balance_points} 点</span><span>冻结 {usage.frozen_points} 点</span><span>今日占用 {usage.day_used_points} 点</span><span>本月占用 {usage.month_used_points} 点</span><span>媒体 {(Number(usage.storage_bytes) / MiB).toFixed(1)} MiB</span></div>
        <form className={styles.section} onSubmit={saveCustomer}>
          <div className={styles.grid}>{input('name', '客户名称', false, 'text')}{input('points_per_cny', '点 / 元')}{input('max_task_points', '单笔上限（点）')}</div>
          <div className={styles.options}>{toggle('create_enabled', '允许新生成')}{toggle('read_enabled', '允许访问已有结果')}{toggle('license_confirmed', '客户素材与使用许可已核实')}</div>
          <h3>型号与客户售价</h3>{toggle('model_enabled', 'Seedance 2.5 · IP 线路')}
          <div className={styles.rates}>{['480p', '720p', '1080p'].map(resolution => <div key={resolution}>{toggle(`enabled_${resolution}`, resolution)}{input(`rate_${resolution}`, '人民币 / 秒', false, 'number', '0.00000001')}</div>)}</div>
          <h3>预算与容量</h3><p className={styles.muted}>固定预算时区：{c.timezone}</p>
          <div className={styles.grid}>{input('daily_points', '日预算（点）')}{input('monthly_points', '月预算（点）')}{input('concurrency_limit', '客户总并发', false, 'number', '1')}
            {input('storage_mb', '客户存储上限（MiB）', false, 'number', '1')}{input('upload_mb', '单文件上传上限（MiB）', false, 'number', '1')}</div>
          <label className={styles.field}><span>媒体保留规则</span><textarea className="input" value={String(fields.retention_policy || '')} maxLength={1000} onChange={e => update('retention_policy', e.target.value)} /></label>
          <div className={styles.toolbar}><button className="btn btn-primary" type="submit"><Save size={16} />保存客户设置</button><button type="button" className="btn btn-secondary" onClick={() => void load(c.id)}>重新读取，保留输入</button></div>
        </form>
        <section className={styles.section}><h3>Key</h3><details><summary>发放新 Key / 轮换</summary><form className={styles.keyForm} onSubmit={e => {
          e.preventDefault(); const date = new Date(expires); if (!Number.isFinite(date.getTime())) { setNotice('请选择有效截止时间。'); return; }
          void write({ action: 'issue_key', customer_id: c.id, revision: c.revision, name: keyName, expires_at: date.toISOString(), requests_per_minute: rpm, scopes, models: [model] });
        }}><div className={styles.grid}><label className={styles.field}><span>Key 名称</span><input className="input" required value={keyName} onChange={e => setKeyName(e.target.value)} /></label>
          <label className={styles.field}><span>有效期至</span><input className="input" type="datetime-local" required value={expires} onChange={e => setExpires(e.target.value)} /></label>
          <label className={styles.field}><span>每分钟请求数</span><input className="input" type="number" min={1} max={10000} step={1} required value={rpm} onChange={e => setRpm(e.target.value)} /></label></div>
          <div className={styles.options}>{Object.entries(scopeLabels).map(([scope, label]) => <label className={styles.check} key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e => setScopes(old => e.target.checked ? [...old, scope] : old.filter(v => v !== scope))} />{label}</label>)}</div>
          <p className={styles.muted}>型号：Seedance 2.5 · IP。轮换先发新 Key，客户切换后再吊销旧 Key。</p><button className="btn btn-primary" type="submit"><KeyRound size={16} />发放 Key</button>
        </form></details>
          <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>名称 / 前缀</th><th>状态</th><th>有效期至</th><th>范围</th><th>最近使用</th><th /></tr></thead><tbody>{c.keys.map(key => <tr key={key.id}>
            <td>{key.name}<br /><code>{key.prefix}…</code></td><td>{!key.active ? '已吊销' : new Date(key.expires_at).getTime() <= Date.now() ? '已过期' : '有效'}</td><td>{new Date(key.expires_at).toLocaleString()}</td>
            <td>{(JSON.parse(key.scopes_json) as string[]).map(s => scopeLabels[s] || s).join('、')}<br />{key.requests_per_minute} 次/分钟</td><td>{key.last_used_at ? <RelativeTime value={key.last_used_at} /> : '未使用'}</td>
            <td>{key.active && <button type="button" className="btn btn-icon" title="吊销 Key" aria-label={`吊销 ${key.name}`} onClick={async () => {
              if (await confirm(`吊销「${key.name}」后，后续访问立即失效；已受理任务仍继续生成和计费，同客户其他有效 Key 可查询。`, { title: '吊销 Key', confirmLabel: '吊销', danger: true })) void write({ action: 'revoke_key', customer_id: c.id, revision: c.revision, key_id: key.id, confirm_revoke: true });
            }}><ShieldOff size={17} /></button>}</td></tr>)}</tbody></table></div>
          {!c.keys.length && <p className={styles.empty}>尚未发放 Key。</p>}
          {c.keys_next_cursor && <button type="button" className="btn btn-secondary" onClick={() => void loadMoreKeys()}>加载更多 Key</button>}
        </section>
        <section className={styles.section}><h3>用量记录</h3><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>原请求号</th><th>费用状态</th><th>预留 / 已扣（点）</th><th>创建时间</th></tr></thead><tbody>
          {usage.records.map(record => <tr key={record.id}><td><code>{record.request_id}</code></td><td>{feeLabels[record.fee_status]}</td><td>{record.reserved_points} / {record.charged_points}</td><td><RelativeTime value={record.created_at} /></td></tr>)}
        </tbody></table></div>{!usage.records.length && <p className={styles.empty}>暂无生成记录。</p>}
          {usage.next_cursor && <button className="btn btn-secondary" onClick={() => void load(c.id, usage.next_cursor!, true)}>加载更多记录</button>}
        </section>
      </>}
    </fieldset>
  </div>;
}
