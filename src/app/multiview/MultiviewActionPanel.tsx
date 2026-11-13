'use client';
import { usePricingModelAvailability } from '@/lib/pricing/use-model-availability';
import { ProjectSelector } from '@/components/ProjectSelector';
import { useProjectCatalogRevision } from '@/lib/projects/selector-client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, RefreshCw, X } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { PrivateDefinitionEditor } from '@/app/image-studio/PrivateDefinitionEditor';
import { isResolvedCreationIntent, useCreationContext } from '@/lib/hooks/use-creation-context';
import CreationAvailability from '@/components/creation/CreationAvailability';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { SEEDANCE_VIDEO_MODEL_OPTIONS, DEFAULT_SEEDANCE_VIDEO_MODEL_ID, seedanceVideoDurationOptions, seedanceVideoModelLabel } from '@/lib/provider/seedance-models';
import type { MultiviewWorkDto } from '@/lib/video/multiview-work-contract';
import { parseMultiviewActionBinding, type MultiviewActionBinding, type MultiviewActionDraft, type MultiviewActionRun, type MultiviewActionState, type MultiviewActionParameters, type MultiviewActionContextKind } from '@/lib/video/multiview-action-contract';
import type { VideoCreationIntentDTO } from '@/lib/creation/contract';
import { parseMultiviewActionInput, type MultiviewActionRestore } from '@/lib/video/multiview-action-restore-contract';
import styles from './multiview-action.module.css';
import { MultiviewVideoResults } from './MultiviewVideoResults';

