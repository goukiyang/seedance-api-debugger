'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Copy, Dice5, Download, Lock, Unlock, Save, Trash2, RotateCcw, UserRound } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { RelativeTime } from '@/components/RelativeTime';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';
import { catalog, fieldLabels, quickFields } from '@/lib/avatar-random/catalog';
import { emptyRules, type AvatarPlan, type AvatarRecord, type AvatarRules } from '@/lib/avatar-random/types';
import { avatarLayout, avatarOutputCount } from '@/lib/avatar-random/layout';
import type { DescriptionStatus } from '@/lib/avatar-random/description-parser';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS } from '@/lib/image-studio/model-catalog';
import styles from './studio.module.css';
type Task = { id: string; ordinal: number; status: string; error?: string | null; asset: { id: string; original_url: string; thumbnail_url?: string | null } | null };
type Payload = { records: AvatarRecord[]; recentConfigs:AvatarRecord[];recordTasks:Record<string,Task>; nextCursor?: string | null; settings: { model: string; revision: number; prices: Record<string, number | null> } };
const statusLabel: Record<string, string> = { queued: '排队中', running: '生成中', succeeded: '图片已保存，待人工确认', failed: '生成失败', uncertain: '受理未知，请先查询' };
async function api<T>(body?: unknown, query = '') { const response = await fetch(`/api/avatar-studio${query}`, { method: body ? 'POST' : 'GET', cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const data = await readJsonResponse<T & { error?: string; parse?: DescriptionStatus }>(response); if (!response.ok) throw Object.assign(new Error(data.error || '操作未确认'),{status:response.status,parse:data.parse}); return data; }
export default function AvatarStudio({ ownerId, management, ticketId }: { ownerId: string; management?: boolean; ticketId?: string }) {
  const { confirm, prompt: askName, productDialog } = useProductDialog();
  const { refreshCredits } = useAppSession();
  const key = `sd2:avatar-studio:v1:${ownerId}`;
  const [rules, setRules] = useState<AvatarRules>(emptyRules), [plan, setPlan] = useState<AvatarPlan | null>(null), [tasks, setTasks] = useState<Task[]>([]), [records, setRecords] = useState<AvatarRecord[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [model, setModel] = useState(IMAGE_STUDIO_MODELS[0] as string), [quality, setQuality] = useState('auto'), [resolution, setResolution] = useState('1K');
  const [prices, setPrices] = useState<Record<string, number | null>>({}), [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [ready, setReady] = useState(false), [preview, setPreview] = useState(false), [advanced, setAdvanced] = useState(false), [tab, setTab] = useState<'config' | 'character' | 'result'>(management ? 'config' : 'result'), [deleted, setDeleted] = useState(false), [pending, setPending] = useState(false);
  const [recordTasks, setRecordTasks] = useState<Record<string, Task>>({});
  const [parseStatus,setParseStatus]=useState<DescriptionStatus|null>(null),[stage,setStage]=useState(''),[selectedImage,setSelectedImage]=useState(false);
  const [recentConfigs,setRecentConfigs]=useState<AvatarRecord[]>([]),[sourceTask,setSourceTask]=useState<Task|null>(null),[storedSignature,setStoredSignature]=useState('');
  const editing = useRef<AvatarRecord | null>(null), lock = useRef(false), alive = useRef(true);
  const settledTaskPhases = useRef(new Set<string>());
  const planRef=useRef<string|null>(null), filterRef=useRef({tab,deleted}); filterRef.current={tab,deleted};
  const draftSignature=JSON.stringify({rules,planId:plan?.id,index,model,quality,resolution,advanced,tab,deleted});
  usePageExitRisk({ unsaved: ready&&storedSignature===draftSignature ? [] : ['人物工作现场尚未保存'], busy: busy ? ['人物操作处理中'] : [], revision: draftSignature });
  const load = useCallback(async (append = false, nextCursor?: string | null) => { const filter={...filterRef.current};const params=new URLSearchParams({kind:filter.tab,deleted:filter.deleted?'1':'0'});if(nextCursor)params.set('cursor',nextCursor);const data = await api<Payload>(undefined, `?${params}`); if (!alive.current||filterRef.current.tab!==filter.tab||filterRef.current.deleted!==filter.deleted) return; setRecords(old => append ? [...old, ...data.records.filter(r=>!old.some(o=>o.id===r.id))] : data.records);setRecordTasks(old=>append?{...old,...data.recordTasks}:data.recordTasks);setRecentConfigs(data.recentConfigs); setCursor(data.nextCursor || null); setPrices(data.settings.prices); return data; }, []);
  const queryPlan = useCallback(async (id: string) => {
    const data = await api<{ plan: AvatarPlan; tasks: Task[];sourceTask?:Task|null }>(undefined, `?plan=${encodeURIComponent(id)}`);
    if (!alive.current||planRef.current!==id) return data;
    setTasks(data.tasks);setSourceTask(data.sourceTask||null);
    const latestTasks = data.sourceTask ? [...data.tasks, data.sourceTask] : data.tasks;
    setRecordTasks(old => ({ ...old, ...Object.fromEntries(latestTasks.map(task => [task.id, task])) }));
    const settled = data.tasks.filter(task => ['succeeded','failed','uncertain'].includes(task.status)).map(task => `${task.id}:${task.status}`);
    // Refresh once per settlement phase, not on every task poll.
    if (settled.some(phase => !settledTaskPhases.current.has(phase))) {
      settled.forEach(phase => settledTaskPhases.current.add(phase));
      void refreshCredits({ force: true });
    }
    if (data.tasks.length) {setPending(false);try{localStorage.removeItem(`${key}:pending`);}catch{}}
    return data;
  }, [key, refreshCredits]);
  useEffect(() => { alive.current = true; void (async () => { try {
    const data = await load(); if (!alive.current) return;
    let saved: { rules?: AvatarRules; planId?: string; index?: number; model?: string; quality?: string; resolution?: string; advanced?: boolean; deleted?: boolean; tab?: 'config' | 'character' | 'result' } = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* Invalid saved state uses defaults. */ }
    if (saved.rules && typeof saved.rules.description === 'string' && saved.rules.description.length<=3000 && saved.rules.choices && saved.rules.locks && [1,2,3,4].includes(saved.rules.people) && [1,2,4].includes(saved.rules.candidates)) {setRules({...saved.rules,layout:avatarLayout(saved.rules)});if(saved.rules.configId){try{const restored=await api<{record:AvatarRecord}>(undefined,`?record=${encodeURIComponent(saved.rules.configId)}`);if(restored.record.kind==='config'&&restored.record.revision===saved.rules.configRevision)editing.current=restored.record;else setNotice('命名配置已变化，保留本机草稿；请另存规则。');}catch{setNotice('命名配置已不可用，保留本机草稿；请另存规则。');}}}
    setModel(IMAGE_STUDIO_MODELS.includes(saved.model as typeof IMAGE_STUDIO_MODELS[number]) ? saved.model! : data?.settings.model || IMAGE_STUDIO_MODELS[0]);
    setAdvanced(saved.advanced === true); if (!management && ['config','character','result'].includes(saved.tab || '')) setTab(saved.tab!);
    setDeleted(saved.deleted === true);
    if(saved.quality)setQuality(saved.quality);if(saved.resolution)setResolution(saved.resolution);
    const pendingId=localStorage.getItem(`${key}:pending`);
    const resumeId=pendingId||saved.planId;
    if (resumeId && /^[a-zA-Z0-9-]{1,100}$/.test(resumeId)) { planRef.current=resumeId;if(pendingId)setPending(true);try { const recovered = await queryPlan(resumeId); setPlan(recovered.plan); setModel(recovered.plan.model); setQuality(recovered.plan.quality); setResolution(recovered.plan.resolution); setIndex(Math.max(0, Math.min(recovered.plan.candidates.length - 1, Number(saved.index) || 0))); } catch { setNotice('上次人物草稿暂不可读取，未重复提交；已保留可读设置。'); } }
  } catch (e) { setError((e as Error).message); } finally { if (alive.current) setReady(true); } })(); return () => { alive.current = false; }; }, [key, load, management, queryPlan]);
  useEffect(() => { if (!ready) return; try { localStorage.setItem(key, draftSignature);setStoredSignature(draftSignature); } catch { setNotice('本机无法保存工作现场，请勿刷新；本次仍可编辑或另存。'); } }, [key, ready, draftSignature]);
  useEffect(() => { if (!ready) return; const scrollKey=`${key}:scroll:${management?'configs':'studio'}`;let position=0;try{position=Number(localStorage.getItem(scrollKey));}catch{} const frame=requestAnimationFrame(()=>{if(Number.isFinite(position)&&position>0)window.scrollTo(0,position);}); const save=()=>{try{localStorage.setItem(scrollKey,String(window.scrollY));}catch{}};window.addEventListener('scroll',save,{passive:true});return()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',save);}; },[key,management,ready]);
  useEffect(() => { if (!plan || !tasks.some(t => ['queued','running'].includes(t.status))) return; const timer = setInterval(() => void queryPlan(plan.id).catch(e => setError(e.message)), 5000); return () => clearInterval(timer); }, [plan?.id, tasks, queryPlan]);
  useEffect(()=>{if(ready)void load().catch(e=>setError(e.message));},[ready,tab,deleted,load]);
  useEffect(()=>{if(!ready||!rules.description.trim()){setParseStatus(null);return;}let active=true;const timer=setTimeout(()=>void api<{parse:DescriptionStatus}>({action:'parse-status',description:rules.description}).then(data=>{if(active)setParseStatus(data.parse);}).catch(()=>undefined),600);return()=>{active=false;clearTimeout(timer);};},[ready,rules.description]);
  useEffect(()=>{if(!ticketId)return;const receive=(e:MessageEvent)=>{if(e.origin===location.origin&&e.source===window.opener&&e.data?.type==='sd2:avatar-applied'&&e.data.ticketId===ticketId)setNotice('原任务已确认回填，没有启动生成。');};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[ticketId]);
  const sheet=!!plan&&avatarLayout(plan)==='contact-sheet', draftSheet=avatarLayout(rules)==='contact-sheet', layoutChanged=!!plan&&avatarLayout(plan)!==avatarLayout(rules);
  const current = plan?.candidates[index], task = tasks.find(t => t.ordinal === (sheet ? 1 : index + 1))||sourceTask, image = task?.asset;
  const activePrompt=sheet?plan!.sheetPrompt||'':current?.prompt||'';
  const currentRecord = records.find(r => r.taskId === task?.id);
  const blocked = pending || tasks.some(t => t.status === 'uncertain');
  async function run(work: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message);if((e as {parse?:DescriptionStatus}).parse)setParseStatus((e as {parse:DescriptionStatus}).parse); } finally { lock.current = false; setBusy(false);setStage(''); } }
  async function submit(next: AvatarPlan) {
    if(next.unitCredits===null||!next.imageReady){setNotice('当前仅生成描述，图片通道或报价尚未就绪。');return;}
    setStage('等待确认图片费用');
    const count=avatarOutputCount(next);
    if (!(await confirm(`${avatarLayout(next)==='contact-sheet'?'1张真实四宫格，四格不同人物、每格1人':`${count}张独立候选，每张${next.candidates[0].members.length}人`}，每张${next.unitCredits}点，共冻结${count * next.unitCredits}点。仅本次明确的人物要求会用于生成。`, { title: '确认生成', confirmLabel: '生成图片' }))) return;
    localStorage.setItem(`${key}:pending`,next.id);localStorage.setItem(key,JSON.stringify({...JSON.parse(draftSignature),planId:next.id}));planRef.current=next.id;setPending(true);
    setStage('提交图片任务');
    try {
      try { await api({ action: 'submit', id: next.id, layout:avatarLayout(next) }); }
      finally { if (alive.current && planRef.current===next.id) await refreshCredits({ force: true }); }
      setPending(false); await queryPlan(next.id); await load();
    }
    catch (e) { if ((e as {status?:number}).status && (e as {status:number}).status<500) {setPending(false);localStorage.removeItem(`${key}:pending`);} await queryPlan(next.id).catch(() => undefined); throw e; }
  }
  async function prepare(action = 'new', field?: string, reroll = false, retryToken?:string) { await run(async () => {
    let approved=false;
    if (rules.description.trim()) {
      setStage('检查描述解析');
      const {parse}=await api<{parse:DescriptionStatus}>({action:'parse-status',description:rules.description});setParseStatus(parse);
      if(retryToken){
        if(retryToken!==parse.retryToken)throw new Error('解析状态已变化，请查询后再决定是否重试');
        if(!(await confirm('上次解析费用可能已经产生。此次将重新调用一次文字模型，可能再次产生费用；图片生成仍需单独确认。原草稿与已有回复保留。',{title:'重试描述解析',confirmLabel:'确认一次新解析'})))return;
        approved=true;
      } else if(parse.state==='not-started') {
        if(!(await confirm('将使用文字模型解析描述，可能产生模型调用费用。未识别或冲突要求会阻止出图；图片费用稍后单独确认。',{title:'解析人物描述',confirmLabel:'解析并继续'})))return;
        approved=true;
      } else if(parse.state!=='succeeded'&&!parse.canRecheck) throw Object.assign(new Error(parse.message),{parse});
      setStage(parse.state==='succeeded'?'准备图片报价':parse.canRecheck&&!retryToken?'免费重检已有回复':'解析人物描述');
    } else {setParseStatus(null);setStage('准备图片报价');}
    const result = await api<{plan:AvatarPlan}>({ action: 'prepare', rules:reroll&&field?{...rules,choices:{...rules.choices,[field]:''}}:rules, approveTextModel: approved, ...(retryToken?{parseRetryToken:retryToken}:{}), model, quality, resolution, previousId: plan?.id, previousIndex: index, baselineAssetId: sheet?undefined:current?.baselineAssetId || image?.id, actionType: action, ...(field ? { field } : {}) });
    planRef.current=result.plan.id;setPlan(result.plan);setRules(result.plan.candidates[0].rules);setSourceTask(null); setTasks([]); setIndex(0); setPending(false);setParseStatus(null);
    if (action !== 'tweak') await submit(result.plan); else setNotice('仅修改人物草稿，尚未生成图片或扣除图片点数。');
  }); }
  async function saveRules(copy = false) { await run(async () => {
    const active = copy ? null : editing.current;
    const initialName = active?.name || current?.standardDescription.slice(0, 16) || '人物规则';
    await askName('配置名称', initialName, { title: copy ? '另存规则' : '保存规则', confirmLabel: '保存', maxLength: 80, onSubmit: async name => {
      await api({ action: 'save', id: active?.id, revision: active?.revision, name, record: { kind: 'config', rules } }); editing.current = null; await load(); setNotice('随机规则已保存，历史人物与结果未改变。');
    } });
  }); }
  async function mutate(record: AvatarRecord, action: string, extra: Record<string,unknown> = {}) { await api({ action, id: record.id, revision: record.revision, ...extra }); await load(); }
  async function restore(record: AvatarRecord) { await run(async () => {
    if(blocked)throw new Error('原提交尚未确认，请先查询原任务');
    if (record.kind === 'config') { setRules({...record.rules!,layout:avatarLayout(record.rules!),configId:record.id,configRevision:record.revision,choiceSources:Object.fromEntries(Object.keys(record.rules!.choices).map(key=>[key,'config']))}); editing.current = record;planRef.current=null;setPlan(null);setTasks([]);setSourceTask(null); setNotice('已载入配置；修改后选择保存或另存为。'); return; }
    const result = await api<{plan:AvatarPlan;sourceTask?:Task|null}>({ action: 'restore', id: record.id }); setRules({...result.plan.candidates[0].rules,layout:avatarLayout(result.plan)});planRef.current=result.plan.id; setPlan(result.plan);setModel(result.plan.model);setQuality(result.plan.quality);setResolution(result.plan.resolution);setSourceTask(result.sourceTask||null); setIndex(0); setTasks([]); setPending(false); setNotice('已恢复完整人物、条件、锁和历史生成参数；没有新建任务或扣除点数。出图前需更新报价。');
  }); }
  function setChoice(field: string, value: string) { setRules(old => ({ ...old, choices: { ...old.choices, [field]: value },choiceSources:{...old.choiceSources,[field]:'user'},choiceEditedAt:{...old.choiceEditedAt,[field]:Date.now()} })); }
  async function returnImage() { await run(async () => { if (!ticketId || !image) return;if(!window.opener||window.opener.closed)throw new Error('原窗口已关闭，请在原任务的素材库重新选择；图片仍保留。'); const response = await fetch('/api/avatar-studio/handoff', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action:'choose', id:ticketId, assetId:image.id}) }); const data = await readJsonResponse<{error?:string}>(response); if (!response.ok) throw new Error(data.error || '返回未确认'); window.opener.postMessage({ type: 'sd2:avatar-return', ticketId }, location.origin); window.opener.focus(); setNotice('已选择这张，正在等待原任务确认；原图仍保存在我的素材。'); }); }
  const visibleRecords = records.filter(r => r.kind === tab && Boolean(r.deletedAt) === deleted);
  return <main className={styles.page}>
    <header className={styles.heading}><h1>{management ? '人物配置管理' : '人物生成'}</h1><div className={styles.controls}><Link href={management ? '/tools/avatar-studio' : '/tools/avatar-studio/configs'}>{management ? '返回人物生成' : '管理配置'}</Link>{ticketId && <button type="button" onClick={() => window.opener?.focus()}><ArrowLeft size={15}/>返回原任务</button>}<button type="button" disabled={busy||blocked} onClick={() => {planRef.current=null;setSourceTask(null);setRules(emptyRules);setPlan(null);setTasks([]);setIndex(0);editing.current=null;setPending(false);}} title="重置人物草稿"><RotateCcw size={15}/></button></div></header>
    {plan?.warnings?.map((warning,i)=><div role="status" className={styles.notice} key={i}>{warning}</div>)}
    {error && <div role="alert" className={`${styles.notice} ${styles.error}`}>{error}</div>}{notice && <div role="status" className={styles.notice}>{notice}</div>}
    {busy&&stage&&<div role="status" className={styles.notice}>{stage}；当前草稿保留。</div>}
    {parseStatus&&parseStatus.state!=='succeeded'&&parseStatus.state!=='not-started'&&<div className={styles.notice}><p>{parseStatus.message}</p>{parseStatus.failure&&<small>定位：{parseStatus.failure.stage} / {parseStatus.failure.field||parseStatus.failure.code}</small>}<div className={styles.controls}><button type="button" disabled={busy} onClick={()=>void run(async()=>{const data=await api<{parse:DescriptionStatus}>({action:'parse-status',description:rules.description});setParseStatus(data.parse);})}>查询解析状态</button>{parseStatus.canRecheck&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{setStage('免费重检已有回复');const data=await api<{parse:DescriptionStatus}>({action:'parse-recheck',description:rules.description});setParseStatus(data.parse);setNotice('描述重检成功；点击生成继续准备图片报价，没有重新调用文字模型。');})}>免费重检原回复</button>}{parseStatus.retryToken&&<button type="button" disabled={busy||blocked} onClick={()=>void prepare('new',undefined,false,parseStatus.retryToken)}>确认后重新解析一次</button>}</div></div>}
    {layoutChanged&&<div role="status" className={styles.notice}>排版已变，请重新报价；旧图片和四份人物条件保留，不直接按旧计划提交。</div>}
    {(!management || editing.current) && <fieldset className={styles.layout} disabled={busy||!ready}>
      <section className={styles.input} aria-label="人物条件">
        <div className={styles.controls} aria-label="图片排版"><button type="button" aria-pressed={draftSheet} onClick={()=>setRules(r=>({...r,layout:'contact-sheet',people:1,candidates:4}))}>四宫格（1张）</button><button type="button" aria-pressed={!draftSheet} onClick={()=>setRules(r=>({...r,layout:'independent'}))}>独立头像</button></div>
        {!draftSheet&&<div className={styles.controls}><button type="button" aria-pressed={rules.people === 1} onClick={() => setRules(r => ({...r,people:1}))}>单人头像</button><button type="button" aria-pressed={rules.people > 1} onClick={() => setRules(r => ({...r,people:2}))}>多人</button>{rules.people > 1 && <select aria-label="每张图片人数" value={rules.people} onChange={e=>setRules(r=>({...r,people:Number(e.target.value) as 2|3|4}))}>{[2,3,4].map(n=><option key={n} value={n}>{n}人</option>)}</select>}</div>}
        <label>描述你想要的人物（可选）<textarea value={rules.description} maxLength={3000} placeholder="上班族，短发，沉稳，右眉有一道浅疤" onChange={e=>setRules(r=>({...r,description:e.target.value,descriptionEditedAt:Date.now()}))}/></label>
        <div className={styles.quick}>{quickFields.map(field=><label key={field}>{fieldLabels[field]}{field==='age' ? <input type="text" inputMode="numeric" maxLength={5} placeholder="不限 / 25-35" value={rules.choices[field]||''} onChange={e=>setChoice(field,e.target.value)}/> : <select value={rules.choices[field]||''} onChange={e=>setChoice(field,e.target.value)}><option value="">不限</option>{Array.from(new Set(catalog[field])).map(v=><option key={v}>{v}</option>)}</select>}</label>)}</div>
        <details open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>更多选项</summary><div className={styles.input}>{['face_shape','hair_color','skin_tone','temperament','body_type'].map(field=><label key={field}>{fieldLabels[field]}<select value={rules.choices[field]||''} onChange={e=>setChoice(field,e.target.value)}><option value="">不限</option>{Array.from(new Set(catalog[field])).map(v=><option key={v}>{v}</option>)}</select></label>)}<label>随机强度<select value={rules.intensity} onChange={e=>setRules(r=>({...r,intensity:e.target.value as AvatarRules['intensity']}))}><option value="conservative">保守</option><option value="standard">标准</option><option value="bold">大胆</option></select></label></div></details>
        <label>图片模型<select value={model} onChange={e=>{setModel(e.target.value);setQuality('auto');setResolution('1K');}}>{!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])&&<option value={model}>原模型已不可用</option>}{IMAGE_STUDIO_MODELS.map(m=><option key={m} value={m}>{IMAGE_STUDIO_MODEL_LABELS[m]}</option>)}</select></label>
        <div className={styles.quick}><label>质量<select value={quality} onChange={e=>setQuality(e.target.value)}>{(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model as typeof IMAGE_STUDIO_MODELS[number]]||[quality]).map(q=><option key={q}>{q}</option>)}</select></label><label>分辨率<select value={resolution} onChange={e=>setResolution(e.target.value)}>{(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model as typeof IMAGE_STUDIO_MODELS[number]]||[resolution]).map(q=><option key={q}>{q}</option>)}</select></label></div>
        {!draftSheet&&<div className={styles.controls} aria-label="不同候选数量">{[1,2,4].map(n=><button key={n} type="button" aria-pressed={rules.candidates===n} onClick={()=>setRules(r=>({...r,candidates:n as 1|2|4}))}>{n}位候选</button>)}</div>}
        <span className={styles.price}>{prices[model] == null ? '此模型尚未设置价格' : draftSheet?`1张四宫格，共${prices[model]}点；4位不同人物，每格1人，整图1:1`:`${rules.candidates}张，共${prices[model]! * rules.candidates}点；${rules.people}人/张`}</span>
        <button type="button" className={styles.primary} disabled={!ready||busy||blocked||management} onClick={()=>void prepare()}>{busy?stage||'处理中':draftSheet?'生成四宫格':'生成独立头像'}</button>
        {blocked && <button type="button" className={styles.quiet} onClick={()=>void run(async()=>{if(plan)await queryPlan(plan.id);})}>查询原提交，不重复生成</button>}
        <div className={styles.controls}><button type="button" disabled={busy} onClick={()=>void saveRules()}><Save size={15}/>保存规则</button>{editing.current && <button type="button" disabled={busy} onClick={()=>void saveRules(true)}>另存为</button>}</div>
        {!!recentConfigs.length&&<section><small>最近配置</small>{recentConfigs.map(r=><button type="button" className={styles.quiet} key={r.id} onClick={()=>void restore(r)}>{r.name}</button>)}</section>}
      </section>
      <section aria-label="人物结果"><div className={styles.preview}>{image ? <button type="button" aria-label="选择人物图片" aria-pressed={selectedImage} onClick={()=>setSelectedImage(true)}><img src={image.original_url} alt={sheet?'整张四宫格人物图片':'当前人物结果'}/></button> : <div className={styles.placeholder}>{task ? statusLabel[task.status]||'状态待确认' : current ? `${sheet?'四位人物的四宫格草稿\n':''}${current.members[0].fields.age.value}岁 · ${current.members[0].fields.gender.value}\n${current.members[0].fields.face_shape.value} · ${current.members[0].fields.hair_length.value}\n人物草稿，尚未出图` : <><UserRound size={48}/><p>暂无人物图片</p></>}</div>}</div>
        {sheet&&<p className={styles.price}>整张四宫格是一张图片；以下选择只查看对应格的人物条件，不是裁切图片。</p>}
        <div className={styles.thumbnails}>{plan?.candidates.map((c,i)=>{const t=sheet?undefined:tasks.find(t=>t.ordinal===i+1);return <button type="button" className={styles.thumb} key={c.characterId+String(i)} aria-pressed={index===i} aria-label={`查看${sheet?'格':'候选'}${i+1}人物信息`} onClick={()=>{setIndex(i);setSelectedImage(true);}}>{t?.asset?<img src={t.asset.thumbnail_url||t.asset.original_url} alt={`人物${i+1}`}/>:<UserRound size={28}/>}<small>{sheet?['左上','右上','左下','右下'][i]:t ? statusLabel[t.status]?.split('，')[0]||'状态待确认' : `候选${i+1}草稿`}</small></button>;})}</div>
        <div className={styles.controls}>{plan&&plan.candidates.length>1&&<><button type="button" title="上一个" aria-label="上一个" onClick={()=>setIndex(i=>(i+plan.candidates.length-1)%plan.candidates.length)}><ArrowLeft size={16}/></button><button type="button" title="下一个" aria-label="下一个" onClick={()=>setIndex(i=>(i+1)%plan.candidates.length)}><ArrowRight size={16}/></button></>}{image&&<><button type="button" onClick={()=>setPreview(true)}>预览整图</button><a className={styles.quiet} href={`/api/image-studio/download?id=${encodeURIComponent(task!.id)}`}><Download size={15}/>下载</a><ContentReactions contentKey={`asset:${image.id}`} imageSharing={false}/>{!sheet&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await askName('人物名称','我的人物',{title:'保存人物',confirmLabel:'保存',onSubmit:async name=>{await api({action:'save',name,planId:plan!.id,index,record:{kind:'character'}});await load();}});})}><Save size={15}/>保存这个人</button>}</>}
        {current&&<><button type="button" disabled={busy||blocked} onClick={()=>void prepare()}>{draftSheet?'换一组人物':'换一个人'}</button><button type="button" disabled={busy||blocked||sheet||draftSheet||!image&&!current.baselineAssetId} onClick={()=>void prepare('styling')}>换个造型</button>{(!tasks.length||layoutChanged)&&<button type="button" disabled={busy||blocked} onClick={()=>void run(async()=>{setStage('更新图片报价');const data=await api<{plan:AvatarPlan}>({action:'quote',id:plan!.id,model,quality,resolution,layout:avatarLayout(rules)});planRef.current=data.plan.id;setPlan(data.plan);setRules(data.plan.candidates[0].rules);setTasks([]);setSourceTask(null);setIndex(0);await submit(data.plan);})}>重新报价并按原人物出图</button>}</>}
        {ticketId&&image&&<button type="button" className={styles.primary} disabled={busy} onClick={()=>void returnImage()}>使用这张并返回</button>}</div>
        {tasks.some(t=>t.status==='failed')&&!tasks.some(t=>['queued','running','uncertain'].includes(t.status))&&<button type="button" className={styles.quiet} disabled={busy} onClick={()=>void run(async()=>{const data=await api<{plan:AvatarPlan}>({action:'retry',id:plan!.id});planRef.current=data.plan.id;setPlan(data.plan);setSourceTask(null);setTasks([]);setIndex(0);await submit(data.plan);})}>只重试失败项</button>}
        {sheet&&<p className={styles.price}>需保存或调整某一个人，请切到独立头像，按原人物重新报价出图；不会自动裁切或自动生成。</p>}
        {task?.error&&<p className={styles.error}>{task.error}</p>}{tasks.length>0&&<p className={styles.price}>已完成 {tasks.filter(t=>t.status==='succeeded').length}/{plan?avatarOutputCount(plan):0} 张。图片已保存不代表人物要求已符合。</p>}
      </section>
      <aside className={styles.detail} aria-label="当前人物信息"><h2>{sheet?['左上格人物','右上格人物','左下格人物','右下格人物'][index]:'当前人物'}</h2>{current ? <><p>{current.members.map(d=>`${d.fields.gender.value} · ${d.fields.age.value}岁 · ${d.fields.face_shape.value} · ${d.fields.hair_length.value}`).join('；')}</p><small>{sheet?'四宫格保留四份人物条件；整图不能作为某一个人的身份基准。':'保持同人使用原图参考，模型仍可能改变面部；基准图不会自动替换。'}</small>{[...quickFields,'face_shape'].map(field=>{const f=current.members[0].fields[field];return <div key={field} className={styles.field}><span>{fieldLabels[field]}</span><select aria-label={`微调${fieldLabels[field]}`} value={rules.choices[field]||f.value} onChange={e=>setChoice(field,e.target.value)}>{Array.from(new Set([f.value,...catalog[field]])).map(v=><option key={v}>{v}</option>)}</select><button type="button" aria-label={`锁定${fieldLabels[field]}`} title={`锁定${fieldLabels[field]}，${f.source==='user'?'用户指定':f.source==='random'?'随机生成':'继承或推断'}`} aria-pressed={!!rules.locks[field]} onClick={()=>setRules(r=>{const locks={...r.locks};if(locks[field])delete locks[field];else locks[field]={...f,locked:true,manualLock:true};return {...r,locks};})}>{rules.locks[field]?<Lock size={14}/>:<Unlock size={14}/>}</button><button type="button" disabled={busy||sheet||draftSheet||!!rules.locks[field]||f.locked} title={`只重抽${fieldLabels[field]}，不出图`} aria-label={`只重抽${fieldLabels[field]}`} onClick={()=>void prepare('tweak',field,true)}><Dice5 size={15}/></button></div>;})}<div className={styles.controls}>{[...quickFields,'face_shape'].filter(field=>rules.choices[field]&&rules.choices[field]!==current.members[0].fields[field].value).map(field=><button type="button" className={styles.quiet} key={field} disabled={sheet||draftSheet} onClick={()=>void prepare('tweak',field)}>微调{fieldLabels[field]}</button>)}</div><details><summary>完整人物信息</summary>{current.members.map((dna,i)=><div key={dna.seed}><strong>人物 {i+1}</strong><p>明显特征 {dna.details.filter(d=>d.prominence!=='micro').length} / 默认预算 {dna.featureBudget}</p>{Object.entries(dna.fields).map(([key,f])=><p key={key}>{fieldLabels[key]||key}：{f.value} · {f.source==='user'?'用户指定':f.source==='config'?'配置继承':f.source==='inferred'?'范围推断':'随机生成'}{f.locked?' · 已固定':''}</p>)}</div>)}</details><details><summary>人物描述与提示词</summary><div className={styles.prompt}>{activePrompt}</div><button className={styles.quiet} type="button" onClick={()=>void navigator.clipboard.writeText(activePrompt).catch(()=>setError('复制失败，请手动选择文本'))}><Copy size={15}/>复制提示词</button><small>随机规则 {current.members[0].ruleVersion}，图片模型不提供可复现的生图种子。</small></details>{currentRecord&&<label>人物符合度<select value={currentRecord.qualityStatus||'unreviewed'} onChange={e=>void run(()=>mutate(currentRecord,'quality',{record:{qualityStatus:e.target.value}}))}><option value="unreviewed">未人工确认</option><option value="matches">符合要求</option><option value="mismatch">不符合要求</option></select></label>}</> : <small>生成后查看人物信息</small>}</aside>
    </fieldset>}
    <section className={styles.records}><div className={styles.heading}><div className={styles.controls}>{(['config','character','result'] as const).map(t=><button type="button" key={t} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='config'?'随机规则':t==='character'?'保存的人物':'生成历史'}</button>)}</div><label><input type="checkbox" checked={deleted} onChange={e=>setDeleted(e.target.checked)} style={{width:'auto'}}/> 最近删除</label></div>
      {visibleRecords.map(r=>{const t=tasks.find(task=>task.id===r.taskId)||(sourceTask?.id===r.taskId?sourceTask:recordTasks[r.taskId||'']);return <article className={styles.record} key={r.id}>{t?.asset?<img src={t.asset.thumbnail_url||t.asset.original_url} alt={r.name}/>:r.assetId?<img src={`/api/image-studio/assets/${r.assetId}?thumbnail=1`} alt={r.name}/>:<span className={styles.recordCover}><UserRound size={24}/></span>}<div className={styles.recordText}><strong>{r.name}</strong><small><RelativeTime value={r.createdAt}/> · {r.kind==='result'?(t?statusLabel[t.status]:'状态未读取'):r.kind==='config'?`配置第${r.revision}版`:'已保存人物'}</small></div><div className={styles.controls}>{r.deletedAt?<button type="button" disabled={busy} onClick={()=>void run(()=>mutate(r,'undelete'))}>撤销删除</button>:<><button type="button" disabled={busy} onClick={()=>void restore(r)}>{r.kind==='config'?'使用/编辑':'恢复草稿'}</button>{r.kind==='config'&&<><button type="button" onClick={()=>void run(async()=>{await askName('配置名称',r.name,{title:'重命名',onSubmit:async name=>mutate(r,'rename',{name})});})}>重命名</button><button type="button" onClick={()=>void run(async()=>{await api({action:'save',name:`${r.name}副本`,record:{kind:'config',rules:r.rules}});await load();})}>复制</button></>}{r.kind==='result'&&t?.asset&&<ContentReactions contentKey={`asset:${t.asset.id}`} imageSharing={false}/>}<button type="button" disabled={busy} onClick={()=>void run(async()=>{if(await confirm(`删除“${r.name}”？可撤销，不删除已有图片、资产或其他历史。`,{title:'删除记录',confirmLabel:'删除',danger:true}))await mutate(r,'delete');})}><Trash2 size={15}/>删除</button></>}</div></article>;})}
      {!visibleRecords.length&&<p className={styles.empty}>暂无{deleted?'已删除':''}{tab==='config'?'配置':tab==='character'?'人物':'生成历史'}</p>}{cursor&&<button type="button" className={styles.quiet} disabled={busy} onClick={()=>void run(async()=>{await load(true,cursor);})}>加载更多</button>}
    </section>{preview&&image&&<ZoomableImagePreview src={image.original_url} alt="人物结果" fileName="avatar.png" onClose={()=>setPreview(false)}/>} {productDialog}
  </main>;
}
