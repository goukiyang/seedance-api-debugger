'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Square, X } from 'lucide-react';
import type { FusionMessage } from '@/lib/character-fusion/assistant';
import { lookupOperation, postFusion, type FusionWorkspace, type WorkspaceOperation, type WorkspaceReceipt, type OperationLookup, type UnappliedProposal } from './workspace-client';
import styles from './studio.module.css';

type AssistantResponse = { status?: OperationLookup['status']; reply: string; workspace?: FusionWorkspace; operation?: WorkspaceOperation; rowsPage?: WorkspaceReceipt['rowsPage']; rowChanges?: WorkspaceReceipt['rowChanges']; drafts?: unknown[]; pending?: boolean; reads?: unknown[]; iterations?: number };
type Props = {
  ownerId: string; workspaceId: string; version: number; messages: FusionMessage[]; model: string; modelReady: boolean;
  disabled: boolean; active: boolean; onWorkspace: (receipt: Pick<WorkspaceReceipt, 'workspace' | 'rowChanges' | 'rowsPage'>) => void; onChooseModel: () => void;
  onDrafts: (drafts: unknown[]) => void; onClose: () => void;
};
export default function CreationChat({ ownerId, workspaceId, version, messages, model, modelReady, disabled, active, onWorkspace, onChooseModel, onDrafts, onClose }: Props) {
  const draftKey = `sd2-fusion-assistant:${ownerId}:${workspaceId}`;
  const [input, setInput] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<{ opId: string; message: string } | null>(null);
  const [reply, setReply] = useState(''), [proposal, setProposal] = useState<UnappliedProposal | null>(null);
  const inputRef = useRef(input); inputRef.current = input;
  const stopping = useRef(false);
  const controller = useRef<AbortController | null>(null), current = useRef({ active, workspaceId });
  current.current = { active, workspaceId };
  useEffect(() => {
    setInput(''); setPending(null); setReply(''); setError(''); setProposal(null);
    try { const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); if (saved) { if (saved.proposal) setProposal(saved.proposal); setInput(typeof saved.input === 'string' ? saved.input : ''); if (typeof saved.pending?.opId === 'string') setPending(saved.pending); } } catch { /* Current input remains usable. */ }
    return () => controller.current?.abort();
  }, [draftKey]);
  const persist = (nextInput: string, nextPending: typeof pending, nextProposal = proposal) => { try { sessionStorage.setItem(draftKey, JSON.stringify({ input: nextInput, pending: nextPending, proposal: nextProposal })); } catch { /* The visible draft is retained. */ } };
  const accepts = (id: string) => current.current.active && current.current.workspaceId === id;
  const keepProposal = (draft: UnappliedProposal) => { setProposal(draft); if (draft.drafts?.length) onDrafts(draft.drafts); try { sessionStorage.setItem(draftKey, JSON.stringify({ input: inputRef.current, pending: null, proposal: draft })); } catch { /* The visible proposal is retained. */ } };
  const acceptLookup = (result: OperationLookup, operation: NonNullable<typeof pending>) => {
    if (result.status === 'committed' && result.workspace) {
      onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage }); setPending(null);
      const nextInput = inputRef.current.trim() === operation.message ? '' : inputRef.current; setInput(nextInput); persist(nextInput, null); setReply('原操作已确认，现场已更新。'); return true;
    }
    if (result.status === 'rejected' || result.status === 'cancelled') { if (result.proposal) keepProposal(result.proposal); setPending(null); persist(inputRef.current, null, result.proposal || proposal); setError(result.error || (result.status === 'cancelled' ? '本回合已取消，未应用新提案。输入与型号保留。' : '本回合未应用，输入与型号保留。可调整后重新发送。')); return true; }
    setError(result.status === 'planning' ? '原回合仍在处理，可继续核对或显式结束本回合。' : '尚未查到原操作确认，输入和操作编号保留。可核对或显式结束本回合。'); return false;
  };
  const check = async (operation = pending) => {
    if (!operation || busy || !active) return; setBusy(true); setError('');
    try { const result = await lookupOperation(workspaceId, operation.opId); if (accepts(workspaceId)) acceptLookup(result, operation); }
    catch (e) { if (accepts(workspaceId)) setError(e instanceof Error ? e.message : '暂时无法核对原操作。'); }
    finally { if (accepts(workspaceId)) setBusy(false); }
  };
  const stop = async () => {
    if (!pending || stopping.current || !active) return; stopping.current = true; controller.current?.abort(); setBusy(true);
    try { const result = await postFusion<OperationLookup>('/api/character-fusion/assistant', { action: 'cancel', workspaceId, opId: pending.opId }); if (accepts(workspaceId)) acceptLookup(result, pending); }
    catch (e) { if (accepts(workspaceId)) setError(e instanceof Error ? e.message : '结束状态仍待核对，原操作编号保留。'); }
    finally { stopping.current = false; if (accepts(workspaceId)) setBusy(false); }
  };
  const send = async () => {
    if (busy || pending || disabled || !modelReady || !input.trim() || !active) return;
    const operation = { opId: crypto.randomUUID(), message: input.trim() }, request = new AbortController();
    controller.current = request; setBusy(true); setError(''); setReply(''); setPending(operation); persist(input, operation);
    try {
      const result = await postFusion<AssistantResponse>('/api/character-fusion/assistant', { workspaceId, opId: operation.opId, baseVersion: version, message: operation.message, model }, request.signal);
      if (!accepts(workspaceId)) return;
      if (result.workspace) onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage });
      if (result.drafts?.length) onDrafts(result.drafts);
      setReply(result.reply || '助手已结束本轮。');
      if (result.status === 'rejected' || result.status === 'cancelled') { acceptLookup(result as OperationLookup, operation); return; }
      if (result.pending) { setError('本轮仍有提交待核对，请按原操作编号核对。'); return; }
      setPending(null); const nextInput = inputRef.current.trim() === operation.message ? '' : inputRef.current; setInput(nextInput); persist(nextInput, null);
    } catch (e) {
      if (!accepts(workspaceId) || stopping.current) return;
      // Cancellation may arrive after a proposal was submitted; keep its original identifier.
      try {
        const result = await lookupOperation(workspaceId, operation.opId);
        if (!accepts(workspaceId)) return;
        acceptLookup(result, operation);
      } catch { if (accepts(workspaceId)) setError('回复未确认，原输入、型号与操作编号已保留。请核对原操作。'); }
    } finally { if (accepts(workspaceId)) setBusy(false); }
  };
  return <section className={styles.chat} aria-labelledby="fusion-creation-chat-title">
    <div className={styles.sectionHead}><div><h3 id="fusion-creation-chat-title"><MessageCircle size={17} />创作助手</h3><p>可调整本次设置、抽卡或保留结果。当前模型：{model || '未选择'}</p></div><button type="button" aria-label="收起创作助手，保留输入" onClick={onClose}><X size={17} /></button></div>
    <div className={styles.chatMessages} role="log" aria-label="创作对话">{!messages.length && <p>例如：保留第 3、7 条，其余更像深海学者，巨掌巨脚都要，别带武器。</p>}{messages.slice(-20).map((message, index) => <div key={index} className={message.role === 'user' ? styles.userMessage : styles.assistantMessage}><small>{message.role === 'user' ? '你' : '创作助手'}</small><p>{message.reply || message.content}</p></div>)}{busy && <p role="status">正在理解想法并核对当前现场…</p>}{reply && <p role="status">{reply}</p>}</div>
    {proposal && <details className={styles.cardPreview}><summary>未应用建议，当前现场保持本人修改</summary>{proposal.reply && <p>{proposal.reply}</p>}{proposal.commands?.length ? <details><summary>查看未执行的调整提案</summary><pre>{JSON.stringify(proposal.commands, null, 2)}</pre></details> : null}{proposal.drafts?.length ? <p>词条建议仍为草稿，可到词库管理预览入库。</p> : null}</details>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {pending && <div className={styles.actions}><small>本回合结果待确认</small><details><summary>操作详情</summary><small>{pending.opId}</small></details><button disabled={busy} type="button" onClick={() => void check()}>核对原操作</button><button disabled={busy} type="button" onClick={() => void stop()}>结束本回合</button></div>}
    {!modelReady && <p className={styles.hint}>当前输入保留。<button type="button" onClick={onChooseModel}>选择 API 模型</button></p>}
    {disabled && <p className={styles.hint}>当前为只读，创作助手暂不能提交新操作。</p>}
    <form className={styles.chatInput} onSubmit={event => { event.preventDefault(); void send(); }}><textarea rows={3} maxLength={4000} aria-label="本次创作想法或调整要求" value={input} onChange={event => { setInput(event.target.value); persist(event.target.value, pending); }} placeholder="描述想法，或说要保留和调整哪些结果…" /><button disabled={busy || Boolean(pending) || disabled || !modelReady || !input.trim()}><Send size={16} />发送</button>{busy && <button type="button" onClick={() => void stop()}><Square size={14} />停止本回合</button>}</form>
  </section>;
}
