'use client';
import { validVideoPricingAmount } from '@/lib/pricing-client';
import { creditCents, normalizeCredits } from '@/lib/credits/precision';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, RotateCcw } from 'lucide-react';
import { createUploadBatch, uploadFileAsAsset } from '@/lib/http/file-upload';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useProductDialog } from '@/components/useProductDialog';
import { STUDIO_BATCH_LIMITS } from '@/lib/image-studio/batch-contract';
import { readBatchResponse } from '@/lib/image-studio/batch-receipt';
import { canSelectBatchDirectory, selectBatchDirectory, readBatchDirectory, previewBatchFiles, type BatchLocalFile } from './batch-files';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_QUALITY_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import styles from './batch.module.css';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';
import type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';
import { imageStudioChannelUnitCredits, imageStudioEffectiveChannelId, normalizeImageStudioChannels } from '@/lib/image-studio/channels';
import type { SharedStudioIntent } from '@/lib/image-studio/shared-types';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

export type ImageUiQuote = { billingMode: 'fixed' | 'actual'; billingQuoteId?: string | null; batchQuoteId?: string | null; pricingRevision?: string | null; creditPrecision?: number; estimatedCredits: number; unitCredits: number; expiresAt?: string; imageChannel?: ImageGenerationChannelSnapshot };
export function formatImageUiCredits(value: number): string {
  return validVideoPricingAmount(value) ? String(normalizeCredits(value)) : '待确认';
}
export function imageUiQuotePriceText(quote: Pick<ImageUiQuote, 'billingMode' | 'estimatedCredits'>): string {
  if (!validVideoPricingAmount(quote.estimatedCredits)) return '费用待报价';
  const amount = formatImageUiCredits(quote.estimatedCredits);
  return quote.billingMode === 'actual' ? `最多预留 ${amount} 点，按账单结算` : `本次扣 ${amount} 点`;
}
export function validImageUiQuote(quote: ImageUiQuote, now = Date.now(), batch = false): boolean {
  const token = batch ? quote.batchQuoteId : quote.billingQuoteId;
  return ['fixed', 'actual'].includes(quote.billingMode)
    && validVideoPricingAmount(quote.unitCredits) && validVideoPricingAmount(quote.estimatedCredits)
    && typeof quote.expiresAt === 'string' && Date.parse(quote.expiresAt) > now
    && (quote.pricingRevision == null || typeof quote.pricingRevision === 'string' && quote.pricingRevision.length > 0)
    && (quote.creditPrecision === undefined || quote.creditPrecision === 0.01 || quote.creditPrecision === 0.1)
    && (quote.creditPrecision !== 0.1 || creditCents(quote.unitCredits) % 10 === 0 && creditCents(quote.estimatedCredits) % 10 === 0)
    && (token == null || typeof token === 'string' && token.length > 0)
    && (!(quote.billingMode === 'actual' || quote.pricingRevision != null) || typeof token === 'string' && token.length > 0);
}
export function imageUiQuoteChanged(previous: ImageUiQuote | null, next: ImageUiQuote): boolean {
  return !previous || previous.billingMode !== next.billingMode || previous.pricingRevision !== next.pricingRevision
    || previous.unitCredits !== next.unitCredits || previous.estimatedCredits !== next.estimatedCredits
    || previous.imageChannel?.channelId !== next.imageChannel?.channelId
    || previous.imageChannel?.configRevision !== next.imageChannel?.configRevision
    || JSON.stringify(previous.imageChannel?.qualityRoute) !== JSON.stringify(next.imageChannel?.qualityRoute);
}
export function imageUiQuoteAction(pendingRequestId: string | null, signature: string, cachedSignature: string | undefined,
  quote: ImageUiQuote | null | undefined, now = Date.now(), batch = false): 'query' | 'quote' | 'submit' {
  if (pendingRequestId) return 'query';
  return signature && signature === cachedSignature && quote && validImageUiQuote(quote, now, batch) ? 'submit' : 'quote';
}
export function imageUiQuoteFields(quote: ImageUiQuote, batch = false) {
  if (!validImageUiQuote(quote, Date.now(), batch)) throw new Error('报价已过期或不完整，尚未提交生成');
  return { ...(quote.imageChannel ? { imageChannel: quote.imageChannel } : {}),
    ...(batch ? quote.batchQuoteId ? { batchQuoteId: quote.batchQuoteId } : {} : quote.billingQuoteId ? { billingQuoteId: quote.billingQuoteId } : {}),
    ...(quote.pricingRevision ? { pricingRevision: quote.pricingRevision } : {}),
    ...(batch ? { budget: quote.estimatedCredits } : { maxEstimatedCost: quote.estimatedCredits }) };
}
export function imageUiBudgetPrecision(quote: ImageUiQuote, committedCredits: number): 0.01 | 0.1 | 1 {
  if (quote.pricingRevision == null) return 1;
  return quote.creditPrecision === 0.1 && creditCents(committedCredits) % 10 === 0 ? 0.1 : 0.01;
}
export function parseImageUiBudget(value: string, precision: 0.01 | 0.1 | 1 = 0.01): number | null {
  if (!(precision === 1 ? /^\d{1,8}$/ : /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/).test(value)) return null;
  const amount = Number(value);
  return validVideoPricingAmount(amount) && creditCents(amount) % (precision * 100) === 0 ? normalizeCredits(amount) : null;
}
type StudioBatchQuote = ImageUiQuote & { batchQuoteId: string | null; expiresAt: string };
type CachedStudioBatchQuote = { signature: string; requestId: string; quote: StudioBatchQuote; expired?: boolean };

