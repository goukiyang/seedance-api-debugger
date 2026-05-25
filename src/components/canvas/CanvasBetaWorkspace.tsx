'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AccountMenu, { type AccountMenuUser } from '@/components/AccountMenu';
import {
  createBlankCanvasDocument,
  normalizeCanvasDocumentInput,
  summarizeCanvasDocument,
} from '@/lib/canvas/document';
import styles from './CanvasBetaWorkspace.module.css';

interface CreditSummary {
  balance: number;
  frozen_credits: number;
  available: number;
  monthly_used: number;
}

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  owner_user_id: string;
  my_role: string | null;
  can_generate?: boolean;
  owner?: { name: string | null; username: string | null };
}

interface CanvasSummary {
  id: string;
  title: string;
  status: string;
  project_id: string | null;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  node_count: number;
  edge_count: number;
  generation_count: number;
  project: {
    id: string;
    name: string;
    type: string;
    status: string;
    owner_user_id: string;
  } | null;
  owner: {
    id: string;
    name: string | null;
    username: string | null;
    email: string | null;
  };
}

interface CanvasDetail extends CanvasSummary {
  active_generation_node_id: string | null;
  document: unknown;
}

interface AuthMeResponse {
  user: AccountMenuUser | null;
}

const PROJECT_STORAGE_KEY = 'canvas_beta_project_id';
const CANVAS_STORAGE_KEY = 'canvas_beta_id';

function projectOwnerName(project: ProjectOption) {
  const name = project.owner?.name?.trim();
  const username = project.owner?.username?.trim();
  if (name && username && name !== username) return `${name}（${username}）`;
  return name || username || project.owner_user_id;
}

