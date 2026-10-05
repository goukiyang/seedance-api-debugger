'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Image as ImageIcon, Redo2, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useProductDialog } from '@/components/useProductDialog';
import type { CharacterBox, PromptOverride } from '@/lib/cutout/types';
import styles from './editors.module.css';

type Props = {
  imageUrl: string;
  width: number;
  height: number;
  boxes: CharacterBox[];
  onBoxesChange: (boxes: CharacterBox[]) => void;
  prompts: PromptOverride[];
  onPromptsChange: (prompts: PromptOverride[]) => void;
  disabled?: boolean;
};

type Snapshot = { boxes: CharacterBox[]; prompts: PromptOverride[] };
type PointMode = 'foreground' | 'background' | null;
const HISTORY_LIMIT = 24;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function copySnapshot(boxes: CharacterBox[], prompts: PromptOverride[]): Snapshot {
  return { boxes: cloneValue(boxes), prompts: cloneValue(prompts) };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizedBox(box: CharacterBox, width: number, height: number): CharacterBox {
  const safeWidth = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const safeHeight = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const w = clamp(Math.round(box.w), 1, safeWidth);
  const h = clamp(Math.round(box.h), 1, safeHeight);
  return {
    ...box,
    x: clamp(Math.round(box.x), 0, safeWidth - w),
    y: clamp(Math.round(box.y), 0, safeHeight - h),
    w,
    h,
  };
}

function getPoint(event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }, width: number, height: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: clamp(Math.round(((event.clientX - rect.left) / rect.width) * width), 0, width),
    y: clamp(Math.round(((event.clientY - rect.top) / rect.height) * height), 0, height),
  };
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `character-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
  onEditEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
  onEditEnd: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onCommit(clamp(Math.round(parsed), min, max));
    else setDraft(String(value));
  };

  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
        onBlur={() => { commit(); onEditEnd(); }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      />
    </label>
  );
}

function NameField({ value, disabled, onCommit, onEditEnd }: { value: string; disabled: boolean; onCommit: (value: string) => void; onEditEnd: () => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className={styles.field}>
      <span>角色名称</span>
      <input
        type="text"
        value={draft}
        maxLength={80}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { onCommit(draft.trim() || value); onEditEnd(); }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      />
    </label>
  );
}

export default function CharacterBoxEditor({
  imageUrl,
  width,
  height,
  boxes,
  onBoxesChange,
  prompts,
  onPromptsChange,
  disabled = false,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const boxesRef = useRef(boxes);
  const promptsRef = useRef(prompts);
  const baselineRef = useRef(copySnapshot(boxes, prompts));
  const baselineKey = useRef(`${imageUrl}:${width}x${height}`);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const drawingStart = useRef<{ x: number; y: number } | null>(null);
  const editGroup = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(boxes[0]?.id ?? null);
  const [pointMode, setPointMode] = useState<PointMode>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const { confirm, productDialog } = useProductDialog();

  boxesRef.current = boxes;
  promptsRef.current = prompts;

  const updateHistoryButtons = useCallback(() => {
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }, []);

  const pushUndo = useCallback((snapshot = copySnapshot(boxesRef.current, promptsRef.current)) => {
    undoRef.current.push(snapshot);
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    editGroup.current = null;
    updateHistoryButtons();
  }, [updateHistoryButtons]);

  const commit = useCallback((nextBoxes: CharacterBox[], nextPrompts: PromptOverride[]) => {
    boxesRef.current = nextBoxes;
    promptsRef.current = nextPrompts;
    onBoxesChange(nextBoxes);
    onPromptsChange(nextPrompts);
  }, [onBoxesChange, onPromptsChange]);

  useEffect(() => {
    const key = `${imageUrl}:${width}x${height}`;
    if (baselineKey.current === key) return;
    baselineKey.current = key;
    baselineRef.current = copySnapshot(boxes, prompts);
    undoRef.current = [];
    redoRef.current = [];
    setSelectedId(boxes[0]?.id ?? null);
    setPointMode(null);
    setDrawing(null);
    updateHistoryButtons();
  }, [boxes, height, imageUrl, prompts, updateHistoryButtons, width]);

  useEffect(() => {
    if (boxes.length && !boxes.some((box) => box.id === selectedId)) setSelectedId(boxes[0].id);
    if (!boxes.length && selectedId) setSelectedId(null);
  }, [boxes, selectedId]);

  const changedFromInitial = useMemo(() => (
    JSON.stringify({ boxes, prompts }) !== JSON.stringify(baselineRef.current)
  ), [boxes, prompts]);

  const undo = () => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(copySnapshot(boxesRef.current, promptsRef.current));
    editGroup.current = null;
    commit(cloneValue(previous.boxes), cloneValue(previous.prompts));
    updateHistoryButtons();
    setAnnouncement('已撤销');
  };

  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(copySnapshot(boxesRef.current, promptsRef.current));
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    editGroup.current = null;
    commit(cloneValue(next.boxes), cloneValue(next.prompts));
    updateHistoryButtons();
    setAnnouncement('已重做');
  };

  const pointRadius = Math.max(4, Math.min(15, Math.min(width, height) * 0.012));
  const labelSize = Math.max(12, Math.min(22, Math.min(width, height) * 0.022));
  const selectedBox = boxes.find((box) => box.id === selectedId) ?? null;

  const beginDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || pointMode) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-box-id]')) {
      const id = target.closest<SVGGElement>('[data-box-id]')?.dataset.boxId;
      if (id) setSelectedId(id);
      return;
    }
    const point = getPoint(event, width, height);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingStart.current = point;
    setDrawing({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const moveDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = drawingStart.current;
    if (!start) return;
    const point = getPoint(event, width, height);
    if (!point) return;
    setDrawing({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    });
  };

  const finishDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = drawingStart.current;
    const end = getPoint(event, width, height);
    drawingStart.current = null;
    setDrawing(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture can be lost before pointerup */ }
    if (!start || !end || disabled) return;
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    if (w < 4 || h < 4) return;
    const next = normalizedBox({
      id: makeId(),
      name: `角色 ${boxesRef.current.length + 1}`,
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w,
      h,
    }, width, height);
    pushUndo();
    commit([...boxesRef.current, next], promptsRef.current);
    setSelectedId(next.id);
    setPointMode(null);
    setAnnouncement(`已添加${next.name}`);
  };

  const cancelDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    drawingStart.current = null;
    setDrawing(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture can be lost before pointercancel */ }
  };

  const addPromptPoint = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (disabled || !pointMode || !selectedId) return;
    const point = getPoint(event, width, height);
    if (!point) return;
    const current = promptsRef.current;
    const existingIndex = current.findIndex((prompt) => prompt.id === selectedId);
    const next = cloneValue(current);
    if (existingIndex < 0) {
      next.push({ id: selectedId, points: [[point.x, point.y]], labels: [pointMode === 'foreground' ? 1 : 0] });
    } else {
      const targetPrompt = next[existingIndex];
      targetPrompt.points.push([point.x, point.y]);
      targetPrompt.labels.push(pointMode === 'foreground' ? 1 : 0);
    }
    pushUndo();
    commit(boxesRef.current, next);
    setAnnouncement(`已添加${pointMode === 'foreground' ? '前景' : '背景'}提示点`);
  };

  const editBox = (id: string, field: keyof CharacterBox, value: number | string) => {
    const current = boxesRef.current.find((box) => box.id === id);
    if (!current || current[field] === value) return;
    const transaction = `${id}:${field}`;
    if (editGroup.current !== transaction) {
      pushUndo();
      editGroup.current = transaction;
    }
    const next = boxesRef.current.map((box) => box.id !== id
      ? box
      : normalizedBox({ ...box, [field]: value } as CharacterBox, width, height));
    commit(next, promptsRef.current);
  };

  const removeBox = (id: string) => {
    pushUndo();
    commit(boxesRef.current.filter((box) => box.id !== id), promptsRef.current.filter((prompt) => prompt.id !== id));
    setPointMode(null);
    setAnnouncement('已移除角色框，可用撤销恢复');
  };

  const removePromptPoint = (promptId: string, pointIndex: number) => {
    const next = cloneValue(promptsRef.current);
    const prompt = next.find((item) => item.id === promptId);
    if (!prompt) return;
    pushUndo();
    prompt.points.splice(pointIndex, 1);
    prompt.labels.splice(pointIndex, 1);
    commit(boxesRef.current, next.filter((item) => item.points.length > 0));
  };

  const restoreInitial = async () => {
    if (!changedFromInitial) return;
    const accepted = await confirm('将当前角色框和提示点恢复到进入编辑器时的内容。此操作不会删除原图或结果文件。', {
      title: '恢复初始框选',
      confirmLabel: '恢复初始内容',
      danger: true,
    });
    if (!accepted) return;
    const baseline = copySnapshot(baselineRef.current.boxes, baselineRef.current.prompts);
    undoRef.current = [];
    redoRef.current = [];
    commit(baseline.boxes, baseline.prompts);
    setSelectedId(baseline.boxes[0]?.id ?? null);
    setPointMode(null);
    updateHistoryButtons();
    setAnnouncement('已恢复初始内容');
  };

  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedId);
  const preview = previewOpen && imageUrl
    ? <ZoomableImagePreview src={imageUrl} alt="角色图大图预览" onClose={() => setPreviewOpen(false)} />
    : null;

  return (
    <>
      <section className={styles.editor} aria-label="角色框与提示点编辑器">
        <header className={styles.editorHeader}>
          <div>
            <h3>角色框选</h3>
            <p>{width} × {height} px</p>
          </div>
          <div className={styles.toolbar}>
            <button type="button" className={styles.iconButton} title="撤销" aria-label="撤销" onClick={undo} disabled={disabled || !canUndo}><Undo2 size={16} /></button>
            <button type="button" className={styles.iconButton} title="重做" aria-label="重做" onClick={redo} disabled={disabled || !canRedo}><Redo2 size={16} /></button>
            <button type="button" className={styles.iconButton} title="放大预览" aria-label="放大预览" onClick={() => setPreviewOpen(true)} disabled={!imageUrl}><ImageIcon size={16} /></button>
            <button type="button" className={styles.iconButton} title="恢复初始框选" aria-label="恢复初始框选" onClick={() => void restoreInitial()} disabled={disabled || !changedFromInitial}><RotateCcw size={16} /></button>
          </div>
        </header>

        <div className={styles.characterLayout}>
          <div className={styles.imageColumn}>
            <div
              className={styles.imageStage}
              onDoubleClick={() => { if (!pointMode) setPreviewOpen(true); }}
            >
              <img src={imageUrl} alt="角色原图" draggable={false} className={styles.stageImage} />
              <svg
                ref={svgRef}
                className={`${styles.overlay} ${pointMode ? styles.pointCursor : styles.drawCursor}`}
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="none"
                aria-label="角色框选区域"
                onPointerDown={beginDraw}
                onPointerMove={moveDraw}
                onPointerUp={finishDraw}
                onPointerCancel={cancelDraw}
                onClick={addPromptPoint}
              >
                {boxes.map((box, index) => (
                  <g key={box.id} data-box-id={box.id} className={box.id === selectedId ? styles.boxSelected : styles.box}>
                    <rect x={box.x} y={box.y} width={box.w} height={box.h} vectorEffect="non-scaling-stroke" />
                    <text x={box.x + 5} y={Math.min(height - 3, box.y + labelSize + 3)} fontSize={labelSize} vectorEffect="non-scaling-stroke">
                      {index + 1}. {box.name}
                    </text>
                  </g>
                ))}
                {prompts.flatMap((prompt) => prompt.points.map((point, index) => {
                  const foreground = prompt.labels[index] === 1;
                  return (
                    <g key={`${prompt.id}-${index}`} className={foreground ? styles.foregroundPoint : styles.backgroundPoint} pointerEvents="none">
                      <circle cx={point[0]} cy={point[1]} r={pointRadius} vectorEffect="non-scaling-stroke" />
                      <text x={point[0] + pointRadius + 2} y={point[1] - pointRadius} fontSize={labelSize * 0.8} vectorEffect="non-scaling-stroke">{foreground ? '+' : '-'}</text>
                    </g>
                  );
                }))}
                {drawing && <rect className={styles.drawingBox} x={drawing.x} y={drawing.y} width={drawing.w} height={drawing.h} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
              </svg>
            </div>
            <div className={styles.imageCaption}>
              <span role="status" aria-live="polite">{pointMode
                ? selectedBox ? `${pointMode === 'foreground' ? '前景' : '背景'}点 · ${selectedBox.name}` : '未选择角色框'
                : '原图坐标'}</span>
              <span>{boxes.length} 个角色框</span>
            </div>
          </div>

          <aside className={styles.sidePanel} aria-label="角色与提示点">
            <div className={styles.sideHeading}><strong>角色</strong><span>{boxes.length}</span></div>
            {boxes.length === 0 && <p className={styles.emptyHint}>暂无角色框</p>}
            <div className={styles.characterList}>
              {boxes.map((box, index) => (
                <div className={styles.characterItem} key={box.id}>
                  <div className={styles.characterRow}>
                    <button type="button" className={styles.characterSelect} aria-pressed={selectedId === box.id} onClick={() => { setSelectedId(box.id); setPointMode(null); }} disabled={disabled}>
                      <span className={styles.index}>{index + 1}</span><span className={styles.characterName}>{box.name || `角色 ${index + 1}`}</span>
                    </button>
                    <button type="button" className={styles.iconButton} title={`移除${box.name || '角色框'}`} aria-label={`移除${box.name || '角色框'}`} onClick={() => removeBox(box.id)} disabled={disabled}><Trash2 size={15} /></button>
                  </div>
                  {selectedId === box.id && (
                    <div className={styles.characterDetails}>
                      <NameField value={box.name} disabled={disabled} onCommit={(value) => editBox(box.id, 'name', value)} onEditEnd={() => { editGroup.current = null; }} />
                      <div className={styles.numberGrid}>
                        <NumberField label="X" value={box.x} min={0} max={Math.max(0, width - box.w)} disabled={disabled} onCommit={(value) => editBox(box.id, 'x', value)} onEditEnd={() => { editGroup.current = null; }} />
                        <NumberField label="Y" value={box.y} min={0} max={Math.max(0, height - box.h)} disabled={disabled} onCommit={(value) => editBox(box.id, 'y', value)} onEditEnd={() => { editGroup.current = null; }} />
                        <NumberField label="宽" value={box.w} min={1} max={width} disabled={disabled} onCommit={(value) => editBox(box.id, 'w', value)} onEditEnd={() => { editGroup.current = null; }} />
                        <NumberField label="高" value={box.h} min={1} max={height} disabled={disabled} onCommit={(value) => editBox(box.id, 'h', value)} onEditEnd={() => { editGroup.current = null; }} />
                      </div>
                      <div className={styles.pointTools} role="group" aria-label="提示点类型">
                        <button type="button" className={pointMode === 'foreground' ? styles.segmentActive : styles.segment} aria-pressed={pointMode === 'foreground'} onClick={() => setPointMode(pointMode === 'foreground' ? null : 'foreground')} disabled={disabled}>前景点</button>
                        <button type="button" className={pointMode === 'background' ? styles.segmentActive : styles.segment} aria-pressed={pointMode === 'background'} onClick={() => setPointMode(pointMode === 'background' ? null : 'background')} disabled={disabled}>背景点</button>
                      </div>
                      {selectedPrompt?.points.length ? (
                        <ul className={styles.pointList} aria-label="提示点列表">
                          {selectedPrompt.points.map((point, pointIndex) => (
                            <li key={`${selectedPrompt.id}-${pointIndex}`}>
                              <span className={selectedPrompt.labels[pointIndex] === 1 ? styles.foregroundLabel : styles.backgroundLabel}>
                                {selectedPrompt.labels[pointIndex] === 1 ? '前景' : '背景'} · {point[0]}, {point[1]}
                              </span>
                              <button type="button" className={styles.iconButton} title="移除提示点" aria-label={`移除第 ${pointIndex + 1} 个提示点`} onClick={() => removePromptPoint(selectedPrompt.id, pointIndex)} disabled={disabled}><X size={14} /></button>
                            </li>
                          ))}
                        </ul>
                      ) : <p className={styles.fieldHint}>提示点按所选角色分组，仅用于这次角色拆切。</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </section>
      {productDialog}
      {preview}
      <span className={styles.srOnly} aria-live="polite">{announcement}</span>
    </>
  );
}
