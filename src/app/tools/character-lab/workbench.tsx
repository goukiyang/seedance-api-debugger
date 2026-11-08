'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Download, ImagePlus, Maximize2, RefreshCw, Undo2 } from 'lucide-react';
import { ImageResultStatusDetails } from '@/components/ImageResultStatusDetails';
import { RelativeTime } from '@/components/RelativeTime';
import { ImageFeishuStatus } from '@/components/image-studio/ImageFeishuStatus';
import { characterLabIsGrid, characterLabMediaUrl, characterLabStrength, sameLabReference, type CharacterLabDraft, type CharacterLabOperation, type CharacterLabPlan, type CharacterLabReference, type CharacterLabTask, type CharacterLabWorkspace } from '@/lib/character-lab/types';
import { labPersonalFields } from '@/lib/character-lab/contexts';
import { CharacterLabImage } from './images';
import { CharacterLabPromptPanel } from './prompt-panel';
import { CharacterLabLayout } from './workbench-layout';
import styles from './studio.module.css';

type Part = 'faces' | 'side' | 'body';
type Position = { part: Part | 'overview'; batches: Partial<Record<Part, string>>; bases: Partial<Record<Part, CharacterLabReference>>; texts: Record<string, string> };
export type LabEditorIntent = { operation?: CharacterLabOperation; input?: CharacterLabReference; description: string };
type Props = {
  ownerId: string; workspace: CharacterLabWorkspace; draft: CharacterLabDraft; plans: CharacterLabPlan[]; tasks: Record<string, CharacterLabTask | null>; configRevision: number;
  initialPart: Part | 'overview'; isAdmin: boolean; locked: boolean; pending: string[]; settings: ReactNode; versions: (inspect: (reference: CharacterLabReference) => void) => ReactNode; allHistory: boolean;
  onUpdate: (patch: Partial<CharacterLabDraft>) => void; onSource: () => void; onPreview: (src: string, alt: string) => void;
  onGenerate: (intent: LabEditorIntent) => Promise<string | undefined>; onQuery: () => void; onLegacy: (plan: CharacterLabPlan) => void;
  onManage: (target: 'faces' | CharacterLabOperation) => void;
  onRestore: (id: string) => Promise<boolean>; onReproduce: (id: string) => Promise<string | undefined>;
};
const titles = { faces: '正脸', side: '侧脸', body: '正背面' };
const fields = { faces: 'faceDescription', side: 'sideDescription', body: 'bodyDescription' } as const;
const statuses: Record<string, string> = { queued: '排队中', running: '生成中', succeeded: '已生成', failed: '生成失败', canceled: '已取消', uncertain: '结果待核对', billing_pending: '费用待核对' };
function partOf(plan: CharacterLabPlan): Part | 'legacy' {
  return plan.operation === 'body-pair' ? 'body' : plan.operation === 'side' || plan.operation === 'refine-side' ? 'side' : plan.kind === 'faces' ? 'faces' : 'legacy';
}
const referenceKey = (part: Part, base?: CharacterLabReference) => `${part}:${base?.planId || 'source'}:${base?.cell ?? ''}`;

