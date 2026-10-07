'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Clapperboard, Film, Folder, Image as ImageIcon, LayoutTemplate, ListTodo, Menu, Network, Plus, RefreshCw, RotateCcw, Scissors, UserRound } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import LikeButton from '@/components/content-reactions/LikeButton';
import { cachedReactionState, watchReactionChanges, writeReaction } from '@/components/content-reactions/ContentReactions';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import type { HomeProject, HomeTemplate, HomeTemplates } from '@/lib/home/types';
import styles from '@/app/home.module.css';

function Thumbnail({ src, project = false }: { src: string | null; project?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <div className={styles.thumbnail}>
    {src && !failed
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <span className={styles.placeholder}>
        {project ? <Folder size={26} aria-hidden="true" /> : <ImageIcon size={26} aria-hidden="true" />}
        <span>{project ? '暂无预览' : '暂无封面'}</span>
      </span>}
  </div>;
}

function CardSkeletons({ className, count }: { className: string; count: number }) {
  return <div className={`${className} ${styles.skeletons}`} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <span className={styles.skeleton} key={index}><i /><b /></span>)}
  </div>;
}

export default function HomeWorkspace({ accountId, internal, images, admin }: { accountId: string; internal: boolean; images: boolean; admin: boolean }) {
  const { user, hasLoadedUser } = useAppSession();
  const router = useRouter();
  const authorized = hasLoadedUser && user?.id === accountId;
  const identity = authorized ? accountId : '';
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [templates, setTemplates] = useState<HomeTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [needed, setNeeded] = useState(false);
  const [open, setOpen] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({});
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const workspaceOpen = Boolean(identity && preferencesReady && open);
  const accountDataReady = Boolean(identity && loadedIdentity === identity);
  const writing = useRef(new Set<string>());
  const projectsRequest = useRef<AbortController | null>(null);
  const templatesRequest = useRef<AbortController | null>(null);
  const templateSection = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useDialogDismiss({ open: workspaceOpen, dialogRef: workspace, branchRefs: [menuButton], modal: false, onDismiss: () => setOpen(false) });
  const resetScroll = useRememberedScroll(`home:${identity}`, Boolean(identity && preferencesReady && (!internal || projectLoaded)), { localFallback: true });

  useEffect(() => {
    if (hasLoadedUser && user?.id !== accountId) router.refresh();
  }, [accountId, hasLoadedUser, router, user?.id]);

  useEffect(() => {
    setPreferencesReady(false);
    setOpen(false);
    if (!identity) return;
    try { setOpen(localStorage.getItem(`sd2-home-workspace:${identity}`) === 'open'); } catch { /* Keep the in-memory default. */ }
    setPreferencesReady(true);
  }, [identity]);

  useEffect(() => {
    if (!identity || !preferencesReady) return;
    try { localStorage.setItem(`sd2-home-workspace:${identity}`, open ? 'open' : 'closed'); } catch { /* The workspace remains usable without storage. */ }
  }, [identity, open, preferencesReady]);

  useEffect(() => {
    const section = templateSection.current;
    if (!section || !images) return;
    if (typeof IntersectionObserver === 'undefined') { setNeeded(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNeeded(true);
        observer.disconnect();
      }
    }, { rootMargin: '160px' });
    observer.observe(section);
    return () => observer.disconnect();
  }, [images]);

  const loadProjects = useCallback(async () => {
    projectsRequest.current?.abort();
    if (!identity || !internal) return;
    const requestIdentity = identity;
    const controller = new AbortController();
    projectsRequest.current = controller;
    setProjects([]);
    setProjectError('');
    setProjectLoading(true);
    try {
      const response = await fetch('/api/projects?summary=home', { cache: 'no-store', signal: controller.signal });
      const data: { projects?: HomeProject[]; error?: string } = await response.json();
      if (!response.ok || !Array.isArray(data.projects)) throw new Error('项目暂时无法读取，请重试');
      if (!controller.signal.aborted && identityRef.current === requestIdentity) setProjects(data.projects);
    } catch {
      if (!controller.signal.aborted && identityRef.current === requestIdentity) setProjectError('项目暂时无法读取，请重试');
    } finally {
      if (!controller.signal.aborted && identityRef.current === requestIdentity) {
        setProjectLoading(false);
        setProjectLoaded(true);
      }
    }
  }, [identity, internal]);

  const loadTemplates = useCallback(async (after: string | null = null, retained: HomeTemplate[] = []) => {
    templatesRequest.current?.abort();
    if (!identity || !images) return;
    const requestIdentity = identity;
    const controller = new AbortController();
    templatesRequest.current = controller;
    setTemplateError('');
    setTemplateLoading(true);
    if (!after) { setTemplates([]); setCursor(null); }
    let items = retained;
    let next = after;
    try {
      // Continue only through bounded candidate pages; never treat an invisible batch as global emptiness.
      for (let page = 0; page < 3; page += 1) {
        const remaining = 5 - items.length;
        if (remaining <= 0 || !next && page > 0) break;
        const query = new URLSearchParams({ summary: 'home-templates', limit: String(remaining) });
        if (next) query.set('cursor', next);
        const response = await fetch(`/api/content-reactions?${query.toString()}`, { cache: 'no-store', signal: controller.signal });
        const data: HomeTemplates & { error?: string } = await response.json();
        if (!response.ok || !Array.isArray(data.items) || !(data.nextCursor === null || (typeof data.nextCursor === 'string' && data.nextCursor.length > 0))) {
          throw new Error('收藏暂时无法读取，请重试');
        }
        if (data.items.length > remaining) throw new Error('收藏数量不一致，请重新读取');
        items = [...items, ...data.items.filter(item => !items.some(old => old.key === item.key))];
        next = data.nextCursor;
        if (items.length >= 5 || !next) break;
      }
      if (!controller.signal.aborted && identityRef.current === requestIdentity) {
        setTemplates(items);
        setCursor(next);
      }
    } catch {
      if (!controller.signal.aborted && identityRef.current === requestIdentity) {
        setTemplateError('收藏暂时无法读取，请重试');
      }
    } finally {
      if (!controller.signal.aborted && identityRef.current === requestIdentity) {
        setTemplateLoading(false);
        setTemplateLoaded(true);
      }
    }
  }, [identity, images]);

  useEffect(() => {
    projectsRequest.current?.abort();
    templatesRequest.current?.abort();
    writing.current.clear();
    setLoadedIdentity(identity);
    setProjects([]);
    setTemplates([]);
    setCursor(null);
    setProjectError('');
    setTemplateError('');
    setWriteErrors({});
    setBusyKeys([]);
    setProjectLoaded(false);
    setTemplateLoaded(false);
    setProjectLoading(Boolean(identity));
    setTemplateLoading(false);
  }, [identity]);

  useEffect(() => {
    if (!identity || !internal) {
      setProjects([]);
      setProjectError('');
      setProjectLoading(false);
      setProjectLoaded(true);
      return;
    }
    void loadProjects();
    return () => projectsRequest.current?.abort();
  }, [identity, internal, loadProjects]);

  useEffect(() => {
    if (!identity || !images || !needed) {
      if (!identity || !images) {
        setTemplates([]);
        setCursor(null);
        setTemplateError('');
        setTemplateLoaded(true);
      }
      setTemplateLoading(false);
      return;
    }
    void loadTemplates();
    return () => templatesRequest.current?.abort();
  }, [identity, images, needed, loadTemplates]);

  useEffect(() => {
    if (!identity) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadProjects();
      if (needed && !writing.current.size) void loadTemplates();
    };
    const unwatch = watchReactionChanges(identity, () => { if (needed) void loadTemplates(); });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      unwatch();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [identity, loadProjects, loadTemplates, needed]);

  async function cancelFavorite(item: HomeTemplate) {
    if (!identity || !authorized) return;
    const requestIdentity = identity;
    const mutationKey = `${requestIdentity}/${item.key}`;
    if (writing.current.has(mutationKey)) return;
    writing.current.add(mutationKey);
    setBusyKeys(Array.from(writing.current));
    setWriteErrors(errors => ({ ...errors, [mutationKey]: '' }));
    try {
      const latest = writeErrors[mutationKey] ? cachedReactionState(requestIdentity, item.key) : undefined;
      if (latest && !latest.available) {
        setTemplates(current => current.filter(old => old.key !== item.key));
        void loadTemplates();
        return;
      }
      const state = await writeReaction(requestIdentity, item.key, 'like', false, latest || item.state);
      if (identityRef.current !== requestIdentity || !state) return;
      if (state.liked || state.favorited) throw new Error('收藏状态尚未确认，请重试');
      setTemplates(current => current.filter(old => old.key !== item.key));
      void loadTemplates();
    } catch {
      if (identityRef.current === requestIdentity) {
        setWriteErrors(errors => ({ ...errors, [mutationKey]: '收藏状态未能更新，请重试' }));
      }
    } finally {
      writing.current.delete(mutationKey);
      if (identityRef.current === requestIdentity) setBusyKeys(Array.from(writing.current));
    }
  }

  const links = [
    { title: '新建项目', href: '/projects#create-project', icon: Plus, visible: internal },
    { title: '我的项目', href: '/projects', icon: Folder, visible: internal },
    { title: '资产管理', href: '/assets', icon: ImageIcon, visible: true },
    { title: '模板工作台', href: '/template-studio', icon: LayoutTemplate, visible: internal || images },
    { title: '我的任务', href: '/tasks', icon: ListTodo, visible: true },
  ];
  const entries = [
    { title: '普通视频', href: '/generate', icon: Clapperboard, visible: internal, tone: 'blue' },
    { title: 'IP视频', href: '/generate/ip', icon: Film, visible: internal, tone: 'yellow' },
    { title: '图片生成', href: '/template-studio?type=image', icon: ImageIcon, visible: images, tone: 'mint' },
    { title: '分镜提示词', href: '/template-studio?type=video&view=prompts', icon: ListTodo, visible: internal, tone: 'rose' },
    { title: '随机真人', href: '/tools/avatar-studio', icon: UserRound, visible: images, tone: 'violet' },
    { title: 'AI 抠图', href: '/cutout', icon: Scissors, visible: admin, tone: 'cyan' },
  ];

  return <div className={styles.page}>
    <aside className={styles.sidebar}>
      <button ref={menuButton} type="button" className={styles.workspaceToggle} aria-expanded={workspaceOpen} aria-controls="home-workspace-links" onClick={() => setOpen(value => !value)}>
        <Menu size={18} aria-hidden="true" />工作区
      </button>
      <div ref={workspace} id="home-workspace-links" className={styles.workspaceLinks} data-open={workspaceOpen ? 'true' : 'false'}>
        <h1>工作区</h1>
        <nav aria-label="工作区">
          {links.filter(link => link.visible).map(link => <Link key={link.href} href={link.href} className={link.icon === Plus ? styles.createLink : styles.sideLink} onClick={() => setOpen(false)}>
            <link.icon size={18} aria-hidden="true" /><span>{link.title}</span>
          </Link>)}
        </nav>
        <button type="button" className={styles.reset} onClick={() => { setOpen(false); resetScroll(); }} title="重置首页位置" aria-label="重置首页位置">
          <RotateCcw size={15} aria-hidden="true" />重置位置
        </button>
      </div>
    </aside>

    <div className={styles.content}>
      {internal && <section className={styles.canvasSection} aria-labelledby="home-canvas-title">
        <Link href="/tools/ultimate-canvas" className={styles.canvas}>
          <span className={styles.canvasIcon}><Network size={28} strokeWidth={1.7} aria-hidden="true" /></span>
          <h2 id="home-canvas-title">无线画布</h2>
          <span className={styles.canvasAction}>打开画布<ArrowRight size={17} aria-hidden="true" /></span>
        </Link>
      </section>}

      <section className={styles.tools} aria-labelledby="home-tools-title">
        <h2 id="home-tools-title">常用功能</h2>
        <div className={styles.entries}>
          {entries.filter(entry => entry.visible).map(entry => <Link key={entry.href} href={entry.href} className={styles.entryLink} data-tone={entry.tone}>
            <entry.icon size={25} strokeWidth={1.7} aria-hidden="true" /><span>{entry.title}</span>
          </Link>)}
        </div>
      </section>

      {internal && <section className={styles.section} aria-labelledby="home-projects-title" aria-busy={projectLoading} data-remember-scroll-anchor="home-projects">
        <header className={styles.sectionHeader}>
          <h2 id="home-projects-title">最近项目</h2>
          <Link href="/projects">查看全部<ArrowRight size={14} aria-hidden="true" /></Link>
        </header>
        {authorized && accountDataReady && projectLoading && !projects.length && <><span className={styles.visuallyHidden} role="status">正在读取项目…</span><CardSkeletons className={styles.projects} count={4} /></>}
        {authorized && accountDataReady && projects.length > 0 && <div className={styles.projects}>
          {projects.slice(0, 4).map(project => <article key={project.id} className={styles.project}>
            <Link href={`/projects/${encodeURIComponent(project.id)}`} className={styles.projectLink}>
              <Thumbnail key={project.thumbnailUrl} src={project.thumbnailUrl} project />
              <strong className={styles.projectName}>{project.name}</strong>
            </Link>
            <div className={styles.updated}>更新 <RelativeTime value={project.updated_at} /></div>
          </article>)}
        </div>}
        {authorized && accountDataReady && !projectLoading && projectError && <div className={styles.sectionState} role="status">
          <span>{projectError}</span><button type="button" onClick={() => void loadProjects()}><RefreshCw size={16} aria-hidden="true" />重试</button>
        </div>}
        {authorized && accountDataReady && !projectLoading && !projectError && !projects.length && <div className={styles.sectionState}>
          <span>还没有项目</span><Link href="/projects#create-project"><Plus size={16} aria-hidden="true" />新建项目</Link>
        </div>}
        {(!authorized || !accountDataReady) && <span className={styles.visuallyHidden} role="status">正在确认账号…</span>}
      </section>}

      {images && <section ref={templateSection} className={styles.section} aria-labelledby="home-templates-title" aria-busy={templateLoading} data-remember-scroll-anchor="home-templates">
        <header className={styles.sectionHeader}>
          <h2 id="home-templates-title">收藏模板</h2>
          <Link href="/template-studio?type=image">模板工作台<ArrowRight size={14} aria-hidden="true" /></Link>
        </header>
        {authorized && accountDataReady && !templateError && (templateLoading || !needed) && !templates.length && <>
          {needed && <span className={styles.visuallyHidden} role="status">正在读取收藏…</span>}
          <CardSkeletons className={styles.templates} count={5} />
        </>}
        {authorized && accountDataReady && templates.length > 0 && <div className={styles.templates}>
          {templates.slice(0, 5).map(item => {
            const mutationKey = `${identity}/${item.key}`;
            const busy = busyKeys.includes(mutationKey);
            return <article key={item.key} className={styles.template}>
              <Link href={item.href} className={styles.templateLink}>
                <Thumbnail key={item.thumbnailUrl} src={item.thumbnailUrl} />
                <strong>{item.title}</strong>
              </Link>
              <div className={styles.favorite} aria-busy={busy || undefined}>
                <LikeButton active={Boolean(item.state.liked || item.state.favorited)} disabled={busy} showCount={false} animateCount={false} bloom={0} onClick={() => void cancelFavorite(item)} />
                {busy && <span role="status">保存中</span>}
              </div>
              {writeErrors[mutationKey] && <p className={styles.error} role="status">
                <span>{writeErrors[mutationKey]}</span><button type="button" disabled={busy} aria-label="重试取消收藏" title="重试取消收藏" onClick={() => void cancelFavorite(item)}><RefreshCw size={15} aria-hidden="true" /></button>
              </p>}
            </article>;
          })}
        </div>}
        {authorized && accountDataReady && templateError && <div className={styles.sectionState} role="status">
          <span>{templateError}</span><button type="button" onClick={() => { setNeeded(true); void loadTemplates(); }}><RefreshCw size={16} aria-hidden="true" />重试</button>
        </div>}
        {authorized && accountDataReady && templateLoaded && !templateLoading && !templateError && !templates.length && !cursor && <div className={styles.sectionState}>
          <span>还没有收藏模板</span><Link href="/template-studio?type=image">去模板工作台<ArrowRight size={16} aria-hidden="true" /></Link>
        </div>}
        {authorized && accountDataReady && !templateLoading && !templateError && cursor && templates.length < 5 && <button className={styles.continue} type="button" onClick={() => void loadTemplates(cursor, templates)}>
          <RefreshCw size={16} aria-hidden="true" />继续读取收藏
        </button>}
        {(!authorized || !accountDataReady) && <span className={styles.visuallyHidden} role="status">正在确认账号…</span>}
      </section>}
    </div>
  </div>;
}
