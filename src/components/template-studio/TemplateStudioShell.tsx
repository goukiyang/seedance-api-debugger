'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Bookmark, RotateCcw } from 'lucide-react';
import ImageStudio from '@/app/image-studio/studio';
import { StudioBatchHistory } from '@/app/image-studio/batch-results';
import { useAppSession } from '@/lib/context/AppSessionContext';
import VideoTemplateWorkbench from './VideoTemplateWorkbench';
import styles from './template-studio.module.css';

type StudioType = 'image' | 'video';
type VideoStudioView = 'templates' | 'prompts' | 'results';
type RememberedStudioLocation = {
  version: 1;
  type: StudioType;
  view?: VideoStudioView;
  moduleId?: string;
  draftId?: string;
  runId?: string;
};

type Props = {
  userId: string;
  isAdmin: boolean;
  allowedTypes: StudioType[];
  initialType: StudioType;
};

const REMEMBERED_LOCATION_PREFIX = 'sd2-template-studio-location:v1:';

function rememberedLocationKey(userId: string) {
  return `${REMEMBERED_LOCATION_PREFIX}${encodeURIComponent(userId)}`;
}

function safeId(value: string | null | undefined, maxLength = 200) {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) return undefined;
  return value;
}

function safeVideoView(value: string | null | undefined): VideoStudioView {
  if (value === 'prompts') return 'prompts';
  if (value === 'results' || value === 'run') return 'results';
  return 'templates';
}

