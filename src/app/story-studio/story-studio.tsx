'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowDown, ArrowUp, Clapperboard, ImagePlus, Plus, RefreshCw, Save, Trash2, WandSparkles } from 'lucide-react';
import { buildStoryPrompt, parseStoryShots, validateStoryDraft, type StoryDraft, type StoryShot } from '@/lib/story-workflow';
import { useProductDialog } from '@/components/useProductDialog';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { GeneratedImageResults, type GeneratedImageResult } from '@/components/GeneratedImageResults';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { RelativeTime } from '@/components/RelativeTime';
import type { PickerItem } from '@/lib/assets/picker-types';
import type { ContentKey } from '@/lib/content-reactions/types';
import styles from './story-studio.module.css';
import { timingFromStory, validateStoryTiming } from './story-duration';
import { attachStoryVideo, type StoryCanvas as Snapshot } from './story-handoff';

type Document = { id: string; owner_user_id: string; project_id: string; title: string; revision: number;
  status: string; updated_at: string; document_json: string };
type TextRequest = { id: string; stage: 'script' | 'storyboard'; state: 'not_sent' | 'pending' | 'unconfirmed' | 'review'; raw?: string; message?: string };
type ImageHandoff = { moduleId: string; prompt: string; state: 'not_sent' | 'pending' | 'ready' | 'unconfirmed' };
type Work = { draft: StoryDraft; request?: TextRequest; images: Record<string, ImageHandoff>;
  references: Record<string, PickerItem>; mediaNodes: Record<string, string>;
  lineage: { scriptStory?: string; shotsScript?: string }; versions: StoryVersion[] };
type StoryVersion = Omit<Work, 'request' | 'versions'> & { id: string; createdAt: string };
type SaveRequest = Record<string, unknown> & { mutation_id: string; document_json: string; base_revision: number };
const DOC_API = '/api/tools/ultimate-canvas/document';
const blank = (): StoryDraft => ({ version: 1, story: '', script: '', shots: [], sourceRevision: 0 });
async function request<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(url, { method: body ? method : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回未能确认，请保留当前草稿'); }
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || '操作未完成'), { status: response.status });
  return data as T;
}
const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成';