export function useStudioBatch({ userId, moduleId, unitCredits, draftSignature, actualQuoteRequired = false, pricingBySpecification = false, quotePayload, effectiveChannelId, sharedLive, sourceAvailable = true, onSourceChanged, readSettings }: { userId: string; moduleId: string; unitCredits: number | null; draftSignature: string; actualQuoteRequired?: boolean; pricingBySpecification?: boolean; quotePayload?: Record<string, unknown> | null; effectiveChannelId?: string; sharedLive?: SharedStudioIntent; sourceAvailable?: boolean; onSourceChanged?: () => void; readSettings: () => Promise<import('./settings-controller').SettingsValue | null> }) {
  const settingsReader = useRef(readSettings); settingsReader.current = readSettings;
  const { sessionChanged } = useAppSession();
  const channelQuoteMatches = (quote: StudioBatchQuote, payload: Record<string, unknown>) => !payload.channelId
    || (payload.channelId === 'original' && (!effectiveChannelId || effectiveChannelId === 'original'))
    || (quote.imageChannel?.channelId === (effectiveChannelId || payload.channelId) && typeof quote.imageChannel.configRevision === 'string' && Boolean(quote.imageChannel.configRevision));
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [source, setSource] = useState<'current' | 'folder'>('folder');
  const [quantity, setQuantity] = useState(8), [perFile, setPerFile] = useState(1), [pack, setPack] = useState(false);
  const [folderName, setFolderName] = useState(''), [advanced, setAdvanced] = useState(false);
  const [files, setFiles] = useState<BatchLocalFile[]>([]), [skipped, setSkipped] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('');
  const [id, setId] = useState<string | null>(null), [pending, setPending] = useState<string | null>(null);
  const [billingQuote, setBillingQuote] = useState<CachedStudioBatchQuote | null>(null);
  const [quoteVisible, setQuoteVisible] = useState(true);
  useEffect(() => { const update = () => setQuoteVisible(!document.hidden); update(); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  const [loadedScope, setLoadedScope] = useState('');
  const [recoveryKnownScope, setRecoveryKnownScope] = useState('');
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null), lock = useRef(false), fileRef = useRef<BatchLocalFile[]>([]);
  const scopedKey = `sd2-studio-batch-draft:v1:${userId}:${moduleId}`, pendingKey = `${scopedKey}:request`;
  const loaded = loadedScope === scopedKey;
  const total = source === 'current' ? quantity : files.length * perFile;
  const signature = JSON.stringify([scopedKey, sharedLive, sourceAvailable, source, quantity, perFile, unitCredits, draftSignature,
    actualQuoteRequired, pricingBySpecification, files.map(local => [local.file.name, local.file.size, local.file.lastModified])]);
  const sourceChanged = useRef(onSourceChanged); sourceChanged.current = onSourceChanged;
  const previousDefinition = useRef(sharedLive?.definitionToken);
  useEffect(() => {
    if (previousDefinition.current && previousDefinition.current !== sharedLive?.definitionToken) {
      setBillingQuote(null);
      setError('模板已更新，请确认本次生成；已提交的批次和素材保留。');
    }
    previousDefinition.current = sharedLive?.definitionToken;
  }, [sharedLive?.definitionToken]);
  const quoteSources: Array<{ name: string; assetId?: string }> = source === 'folder' && Number.isInteger(perFile) && perFile >= 1 && perFile <= 8
    ? files.flatMap(local => Array.from({ length: perFile }, (_, variant) => ({ name: `${local.file.name.replace(/\.[^.]+$/, '')}-v${variant + 1}`, ...(local.assetId ? { assetId: local.assetId } : {}) })))
    : source === 'current' && Number.isInteger(total) && total >= 1 && total <= STUDIO_BATCH_LIMITS.images
      ? Array.from({ length: total }, (_, index) => ({ name: `image-${index + 1}` })) : [];
  const quoteSignature = JSON.stringify([signature, quoteSources]);
  const quoteInputReady = quoteSources.length > 0 && quoteSources.length <= STUDIO_BATCH_LIMITS.images
    && (source !== 'folder' || quoteSources.every(item => item.assetId));
  const previousQuoteSignature = useRef(quoteSignature);
  const visibleQuote = !billingQuote?.expired && imageUiQuoteAction(pending, quoteSignature, billingQuote?.signature, billingQuote?.quote, Date.now(), true) === 'submit'
    ? billingQuote!.quote : null;
  const live = useRef({ scope: scopedKey, signature, mounted: true }); live.current = { scope: scopedKey, signature, mounted: live.current.mounted };
  const { confirm, productDialog } = useProductDialog();
  const automaticPayload = quotePayload ? JSON.stringify({ ...Object.fromEntries(Object.entries(quotePayload).filter(([key]) => key !== 'image_feishu')), ...(sharedLive ? { sharedLive } : {}) }) : '';
  useEffect(() => {
    if (sessionChanged || isClientSessionBlocked() || !sourceAvailable || !quoteVisible || mode !== 'batch' || !loaded || busy || previewing || pending || !automaticPayload
      || !quoteInputReady) return;
    if (billingQuote?.signature === quoteSignature && !billingQuote.expired && Date.parse(billingQuote.quote.expiresAt) > Date.now()) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      if (isClientSessionBlocked() || document.hidden) return;
      const requestId = crypto.randomUUID();
      const payload = { ...JSON.parse(automaticPayload), action: 'quote', count: 1, requestId, sources: JSON.parse(quoteSignature)[1] };
      void settingsReader.current().then(current => {
        if (!current || current.revision !== payload.revision || abort.signal.aborted || isClientSessionBlocked()) return null;
        return fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]) })
        .then(response => { if (!isClientSessionBlocked() && response.status === 409 && !abort.signal.aborted) sourceChanged.current?.(); return readBatchResponse(response); });
      }).then((quote: StudioBatchQuote | null) => {
          if (!quote || isClientSessionBlocked() || abort.signal.aborted || !validImageUiQuote(quote, Date.now(), true)
            || !channelQuoteMatches(quote, JSON.parse(automaticPayload))) return;
          previousQuoteSignature.current = quoteSignature;
          setBillingQuote({ signature: quoteSignature, requestId, quote });
        }).catch(() => {});
    }, 500);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [sessionChanged, sourceAvailable, actualQuoteRequired, pricingBySpecification, quoteVisible, mode, loaded, busy, previewing, pending, automaticPayload, quoteSignature, quoteInputReady, billingQuote, effectiveChannelId]);
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); }; }, []);
  useEffect(() => { if (previousQuoteSignature.current !== quoteSignature) setBillingQuote(null); previousQuoteSignature.current = quoteSignature; }, [quoteSignature]);
  useEffect(() => {
    if (!billingQuote?.quote.expiresAt) return;
    const delay = Date.parse(billingQuote.quote.expiresAt) - Date.now();
    if (delay <= 0) { setBillingQuote(current => current?.requestId === billingQuote.requestId ? { ...current, expired: true } : current); return; }
    const timer = window.setTimeout(() => setBillingQuote(current => current?.requestId === billingQuote.requestId ? { ...current, expired: true } : current), delay);
    return () => window.clearTimeout(timer);
  }, [billingQuote]);
  useUnsavedNavigation(busy || previewing || files.some(file => !file.assetId), confirm, { unsaved: files.some(file => !file.assetId) ? ['尚未上传的本机批量素材，离开后需重新选择'] : [], busy: busy ? ['批次素材或提交正在处理'] : previewing ? ['本机图片正在读取'] : [], revision: signature, onBlocked: setError });
  useEffect(() => {
    setRecoveryKnownScope('');
    fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); fileRef.current = []; setFiles([]); setSkipped([]); setFolderName(''); setError(''); setId(null); setPending(null); setBillingQuote(null);
    setMode('single'); setSource('folder'); setQuantity(8); setPerFile(1); setPack(false); setBusy(false); setPreviewing(false); setProgress('');
    try {
      const saved = JSON.parse(localStorage.getItem(scopedKey) || 'null');
      if (saved?.version === 1) {
        if (saved.mode === 'batch') setMode('batch');
        // Old text-batch preferences remain available, but do not silently enlarge a folder batch.
        if (saved.source === 'current') setSource('current');
        if (Number.isInteger(saved.quantity) && saved.quantity >= 1 && saved.quantity <= STUDIO_BATCH_LIMITS.images) setQuantity(saved.quantity);
        if (Number.isInteger(saved.perFile) && saved.perFile >= 1 && saved.perFile <= 8) setPerFile(saved.perFile);
        setPack(saved.pack === true);
        if (typeof saved.id === 'string' && /^[a-f0-9]{64}$/.test(saved.id)) setId(saved.id);
      }
    } catch { /* A broken cache never replays generation. */ }
    try {
      const request = localStorage.getItem(pendingKey);
      if (request !== null && /^[a-zA-Z0-9-]{16,80}$/.test(request)) {
        setPending(request); setMode('batch'); setRecoveryKnownScope(scopedKey);
      } else if (request === null) setRecoveryKnownScope(scopedKey);
    } catch { /* Unreadable request storage does not prove the absence of pending work. */ }
    setLoadedScope(scopedKey);
  }, [scopedKey, pendingKey]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(scopedKey, JSON.stringify({ version: 1, mode, source, quantity, perFile, pack, id })); }
    catch { setError('批次设置无法在本机记住，已有批次可从我的批次找回'); }
  }, [loaded, scopedKey, mode, source, quantity, perFile, pack, id]);
  useEffect(() => { fileRef.current = files; }, [files]);
  async function previewFiles(selected: File[], label = '所选素材', initialSkipped: string[] = []) {
    if (isClientSessionBlocked() || lock.current || !selected.length) return;
    const scope = scopedKey;
    lock.current = true; setPreviewing(true); setError('');
    try {
      const result = await previewBatchFiles(selected, initialSkipped);
      if (isClientSessionBlocked() || !live.current.mounted || live.current.scope !== scope) { result.accepted.forEach(file => URL.revokeObjectURL(file.preview)); return; }
      if (!result.accepted.length) { setSkipped(result.skipped); throw new Error('没有可用图片，原素材选择保留'); }
      fileRef.current.forEach(file => URL.revokeObjectURL(file.preview));
      fileRef.current = result.accepted; setFiles(result.accepted); setSkipped(result.skipped); setFolderName(label);
    } catch (error) { if (!isClientSessionBlocked() && live.current.mounted && live.current.scope === scope) setError(error instanceof Error ? error.message : '本机素材读取失败，尚未上传'); }
    finally { lock.current = false; if (live.current.mounted && live.current.scope === scope) setPreviewing(false); }
  }
  async function chooseSources() {
    if (isClientSessionBlocked()) return;
    if (!canSelectBatchDirectory()) { directoryInput.current?.click(); return; }
    const scope = scopedKey;
    try {
      const directory = await selectBatchDirectory('read');
      const selected = await readBatchDirectory(directory);
      if (!isClientSessionBlocked() && live.current.mounted && live.current.scope === scope) await previewFiles(selected.files, directory.name, selected.skipped);
    } catch (error) { if (!isClientSessionBlocked() && live.current.mounted && live.current.scope === scope && !(error instanceof DOMException && error.name === 'AbortError')) setError(error instanceof Error ? error.message : '素材目录权限失效或无法读取，请重新选择'); }
  }
  async function query() {
    if (isClientSessionBlocked() || !pending || lock.current) return;
    const scope = scopedKey;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await readBatchResponse(await fetch(`/api/image-studio/batches?requestId=${encodeURIComponent(pending)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }), true);
      if (isClientSessionBlocked() || !live.current.mounted || live.current.scope !== scope) return;
      setId(result.batch.id); setPending(null); localStorage.removeItem(pendingKey);
    } catch { if (!isClientSessionBlocked() && live.current.mounted && live.current.scope === scope) setError('原提交尚未核对，不会自动再生成；请稍后查询或联系管理员'); }
    finally { lock.current = false; if (live.current.mounted && live.current.scope === scope) setBusy(false); }
  }
  async function submit(payload: Record<string, unknown>) {
    if (isClientSessionBlocked()) return false;
    if (imageUiQuoteAction(pending, quoteSignature, billingQuote?.signature, billingQuote?.quote, Date.now(), true) === 'query') { await query(); return false; }
    if (!sourceAvailable) { setError('模板已不可用，不能新建批次；原批次和素材保留。'); return false; }
    if (lock.current || !loaded) return false;
    if (!Number.isInteger(total) || total < 1 || total > STUDIO_BATCH_LIMITS.images || !Number.isInteger(perFile) || perFile < 1 || perFile > 8) { setError('本批总图数须为1至100张，请选择有效素材或调整次级数量设置'); return false; }
    const scope = scopedKey, expected = signature, snapshot = JSON.parse(JSON.stringify({ ...payload, ...(sharedLive ? { sharedLive } : {}) })), localFiles = [...files];
    const sameScope = () => !isClientSessionBlocked() && live.current.mounted && live.current.scope === scope;
    const valid = () => sameScope() && live.current.signature === expected;
    lock.current = true; setBusy(true); setError('');
    let submittedRequest: string | null = null;
    try {
      const checkSettings = async () => {
        if (!valid()) throw new Error('账号或当前设置已变化，尚未生成');
        const current = await settingsReader.current();
        if (!current) throw new Error('未能读取当前通用设置，素材保留，尚未生成');
        if (!valid() || current.revision !== snapshot.revision) throw new Error('素材、模型或报价已变化，请重新读取设置后确认；尚未生成');
        const channelId = typeof snapshot.channelId === 'string' ? snapshot.channelId : 'original';
        const freshChannels = normalizeImageStudioChannels(current.imageChannels);
        const freshEffectiveId = imageStudioEffectiveChannelId(freshChannels, String(snapshot.model), channelId, String(snapshot.quality));
        if (freshEffectiveId !== (effectiveChannelId || channelId)) throw new Error('后台默认供应商已变化，请重新读取设置并确认；素材保留，尚未生成');
        const channel = freshChannels.items.find(item => item.id === freshEffectiveId);
        const model = String(snapshot.model) as ImageStudioModel;
        if (!IMAGE_STUDIO_MODELS.includes(model)) throw new Error('本批型号无效；素材保留，尚未生成');
        const capability = channel?.models?.[model];
        if (Boolean(capability?.pricingBySpecification) !== pricingBySpecification) throw new Error('图片计价范围已变化，请重新读取设置并报价；素材保留，尚未生成');
        if (freshEffectiveId === 'original') {
          if (!pricingBySpecification) {
            if (current.prices?.[model] !== unitCredits) throw new Error('素材、模型或报价已变化，请重新读取设置后确认；尚未生成');
            return;
          }
        }
        if (!channel?.enabled || !channel.configured || !channel.ready || !capability?.ready
          || capability.billingMode === 'actual' && !actualQuoteRequired
          || capability.billingMode === 'fixed' && !pricingBySpecification
            && imageStudioChannelUnitCredits(capability, false, freshEffectiveId, current.prices?.[model]) !== unitCredits) {
          throw new Error('所选生图通道或报价已变化，请重新读取设置后确认；尚未生成');
        }
      };
      await checkSettings();
      if (!valid()) return false;
      const sources: Array<{ name: string; assetId?: string }> = [];
      if (source === 'folder') {
        const uploadBatch = createUploadBatch(userId);
        for (let index = 0; index < localFiles.length; index++) {
          if (!valid()) throw new Error('已离开或切换本批，未继续上传或生成');
          const local = localFiles[index];
          if (!local.assetId) {
            const asset = await uploadFileAsAsset(local.file, { ownerId: userId, batch: uploadBatch, onProgress: progress => { if (valid()) setProgress(`上传素材 ${index + 1}/${localFiles.length} · ${progress.label}`); } });
            if (!asset.id) throw new Error('素材上传尚未确认，请重新核对');
            local.assetId = asset.id;
            if (!valid()) throw new Error('素材已保存，但原页面已变化；未提交生成');
            setFiles([...localFiles]);
          }
          for (let variant = 0; variant < perFile; variant++) sources.push({ name: `${local.file.name.replace(/\.[^.]+$/, '')}-v${variant + 1}`, assetId: local.assetId });
        }
      } else for (let index = 0; index < total; index++) sources.push({ name: `image-${index + 1}` });
      if (!valid()) throw new Error('当前设置已变化，未提交生成');
      await checkSettings();
      if (!valid()) return false;
      const quoteKey = JSON.stringify([expected, sources]);
      const priorQuote = billingQuote?.signature === quoteKey ? billingQuote : null;
      const requestId = priorQuote?.requestId || crypto.randomUUID();
      const quoteRequest = { ...snapshot, action: 'quote', requestId, count: 1, sources };
      const readQuote = async () => {
        if (!valid()) throw new Error('账号或当前设置已变化，尚未生成');
        const response = await fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteRequest), signal: AbortSignal.timeout(120000) });
        if (valid() && response.status === 409) sourceChanged.current?.();
        const result = await readBatchResponse(response) as StudioBatchQuote;
        if (!valid()) throw new Error('当前设置已变化，报价未用于生成');
        if (!validImageUiQuote(result, Date.now(), true)
          || !channelQuoteMatches(result, snapshot)) throw new Error('本批报价信息不完整或通道已变化，尚未生成');
        return result;
      };
      let quote = priorQuote && !priorQuote.expired && Date.parse(priorQuote.quote.expiresAt) > Date.now() ? priorQuote.quote : await readQuote();
      previousQuoteSignature.current = quoteKey;
      setBillingQuote({ signature: quoteKey, requestId, quote });
      if (priorQuote && (priorQuote.expired || Date.parse(priorQuote.quote.expiresAt) <= Date.now() || imageUiQuoteChanged(priorQuote.quote, quote))) {
        setError(`报价已更新为 ${formatImageUiCredits(quote.estimatedCredits)} 点，本批尚未生成；请再次点击确认。`);
        return false;
      }
      const quoteTotal = quote.estimatedCredits;
      if (!validVideoPricingAmount(quoteTotal)) throw new Error('本批报价超出可确认范围，尚未生成');
      const currentBalance = await readBatchResponse(await fetch('/api/me/credits', { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      if (!valid()) return false;
      if (quoteTotal > 0 && (!Number.isFinite(currentBalance.available) || currentBalance.available < quoteTotal)) throw new Error('可用点数不足，素材已上传但尚未生成');
      const model = IMAGE_STUDIO_MODEL_LABELS[String(snapshot.model) as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || String(snapshot.model);
      const quality = IMAGE_STUDIO_QUALITY_LABELS[String(snapshot.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || String(snapshot.quality || '默认');
      if (!await confirm(`${source === 'folder' ? localFiles.length + '张已上传素材' : '当前正文'} · 生成${total}张\n${model} · ${quality} · ${String(snapshot.resolution || '默认')} · ${String(snapshot.aspectRatio || '自动')}\n${imageUiQuotePriceText(quote)}`, { title: '确认生成', confirmLabel: `确认生成 · ${quoteTotal}点`, anchor: null })) return false;
      if (!valid()) throw new Error('当前设置已变化，尚未生成，请重新确认');
      await checkSettings();
      if (!valid()) return false;
      const confirmedTotal = quoteTotal;
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        setProgress('报价已过期，正在重新获取本批报价');
        quote = await readQuote();
        setBillingQuote({ signature: quoteKey, requestId, quote });
        setError(`报价已更新为 ${formatImageUiCredits(quote.estimatedCredits)} 点，本批尚未生成；请再次点击并确认新总额。`);
        return false;
      }
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        setBillingQuote(current => current?.requestId === requestId ? { ...current, expired: true } : current);
        setError('本批报价再次过期，尚未生成；请重新获取并确认报价。');
        return false;
      }
      if (!valid()) return false;
      localStorage.setItem(pendingKey, requestId);
      if (localStorage.getItem(pendingKey) !== requestId) throw new Error('提交编号未能保存，尚未提交生成');
      submittedRequest = requestId; setPending(requestId); setProgress('正在登记本批素材和设置');
      setBillingQuote(null);
      if (!valid()) return false;
      const response = await fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...snapshot, requestId, count: 1, sources, ...imageUiQuoteFields(quote, true), budget: confirmedTotal }), signal: AbortSignal.timeout(120000) });
      if (!sameScope()) return false;
      if (response.status === 409) sourceChanged.current?.();
      if (response.status >= 400 && response.status < 500) { localStorage.removeItem(pendingKey); submittedRequest = null; if (sameScope()) setPending(null); }
      const result = await readBatchResponse(response, true);
      if (!sameScope()) return false;
      localStorage.removeItem(pendingKey);
      if (!sameScope()) return false;
      watchGenerationCompletion(userId, result.batch.id, 'batch', total);
      setId(result.batch.id); setPending(null); return true;
    } catch (error) { if (sameScope()) { setError(error instanceof Error ? error.message : '批次提交结果未确认'); if (submittedRequest) setPending(submittedRequest); } return false; }
    finally { lock.current = false; if (live.current.mounted && live.current.scope === scope) { setBusy(false); setProgress(''); } }
  }
  const blocker = mode !== 'batch' ? '' : previewing ? '正在本机读取图片' : busy ? '正在处理本批' : pending ? '' : !sourceAvailable ? '模板已不可用，原批次和素材保留' : !loaded ? '正在恢复批次设置' : !Number.isInteger(total) || total < 1 || total > STUDIO_BATCH_LIMITS.images ? '请先选择有效素材，本批最多100张' : '';
  const controls = <div className={styles.controls}>
    <p>{visibleQuote ? imageUiQuotePriceText(visibleQuote) : pricingBySpecification ? '按规格计费，费用待报价' : '费用待估算'}</p>
    <div className={styles.actions}>
      {source === 'folder' && <button type="button" disabled={busy || previewing || Boolean(pending)} onClick={() => void chooseSources()}><FolderOpen size={16} />{canSelectBatchDirectory() ? '选择素材文件夹' : '选择素材'}</button>}
      <label><input type="checkbox" checked={pack} disabled={busy} onChange={event => setPack(event.target.checked)} />完成后打包</label>
      {source === 'folder' && files.length > 0 && <span>{folderName} · {files.length}张素材{perFile > 1 ? ` · 共${total}张结果` : ''}</span>}
      <button type="button" title="其他批量设置" aria-expanded={advanced} disabled={busy || previewing || Boolean(pending)} onClick={() => setAdvanced(value => !value)}>其他设置</button>
    </div>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void previewFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <input ref={directoryInput} type="file" {...{ webkitdirectory: '', directory: '' }} multiple hidden onChange={event => { const files = Array.from(event.target.files || []); void previewFiles(files, (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath?.split('/')[0] || '所选素材'); event.target.value = ''; }} />
    {advanced && <div className={styles.fields}><label>批量来源<select value={source} disabled={busy || Boolean(pending)} onChange={event => setSource(event.target.value as 'current' | 'folder')}><option value="folder">素材逐图</option><option value="current">当前正文</option></select></label><label>{source === 'current' ? '本批结果数' : '每张素材结果数'}<input type="number" min={1} max={source === 'current' ? 100 : 8} step={1} value={source === 'current' ? quantity : perFile} disabled={busy || Boolean(pending)} onChange={event => source === 'current' ? setQuantity(Number(event.target.value)) : setPerFile(Number(event.target.value))} /></label>{source === 'folder' && <button type="button" disabled={busy || previewing || Boolean(pending)} onClick={() => fileInput.current?.click()}>选择多张图片</button>}<button type="button" title="重置本批设置" aria-label="重置本批设置" disabled={busy || Boolean(pending)} onClick={() => { setSource('folder'); setQuantity(8); setPerFile(1); setPack(false); fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); fileRef.current = []; setFiles([]); setSkipped([]); setFolderName(''); }}><RotateCcw size={16} /></button></div>}
    {!!skipped.length && <details><summary>跳过{skipped.length}项</summary>{skipped.map((reason, index) => <p key={index}>{reason}</p>)}</details>}
    {progress && <p role="status">{progress}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    {pending && <p>原提交待核对，不会重新生成。<button type="button" disabled={busy} onClick={() => void query()}><RefreshCw size={16} />查询原批次</button></p>}
    {productDialog}
  </div>;
  return { mode, setMode, source, busy, previewing, pending, recoveryKnown: recoveryKnownScope === scopedKey, blocker, submit, query, controls, id, pack, localPreviews: files.slice(0, 24).map(file => file.preview) };
}
