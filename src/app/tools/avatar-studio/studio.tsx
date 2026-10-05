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
import { AVATAR_PARSER_VERSION, emptyRules, type AvatarPlan, type AvatarRecord, type AvatarRules } from '@/lib/avatar-random/types';
import { avatarRulesSignature, effectiveConditions } from '@/lib/avatar-random/intent';
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
  const [parseBinding,setParseBinding]=useState('');
  const analysisBinding=JSON.stringify([ownerId,rules.description.trim(),rules.descriptionEditedAt||0,AVATAR_PARSER_VERSION]);
  const inputSignature=JSON.stringify([ownerId,rules,model,quality,resolution,plan?.id,index,ready]);
  const liveDraft=useRef({ownerId,rules,model,quality,resolution,analysisBinding,inputSignature,revision:0,ownerRevision:0,prices,blocked:pending||tasks.some(t=>t.status==='uncertain'),ready});
  liveDraft.current={ownerId,rules,model,quality,resolution,analysisBinding,inputSignature,revision:liveDraft.current.revision+(liveDraft.current.inputSignature===inputSignature?0:1),ownerRevision:liveDraft.current.ownerRevision+(liveDraft.current.ownerId===ownerId?0:1),prices,blocked:pending||tasks.some(t=>t.status==='uncertain'),ready};
  type DraftSnapshot = typeof liveDraft.current;
  const activeParse=parseBinding===analysisBinding?parseStatus:null;
  const needsAnalysis=!!rules.description.trim()&&activeParse?.state!=='succeeded';
  const [recentConfigs,setRecentConfigs]=useState<AvatarRecord[]>([]),[sourceTask,setSourceTask]=useState<Task|null>(null),[storedSignature,setStoredSignature]=useState('');
  const [previousImageTask,setPreviousImageTask]=useState<Task|null>(null);
  const [runningPlans,setRunningPlans]=useState<string[]>([]);
  const editing = useRef<AvatarRecord | null>(null), lock = useRef(false), alive = useRef(true);
  const initializedOwner=useRef<string|null>(null);
  const settledTaskPhases = useRef(new Set<string>());
  const querySequences = useRef(new Map<string, number>());
  const planRef=useRef<string|null>(null), filterRef=useRef({tab,deleted}); filterRef.current={tab,deleted};
  const draftSignature=JSON.stringify({rules,planId:plan?.id,index,model,quality,resolution,advanced,tab,deleted,previousImageTaskId:previousImageTask?.id,runningPlans});
  usePageExitRisk({ unsaved: ready&&storedSignature===draftSignature ? [] : ['人物工作现场尚未保存'], busy: busy ? ['人物操作处理中'] : [], revision: draftSignature });
  const load = useCallback(async (append = false, nextCursor?: string | null) => { const owner=liveDraft.current.ownerId,filter={...filterRef.current};const params=new URLSearchParams({kind:filter.tab,deleted:filter.deleted?'1':'0'});if(nextCursor)params.set('cursor',nextCursor);const data = await api<Payload>(undefined, `?${params}`); if (!alive.current||owner!==liveDraft.current.ownerId||filterRef.current.tab!==filter.tab||filterRef.current.deleted!==filter.deleted) return; setRecords(old => append ? [...old, ...data.records.filter(r=>!old.some(o=>o.id===r.id))] : data.records);setRecordTasks(old=>append?{...old,...data.recordTasks}:data.recordTasks);setRecentConfigs(data.recentConfigs); setCursor(data.nextCursor || null); setPrices(data.settings.prices); return data; }, []);
  const queryPlan = useCallback(async (id: string) => {
    const owner=liveDraft.current.ownerId;
    const sequence = (querySequences.current.get(id) || 0) + 1;
    querySequences.current.set(id, sequence);
    const data = await api<{ plan: AvatarPlan; tasks: Task[];sourceTask?:Task|null }>(undefined, `?plan=${encodeURIComponent(id)}`);
    if (!alive.current||owner!==liveDraft.current.ownerId||planRef.current!==id||querySequences.current.get(id)!==sequence) return data;
    setPlan(old => old?.id===id ? old : data.plan);
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
  useEffect(() => { let active=true;alive.current = true;initializedOwner.current=null;setReady(false);setRules(emptyRules);setPlan(null);planRef.current=null;setTasks([]);setSourceTask(null);setPreviousImageTask(null);setRunningPlans([]);setRecords([]);setRecordTasks({});setParseStatus(null);setParseBinding('');editing.current=null;setPending(false);querySequences.current.clear();settledTaskPhases.current.clear();void (async () => { try {
    const data = await load(); if (!active) return;
    let saved: { rules?: AvatarRules; planId?: string; index?: number; model?: string; quality?: string; resolution?: string; advanced?: boolean; deleted?: boolean; tab?: 'config' | 'character' | 'result'; previousImageTaskId?:string; runningPlans?:string[] } = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* Invalid saved state uses defaults. */ }
    if (saved.rules && typeof saved.rules.description === 'string' && saved.rules.description.length<=3000 && saved.rules.choices && saved.rules.locks && [1,2,3,4].includes(saved.rules.people) && [1,2,4].includes(saved.rules.candidates)) {setRules({...saved.rules,layout:avatarLayout(saved.rules)});if(saved.rules.configId){try{const restored=await api<{record:AvatarRecord}>(undefined,`?record=${encodeURIComponent(saved.rules.configId)}`);if(restored.record.kind==='config'&&restored.record.revision===saved.rules.configRevision)editing.current=restored.record;else setNotice('命名配置已变化，保留本机草稿；请另存规则。');}catch{setNotice('命名配置已不可用，保留本机草稿；请另存规则。');}}}
    setModel(IMAGE_STUDIO_MODELS.includes(saved.model as typeof IMAGE_STUDIO_MODELS[number]) ? saved.model! : data?.settings.model || IMAGE_STUDIO_MODELS[0]);
    setAdvanced(saved.advanced === true); if (!management && ['config','character','result'].includes(saved.tab || '')) setTab(saved.tab!);
    setDeleted(saved.deleted === true);
    if(saved.quality)setQuality(saved.quality);if(saved.resolution)setResolution(saved.resolution);
    if(Array.isArray(saved.runningPlans))setRunningPlans(saved.runningPlans.filter(id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(id)));
    if(typeof saved.previousImageTaskId==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(saved.previousImageTaskId)){try{const previous=await api<{sourceTask:Task|null}>(undefined,`?imageTask=${encodeURIComponent(saved.previousImageTaskId)}`);if(active)setPreviousImageTask(previous.sourceTask?.asset?previous.sourceTask:null);}catch{}}
    if(!active)return;
    const pendingId=localStorage.getItem(`${key}:pending`);
    const resumeId=pendingId||saved.planId;
    if (resumeId && /^[a-zA-Z0-9-]{1,100}$/.test(resumeId)) { planRef.current=resumeId;if(pendingId)setPending(true);try { const recovered = await queryPlan(resumeId);if(!active)return;setPlan(recovered.plan);if(!saved.model)setModel(recovered.plan.model);if(!saved.quality)setQuality(recovered.plan.quality);if(!saved.resolution)setResolution(recovered.plan.resolution); setIndex(Math.max(0, Math.min(recovered.plan.candidates.length - 1, Number(saved.index) || 0))); } catch { if(active)setNotice('上次人物草稿暂不可读取，未重复提交；已保留可读设置。'); } }
  } catch (e) { if(active)setError((e as Error).message); } finally { if (active) {initializedOwner.current=ownerId;setReady(true);} } })(); return () => { active=false;alive.current = false; }; }, [key, ownerId, load, management, queryPlan]);
  useEffect(() => { if (!ready||initializedOwner.current!==ownerId) return; try { localStorage.setItem(key, draftSignature);setStoredSignature(draftSignature); } catch { setNotice('本机无法保存工作现场，请勿刷新；本次仍可编辑或另存。'); } }, [key, ownerId, ready, draftSignature]);
  useEffect(() => { if (!ready) return; const scrollKey=`${key}:scroll:${management?'configs':'studio'}`;let position=0;try{position=Number(localStorage.getItem(scrollKey));}catch{} const frame=requestAnimationFrame(()=>{if(Number.isFinite(position)&&position>0)window.scrollTo(0,position);}); const save=()=>{try{localStorage.setItem(scrollKey,String(window.scrollY));}catch{}};window.addEventListener('scroll',save,{passive:true});return()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',save);}; },[key,management,ready]);
  useEffect(() => { if (!plan || !tasks.some(t => ['queued','running'].includes(t.status))) return; const timer = setInterval(() => void queryPlan(plan.id).catch(e => setError(e.message)), 5000); return () => clearInterval(timer); }, [plan?.id, tasks, queryPlan]);
  useEffect(()=>{if(!ready||!runningPlans.length)return;let active=true;const refresh=async()=>{for(const id of runningPlans){try{const data=await api<{tasks:Task[]}>(undefined,`?plan=${encodeURIComponent(id)}`);if(!active)return;setRecordTasks(old=>({...old,...Object.fromEntries(data.tasks.map(task=>[task.id,task]))}));if(data.tasks.length&&data.tasks.every(task=>!['queued','running','uncertain'].includes(task.status)))setRunningPlans(old=>old.filter(value=>value!==id));}catch{}}};void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{active=false;clearInterval(timer);};},[ready,runningPlans]);
  useEffect(()=>{if(ready)void load().catch(e=>setError(e.message));},[ready,tab,deleted,load]);
  useEffect(()=>{setParseStatus(null);setParseBinding('');if(!ready||!rules.description.trim())return;let active=true;const binding=analysisBinding;const timer=setTimeout(()=>void api<{parse:DescriptionStatus}>({action:'parse-status',description:rules.description}).then(data=>{if(active&&!lock.current&&liveDraft.current.analysisBinding===binding){setParseStatus(data.parse);setParseBinding(binding);}}).catch(()=>undefined),600);return()=>{active=false;clearTimeout(timer);};},[ready,analysisBinding,rules.description]);
  useEffect(()=>{if(!ticketId)return;const receive=(e:MessageEvent)=>{if(e.origin===location.origin&&e.source===window.opener&&e.data?.type==='sd2:avatar-applied'&&e.data.ticketId===ticketId)setNotice('原任务已确认回填，没有启动生成。');};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[ticketId]);
  const sheet=!!plan&&avatarLayout(plan)==='contact-sheet', draftSheet=avatarLayout(rules)==='contact-sheet', layoutChanged=!!plan&&avatarLayout(plan)!==avatarLayout(rules);
  const current = plan?.candidates[index], task = tasks.find(t => t.ordinal === (sheet ? 1 : index + 1))||sourceTask;
  const imageTask=task?.asset?task:previousImageTask, image=imageTask?.asset;
  const conditionsChanged=!!current&&avatarRulesSignature(rules,false)!==avatarRulesSignature(current.rules,false);
  const activePrompt=sheet?plan!.sheetPrompt||'':current?.prompt||'';
  const currentRecord = records.find(r => r.taskId === imageTask?.id);
  const blocked = pending || tasks.some(t => t.status === 'uncertain');
  function assertDraft(draft: DraftSnapshot) {
    if(!alive.current||liveDraft.current.revision!==draft.revision||liveDraft.current.ownerRevision!==draft.ownerRevision)throw new Error('当前草稿或账号已变化，旧请求不会继续出图；请按当前内容重新生成。');
  }
  function showParse(parse: DescriptionStatus, draft: DraftSnapshot) {assertDraft(draft);setParseStatus(parse);setParseBinding(draft.analysisBinding);}
  function checkGeneration(draft: DraftSnapshot) {
    assertDraft(draft);
    if(!draft.ready||management)throw new Error('人物页面尚未就绪，请等待或返回人物生成。');
    if(liveDraft.current.blocked)throw new Error('原提交尚未确认，请先查询原任务；不能重复生成。');
    const unit=draft.prices[draft.model];
    if(unit==null||!Number.isInteger(unit)||unit<0)throw new Error('当前模型图片价格尚未就绪，本次未调用文字模型或提交图片。');
    const selected=draft.model as typeof IMAGE_STUDIO_MODELS[number];
    if(!IMAGE_STUDIO_MODELS.includes(selected)||!IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[selected]?.some(option=>option===draft.quality)||!IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[selected]?.some(option=>option===draft.resolution))throw new Error('当前图片模型或参数不可用，请先调整；本次未调用文字模型或提交图片。');
  }
  async function checkImageSettings(draft: DraftSnapshot) {
    setStage('检查图片价格和通道');
    const response=await fetch('/api/image-studio/settings',{cache:'no-store'});
    const settings=await readJsonResponse<{error?:string;prices:Record<string,number|null>;modelReady:Record<string,boolean>}>(response);
    assertDraft(draft);
    if(!response.ok)throw new Error(settings.error||'图片设置尚未确认，本次未调用文字模型或提交图片。');
    const unit=settings.prices?.[draft.model];
    if(unit!==draft.prices[draft.model]){
      setPrices(old=>({...old,[draft.model]:unit??null}));
      throw new Error('图片价格已变化，请核对按钮上方的新报价后重新点击；本次未调用文字模型或提交图片。');
    }
    if(settings.modelReady?.[draft.model]!==true)throw new Error('当前模型图片通道尚未就绪，本次未调用文字模型或提交图片。');
  }
  async function run(work: () => Promise<void>) { if (lock.current) return; const draft=liveDraft.current; lock.current = true; setBusy(true); setError(''); try { await work(); } catch (e) { if(alive.current&&liveDraft.current.ownerRevision===draft.ownerRevision&&liveDraft.current.revision===draft.revision){setError((e as Error).message);if((e as {parse?:DescriptionStatus}).parse)showParse((e as {parse:DescriptionStatus}).parse,draft);} } finally { lock.current = false; if(alive.current){setBusy(false);setStage('');} } }
  async function readParse(draft: DraftSnapshot, allowAnalysis: boolean, retryToken?: string, recheckOnly=false) {
    if(!draft.rules.description.trim())return null;
    setStage('检查人物文案');
    let {parse}=await api<{parse:DescriptionStatus}>({action:'parse-status',description:draft.rules.description});
    showParse(parse,draft);
    if(parse.state==='succeeded'&&!recheckOnly)return parse;
    let rechecked=false;
    const request=async(free:boolean)=>{
      assertDraft(draft);setStage(free?'免费重检已有回复':'理解人物文案');
      const data=await api<{parse:DescriptionStatus}>({action:free?'parse-recheck':'analyze',description:draft.rules.description,draftRevision:draft.rules.descriptionEditedAt||0,approveTextModel:!free,...(!free&&retryToken?{parseRetryToken:retryToken}:{})});
      showParse(data.parse,draft);return data.parse;
    };
    if(parse.canRecheck){rechecked=true;parse=await request(true);}
    else if(!recheckOnly&&allowAnalysis&&(parse.state==='not-started'||parse.state==='failed'&&retryToken&&retryToken===parse.retryToken)){
      try {parse=await request(false);}
      catch(e){assertDraft(draft);const receipt=(e as {parse?:DescriptionStatus}).parse;if(!receipt?.canRecheck)throw e;showParse(receipt,draft);rechecked=true;parse=await request(true);}
    }
    if(!rechecked&&parse.state!=='succeeded'&&parse.canRecheck)parse=await request(true);
    if(parse.state!=='succeeded')throw Object.assign(new Error(`${parse.message} 本次未提交图片，正文和旧图保留。`),{parse});
    return parse;
  }
  async function analyze(retryToken?:string, recheck=false) { await run(async()=>{
    const draft=liveDraft.current;
    if(retryToken&&!(await confirm('上次文字理解费用可能已经产生。重新理解会主动调用一次文字模型，可能再次产生上游费用，金额未知；本次不生成图片。',{title:'重新理解',confirmLabel:'重新理解一次'})))return;
    assertDraft(draft);
    const parse=await readParse(draft,!!retryToken,retryToken,recheck);
    if(parse)setNotice('文案已理解；本次没有提交图片。点击生成可按当前报价出图。');
  }); }
  async function submit(next: AvatarPlan, original=liveDraft.current, direct=false) {
    assertDraft(original);
    if(liveDraft.current.blocked)throw new Error('原提交尚未确认，请先查询；本次未重复出图。');
    if(next.model!==original.model||next.quality!==original.quality||next.resolution!==original.resolution||avatarLayout(next)!==avatarLayout(original.rules))throw new Error('返回的图片参数与当前选择不一致，本次未提交；请重新准备。');
    if(next.candidates.some(candidate=>candidate.members.length!==original.rules.people))throw new Error('返回的人数与当前选择不一致，本次未提交；正文和原参数保留。');
    if(next.unitCredits===null||!Number.isInteger(next.unitCredits)||next.unitCredits<0||!next.imageReady){setNotice('人物草稿已准备，图片通道或报价尚未就绪；本次未提交图片。');return;}
    const count=avatarOutputCount(next),expectedCount=avatarLayout(original.rules)==='contact-sheet'?1:original.rules.candidates;
    if(direct&&(next.unitCredits!==original.prices[original.model]||count!==expectedCount)){
      setPrices(old=>({...old,[next.model]:next.unitCredits}));
      setNotice(`图片报价已变化：${count}张，每张${next.unitCredits}点，共${count*next.unitCredits}点。本次未提交图片，请核对新报价后重新点击生成。`);
      return;
    }
    if(!direct){
      setStage('等待确认图片费用');
      if (!(await confirm(`${avatarLayout(next)==='contact-sheet'?'1张真实四宫格，四格不同人物、每格1人':`${count}张独立候选，每张${next.candidates[0].members.length}人`}，每张${next.unitCredits}点，共冻结${count * next.unitCredits}点。仅本次明确的人物要求会用于生成。`, { title: '确认生成', confirmLabel: '生成图片' }))) return;
    }
    assertDraft(original);
    // Save the exact request before POST so reload can query it without replaying payment.
    localStorage.setItem(key,JSON.stringify({...JSON.parse(draftSignature),rules:next.candidates[0].rules,planId:next.id,index:0,model:next.model,quality:next.quality,resolution:next.resolution,...(imageTask?.asset?{previousImageTaskId:imageTask.id}:{})}));
    localStorage.setItem(`${key}:pending`,next.id);
    if(imageTask?.asset)setPreviousImageTask(imageTask);
    if(plan&&tasks.some(task=>['queued','running'].includes(task.status)))setRunningPlans(old=>Array.from(new Set([...old,plan.id])));
    setPlan(next);setRules(next.candidates[0].rules);setTasks([]);setSourceTask(null);setIndex(0);
    planRef.current=next.id;setPending(true);
    setStage('提交图片任务');
    try {
      try { await api({ action: 'submit', id: next.id, layout:avatarLayout(next),rules:next.candidates[0].rules,model:next.model,quality:next.quality,resolution:next.resolution }); }
      finally { if (alive.current && liveDraft.current.ownerRevision===original.ownerRevision && planRef.current===next.id) await refreshCredits({ force: true }); }
      if(!alive.current||liveDraft.current.ownerRevision!==original.ownerRevision||planRef.current!==next.id)return true;
      setPending(false);setNotice('图片任务已提交，正在查询结果；尚未代表已出图。'); await queryPlan(next.id); await load();
      return true;
    }
    catch (e) { if(!alive.current||liveDraft.current.ownerRevision!==original.ownerRevision||planRef.current!==next.id)return;if ((e as {status?:number}).status && (e as {status:number}).status<500) {setPending(false);localStorage.removeItem(`${key}:pending`);} setError((e as Error).message);await queryPlan(next.id).catch(() => undefined); throw e; }
  }
  async function prepare(action = 'new', field?: string, reroll = false, forceNew=false) { await run(async () => {
    const draft=liveDraft.current;
    if(draft.blocked)throw new Error('原提交尚未确认，请先查询原任务；不能微调或新建人物');
    if(action!=='tweak'){checkGeneration(draft);await checkImageSettings(draft);}
    const parse=await readParse(draft,action==='new');
    assertDraft(draft);setStage('准备人物和图片报价');
    const reprice=action==='new'&&!forceNew&&plan&&avatarRulesSignature(draft.rules)===avatarRulesSignature(plan.candidates[0].rules)&&(!tasks.length||draft.model!==plan.model||draft.quality!==plan.quality||draft.resolution!==plan.resolution);
    const result = await api<{plan:AvatarPlan}>(reprice?{action:'quote',id:plan!.id,rules:draft.rules,model:draft.model,quality:draft.quality,resolution:draft.resolution,layout:avatarLayout(draft.rules)}:{ action: 'prepare', rules:reroll&&field?{...draft.rules,choices:{...draft.rules.choices,[field]:''}}:draft.rules, ...(parse?{descriptionId:parse.descriptionId,parserVersion:parse.parserVersion}:{}), model:draft.model, quality:draft.quality, resolution:draft.resolution, previousId: plan?.id, previousIndex: index, baselineAssetId: sheet?undefined:current?.baselineAssetId || image?.id, actionType: action, ...(field ? { field } : {}) });
    assertDraft(draft);
    if(action==='tweak'){planRef.current=result.plan.id;setPlan(result.plan);setRules(result.plan.candidates[0].rules);setSourceTask(null);setTasks([]);setIndex(0);setPending(false);setNotice('仅修改人物草稿，尚未生成图片或扣除图片点数。');}
    else {const submitted=await submit(result.plan,draft,action==='new');if(!submitted){assertDraft(draft);if(!image){planRef.current=result.plan.id;setPlan(result.plan);setSourceTask(null);setTasks([]);setIndex(0);}}}
  }); }
  async function saveRules(copy = false) { await run(async () => {
    const active = copy ? null : editing.current;
    const initialName = active?.name || current?.standardDescription.slice(0, 16) || '人物规则';
    await askName('配置名称', initialName, { title: copy ? '另存规则' : '保存规则', confirmLabel: '保存', maxLength: 80, onSubmit: async name => {
      await api({ action: 'save', id: active?.id, revision: active?.revision, name, record: { kind: 'config', rules } }); editing.current = null; await load(); setNotice('随机规则已保存，历史人物与结果未改变。');
    } });
  }); }
  function rememberResult() {
    if(imageTask?.asset)setPreviousImageTask(imageTask);
    if(plan&&tasks.some(task=>['queued','running'].includes(task.status)))setRunningPlans(old=>Array.from(new Set([...old,plan.id])));
  }
  function resetDraft() {rememberResult();planRef.current=null;setSourceTask(null);setRules(emptyRules);setPlan(null);setTasks([]);setIndex(0);editing.current=null;setPending(false);}
  async function quoteOriginal() { await run(async()=>{
    const draft=liveDraft.current;
    if(!plan||blocked)throw new Error('请先查询原任务；本次没有重复生成');
    if(conditionsChanged)throw new Error('人物条件已变化，请先按当前文案和条件准备人物；旧图片仍保留');
    setStage('更新图片报价');const data=await api<{plan:AvatarPlan}>({action:'quote',id:plan.id,rules,model,quality,resolution,layout:avatarLayout(rules)});
    assertDraft(draft);await submit(data.plan,draft);
  }); }
  async function mutate(record: AvatarRecord, action: string, extra: Record<string,unknown> = {}) { await api({ action, id: record.id, revision: record.revision, ...extra }); await load(); }
  async function restore(record: AvatarRecord) { await run(async () => {
    if(blocked)throw new Error('原提交尚未确认，请先查询原任务');
    rememberResult();
    if (record.kind === 'config') { if(imageTask?.asset)setPreviousImageTask(imageTask);setRules({...record.rules!,layout:avatarLayout(record.rules!),configId:record.id,configRevision:record.revision,choiceSources:Object.fromEntries(Object.keys(record.rules!.choices).map(key=>[key,'config']))}); editing.current = record;planRef.current=null;setPlan(null);setTasks([]);setSourceTask(null); setNotice('已载入配置；修改后选择保存或另存为。'); return; }
    const result = await api<{plan:AvatarPlan;sourceTask?:Task|null}>({ action: 'restore', id: record.id }); setRules({...result.plan.candidates[0].rules,layout:avatarLayout(result.plan)});planRef.current=result.plan.id; setPlan(result.plan);setModel(result.plan.model);setQuality(result.plan.quality);setResolution(result.plan.resolution);setSourceTask(result.sourceTask||null); setIndex(0); setTasks([]); setPending(false); setNotice('已恢复完整人物、条件、锁和历史生成参数；没有新建任务或扣除点数。出图前需更新报价。');
  }); }
  function setChoice(field: string, value: string) { setRules(old => ({ ...old, choices: { ...old.choices, [field]: value },choiceSources:{...old.choiceSources,[field]:'user'},choiceEditedAt:{...old.choiceEditedAt,[field]:Date.now()} })); }
  async function returnImage() { await run(async () => { if (!ticketId || !image) return;if(!window.opener||window.opener.closed)throw new Error('原窗口已关闭，请在原任务的素材库重新选择；图片仍保留。'); const response = await fetch('/api/avatar-studio/handoff', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action:'choose', id:ticketId, assetId:image.id}) }); const data = await readJsonResponse<{error?:string}>(response); if (!response.ok) throw new Error(data.error || '返回未确认'); window.opener.postMessage({ type: 'sd2:avatar-return', ticketId }, location.origin); window.opener.focus(); setNotice('已选择这张，正在等待原任务确认；原图仍保存在我的素材。'); }); }
  const visibleRecords = records.filter(r => r.kind === tab && Boolean(r.deletedAt) === deleted);
  return <main className={styles.page}>
    <header className={styles.heading}><h1>{management ? '人物配置管理' : '人物生成'}</h1><div className={styles.controls}><Link href={management ? '/tools/avatar-studio' : '/tools/avatar-studio/configs'}>{management ? '返回人物生成' : '管理配置'}</Link>{ticketId && <button type="button" onClick={() => window.opener?.focus()}><ArrowLeft size={15}/>返回原任务</button>}<button type="button" disabled={busy||blocked} onClick={resetDraft} title="重置人物草稿"><RotateCcw size={15}/></button></div></header>
    {plan?.warnings?.map((warning,i)=><div role="status" className={styles.notice} key={i}>{warning}</div>)}
    {error && <div role="alert" className={`${styles.notice} ${styles.error}`}>{error}</div>}{notice && <div role="status" className={styles.notice}>{notice}</div>}
    {busy&&stage&&<div role="status" className={styles.notice}>{stage}；当前草稿保留。</div>}
    {activeParse&&activeParse.state!=='not-started'&&<section aria-label="文案理解" className={styles.notice}>
      <strong>{activeParse.state==='succeeded'?'可以生成':activeParse.state==='needs-clarification'?'需要补充':activeParse.state==='pending'?'分析中':'分析尚未确认'}</strong><p>{activeParse.message}</p>
      {activeParse.understanding&&<><p>{activeParse.understanding.summary}</p>{!!activeParse.understanding.explicit.length&&<p>文案明确要求：{activeParse.understanding.explicit.join('；')}</p>}{!!activeParse.understanding.soft.length&&<p>软方向：{activeParse.understanding.soft.join('；')}</p>}<details><summary>文案未指定的外观</summary><p>{activeParse.understanding.randomizable.join('、')||'按已确认条件准备人物'}</p></details>{activeParse.understanding.issues.map((issue,i)=><p key={i}>{issue}</p>)}</>}
      {activeParse.constraints&&<p>当前生效条件：{effectiveConditions(activeParse.constraints,rules).join('；')||'未指定的外观按允许范围随机'}。同一项以最新文案或快捷条件为准。</p>}
      {activeParse.state!=='succeeded'&&<div className={styles.controls}><button type="button" disabled={busy} onClick={()=>void run(async()=>{const binding=liveDraft.current.analysisBinding;const data=await api<{parse:DescriptionStatus}>({action:'parse-status',description:rules.description});if(liveDraft.current.analysisBinding===binding){setParseStatus(data.parse);setParseBinding(binding);}})}>查询解析状态</button>{activeParse.canRecheck&&<button type="button" disabled={busy} onClick={()=>void analyze(undefined,true)}>免费重检原回复</button>}{activeParse.retryToken&&activeParse.state==='failed'&&<button type="button" disabled={busy||blocked} onClick={()=>void analyze(activeParse.retryToken)}>确认后重新解析一次</button>}</div>}
    </section>}
    {layoutChanged&&<div role="status" className={styles.notice}>排版已变，请重新报价；旧图片和四份人物条件保留，不直接按旧计划提交。</div>}
    {conditionsChanged&&<div role="status" className={styles.notice}>人物条件已变化，旧图片和任务保留；旧报价不能直接出图。</div>}
    {(!management || editing.current) && <fieldset className={styles.layout} disabled={busy||!ready}>
      <section className={styles.input} aria-label="人物条件">
        <div className={styles.controls} aria-label="图片排版"><button type="button" aria-pressed={draftSheet} onClick={()=>setRules(r=>({...r,layout:'contact-sheet',people:1,candidates:4}))}>四宫格（1张）</button><button type="button" aria-pressed={!draftSheet} onClick={()=>setRules(r=>({...r,layout:'independent'}))}>独立头像</button></div>
        {!draftSheet&&<div className={styles.controls}><button type="button" aria-pressed={rules.people === 1} onClick={() => setRules(r => ({...r,people:1}))}>单人头像</button><button type="button" aria-pressed={rules.people > 1} onClick={() => setRules(r => ({...r,people:2}))}>多人</button>{rules.people > 1 && <select aria-label="每张图片人数" value={rules.people} onChange={e=>setRules(r=>({...r,people:Number(e.target.value) as 2|3|4}))}>{[2,3,4].map(n=><option key={n} value={n}>{n}人</option>)}</select>}</div>}
        <label>描述你想要的人物<textarea value={rules.description} maxLength={3000} placeholder="上班族，短发，沉稳，右眉有一道浅疤" onChange={e=>setRules(r=>({...r,description:e.target.value,descriptionEditedAt:Date.now()}))}/></label>
        <fieldset className={styles.optional}><legend>补充条件（可选）</legend><div className={styles.quick}>{quickFields.map(field=><label key={field}>{fieldLabels[field]}{field==='age' ? <input type="text" inputMode="numeric" maxLength={5} placeholder="按描述 / 随机" value={rules.choices[field]||''} onChange={e=>setChoice(field,e.target.value)}/> : <select value={rules.choices[field]||''} onChange={e=>setChoice(field,e.target.value)}><option value="">按描述 / 未指定随机</option>{Array.from(new Set(catalog[field])).map(v=><option key={v}>{v}</option>)}</select>}</label>)}</div></fieldset>
        <details open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>更多补充条件（可选）</summary><div className={styles.input}>{['face_shape','hair_color','skin_tone','temperament','body_type','facial_hair'].map(field=><label key={field}>{fieldLabels[field]}<select value={rules.choices[field]||''} onChange={e=>setChoice(field,e.target.value)}><option value="">按描述 / 未指定随机</option>{Array.from(new Set(catalog[field])).map(v=><option key={v}>{v}</option>)}</select></label>)}<label>随机强度<select value={rules.intensity} onChange={e=>setRules(r=>({...r,intensity:e.target.value as AvatarRules['intensity']}))}><option value="conservative">保守</option><option value="standard">标准</option><option value="bold">大胆</option></select></label></div></details>
        <label>图片模型<select value={model} onChange={e=>{setModel(e.target.value);setQuality('auto');setResolution('1K');}}>{!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])&&<option value={model}>原模型已不可用</option>}{IMAGE_STUDIO_MODELS.map(m=><option key={m} value={m}>{IMAGE_STUDIO_MODEL_LABELS[m]}</option>)}</select></label>
        <div className={styles.quick}><label>质量<select value={quality} onChange={e=>setQuality(e.target.value)}>{(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model as typeof IMAGE_STUDIO_MODELS[number]]||[quality]).map(q=><option key={q}>{q}</option>)}</select></label><label>分辨率<select value={resolution} onChange={e=>setResolution(e.target.value)}>{(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model as typeof IMAGE_STUDIO_MODELS[number]]||[resolution]).map(q=><option key={q}>{q}</option>)}</select></label></div>
        {!draftSheet&&<div className={styles.controls} aria-label="不同候选数量">{[1,2,4].map(n=><button key={n} type="button" aria-pressed={rules.candidates===n} onClick={()=>setRules(r=>({...r,candidates:n as 1|2|4}))}>{n}位候选</button>)}</div>}
        <span className={styles.price}>{prices[model] == null ? '此模型尚未设置价格' : draftSheet?`1张四宫格，每张${prices[model]}点，共${prices[model]}点；4位不同人物，每格1人，整图1:1`:`${rules.candidates}张，每张${prices[model]}点，共${prices[model]! * rules.candidates}点；${rules.people}人/张`}</span>
        {!!rules.description.trim()&&<small className={styles.price}>生成时按正文理解人物并提交图片。新正文首次理解可能另有上游文字模型费用，金额未知；图片积分如上。</small>}
        <button type="button" className={styles.primary} disabled={!ready||busy||blocked||management} onClick={()=>void prepare()}>{busy?stage||'处理中':draftSheet?'生成四宫格':'生成独立头像'}</button>
        {blocked && <button type="button" className={styles.quiet} onClick={()=>void run(async()=>{const id=planRef.current;if(!id)throw new Error('原计划编号暂不可读取，请保留草稿后重新打开页面；未重复提交');await queryPlan(id);})}>查询原提交，不重复生成</button>}
        <div className={styles.controls}><button type="button" disabled={busy} onClick={()=>void saveRules()}><Save size={15}/>保存规则</button>{editing.current && <button type="button" disabled={busy} onClick={()=>void saveRules(true)}>另存为</button>}</div>
        {!!recentConfigs.length&&<section><small>最近配置</small>{recentConfigs.map(r=><button type="button" className={styles.quiet} key={r.id} onClick={()=>void restore(r)}>{r.name}</button>)}</section>}
      </section>
      <section aria-label="人物结果"><div className={styles.preview}>{image ? <button type="button" aria-label="选择人物图片" aria-pressed={selectedImage} onClick={()=>setSelectedImage(true)}><img src={image.original_url} alt={sheet?'整张四宫格人物图片':'当前人物结果'}/></button> : <div className={styles.placeholder}>{task ? statusLabel[task.status]||'状态待确认' : current ? `${sheet?'四位人物的四宫格草稿\n':''}${current.members[0].fields.age.value}岁 · ${current.members[0].fields.gender.value}\n${current.members[0].fields.face_shape.value} · ${current.members[0].fields.hair_length.value}\n人物草稿，尚未出图` : <><UserRound size={48}/><p>暂无人物图片</p></>}</div>}</div>
        {sheet&&<p className={styles.price}>整张四宫格是一张图片；以下选择只查看对应格的人物条件，不是裁切图片。</p>}
        <div className={styles.thumbnails}>{plan?.candidates.map((c,i)=>{const t=sheet?undefined:tasks.find(t=>t.ordinal===i+1);return <button type="button" className={styles.thumb} key={c.characterId+String(i)} aria-pressed={index===i} aria-label={`查看${sheet?'格':'候选'}${i+1}人物信息`} onClick={()=>{setIndex(i);setSelectedImage(true);}}>{t?.asset?<img src={t.asset.thumbnail_url||t.asset.original_url} alt={`人物${i+1}`}/>:<UserRound size={28}/>}<small>{sheet?['左上','右上','左下','右下'][i]:t ? statusLabel[t.status]?.split('，')[0]||'状态待确认' : `候选${i+1}草稿`}</small></button>;})}</div>
        <div className={styles.controls}>{plan&&plan.candidates.length>1&&<><button type="button" title="上一个" aria-label="上一个" onClick={()=>setIndex(i=>(i+plan.candidates.length-1)%plan.candidates.length)}><ArrowLeft size={16}/></button><button type="button" title="下一个" aria-label="下一个" onClick={()=>setIndex(i=>(i+1)%plan.candidates.length)}><ArrowRight size={16}/></button></>}{image&&<><button type="button" onClick={()=>setPreview(true)}>预览整图</button><a className={styles.quiet} href={`/api/image-studio/download?id=${encodeURIComponent(imageTask!.id)}`}><Download size={15}/>下载</a><ContentReactions contentKey={`asset:${image.id}`} imageSharing={false}/>{!sheet&&task?.asset&&imageTask===task&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await askName('人物名称','我的人物',{title:'保存人物',confirmLabel:'保存',onSubmit:async name=>{await api({action:'save',name,planId:plan!.id,index,record:{kind:'character'}});await load();}});})}><Save size={15}/>保存这个人</button>}</>}
        {current&&<><button type="button" disabled={busy||blocked} onClick={()=>void prepare('new',undefined,false,true)}>{draftSheet?'换一组人物':'换一个人'}</button><button type="button" disabled={busy||blocked||needsAnalysis||sheet||draftSheet||!image&&!current.baselineAssetId} onClick={()=>void prepare('styling')}>换个造型</button>{(!tasks.length||layoutChanged||model!==plan?.model||quality!==plan?.quality||resolution!==plan?.resolution)&&<button type="button" disabled={busy||blocked||conditionsChanged||needsAnalysis} onClick={()=>void quoteOriginal()}>重新报价并按原人物出图</button>}</>}
        {ticketId&&image&&<button type="button" className={styles.primary} disabled={busy} onClick={()=>void returnImage()}>使用这张并返回</button>}</div>
        {tasks.some(t=>t.status==='failed')&&!tasks.some(t=>['queued','running','uncertain'].includes(t.status))&&<button type="button" className={styles.quiet} disabled={busy||conditionsChanged||needsAnalysis} onClick={()=>void run(async()=>{const draft=liveDraft.current;const data=await api<{plan:AvatarPlan}>({action:'retry',id:plan!.id});assertDraft(draft);await submit(data.plan,draft);})}>只重试失败项</button>}
        {previousImageTask?.asset&&imageTask===previousImageTask&&<p className={styles.price}>保留的上一张图片；当前人物或任务还没有新图片。</p>}
        {sheet&&<p className={styles.price}>需保存或调整某一个人，请切到独立头像，按原人物重新报价出图；不会自动裁切或自动生成。</p>}
        {task?.error&&<p className={styles.error}>{task.error}</p>}{tasks.length>0&&<p className={styles.price}>已完成 {tasks.filter(t=>t.status==='succeeded').length}/{plan?avatarOutputCount(plan):0} 张。图片已保存不代表人物要求已符合。</p>}
      </section>
      <aside className={styles.detail} aria-label="当前人物信息"><h2>{sheet?['左上格人物','右上格人物','左下格人物','右下格人物'][index]:'当前人物'}</h2>{current ? <><p>{current.members.map(d=>`${d.fields.gender.value} · ${d.fields.age.value}岁 · ${d.fields.face_shape.value} · ${d.fields.hair_length.value}`).join('；')}</p><small>{sheet?'四宫格保留四份人物条件；整图不能作为某一个人的身份基准。':'保持同人使用原图参考，模型仍可能改变面部；基准图不会自动替换。'}</small>{[...quickFields,'face_shape'].map(field=>{const f=current.members[0].fields[field];return <div key={field} className={styles.field}><span>{fieldLabels[field]}</span><select aria-label={`微调${fieldLabels[field]}`} value={rules.choices[field]||f.value} onChange={e=>setChoice(field,e.target.value)}>{Array.from(new Set([f.value,...catalog[field]])).map(v=><option key={v}>{v}</option>)}</select><button type="button" aria-label={`锁定${fieldLabels[field]}`} title={`锁定${fieldLabels[field]}，${f.source==='user'?'用户指定':f.source==='random'?'随机生成':'继承或推断'}`} aria-pressed={!!rules.locks[field]} onClick={()=>setRules(r=>{const locks={...r.locks};if(locks[field])delete locks[field];else locks[field]={...f,locked:true,manualLock:true};return {...r,locks};})}>{rules.locks[field]?<Lock size={14}/>:<Unlock size={14}/>}</button><button type="button" disabled={busy||blocked||sheet||draftSheet||!!rules.locks[field]||f.locked} title={`只重抽${fieldLabels[field]}，不出图`} aria-label={`只重抽${fieldLabels[field]}`} onClick={()=>void prepare('tweak',field,true)}><Dice5 size={15}/></button></div>;})}<div className={styles.controls}>{[...quickFields,'face_shape'].filter(field=>rules.choices[field]&&rules.choices[field]!==current.members[0].fields[field].value).map(field=><button type="button" className={styles.quiet} key={field} disabled={busy||blocked||sheet||draftSheet} onClick={()=>void prepare('tweak',field)}>微调{fieldLabels[field]}</button>)}</div><details><summary>完整人物信息</summary>{current.members.map((dna,i)=><div key={dna.seed}><strong>人物 {i+1}</strong><p>明显特征 {dna.details.filter(d=>d.prominence!=='micro').length} / 默认预算 {dna.featureBudget}</p>{Object.entries(dna.fields).map(([key,f])=><p key={key}>{fieldLabels[key]||key}：{f.value} · {f.source==='user'?'用户指定':f.source==='config'?'配置继承':f.source==='inferred'?'范围推断':'随机生成'}{f.locked?' · 已固定':''}</p>)}</div>)}</details><details><summary>人物描述与提示词</summary><div className={styles.prompt}>{activePrompt}</div><button className={styles.quiet} type="button" onClick={()=>void navigator.clipboard.writeText(activePrompt).catch(()=>setError('复制失败，请手动选择文本'))}><Copy size={15}/>复制提示词</button><small>随机规则 {current.members[0].ruleVersion}，图片模型不提供可复现的生图种子。</small></details>{currentRecord&&<label>人物符合度<select value={currentRecord.qualityStatus||'unreviewed'} onChange={e=>void run(()=>mutate(currentRecord,'quality',{record:{qualityStatus:e.target.value}}))}><option value="unreviewed">未人工确认</option><option value="matches">符合要求</option><option value="mismatch">不符合要求</option></select></label>}</> : <small>生成后查看人物信息</small>}</aside>
    </fieldset>}
    <section className={styles.records}><div className={styles.heading}><div className={styles.controls}>{(['config','character','result'] as const).map(t=><button type="button" key={t} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='config'?'随机规则':t==='character'?'保存的人物':'生成历史'}</button>)}</div><label><input type="checkbox" checked={deleted} onChange={e=>setDeleted(e.target.checked)} style={{width:'auto'}}/> 最近删除</label></div>
      {visibleRecords.map(r=>{const t=tasks.find(task=>task.id===r.taskId)||(sourceTask?.id===r.taskId?sourceTask:recordTasks[r.taskId||'']);return <article className={styles.record} key={r.id}>{t?.asset?<img src={t.asset.thumbnail_url||t.asset.original_url} alt={r.name}/>:r.assetId?<img src={`/api/image-studio/assets/${r.assetId}?thumbnail=1`} alt={r.name}/>:<span className={styles.recordCover}><UserRound size={24}/></span>}<div className={styles.recordText}><strong>{r.name}</strong><small><RelativeTime value={r.createdAt}/> · {r.kind==='result'?(t?statusLabel[t.status]:'状态未读取'):r.kind==='config'?`配置第${r.revision}版`:'已保存人物'}</small></div><div className={styles.controls}>{r.deletedAt?<button type="button" disabled={busy} onClick={()=>void run(()=>mutate(r,'undelete'))}>撤销删除</button>:<><button type="button" disabled={busy} onClick={()=>void restore(r)}>{r.kind==='config'?'使用/编辑':'恢复草稿'}</button>{r.kind==='config'&&<><button type="button" onClick={()=>void run(async()=>{await askName('配置名称',r.name,{title:'重命名',onSubmit:async name=>mutate(r,'rename',{name})});})}>重命名</button><button type="button" onClick={()=>void run(async()=>{await api({action:'save',name:`${r.name}副本`,record:{kind:'config',rules:r.rules}});await load();})}>复制</button></>}{r.kind==='result'&&t?.asset&&<ContentReactions contentKey={`asset:${t.asset.id}`} imageSharing={false}/>}<button type="button" disabled={busy} onClick={()=>void run(async()=>{if(await confirm(`删除“${r.name}”？可撤销，不删除已有图片、资产或其他历史。`,{title:'删除记录',confirmLabel:'删除',danger:true}))await mutate(r,'delete');})}><Trash2 size={15}/>删除</button></>}</div></article>;})}
      {!visibleRecords.length&&<p className={styles.empty}>暂无{deleted?'已删除':''}{tab==='config'?'配置':tab==='character'?'人物':'生成历史'}</p>}{cursor&&<button type="button" className={styles.quiet} disabled={busy} onClick={()=>void run(async()=>{await load(true,cursor);})}>加载更多</button>}
    </section>{preview&&image&&<ZoomableImagePreview src={image.original_url} alt="人物结果" fileName="avatar.png" onClose={()=>setPreview(false)}/>} {productDialog}
  </main>;
}