export default function StoryStudio({ userId, documentId, nodeId, imageAllowed }: { userId: string; documentId: string; nodeId: string; imageAllowed: boolean }) {
  const [document, setDocument] = useState<Document | null>(null);
  const [work, setWork] = useState<Work>({ draft: blank(), images: {}, references: {}, mediaNodes: {}, lineage: {}, versions: [] });
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [autosavePaused, setAutosavePaused] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedImageResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [resultShot, setResultShot] = useState<string | null>(null);
  const [resultAssets, setResultAssets] = useState<Record<string, PickerItem>>({});
  const current = useRef(work); current.current = work;
  const documentRef = useRef(document); documentRef.current = document;
  const snapshot = useRef<Snapshot | null>(null);
  const lock = useRef(false);
  const sequence = useRef(0);
  const failedSave = useRef<SaveRequest | null>(null);
  const alive = useRef(true);
  const { confirm, productDialog } = useProductDialog();
  const key = `sd2:story:v1:${userId}:${documentId}:${nodeId}`;
  usePageExitRisk({ unsaved: dirty ? ['故事与分镜草稿'] : [], busy: busy ? [busy] : [] });
  const cache = useCallback((value: Work, pending: SaveRequest | null = failedSave.current) => {
    try { localStorage.setItem(key, JSON.stringify({ userId, documentId, nodeId, revision: documentRef.current?.revision,
      work: value, pending })); } catch { setError('本地草稿无法保存，请保持页面打开并保存到画布'); }
  }, [key, userId, documentId, nodeId]);
  function change(value: Work) {
    current.current = value; setWork(value); sequence.current += 1; setDirty(true); cache(value);
    if (!lock.current && !conflict && !failedSave.current) setAutosavePaused(false);
  }
  const updateDraft = (patch: Partial<StoryDraft>) => change({ ...current.current, draft: { ...current.current.draft, ...patch } });

  useEffect(() => {
    alive.current = true;
    async function load() {
      try {
        if (!documentId || !nodeId) return;
        const data = await request<{ document: Document }>(`${DOC_API}?document_id=${encodeURIComponent(documentId)}`);
        if (!alive.current) return;
        const doc = data.document;
        if (!doc || doc.owner_user_id !== userId || doc.status !== 'active') throw Error('画布不可编辑，请回到画布查看');
        const graph = JSON.parse(doc.document_json) as Snapshot;
        const node = graph.canvas.nodes.find(item => item.id === nodeId && ['script', 'text'].includes(item.type));
        if (!node) throw Error('故事源节点已不存在，请回到画布重新选择');
        const draft = node.data.storyWorkflow ? validateStoryDraft(node.data.storyWorkflow) : {
          ...blank(), story: String(node.data.prompt || node.data.generatedText || ''),
          script: String(node.data.generatedText || ''), sourceRevision: doc.revision,
        };
        const value: Work = { draft, request: node.data.storyRequest as TextRequest | undefined,
          images: (node.data.storyImages || {}) as Work['images'], references: (node.data.storyReferences || {}) as Work['references'],
          mediaNodes: (node.data.storyMediaNodes || {}) as Work['mediaNodes'],
          lineage: (node.data.storyLineage || {}) as Work['lineage'], versions: (node.data.storyVersions || []) as StoryVersion[] };
        if (value.request?.state === 'pending') value.request = { ...value.request, state: 'unconfirmed', message: '上次文字请求的结果未确认，不会自动重发' };
        documentRef.current = doc; setDocument(doc); snapshot.current = graph;
        let restored = value;
        try {
          const local = JSON.parse(localStorage.getItem(key) || 'null');
          if (local?.userId === userId && local.documentId === documentId && local.nodeId === nodeId && local.work) {
            validateStoryDraft(local.work.draft);
            if (local.revision === doc.revision || await confirm('本地故事草稿基于较早画布。保留该草稿继续核对？不会自动覆盖服务器。', { title: '恢复草稿', confirmLabel: '保留草稿' })) {
              restored = { ...value, ...local.work, lineage: local.work.lineage || {}, versions: local.work.versions || [] };
              if (restored.request?.state === 'pending') restored.request = { ...restored.request, state: 'unconfirmed' };
              failedSave.current = local.pending || null;
              sequence.current = 1; setDirty(true);
              if (local.revision !== doc.revision) {
                setConflict(true);
                setError('画布已有新版本，草稿尚未覆盖服务器；请核对后合并故事草稿');
              }
            }
          }
        } catch { /* Invalid local data never replaces the authorized document. */ }
        if (!alive.current) return;
        current.current = restored; setWork(restored);
      } catch (cause) { if (alive.current) setError(message(cause)); }
      finally { if (alive.current) setLoading(false); }
    }
    void load();
    return () => { alive.current = false; };
  }, [documentId, nodeId, userId, key, confirm]);

  async function save(value = current.current, transform?: (graph: Snapshot) => void) {
    const doc = documentRef.current;
    if (!doc || !snapshot.current) throw Error('画布尚未就绪');
    if (conflict) throw Error('请先读取最新画布并核对故事草稿');
    validateStoryDraft(value.draft);
    const captured = sequence.current;
    async function persist(body: SaveRequest) {
      failedSave.current = body; cache(value, body);
      let result;
      try { result = await request<{ document: Omit<Document, 'document_json'> }>(DOC_API, body); }
      catch (cause) {
        const status = Number((cause as { status?: number })?.status);
        if (status === 409) setConflict(true);
        if (status && status < 500 && ![408, 429].includes(status)) {
          failedSave.current = null; cache(current.current, null);
        }
        throw cause;
      }
      const next = { ...doc, ...result.document, document_json: body.document_json };
      documentRef.current = next; setDocument(next); snapshot.current = JSON.parse(body.document_json);
      failedSave.current = null;
    }
    if (failedSave.current) await persist(failedSave.current);
    const graph: Snapshot = JSON.parse(JSON.stringify(snapshot.current));
    const node = graph.canvas.nodes.find(item => item.id === nodeId);
    if (!node) throw Error('故事节点不存在，未保存');
    Object.assign(node.data, { storyWorkflow: value.draft, storyRequest: value.request || null, storyImages: value.images,
      storyReferences: value.references, storyMediaNodes: value.mediaNodes,
      storyLineage: value.lineage, storyVersions: value.versions });
    transform?.(graph);
    const body: SaveRequest = { document_id: doc.id, protocol_version: 2, mutation_id: crypto.randomUUID(),
      base_revision: documentRef.current!.revision, project_id: doc.project_id, title: doc.title,
      document_json: JSON.stringify(graph) };
    await persist(body);
    setAutosavePaused(false);
    setDirty(sequence.current !== captured);
    if (sequence.current === captured) { try { localStorage.removeItem(key); } catch {} }
    else cache(current.current, null);
    return documentRef.current!;
  }
  async function operate(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError('');
    try {
      if (failedSave.current && label !== '保存草稿' && label !== '读取最新画布') throw Error('上次保存结果未确认，请先点击保存草稿重试原保存；未继续生成或准备媒体');
      await action();
    }
    catch (cause) { setAutosavePaused(true); setError(message(cause)); cache(current.current); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  useEffect(() => {
    if (!dirty || loading || busy || failedSave.current || conflict || autosavePaused || !document) return;
    const timer = setTimeout(() => { void operate('保存草稿', async () => { await save(); }); }, 1000);
    return () => clearTimeout(timer);
    // Save the latest ref, including edits made while a previous save was in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, dirty, busy, loading, document, conflict, autosavePaused]);

  async function reconcile() {
    const data = await request<{ document: Document }>(`${DOC_API}?document_id=${encodeURIComponent(documentId)}`);
    const doc = data.document;
    if (!doc || doc.owner_user_id !== userId || doc.status !== 'active') throw Error('画布不可编辑，当前草稿保留');
    const graph = JSON.parse(doc.document_json) as Snapshot;
    const node = graph.canvas.nodes.find(item => item.id === nodeId && ['script', 'text'].includes(item.type));
    if (!node) throw Error('故事节点已被删除，当前草稿保留，不能覆盖画布');
    if (!await confirm('保留最新画布的其他节点，并使用本页故事草稿替换此故事节点？原服务器故事会保留在历史版本中；不会重发文字或媒体生成。', { title: '核对草稿', confirmLabel: '保留并合并' })) return;
    if (node.data.storyWorkflow) {
      const serverWork: Work = { draft: validateStoryDraft(node.data.storyWorkflow),
        images: (node.data.storyImages || {}) as Work['images'], references: (node.data.storyReferences || {}) as Work['references'],
        mediaNodes: (node.data.storyMediaNodes || {}) as Work['mediaNodes'], lineage: (node.data.storyLineage || {}) as Work['lineage'], versions: [] };
      change({ ...current.current, versions: [...current.current.versions, archived(serverWork)].slice(-10) });
    }
    // A definitive conflict needs an explicit fresh baseline, never a silent CAS retry.
    documentRef.current = doc; setDocument(doc); snapshot.current = graph;
    failedSave.current = null; setConflict(false); setAutosavePaused(true);
    setNotice('已读取最新画布，请核对本页草稿后点击保存');
    cache(current.current, null);
  }

  function archived(value: Work): StoryVersion {
    return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), draft: value.draft, images: value.images,
      references: value.references, mediaNodes: value.mediaNodes, lineage: value.lineage };
  }

  async function generate(stage: 'script' | 'storyboard') {
    if (current.current.request && ['pending', 'unconfirmed'].includes(current.current.request.state)) throw Error('请先处理结果未确认的文字请求');
    const timing = timingFromStory(current.current.draft.story);
    validateStoryTiming(timing);
    const prompt = buildStoryPrompt(stage, current.current.draft)
      + '\n遵守接口外层 JSON 响应协议，将完整剧本文本或完整分镜 JSON 文字放入 content 字符串，不改变外层字段。'
      + (Object.keys(timing).length ? `\n必须满足原故事已明确的时长约束：${JSON.stringify(timing)}（total 总秒数，count 镜头数，each 每镜秒数）。` : '');
    if (prompt.length > 12000) throw Error('完整内容超过文字接口上限，请先拆分故事；不会截断剧本');
    if ((stage === 'script' ? current.current.draft.script.trim() : current.current.draft.shots.length)
      && !await confirm('生成的新稿会成为当前版本；原剧本、分镜和已准备的媒体仍保留。是否继续？', { title: '生成新稿', confirmLabel: '生成新稿' })) return;
    const previous = current.current;
    const pending: Work = { ...previous, request: { id: crypto.randomUUID(), stage, state: 'pending' },
      draft: { ...previous.draft, sourceRevision: documentRef.current!.revision } };
    change(pending);
    try { await save(pending); }
    catch (cause) {
      change({ ...pending, request: { ...pending.request!, state: 'not_sent', message: '草稿未保存，文字请求尚未发出' } });
      throw cause;
    }
    let content = '';
    try {
      const graph = snapshot.current!;
      const data = await request<{ content?: string; text?: string }>('/api/tools/ultimate-canvas/generate', {
        kind: 'script', prompt, nodeId, canvas_document_id: documentId, project_id: documentRef.current!.project_id,
        video_card_id: graph.context?.video_card_id || null, textPurpose: stage === 'storyboard' ? 'storyboard' : 'text',
        source_request_id: pending.request!.id,
        contextRules: graph.canvas.nodes.find(node => node.id === nodeId)?.data.contextRules || '',
      });
      content = data.content || data.text || '';
      if (!content.trim()) throw Error('文字接口没有返回完整内容');
      const shots = stage === 'storyboard' ? parseStoryShots(content) : null;
      if (shots) validateStoryTiming(timing, shots);
      const next: Work = { ...current.current, request: undefined,
        versions: [...previous.versions, archived(previous)].slice(-10),
        lineage: { ...previous.lineage, ...(stage === 'script' ? { scriptStory: previous.draft.story } : { shotsScript: previous.draft.script }) },
        ...(stage === 'storyboard' ? { images: {}, references: {}, mediaNodes: {} } : {}),
        draft: { ...current.current.draft, ...(stage === 'script' ? { script: content } : { shots: shots! }) } };
      validateStoryDraft(next.draft);
      change(next); await save(next); setNotice(stage === 'script' ? '完整剧本已保存' : '分镜已保存，请核对各镜头');
    } catch (cause) {
      const next = { ...current.current, request: { ...pending.request!, state: content ? 'review' as const : 'unconfirmed' as const,
        raw: content || undefined, message: message(cause) } };
      change(next);
      try { await save(next); } catch { /* Local pending marker remains, without an automatic generation retry. */ }
      throw cause;
    }
  }
  async function dismissRequest() {
    if (!await confirm('本次文字请求无法后台查询。保留已有剧本和分镜，结束等待？以后重新生成是新的文字请求。', { title: '保留原稿', confirmLabel: '结束等待' })) return;
    change({ ...current.current, request: undefined }); await save();
  }
  function editShot(id: string, patch: Partial<StoryShot>) {
    updateDraft({ shots: current.current.draft.shots.map(shot => shot.id === id ? { ...shot, ...patch } : shot) });
  }
  function moveShot(index: number, offset: number) {
    const shots = [...current.current.draft.shots];
    if (index + offset < 0 || index + offset >= shots.length) return;
    [shots[index], shots[index + offset]] = [shots[index + offset], shots[index]]; updateDraft({ shots });
  }
  async function imageDraft(shot: StoryShot) {
    if (!imageAllowed) throw Error('当前账号无权使用生图工作区');
    if (!shot.imagePrompt.trim()) throw Error('请先填写此镜头的画面要求');
    let handoff = current.current.images[shot.id];
    if (handoff) {
      const existing = await request<{ modules: Array<{ id: string; prompt: string }> }>(`/api/image-studio/modules?ids=${encodeURIComponent(handoff.moduleId)}`);
      if (existing.modules.some(item => item.id === handoff.moduleId)) {
        change({ ...current.current, images: { ...current.current.images, [shot.id]: { ...handoff, state: 'ready' } } });
        await save(); return;
      }
      if (handoff.state === 'unconfirmed' || handoff.state === 'pending') throw Error('未查询到生图草稿；请稍后重新查询，不会自动重复创建');
    } else {
      handoff = { moduleId: crypto.randomUUID(), prompt: shot.imagePrompt, state: 'not_sent' };
      change({ ...current.current, images: { ...current.current.images, [shot.id]: handoff } }); await save();
    }
    try {
      handoff = { ...handoff, state: 'pending' };
      change({ ...current.current, images: { ...current.current.images, [shot.id]: handoff } });
      await request('/api/image-studio/modules', { id: handoff.moduleId, revision: 0,
        name: shot.title.slice(0, 80) || '分镜画面', prompt: handoff.prompt, count: 1, referenceIds: [], groupName: '故事分镜' }, 'PUT');
      change({ ...current.current, images: { ...current.current.images, [shot.id]: { ...handoff, state: 'ready' } } }); await save();
    } catch (cause) {
      change({ ...current.current, images: { ...current.current.images, [shot.id]: { ...handoff, state: 'unconfirmed' } } });
      try { await save(); } catch {} throw cause;
    }
  }
  async function mediaNode(shot: StoryShot) {
    if (!shot.videoPrompt.trim()) throw Error('请填写此镜头的视频要求');
    const draft = validateStoryDraft(current.current.draft);
    validateStoryTiming(timingFromStory(draft.story), draft.shots);
    const reference = current.current.references[shot.id];
    const oldId = current.current.mediaNodes[shot.id];
    if (oldId) {
      if (snapshot.current!.canvas.nodes.some(node => node.id === oldId)) { setNotice('此镜头已有视频节点，打开画布继续编辑'); return; }
      if (!await confirm('原视频节点已不存在。原任务和结果不会删除，明确为此镜头准备一个新节点？不会提交生成。', { title: '准备新节点', confirmLabel: '准备新节点' })) return;
    }
    const videoId = `node-story-${crypto.randomUUID()}`;
    const next = { ...current.current, draft, mediaNodes: { ...current.current.mediaNodes, [shot.id]: videoId } };
    change(next);
    await save(next, graph => {
      const ordinal = draft.shots.findIndex(item => item.id === shot.id);
      attachStoryVideo(graph, nodeId, shot, ordinal, reference, videoId,
        `node-story-reference-${crypto.randomUUID()}`, draft.sourceRevision);
    });
    setNotice('视频节点已保存，尚未提交生成；在画布核对模型与点数后手动生成');
  }
  async function selectReference(shotId: string, item: PickerItem) {
    if (!current.current.draft.shots.some(shot => shot.id === shotId) || item.unavailableReason || item.type !== 'image') throw Error('所选镜头或原图不可用');
    let referenceImageId = item.referenceImageId;
    if (!referenceImageId) {
      if (!item.assetId) throw Error('图片没有可用的原件编号');
      const response = await fetch('/api/workspace/assets', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-tab-id': `ultimate-canvas:${documentRef.current!.project_id}:${snapshot.current?.context?.video_card_id || nodeId}` },
        body: JSON.stringify({ assetId: item.assetId, role: 'reference_image' }) });
      const data = await response.json();
      if (!response.ok || !data.success || typeof data.referenceImageId !== 'string') throw Error(data.error || data.message || '原图未能关联为参考图，请重新选择');
      referenceImageId = data.referenceImageId;
    }
    change({ ...current.current, references: { ...current.current.references, [shotId]: { ...item, referenceImageId } } });
    await save(); setNotice('已选用原图，未提交视频生成');
  }
  async function readResults(shotId: string, more = false) {
    const handoff = current.current.images[shotId];
    if (!handoff || !imageAllowed) throw Error('此镜头还没有可用的生图工作区');
    const query = new URLSearchParams({ moduleId: handoff.moduleId });
    if (more && cursor) query.set('cursor', cursor);
    const data = await request<{ tasks: Array<{ id: string; status: string; error?: string; asset?: {
      id?: string; original_url: string; thumbnail_url?: string; width?: number; height?: number; file_size?: number;
    } | null }>; nextCursor?: string | null }>(`/api/image-studio/tasks?${query}`);
    const assets: Record<string, PickerItem> = {};
    const items: GeneratedImageResult[] = data.tasks.map(task => {
      const asset = task.status === 'succeeded' ? task.asset : null;
      if (asset?.id) assets[task.id] = { key: `asset:${asset.id}`, identity: `asset:${asset.id}`, id: asset.id,
        assetId: asset.id, type: 'image', fileName: '分镜生成原图',
        originalUrl: `/api/image-studio/assets/${asset.id}`, previewUrl: `/api/image-studio/assets/${asset.id}`, thumbnailUrl: asset.thumbnail_url || null,
        width: asset.width || null, height: asset.height || null, fileSize: asset.file_size || null,
        duration: null, createdAt: '', source: 'generated' };
      return { id: task.id, label: '分镜画面', status: task.status, pending: ['queued', 'running'].includes(task.status), error: task.error,
        ...(asset?.id ? { media: { src: `/api/image-studio/assets/${asset.id}`, thumbnailSrc: asset.thumbnail_url,
          alt: '分镜画面', contentKey: `asset:${asset.id}` as ContentKey } } : {}) };
    });
    setResultShot(shotId); setResults(old => more ? [...old, ...items.filter(item => !old.some(existing => existing.id === item.id))] : items);
    setResultAssets(old => more ? { ...old, ...assets } : assets); setCursor(data.nextCursor || null);
  }
  const ready = Boolean(document && !loading);
  const blocked = busy !== '' || !ready || conflict;
  const awaiting = work.request && ['pending', 'unconfirmed'].includes(work.request.state);
  return <main className={styles.studio}>
    <header className={styles.header}><div><h1>故事与分镜</h1>{document && <small>{document.title} · <RelativeTime value={document.updated_at} /></small>}</div>
      <div className={styles.actions}><Link className={styles.link} href={`/tools/ultimate-canvas${documentId ? `?document_id=${encodeURIComponent(documentId)}` : ''}`}><ArrowLeft size={16} />画布</Link>
        <button disabled={blocked} onClick={() => void operate('保存草稿', async () => { await save(); setNotice('故事与分镜已保存'); })}><Save size={16} />{dirty || failedSave.current ? '保存草稿' : '已保存'}</button></div></header>
    <p role={error ? 'alert' : 'status'} className={`${styles.status} ${error ? styles.error : ''}`}>{error || busy || notice || (loading ? '正在读取故事' : !ready ? '请从画布选择故事节点打开' : '文字生成不扣本站点数；图视频生成在原工作区另行确认点数。')}</p>
    {conflict && <button disabled={Boolean(busy)} onClick={() => void operate('读取最新画布', reconcile)}><RefreshCw size={16} />读取最新画布并保留故事草稿</button>}
    {work.request && <section className={styles.status}><strong>{work.request.state === 'review' ? '返回内容待核对' : work.request.state === 'not_sent' ? '文字请求未发出' : '文字结果未确认'}</strong><p>{work.request.message || '不会自动重发文字请求'}</p>
      {work.request.raw && <pre className={styles.raw}>{work.request.raw}</pre>}<button disabled={blocked} onClick={() => void operate('处理文字请求', dismissRequest)}>保留原稿并结束等待</button></section>}
    {ready && <><div className={styles.grid}><section className={styles.section}><h2>故事</h2>
      <label>故事内容<textarea className={styles.storyText} disabled={Boolean(busy)} value={work.draft.story} onChange={event => updateDraft({ story: event.target.value })} /></label>
      <button className={styles.primary} disabled={blocked || Boolean(awaiting) || !work.draft.story.trim()} onClick={() => void operate('生成完整剧本', () => generate('script'))}><WandSparkles size={16} />生成完整剧本</button>
    </section><section className={styles.section}><h2>完整剧本</h2>
      {work.lineage.scriptStory !== undefined && work.lineage.scriptStory !== work.draft.story && <p className={styles.status}>故事已修改，当前剧本仍是原故事版本，请核对。</p>}
      <label>剧本内容<textarea className={styles.scriptText} disabled={Boolean(busy)} value={work.draft.script} onChange={event => updateDraft({ script: event.target.value })} /></label>
      <button className={styles.primary} disabled={blocked || Boolean(awaiting) || !work.draft.script.trim()} onClick={() => void operate('生成分镜', () => generate('storyboard'))}><Clapperboard size={16} />生成分镜</button>
    </section></div><section className={styles.shots}><div className={styles.toolbar}><h2>分镜 · {work.draft.shots.length}</h2>
      <button disabled={blocked || work.draft.shots.length >= 30} onClick={() => updateDraft({ shots: [...work.draft.shots, { id: `shot-${crypto.randomUUID()}`, title: `镜头 ${work.draft.shots.length + 1}`, description: '', dialogue: '', imagePrompt: '', videoPrompt: '', durationSeconds: 5 }] })}><Plus size={16} />添加镜头</button></div>
      {work.lineage.shotsScript !== undefined && work.lineage.shotsScript !== work.draft.script && <p className={styles.status}>剧本已修改，当前分镜仍属于原剧本版本，请核对。</p>}
      <p className={styles.status}>当前总时长：{work.draft.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)} 秒{Object.keys(timingFromStory(work.draft.story)).length ? ` · 原故事明确要求：${Object.entries(timingFromStory(work.draft.story)).map(([field, value]) => `${({ total: '总时长', count: '镜头数', each: '每镜秒数' })[field as 'total' | 'count' | 'each']} ${value}`).join('，')}` : ''}</p>
      {work.versions.length > 0 && <details><summary>保留的旧稿 · {work.versions.length}</summary>{work.versions.map(version => <section key={version.id} className={styles.shot}>
        <p><RelativeTime value={version.createdAt} /> · {version.draft.shots.length} 个镜头</p><pre className={styles.raw}>{version.draft.script || version.draft.story}</pre>
        <button disabled={blocked} onClick={() => void operate('恢复旧稿', async () => {
          if (!await confirm('当前故事稿将保留。恢复旧稿不会重发生成；已有图视频任务仍保留。', { title: '恢复旧稿', confirmLabel: '恢复' })) return;
          const previous = current.current;
          change({ ...version, versions: [...previous.versions.filter(item => item.id !== version.id), archived(previous)].slice(-10), request: previous.request });
          await save();
        })}>恢复此稿</button></section>)}</details>}
      {work.draft.shots.map((shot, index) => <section className={styles.shot} key={shot.id}><header className={styles.shotHeader}><h3>{index + 1}. {shot.title || '未命名镜头'}</h3><div className={styles.actions}>
        <button title="上移镜头" aria-label="上移镜头" disabled={blocked || index === 0} onClick={() => moveShot(index, -1)}><ArrowUp size={16} /></button>
        <button title="下移镜头" aria-label="下移镜头" disabled={blocked || index === work.draft.shots.length - 1} onClick={() => moveShot(index, 1)}><ArrowDown size={16} /></button>
        <button title="删除镜头" aria-label="删除镜头" disabled={blocked} onClick={() => void operate('删除镜头', async () => {
          if (await confirm('只删除此分镜草稿，已创建的图视频工作区和结果保留。', { title: '删除镜头', confirmLabel: '删除', danger: true })) { updateDraft({ shots: current.current.draft.shots.filter(item => item.id !== shot.id) }); await save(); }
        })}><Trash2 size={16} /></button></div></header>
        <div className={styles.shotFields}><label>镜头名称<input disabled={Boolean(busy)} value={shot.title} onChange={event => editShot(shot.id, { title: event.target.value })} /></label>
          <label className={styles.duration}>时长（秒）<input type="number" min={1} max={15} disabled={Boolean(busy)} value={shot.durationSeconds} onChange={event => {
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 15) editShot(shot.id, { durationSeconds: value });
          }} /></label>
          {(['description', 'dialogue', 'imagePrompt', 'videoPrompt'] as const).map(field => <label key={field}>{({ description: '画面与动作', dialogue: '台词', imagePrompt: '生图要求', videoPrompt: '视频要求' })[field]}<textarea disabled={Boolean(busy)} value={shot[field]} onChange={event => editShot(shot.id, { [field]: event.target.value })} /></label>)}</div>
        <div className={styles.actions}><button disabled={blocked || !imageAllowed || !shot.imagePrompt.trim()} title={!imageAllowed ? '当前账号无权使用生图工作区' : undefined} onClick={() => void operate('准备生图草稿', () => imageDraft(shot))}><ImagePlus size={16} />{work.images[shot.id]?.state === 'unconfirmed' ? '查询生图草稿' : work.images[shot.id] ? '核对生图草稿' : '准备生图草稿'}</button>
          {work.images[shot.id]?.state === 'ready' && <><Link className={styles.link} href={`/template-studio?type=image&moduleId=${encodeURIComponent(work.images[shot.id].moduleId)}`}>打开生图工作区</Link>
            <button disabled={blocked} onClick={() => void operate('读取生成结果', () => readResults(shot.id))}><RefreshCw size={16} />读取生图结果</button></>}
          <button disabled={blocked} onClick={() => setPicker(shot.id)}><ImagePlus size={16} />{work.references[shot.id] ? '更换镜头图片' : '选择镜头图片'}</button>
          <button className={styles.primary} disabled={blocked || !shot.videoPrompt.trim()} onClick={() => void operate('送回画布', () => mediaNode(shot))}><Clapperboard size={16} />{work.mediaNodes[shot.id] ? '核对画布节点' : '送回画布'}</button></div>
        {work.references[shot.id] && <p className={styles.status}>已选原图：{work.references[shot.id].fileName}</p>}
        {work.images[shot.id] && work.images[shot.id].prompt !== shot.imagePrompt && <p className={styles.status}>生图草稿仍保留创建时的要求；后续改动请在该工作区核对，不会自动覆盖。</p>}
        {work.mediaNodes[shot.id] && <p className={styles.status}>已创建的视频节点保留当时的要求；请在画布核对后手动生成。</p>}
      </section>)}
      {resultShot && <GeneratedImageResults items={results} scope={`story:${userId}:${documentId}:${nodeId}:${resultShot}`} hasMore={Boolean(cursor)} loadMore={() => readResults(resultShot, true)} emptyLabel="此镜头暂无生成结果"
        renderActions={item => resultAssets[item.id] ? <button disabled={blocked} onClick={() => void operate('选用原图', async () => {
          await selectReference(resultShot, resultAssets[item.id]);
        })}>选用此原图</button> : null} />}
    </section></>}
    <ResourceLibraryPicker open={Boolean(picker)} imageOnly target="workspace" title="选择镜头原图" maxSelection={1} currentCount={0} currentAssetIds={[]} onClose={() => setPicker(null)}
      onUploadFile={(file, onProgress) => uploadFileAsAsset(file, { onProgress })} onConfirm={async () => false} onConfirmSelection={async items => {
        if (!picker || items.length !== 1 || busy || lock.current) return false;
        const item = items[0]; if (!item.assetId && !item.referenceImageId) return false;
        let success = false;
        await operate('保存镜头图片', async () => { await selectReference(picker, item); success = true; });
        if (success) setPicker(null); return success;
      }} />
    {productDialog}
  </main>;
}
