'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Maximize2, MessageCircle, Minimize2, Send, Square, Undo2, X } from 'lucide-react';
import type { FusionMessage } from '@/lib/character-fusion/assistant';
import { FusionRequestError, lookupOperation, postFusion, type CreationContinuation, type CreationTarget, type FusionWorkspace, type WorkspaceOperation, type WorkspaceReceipt, type OperationLookup, type UnappliedProposal } from './workspace-client';
import styles from './studio.module.css';

type AssistantResponse = Partial<OperationLookup> & { reply?: string; pending?: boolean; scopeChoices?: Array<{ id: 'row' | 'document'; label: string }> };
type HistoryOperation = WorkspaceOperation & { turn?: { user: string; assistant: string }; createdAt?: string; undoneBy?: string };
type PendingTurn = { opId: string; message: string; dispatched?: boolean; target?: CreationTarget };
type Phase = 'idle' | 'saving' | 'processing' | 'checking' | 'stopping' | 'unknown';
type Props = {
  ownerId: string; workspaceId: string; documentName: string; preparing: boolean; messages: FusionMessage[]; model: string; modelReady: boolean;
  disabled: boolean; active: boolean; completedPlanId?: string; completedPlanReply?: string; count: number; language: string; target: CreationTarget | null; onClearTarget: () => void;
  onWorkspace: (receipt: Pick<WorkspaceReceipt, 'workspace' | 'rowChanges' | 'rowsPage'>) => void; onChooseModel: () => void;
  onDrafts: (drafts: unknown[], continuation?: CreationContinuation) => void; onOpenDrafts: () => void;
  onPrepare: () => Promise<{ workspaceId: string; version: number } | null>; onActivityChange: (active: boolean) => void;
  onViewResults: (rowIds: string[]) => void; onUndo: (operationId: string) => Promise<boolean>;
};
export default function CreationChat({ ownerId, workspaceId, documentName, preparing, messages, model, modelReady, disabled, active, completedPlanId, completedPlanReply, count, language, target, onClearTarget, onWorkspace, onChooseModel, onDrafts, onOpenDrafts, onPrepare, onActivityChange, onViewResults, onUndo }: Props) {
  const draftKey = `sd2-fusion-assistant:${ownerId}:${workspaceId}`;
  const [input, setInput] = useState(''), [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('');
  const [pending, setPending] = useState<PendingTurn | null>(null), [reply, setReply] = useState('');
  const [proposal, setProposal] = useState<UnappliedProposal | null>(null), [expanded, setExpanded] = useState(false), [longInput, setLongInput] = useState(false);
  const [lastOperation, setLastOperation] = useState<WorkspaceOperation | null>(null);
  const [scopeChoices, setScopeChoices] = useState<AssistantResponse['scopeChoices']>();
  const [history, setHistory] = useState<HistoryOperation[] | null>(null), [historyCursor, setHistoryCursor] = useState<string | null>(null), [loadingHistory, setLoadingHistory] = useState(false);
  const [undoable, setUndoable] = useState<HistoryOperation[]>([]);
  const [undoBoundary, setUndoBoundary] = useState<{ opId: string; reason: string; label: string } | null>(null);
  const inputRef = useRef(input); inputRef.current = input;
  const proposalRef = useRef(proposal); proposalRef.current = proposal;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const polls = useRef(0);
  const stopping = useRef(false), following = useRef(true), log = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null), current = useRef({ active, workspaceId });
  current.current = { active, workspaceId };
  const busy = !['idle', 'unknown'].includes(phase);
  const accepts = (id: string) => current.current.active && current.current.workspaceId === id;
  const persist = (nextInput: string, nextPending: PendingTurn | null, nextProposal = proposalRef.current) => { try { sessionStorage.setItem(draftKey, JSON.stringify({ input: nextInput, pending: nextPending, proposal: nextProposal })); } catch { /* Visible input remains available. */ } };
  const loadHistory = useCallback(async (cursor?: string) => {
    if (!workspaceId || !active) return;
    setLoadingHistory(true);
    try {
      const result = await postFusion<{ operations: HistoryOperation[]; nextCursor: string | null }>('/api/character-fusion/assistant', { action: 'history', workspaceId, cursor, limit: 20 });
      if (!current.current.active || current.current.workspaceId !== workspaceId) return;
      setHistory(previous => cursor ? Array.from(new Map([...(previous || []), ...result.operations].map(operation => [operation.opId, operation])).values()) : result.operations); setHistoryCursor(result.nextCursor);
    } catch (e) { if (current.current.workspaceId === workspaceId) setError(e instanceof Error ? e.message : '早期对话暂时无法读取，当前对话保留。'); }
    finally { if (current.current.workspaceId === workspaceId) setLoadingHistory(false); }
  }, [active, workspaceId]);
  const loadUndoable = async () => {
    try { const result = await postFusion<{ operations: HistoryOperation[]; blockedBy?: { opId: string; reason: string; label: string }; requiresExplicitChoice?: boolean }>('/api/character-fusion/assistant', { action: 'undoable', workspaceId }); if (accepts(workspaceId)) { setUndoable(result.operations); setUndoBoundary(result.blockedBy || null); } }
    catch (e) { if (accepts(workspaceId)) setError(e instanceof Error ? e.message : '可撤销记录暂时无法读取。'); }
  };
  useEffect(() => { onActivityChange(busy || Boolean(pending) || Boolean(proposal?.continuation)); return () => onActivityChange(false); }, [busy, pending, proposal?.continuation, onActivityChange]);
  useEffect(() => {
    if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages, reply, phase, expanded]);
  useEffect(() => {
    const element = composer.current; if (!element) return;
    element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, longInput ? 340 : 128)}px`;
  }, [input, longInput]);
  useEffect(() => {
    setInput(''); setPending(null); setReply(''); setError(''); setProposal(null); setHistory(null); setHistoryCursor(null); setLastOperation(null); setUndoable([]); setScopeChoices(undefined); setPhase('idle');
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (saved) { if (saved.proposal) { setProposal(saved.proposal); if (saved.proposal.drafts?.length) onDrafts(saved.proposal.drafts, saved.proposal.continuation); } setInput(typeof saved.input === 'string' ? saved.input : ''); if (typeof saved.pending?.opId === 'string' && saved.pending.dispatched !== false) { setPending(saved.pending); setPhase('unknown'); } }
    } catch { /* Current input remains usable. */ }
    return () => controller.current?.abort();
    // Drafts belong to the current account and document, not to the visible tool tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  const keepProposal = (draft: UnappliedProposal) => { proposalRef.current = draft; setProposal(draft); if (draft.drafts?.length || draft.continuation) onDrafts(draft.drafts || [], draft.continuation); persist(inputRef.current, null, draft); };
  const receiveOperation = (operation?: WorkspaceOperation) => { if (operation) { setLastOperation(operation); if (history) void loadHistory(); } };
  const finish = (operation: PendingTurn) => { setPending(null); pendingRef.current = null; setPhase('idle'); const nextInput = inputRef.current.trim() === operation.message ? '' : inputRef.current; setInput(nextInput); persist(nextInput, null); };
  const pauseForPlan = (result: Partial<OperationLookup>) => {
    const continuation = result.continuation || result.proposal?.continuation;
    if (!continuation || !['awaiting_catalogue', 'awaiting_generation'].includes(result.phase || '')) return false;
    const draft = { ...(result.proposal || {}), reply: result.reply, drafts: result.drafts || result.proposal?.drafts || continuation.entries || proposal?.drafts || [], continuation: { ...continuation, phase: result.phase } };
    keepProposal(draft); setPending(null); pendingRef.current = null; setPhase('idle');
    setReply(result.reply || (result.phase === 'awaiting_generation' ? '词条已入库，后续生成待核对。原计划保留。' : '新词草稿已准备好，请编辑与预览后确认。'));
    persist(inputRef.current, null, draft); void loadHistory(); return true;
  };
  const acceptLookup = (result: OperationLookup, operation: PendingTurn) => {
    if (pauseForPlan(result)) return true;

    if (result.status === 'committed' && result.workspace) {
      onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage }); receiveOperation(result.operation);
      if (pauseForPlan(result)) return;
      if (result.drafts?.length) keepProposal({ drafts: result.drafts, continuation: result.continuation });
      finish(operation); setReply((result.operation as HistoryOperation | undefined)?.turn?.assistant || '已核对，创作现场已更新。'); return true;
    }
    if (result.status === 'rejected' || result.status === 'cancelled') {
      if (result.proposal) keepProposal(result.proposal);
      setPending(null); pendingRef.current = null; setPhase('idle'); persist(inputRef.current, null, result.proposal || proposal);
      setError(result.error || (result.status === 'cancelled' ? '本次未生成，原结果和输入已保留。' : '本次未执行，原结果和输入已保留。可调整后重新发送。')); return true;
    }
    setPhase(result.status === 'planning' ? 'processing' : 'unknown');
    if (result.status !== 'planning') setError('尚未确认这次是否完成，请核对结果。原输入与操作编号已保留。'); return false;
  };
  const check = async (operation = pendingRef.current) => {
    if (!operation || !active || ['saving', 'checking', 'stopping'].includes(phaseRef.current)) return;
    setPhase('checking'); setError('');
    try { const result = await lookupOperation(workspaceId, operation.opId); if (accepts(workspaceId)) acceptLookup(result, operation); }
    catch (e) { if (accepts(workspaceId)) { setPhase('unknown'); setError(e instanceof Error ? e.message : '暂时无法核对结果。'); } }
  };
  useEffect(() => {
    if (!pending || !active || !workspaceId || !['processing', 'unknown'].includes(phase)) return;
    if (phase === 'unknown' && polls.current >= 12) return;
    const timer = window.setTimeout(() => { polls.current++; void check(pending); }, phase === 'unknown' ? 2500 : 1800);
    return () => window.clearTimeout(timer);
    // Only query the original operation, never resend a turn during restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.opId, phase, active, workspaceId]);
  const stop = async () => {
    if (!active || stopping.current) return;
    const operation = pendingRef.current; if (!operation) return;
    stopping.current = true; controller.current?.abort();
    if (!operation.dispatched) {
      setPending(null); pendingRef.current = null; setPhase('idle'); persist(inputRef.current, null); setReply('已停止，尚未发送给创作助手。'); stopping.current = false; return;
    }
    setPhase('stopping'); setError('');
    try { const result = await postFusion<OperationLookup>('/api/character-fusion/assistant', { action: 'cancel', workspaceId, opId: operation.opId }); if (accepts(workspaceId)) acceptLookup(result, operation); }
    catch (e) { if (accepts(workspaceId)) { setPhase('unknown'); setError(e instanceof Error ? e.message : '停止状态仍待核对，原操作编号保留。'); } }
    finally { stopping.current = false; }
  };
  const send = async (scopeChoice?: 'row' | 'document') => {
    if (busy || pendingRef.current || proposal?.continuation || disabled || preparing || !workspaceId || !modelReady || !input.trim() || !active) return;
    const operation: PendingTurn = { opId: crypto.randomUUID(), message: input.trim(), dispatched: false, ...(target ? { target } : {}) }, request = new AbortController();
    stopping.current = false; controller.current = request; pendingRef.current = operation; setPending(operation); setPhase('saving'); setError(''); setReply(''); setLastOperation(null); setScopeChoices(undefined); polls.current = 0; persist(input, operation);
    try {
      const ready = await onPrepare();
      if (!accepts(workspaceId) || request.signal.aborted) return;
      if (!ready || ready.workspaceId !== workspaceId) { setPending(null); pendingRef.current = null; setPhase('idle'); persist(inputRef.current, null); setError('当前调整尚未保存，未发送给助手。输入已保留，请先核对工作文档。'); return; }
      operation.dispatched = true; setPending({ ...operation }); persist(inputRef.current, operation); setPhase('processing');
      const result = await postFusion<AssistantResponse>('/api/character-fusion/assistant', { workspaceId, opId: operation.opId, baseVersion: ready.version, message: operation.message, model, ...(operation.target ? { target: { rowId: operation.target.rowId, version: operation.target.version } } : {}), ...(scopeChoice ? { scopeChoice } : {}) }, request.signal);
      if (!accepts(workspaceId)) return;
      if (result.workspace) onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage });
      receiveOperation(result.operation);
      if (pauseForPlan(result)) return;
      if (result.drafts?.length) keepProposal({ drafts: result.drafts, continuation: result.continuation, reply: result.reply });
      setReply(result.reply || '本轮已结束。');
      if (result.scopeChoices?.length) { setScopeChoices(result.scopeChoices); setPending(null); pendingRef.current = null; setPhase('idle'); persist(inputRef.current, null); return; }
      if (result.status === 'rejected' || result.status === 'cancelled') { acceptLookup(result as OperationLookup, operation); return; }
      if (result.pending || result.status === 'planning' || result.status === 'unknown') { setPhase(result.status === 'planning' ? 'processing' : 'unknown'); return; }
      finish(operation);
    } catch (e) {
      if (!accepts(workspaceId) || request.signal.aborted && !operation.dispatched || stopping.current) return;
      if (e instanceof FusionRequestError && e.submitted === false) {
        setPending(null); pendingRef.current = null; setPhase('idle'); persist(inputRef.current, null);
        setError(`本次未执行，原输入与结果已保留。${e.message}`); return;
      }
      setPhase('unknown'); setError(e instanceof Error ? `回复未确认：${e.message}` : '回复未确认，原输入与操作编号已保留。请核对结果。');
    }
  };
  useEffect(() => {
    if (!completedPlanId || proposal?.continuation?.sourceOpId !== completedPlanId) return;
    proposalRef.current = null; setProposal(null); setReply(completedPlanReply || ''); setLastOperation(null); setError(''); persist(inputRef.current, pendingRef.current, null);
    // Completion is acknowledged by the existing catalogue plan receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedPlanId]);
  const effects = lastOperation?.effects;
  const addedIds = effects?.addedIds || [];
  const effectStatus = effects ? [effects.batches.length ? `已新增第${effects.batches.map(batch => batch.number).join('、')}批${effects.addedIds.length}条` : effects.addedIds.length ? `已新增${effects.addedIds.length}条` : '', effects.modifiedIds.length ? `已修改${effects.modifiedIds.length}条` : '', effects.removedIds.length ? `已移除${effects.removedIds.length}条` : '', effects.settingsChanged || effects.intentChanged ? '后续创作要求已更新' : '', effects.undoneOperationId ? '已撤销该步调整' : ''].filter(Boolean).join('；') : '';
  const status = phase === 'saving' ? '正在保存当前调整…' : phase === 'processing' ? '正在处理…' : phase === 'stopping' ? '正在停止并核对结果…' : phase === 'checking' ? '正在核对结果…' : phase === 'unknown' ? '尚未确认这次是否完成' : effectStatus || reply || messages[messages.length - 1]?.reply || (messages[messages.length - 1]?.role === 'assistant' ? messages[messages.length - 1]?.content : '描述方向，继续探索或调整方案');
  const orderedHistory = history ? [...history].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))) : null;
  const undoLabel = (operation: HistoryOperation) => operation.turn?.user || operation.batch?.label || operation.reply || `${operation.effects?.addedIds.length ? `新增${operation.effects.addedIds.length}条方案` : operation.effects?.modifiedIds.length ? `修改${operation.effects.modifiedIds.length}条方案` : operation.effects?.removedIds.length ? `移除${operation.effects.removedIds.length}条方案` : '更新创作要求'} · ${new Date(operation.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  return <section data-fusion-creation-chat className={`${styles.chat} ${styles.creationChat} ${expanded ? styles.chatExpanded : ''}`} aria-labelledby="fusion-creation-chat-title">
    <div className={styles.chatHeading}><h3 id="fusion-creation-chat-title"><MessageCircle size={17} />创作对话</h3><button type="button" className={styles.chatExpand} aria-expanded={expanded} aria-controls="fusion-creation-history" onClick={() => setExpanded(value => !value)}>{expanded ? '收起对话' : '展开对话'}<ChevronDown size={14} /></button></div>
    <div id="fusion-creation-history" className={styles.chatHistory}>
      <div className={styles.chatHistoryTools}><small>{documentName}</small><button disabled={loadingHistory} onClick={() => void loadHistory(history ? historyCursor || undefined : undefined)}>{loadingHistory ? '读取中…' : history ? historyCursor ? '读取更早对话' : '刷新对话记录' : '查看已保存的早期对话'}</button><details onToggle={event => { if (event.currentTarget.open) void loadUndoable(); }}><summary>近期可撤销操作</summary><div>{undoBoundary && <p>最近的{undoBoundary.label}不能直接撤销；可明确选择更早的操作。</p>}{undoable.length ? undoable.map(operation => <button key={operation.opId} disabled={disabled || busy || Boolean(pending)} onClick={() => { void onUndo(operation.opId).then(ok => { if (ok) { setUndoable(current => current.filter(item => item.opId !== operation.opId)); setReply('已撤销该步，原对话保留。'); } }); }}><Undo2 size={13} />{undoLabel(operation)}</button>) : <p>暂无可安全撤销的操作。</p>}</div></details></div>
      <div ref={log} className={styles.chatMessages} role="log" aria-label="创作对话" onScroll={event => { const element = event.currentTarget; following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
        {!messages.length && !orderedHistory?.length && <p>说说你想要的角色，也可以在方案上点“聊这张”。</p>}
        {orderedHistory?.some(operation => operation.turn) ? orderedHistory.filter(operation => operation.turn).map(operation => <div key={operation.opId}><div className={styles.userMessage}><small>你</small><p>{operation.turn!.user}</p></div><div className={styles.assistantMessage}><small>创作助手{operation.undoneBy ? ' · 该步已撤销' : ''}</small><p>{operation.turn!.assistant}</p></div></div>) : messages.slice(-20).map((message, index) => <div key={index} className={message.role === 'user' ? styles.userMessage : styles.assistantMessage}><small>{message.role === 'user' ? '你' : '创作助手'}</small><p>{message.reply || message.content}</p></div>)}
        {reply && messages[messages.length - 1]?.content !== reply && <p role="status">{reply}</p>}
      </div>
    </div>
    <div className={styles.chatComposer}>
      <div className={styles.chatTarget}>{target ? <><span>仅修改：{target.label}</span><button type="button" aria-label="取消单方案聊天目标，作用于本次创作" onClick={onClearTarget}><X size={14} /></button></> : <span>作用于：本次创作</span>}<small>{count}条 · {language}</small></div>
      <div className={styles.chatStatus} role="status"><span>{status}</span>{addedIds.length > 0 && !busy && <button type="button" onClick={() => onViewResults(addedIds)}>查看新增{addedIds.length}条</button>}{lastOperation?.reversible && !busy && <button type="button" disabled={disabled || Boolean(pending)} onClick={() => { void onUndo(lastOperation.opId).then(ok => { if (ok) { setLastOperation(null); setReply('已撤销这步调整，原对话保留。'); } }); }}><Undo2 size={13} />撤销</button>}{busy && <button type="button" disabled={phase === 'stopping'} onClick={() => void stop()}><Square size={13} />停止</button>}</div>
      {proposal?.continuation || proposal?.drafts?.length ? <div className={styles.chatDraftNotice}><span>{proposal.continuation?.mode === 'generate' ? '新词草稿待预览，确认后继续原批次' : '新词草稿待预览入库'}</span><button type="button" onClick={onOpenDrafts}>编辑与预览</button></div> : null}
      {error && <p className={styles.chatError} role="alert">{error}</p>}
      {pending && phase === 'unknown' && <div className={styles.actions}><button type="button" onClick={() => void check()}>核对结果</button><button type="button" onClick={() => void stop()}>停止并核对</button><details><summary>操作详情</summary><small>{pending.opId}</small></details></div>}
      {scopeChoices?.length ? <div className={styles.scopeChoices}><span>这次想调整哪里？</span>{scopeChoices.map(choice => <button type="button" key={choice.id} disabled={disabled} onClick={() => { if (choice.id === 'document') onClearTarget(); void send(choice.id); }}>{choice.label}</button>)}</div> : null}
      {!modelReady && <div className={styles.chatModelNotice}><button type="button" onClick={onChooseModel}>选择 API 模型</button><small>当前输入已保留</small></div>}
      {preparing || !workspaceId ? <small role="status">{preparing ? '正在准备当前文档…' : '新建或继续一份文档后即可发送'}</small> : disabled && !busy && !pending ? <small>当前文档暂不能提交，输入已保留</small> : null}
      <form className={`${styles.chatInput} ${longInput ? styles.longChatInput : ''}`} onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea ref={composer} disabled={!workspaceId} rows={1} maxLength={4000} aria-label="本次创作想法或调整要求" value={input} onChange={event => { setInput(event.target.value); persist(event.target.value, pending); }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} placeholder={target ? '描述要怎样调整这张方案…' : '继续描述想法…'} />
        <div className={styles.chatSendActions}><button type="button" className={styles.iconButton} aria-label={longInput ? '收起长输入' : '展开长输入'} aria-expanded={longInput} onClick={() => setLongInput(value => !value)}>{longInput ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button><button className={styles.primary} aria-label="发送" disabled={busy || Boolean(pending) || Boolean(proposal?.continuation) || disabled || preparing || !workspaceId || !modelReady || !input.trim()}><Send size={16} /><span>发送</span></button></div>
      </form><small className={styles.chatKeyboard}>Enter 换行，Ctrl / ⌘ Enter 发送</small>
    </div>
  </section>;
}