function readRememberedLocation(userId: string): RememberedStudioLocation | null {
  try {
    const raw = window.localStorage.getItem(rememberedLocationKey(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || (record.type !== 'image' && record.type !== 'video')) return null;

    if (record.type === 'image') {
      const moduleId = safeId(typeof record.moduleId === 'string' ? record.moduleId : null, 100);
      return { version: 1, type: 'image', ...(moduleId ? { moduleId } : {}) };
    }

    const draftId = safeId(typeof record.draftId === 'string' ? record.draftId : null)
      || safeId(typeof record.moduleId === 'string' ? record.moduleId : null);
    const runId = safeId(typeof record.runId === 'string' ? record.runId : null);
    const view = safeVideoView(typeof record.view === 'string' ? record.view : null);
    return {
      version: 1,
      type: 'video',
      view,
      ...(draftId ? { draftId, moduleId: draftId } : {}),
      ...(runId ? { runId } : {}),
    };
  } catch {
    return null;
  }
}

function locationFromQuery(params: URLSearchParams, type: StudioType): RememberedStudioLocation {
  if (type === 'image') {
    const moduleId = safeId(params.get('moduleId'), 100);
    return { version: 1, type, ...(moduleId ? { moduleId } : {}) };
  }

  const draftId = safeId(params.get('draftId')) || safeId(params.get('moduleId'));
  const runId = safeId(params.get('runId'));
  return {
    version: 1,
    type,
    view: safeVideoView(params.get('view')),
    ...(draftId ? { draftId, moduleId: draftId } : {}),
    ...(runId ? { runId } : {}),
  };
}

function writeRememberedLocation(userId: string, location: RememberedStudioLocation) {
  try {
    window.localStorage.setItem(rememberedLocationKey(userId), JSON.stringify(location));
    return true;
  } catch {
    return false;
  }
}

function locationHref(location: RememberedStudioLocation) {
  const params = new URLSearchParams();
  params.set('type', location.type);
  if (location.type === 'image') {
    if (location.moduleId) params.set('moduleId', location.moduleId);
  } else {
    params.set('view', location.view || 'templates');
    if (location.draftId) {
      params.set('draftId', location.draftId);
      params.set('moduleId', location.draftId);
    }
    if (location.runId) params.set('runId', location.runId);
  }
  return `/template-studio?${params.toString()}`;
}

export default function TemplateStudioShell({
  userId,
  isAdmin,
  allowedTypes,
  initialType,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, hasLoadedUser } = useAppSession();
  const requestedType = searchParams.get('type');
  const activeType = (requestedType === 'image' || requestedType === 'video')
    && allowedTypes.includes(requestedType)
    ? requestedType
    : initialType;
  const queryString = searchParams.toString();
  const query = useMemo(() => new URLSearchParams(queryString), [queryString]);
  const permissionMismatch = (requestedType === 'image' || requestedType === 'video')
    && !allowedTypes.includes(requestedType);
  const userChanged = hasLoadedUser && (!user || user.id !== userId);
  const restoreAttemptedFor = useRef<string | null>(null);
  const userInteracted = useRef(false);
  const [restoreReady, setRestoreReady] = useState(false);
  const [hasRememberedLocation, setHasRememberedLocation] = useState(false);

  useEffect(() => {
    if (permissionMismatch) {
      const safeDefault = new URLSearchParams();
      safeDefault.set('type', initialType);
      router.replace(`/template-studio?${safeDefault.toString()}`, { scroll: false });
      return;
    }

    if (queryString) {
      setRestoreReady(true);
      if (!hasLoadedUser || !user || user.id !== userId) return;
      const type = requestedType === 'image' || requestedType === 'video' ? requestedType : activeType;
      if (!allowedTypes.includes(type)) return;
      const stored = locationFromQuery(query, type);
      setHasRememberedLocation(writeRememberedLocation(userId, stored));
      return;
    }

    if (!hasLoadedUser) return;
    if (!user || user.id !== userId) {
      setRestoreReady(true);
      return;
    }
    if (restoreAttemptedFor.current === userId) {
      setRestoreReady(true);
      return;
    }
    restoreAttemptedFor.current = userId;

    let remembered: RememberedStudioLocation | null = null;
    try {
      remembered = readRememberedLocation(userId);
    } catch {
      remembered = null;
    }

    if (!remembered) {
      setHasRememberedLocation(false);
      setRestoreReady(true);
      return;
    }
    if (!allowedTypes.includes(remembered.type)) {
      try { window.localStorage.removeItem(rememberedLocationKey(userId)); } catch { /* Storage is optional. */ }
      setHasRememberedLocation(false);
      setRestoreReady(true);
      return;
    }

    setHasRememberedLocation(true);
    if (!userInteracted.current) router.replace(locationHref(remembered), { scroll: false });
    setRestoreReady(true);
  }, [
    activeType,
    allowedTypes,
    hasLoadedUser,
    initialType,
    permissionMismatch,
    query,
    queryString,
    requestedType,
    router,
    user,
    userId,
  ]);

  function changeType(type: StudioType) {
    if (!allowedTypes.includes(type)) return;
    const next = new URLSearchParams(query);
    for (const key of ['view', 'moduleId', 'draftId', 'runId', 'presetId', 'templateId', 'templateSource', 'status']) {
      next.delete(key);
    }
    next.set('type', type);
    router.replace(`/template-studio?${next.toString()}`, { scroll: false });
  }

  function clearRememberedLocation() {
    try { window.localStorage.removeItem(rememberedLocationKey(userId)); } catch { /* Storage is optional. */ }
    restoreAttemptedFor.current = userId;
    setHasRememberedLocation(false);
    router.replace('/template-studio', { scroll: false });
  }

  if (userChanged) {
    const next = `/template-studio?${new URLSearchParams(searchParams.toString()).toString()}`;
    return (
      <main className={styles.sessionGate}>
        <h1>登录状态已变化</h1>
        <p>当前页面已停止读取旧账号的数据。重新登录后可继续自己的工作。</p>
        <a href={`/login?next=${encodeURIComponent(next)}`}>重新登录</a>
      </main>
    );
  }

  if (permissionMismatch || (!restoreReady && !queryString)) {
    return (
      <section className={styles.workbench} aria-label="模板工作台" aria-busy="true">
        <header className={styles.header}>
          <div className={styles.headerTitle}>
            <span className={styles.kicker}>创作</span>
            <h1>模板工作台</h1>
          </div>
        </header>
      </section>
    );
  }

  return (
    <section
      className={styles.workbench}
      aria-label="模板工作台"
      onPointerDownCapture={() => { userInteracted.current = true; }}
      onKeyDownCapture={() => { userInteracted.current = true; }}
    >
      <header className={`${styles.header} ${activeType === 'image' ? styles.imageHeader : ''}`}>
        <div className={styles.headerTitle}>
          <span className={styles.kicker}>创作</span>
          <h1>模板工作台</h1>
        </div>
        <div className={styles.headerActions}>
          {activeType === 'image' && <StudioBatchHistory key={userId} userId={userId} />}
          <Link className={styles.quietButton} href="/assets?view=favorites&category=template"><Bookmark size={16} />我的收藏</Link>
          {hasRememberedLocation && (
            <button
              className={styles.quietButton}
              type="button"
              aria-label="清除上次位置"
              title="清除上次位置"
              onClick={clearRememberedLocation}
            >
              <RotateCcw size={16} />
            </button>
          )}
          <nav className={styles.categoryTabs} aria-label="内容类型" role="tablist">
            {allowedTypes.map((type) => (
              <button
                key={type}
                className={activeType === type ? styles.activeCategory : ''}
                type="button"
                role="tab"
                aria-selected={activeType === type}
                onClick={() => changeType(type)}
              >
                {type === 'image' ? '图片' : '视频'}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {activeType === 'image' ? (
        <div className={styles.imageSurface} role="tabpanel">
          <ImageStudio isAdmin={isAdmin} userId={userId} templateWorkbench />
        </div>
      ) : (
        <div role="tabpanel">
          <VideoTemplateWorkbench key={`${userId}:video`} userId={userId} />
        </div>
      )}
    </section>
  );
}
