'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { PrivateDefinitionEditor } from '@/app/image-studio/PrivateDefinitionEditor';
import { useCreationContext } from '@/lib/hooks/use-creation-context';
import CreationAvailability from '@/components/creation/CreationAvailability';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { SEEDANCE_VIDEO_MODEL_OPTIONS, DEFAULT_SEEDANCE_VIDEO_MODEL_ID, seedanceVideoDurationOptions, seedanceVideoModelLabel } from '@/lib/provider/seedance-models';
import type { MultiviewWorkDto } from '@/lib/video/multiview-work-contract';
import type { MultiviewActionBinding, MultiviewActionDraft, MultiviewActionRun, MultiviewActionState, MultiviewActionParameters, MultiviewActionContextKind } from '@/lib/video/multiview-action-contract';
import styles from './multiview-action.module.css';

type Props = { ownerId: string; authority: string; work: MultiviewWorkDto | null; videoDefaults?: {model:string;duration:number;resolution:string;projectId:string;videoCardId:string|null}; outputReady: boolean; ratio: '16:9'|'9:16'|'1:1'; activeView: 'reference'|'video'; onView(value: 'reference'|'video'): void };
type Quote = { key: string; run: MultiviewActionRun; binding: MultiviewActionBinding; points: number; pricingRevision: string; token: string };
type Original = { key: string; runId: string; taskId: string | null };
const finished = new Set(['succeeded','failed','cancelled','canceled','completed','error']);
function RuleDialog({ kind, ownerId, onClose, onSaved }: { kind: MultiviewActionContextKind; ownerId: string; onClose(): void; onSaved(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), before = useRef<(() => Promise<boolean>) | null>(null);
  const close = async () => { if (!before.current || await before.current()) onClose(); };
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: () => void close() });
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return createPortal(<dialog ref={dialog} className={styles.dialog}><header><h2>{kind === 'format' ? '动作格式' : '镜头与同步'}</h2><button type="button" aria-label="关闭规则编辑" onClick={()=>void close()}><X size={18}/></button></header><PrivateDefinitionEditor userId={ownerId} moduleId={kind} endpoint={`/api/video/multiview/actions/contexts/${kind}`} dialog={dialog} beforeClose={before} open blocked={false} canRead needsIdentity={false} contextOnly label={kind==='format'?'动作格式':'镜头与同步'} maxLength={12000} onSaved={()=>{onSaved();onClose();}} /></dialog>, document.body);
}
function ConfirmDialog({ quote, parameters, busy, onClose, onConfirm }: { quote: Quote; parameters: MultiviewActionParameters; busy: boolean; onClose(): void; onConfirm(): void }) {
  const dialog=useRef<HTMLDialogElement>(null);
  useDialogDismiss({open:true,dialogRef:dialog,nativeDialog:true,onDismiss:()=>{if(!busy)onClose();}});
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
  return createPortal(<dialog ref={dialog} className={styles.dialog}><header><h2>生成动作视频</h2><button disabled={busy} aria-label="关闭费用确认" onClick={onClose}><X size={18}/></button></header><p>{seedanceVideoModelLabel(parameters.model)} · {parameters.duration} 秒 · {parameters.resolution} · {parameters.ratio}</p><p className={styles.frozenText}>{quote.run.text}</p><p className={styles.price}>本次预计 <strong>{quote.points} 点</strong></p><footer><button disabled={busy} onClick={onClose}>返回修改</button><button disabled={busy} onClick={onConfirm}>{busy?'正在受理…':'确认生成'}</button></footer></dialog>,document.body);
}
export function MultiviewActionPanel(props: Props) {
  const [state,setState]=useState<MultiviewActionState|null>(null),[draft,setDraft]=useState<MultiviewActionDraft|null>(null);
  const [text,setText]=useState('');
  const [parameters,setParameters]=useState<MultiviewActionParameters>({provider:'seedance',model:DEFAULT_SEEDANCE_VIDEO_MODEL_ID,duration:12,resolution:'720p',ratio:props.ratio,project_id:props.videoDefaults?.projectId||props.work?.projectId||'',video_card_id:props.videoDefaults?.videoCardId||props.work?.videoCardId||null});
  const [projects,setProjects]=useState<Array<{id:string;name:string}>>([]),[cards,setCards]=useState<Array<{id:string;title:string}>>([]);
  const [hydrated,setHydrated]=useState(false),[saving,setSaving]=useState(false),[draftBlocked,setDraftBlocked]=useState(false);
  const [message,setMessage]=useState(''),[quoteError,setQuoteError]=useState(''),[quote,setQuote]=useState<Quote|null>(null),[quoting,setQuoting]=useState(false);
  const [llmModel,setLlmModel]=useState(''),[aiPending,setAiPending]=useState<{requestId:string;runId?:string;edit:number}|null>(null),[aiBusy,setAiBusy]=useState(false),[suggestion,setSuggestion]=useState<MultiviewActionRun|null>(null),[beforeAi,setBeforeAi]=useState<string|null>(null);
  const [context,setContext]=useState<MultiviewActionContextKind|null>(null),[confirming,setConfirming]=useState(false),[submitting,setSubmitting]=useState(false);
  const [original,setOriginal]=useState<Original|null>(null),[selectedRunId,setSelectedRunId]=useState(''),[baseline,setBaseline]=useState<string|null>(null);
  const [quoteRetry,setQuoteRetry]=useState(0);
  const [attemptId,setAttemptId]=useState('initial'),[newAttemptRequired,setNewAttemptRequired]=useState(false);
  const [appliedRunId,setAppliedRunId]=useState<string|undefined>();
  const aiPoll=useRef({key:'',count:0}),videoPoll=useRef({key:'',count:0});
  const scope=`${props.ownerId}:${props.authority}:${props.work?.id||''}`;
  const liveScope=useRef(scope);liveScope.current=scope;
  const workRef=useRef(props.work);workRef.current=props.work;
  const input=useRef({text,parameters});input.current={text,parameters};
  const editRevision=useRef(0), saved=useRef(''),draftRef=useRef(draft);draftRef.current=draft;
  const saveLock=useRef(false),submitLock=useRef(false),aiLock=useRef(false);
  const requestKey=`sd2:multiview-action-request:v1:${props.ownerId}:${props.work?.id||'pending'}`;
  const attemptKey=requestKey+':attempt';
  const aiKey=`sd2:multiview-action-text-request:v1:${props.ownerId}:${props.work?.id||'pending'}`;
  const active=useCallback((value=scope)=>liveScope.current===value&&!isClientSessionBlocked(),[scope]);
  const headers=useCallback(()=>({'Content-Type':'application/json','x-app-session-user':props.ownerId}),[props.ownerId]);
  const api=useCallback(async<T,>(url:string,body?:unknown,method='POST'):Promise<T>=>{const response=await fetch(url,{method:body===undefined?'GET':method,cache:'no-store',headers:headers(),...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||value.message||'暂时无法完成，当前输入保留。'),{status:response.status,result:value});return value as T;},[headers]);
  const creation=useCreationContext({ownerId:props.ownerId,entry:'multiview',draftId:`action:${props.work?.id||'preparing'}`,projectId:parameters.project_id||null,legacyCardId:parameters.video_card_id,enabled:Boolean(hydrated&&parameters.project_id),onProjectChange:id=>setParameters(value=>({...value,project_id:id}))});
  const content=JSON.stringify([text,parameters,props.work?.draftRevision]);
  const quoteKey=JSON.stringify([scope,content,draft?.revision,state?.capabilities.rules.sync.revision,state?.capabilities.rules.format.revision,appliedRunId,attemptId]);
  const currentQuote=quote?.key===quoteKey&&props.outputReady?quote:null;
  const currentQuoteKey=useRef(quoteKey);currentQuoteKey.current=quoteKey;
  const selectedRun=state?.runs.find(run=>run.id===selectedRunId)||null;
  const selectedTask=selectedRun?.tasks[0]||null;
  const updateText=(value:string)=>{editRevision.current++;setText(value);setConfirming(false);};
  async function refresh(adopt=false,cursor?:string){
    if(!props.work)return;
    const captured=scope;const value=await api<MultiviewActionState>(`/api/video/multiview/actions?workId=${props.work.id}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
    if(!active(captured))return;
    setState(previous=>cursor&&previous?{...value,runs:[...previous.runs,...value.runs.filter(run=>!previous.runs.some(item=>item.id===run.id))]}:value);
    if(adopt){setDraft(value.draft);draftRef.current=value.draft;if(value.draft){setText(value.draft.text);setParameters({...value.draft.parameters,ratio:props.ratio});saved.current=JSON.stringify([value.draft.text,value.draft.parameters,props.work.draftRevision]);}setLlmModel(value.capabilities.defaultLlmModel);setHydrated(true);}
  }
  useEffect(()=>{
    setState(null);setDraft(null);draftRef.current=null;setText('');setQuote(null);setHydrated(false);setOriginal(null);setMessage('');setAiPending(null);saved.current='';
    const captured=scope;let cancelled=false;
    if(!props.work)return;
    setParameters(value=>({...value,ratio:props.ratio,project_id:props.videoDefaults?.projectId||props.work?.projectId||'',video_card_id:props.videoDefaults?.videoCardId||props.work?.videoCardId||null}));
    void (async()=>{try{await refresh(true);if(cancelled||!active(captured))return;const attempt=localStorage.getItem(attemptKey);if(attempt){const value=JSON.parse(attempt);if(value.id==='initial'||/^[a-f0-9-]{36}$/i.test(value.id)){setAttemptId(value.id);setNewAttemptRequired(value.needsNew===true);}}const old=localStorage.getItem(requestKey);if(old){const value=JSON.parse(old);if(typeof value.key!=='string'||typeof value.runId!=='string')throw new Error('原视频请求记录无法确认，请保留页面。');setOriginal(value);setSelectedRunId(value.runId);}const ai=localStorage.getItem(aiKey);if(ai){const value=JSON.parse(ai);if(typeof value.requestId!=='string')throw new Error('原文案请求记录无法确认。');setAiPending({...value,edit:-1});}}catch(cause){if(active(captured)){setDraftBlocked(true);setMessage(cause instanceof Error?cause.message:'草稿暂不可恢复。');}}})();
    return()=>{cancelled=true;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope,api]);
  useEffect(()=>{if(!hydrated)return;setParameters(value=>value.ratio===props.ratio?value:{...value,ratio:props.ratio});},[props.ratio,hydrated]);
  useEffect(()=>{const captured=scope;void api<{projects:Array<{id:string;name:string}>}>('/api/projects?lite=true').then(value=>{if(active(captured))setProjects(value.projects||[]);}).catch(()=>undefined);},[scope,api,active]);
  useEffect(()=>{setCards([]);if(!parameters.project_id)return;const captured=scope;void api<{cards?:Array<{id:string;title:string}>;videoCards?:Array<{id:string;title:string}>}>(`/api/projects/${encodeURIComponent(parameters.project_id)}/video-cards`).then(value=>{if(active(captured))setCards(value.cards||value.videoCards||[]);}).catch(()=>undefined);},[scope,parameters.project_id,api,active]);
  async function saveDraft(){
    if(!props.work||!hydrated||saveLock.current||draftBlocked)return null;
    if(saved.current===content&&draftRef.current)return draftRef.current;
    const captured=scope,frozen=input.current,revision=draftRef.current?.revision||0,signature=JSON.stringify([frozen.text,frozen.parameters,props.work.draftRevision]);
    saveLock.current=true;setSaving(true);
    try{const result=await api<{draft:MultiviewActionDraft}>('/api/video/multiview/actions/drafts',{workId:props.work.id,draftId:draftRef.current?.id,revision,text:frozen.text,parameters:frozen.parameters});if(!active(captured))return null;setDraft(result.draft);draftRef.current=result.draft;saved.current=signature;return result.draft;}
    catch(cause){if(active(captured)){setDraftBlocked(true);setMessage(cause instanceof Error?cause.message:'动作保存未完成，当前输入保留。');}return null;}
    finally{saveLock.current=false;if(active(captured))setSaving(false);}
  }
  useEffect(()=>{if(!hydrated||draftBlocked||saving||saved.current===content)return;const timer=setTimeout(()=>void saveDraft(),550);return()=>clearTimeout(timer);});
  useEffect(()=>{
    if(newAttemptRequired||!hydrated||!draft||saved.current!==content||!text.trim()||!parameters.project_id||!props.outputReady||!state?.capabilities.actionReady||original&&!original.taskId){setQuote(null);return;}
    const captured=scope,key=quoteKey;let cancelled=false;setQuoting(true);setQuoteError('');
    const timer=setTimeout(()=>{void (async()=>{try{
      const final=await api<{run:MultiviewActionRun;binding:MultiviewActionBinding}>('/api/video/multiview/actions/final',{draftId:draft.id,revision:draft.revision,text,parameters,attemptId,...(appliedRunId?{sourceRunId:appliedRunId}:{})});
      if(cancelled||!active(captured)||currentQuoteKey.current!==key)return;
      const quoted=await api<{estimatedCost:number;pricing_revision:string;pricing_quote_token:string;multiviewAction?:MultiviewActionBinding}>('/api/tasks/estimate',{...parameters,provider:'seedance',generation_mode:'first_last_frame',prompt:text,multiview_action:final.binding});
      if(cancelled||!active(captured)||currentQuoteKey.current!==key)return;
      if(typeof quoted.estimatedCost!=='number'||!Number.isFinite(quoted.estimatedCost)||!quoted.pricing_quote_token)throw new Error('本次费用尚未确认。');
      setQuote({key,run:final.run,binding:final.binding,points:quoted.estimatedCost,pricingRevision:quoted.pricing_revision,token:quoted.pricing_quote_token});
    }catch(cause){if(!cancelled&&active(captured))setQuoteError(cause instanceof Error?cause.message:'视频报价暂不可用。');}finally{if(!cancelled&&active(captured))setQuoting(false);}})();},550);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[quoteKey,quoteRetry,hydrated,draft,content,text,parameters,props.outputReady,state?.capabilities.actionReady,newAttemptRequired,original?.key,original?.taskId,scope,active,api]);
  async function organize(){
    if(aiLock.current||aiPending||!state?.capabilities.llmEnabled||!text.trim())return;
    const savedDraft=await saveDraft();if(!savedDraft)return;
    const pending={requestId:crypto.randomUUID(),edit:editRevision.current};aiLock.current=true;setAiBusy(true);setMessage('');
    try{localStorage.setItem(aiKey,JSON.stringify({requestId:pending.requestId}));setAiPending(pending);const value=await api<{run:MultiviewActionRun}>('/api/video/multiview/actions/runs',{draftId:savedDraft.id,revision:savedDraft.revision,requestId:pending.requestId,llmModel});if(active())setAiPending({...pending,runId:value.run.id});}
    catch(cause){if(active())setMessage('文案提交结果待确认，请查询原请求。');}
    finally{aiLock.current=false;setAiBusy(false);}
  }
  const consumeAi=useCallback((run:MultiviewActionRun,pending:{requestId:string;runId?:string;edit:number})=>{
    if(!finished.has(run.status)&&run.status!=='uncertain')return;
    if(run.status==='succeeded'&&run.text){if(editRevision.current===pending.edit){setBeforeAi(input.current.text);setAppliedRunId(run.id);setText(run.text);editRevision.current++;setMessage('动作已整理。');}else setSuggestion(run);}
    else setMessage(run.error|| (run.status==='uncertain'?'文案发送结果待确认，请保留原请求，不会自动重试。':'文案未完成，原动作保留。'));
    if(run.status!=='uncertain'){setAiPending(null);localStorage.removeItem(aiKey);}
  },[aiKey]);
  async function queryAi(manual=true){if(!aiPending)return;if(manual)aiPoll.current={key:aiPending.requestId,count:0};try{const value=await api<{run:MultiviewActionRun|null}>(aiPending.runId?`/api/video/multiview/actions/runs/${aiPending.runId}`:`/api/video/multiview/actions/runs?requestId=${encodeURIComponent(aiPending.requestId)}`);if(!active())return;if(value.run){setAiPending({...aiPending,runId:value.run.id});consumeAi(value.run,aiPending);}else setMessage('原文案尚未查到，继续保留原号。');}catch(cause){if(active())setMessage(cause instanceof Error?cause.message:'原文案暂不可查询。');}}
  useEffect(()=>{if(!aiPending)return;if(aiPoll.current.key!==aiPending.requestId)aiPoll.current={key:aiPending.requestId,count:0};if(aiPoll.current.count>=12)return;const timer=setTimeout(()=>{aiPoll.current.count++;void queryAi(false);},4000);return()=>clearTimeout(timer);});
  async function queryOriginal(manual=true){if(!original)return;if(manual)videoPoll.current={key:original.key,count:0};const captured=scope;try{const value=await api<{task:{id:string}|null;new_request_allowed?:boolean;request_receipt?:{key?:string;state?:string;accepted?:boolean;message?:string}}>(`/api/tasks/request-status?idempotency_key=${encodeURIComponent(original.key)}`);if(!active(captured))return;if(value.task){const next={...original,taskId:value.task.id};setOriginal(next);localStorage.setItem(requestKey,JSON.stringify(next));await refresh();}else if(value.new_request_allowed===true&&value.request_receipt?.state==='rejected'&&value.request_receipt.accepted===false&&value.request_receipt.key===original.key){setOriginal(null);setNewAttemptRequired(true);localStorage.setItem(attemptKey,JSON.stringify({id:attemptId,needsNew:true}));localStorage.removeItem(requestKey);setMessage(value.request_receipt.message||'本次未受理，请调整后重新确认费用。');}else setMessage('提交结果待确认，原请求尚未查到，不会重新提交。');}catch(cause){if(active(captured))setMessage('原请求暂不可查询，保留最后已知状态。');}}
  useEffect(()=>{if(!hydrated||!props.work)return;const waiting=original&&!original.taskId||state?.runs.some(run=>['queued','running'].includes(run.status)||run.tasks.some(task=>!finished.has(task.status)));if(!waiting)return;if(original&&!original.taskId){if(videoPoll.current.key!==original.key)videoPoll.current={key:original.key,count:0};if(videoPoll.current.count>=12)return;}const timer=setTimeout(()=>{if(original&&!original.taskId){videoPoll.current.count++;void queryOriginal(false);}else void refresh().catch(()=>undefined);},5000);return()=>clearTimeout(timer);});
  async function submit(){
    if(submitLock.current||!currentQuote||!props.outputReady)return;
    const frozen=currentQuote,captured=scope,keyAtClick=quoteKey;submitLock.current=true;setSubmitting(true);setMessage('');
    let retained=false;
    try{
      const requestId=`multiview-action:${frozen.binding.runId}`;
      const body:Record<string,unknown>={...parameters,provider:'seedance',generation_mode:'first_last_frame',prompt:frozen.run.text,multiview_action:frozen.binding,idempotency_key:requestId,creation_contract_version:2,entry:'multiview',action:'generate',continuation:{mode:'new'},count:1,video_branch_id:null,baseline_task_id:baseline,max_estimated_cost:frozen.points,pricing_revision:frozen.pricingRevision,pricing_quote_token:frozen.token,pricing_fingerprint_version:2};
      const previous=creation.intent&&!['accepted','closed','rejected'].includes(creation.intent.state)?creation.intent:null;
      const prepared=await creation.prepare(body,requestId,previous);
      if(!active(captured)||currentQuoteKey.current!==keyAtClick)throw new Error('输入已变化，请重新确认当前费用。');
      if(!prepared.availability?.canSubmit){setConfirming(false);setMessage('请完成下方创作条件，当前动作保留。');return;}
      if(!prepared.quote||prepared.quote.estimated_cost!==frozen.points||prepared.quote.pricing_revision!==frozen.pricingRevision){setConfirming(false);setQuoteRetry(value=>value+1);throw new Error('费用已变化，请核对新报价后生成。');}
      Object.assign(body,{intent_id:prepared.id,intent_revision:prepared.revision,resolution_approval_id:prepared.approval_id||null,pricing_quote_token:prepared.quote.pricing_quote_token||frozen.token});
      const pending:Original={key:requestId,runId:frozen.binding.runId,taskId:null};localStorage.setItem(requestKey,JSON.stringify(pending));setOriginal(pending);retained=true;setConfirming(false);setSelectedRunId(frozen.binding.runId);
      const result=await api<{id?:string;task_id?:string;existing_task_id?:string}>('/api/tasks/create',body);if(!active(captured))return;
      const taskId=result.id||result.task_id||result.existing_task_id;
      if(!taskId)throw new Error('提交结果待确认，原请求已保留。');
      const accepted={...pending,taskId};setOriginal(accepted);localStorage.setItem(requestKey,JSON.stringify(accepted));await refresh();props.onView('video');
    }catch(cause){if(active(captured)){const result=(cause as {result?:{new_request_allowed?:boolean;request_receipt?:{key?:string;state?:string;accepted?:boolean;message?:string}}})?.result,receipt=result?.request_receipt;if(retained&&result?.new_request_allowed===true&&receipt?.state==='rejected'&&receipt.accepted===false&&receipt.key===`multiview-action:${frozen.binding.runId}`){setOriginal(null);setNewAttemptRequired(true);localStorage.removeItem(requestKey);localStorage.setItem(attemptKey,JSON.stringify({id:attemptId,needsNew:true}));setMessage(receipt.message||'本次未受理，当前输入保留。');}else setMessage(retained?'提交结果待确认，请查询原请求，不会重复提交。':cause instanceof Error?cause.message:'尚未提交，当前输入保留。');}}
    finally{submitLock.current=false;if(active(captured))setSubmitting(false);}
  }
  function newAttempt() { if (original && !original.taskId) return false; const id=crypto.randomUUID(); try { localStorage.setItem(attemptKey,JSON.stringify({id,needsNew:false}));setAttemptId(id);setNewAttemptRequired(false);setOriginal(null);localStorage.removeItem(requestKey);setQuote(null);return true; } catch {setMessage('新操作编号未能保存，尚未准备新的生成。');return false;} }
  const applyParameters=(patch:Partial<MultiviewActionParameters>)=>{editRevision.current++;setParameters(value=>({...value,...patch}));setConfirming(false);};
  const showVideo=props.activeView==='video';
  return <>
    {showVideo&&<div className={styles.videoResult}>{selectedTask?.playUrl?<video key={selectedTask.taskId} controls playsInline preload="metadata" src={selectedTask.playUrl} onLoadedMetadata={event=>event.currentTarget.pause()}/>:<p className={styles.notice}>{original&&!original.taskId?'提交结果待确认':selectedTask?`视频${({queued:'排队中',running:'生成中',processing:'生成中',failed:'生成失败',cancelled:'已取消'} as Record<string,string>)[selectedTask.status]||selectedTask.status}`:'选择下方视频记录'}</p>}{selectedTask&&<div className={styles.taskId}><code>{selectedTask.taskId}</code><button aria-label="复制完整视频编号" onClick={()=>void navigator.clipboard.writeText(selectedTask.taskId).then(()=>setMessage('已复制视频编号。')).catch(()=>setMessage('复制未完成，请选择编号复制。'))}><Copy size={14}/></button></div>}{selectedTask?.downloadUrl&&<a href={selectedTask.downloadUrl} download>下载视频</a>}<div className={styles.history}>{state?.runs.filter(run=>run.tasks.length).map(run=><button key={run.id} aria-pressed={selectedRunId===run.id} onClick={()=>setSelectedRunId(run.id)}>{seedanceVideoModelLabel(run.parameters.model)} · <RelativeTime value={run.createdAt}/></button>)}{state?.nextCursor&&<button onClick={()=>void refresh(false,state.nextCursor!)}>加载更多</button>}</div></div>}
    <aside className={styles.action} aria-label="同步动作视频">
      <h3>动作</h3>
      {showVideo&&selectedRun?<><p className={styles.frozenText}>{selectedRun.text}</p><p className={styles.notice}>{seedanceVideoModelLabel(selectedRun.parameters.model)} · {selectedRun.parameters.duration} 秒 · {selectedRun.parameters.resolution}</p><button onClick={()=>{if(!newAttempt())return;updateText(selectedRun.text||'');setParameters(selectedRun.parameters);props.onView('reference');}}>修改动作再做</button></>:<>
        <textarea aria-label="动作" placeholder="例如：原地挥拳三次，从轻到重。" maxLength={12000} value={text} disabled={!hydrated} onChange={event=>updateText(event.target.value)}/>
        <div className={styles.compact}><button type="button" disabled={!state?.capabilities.llmEnabled||!text.trim()||aiBusy||Boolean(aiPending)||saving||draftBlocked} onClick={()=>void organize()}>{aiPending?'正在整理…':'AI整理动作'}</button><select aria-label="文案模型" value={llmModel} onChange={event=>setLlmModel(event.target.value)}>{state?.capabilities.llmModels.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select>{beforeAi!==null&&<button onClick={()=>{updateText(beforeAi);setAppliedRunId(undefined);setBeforeAi(null);}}>撤销整理</button>}</div>
        {!state?.capabilities.llmEnabled&&state?.capabilities.llmReason&&<p className={styles.notice}>{state.capabilities.llmReason}</p>}
        {state?.capabilities.billingLabel&&<p className={styles.notice}>{state.capabilities.billingLabel}</p>}
        {aiPending&&<button onClick={()=>void queryAi()}>查询原文案</button>}
        {suggestion&&<div className={styles.notice}><p>新整理已就绪，当前动作保留。</p><button onClick={()=>{setBeforeAi(text);setAppliedRunId(suggestion.id);updateText(suggestion.text||'');setSuggestion(null);}}>使用此整理</button><button onClick={()=>setSuggestion(null)}>保留当前动作</button></div>}
        {state?.runs.find(run=>run.mode==='llm'&&run.status==='succeeded')&&<details><summary>原需求与整理记录</summary>{state.runs.filter(run=>run.mode==='llm').map(run=><div key={run.id}><p className={styles.frozenText}>{run.inputText}</p><button disabled={!run.text} onClick={()=>updateText(run.inputText)}>使用原需求</button><button disabled={!run.text} onClick={()=>updateText(run.text||'')}>使用整理</button></div>)}</details>}
        <div className={styles.compact}>{(['format','sync'] as const).map(kind=><button className={styles.ruleLink} key={kind} disabled={!state?.capabilities.rules[kind].canEdit} onClick={()=>setContext(kind)}>{kind==='format'?'动作格式':'镜头与同步'} · 编辑</button>)}</div>
        <div className={`${styles.compact} ${styles.params}`}><select aria-label="视频型号" value={parameters.model} onChange={event=>applyParameters({model:event.target.value})}>{SEEDANCE_VIDEO_MODEL_OPTIONS.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select><select aria-label="视频时长" value={parameters.duration} onChange={event=>applyParameters({duration:Number(event.target.value)})}>{seedanceVideoDurationOptions(parameters.model).map(duration=><option key={duration} value={duration}>{duration} 秒</option>)}</select><select aria-label="分辨率" value={parameters.resolution} onChange={event=>applyParameters({resolution:event.target.value as MultiviewActionParameters['resolution']})}>{['480p','720p','1080p'].map(value=><option key={value}>{value}</option>)}</select><select aria-label="项目" name="project_id" value={parameters.project_id} onChange={event=>applyParameters({project_id:event.target.value,video_card_id:null})}><option value="">选择项目</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select><select aria-label="视频卡，可选" name="video_card_id" value={parameters.video_card_id||''} onChange={event=>applyParameters({video_card_id:event.target.value||null})}><option value="">视频卡（可选）</option>{cards.map(card=><option key={card.id} value={card.id}>{card.title}</option>)}</select></div>
        <CreationAvailability controller={creation} onBaselineChange={setBaseline}/>
        {state&&!state.capabilities.actionReady&&<p className={styles.notice}>{state.capabilities.actionReason}</p>}
        {!props.outputReady&&<p className={styles.notice}>参考拼图准备中，动作可继续编辑。</p>}
        <div className={styles.price}>{currentQuote?<>预计 <strong>{currentQuote.points} 点</strong></>:quoting?'视频费用获取中…':quoteError||'视频费用待准备'}</div>
        {newAttemptRequired&&<button onClick={newAttempt}>重新准备生成</button>}
        {quoteError&&<button onClick={()=>setQuoteRetry(value=>value+1)}>重新报价</button>}
        <button className={styles.primary} disabled={!currentQuote||submitting||Boolean(original&&!original.taskId)||draftBlocked} onClick={()=>setConfirming(true)}>{submitting?'正在受理…':'生成视频'}</button>
      </>}
      {original&&!original.taskId&&<p className={styles.notice}>提交结果待确认 <button onClick={()=>void queryOriginal()}>查询原请求</button></p>}
      {original?.taskId&&<div className={styles.taskId}><code>{original.taskId}</code><button aria-label="复制完整任务编号" onClick={()=>void navigator.clipboard.writeText(original.taskId!).catch(()=>setMessage('复制未完成，请选择编号复制。'))}><Copy size={14}/></button></div>}
      {saving&&<p className={styles.notice}>正在保存动作…</p>}
      {draftBlocked&&<button onClick={async()=>{try{await refresh();setDraftBlocked(false);const latest=await api<MultiviewActionState>(`/api/video/multiview/actions?workId=${props.work!.id}`);if(active()){setDraft(latest.draft);draftRef.current=latest.draft;setMessage('服务器版本已核对，当前文字保留，请继续保存。');}}catch(cause){setMessage(cause instanceof Error?cause.message:'暂不可读取。');}}}>核对最新并保留我的草稿</button>}
      {message&&<p className={styles.notice} role="status">{message}</p>}
    </aside>
    {context&&<RuleDialog key={`${scope}:${context}`} kind={context} ownerId={props.ownerId} onClose={()=>setContext(null)} onSaved={()=>{setQuote(null);void refresh().catch(()=>undefined);}}/>}
    {confirming&&currentQuote&&<ConfirmDialog quote={currentQuote} parameters={parameters} busy={submitting} onClose={()=>setConfirming(false)} onConfirm={()=>void submit()}/>}
  </>;
}
