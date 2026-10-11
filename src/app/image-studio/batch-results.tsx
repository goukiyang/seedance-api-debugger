'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FolderOpen, Pause, Play, RefreshCw, RotateCcw, Save, X } from 'lucide-react';
import { GeneratedImageResults, type GeneratedImageResult } from '@/components/GeneratedImageResults';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';
import { handImageDownloadToBrowser } from '@/lib/media/native-download';
import { batchStateLabel, safeBatchFileName, STUDIO_BATCH_LIMITS, type StudioBatchView } from '@/lib/image-studio/batch-contract';
import { readBatchResponse } from '@/lib/image-studio/batch-receipt';
import { useImageBillingRefresh } from '@/lib/hooks/use-image-billing-refresh';
import type { SharedStudioIntent } from '@/lib/image-studio/shared-types';
import { IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_QUALITY_LABELS } from '@/lib/image-studio/model-catalog';
import { canSelectBatchDirectory, selectBatchDirectory, newBatchOutputDirectory, writeUniqueBatchFile, type BatchDirectoryHandle } from './batch-files';
import styles from './batch.module.css';
import { hasSharedDefaults } from './use-shared-studio';
type Delivery = { saved: Record<number, string>; child: BatchDirectoryHandle | null; lock: boolean; directory: BatchDirectoryHandle | null };
type SharedBatchView = StudioBatchView & { sharedLive?: SharedStudioIntent; definitionConfirmationRequired?: boolean };
type SavedPersonalInput = Partial<{ prompt: string; model: string; quality: string; resolution: string; count: number; aspectRatio: string }>;
type CurrentSharedModule = { id: string; name: string; revision: number; templatePrompt?: string; personalPrompt?: string;
  model: string; quality: string; resolution: string; count: number; aspectRatio: string;
  sharedLive?: { intent: SharedStudioIntent; available: boolean; unavailableReason?: string; overriddenFields: Array<keyof SavedPersonalInput>;
    defaults?: import('@/lib/image-studio/shared-types').SharedStudioDefaults } };
type ContinuationQuote = { sharedLive?: SharedStudioIntent; billingMode: 'fixed' | 'actual'; batchQuoteId: string | null;
  estimatedCredits: number; unitCredits: number; expiresAt: string; imageChannel?: { channelId: string; configRevision: string } };
function sameDefinition(left?: SharedStudioIntent, right?: SharedStudioIntent) {
  return left?.protocol === 'shared-live-v1' && right?.protocol === 'shared-live-v1'
    && left.presetId === right.presetId && left.definitionToken === right.definitionToken;
}
function continuationSignature(batch: SharedBatchView) {
  return JSON.stringify([batch.id, batch.moduleId, batch.state, batch.sharedLive, batch.definitionConfirmationRequired,
    batch.pending, batch.committedCredits, batch.budget,
    batch.items?.filter(item => !item.taskId && item.status !== 'cancelled').map(item => [item.ordinal, item.sourceName])]);
}
async function readResult(response: Response, expectBatch = false) {
  try { return await readBatchResponse(response, expectBatch); }
  catch (cause) { throw Object.assign(cause instanceof Error ? cause : new Error('原批次结果尚未确认'), { status: response.status }); }
}
const deliveries = new Map<string, Delivery>();
function deliveryFor(key: string, directory?: BatchDirectoryHandle | null) {
  if (!deliveries.has(key)) {
    if (deliveries.size >= 100) { const removable = Array.from(deliveries.entries()).find(([, value]) => !value.lock); if (removable) deliveries.delete(removable[0]); }
    deliveries.set(key, { saved: {}, child: null, lock: false, directory: directory || null });
  }
  return deliveries.get(key)!;
}