export type MultiviewActionInput={text:string;parameters:MultiviewActionParameters};
type Props = { inputError?:string; referenceChanged?:boolean; initialInput?:MultiviewActionInput; onChangeOriginal?:(input:MultiviewActionInput)=>void; hasReferenceDraft?:boolean; onResumeDraft?:()=>void; restored?: MultiviewActionRestore; onSelectVideo?: (id: string) => Promise<boolean>; active?: boolean; ownerId: string; authority: string; work: MultiviewWorkDto | null; videoDefaults?: {model:string;duration:number;resolution:string;projectId:string;videoCardId:string|null}; outputReady: boolean; snapshotKey: string; onPrepare(): Promise<MultiviewWorkDto>; ratio: '16:9'|'9:16'|'1:1'; activeView: 'reference'|'video'; onView(value: 'reference'|'video'): void };
type Quote = { key: string; text: string; parameters: MultiviewActionParameters; points: number | null; pricingRevision: string | null; token?: string };
type Original = { key: string; runId: string; taskId: string | null };
type AiRequest = { requestId: string; runId?: string; edit: number; status?: string; model?: string; referenceImage?: boolean };
type AiJournal = { current: AiRequest | null; retained: AiRequest[] };
const finished = new Set(['succeeded','failed','cancelled','canceled','completed','error']);
function RuleDialog({ kind, ownerId, onClose, onSaved }: { kind: MultiviewActionContextKind; ownerId: string; onClose(): void; onSaved(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), before = useRef<(() => Promise<boolean>) | null>(null);
  const titleId = useId();
  const close = async () => { if (!before.current || await before.current()) onClose(); };
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: () => void close() });
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}><header><h2 id={titleId}>{kind === 'format' ? '动作格式' : '镜头与同步'}</h2><button type="button" aria-label="关闭规则编辑" onClick={()=>void close()}><X size={18}/></button></header><PrivateDefinitionEditor dialogPlacement="center" userId={ownerId} moduleId={kind} endpoint={`/api/video/multiview/actions/contexts/${kind}`} dialog={dialog} beforeClose={before} open blocked={false} canRead needsIdentity={false} contextOnly label={kind==='format'?'动作格式':'镜头与同步'} maxLength={12000} onSaved={(_,keepEditing)=>{onSaved();if(!keepEditing)onClose();}} /></dialog>, document.body);
}
function ConfirmDialog({ quote, parameters, busy, onClose, onConfirm }: { quote: Quote; parameters: MultiviewActionParameters; busy: boolean; onClose(): void; onConfirm(): void }) {
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  const close=()=>{if(!busy)onClose();};
  useDialogDismiss({open:true,dialogRef:dialog,nativeDialog:true,onDismiss:close});
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-busy={busy}><header><h2 id={titleId}>生成动作视频</h2><button disabled={busy} aria-label="关闭费用确认" onClick={close}><X size={18}/></button></header><p>{seedanceVideoModelLabel(parameters.model)} · {parameters.duration} 秒 · {parameters.resolution} · {parameters.ratio}</p><p className={styles.frozenText}>{quote.text}</p><p className={styles.price}>{quote.points===null?'费用待确认':<>本次预计 <strong>{quote.points} 点</strong></>}</p><footer><button disabled={busy} onClick={close}>返回修改</button><button disabled={busy} onClick={onConfirm}>{busy?'正在准备…':quote.points===null?'继续':'确认生成'}</button></footer></dialog>,document.body);
}
export function MultiviewActionPanel(props: Props) {
  const { isAvailable: modelAvailable, reason: modelAvailabilityReason, refresh: refreshAvailability } = usePricingModelAvailability();
  const { confirm, productDialog } = useProductDialog({ placement: 'center' });
  const [state,setState]=useState<MultiviewActionState|null>(null),[draft,setDraft]=useState<MultiviewActionDraft|null>(null);
  const [text,setText]=useState('');
  const [referenceImage,setReferenceImage]=useState(false);
  const [parameters,setParameters]=useState<MultiviewActionParameters>({provider:'seedance',model:DEFAULT_SEEDANCE_VIDEO_MODEL_ID,duration:12,resolution:'720p',ratio:props.ratio,project_id:props.videoDefaults?.projectId||props.work?.projectId||'',video_card_id:props.videoDefaults?.videoCardId||props.work?.videoCardId||null});
  const [projects,setProjects]=useState<Array<{id:string;name:string}>>([]),[cards,setCards]=useState<Array<{id:string;title:string}>>([]);
  const [hydrated,setHydrated]=useState(false),[saving,setSaving]=useState(false),[draftBlocked,setDraftBlocked]=useState(false);
  const [message,setMessage]=useState(''),[quoteError,setQuoteError]=useState(''),[quote,setQuote]=useState<Quote|null>(null),[quoting,setQuoting]=useState(false);
  const [llmModel,setLlmModel]=useState(''),[llmModels,setLlmModels]=useState<Array<{id:string;label:string}>>([]),[modelsBusy,setModelsBusy]=useState(false),[modelMessage,setModelMessage]=useState('');
  const [aiJournal,setAiJournal]=useState<AiJournal>({current:null,retained:[]}),[aiBusy,setAiBusy]=useState(false),[suggestion,setSuggestion]=useState<MultiviewActionRun|null>(null),[beforeAi,setBeforeAi]=useState<string|null>(null);
  const aiPending=aiJournal.current,aiJournalRef=useRef(aiJournal);
  const referenceKeyRef=useRef(props.snapshotKey),aiReferenceKeyRef=useRef<{requestId:string;key:string}|null>(null);referenceKeyRef.current=props.snapshotKey;
  const [context,setContext]=useState<MultiviewActionContextKind|null>(null),[confirming,setConfirming]=useState(false),[submitting,setSubmitting]=useState(false);
  const [original,setOriginal]=useState<Original|null>(null),[selectedRunId,setSelectedRunId]=useState(''),[baseline,setBaseline]=useState<string|null>(null);
  const [quoteRetry,setQuoteRetry]=useState(0);
  const [attemptId,setAttemptId]=useState('initial'),[newAttemptRequired,setNewAttemptRequired]=useState(false);
  const [appliedRunId,setAppliedRunId]=useState<string|undefined>();
  const aiPoll=useRef({key:'',count:0}),videoPoll=useRef({key:'',count:0});
  const modelController=useRef<AbortController|null>(null);
  const scope=`${props.ownerId}:${props.authority}:${props.work?.id||''}`;
  const liveScope=useRef(scope);liveScope.current=scope;
  const workRef=useRef(props.work);workRef.current=props.work;
  const input=useRef({text,parameters});input.current={text,parameters};
  const editRevision=useRef(0), saved=useRef(''),draftRef=useRef(draft);draftRef.current=draft;
  const saveInFlight=useRef<Promise<{draft:MultiviewActionDraft}>|null>(null);
  const saveLock=useRef(false),submitLock=useRef(false),aiLock=useRef(false);
  const requestKey=`sd2:multiview-action-request:v1:${props.ownerId}:${props.work?.id||'pending'}`;
  const attemptKey=requestKey+':attempt';
  const legacyAiKey=`sd2:multiview-action-text-request:v1:${props.ownerId}:${props.work?.id||'pending'}`;
  const aiKey=`sd2:multiview-action-text-request:v2:${props.ownerId}:${props.work?.id||'pending'}`;
  const modelKey=`sd2:multiview-action-llm:v1:${props.ownerId}`;
  const projectCatalogRevision = useProjectCatalogRevision();
  const active=useCallback((value=scope)=>liveScope.current===value&&!isClientSessionBlocked(),[scope]);
  const headers=useCallback(()=>({'Content-Type':'application/json','x-app-session-user':props.ownerId}),[props.ownerId]);
  const api=useCallback(async<T,>(url:string,body?:unknown,method='POST',signal?:AbortSignal):Promise<T>=>{const response=await fetch(url,{method:body===undefined?'GET':method,cache:'no-store',headers:headers(),...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal||AbortSignal.timeout(45000)});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||value.message||'暂时无法完成，当前输入保留。'),{status:response.status,result:value});return value as T;},[headers]);
  const creation=useCreationContext({ownerId:props.ownerId,entry:'multiview',draftId:`action:${props.work?.id||'preparing'}`,projectId:parameters.project_id||null,legacyCardId:parameters.video_card_id,enabled:Boolean(hydrated&&parameters.project_id),onProjectChange:id=>setParameters(value=>({...value,project_id:id}))});
  useEffect(()=>{setLlmModels([]);setModelMessage('');try{setLlmModel(localStorage.getItem(modelKey)||'');}catch{setLlmModel('');setModelMessage('模型选择暂不能在本机记住，当前仍可选择。');}},[modelKey]);
  const loadModels=useCallback(async(force=false)=>{
    const captured=scope;modelController.current?.abort();const controller=new AbortController();modelController.current=controller;const timeout=setTimeout(()=>controller.abort(),45000);setModelsBusy(true);setModelMessage('');
    try{const value=await api<{models:Array<{id:string;label:string}>;default:string}>(`/api/llm/models${force?'?refresh=1':''}`,undefined,'GET',controller.signal);if(!active(captured)||modelController.current!==controller)return;
      if(!Array.isArray(value.models)||typeof value.default!=='string')throw new Error('模型目录读取失败，原选择已保留。');
      setLlmModels(value.models);setLlmModel(current=>current||value.default);if(force)setModelMessage(value.models.length?'模型目录已更新。':'模型目录已更新，当前没有可用型号。');
    }catch(cause){if(active(captured)&&modelController.current===controller)setModelMessage(controller.signal.aborted?'模型更新超时，原目录和选择已保留。':cause instanceof Error?cause.message:'模型更新失败，原选择已保留。');}
    finally{clearTimeout(timeout);if(active(captured)&&modelController.current===controller)setModelsBusy(false);}
  },[scope,api,active]);
  useEffect(()=>{void loadModels();const refresh=()=>{if(document.visibilityState!=='hidden')void loadModels();};window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);return()=>{modelController.current?.abort();modelController.current=null;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};},[loadModels]);
  function rememberModel(model:string){setLlmModel(model);try{localStorage.setItem(modelKey,model);}catch{setModelMessage('模型选择暂不能在本机记住，当前选择仍可使用。');}}
  function keepAiJournal(value:AiJournal){localStorage.setItem(aiKey,JSON.stringify(value));aiJournalRef.current=value;setAiJournal(value);}
  const modelOptions=llmModels.filter(model=>modelAvailable('text',model.id));
  const llmReady=modelOptions.some(model=>model.id===llmModel);
  const [videoDraft,setVideoDraft]=useState<{text:string;parameters:MultiviewActionParameters;referenceImage?:boolean}|null>(null);
  const videoInputKey=props.restored ? `sd2:multiview-action-video-input:v1:${props.ownerId}:${props.restored.taskId}` : requestKey+':input';
  const restoredInput=useRef('');
  const initialInputApplied=useRef(false);
  useEffect(()=>{if(!hydrated||!props.initialInput||initialInputApplied.current)return;initialInputApplied.current=true;updateText(props.initialInput.text);setParameters({...props.initialInput.parameters,ratio:props.ratio});},[hydrated,props.initialInput,props.ratio]);
  useEffect(()=>{
    if(!hydrated||!props.restored||restoredInput.current===props.restored.taskId)return;
    restoredInput.current=props.restored.taskId;
    try { const raw=localStorage.getItem(videoInputKey); if(raw){const previous=JSON.parse(raw);if(parseMultiviewActionInput(previous)&&JSON.stringify([previous.text,previous.parameters])!==JSON.stringify([props.restored.text,props.restored.parameters]))setVideoDraft(previous);} }
    catch {setDraftBlocked(true);setMessage('该版修改草稿暂不可读取，当前输入保留。');return;}
    updateText(props.initialInput?.text??props.restored.text);setParameters(props.initialInput?{...props.initialInput.parameters,ratio:props.ratio}:props.restored.parameters);setAppliedRunId(undefined);setSuggestion(null);setBeforeAi(null);setReferenceImage(false);
  },[hydrated,props.restored,videoInputKey]);
  const content=JSON.stringify([text,parameters,props.work?.draftRevision]);
  const quoteKey=JSON.stringify([scope,content,props.snapshotKey,state?.capabilities.rules.sync.revision,state?.capabilities.rules.format.revision,appliedRunId,attemptId]);
  const currentQuote=quote?.key===quoteKey?quote:null;
  const confirmationQuote:Quote=currentQuote||{key:quoteKey,text:text.trim(),parameters:{...parameters},points:null,pricingRevision:null};
  const currentQuoteKey=useRef(quoteKey);currentQuoteKey.current=quoteKey;
  const selectedRun=state?.runs.find(run=>run.id===selectedRunId)||null;
  const selectedTask=selectedRun?.tasks[0]||null;
  const updateText=(value:string)=>{editRevision.current++;setText(value);setConfirming(false);};
  async function refresh(adopt=false,cursor?:string){
    if(!props.work)return;
    const captured=scope;
    const tasks = state?.runs.flatMap(run=>run.tasks) || [];
    const task = tasks.find(task=>task.taskId===original?.taskId || task.taskId===selectedTask?.taskId) || tasks.find(task=>!finished.has(task.status));
    if (!cursor && task && !finished.has(task.status)) {
      await api(`/api/video/status/${encodeURIComponent(task.taskId)}`).catch(()=>{if(active(captured))setMessage('原任务状态暂未更新，保留最后已知结果。');});
      if (!active(captured)) return;
    }
    const value=await api<MultiviewActionState>(`/api/video/multiview/actions?workId=${props.work.id}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
    if(!active(captured))return;
    setState(previous=>cursor&&previous?{...value,runs:[...previous.runs,...value.runs.filter(run=>!previous.runs.some(item=>item.id===run.id))]}:value);
    if(!selectedRunId){const newest=value.runs.find(run=>run.tasks.length);if(newest)setSelectedRunId(newest.id);}
    if(adopt){setDraft(value.draft);draftRef.current=value.draft;if(value.draft){setText(value.draft.text);setParameters({...value.draft.parameters,ratio:props.ratio});saved.current=JSON.stringify([value.draft.text,value.draft.parameters,props.work.draftRevision]);}setHydrated(true);}
  }
  useEffect(()=>{
    setState(null);setDraft(null);draftRef.current=null;setText('');setReferenceImage(false);setQuote(null);setHydrated(false);setOriginal(null);setMessage('');setAiJournal({current:null,retained:[]});aiJournalRef.current={current:null,retained:[]};saved.current='';
    const captured=scope;let cancelled=false;
    if(!props.work)return;
    setParameters(value=>({...value,ratio:props.ratio,project_id:props.videoDefaults?.projectId||props.work?.projectId||'',video_card_id:props.videoDefaults?.videoCardId||props.work?.videoCardId||null}));
    void (async()=>{try{await refresh(true);if(cancelled||!active(captured))return;const local=localStorage.getItem(requestKey+':input');if(local&&!props.restored){const value=JSON.parse(local);if(typeof value.text==='string'&&value.parameters&&typeof value.parameters==='object'){setText(value.text);setReferenceImage(value.referenceImage===true);setParameters({...value.parameters,ratio:props.ratio});}}const attempt=localStorage.getItem(attemptKey);if(attempt){const value=JSON.parse(attempt);if(value.id==='initial'||/^[a-f0-9-]{36}$/i.test(value.id)){setAttemptId(value.id);setNewAttemptRequired(value.needsNew===true);}}const old=localStorage.getItem(requestKey);if(old){const value=JSON.parse(old);if(typeof value.key!=='string'||typeof value.runId!=='string')throw new Error('原视频请求记录无法确认，请保留页面。');setOriginal(value);setSelectedRunId(value.runId);}const ai=localStorage.getItem(aiKey)||localStorage.getItem(legacyAiKey);if(ai){const value=JSON.parse(ai);const journal:AiJournal=typeof value.requestId==='string'?{current:value,retained:[]}:value;
      if(!journal||!Array.isArray(journal.retained)||[journal.current,...journal.retained].some(item=>item!==null&&(!item||typeof item.requestId!=='string'||item.runId!==undefined&&typeof item.runId!=='string')))throw new Error('原文案请求记录无法确认。');
      const restored={current:journal.current?{...journal.current,edit:-1}:null,retained:journal.retained.map(item=>({...item,edit:-1}))};aiJournalRef.current=restored;setAiJournal(restored);}}catch(cause){if(active(captured)){setDraftBlocked(true);setMessage(cause instanceof Error?cause.message:'草稿暂不可恢复。');}}})();
    return()=>{cancelled=true;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope,api]);
  useEffect(()=>{if(!hydrated)return;setParameters(value=>value.ratio===props.ratio?value:{...value,ratio:props.ratio});},[props.ratio,hydrated]);
  useEffect(()=>{
    if(!hydrated)return;
    try{if(props.restored&&(restoredInput.current!==props.restored.taskId||text===props.restored.text&&JSON.stringify(parameters)===JSON.stringify(props.restored.parameters)))return;localStorage.setItem(videoInputKey,JSON.stringify({text,parameters,referenceImage}));}
    catch{setDraftBlocked(true);setMessage('当前动作暂不能在本机保留，请保留页面。');}
  },[hydrated,videoInputKey,text,parameters,referenceImage,props.restored]);
  useEffect(()=>{const captured=scope;void api<{projects:Array<{id:string;name:string}>}>('/api/projects?lite=true').then(value=>{if(active(captured))setProjects(value.projects||[]);}).catch(()=>undefined);},[scope,api,active, projectCatalogRevision]);
  useEffect(()=>{setCards([]);if(!parameters.project_id)return;const captured=scope;void api<{cards?:Array<{id:string;title:string}>;videoCards?:Array<{id:string;title:string}>}>(`/api/projects/${encodeURIComponent(parameters.project_id)}/video-cards`).then(value=>{if(active(captured))setCards(value.cards||value.videoCards||[]);}).catch(()=>undefined);},[scope,parameters.project_id,api,active]);
  async function saveDraft(work=workRef.current,frozen=input.current){
    if(!work||!hydrated||saveLock.current||draftBlocked)return null;
    const captured=scope,revision=draftRef.current?.revision||0,signature=JSON.stringify([frozen.text,frozen.parameters,work.draftRevision]);
    if(saved.current===signature&&draftRef.current)return draftRef.current;
    saveLock.current=true;setSaving(true);
    try{const operation=api<{draft:MultiviewActionDraft}>('/api/video/multiview/actions/drafts',{workId:work.id,draftId:draftRef.current?.id,revision,text:frozen.text,parameters:frozen.parameters});saveInFlight.current=operation;const result=await operation;if(!active(captured))return null;setDraft(result.draft);draftRef.current=result.draft;saved.current=signature;return result.draft;}
    catch(cause){if(active(captured)){setDraftBlocked(true);setMessage(cause instanceof Error?cause.message:'动作保存未完成，当前输入保留。');}return null;}
    finally{saveInFlight.current=null;saveLock.current=false;if(active(captured))setSaving(false);}
  }
  useEffect(()=>{if(!hydrated||draftBlocked||saving||submitting||aiBusy||saved.current===content)return;const timer=setTimeout(()=>void saveDraft(),550);return()=>clearTimeout(timer);});
  useEffect(()=>{
    if(newAttemptRequired||!hydrated||!text.trim()||!parameters.project_id||!state?.capabilities.actionReady||original&&!original.taskId){setQuote(null);return;}
    const captured=scope,key=quoteKey;let cancelled=false;setQuoting(true);setQuoteError('');
    const timer=setTimeout(()=>{void (async()=>{try{
      const quoted=await api<{estimatedCost:number;pricing_revision:string;pricing_quote_token:string}>('/api/tasks/estimate',{...parameters,provider:'seedance',generation_mode:'first_last_frame',prompt:text});
      if(cancelled||!active(captured)||currentQuoteKey.current!==key)return;
      if(typeof quoted.estimatedCost!=='number'||!Number.isFinite(quoted.estimatedCost)||!quoted.pricing_quote_token)throw new Error('本次费用尚未确认。');
      setQuote({key,text:text.trim(),parameters:{...parameters},points:quoted.estimatedCost,pricingRevision:quoted.pricing_revision,token:quoted.pricing_quote_token});
    }catch(cause){if(!cancelled&&active(captured))setQuoteError(cause instanceof Error?cause.message:'视频报价暂不可用。');}finally{if(!cancelled&&active(captured))setQuoting(false);}})();},550);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[quoteKey,quoteRetry,hydrated,content,text,parameters,state?.capabilities.actionReady,newAttemptRequired,original?.key,original?.taskId,scope,active,api]);
  async function organize(){
    if(aiLock.current||aiPending&&aiPending.status!=='uncertain'||!state?.capabilities.llmEnabled||referenceImage&&(!state.capabilities.referenceImageEnabled||Boolean(props.inputError))||!llmReady||!text.trim())return;
    if(aiPending&&!await confirm('原文案结果仍未确认，原记录会保留，不会重发。继续将用当前所选模型新建一次整理，上游文字费用由平台承担。', {title:'新建一次动作整理',confirmLabel:'新建整理'}))return;
    rememberModel(llmModel);
    const sourceEdit=editRevision.current,frozen=input.current,withReference=referenceImage,sourceReferenceKey=props.snapshotKey,captured=scope;
    aiLock.current=true;setAiBusy(true);setMessage('');
    let retained=false;
    try{
      let preparedWork=workRef.current;
      if(withReference){setMessage('正在准备当前参考拼图…');preparedWork=await props.onPrepare();if(!active(captured))return;}
      const savedDraft=await saveDraft(preparedWork,frozen);if(!savedDraft||!active(captured))return;
      setMessage('');
      const pending:AiRequest={requestId:crypto.randomUUID(),edit:sourceEdit,model:llmModel,referenceImage:withReference};
      aiReferenceKeyRef.current=withReference?{requestId:pending.requestId,key:sourceReferenceKey}:null;
      const previous=aiJournalRef.current;
      keepAiJournal({current:pending,retained:previous.current?[...previous.retained,previous.current]:previous.retained});retained=true;
      const value=await api<{run:MultiviewActionRun}>(withReference?'/api/video/multiview/actions/reference-runs':'/api/video/multiview/actions/runs',{draftId:savedDraft.id,revision:savedDraft.revision,requestId:pending.requestId,llmModel,referenceImage:withReference});if(active(captured))consumeAi(value.run,pending);
    }catch(cause){if(active(captured)){
      if(!retained)setMessage(cause instanceof Error?cause.message.replace('尚未提交视频','尚未提交整理'):'参考拼图未能准备，尚未提交整理；当前输入保留。');
      else if((cause as {result?:{details?:{notAccepted?:boolean}}})?.result?.details?.notAccepted===true){keepAiJournal({...aiJournalRef.current,current:null});setMessage(cause instanceof Error?cause.message:'本次整理未受理，原动作保留。');}
      else setMessage('文案提交结果待确认，请查询原请求。');
    }}
    finally{aiLock.current=false;setAiBusy(false);}
  }
  function consumeAi(run:MultiviewActionRun,pending:AiRequest){
    const journal=aiJournalRef.current,isCurrent=journal.current?.requestId===pending.requestId;
    const next={...pending,runId:run.id,status:run.status,model:run.llmModel||pending.model};
    const done=finished.has(run.status);
    keepAiJournal({current:isCurrent?(done?null:next):journal.current,retained:journal.retained.flatMap(item=>item.requestId===pending.requestId?(done?[]:[next]):[item])});
    setState(value=>value?{...value,runs:[run,...value.runs.filter(item=>item.id!==run.id)]}:value);
    if(!done&&run.status!=='uncertain'){if(isCurrent)aiPoll.current.count=0;return;}
    if(run.status==='succeeded'&&run.text){if(isCurrent&&editRevision.current===pending.edit&&(!pending.referenceImage||aiReferenceKeyRef.current?.requestId===pending.requestId&&aiReferenceKeyRef.current?.key===referenceKeyRef.current)){setBeforeAi(input.current.text);setAppliedRunId(run.id);setText(run.text);editRevision.current++;setMessage('动作已整理。');}else setSuggestion(run);}
    else setMessage(run.error|| (run.status==='uncertain'?'文案发送结果待确认，请保留原请求，不会自动重试。':'文案未完成，原动作保留。'));
  }
  async function queryAi(manual=true,pending=aiJournalRef.current.current){if(!pending)return;if(manual)aiPoll.current={key:pending.requestId,count:0};try{const value=await api<{run:MultiviewActionRun|null}>(pending.runId?`/api/video/multiview/actions/runs/${pending.runId}`:`/api/video/multiview/actions/runs?requestId=${encodeURIComponent(pending.requestId)}`);if(!active())return;if(value.run)consumeAi(value.run,pending);else setMessage('原文案尚未查到，继续保留原号。');}catch(cause){if(active())setMessage(cause instanceof Error?cause.message:'原文案暂不可查询。');}}
  useEffect(()=>{if(!aiPending||aiPending.status==='uncertain')return;if(aiPoll.current.key!==aiPending.requestId)aiPoll.current={key:aiPending.requestId,count:0};if(aiPoll.current.count>=30)return;const timer=setTimeout(()=>{aiPoll.current.count++;void queryAi(false);},4000);return()=>clearTimeout(timer);});
  async function queryOriginal(manual=true){if(!original)return;if(manual)videoPoll.current={key:original.key,count:0};const captured=scope;try{const value=await api<{task:{id:string}|null;new_request_allowed?:boolean;request_receipt?:{key?:string;state?:string;accepted?:boolean;message?:string}}>(`/api/tasks/request-status?idempotency_key=${encodeURIComponent(original.key)}`);if(!active(captured))return;if(value.task){const next={...original,taskId:value.task.id};setOriginal(next);localStorage.setItem(requestKey,JSON.stringify(next));await refresh();}else if(value.new_request_allowed===true&&value.request_receipt?.state==='rejected'&&value.request_receipt.accepted===false&&value.request_receipt.key===original.key){setOriginal(null);setNewAttemptRequired(true);localStorage.setItem(attemptKey,JSON.stringify({id:attemptId,needsNew:true}));localStorage.removeItem(requestKey);setMessage(value.request_receipt.message||'本次未受理，请调整后重新确认费用。');}else setMessage('提交结果待确认，原请求尚未查到，不会重新提交。');}catch(cause){if(active(captured))setMessage('原请求暂不可查询，保留最后已知状态。');}}
  useEffect(()=>{if(!hydrated||!props.work)return;const waiting=original&&!original.taskId||state?.runs.some(run=>['queued','running'].includes(run.status)||run.tasks.some(task=>!finished.has(task.status)));if(!waiting)return;if(original&&!original.taskId){if(videoPoll.current.key!==original.key)videoPoll.current={key:original.key,count:0};if(videoPoll.current.count>=12)return;}const timer=setTimeout(()=>{if(original&&!original.taskId){videoPoll.current.count++;void queryOriginal(false);}else void refresh().catch(()=>undefined);},5000);return()=>clearTimeout(timer);});
  async function submit(){
    if(submitLock.current||saveLock.current||!hydrated||!text.trim()||!parameters.project_id||!state?.capabilities.actionReady||draftBlocked||newAttemptRequired||original&&!original.taskId)return;
    const frozen=confirmationQuote,captured=scope,frozenEdit=editRevision.current;submitLock.current=true;setSubmitting(true);setMessage('正在准备本次拼图…');
    let retained=false;
    let binding: MultiviewActionBinding | null = null;
    try{
      const preparedWork=await props.onPrepare();
      if(!active(captured))return;
      const savedDraft=await api<{draft:MultiviewActionDraft}>('/api/video/multiview/actions/drafts',{workId:preparedWork.id,draftId:draftRef.current?.id,revision:draftRef.current?.revision||0,text:frozen.text,parameters:frozen.parameters});
      if(!active(captured))return;
      setDraft(savedDraft.draft);draftRef.current=savedDraft.draft;
      const final=await api<{run:MultiviewActionRun;binding:MultiviewActionBinding}>('/api/video/multiview/actions/final',{draftId:savedDraft.draft.id,revision:savedDraft.draft.revision,text:frozen.text,parameters:frozen.parameters,attemptId,...(appliedRunId?{sourceRunId:appliedRunId}:{})});
      binding=final.binding;
      if(!active(captured))return;
      const requestId=`multiview-action:${binding.runId}`;
      const body:Record<string,unknown>={...frozen.parameters,provider:'seedance',generation_mode:'first_last_frame',prompt:final.run.text,multiview_action:binding,idempotency_key:requestId,creation_contract_version:2,entry:'multiview',action:'generate',continuation:{mode:'new'},count:1,video_branch_id:null,baseline_task_id:baseline,...(frozen.points===null?{}:{max_estimated_cost:frozen.points}),pricing_revision:frozen.pricingRevision,pricing_fingerprint_version:2};
      setMessage('正在核对本次费用并提交…');
      if(creation.intent && !isResolvedCreationIntent(creation.intent) && creation.intent.request_id!==requestId){
        const prior=await creation.queryOriginal();
        if(!active(captured))return;
        const priorBinding=parseMultiviewActionBinding(prior?.spec?.input.multiview_action);
        if(prior && !isResolvedCreationIntent(prior) && priorBinding?.workId===binding.workId && prior.request_id===`multiview-action:${priorBinding.runId}`){
          // Seal only an unused preparation in the existing CAS transaction. A late accepted task wins.
          const closed=await api<{intent:VideoCreationIntentDTO}>(`/api/video/creation-intents/${encodeURIComponent(prior.id)}/close`,{expected_revision:prior.revision});
          if(!active(captured))return;
          if(closed.intent.accepted_task_id){
            const accepted={key:prior.request_id,runId:priorBinding.runId,taskId:closed.intent.accepted_task_id};
            setOriginal(accepted);localStorage.setItem(requestKey,JSON.stringify(accepted));setSelectedRunId(priorBinding.runId);setConfirming(false);props.onView('video');
            setMessage('原任务已经受理，已接回原任务；本次未重复提交。');await refresh();return;
          }
          if(closed.intent.state!=='closed')throw new Error('原准备仍待核对，尚未提交新的动作视频。');
        }
      }
      const previous=!isResolvedCreationIntent(creation.intent)?creation.intent:null;
      const prepared=await creation.prepare({...body,pricing_preparation:'current'},requestId,previous);
      if(!active(captured))return;
      if(prepared.request_id!==requestId){setConfirming(false);setMessage('原动作准备尚未结束，请先核对下方原请求；本次未重新提交。');return;}
      if(isResolvedCreationIntent(prepared)){
        if(prepared.accepted_task_id){const accepted={key:requestId,runId:binding.runId,taskId:prepared.accepted_task_id};setOriginal(accepted);localStorage.setItem(requestKey,JSON.stringify(accepted));setSelectedRunId(binding.runId);await refresh();props.onView('video');}
        else if(prepared.state==='closed'){setNewAttemptRequired(true);localStorage.setItem(attemptKey,JSON.stringify({id:attemptId,needsNew:true}));}
        setConfirming(false);setMessage(prepared.accepted_task_id?'已找到原任务，不会重复生成。':'原动作请求已结束，当前输入保留，请主动重新准备生成。');return;
      }
      if(!prepared.availability?.canSubmit){setConfirming(false);setMessage(prepared.availability?.reasons.map(reason=>reason.message).join('；')||'本次尚未提交，请完成下方创作条件。');return;}
      if(editRevision.current!==frozenEdit)throw new Error('当前输入已修改，请核对后再生成。');
      if(!prepared.quote||!Number.isFinite(prepared.quote.estimated_cost)||prepared.quote.estimated_cost<0)throw new Error('本次费用暂未确认，尚未生成。');
      if(prepared.quote.estimated_cost!==frozen.points){
        setQuote({...frozen,key:currentQuoteKey.current,points:prepared.quote.estimated_cost,pricingRevision:prepared.quote.pricing_revision,token:prepared.quote.pricing_quote_token});
        setMessage('本次费用已更新，请核对后确认生成。');return;
      }
      Object.assign(body,{intent_id:prepared.id,intent_revision:prepared.revision,resolution_approval_id:prepared.approval_id||null,pricing_revision:prepared.quote.pricing_revision,pricing_quote_token:prepared.quote.pricing_quote_token||frozen.token});
      const pending:Original={key:requestId,runId:binding.runId,taskId:null};localStorage.setItem(requestKey,JSON.stringify(pending));setOriginal(pending);retained=true;setConfirming(false);setSelectedRunId(binding.runId);
      const result=await api<{id?:string;task_id?:string;existing_task_id?:string}>('/api/tasks/create',body);if(!active(captured))return;
      const taskId=result.id||result.task_id||result.existing_task_id;
      if(!taskId)throw new Error('提交结果待确认，原请求已保留。');
      const accepted={...pending,taskId};setOriginal(accepted);localStorage.setItem(requestKey,JSON.stringify(accepted));void creation.acceptTask(requestId,taskId).catch(()=>undefined);setMessage('视频任务已受理。');props.onView('video');await refresh().catch(()=>setMessage('视频任务已受理，状态暂未更新，可查询原任务。'));
    }catch(cause){if(active(captured)){setConfirming(false);const result=(cause as {result?:{new_request_allowed?:boolean;request_receipt?:{key?:string;state?:string;accepted?:boolean;message?:string}}})?.result,receipt=result?.request_receipt;if(retained&&result?.new_request_allowed===true&&receipt?.state==='rejected'&&receipt.accepted===false&&receipt.key===`multiview-action:${binding?.runId}`){setOriginal(null);setNewAttemptRequired(true);localStorage.removeItem(requestKey);localStorage.setItem(attemptKey,JSON.stringify({id:attemptId,needsNew:true}));setMessage(receipt.message||'本次未受理，当前输入保留。');}else setMessage(retained?'提交结果待确认，请查询原请求，不会重复提交。':cause instanceof Error?cause.message:'尚未提交，当前输入保留。');}}
    finally{submitLock.current=false;if(active(captured))setSubmitting(false);}
  }
  function newAttempt() { if (original && !original.taskId) return false; const id=crypto.randomUUID(); try { localStorage.setItem(attemptKey,JSON.stringify({id,needsNew:false}));setAttemptId(id);setNewAttemptRequired(false);setOriginal(null);localStorage.removeItem(requestKey);setQuote(null);return true; } catch {setMessage('新操作编号未能保存，尚未准备新的生成。');return false;} }
  const applyParameters=(patch:Partial<MultiviewActionParameters>)=>{editRevision.current++;setParameters(value=>({...value,...patch}));setConfirming(false);};
  const showVideo=props.activeView==='video';
  return <>
    <div className={styles.resultRow} hidden={!showVideo}><MultiviewVideoResults key={scope} initialTaskId={props.restored?.taskId} onSelect={async id=>{if(props.restored&&id===props.restored.taskId)return true;try{if(props.restored&&(text!==props.restored.text||JSON.stringify(parameters)!==JSON.stringify(props.restored.parameters)))localStorage.setItem(videoInputKey,JSON.stringify({text,parameters,referenceImage}));}catch{setMessage('当前修改未能保留，请重试后再切换。');return false;}if(saveInFlight.current)await saveInFlight.current.catch(()=>undefined);await saveDraft();return props.onSelectVideo?props.onSelectVideo(id):true;}} owner={props.ownerId} authority={props.authority} active={props.active !== false && showVideo}
      currentTaskId={original ? original.taskId : state?.runs.find(run => run.tasks.length)?.tasks[0]?.taskId}
      pendingLabel={original && !original.taskId ? '提交结果待确认' : submitting ? '正在准备并提交视频任务…' : undefined} /></div>
    <aside className={styles.action} aria-label="同步动作视频">
      <div className={styles.actionHeading}><h3>动作与设置</h3>{props.onChangeOriginal&&<button type="button" onClick={()=>props.onChangeOriginal?.({text,parameters})}>更换原图</button>}</div>
      {props.restored && <div className={styles.inputSource}><span>{!props.referenceChanged&&text===props.restored.text&&JSON.stringify(parameters)===JSON.stringify(props.restored.parameters)?'当前视频的生成时输入':'基于当前视频的修改 · 未生成'}</span><small>{seedanceVideoModelLabel(props.restored.parameters.model)} · {props.restored.parameters.duration}秒 · {props.restored.parameters.resolution}</small></div>}
      {(videoDraft||props.hasReferenceDraft)&&<p className={styles.notice}>这条视频有上次修改。<button type="button" onClick={()=>{if(videoDraft){updateText(videoDraft.text);setParameters(videoDraft.parameters);setReferenceImage(videoDraft.referenceImage===true);setVideoDraft(null);}if(props.hasReferenceDraft)props.onResumeDraft?.();}}>继续上次修改</button></p>}
      <>
        <textarea aria-label="动作" placeholder="例如：原地挥拳三次，从轻到重。" maxLength={12000} value={text} disabled={!hydrated} onChange={event=>updateText(event.target.value)}/>
        <label className={styles.aiReference}><input type="checkbox" checked={referenceImage} disabled={!hydrated||aiBusy} onChange={event=>setReferenceImage(event.target.checked)}/>让 GPT 参考当前拼图</label>
        {referenceImage&&state&&!state.capabilities.referenceImageEnabled&&<p className={styles.notice}>当前服务暂不支持图片参考；当前输入和原请求均保留。</p>}
        <div className={styles.aiControls}>
          <button type="button" disabled={!state?.capabilities.llmEnabled||referenceImage&&(!state.capabilities.referenceImageEnabled||Boolean(props.inputError))||!llmReady||!text.trim()||aiBusy||Boolean(aiPending&&aiPending.status!=='uncertain')||saving||draftBlocked} onClick={()=>void organize()}>{aiBusy?'正在提交…':aiPending?.status==='uncertain'?'新建一次整理':aiPending?(aiPending.status==='queued'?'等待整理…':aiPending.runId?'正在整理…':'提交结果待确认'):'AI整理动作'}</button>
          <div className={styles.modelPicker}><select aria-label="文案模型" value={llmReady?llmModel:''} onChange={event=>rememberModel(event.target.value)}><option value="" disabled>{modelsBusy&&!llmModels.length?'正在读取模型…':modelAvailabilityReason||'请选择可用文案模型'}</option>{modelOptions.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select><button type="button" disabled={modelsBusy} aria-busy={modelsBusy} onClick={()=>{void loadModels(true);void refreshAvailability();}}><RefreshCw size={15}/>{modelsBusy?'更新中…':'更新'}</button></div>
          {beforeAi!==null&&<button onClick={()=>{updateText(beforeAi);setAppliedRunId(undefined);setBeforeAi(null);}}>撤销整理</button>}
        </div>
        {llmModel&&!llmReady&&!modelsBusy&&<p className={styles.notice} role="status">上次选择的 {llmModel} 当前不可用，请更新模型后重新选择；原动作保留。</p>}
        {modelMessage&&<p className={styles.notice} role="status">{modelMessage}</p>}
        {!state?.capabilities.llmEnabled&&state?.capabilities.llmReason&&<p className={styles.notice}>{state.capabilities.llmReason}</p>}
        {state?.capabilities.billingLabel&&<p className={styles.notice}>{state.capabilities.billingLabel}</p>}
        {aiPending&&<div className={styles.requestNotice} role="status"><span>{aiPending.status==='uncertain'?`尚未收到整理结果${aiPending.model?'（'+aiPending.model+'）':''}，当前原文保留；原请求待确认，不会重发。`:aiPending.status==='queued'?'文案已排队，等待整理结果。':aiPending.runId?'正在查询原文案进度。':'文案提交结果待确认，原请求保留。'}</span><button type="button" onClick={()=>void queryAi()}>查询原文案</button></div>}
        {aiJournal.retained.length>0&&<details className={styles.retained}><summary>待核对的原文案（{aiJournal.retained.length}）</summary>{aiJournal.retained.map(item=><div className={styles.requestNotice} key={item.requestId}><span>{item.model||'原文案'} · 结果待确认</span><button type="button" onClick={()=>void queryAi(true,item)}>查询此原文案</button></div>)}</details>}
        {suggestion&&<div className={styles.notice}><p>新整理已就绪，当前动作保留。</p><button onClick={()=>{setBeforeAi(text);setAppliedRunId(suggestion.id);updateText(suggestion.text||'');setSuggestion(null);}}>使用此整理</button><button onClick={()=>setSuggestion(null)}>保留当前动作</button></div>}
        {state?.runs.find(run=>run.mode==='llm'&&run.status==='succeeded')&&<details><summary>原需求与整理记录</summary>{state.runs.filter(run=>run.mode==='llm').map(run=><div key={run.id}><p className={styles.frozenText}>{run.inputText}</p><button disabled={!run.text} onClick={()=>updateText(run.inputText)}>使用原需求</button><button disabled={!run.text} onClick={()=>updateText(run.text||'')}>使用整理</button></div>)}</details>}
        <div className={styles.compact}>{(['format','sync'] as const).map(kind=><button className={styles.ruleLink} key={kind} disabled={!state?.capabilities.rules[kind].canEdit} onClick={()=>setContext(kind)}>{kind==='format'?'动作格式':'镜头与同步'} · 编辑</button>)}</div>
        <div className={styles.params}>
          <div className={styles.videoParameters}><select aria-label="视频型号" value={parameters.model} onChange={event=>applyParameters({model:event.target.value})}><option value="" disabled>{modelAvailabilityReason || "请选择已开放模型"}</option>{parameters.model&&!modelAvailable('video',parameters.model,{},'seedance')&&<option value={parameters.model}>{seedanceVideoModelLabel(parameters.model)}（当前不可用）</option>}{SEEDANCE_VIDEO_MODEL_OPTIONS.filter(model=>modelAvailable('video',model.id,{},'seedance')).map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select><select aria-label="视频时长" value={parameters.duration} onChange={event=>applyParameters({duration:Number(event.target.value)})}>{!seedanceVideoDurationOptions(parameters.model).some(value=>value===parameters.duration)&&<option value={parameters.duration}>{parameters.duration} 秒（历史值）</option>}{seedanceVideoDurationOptions(parameters.model).map(duration=><option key={duration} value={duration}>{duration} 秒</option>)}</select><select aria-label="分辨率" value={parameters.resolution} onChange={event=>applyParameters({resolution:event.target.value as MultiviewActionParameters['resolution']})}>{['480p','720p','1080p'].map(value=><option key={value}>{value}</option>)}</select></div>
          <div className={styles.destinationParameters}><div className={styles.projectField}><ProjectSelector  aria-label="项目" name="project_id" value={parameters.project_id} onChange={event=>applyParameters({project_id:event.target.value,video_card_id:null})}><option value="">选择项目</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</ProjectSelector></div><div className={styles.cardField}><select aria-label="视频卡，可选" name="video_card_id" value={parameters.video_card_id||''} onChange={event=>applyParameters({video_card_id:event.target.value||null})}><option value="">视频卡（可选）</option>{cards.map(card=><option key={card.id} value={card.id}>{card.title}</option>)}</select></div></div>
        </div>
        <CreationAvailability controller={creation} onBaselineChange={setBaseline}/>
        {state&&!state.capabilities.actionReady&&<p className={styles.notice}>{state.capabilities.actionReason}</p>}
        {props.work && ['queued','rendering'].includes(props.work.status)&&<p className={styles.notice}>拼图准备中…</p>}
        <div className={styles.price}>{currentQuote?<>预计 <strong>{currentQuote.points} 点</strong></>:quoting?'视频费用获取中…':quoteError||'视频费用待准备'}</div>
        {props.inputError&&<p className={styles.notice} role="status">{props.inputError}</p>}
        {quoteError&&<button onClick={()=>setQuoteRetry(value=>value+1)}>重新报价</button>}
      </>
      {original&&!original.taskId&&<p className={styles.notice}>提交结果待确认 <button onClick={()=>void queryOriginal()}>查询原请求</button></p>}
      {original?.taskId&&<div className={styles.taskId}><code>{original.taskId}</code><button onClick={()=>void queryOriginal()}>查询原任务</button><button aria-label="复制完整任务编号" onClick={()=>void navigator.clipboard.writeText(original.taskId!).catch(()=>setMessage('复制未完成，请选择编号复制。'))}><Copy size={14}/></button></div>}
      {saving&&<p className={styles.notice}>正在保存动作…</p>}
      {draftBlocked&&<button onClick={async()=>{try{await refresh();setDraftBlocked(false);const latest=await api<MultiviewActionState>(`/api/video/multiview/actions?workId=${props.work!.id}`);if(active()){setDraft(latest.draft);draftRef.current=latest.draft;setMessage('服务器版本已核对，当前文字保留，请继续保存。');}}catch(cause){setMessage(cause instanceof Error?cause.message:'暂不可读取。');}}}>核对最新并保留我的草稿</button>}
      {message&&<p className={styles.notice} role="status">{message}</p>}
      {<button type="button" className={styles.primary} disabled={!hydrated||!text.trim()||!parameters.project_id||!state?.capabilities.actionReady||Boolean(props.inputError)||submitting||saving||creation.loading||Boolean(original&&!original.taskId)||draftBlocked} onClick={()=>{if((original?.taskId||newAttemptRequired)&&!newAttempt())return;setConfirming(true);}}>{submitting?'正在准备并提交…':props.restored?'生成新版本':'制作动作视频'}</button>}
    </aside>
    {productDialog}
    {context&&<RuleDialog key={`${scope}:${context}`} kind={context} ownerId={props.ownerId} onClose={()=>setContext(null)} onSaved={()=>{setQuote(null);void refresh().catch(()=>undefined);}}/>}
    {confirming&&<ConfirmDialog quote={confirmationQuote} parameters={confirmationQuote.parameters} busy={submitting} onClose={()=>setConfirming(false)} onConfirm={()=>void submit()}/>}
  </>;
}