function projectDisplayName(project: ProjectOption) {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function projectDisplayLabel(project: ProjectOption, duplicateNames: Record<string, number>) {
  const name = projectDisplayName(project);
  return duplicateNames[name] > 1 ? `${name} · ${projectOwnerName(project)}` : name;
}

function formatTime(dateStr: string) {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatCredit(value: number | undefined) {
  return Math.max(0, Math.floor(value || 0)).toString();
}

function blankEditorValue(title = '未命名画布') {
  return JSON.stringify(createBlankCanvasDocument(title), null, 2);
}

export default function CanvasBetaWorkspace() {
  const [currentUser, setCurrentUser] = useState<AccountMenuUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [credits, setCredits] = useState<CreditSummary | null>(null);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');

  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [currentCanvasId, setCurrentCanvasId] = useState('');
  const [canvasTitle, setCanvasTitle] = useState('未命名画布');
  const [editorValue, setEditorValue] = useState(blankEditorValue());
  const [statusText, setStatusText] = useState('画布尚未保存');
  const [errorText, setErrorText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: AuthMeResponse) => {
        if (!cancelled) setCurrentUser(data.user || null);
      })
      .catch(() => {
        if (!cancelled) setCurrentUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingUser(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetch('/api/me/credits')
      .then((response) => {
        if (response.status === 401) {
          window.location.href = '/login?next=/generate/canvas';
          return null;
        }
        return response.json();
      })
      .then((payload) => {
        if (payload) setCredits(payload);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/projects')
      .then((response) => {
        if (response.status === 401) {
          window.location.href = '/login?next=/generate/canvas';
          return null;
        }
        return response.json();
      })
      .then((payload) => {
        if (!payload) return;
        const availableProjects: ProjectOption[] = (payload.projects || []).filter(
          (project: ProjectOption) => project.can_generate !== false,
        );
        setProjects(availableProjects);

        const queryProjectId = new URLSearchParams(window.location.search).get('project_id');
        const rememberedProjectId = window.localStorage.getItem(PROJECT_STORAGE_KEY);
        const preferredProjectId = queryProjectId || rememberedProjectId || '';
        const preferredProject = availableProjects.find((project) => project.id === preferredProjectId);
        const personalProject = availableProjects.find((project) => project.type === 'personal');
        const nextProjectId = (preferredProject || personalProject || availableProjects[0])?.id || '';
        setSelectedProjectId(nextProjectId);
      })
      .catch(() => {});
  }, []);

  const refreshCanvasList = useCallback(async (preferredCanvasId?: string) => {
    setLoadingList(true);
    try {
      const response = await fetch('/api/canvases', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || payload.message || '画布列表加载失败');
      }

      const nextCanvases: CanvasSummary[] = payload.canvases || [];
      setCanvases(nextCanvases);

      setCurrentCanvasId((currentId) => {
        const rememberedCanvasId = preferredCanvasId || currentId || window.localStorage.getItem(CANVAS_STORAGE_KEY) || '';
        if (rememberedCanvasId && nextCanvases.some((canvas) => canvas.id === rememberedCanvasId)) {
          return rememberedCanvasId;
        }
        return nextCanvases[0]?.id || '';
      });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '画布列表加载失败');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void refreshCanvasList();
  }, [refreshCanvasList]);

  useEffect(() => {
    if (!selectedProjectId) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!currentCanvasId) {
      window.localStorage.removeItem(CANVAS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CANVAS_STORAGE_KEY, currentCanvasId);
  }, [currentCanvasId]);

  const duplicateProjectNames = useMemo(
    () =>
      projects.reduce<Record<string, number>>((counts, project) => {
        const name = projectDisplayName(project);
        counts[name] = (counts[name] || 0) + 1;
        return counts;
      }, {}),
    [projects],
  );

  const visibleCanvases = useMemo(() => {
    if (!selectedProjectId) return canvases;
    return canvases.filter((canvas) => canvas.project_id === selectedProjectId);
  }, [canvases, selectedProjectId]);

  const currentSummary = useMemo(
    () => canvases.find((canvas) => canvas.id === currentCanvasId) || null,
    [canvases, currentCanvasId],
  );

  const resetToBlank = useCallback(() => {
    setCurrentCanvasId('');
    setCanvasTitle('未命名画布');
    setEditorValue(blankEditorValue());
    setStatusText('已切到新的空白画布');
    setErrorText('');
  }, []);

  useEffect(() => {
    if (!selectedProjectId || loadingList) return;
    if (currentSummary?.project_id === selectedProjectId) return;
    if (visibleCanvases[0]) {
      setCurrentCanvasId(visibleCanvases[0].id);
      return;
    }
    resetToBlank();
  }, [currentSummary?.project_id, loadingList, resetToBlank, selectedProjectId, visibleCanvases]);

  const parsedEditorState = useMemo(() => {
    try {
      const parsed = normalizeCanvasDocumentInput(JSON.parse(editorValue), canvasTitle || '未命名画布');
      const summary = summarizeCanvasDocument(parsed);
      return { ok: true as const, document: parsed, summary };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'JSON 解析失败',
      };
    }
  }, [canvasTitle, editorValue]);

  const handleLoadCanvas = useCallback(async (canvasId: string) => {
    if (!canvasId) {
      setCurrentCanvasId('');
      setCanvasTitle('未命名画布');
      setEditorValue(blankEditorValue());
      setStatusText('已切到空白画布');
      setErrorText('');
      return;
    }

    setLoadingDetail(true);
    setErrorText('');

    try {
      const response = await fetch(`/api/canvases/${canvasId}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || payload.message || '画布读取失败');
      }

      const canvas: CanvasDetail = payload.canvas;
      setCurrentCanvasId(canvas.id);
      setCanvasTitle(canvas.title);
      setSelectedProjectId(canvas.project_id || selectedProjectId);
      setEditorValue(JSON.stringify(canvas.document, null, 2));
      setStatusText(`已加载 ${canvas.title} · ${formatTime(canvas.updated_at)}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '画布读取失败');
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!currentCanvasId || loadingList) return;
    if (currentSummary) return;
    if (visibleCanvases[0]) {
      setCurrentCanvasId(visibleCanvases[0].id);
    }
  }, [currentCanvasId, currentSummary, loadingList, visibleCanvases]);

  useEffect(() => {
    if (!currentCanvasId) return;
    void handleLoadCanvas(currentCanvasId);
  }, [currentCanvasId, handleLoadCanvas]);

  const handleSave = useCallback(async (forceCreate = false) => {
    if (!selectedProjectId) {
      setErrorText('请先选择项目，再保存画布');
      return;
    }

    if (!parsedEditorState.ok) {
      setErrorText(`画布 JSON 无法保存：${parsedEditorState.message}`);
      return;
    }

    setSaving(true);
    setErrorText('');

    const method = !currentCanvasId || forceCreate ? 'POST' : 'PUT';
    const url = method === 'POST' ? '/api/canvases' : `/api/canvases/${currentCanvasId}`;

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: canvasTitle,
          project_id: selectedProjectId,
          document: parsedEditorState.document,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || payload.message || '画布保存失败');
      }

      const canvas: CanvasDetail = payload.canvas;
      setCurrentCanvasId(canvas.id);
      setCanvasTitle(canvas.title);
      setEditorValue(JSON.stringify(canvas.document, null, 2));
      setStatusText(`已保存 ${canvas.title} · ${formatTime(canvas.updated_at)}`);
      await refreshCanvasList(canvas.id);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '画布保存失败');
    } finally {
      setSaving(false);
    }
  }, [canvasTitle, currentCanvasId, parsedEditorState, refreshCanvasList, selectedProjectId]);

  const handleDelete = useCallback(async () => {
    if (!currentCanvasId || deleting) return;
    if (!window.confirm('删除后会从列表中移除这个画布，继续吗？')) return;

    setDeleting(true);
    setErrorText('');

    try {
      const response = await fetch(`/api/canvases/${currentCanvasId}`, { method: 'DELETE' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || payload.message || '画布删除失败');
      }

      resetToBlank();
      await refreshCanvasList();
      setStatusText('当前画布已删除');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '画布删除失败');
    } finally {
      setDeleting(false);
    }
  }, [currentCanvasId, deleting, refreshCanvasList, resetToBlank]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const summaryCounts = parsedEditorState.ok ? parsedEditorState.summary : null;

  return (
    <div className="composer-page">
      <header className="composer-topbar">
        <div className="composer-topbar-left">
          <Link href="/" className="composer-topbar-logo">Seedance 2.0</Link>
          <nav className="composer-topbar-nav">
            <Link href="/generate" className="composer-topbar-nav-btn">标准生成</Link>
            <Link href="/generate/canvas" className="composer-topbar-nav-btn active">画布模式</Link>
            <Link href="/projects" className="composer-topbar-nav-btn">我的项目</Link>
            <Link href="/collections" className="composer-topbar-nav-btn">参考图集</Link>
            <Link href="/tasks" className="composer-topbar-nav-btn">我的任务</Link>
          </nav>
        </div>
        <div className="composer-topbar-right">
          {credits && (
            <div className="composer-topbar-nav-btn" title="当前点数">
              可用 {formatCredit(credits.available)} 点 ｜ 冻结 {formatCredit(credits.frozen_credits)} 点 ｜ 本月已用 {formatCredit(credits.monthly_used)} 点
            </div>
          )}
          <AccountMenu user={currentUser} loading={loadingUser} variant="composer" />
        </div>
      </header>

      <main className={styles.page}>
        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Canvas Beta</p>
            <h1>先把工作流保存成系统内资产</h1>
            <p className={styles.heroText}>
              这一版先打通项目归属、保存、加载和权限。你可以直接粘贴同事原型导出的 canvas JSON，
              后面我们再把可视化节点编辑器无缝接进来。
            </p>
            <div className={styles.heroActions}>
              <Link href="/generate" className={styles.heroActionPrimary}>
                返回标准生成
              </Link>
              <Link href="/projects" className={styles.heroActionSecondary}>
                查看我的项目
              </Link>
            </div>
          </div>
          <div className={styles.heroMeta}>
            <span>项目归属</span>
            <span>权限可控</span>
            <span>可接旧原型 JSON</span>
          </div>
        </section>

        <section className={styles.grid}>
          <aside className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>当前项目画布</h2>
                <p>{selectedProject ? projectDisplayLabel(selectedProject, duplicateProjectNames) : '先选择项目'}</p>
              </div>
              <button type="button" className={styles.subtleButton} onClick={() => void refreshCanvasList(currentCanvasId || undefined)}>
                刷新
              </button>
            </div>

            <label className={styles.field}>
              <span>写入项目</span>
              <select
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                className={styles.select}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectDisplayLabel(project, duplicateProjectNames)}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.canvasList}>
              {loadingList ? (
                <div className={styles.emptyState}>正在加载画布列表...</div>
              ) : visibleCanvases.length === 0 ? (
                <div className={styles.emptyState}>当前项目下还没有画布，先新建一个空白工作流。</div>
              ) : (
                visibleCanvases.map((canvas) => (
                  <button
                    key={canvas.id}
                    type="button"
                    className={`${styles.canvasCard} ${canvas.id === currentCanvasId ? styles.canvasCardActive : ''}`}
                    onClick={() => void handleLoadCanvas(canvas.id)}
                  >
                    <div className={styles.canvasCardTop}>
                      <strong>{canvas.title}</strong>
                      <span>{canvas.status === 'archived' ? '已归档' : '进行中'}</span>
                    </div>
                    <p>{canvas.node_count} 节点 · {canvas.edge_count} 连线 · {canvas.generation_count} 生成卡</p>
                    <p>{canvas.project?.name || '未归属项目'} · {formatTime(canvas.updated_at)}</p>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className={`${styles.panel} ${styles.editorPanel}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>画布文档</h2>
                <p>{currentCanvasId ? currentCanvasId : '新画布尚未保存'}</p>
              </div>
              <div className={styles.actionGroup}>
                <button type="button" className={styles.subtleButton} onClick={resetToBlank}>
                  新建空白
                </button>
                <button type="button" className={styles.subtleButton} onClick={() => void handleSave(true)} disabled={saving}>
                  另存为新
                </button>
                <button type="button" className={styles.primaryButton} onClick={() => void handleSave(false)} disabled={saving || !selectedProjectId}>
                  {saving ? '保存中...' : '保存当前'}
                </button>
              </div>
            </div>

            <label className={styles.field}>
              <span>画布标题</span>
              <input
                value={canvasTitle}
                onChange={(event) => setCanvasTitle(event.target.value)}
                className={styles.input}
                placeholder="给这套工作流起个名字"
              />
            </label>

            <label className={styles.field}>
              <span>画布 JSON</span>
              <textarea
                value={editorValue}
                onChange={(event) => setEditorValue(event.target.value)}
                className={styles.editor}
                spellCheck={false}
                placeholder="可直接粘贴 seedance-frontend-source 导出的 canvas JSON"
              />
            </label>

            <div className={styles.footerBar}>
              <div>
                <strong>{statusText}</strong>
                {errorText ? <p className={styles.errorText}>{errorText}</p> : null}
              </div>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => void handleDelete()}
                disabled={!currentCanvasId || deleting}
              >
                {deleting ? '删除中...' : '删除当前'}
              </button>
            </div>
          </section>

          <aside className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>结构摘要</h2>
                <p>保存前就能先看当前 JSON 是否合理</p>
              </div>
            </div>

            <div className={styles.summaryGrid}>
              <div className={styles.summaryItem}>
                <span>节点</span>
                <strong>{summaryCounts?.nodeCount ?? '--'}</strong>
              </div>
              <div className={styles.summaryItem}>
                <span>连线</span>
                <strong>{summaryCounts?.edgeCount ?? '--'}</strong>
              </div>
              <div className={styles.summaryItem}>
                <span>生成卡</span>
                <strong>{summaryCounts?.generationCount ?? '--'}</strong>
              </div>
              <div className={styles.summaryItem}>
                <span>当前状态</span>
                <strong>{loadingDetail ? '读取中' : currentSummary?.status || '草稿'}</strong>
              </div>
            </div>

            <div className={styles.infoBlock}>
              <h3>当前项目上下文</h3>
              <p>{selectedProject ? projectDisplayLabel(selectedProject, duplicateProjectNames) : '未选择项目'}</p>
              <p>这一版所有新建画布都会写进正式项目，后续任务、成本和资产关系都能沿着项目继续追。</p>
            </div>

            <div className={styles.infoBlock}>
              <h3>这次已经落地</h3>
              <ul className={styles.infoList}>
                <li>CanvasDocument 正式模型</li>
                <li>画布列表、详情、保存、软删除接口</li>
                <li>项目归属和权限校验</li>
                <li>兼容旧原型 JSON 的保存入口</li>
              </ul>
            </div>

            <div className={styles.infoBlock}>
              <h3>下一步接入</h3>
              <ul className={styles.infoList}>
                <li>把 React Flow 节点编辑器迁进来</li>
                <li>素材节点接现有图集和项目资产</li>
                <li>生成卡直接走 /api/tasks/create</li>
              </ul>
            </div>

            {!parsedEditorState.ok ? (
              <div className={styles.parseWarning}>
                当前 JSON 还不能保存：{parsedEditorState.message}
              </div>
            ) : null}
          </aside>
        </section>
      </main>
    </div>
  );
}
