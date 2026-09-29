'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, ChevronDown, Film, Image as ImageIcon, RefreshCw, Settings2 } from 'lucide-react';
import type { StudioTemplateDto, TemplateListResponse } from '@/lib/template-studio/types';
import styles from './TemplateCatalog.module.css';

type ImageTemplate = {
  id: string;
  name: string;
  scope: 'admin' | 'creator';
  isShared: boolean;
  canManageSharing?: boolean;
  groupName: string;
  prompt: string;
  context: string;
  model: string;
  images: Array<{ id: string; thumbnailUrl?: string | null; originalUrl?: string | null }>;
  banner: { id: string; thumbnailUrl?: string | null; originalUrl?: string | null } | null;
};

type Props = {
  userId: string;
  allowedTypes: Array<'image' | 'video'>;
};

const IMAGE_BATCH_SIZE = 12;

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : fallback;
    throw new Error(message);
  }
  return body as T;
}

function groupItems<T>(items: T[], groupOf: (item: T) => string) {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const groupName = groupOf(item).trim() || '未分组';
    (groups[groupName] ||= []).push(item);
    return groups;
  }, Object.create(null) as Record<string, T[]>);
}

function PreviewText({ label, value }: { label: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = value.trim();
  if (!text) return null;
  return (
    <div className={styles.previewBlock} data-template-preview={label === '提示词' ? 'prompt' : 'context'}>
      <span className={styles.previewLabel}>{label}</span>
      <p className={expanded ? styles.previewTextExpanded : styles.previewText}>{text}</p>
      <button className={styles.textToggle} type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        {expanded ? '收起内容' : '展开内容'}
      </button>
    </div>
  );
}

export default function TemplateCatalog({ userId, allowedTypes }: Props) {
  const router = useRouter();
  const [imageTemplates, setImageTemplates] = useState<ImageTemplate[]>([]);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [videoTemplates, setVideoTemplates] = useState<StudioTemplateDto[]>([]);
  const [videoCursor, setVideoCursor] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [foldsReady, setFoldsReady] = useState(false);
  const [imageVisibleCounts, setImageVisibleCounts] = useState<Record<string, number>>({});
  const [applyingPresetId, setApplyingPresetId] = useState<string | null>(null);
  const [applyMessages, setApplyMessages] = useState<Record<string, { message: string; uncertain: boolean }>>({});
  const imageSequence = useRef(0);
  const videoSequence = useRef(0);
  const videoCursorRef = useRef<string | null>(null);
  const videoLoadLock = useRef(false);
  const applyLock = useRef(false);
  const uncertainApplications = useRef(new Set<string>());
  const foldStorageKey = useMemo(() => `sd2-template-catalog-folds:${encodeURIComponent(userId)}`, [userId]);
  const canViewImages = allowedTypes.includes('image');
  const canViewVideos = allowedTypes.includes('video');

  const loadImageTemplates = useCallback(async () => {
    const sequence = ++imageSequence.current;
    setImageLoading(true);
    setImageError('');
    try {
      const response = await fetch('/api/image-studio/presets', { cache: 'no-store' });
      const result = await readJson<{ presets: ImageTemplate[] }>(response, '图片模板暂时无法读取');
      if (sequence === imageSequence.current) setImageTemplates(Array.isArray(result.presets) ? result.presets : []);
    } catch (error) {
      if (sequence === imageSequence.current) setImageError(error instanceof Error ? error.message : '图片模板暂时无法读取');
    } finally {
      if (sequence === imageSequence.current) setImageLoading(false);
    }
  }, []);

  const loadVideoTemplates = useCallback(async (append = false) => {
    if (videoLoadLock.current) return;
    const cursor = append ? videoCursorRef.current : null;
    if (append && !cursor) return;
    videoLoadLock.current = true;
    const sequence = ++videoSequence.current;
    setVideoLoading(true);
    setVideoError('');
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const response = await fetch(`/api/template-studio/templates${query}`, { cache: 'no-store' });
      const page = await readJson<TemplateListResponse>(response, '视频模板暂时无法读取');
      if (sequence !== videoSequence.current) return;
      setVideoTemplates((current) => {
        const next = append ? [...current, ...page.items] : page.items;
        const seen = new Set<string>();
        return next.filter((item) => {
          const key = `${item.source}:${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
      videoCursorRef.current = page.nextCursor;
      setVideoCursor(page.nextCursor);
    } catch (error) {
      if (sequence === videoSequence.current) setVideoError(error instanceof Error ? error.message : '视频模板暂时无法读取');
    } finally {
      if (sequence === videoSequence.current) setVideoLoading(false);
      videoLoadLock.current = false;
    }
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(foldStorageKey) || '[]');
      if (Array.isArray(saved)) setCollapsedGroups(new Set(saved.filter((value): value is string => typeof value === 'string')));
    } catch {
      setCollapsedGroups(new Set());
    } finally {
      setFoldsReady(true);
    }
  }, [foldStorageKey]);

  useEffect(() => {
    if (canViewImages) void loadImageTemplates();
    if (canViewVideos) void loadVideoTemplates();
    return () => {
      imageSequence.current += 1;
      videoSequence.current += 1;
    };
  }, [canViewImages, canViewVideos, loadImageTemplates, loadVideoTemplates]);

  const imageGroups = useMemo(() => groupItems(imageTemplates, (item) => item.groupName), [imageTemplates]);
  const videoGroups = useMemo(() => groupItems(videoTemplates, (item) => item.groupName), [videoTemplates]);

  function groupIsOpen(key: string) {
    return !foldsReady || !collapsedGroups.has(key);
  }

  function rememberGroupState(key: string, open: boolean) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (open) next.delete(key);
      else next.add(key);
      try { window.localStorage.setItem(foldStorageKey, JSON.stringify(Array.from(next))); } catch { /* Folding remains available for this visit. */ }
      return next;
    });
  }

  function openImageWorkspace(view?: string) {
    const query = new URLSearchParams({ workspace: '1', type: 'image' });
    if (view) query.set('view', view);
    router.push(`/template-studio?${query.toString()}`);
  }

  function openVideoWorkspace(template?: StudioTemplateDto) {
    const query = new URLSearchParams({ workspace: '1', type: 'video', view: 'templates' });
    if (template) {
      query.set('templateId', template.id);
      query.set('templateSource', template.source);
    }
    router.push(`/template-studio?${query.toString()}`);
  }

  async function handleApplyImageTemplate(template: ImageTemplate) {
    if (applyLock.current || uncertainApplications.current.has(template.id)) return;
    applyLock.current = true;
    setApplyingPresetId(template.id);
    setApplyMessages((current) => {
      const next = { ...current };
      delete next[template.id];
      return next;
    });
    const markUncertain = () => {
      uncertainApplications.current.add(template.id);
      setApplyMessages((current) => ({ ...current, [template.id]: { message: '应用结果未确认。请先到图片工作区核对是否已创建模块，再决定下一步。', uncertain: true } }));
    };
    try {
      let response: Response;
      try {
        response = await fetch('/api/image-studio/presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'apply', presetId: template.id }),
        });
      } catch {
        markUncertain();
        return;
      }
      let created: { id?: string; error?: string } | null = null;
      try {
        created = await response.json() as { id?: string; error?: string };
      } catch {
        if (response.status >= 400 && response.status < 500) {
          setApplyMessages((current) => ({ ...current, [template.id]: { message: '模板没有应用成功', uncertain: false } }));
        } else {
          markUncertain();
        }
        return;
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const message = typeof created?.error === 'string' ? created.error : '模板没有应用成功';
          setApplyMessages((current) => ({ ...current, [template.id]: { message, uncertain: false } }));
        } else {
          markUncertain();
        }
        return;
      }
      if (!created || typeof created.id !== 'string' || !created.id) {
        markUncertain();
        return;
      }
      const query = new URLSearchParams({ workspace: '1', type: 'image', moduleId: created.id });
      router.push(`/template-studio?${query.toString()}`);
    } catch {
      markUncertain();
    } finally {
      applyLock.current = false;
      setApplyingPresetId(null);
    }
  }

  return (
    <section className={styles.catalog} aria-label="统一模板目录">
      {canViewImages && (
        <section className={styles.category} aria-label="图片模板">
          <header className={styles.categoryHeader}>
            <div className={styles.categoryTitle}>
              <ImageIcon size={18} aria-hidden="true" />
              <h2>图片模板</h2>
              {!imageLoading && !imageError && <span className={styles.categoryCount}>{imageTemplates.length}</span>}
            </div>
            <div className={styles.categoryActions}>
              <button type="button" className={styles.quietButton} onClick={() => openImageWorkspace('template-management')}>
                <Settings2 size={15} aria-hidden="true" /> 管理模板
              </button>
              <a className={styles.quietButton} href="/image-studio">
                打开图片生成 <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </div>
          </header>

          {imageLoading && imageTemplates.length === 0 && <p className={styles.state} role="status">正在读取图片模板…</p>}
          {imageError && <div className={styles.errorState} role="alert"><span>{imageError}</span><button className={styles.quietButton} type="button" onClick={() => void loadImageTemplates()}><RefreshCw size={14} aria-hidden="true" /> 重试</button></div>}
          {!imageLoading && !imageError && imageTemplates.length === 0 && <p className={styles.state}>暂无图片模板</p>}

          <div className={styles.groupList}>
            {Object.entries(imageGroups).map(([groupName, items]) => {
              const key = `image:${groupName}`;
              const visibleCount = imageVisibleCounts[key] || IMAGE_BATCH_SIZE;
              const visibleItems = items.slice(0, visibleCount);
              return (
                <details
                  key={key}
                  className={styles.group}
                  data-template-group={groupName}
                  open={groupIsOpen(key)}
                  onToggle={(event) => rememberGroupState(key, event.currentTarget.open)}
                >
                  <summary className={styles.groupSummary}>
                    <ChevronDown className={styles.groupChevron} size={15} aria-hidden="true" />
                    <span>{groupName}</span><small>{items.length}</small>
                  </summary>
                  <div className={styles.templateList}>
                    {visibleItems.map((template) => {
                      const cover = template.banner?.thumbnailUrl || template.images[0]?.thumbnailUrl || '';
                      const applyMessage = applyMessages[template.id];
                      return (
                        <article key={template.id} className={styles.templateItem} data-template-card="image" data-template-id={template.id}>
                          <div className={styles.imageCover}>
                            {cover ? <img src={cover} alt={`${template.name}封面`} loading="lazy" /> : <span>暂无封面</span>}
                          </div>
                          <div className={styles.templateContent}>
                            <div className={styles.templateTitleRow}>
                              <h3>{template.name}</h3>
                              <span className={styles.visibility}>{template.isShared ? '共享模板' : '个人模板'}</span>
                            </div>
                            <PreviewText label="提示词" value={template.prompt} />
                            <PreviewText label="上下文" value={template.context} />
                            {applyMessage && <p className={applyMessage.uncertain ? styles.warningText : styles.errorText} role="alert">{applyMessage.message}</p>}
                            {applyMessage?.uncertain && <a className={styles.inlineLink} href="/template-studio?workspace=1&type=image">打开图片工作区核对</a>}
                          </div>
                          <div className={styles.templateActions}>
                            <button
                              className={styles.primaryButton}
                              type="button"
                              disabled={applyingPresetId !== null || uncertainApplications.current.has(template.id)}
                              onClick={() => void handleApplyImageTemplate(template)}
                            >
                              {applyingPresetId === template.id ? '正在打开…' : '使用模板'}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                    {items.length > visibleItems.length && (
                      <button className={styles.loadMoreInline} type="button" onClick={() => setImageVisibleCounts((current) => ({ ...current, [key]: visibleCount + IMAGE_BATCH_SIZE }))}>
                        加载更多图片模板
                      </button>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}

      {canViewVideos && (
        <section className={styles.category} aria-label="视频模板">
          <header className={styles.categoryHeader}>
            <div className={styles.categoryTitle}>
              <Film size={18} aria-hidden="true" />
              <h2>视频模板</h2>
              {!videoLoading && !videoError && <span className={styles.categoryCount}>已加载 {videoTemplates.length} 项</span>}
            </div>
            <div className={styles.categoryActions}>
              <button type="button" className={styles.quietButton} onClick={() => openVideoWorkspace()}>
                打开视频工作区 <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>
          </header>

          {videoLoading && videoTemplates.length === 0 && <p className={styles.state} role="status">正在读取视频模板…</p>}
          {videoError && <div className={styles.errorState} role="alert"><span>{videoError}</span><button className={styles.quietButton} type="button" onClick={() => void loadVideoTemplates(Boolean(videoCursorRef.current))}><RefreshCw size={14} aria-hidden="true" /> 重试</button></div>}
          {!videoLoading && !videoError && videoTemplates.length === 0 && <p className={styles.state}>暂无视频模板</p>}

          <div className={styles.groupList}>
            {Object.entries(videoGroups).map(([groupName, items]) => {
              const key = `video:${groupName}`;
              return (
                <details
                  key={key}
                  className={styles.group}
                  data-template-group={groupName}
                  open={groupIsOpen(key)}
                  onToggle={(event) => rememberGroupState(key, event.currentTarget.open)}
                >
                  <summary className={styles.groupSummary}>
                    <ChevronDown className={styles.groupChevron} size={15} aria-hidden="true" />
                    <span>{groupName}</span><small>{items.length}</small>
                  </summary>
                  <div className={styles.templateList}>
                    {items.map((template) => (
                      <article key={`${template.source}:${template.id}`} className={styles.templateItem} data-template-card="video" data-template-id={template.id} data-template-source={template.source}>
                        <div className={styles.videoCover}><Film size={21} aria-hidden="true" /><span>视频模板</span></div>
                        <div className={styles.templateContent}>
                          <div className={styles.templateTitleRow}>
                            <h3>{template.name}</h3>
                            <span className={styles.visibility}>
                              {template.visibility === 'shared' ? '共享模板' : template.visibility === 'legacy' ? '旧版模板' : '个人模板'}
                            </span>
                          </div>
                          <PreviewText label="说明" value={template.description || ''} />
                          {template.recipe?.instruction && <PreviewText label="固定要求" value={template.recipe.instruction} />}
                          {template.recipe && (template.recipe.fields.length > 0 || template.recipe.assetSlots.length > 0) && (
                            <p className={styles.templateMeta}>
                              {template.recipe.fields.length > 0 && <span>{template.recipe.fields.map((field) => field.label).join('、')}</span>}
                              {template.recipe.assetSlots.length > 0 && <span>素材位置：{template.recipe.assetSlots.map((slot) => slot.label).join('、')}</span>}
                            </p>
                          )}
                        </div>
                        <div className={styles.templateActions}>
                          <button className={styles.primaryButton} type="button" onClick={() => openVideoWorkspace(template)}>查看模板</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>

          {videoCursor && <button className={styles.loadMore} type="button" disabled={videoLoading} onClick={() => void loadVideoTemplates(true)}>{videoLoading ? '正在读取…' : '加载更多视频模板'}</button>}
        </section>
      )}
    </section>
  );
}
