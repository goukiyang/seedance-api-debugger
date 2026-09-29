'use client';

import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ImageStudio from '@/app/image-studio/studio';
import { useAppSession } from '@/lib/context/AppSessionContext';
import VideoTemplateWorkbench from './VideoTemplateWorkbench';
import styles from './template-studio.module.css';

type StudioType = 'image' | 'video';

type Props = {
  userId: string;
  isAdmin: boolean;
  allowedTypes: StudioType[];
  initialType: StudioType;
};

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
  const userChanged = hasLoadedUser && (!user || user.id !== userId);
  const query = useMemo(() => new URLSearchParams(searchParams.toString()), [searchParams]);

  function changeType(type: StudioType) {
    if (!allowedTypes.includes(type)) return;
    const next = new URLSearchParams(query);
    next.set('type', type);
    router.replace(`/template-studio?${next.toString()}`, { scroll: false });
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

  return (
    <section className={styles.workbench} aria-label="模板工作台">
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.kicker}>创作</span>
          <h1>模板工作台</h1>
        </div>
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
      </header>

      {activeType === 'image' ? (
        <div className={styles.imageSurface} role="tabpanel">
          <ImageStudio isAdmin={isAdmin} userId={userId} />
        </div>
      ) : (
        <div role="tabpanel">
          <VideoTemplateWorkbench key={`${userId}:video`} userId={userId} />
        </div>
      )}
    </section>
  );
}