type BatchResultsProps = { id: string; userId: string; outputDirectory?: BatchDirectoryHandle | null; compact?: boolean; deliveryOnly?: boolean; autoPack?: boolean; onQuickUse?: (assetId: string) => void; visible?: boolean; onSourceChanged?: () => void };
export function BatchResults(props: BatchResultsProps) {
  return <BatchResultsWorkspace key={`${props.userId}:${props.id}`} {...props} />;
}
function BatchResultsWorkspace({ id, userId, outputDirectory, deliveryOnly = false, autoPack = false, onQuickUse, visible = true, onSourceChanged }: BatchResultsProps) {
  const { confirm, prompt: askBudget, productDialog } = useProductDialog();
  const delivery = deliveryFor(`${userId}:${id}`, outputDirectory);
  const [batch, setBatch] = useState<SharedBatchView | null>(null);
  const [error, setError] = useState('');
  const [continuationMessage, setContinuationMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saved, setSaved] = useState<Record<number, string>>(delivery.saved);
  const [saveError, setSaveError] = useState('');
  const [provided, setProvided] = useState<number[]>([]);
  const [zipReady, setZipReady] = useState<{ url: string; name: string } | null>(null);
  const [directory, setDirectory] = useState(delivery.directory);
  const [selected, setSelected] = useState<number[]>([]);
  const [autoSave, setAutoSave] = useState(Boolean(outputDirectory));
  const saveLock = useRef(false), actionLock = useRef(false), reader = useRef(false);
  const childDirectory = useRef<BatchDirectoryHandle | null>(delivery.child);
  const packed = useRef(new Set<string>());
  const scope = useRef(`${userId}:${id}`); scope.current = `${userId}:${id}`;
  useEffect(() => {
    if (outputDirectory && outputDirectory !== delivery.directory && !delivery.lock) { delivery.directory = outputDirectory; delivery.child = null; delivery.saved = {}; childDirectory.current = null; setDirectory(outputDirectory); setSaved({}); }
  }, [outputDirectory, delivery]);
  useEffect(() => { scope.current = `${userId}:${id}`; return () => { scope.current = ''; }; }, [userId, id]);
  const load = useCallback(async () => {
    if (reader.current || actionLock.current) return;
    reader.current = true; setReading(true);
    const expected = `${userId}:${id}`;
    try {
      const data = await readBatchResponse(await fetch(`/api/image-studio/batches?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }), true);
      if (scope.current === expected && !actionLock.current) { setBatch(data.batch); setSaved({ ...delivery.saved }); setError(''); }
    } catch (error) { if (scope.current === expected && !actionLock.current) setError(error instanceof Error ? error.message : '批次读取失败'); }
    finally { reader.current = false; if (scope.current === expected) setReading(false); }
  }, [id, userId]);
  useEffect(() => { void load(); }, [load]);
  const generationPending = !!batch && !['complete', 'cancelled'].includes(batch.state);
  useEffect(() => { if (!generationPending || busy) return; const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000); return () => clearInterval(timer); }, [load, generationPending, busy]);
  useImageBillingRefresh((batch?.items || []).map(item => ({ id: item.taskId || String(item.ordinal), billing: item.billing })), load);
  async function continueSharedBatch(expected: string) {
    const valid = () => scope.current === expected;
    const readOriginal = async () => {
      const result = await readResult(await fetch(`/api/image-studio/batches?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }), true);
      if (!valid()) throw new Error('已离开原批次，未继续生成');
      if (result.batch.id !== id) throw new Error('原批次未能确认，不会新建任务');
      return result.batch as SharedBatchView;
    };
    const fresh = await readOriginal();
    setBatch(fresh);
    if (!['needs-confirmation', 'paused', 'blocked'].includes(fresh.state) || fresh.pending < 1) throw new Error('原批次当前无需继续，请查看最新状态');
    const readDefinition = async () => {
      const data = await readResult(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(fresh.moduleId)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      if (!valid()) throw new Error('已离开原批次，未继续生成');
      const current: CurrentSharedModule | undefined = data.modules?.find((item: CurrentSharedModule) => item.id === fresh.moduleId);
      if (!current?.sharedLive?.available || !hasSharedDefaults(current.sharedLive.defaults) || current.sharedLive.intent.protocol !== 'shared-live-v1') throw new Error(current?.sharedLive?.unavailableReason || '原批次的共享模板已不可用，不能继续；原任务和结果保留');
      if (fresh.sharedLive && current.sharedLive.intent.presetId !== fresh.sharedLive.presetId) throw new Error('原批次绑定已变化，不能改用另一个模板');
      return current as CurrentSharedModule & { sharedLive: NonNullable<CurrentSharedModule['sharedLive']> & { defaults: import('@/lib/image-studio/shared-types').SharedStudioDefaults } };
    };
    const current = await readDefinition();
    if (!fresh.definitionConfirmationRequired && fresh.state !== 'needs-confirmation' && sameDefinition(fresh.sharedLive, current.sharedLive.intent)) {
      const result = await readResult(await fetch('/api/image-studio/batches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'resume', sharedLive: current.sharedLive.intent }), signal: AbortSignal.timeout(120000) }), true);
      if (valid()) {
        setBatch(result.batch);
        if (result.batch.id !== id || result.batch.definitionConfirmationRequired || result.batch.state === 'needs-confirmation') throw new Error('原批次仍需确认，请核对最新状态；不会自动继续');
        setContinuationMessage('已继续原批次，原任务与预算保持不变');
      }
      return;
    }
    const personalOverrides: SavedPersonalInput = {};
    for (const field of current.sharedLive.overriddenFields || []) {
      if (!['prompt', 'model', 'quality', 'resolution', 'count', 'aspectRatio'].includes(field)) continue;
      const value = field === 'prompt' ? current.personalPrompt : current[field];
      if (field === 'count' ? !Number.isInteger(value) : typeof value !== 'string') throw new Error('原批次的本人已保存输入尚未完整读取，未继续生成');
      Object.assign(personalOverrides, { [field]: value });
    }
    const continuation = { sharedLive: current.sharedLive.intent, personalOverrides, personalPrompt: personalOverrides.prompt ?? '', moduleRevision: current.revision };
    const quote: ContinuationQuote = await readResult(await fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'quote', id, ...continuation }), signal: AbortSignal.timeout(120000) }));
    if (!valid()) return;
    if (!['fixed', 'actual'].includes(quote.billingMode) || !Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0
      || !Number.isFinite(quote.unitCredits) || quote.unitCredits < 0 || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()
      || quote.batchQuoteId !== null && typeof quote.batchQuoteId !== 'string'
      || quote.billingMode === 'actual' && !quote.batchQuoteId || !sameDefinition(quote.sharedLive, continuation.sharedLive)
      || quote.imageChannel && (!quote.imageChannel.channelId || !quote.imageChannel.configRevision)) throw new Error('剩余项报价尚未完整确认，原批次保持不变');
    const remainingCredits = Math.ceil(quote.estimatedCredits);
    const minimumBudget = fresh.committedCredits + remainingCredits;
    const suggestedBudget = Math.max(fresh.budget, minimumBudget);
    if (!Number.isSafeInteger(suggestedBudget) || suggestedBudget < 0 || suggestedBudget > 10000000) throw new Error('整批最高点数超出可确认范围，原批次保持不变');
    const defaults = current.sharedLive.defaults;
    const model = personalOverrides.model ?? defaults.model ?? current.model;
    const quality = personalOverrides.quality ?? defaults.quality ?? current.quality;
    const policy = defaults.referencePolicy;
    const description = [`当前模板：${current.name}`, typeof current.templatePrompt === 'string' && current.templatePrompt ? `模板画面描述：${current.templatePrompt.slice(0, 160)}` : '',
      `${IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model} · ${IMAGE_STUDIO_QUALITY_LABELS[quality as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || quality} · ${personalOverrides.resolution ?? defaults.resolution ?? current.resolution} · ${personalOverrides.aspectRatio ?? defaults.aspectRatio ?? current.aspectRatio}`,
      policy ? `主图要求：${policy.primaryMin} 至 ${policy.primaryMax} 张` : '',
      `剩余未受理 ${fresh.pending} 项，预计 ${remainingCredits} 点；已受理计入 ${fresh.committedCredits} 点。`,
      '只继续原批剩余项，保留本人已保存输入和原素材；已受理、未知和成功项不重发。', '填写整批最高点数（包含已受理部分）：'].filter(Boolean).join('\n');
    let mutationSent = false;
    await askBudget(description, String(suggestedBudget), { title: '确认继续', confirmLabel: `确认继续 · ${remainingCredits}点`, maxLength: 8, anchor: null,
      onSubmit: async value => {
        if (!valid()) throw new Error('已离开原批次，未继续生成');
        if (mutationSent) {
          const observed = await readOriginal(); setBatch(observed);
          throw new Error('已查询原批次，不会重复发送继续请求；请关闭确认框查看最新状态');
        }
        if (!/^\d{1,8}$/.test(value)) throw new Error('请填写整批最高点数，不能包含小数');
        const budget = Number(value);
        if (!Number.isSafeInteger(budget) || budget < minimumBudget || budget > 10000000) throw new Error(`整批最高点数须为 ${minimumBudget} 至 10000000 点`);
        if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error('报价已过期，未继续生成；请关闭确认框重新读取报价');
        const latestBatch = await readOriginal();
        const latestDefinition = await readDefinition();
        if (continuationSignature(latestBatch) !== continuationSignature(fresh)
          || latestDefinition.revision !== current.revision || !sameDefinition(latestDefinition.sharedLive.intent, continuation.sharedLive)) {
          setBatch(latestBatch); onSourceChanged?.();
          throw new Error('原批次或当前模板已变化，未继续生成；请关闭确认框重新报价');
        }
        if (!valid() || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('报价或当前页面已变化，未继续生成；请重新核对');
        mutationSent = true;
        try {
          const result = await readResult(await fetch('/api/image-studio/batches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, action: 'resume', ...continuation, budget, ...(quote.batchQuoteId ? { batchQuoteId: quote.batchQuoteId } : {}),
              ...(quote.imageChannel ? { imageChannel: quote.imageChannel } : {}) }), signal: AbortSignal.timeout(120000) }), true);
          if (!valid()) return;
          if (result.batch.id !== id) throw new Error('继续回执未匹配原批次，请查询原批次，不要新建任务');
          setBatch(result.batch); onSourceChanged?.();
          if (result.batch.definitionConfirmationRequired || result.batch.state === 'needs-confirmation'
            || !sameDefinition(result.batch.sharedLive, continuation.sharedLive)) throw Object.assign(new Error('模板或剩余项再次变化，原批次仍待确认；请关闭确认框重新核对'), { status: 409 });
          setSelected([]);
          setContinuationMessage('已确认当前模板与整批最高点数，只重新准备未受理项；原任务和结果保留');
          watchGenerationCompletion(userId, id, 'batch', fresh.total, crypto.randomUUID(), fresh.generated);
        } catch (cause) {
          if (valid()) {
            const status = Number((cause as { status?: number })?.status);
            if ([401, 403, 404, 409].includes(status)) onSourceChanged?.();
            setError(status >= 400 && status < 500 ? cause instanceof Error ? cause.message : '继续请求被拒绝，原批次保持不变'
              : '继续结果尚未确认，请查询原批次；不会自动再发继续请求或新建批次');
          }
          throw cause;
        }
      } });
  }
  async function action(action: string) {
    if (actionLock.current || !batch) return;
    actionLock.current = true; setBusy(true); setError(''); setContinuationMessage('');
    const expected = `${userId}:${id}`, ordinals = [...selected], retryBudget = batch.committedCredits + ordinals.length * batch.unitCredits;
    try {
      if (action === 'resume' && (batch.sharedLive || batch.definitionConfirmationRequired || batch.state === 'needs-confirmation')) {
        await continueSharedBatch(expected); return;
      }
      const quoteRetry = async () => {
        if (!batch.model) throw new Error('原批次模型报价无法核对，请先查询原批次；没有重新生成');
        const current = await readBatchResponse(await fetch('/api/image-studio/settings', { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
        if (scope.current !== expected || current.prices?.[batch.model] !== batch.unitCredits) throw new Error('本批报价已变化，请重新核对；没有重试生成');
      };
      if (action === 'retry') {
        await quoteRetry();
        if (!await confirm(`仅重试所选失败${ordinals.length}项，本次预计${ordinals.length * batch.unitCredits}点；已成功结果不再生成。`, { title: '确认重试', confirmLabel: `确认重试 · ${ordinals.length * batch.unitCredits}点`, anchor: null })) return;
        await quoteRetry();
      }
      if (scope.current !== expected) return;
      const data = await readBatchResponse(await fetch('/api/image-studio/batches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, ...(action === 'retry' ? { ordinals, budget: retryBudget } : {}) }), signal: AbortSignal.timeout(20000) }), true);
      if (scope.current !== expected) return;
      if (action === 'retry') watchGenerationCompletion(userId, id, 'batch', batch.total, crypto.randomUUID(), batch.generated);
      setBatch(data.batch); setSelected([]);
    } catch (error) { if (scope.current === expected) { setError(error instanceof Error ? error.message : '操作结果待确认，请刷新原批次'); if (action === 'resume') onSourceChanged?.(); } }
    finally { actionLock.current = false; if (scope.current === expected) setBusy(false); }
  }
  async function chooseDirectory() {
    try { const selected = await selectBatchDirectory('readwrite'); setDirectory(selected); childDirectory.current = null; delivery.directory = selected; delivery.child = null; delivery.saved = {}; setSaved({}); setSaveError(''); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setSaveError(error instanceof Error ? error.message : '请重新选择保存位置'); }
  }
  async function saveImages(automatic = false) {
    if (!batch || !directory || saveLock.current || delivery.lock) return;
    saveLock.current = true; delivery.lock = true; setSaveBusy(true); setSaveError('');
    const nextSaved = { ...delivery.saved }, expected = `${userId}:${id}`;
    try {
      if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted' && (automatic || await directory.requestPermission({ mode: 'readwrite' }) !== 'granted')) throw new Error('目录权限已失效，请重新选择保存位置');
      if (!delivery.child) delivery.child = await newBatchOutputDirectory(directory, id);
      childDirectory.current = delivery.child;
      for (const item of batch.items || []) {
        if (scope.current !== expected) throw new Error('已离开本批结果，后续本机保存已停止');
        if (!item.image || nextSaved[item.ordinal]) continue;
        const response = await fetch(item.image.url, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`第 ${item.ordinal} 张读取失败，请重试保存`);
        const blob = await response.blob();
        if (scope.current !== expected) throw new Error('已离开本批结果，后续本机保存已停止');
        if (!blob.type.startsWith('image/png') || !blob.size || blob.size > 96 * 1024 * 1024) throw new Error(`第 ${item.ordinal} 张图片格式或大小未确认`);
        const fileName = await writeUniqueBatchFile(childDirectory.current, safeBatchFileName(id, item.ordinal, item.sourceName), blob);
        nextSaved[item.ordinal] = fileName; delivery.saved = { ...nextSaved }; setSaved({ ...nextSaved });
      }
      await writeUniqueBatchFile(childDirectory.current, 'results.json', JSON.stringify({ batch: id, createdAt: batch.createdAt, generated: batch.generated, total: batch.total, saved: Object.keys(nextSaved).length,
        items: batch.items?.map(item => ({ ordinal: item.ordinal, source: item.sourceName, task: item.taskId, generation: item.status, file: nextSaved[item.ordinal] || null, save: nextSaved[item.ordinal] ? 'saved-and-size-checked' : 'not-saved' })) }, null, 2));
    } catch (error) { setAutoSave(false); setSaveError(error instanceof Error ? error.message : '保存未完成，请重选目录或补保存；不会重新生成'); }
    finally { saveLock.current = false; delivery.lock = false; setSaveBusy(false); }
  }
  useEffect(() => { if (autoSave && directory && !saveBusy && batch?.items?.some(item => item.image && !saved[item.ordinal])) void saveImages(true); }, [autoSave, directory, batch, saved, saveBusy]);
  const packages: Array<NonNullable<StudioBatchView['items']>> = [];
  for (const item of batch?.items || []) {
    if (!item.image || !item.taskId) continue;
    const previous = packages[packages.length - 1];
    if (!previous || previous.length >= STUDIO_BATCH_LIMITS.zipImages || previous.reduce((sum, entry) => sum + (entry.image?.fileSize || 0), 0) + item.image.fileSize > STUDIO_BATCH_LIMITS.zipBytes) packages.push([item]);
    else previous.push(item);
  }
  async function downloadPackage(index: number) {
    if (saveLock.current || !packages[index]?.length) return false;
    const expected = `${userId}:${id}`;
    saveLock.current = true; setSaveBusy(true); setSaveError('');
    try {
      const query = new URLSearchParams({ batchId: id }); packages[index].forEach(item => query.append('id', item.taskId!));
      const name = `batch-${id.slice(0, 12)}-part-${index + 1}.zip`, url = `/api/image-studio/download?${query}`;
      if (scope.current !== expected) return false;
      await handImageDownloadToBrowser(url, name, () => scope.current === expected);
      if (scope.current !== expected) return false;
      setZipReady({ url, name });
      setProvided(previous => Array.from(new Set([...previous, ...packages[index].map(item => item.ordinal)])));
      return true;
    } catch (error) { if (scope.current === expected) setSaveError(error instanceof Error ? error.message : '下载准备失败，已有图片仍保留'); return false; }
    finally { saveLock.current = false; if (scope.current === expected) setSaveBusy(false); }
  }
  useEffect(() => {
    if (!autoPack || !batch || batch.active || batch.pending || batch.uncertain || !['complete', 'cancelled'].includes(batch.state) || !packages.length) return;
    const expected = `${userId}:${id}`;
    void (async () => {
      for (let index = 0; index < packages.length; index++) {
        const key = packages[index].map(item => item.taskId).join('|');
        if (scope.current !== expected || packed.current.has(key)) continue;
        packed.current.add(key);
        if (!await downloadPackage(index)) break;
      }
    })();
  // The terminal result set determines packages; exporting never creates image tasks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPack, batch?.state, batch?.generated, batch?.active, batch?.pending, batch?.uncertain]);
  const statusLabel = (state: string) => ({ pending: '等待派发', 'needs-confirmation': '模板已更新，待确认后继续', queued: '已受理，排队中', running: '生成中', succeeded: '已生成', failed: '生成失败', uncertain: '结果待确认', cancelled: '未派发，已取消' } as Record<string, string>)[state] || '状态待确认';
  const resultItems = useMemo(() => (batch?.items || []).map(item => ({
    ...item, id: String(item.ordinal), label: `${item.ordinal}. ${item.sourceName}`, generationStatus: item.status,
    status: statusLabel(item.status), pending: ['pending', 'queued', 'running'].includes(item.status),
    media: item.image ? { src: item.image.url, thumbnailSrc: item.image.thumbnail, alt: `第 ${item.ordinal} 张结果`, fileName: 'batch-image.png',
      contentKey: `asset:${item.image.id}` as const,
      comparisonCandidates: (batch?.items || []).flatMap(other => other.image ? [{ src: other.image.url, thumbnailSrc: other.image.thumbnail, alt: `生成结果 ${other.ordinal}`, contentKey: `asset:${other.image.id}` as const }] : []),
    } : undefined,
    download: item.image && item.taskId ? () => handImageDownloadToBrowser(`/api/image-studio/download?id=${encodeURIComponent(item.taskId!)}`, 'batch-image.png', () => scope.current === `${userId}:${id}`) : undefined,
  } satisfies GeneratedImageResult & { generationStatus: string })), [batch?.items, id, userId]);
  return <div className={styles.results} aria-label="批次结果">
    <div className={styles.actions}><strong>{batch?.moduleName || '本批结果'}</strong><button type="button" title="刷新批次" aria-label="刷新批次" disabled={reading} onClick={() => void load()}><RefreshCw size={16} /></button>{deliveryOnly && <a href={`/assets?imageBatchId=${encodeURIComponent(id)}`}>本批资产</a>}</div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {continuationMessage && <p role="status">{continuationMessage}</p>}
    {!batch && <p role="status">{reading ? '正在读取原批次' : '尚未读取批次'}，不会重新提交生成。</p>}
    {batch && <>
      <p className={styles.summary}>{batchStateLabel(batch.state)} · <RelativeTime value={batch.createdAt} /> · 已生成 {batch.generated}/{batch.total} · 已保存 {Object.keys(saved).length}/{batch.generated} · 失败 {batch.failed} · 待确认 {batch.uncertain}</p>
      {!deliveryOnly && <p>素材已准备 {batch.prepared}/{batch.total} · 在途 {batch.active} · 未派发 {batch.pending}</p>}
      {batch.note && <p role="status">{batch.note}</p>}
      {(batch.state === 'needs-confirmation' || batch.definitionConfirmationRequired) && <p role="status">当前模板需要重新确认，剩余未受理 {batch.pending} 项；已受理与未知结果不会重发。</p>}
      <div className={styles.actions}>
        {['preparing', 'blocked'].includes(batch.state) && !batch.definitionConfirmationRequired && batch.prepared < batch.total && <button type="button" disabled={busy} onClick={() => void action('prepare')}><RefreshCw size={16} />继续准备原批素材</button>}
        {['ready', 'needs-confirmation'].includes(batch.state) && <button type="button" disabled={busy} onClick={() => void action('pause')}><Pause size={16} />暂停未派发</button>}
        {(['paused', 'blocked'].includes(batch.state) && batch.prepared === batch.total || batch.definitionConfirmationRequired || batch.state === 'needs-confirmation')
          && batch.pending > 0 && !['cancelled', 'complete'].includes(batch.state) && <button type="button" className={styles.primary} disabled={busy} onClick={() => void action('resume')}><Play size={16} />{batch.definitionConfirmationRequired || batch.state === 'needs-confirmation' ? '核对并继续剩余' : '继续剩余'}</button>}
        {!['cancelled', 'complete'].includes(batch.state) && <button type="button" disabled={busy} onClick={() => void action('cancel')}><X size={16} />取消未派发</button>}
      </div>
      {batch.uncertain > 0 && <p role="status">结果未知项不会自动重发。请刷新查询原任务，仍未知时联系管理员核对。</p>}
      {batch.generated > 0 && <div className={styles.delivery}>
        <div className={styles.actions}>{canSelectBatchDirectory() && <button type="button" disabled={saveBusy} onClick={() => void chooseDirectory()}><FolderOpen size={16} />{directory ? '重新选择保存位置' : '选择结果保存位置'}</button>}
          {directory && <><label><input type="checkbox" checked={autoSave} onChange={event => setAutoSave(event.target.checked)} />本页打开时自动保存新结果</label><button type="button" className={styles.primary} disabled={saveBusy || Object.keys(saved).length === batch.generated} onClick={() => void saveImages()}><Save size={16} />{saveBusy ? '保存中' : '补保存已有图片'}</button></>}
          {packages.map((items, index) => <button type="button" key={index} disabled={saveBusy} onClick={() => void downloadPackage(index)}><Download size={16} />下载第 {index + 1} 包 · {items.length} 张</button>)}</div>
        {directory && <p>保存至所选位置的新批次子目录，不覆盖已有文件。关网页后不会继续写本机。</p>}
        {provided.length > 0 && <p role="status">已提供 {provided.length} 张下载，尚未确认本机落盘。</p>}
        {zipReady && <a href={zipReady.url} download={zipReady.name}>再次下载已准备的包</a>}
        {saveError && <p role="alert" className={styles.error}>{saveError}，只补保存，不重新生成。</p>}
      </div>}
      {!deliveryOnly && batch.failed > 0 && <div className={styles.retry}><span>选中失败项 {selected.length} 张，本次重试预计 {selected.length * batch.unitCredits} 点；每项最多重试 3 次</span><button type="button" disabled={busy || !selected.length} onClick={() => void action('retry')}><RotateCcw size={16} />重试选中失败项</button></div>}
      {!deliveryOnly && <GeneratedImageResults items={resultItems} scope={`sd2-image-studio-batch-page:${userId}:${id}`}
        visible={visible} onQuickUse={onQuickUse ? item => { if (item.image) onQuickUse(item.image.id); } : undefined}
        busy={reading} emptyLabel="暂无本批图片" renderSupplement={item => <>
          {saved[item.ordinal] && <p>已保存并核对大小</p>}
          {item.generationStatus === 'failed' && <label><input type="checkbox" disabled={busy} aria-label={`重试第 ${item.ordinal} 项`} checked={selected.includes(item.ordinal)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.ordinal] : previous.filter(value => value !== item.ordinal))} />重试此项</label>}
        </>} />}
    </>}
    {productDialog}
  </div>;
}

export function StudioBatchHistory({ userId, initialId }: { userId: string; initialId?: string }) {
  const [open, setOpen] = useState(false), [batches, setBatches] = useState<StudioBatchView[]>([]), [id, setId] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false);
  useEffect(() => { if (initialId && /^[a-f0-9]{64}$/.test(initialId)) { setId(initialId); setOpen(true); } }, [initialId]);
  async function load(more = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const data = await readBatchResponse(await fetch(`/api/image-studio/batches${more && cursor ? `?cursor=${cursor}` : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      setBatches(previous => more ? [...previous, ...data.batches] : data.batches); setCursor(data.nextCursor);
    } catch (error) { setError(error instanceof Error ? error.message : '批次读取失败'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { if (open) { dialog.current?.showModal(); void load(); } }, [open]);
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: () => setOpen(false) });
  return <><button type="button" onClick={() => setOpen(true)}><FolderOpen size={16} />我的批次</button>{open && <dialog ref={dialog} className={styles.dialog} aria-labelledby="batch-history-title">
    <header className={styles.actions}><h2 id="batch-history-title">我的批次</h2><button type="button" aria-label="关闭我的批次" onClick={() => setOpen(false)}><X size={18} /></button></header>
    {id ? <><button type="button" onClick={() => setId(null)}>返回批次列表</button><BatchResults key={`${userId}:${id}`} id={id} userId={userId} /></> : <>
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />刷新批次</button></div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {!batches.length && !busy && !error && <p>暂无批次</p>}
      {batches.map(batch => <article className={styles.historyItem} key={batch.id}><button type="button" onClick={() => setId(batch.id)}><strong>{batch.moduleName}</strong><span>{batchStateLabel(batch.state)} · 已生成 {batch.generated}/{batch.total}</span></button><RelativeTime value={batch.createdAt} /></article>)}
      {cursor && <button type="button" disabled={busy} onClick={() => void load(true)}>加载更多</button>}
    </>}
  </dialog>}</>;
}