export function CharacterLabWorkbench(p: Props) {
  const positionKey = `sd2:character-lab:editor:v1:${p.ownerId}:${p.workspace.id}:${p.draft.sourceAssetId || ''}`;
  const [position, setPosition] = useState<Position>({ part: p.initialPart, batches: {}, bases: {}, texts: {} });
  const [ready, setReady] = useState(false);
  const [prompt, setPrompt] = useState<'current' | 'next' | null>(null);
  const [promptReference, setPromptReference] = useState<CharacterLabReference | undefined>();
  const [undo, setUndo] = useState<(Pick<CharacterLabDraft, 'mainFace' | 'views'> & { part: Part; reference?: CharacterLabReference }) | null>(null);
  const positionRef = useRef(position), promptTrigger = useRef<HTMLElement | null>(null);
  positionRef.current = position;
  function showPrompt(tab: 'current' | 'next', reference?: CharacterLabReference) {
    promptTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPromptReference(reference); setPrompt(tab);
    requestAnimationFrame(() => document.getElementById('character-recipe-panel')?.scrollIntoView({ block: 'start' }));
  }
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(positionKey) || 'null');
      if (value && ['overview', 'faces', 'side', 'body'].includes(value.part)) {
        const bases: Position['bases'] = {}, batches: Position['batches'] = {};
        for (const part of ['faces', 'side', 'body'] as const) {
          const batch = p.plans.find(plan => plan.id === value.batches?.[part] && partOf(plan) === part);
          if (batch) batches[part] = batch.id;
          const base = value.bases?.[part], plan = p.plans.find(plan => plan.id === base?.planId && partOf(plan) === part);
          if (plan && (part === 'body' ? base.cell === undefined : characterLabIsGrid(plan) ? Number.isInteger(base.cell) && base.cell >= 0 && base.cell < plan.count : base.cell === undefined)) bases[part] = base;
        }
        const texts = Object.fromEntries(Object.entries(value.texts || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length <= 3000));
        setPosition({ part: p.initialPart === 'body' ? 'body' : value.part, bases, batches, texts });
      }
    } catch { /* Optional local viewing preferences never block the server draft. */ }
    setReady(true);
    // The component remounts for account/workspace/source changes, not task polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey]);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Server-owned draft remains authoritative. */ }
  }, [ready, position, positionKey]);
  const part: Part = position.part === 'overview' ? 'faces' : position.part;
  const base = position.bases[part];
  const text = p.draft[fields[part]] || '';
  const basePlan = p.plans.find(plan => plan.id === base?.planId);
  const own = p.plans.filter(plan => plan.sourceAssetId === p.draft.sourceAssetId && partOf(plan) === part);
  const batch = own.find(plan => plan.id === position.batches[part]) || own.find(plan => p.tasks[plan.id]?.asset) || own[0];
  const shown = batch && p.tasks[batch.id]?.asset ? batch : own.find(plan => p.tasks[plan.id]?.asset);
  const numbers = new Map<string, number>();
  const counts = { faces: 0, side: 0, body: 0, legacy: 0 };
  for (const plan of [...p.plans].reverse()) numbers.set(plan.id, ++counts[partOf(plan)]);
  const adopted = (target: Part): CharacterLabReference | undefined => target === 'faces' ? p.draft.mainFace || undefined
    : target === 'side' ? p.draft.views?.side : p.draft.views?.['body-front'] && p.draft.views['body-front'].planId === p.draft.views['body-back']?.planId
      && p.plans.some(plan => plan.id === p.draft.views?.['body-front']?.planId && plan.operation === 'body-pair') ? { planId: p.draft.views['body-front'].planId } : undefined;
  const current = adopted(part), currentPlan = p.plans.find(plan => plan.id === current?.planId);
  const stale = (plan?: CharacterLabPlan) => part === 'side' && Boolean(plan && !sameLabReference(plan.mainFace, p.draft.mainFace));
  const validBase = Boolean(basePlan && p.tasks[basePlan.id]?.asset && !stale(basePlan));
  const selectedIsAdopted = sameLabReference(base, current);
  const operation = part === 'body' ? 'body-pair' : validBase ? part === 'side' ? 'refine-side' : 'refine-face' : part === 'side' ? 'side' : undefined;
  const relatedPending = p.pending.some(id => !p.plans.find(plan => plan.id === id)?.slotScoped || p.plans.some(plan => plan.id === id && partOf(plan) === part));
  const canGenerate = Boolean(p.draft.sourceAssetId && (part !== 'side' || p.draft.mainFace) && !relatedPending && (!base || validBase || part === 'side' && stale(basePlan)) && (!validBase || text.trim()));
  const frozenText = (plan?: CharacterLabPlan) => plan ? plan.operation ? plan.adjustment : plan.context : '';
  const hasNewText = Boolean(text.trim() && text !== frozenText(basePlan || shown));
  function change(target: Part | 'overview', nextBase?: CharacterLabReference, nextBatch?: string, restore = false) {
    if (p.locked) return;
    const old = positionRef.current, oldPart = old.part === 'overview' ? 'faces' : old.part;
    const texts = { ...old.texts, [referenceKey(oldPart, old.bases[oldPart])]: p.draft[fields[oldPart]] || '' };
    const targetPart = target === 'overview' ? 'faces' : target;
    const chosen = restore ? nextBase : old.bases[targetPart];
    const plan = p.plans.find(item => item.id === chosen?.planId);
    const key = referenceKey(targetPart, chosen);
    const nextText = texts[key] ?? (restore ? frozenText(plan) : p.draft[fields[targetPart]] || '');
    texts[key] = nextText;
    setPosition({ part: target, bases: { ...old.bases, [targetPart]: chosen }, batches: { ...old.batches, ...(nextBatch ? { [targetPart]: nextBatch } : {}) }, texts });
    p.onUpdate({ [fields[targetPart]]: nextText }); setPromptReference(undefined); setPrompt(old => old ? 'current' : null);
  }
  function browse(plan: CharacterLabPlan) {
    const target = partOf(plan);
    if (target === 'legacy' || plan.sourceAssetId !== p.draft.sourceAssetId) { p.onLegacy(plan); return; }
    const candidate = { planId: plan.id, ...(characterLabIsGrid(plan) ? { cell: 0 } : {}) };
    change(target, candidate, plan.id, true);
  }
  function adopt(choice = base) {
    const plan = p.plans.find(item => item.id === choice?.planId);
    if (p.locked || !choice || !plan || !p.tasks[plan.id]?.asset || stale(plan) || sameLabReference(choice, current)) return;
    setUndo({ mainFace: p.draft.mainFace, views: p.draft.views, part, reference: current });
    if (part === 'faces' && choice.cell !== undefined) p.onUpdate({ mainFace: { planId: choice.planId, cell: choice.cell } });
    else if (part === 'side') p.onUpdate({ views: { ...p.draft.views, side: choice } });
    else p.onUpdate({ views: { ...p.draft.views, 'body-front': { planId: choice.planId, cell: 0 }, 'body-back': { planId: choice.planId, cell: 1 } } });
  }
  async function generate() {
    const captured = positionRef.current;
    const id = await p.onGenerate({ operation, ...(validBase && base ? { input: base } : {}), description: text });
    if (id && positionRef.current === captured) setPosition(old => ({ ...old, batches: { ...old.batches, [part]: id } }));
  }
  const media = (ref?: CharacterLabReference) => ref ? characterLabMediaUrl(ref.planId, ref.cell) : '';
  function picture(ref: CharacterLabReference | undefined, label: string) {
    return ref && p.tasks[ref.planId]?.asset ? <CharacterLabImage src={media(ref)} alt={label} /> : <span className={styles.emptyPart}>{label}<small>点击制作</small></span>;
  }
  function composition(mini = false) {
    return <div className={mini ? styles.miniComposition : styles.adoptedComposition}>
      {([['faces', p.draft.mainFace, '正脸'], ['side', p.draft.views?.side, '侧脸'], ['body', p.draft.views?.['body-front'], '正面全身'], ['body', p.draft.views?.['body-back'], '背面全身']] as const).map(([target, ref, title], index) => <button type="button" key={title} data-body={index > 1} aria-pressed={position.part === target} disabled={p.locked} onClick={() => change(target)}>{picture(ref || undefined, title)}<span className={styles.partTag}>{title}{target === 'side' && ref && !sameLabReference(p.plans.find(plan => plan.id === ref.planId)?.mainFace, p.draft.mainFace) ? ' · 待同步' : ''}</span></button>)}
    </div>;
  }
  const generationStatus = batch && batch.id !== shown?.id ? `第${numbers.get(batch.id)}组 · ${characterLabIsGrid(batch) ? `${batch.count}宫格` : batch.operation === 'body-pair' ? '正背面' : '单张'}：${statuses[p.tasks[batch.id]?.status || ''] || (p.pending.includes(batch.id) ? '提交待核对' : '未提交')}；保留已有候选` : '';
  const materialsPanel = <aside className={styles.unifiedRail}>
      <section><h2>原始角色</h2><button type="button" className={styles.originalThumb} onClick={() => p.draft.sourceAssetId ? p.onPreview(`/api/image-studio/template-assets/${encodeURIComponent(p.draft.sourceAssetId)}`, '原始角色') : p.onSource()}>{p.draft.sourceAssetId ? <CharacterLabImage src={`/api/image-studio/template-assets/${encodeURIComponent(p.draft.sourceAssetId)}`} alt="原始角色" /> : <ImagePlus size={28} />}</button><button type="button" disabled={p.locked || p.pending.length > 0} onClick={p.onSource}><ImagePlus size={14} />{p.draft.sourceAssetId ? '更换原图' : '添加原图'}</button></section>
      <section><div className={styles.sectionTitle}><h2>当前成品</h2><button type="button" disabled={p.locked} onClick={() => change('overview')}>总览</button></div>{composition(true)}</section>
      <section className={styles.lowerHistory} id="character-lab-history"><h2>{p.allHistory ? '全部历史' : `${titles[part]}历史候选`}</h2>
        <div className={styles.historyTabs}>{(['faces', 'side', 'body'] as const).map(target => <button type="button" key={target} aria-pressed={part === target} disabled={p.locked} onClick={() => change(target)}>{titles[target]}</button>)}</div>
        <div className={styles.unifiedBatches}>{(p.allHistory ? p.plans : own).map(plan => <button type="button" key={plan.id} aria-pressed={batch?.id === plan.id} disabled={p.locked} onClick={() => browse(plan)}>{p.tasks[plan.id]?.asset ? <CharacterLabImage src={characterLabMediaUrl(plan.id)} alt={`第${numbers.get(plan.id)}组候选`} /> : <RefreshCw size={20} />}<span>{partOf(plan) === 'legacy' ? '旧版记录' : titles[partOf(plan) as Part]} · 第{numbers.get(plan.id)}组<small>{characterLabIsGrid(plan) ? `${plan.count}宫格 · ` : ''}<RelativeTime value={plan.createdAt} /></small></span></button>)}</div>
      </section>
    </aside>;
  const previewPanel = <section className={styles.adoptedCanvas}>
        <header><div><h2>{position.part === 'overview' ? '成品预览' : `当前采用 · ${titles[part]}`}</h2>{position.part !== 'overview' && <span>{current ? `第${numbers.get(current.planId)}组${current.cell === undefined ? '' : ` · 候选${current.cell + 1}`}` : '尚未采用'}</span>}</div><div>{position.part !== 'overview' && current && <button type="button" onClick={() => showPrompt('current', current)}>采用图提示词</button>}{undo && <button type="button" disabled={p.locked} onClick={() => { change(undo.part, undo.reference, undo.reference?.planId, true); p.onUpdate({ mainFace: undo.mainFace, views: undo.views }); setUndo(null); }}><Undo2 size={14} />撤销采用</button>}{position.part !== 'overview' && <button type="button" disabled={p.locked} onClick={() => change('overview')}>查看整张</button>}</div></header>
        <div className={styles.adoptedViewport}>{position.part === 'overview' ? composition() : current ? <div className={styles.currentImage} data-body={part === 'body'}>{picture(current, `已采用${titles[part]}`)}<button type="button" className={styles.enlarge} onClick={() => p.onPreview(media(current), `已采用${titles[part]}`)} aria-label="放大当前采用"><Maximize2 size={16} /></button></div> : <button type="button" className={styles.emptyCanvas} onClick={() => document.getElementById('character-supplement')?.focus()}><ImagePlus size={34} /><strong>制作{titles[part]}</strong><span>在制作栏补充要求，生成后挑选采用</span></button>}</div>
        {position.part !== 'overview' && current && <div className={styles.canvasToolbar}><button type="button" disabled={p.locked || stale(currentPlan)} onClick={() => change(part, current, current.planId, true)}>基于当前采用继续微调</button><a href={media(current) + '&download=1'} download={`${titles[part]}.png`}><Download size={15} />下载这张</a>{stale(currentPlan) && <span>正脸已更换，侧脸需同步</span>}</div>}
      </section>;
  const editorPanel = <aside className={styles.candidateEditor}>
        <nav className={styles.generationTabs} aria-label="制作部位">{(['faces', 'side', 'body'] as const).map(target => <button type="button" key={target} aria-pressed={part === target} disabled={p.locked} onClick={() => change(target)}>{titles[target]}</button>)}</nav>
        <section className={styles.candidateSection}><header><h2>{part === 'body' ? '正背面候选' : shown ? `${shown.count === 9 && characterLabIsGrid(shown) ? '九' : characterLabIsGrid(shown) ? '四' : '单张'}选一 · ${titles[part]}` : `${titles[part]}候选`}</h2><button type="button" onClick={p.onQuery} aria-label="查询生成状态"><RefreshCw size={15} /></button></header>
          <div className={styles.batchToolbar}><span>{shown ? `第${numbers.get(shown.id)}组` : '还没有候选'}</span>{shown && <><button type="button" onClick={() => showPrompt('current', shown ? { planId: shown.id } : undefined)}>本批提示词</button><button type="button" aria-label="放大本批候选" onClick={() => p.onPreview(characterLabMediaUrl(shown.id), '本批候选')}><Maximize2 size={14} /></button></>}{shown && p.tasks[shown.id] && <ImageResultStatusDetails active={!p.locked} scopeKey={`${p.ownerId}:${p.workspace.id}:${shown.id}:batch-status`} label="查看本批状态与来源" heading="本批状态与来源"><p>{statuses[p.tasks[shown.id]!.status] || '状态待确认'}{p.tasks[shown.id]!.error && ` · ${p.tasks[shown.id]!.error}`}</p><ImageFeishuStatus owner={p.ownerId} taskId={p.tasks[shown.id]!.id} presentationLabel="本批生成" /></ImageResultStatusDetails>}</div>
          {generationStatus && <p role="status" className={styles.inlineStatus}>{generationStatus}</p>}
          {shown ? <div className={styles.unifiedCandidates} data-columns={part === 'body' || !characterLabIsGrid(shown) ? 1 : shown.count === 9 ? 3 : 2}>{Array.from({ length: part === 'body' || !characterLabIsGrid(shown) ? 1 : shown.count }, (_, index) => {
            const ref = { planId: shown.id, ...(characterLabIsGrid(shown) ? { cell: index } : {}) };
            const adoptedHere = sameLabReference(ref, current);
            const selectedHere = adoptedHere;
            return <div key={index} className={styles.choiceFrame} data-selected={selectedHere}><button type="button" className={styles.choiceImage} aria-label={part === 'body' ? '采用正背面整组到成品' : stale(shown) ? `查看候选${index + 1}，需按新正脸重新生成` : `采用候选${index + 1}到成品`} aria-pressed={selectedHere} disabled={p.locked} onClick={() => { change(part, ref, shown.id, true); adopt(ref); }}><CharacterLabImage src={media(ref)} alt={part === 'body' ? '正背面整组' : `候选${index + 1}`} /><span className={styles.choiceNumber}>{part === 'body' ? '整组' : index + 1}{selectedHere && <><Check size={12} />已选中</>}</span>{adoptedHere && <span className={styles.choiceAdopted}>已采用</span>}</button><button type="button" className={styles.choiceZoom} aria-label={`放大候选${index + 1}`} onClick={() => p.onPreview(media(ref), '候选详情')}><Maximize2 size={13} /></button></div>;
          })}</div> : <div className={styles.noCandidates}><ImagePlus size={28} /><span>生成后在这里挑选</span></div>}
        </section>
        <section className={styles.inlineEditor}>
          <div className={styles.editingBase}><div><strong>{validBase && base ? `基于第${numbers.get(base.planId)}组${base.cell === undefined ? '整组' : ` · 候选${base.cell + 1}`}` : part === 'side' ? '基于当前采用的正脸' : '基于原始角色'}</strong><small>{base && stale(basePlan) ? '属于旧正脸，改用当前正脸重新生成' : selectedIsAdopted ? '已用于当前成品' : validBase ? '选中作为编辑底图，尚未采用' : '生成新的候选'}</small></div>{base && <button type="button" disabled={p.locked} onClick={() => change(part, undefined, undefined, true)}>从参考重新生成</button>}</div>
          {validBase && !selectedIsAdopted && <button type="button" className={!hasNewText ? styles.primary : styles.outline} disabled={p.locked} onClick={() => adopt()}>采用当前编辑底图</button>}
          <div className={styles.nextSettings}>{part !== 'body' ? <fieldset disabled={p.locked}><legend>下次生成</legend>{([4, 9] as const).map(count => <button key={count} type="button" aria-pressed={p.draft.count === count} onClick={() => p.onUpdate({ count })}>{count}宫格</button>)}</fieldset> : <span>下次生成：正背面同组</span>}<button type="button" onClick={() => showPrompt('next')}>提示词设置</button></div>
          {part === 'faces' && !validBase && <label className={styles.sliderLabel}><span>面部变化 <b>{characterLabStrength(p.draft.diversity)}</b></span><input type="range" min={0} max={100} value={p.draft.diversity} disabled={p.locked} onChange={event => p.onUpdate({ diversity: Number(event.target.value) })} /></label>}
          {p.settings}
          <label className={styles.field}><span>{titles[part]}{validBase ? '微调要求' : '补充要求'}</span><textarea id="character-supplement" rows={3} maxLength={3000} disabled={p.locked} value={text} placeholder={part === 'body' ? '例如：保留原图比例，调整肩甲和背部服装细节' : part === 'side' ? '例如：略收下颌，保留正脸的鼻唇轮廓与发型' : '例如：眼距略窄一点，保留骨相和年龄感'} onChange={event => { const value = event.target.value; p.onUpdate({ [fields[part]]: value }); setPosition(old => ({ ...old, texts: { ...old.texts, [referenceKey(part, old.bases[part])]: value } })); }} /></label>
          <button type="button" className={`${hasNewText || !shown ? styles.primary : styles.outline} ${styles.generateAfterInput}`} disabled={p.locked || !canGenerate} onClick={() => void generate()}><RefreshCw size={15} />{part === 'side' && stale(basePlan) ? '按新正脸生成' : validBase ? '微调' : '生成'}{part === 'body' ? '正背面整组' : `${p.draft.count}个${titles[part]}候选`}</button>
          {part === 'side' && !p.draft.mainFace && <p className={styles.inlineStatus}>先在正脸候选中采用一张，便可直接生成侧脸。</p>}
          {part === 'body' && <span className={styles.editHint}>以原图决定身体比例和服装，正背面一起生成、一起采用。</span>}
          {relatedPending && <p role="status" className={styles.inlineStatus}>本部位已有{statuses[p.tasks[p.pending.find(id => p.plans.some(plan => plan.id === id && partOf(plan) === part)) || '']?.status || ''] || '结果待核对'}的请求，可在候选区查询进度。</p>}
        </section>
    {prompt && <CharacterLabPromptPanel ownerId={p.ownerId} workspaceId={p.workspace.id} configRevision={p.configRevision} title={titles[part]} reference={promptReference || base || (shown ? { planId: shown.id } : undefined)} tab={prompt} onTab={setPrompt} onClose={() => { setPrompt(null); requestAnimationFrame(() => (promptTrigger.current?.isConnected ? promptTrigger.current : document.getElementById('character-supplement'))?.focus()); }} isAdmin={p.isAdmin} disabled={p.locked}
      previewPayload={{ action: 'preview-prompt', contextProtocol: 1, layoutProtocol: 1, workspaceId: p.workspace.id, kind: operation === 'refine-face' || operation === 'refine-side' || !operation ? 'faces' : 'result', operation, input: validBase ? base : undefined, draft: p.draft, description: text }}
      escapeEnabled onBrowse={id => { const plan = p.plans.find(item => item.id === id); if (plan) browse(plan); }}
      onRestore={p.onRestore} onReproduce={async id => { const captured = positionRef.current; const generated = await p.onReproduce(id); if (generated && positionRef.current === captured) setPosition(old => ({ ...old, batches: { ...old.batches, [part]: generated } })); }} onRestorePersonal={(plan, value) => { const target = partOf(plan); if (target !== part) return false; p.onUpdate({ ...labPersonalFields(plan), [fields[part]]: value }); setPosition(old => ({ ...old, texts: { ...old.texts, [referenceKey(part, base)]: value } })); return true; }}
      onPreview={ref => p.onPreview(media(ref), '本批生成图')} onPreviewAsset={id => p.onPreview(`/api/image-studio/template-assets/${encodeURIComponent(id)}`, '原参考')}
      onInspectSource={id => { const plan = p.plans.find(item => item.id === id); if (plan) { browse(plan); setPrompt('current'); } }}>
      <p className={styles.hint}>补充要求在上方编辑，历史提示词保持原记录。</p>{p.isAdmin && <button type="button" onClick={() => { p.onManage(operation || 'faces'); setPrompt(null); }}>管理本部位规则</button>}
    </CharacterLabPromptPanel>}
    {p.versions(reference => {
      const plan = p.plans.find(item => item.id === reference.planId);
      if (!plan || p.locked) return;
      const target = partOf(plan);
      if (target === 'legacy' || plan.sourceAssetId !== p.draft.sourceAssetId) { p.onLegacy(plan); return; }
      change(target, target === 'body' ? { planId: reference.planId } : reference, plan.id, true);
      showPrompt('current', reference);
    })}
  </aside>;
  return <CharacterLabLayout ownerId={p.ownerId} panels={{ materials: materialsPanel, preview: previewPanel, editor: editorPanel }} />;
}
