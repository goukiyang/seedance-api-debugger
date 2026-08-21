/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, FolderInput, RefreshCcw, Search, X } from 'lucide-react';
import {
  BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT,
  downloadBulkVideoZip,
} from '@/lib/video/download-client';

type AssetScope = 'history' | 'project' | 'user';
type AssetType = 'all' | 'video' | 'image' | 'reference';
type AssetStatus = 'all' | 'succeeded' | 'running' | 'submitted' | 'failed' | 'cancelled' | 'hidden';
type AssetSort = 'created_desc' | 'created_asc' | 'completed_desc' | 'project' | 'user' | 'duration';
type AssetGroup = 'date' | 'project' | 'user';
type AssetLibraryItemId = `video_task:${string}` | `asset:${string}` | `reference_image:${string}`;

type SessionUser = {
  id: string;
  role: 'admin' | 'user';
  name?: string | null;
  username?: string | null;
  email?: string | null;
};

type ProjectItem = {
  id: string;
  name: string;
  type: string;
  status: string;
  can_manage_project?: boolean;
  can_manage_assets?: boolean;
};

type UserItem = {
  id: string;
  name: string;
  username: string;
  email: string;
  status: string;
};

type VideoCardItem = {
  id: string;
  title: string;
  status: string;
  project_id: string;
};

type AssetLibraryItem = {
  id: AssetLibraryItemId;
  kind: 'video' | 'image';
  source: 'video_task' | 'asset' | 'reference_image';
  taskId: string | null;
  assetId: string | null;
  referenceImageId: string | null;
  title: string;
  prompt: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  duration: number | null;
  ratio: string | null;
  resolution: string | null;
  status: string;
  retentionStatus: string | null;
  createdAt: string;
  completedAt: string | null;
  project: { id: string; name: string; type?: string | null; status?: string | null } | null;
  owner: { id: string; displayName: string; subtitle: string } | null;
  downloadable: boolean;
  movable: boolean;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_more: boolean;
};

type MarqueeState = {
  active: boolean;
  append: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  previewIds: AssetLibraryItemId[];
};

const scopeTabs: Array<{ id: AssetScope; label: string; adminOnly?: boolean }> = [
  { id: 'history', label: '生产历史' },
  { id: 'project', label: '按项目' },
  { id: 'user', label: '按用户查看', adminOnly: true },
];

const typeTabs: Array<{ id: AssetType; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'video', label: '视频' },
  { id: 'image', label: '图片' },
  { id: 'reference', label: '参考素材' },
];

const statusOptions: Array<{ id: AssetStatus; label: string; adminOnly?: boolean }> = [
  { id: 'all', label: '全部状态' },
  { id: 'succeeded', label: '已完成' },
  { id: 'running', label: '生成中' },
  { id: 'submitted', label: '排队中' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
  { id: 'hidden', label: '已隐藏/已删除', adminOnly: true },
];

const sortOptions: Array<{ id: AssetSort; label: string; adminOnly?: boolean }> = [
  { id: 'created_desc', label: '最近生成' },
  { id: 'created_asc', label: '最早生成' },
  { id: 'completed_desc', label: '最近完成' },
  { id: 'project', label: '项目名称' },
  { id: 'user', label: '用户名称', adminOnly: true },
  { id: 'duration', label: '时长' },
];

const groupOptions: Array<{ id: AssetGroup; label: string; adminOnly?: boolean }> = [
  { id: 'date', label: '按时间' },
  { id: 'project', label: '按项目' },
  { id: 'user', label: '按用户', adminOnly: true },
];

function isAssetType(value: string | null): value is AssetType {
  return value === 'all' || value === 'video' || value === 'image' || value === 'reference';
}

function statusLabel(status: string) {
  if (status === 'succeeded') return '已完成';
  if (status === 'running') return '生成中';
  if (status === 'submitted') return '排队中';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'active') return '可用';
  if (status === 'hidden') return '已隐藏';
  if (status === 'deleted') return '已删除';
  return status || '未知';
}

function formatDuration(seconds: number | null) {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatDateTime(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dateGroupLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function itemGroupLabel(item: AssetLibraryItem, groupBy: AssetGroup) {
  if (groupBy === 'project') return item.project?.name || '未归属项目';
  if (groupBy === 'user') return item.owner?.displayName || '未知用户';
  return dateGroupLabel(item.createdAt);
}

function itemGroupKey(item: AssetLibraryItem, groupBy: AssetGroup) {
  if (groupBy === 'project') return item.project?.id || 'unassigned';
  if (groupBy === 'user') return item.owner?.id || 'unknown';
  const date = new Date(item.createdAt);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function shortText(value: string | null | undefined, fallback = '未命名资产', length = 80) {
  const text = value?.trim() || fallback;
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function intersects(a: DOMRect, b: DOMRect) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    left,
    top,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function AssetsPageContent() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [scope, setScope] = useState<AssetScope>('history');
  const [type, setType] = useState<AssetType>('video');
  const [status, setStatus] = useState<AssetStatus>('all');
  const [sort, setSort] = useState<AssetSort>('created_desc');
  const [groupBy, setGroupBy] = useState<AssetGroup>('date');
  const [projectId, setProjectId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AssetLibraryItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<AssetLibraryItemId[]>([]);
  const [anchorId, setAnchorId] = useState<AssetLibraryItemId | null>(null);
  const [activeItem, setActiveItem] = useState<AssetLibraryItem | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [movePanelOpen, setMovePanelOpen] = useState(false);
  const [moveProjectId, setMoveProjectId] = useState('');
  const [moveVideoCardId, setMoveVideoCardId] = useState('');
  const [videoCards, setVideoCards] = useState<VideoCardItem[]>([]);
  const [moving, setMoving] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const cardRefs = useRef(new Map<AssetLibraryItemId, HTMLButtonElement>());
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAdmin = user?.role === 'admin';
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const previewSet = useMemo(() => new Set(marquee?.previewIds || []), [marquee?.previewIds]);
  const selectedItems = useMemo(
    () => items.filter((item) => selectedSet.has(item.id)),
    [items, selectedSet],
  );
  const downloadableTaskIds = selectedItems
    .filter((item) => item.source === 'video_task' && item.taskId && item.downloadable)
    .map((item) => item.taskId as string);
  const movableItemIds = selectedItems.filter((item) => item.movable).map((item) => item.id);
  const manageableProjects = projects.filter((project) => project.can_manage_project);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; items: AssetLibraryItem[] }>();
    items.forEach((item) => {
      const key = itemGroupKey(item, groupBy);
      const label = itemGroupLabel(item, groupBy);
      const current = groups.get(key);
      if (current) current.items.push(item);
      else groups.set(key, { key, label, items: [item] });
    });
    return Array.from(groups.values());
  }, [items, groupBy]);

  const clearSelection = () => {
    setSelectedIds([]);
    setAnchorId(null);
    setMovePanelOpen(false);
  };

  const resetForFilterChange = () => {
    setPage(1);
    setActiveItem(null);
    clearSelection();
  };

  useEffect(() => {
    let cancelled = false;
    const requestedType = new URLSearchParams(window.location.search).get('type');
    if (isAssetType(requestedType)) setType(requestedType);

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          if (!data.user) {
            window.location.href = '/login';
            return;
          }
          setUser(data.user);
        }
      })
      .catch(() => {
        if (!cancelled) setError('登录状态加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const projectUrl = user.role === 'admin'
      ? '/api/projects?include_archived=true&include_all=true'
      : '/api/projects?include_archived=true';
    fetch(projectUrl, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setProjects(data.projects || []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });

    if (user.role === 'admin') {
      fetch('/api/admin/users', { cache: 'no-store' })
        .then((response) => response.ok ? response.json() : null)
        .then((data) => {
          if (!cancelled && data) setUsers(data.users || []);
        })
        .catch(() => {
          if (!cancelled) setUsers([]);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      scope,
      type,
      status,
      sort,
      group_by: groupBy,
      page: String(page),
      limit: '60',
    });
    if (scope === 'project' && projectId) params.set('project_id', projectId);
    if (scope === 'user' && ownerUserId) params.set('owner_user_id', ownerUserId);
    if (keyword.trim()) params.set('keyword', keyword.trim());

    fetch(`/api/assets/library?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || '资产加载失败');
        return data;
      })
      .then((data) => {
        if (!cancelled) {
          setItems(data.items || []);
          setPagination(data.pagination || null);
          setSelectedIds((current) => current.filter((id) => (data.items || []).some((item: AssetLibraryItem) => item.id === id)));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setItems([]);
          setPagination(null);
          setError(err instanceof Error ? err.message : '资产加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, scope, type, status, sort, groupBy, projectId, ownerUserId, keyword, page, reloadToken]);

  useEffect(() => {
    if (!moveProjectId) {
      setVideoCards([]);
      setMoveVideoCardId('');
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${moveProjectId}/video-cards`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled) {
          const cards = (data?.video_cards || []).filter((card: VideoCardItem) => card.status !== 'sealed' && card.status !== 'archived');
          setVideoCards(cards);
          setMoveVideoCardId(cards[0]?.id || '');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVideoCards([]);
          setMoveVideoCardId('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [moveProjectId]);

  const setCardRef = (id: AssetLibraryItemId) => (node: HTMLButtonElement | null) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  };

  const setSelection = (ids: AssetLibraryItemId[], nextAnchor?: AssetLibraryItemId | null) => {
    setSelectedIds(Array.from(new Set(ids)));
    if (nextAnchor !== undefined) setAnchorId(nextAnchor);
  };

  const toggleItem = (id: AssetLibraryItemId) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
    setAnchorId(id);
  };

  const selectRange = (id: AssetLibraryItemId) => {
    const flatIds = items.map((item) => item.id);
    const currentIndex = flatIds.indexOf(id);
    const anchorIndex = anchorId ? flatIds.indexOf(anchorId) : -1;
    if (currentIndex < 0 || anchorIndex < 0) {
      setSelection([id], id);
      return;
    }
    const start = Math.min(anchorIndex, currentIndex);
    const end = Math.max(anchorIndex, currentIndex);
    setSelection(Array.from(new Set([...selectedIds, ...flatIds.slice(start, end + 1)])), anchorId);
  };

  const handleCardClick = (event: React.MouseEvent, item: AssetLibraryItem) => {
    if (event.shiftKey) {
      selectRange(item.id);
      return;
    }
    if (event.metaKey || event.ctrlKey || selectedIds.length > 0) {
      toggleItem(item.id);
      return;
    }
    setActiveItem(item);
  };

  const beginTouchSelect = (item: AssetLibraryItem) => {
    if (selectedIds.length > 0) return;
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(() => {
      setSelection([item.id], item.id);
    }, 420);
  };

  const clearTouchTimer = () => {
    if (touchTimer.current) {
      clearTimeout(touchTimer.current);
      touchTimer.current = null;
    }
  };

  const detectMarqueeIds = (startX: number, startY: number, currentX: number, currentY: number) => {
    const selectionRect = new DOMRect(
      Math.min(startX, currentX),
      Math.min(startY, currentY),
      Math.abs(currentX - startX),
      Math.abs(currentY - startY),
    );
    if (selectionRect.width < 4 && selectionRect.height < 4) return [];
    return items
      .filter((item) => {
        const node = cardRefs.current.get(item.id);
        return node ? intersects(selectionRect, node.getBoundingClientRect()) : false;
      })
      .map((item) => item.id);
  };

  const handleGridPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-asset-card],button,a,input,select,textarea')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee({
      active: true,
      append: event.metaKey || event.ctrlKey,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      previewIds: [],
    });
  };

  const handleGridPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee?.active) return;
    const previewIds = detectMarqueeIds(marquee.startX, marquee.startY, event.clientX, event.clientY);
    setMarquee({ ...marquee, currentX: event.clientX, currentY: event.clientY, previewIds });
  };

  const handleGridPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee?.active) return;
    const previewIds = marquee.previewIds;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (previewIds.length > 0) {
      setSelection(marquee.append ? [...selectedIds, ...previewIds] : previewIds, previewIds[previewIds.length - 1]);
    } else if (!marquee.append && Math.abs(marquee.currentX - marquee.startX) + Math.abs(marquee.currentY - marquee.startY) > 8) {
      clearSelection();
    }
    setMarquee(null);
  };

  const downloadTaskIds = async (taskIds: string[]) => {
    if (taskIds.length === 0) {
      setError('当前选择里没有可下载的视频');
      return;
    }
    if (taskIds.length > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT) {
      setError(`第一版最多一次打包 ${BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT} 个视频`);
      return;
    }
    setBulkDownloading(true);
    setError('');
    setMessage('');
    try {
      const result = await downloadBulkVideoZip({ taskIds });
      setMessage(`已开始下载视频包：${result.success} 个成功${result.failed ? `，${result.failed} 个失败见 manifest` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量下载失败');
    } finally {
      setBulkDownloading(false);
    }
  };

  const handleDownload = async () => {
    await downloadTaskIds(downloadableTaskIds);
  };

  const handleBulkMove = async () => {
    if (movableItemIds.length === 0) {
      setError('当前选择里没有可移动的视频任务');
      return;
    }
    if (!moveProjectId || !moveVideoCardId) {
      setError('请选择目标项目和视频卡');
      return;
    }
    setMoving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/assets/library/bulk-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_ids: movableItemIds,
          target_project_id: moveProjectId,
          target_video_card_id: moveVideoCardId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '批量移动失败');
      setMessage(`批量移动完成：移动 ${data.moved || 0} 个，跳过 ${data.unchanged || 0} 个，失败 ${data.failed || 0} 个`);
      clearSelection();
      setPage(1);
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量移动失败');
    } finally {
      setMoving(false);
    }
  };

  const reloadItems = () => {
    setReloadToken((value) => value + 1);
  };

  const marqueeRect = marquee
    ? rectFromPoints({ x: marquee.startX, y: marquee.startY }, { x: marquee.currentX, y: marquee.currentY })
    : null;

  return (
    <div className="asset-library-page">
      <header className="asset-library-header">
        <div>
          <div className="asset-library-eyebrow">Asset Library</div>
          <h1>资产管理</h1>
          <p>按生产历史、项目和用户查看视频资产，支持框选、多选、批量下载和批量移动。</p>
        </div>
        <div className="asset-library-header-actions">
          <button className="asset-library-icon-button" type="button" onClick={reloadItems} aria-label="刷新资产">
            <RefreshCcw size={16} />
          </button>
          <Link className="asset-library-secondary-link" href="/tasks">任务列表</Link>
        </div>
      </header>

      <section className="asset-library-tabs" aria-label="资产分类">
        {scopeTabs.filter((tab) => !tab.adminOnly || isAdmin).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={scope === tab.id ? 'active' : ''}
            onClick={() => {
              setScope(tab.id);
              if (tab.id !== 'project') setProjectId('');
              if (tab.id !== 'user') setOwnerUserId('');
              resetForFilterChange();
            }}
          >
            {tab.label}
          </button>
        ))}
      </section>

      <section className="asset-library-filter-bar">
        <div className="asset-library-type-tabs">
          {typeTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={type === tab.id ? 'active' : ''}
              onClick={() => {
                setType(tab.id);
                resetForFilterChange();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form
          className="asset-library-search"
          onSubmit={(event) => {
            event.preventDefault();
            setKeyword(keywordDraft.trim());
            resetForFilterChange();
          }}
        >
          <Search size={15} />
          <input
            value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            placeholder="搜索 prompt、任务、项目或用户"
          />
        </form>

        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as AssetStatus);
            resetForFilterChange();
          }}
        >
          {statusOptions.filter((option) => !option.adminOnly || isAdmin).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        {scope === 'project' && (
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              resetForFilterChange();
            }}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        )}

        {scope === 'user' && isAdmin && (
          <select
            value={ownerUserId}
            onChange={(event) => {
              setOwnerUserId(event.target.value);
              resetForFilterChange();
            }}
          >
            <option value="">全部用户</option>
            {users.map((item) => (
              <option key={item.id} value={item.id}>{item.name || item.email || item.username}</option>
            ))}
          </select>
        )}

        <select
          value={groupBy}
          onChange={(event) => {
            setGroupBy(event.target.value as AssetGroup);
            clearSelection();
          }}
        >
          {groupOptions.filter((option) => !option.adminOnly || isAdmin).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as AssetSort);
            resetForFilterChange();
          }}
        >
          {sortOptions.filter((option) => !option.adminOnly || isAdmin).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </section>

      {(message || error) && (
        <div className={`asset-library-notice ${error ? 'error' : 'success'}`}>
          <span>{error || message}</span>
          <button type="button" onClick={() => { setError(''); setMessage(''); }} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}

      {selectedIds.length > 0 && (
        <section className="asset-library-bulkbar">
          <div>
            <strong>已选 {selectedIds.length} 个</strong>
            <span>
              可下载 {downloadableTaskIds.length} 个，涉及项目 {new Set(selectedItems.map((item) => item.project?.id || 'unassigned')).size} 个
              {isAdmin ? `，涉及用户 ${new Set(selectedItems.map((item) => item.owner?.id || 'unknown')).size} 位` : ''}
            </span>
          </div>
          <div className="asset-library-bulkbar-actions">
            <button type="button" onClick={clearSelection}>取消选择</button>
            <button type="button" onClick={handleDownload} disabled={bulkDownloading || downloadableTaskIds.length === 0}>
              <Download size={15} />
              下载视频（{downloadableTaskIds.length}/{selectedIds.length}）
            </button>
            <button type="button" onClick={() => setMovePanelOpen((value) => !value)} disabled={movableItemIds.length === 0}>
              <FolderInput size={15} />
              移动到项目
            </button>
          </div>
        </section>
      )}

      {movePanelOpen && selectedIds.length > 0 && (
        <section className="asset-library-move-panel">
          <div>
            <strong>移动视频任务</strong>
            <span>需要选择目标项目和该项目下的视频卡。</span>
          </div>
          <select value={moveProjectId} onChange={(event) => setMoveProjectId(event.target.value)}>
            <option value="">选择目标项目</option>
            {manageableProjects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <select value={moveVideoCardId} onChange={(event) => setMoveVideoCardId(event.target.value)} disabled={!moveProjectId || videoCards.length === 0}>
            <option value="">选择目标视频卡</option>
            {videoCards.map((card) => (
              <option key={card.id} value={card.id}>{card.title}</option>
            ))}
          </select>
          <button type="button" onClick={handleBulkMove} disabled={moving || !moveProjectId || !moveVideoCardId}>
            {moving ? '移动中...' : '确认移动'}
          </button>
        </section>
      )}

      <main
        className="asset-library-content"
        onPointerDown={handleGridPointerDown}
        onPointerMove={handleGridPointerMove}
        onPointerUp={handleGridPointerUp}
      >
        {loading && (
          <div className="asset-library-empty">
            <h2>正在加载资产</h2>
            <p>正在读取可见视频、项目和权限信息。</p>
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="asset-library-empty">
            <h2>暂无资产</h2>
            <p>调整筛选条件，或先到生成页创建视频。</p>
            <Link href="/generate">去生成视频</Link>
          </div>
        )}

        {!loading && groupedItems.map((group) => (
          <section key={group.key} className="asset-library-group">
            <h2>{group.label}</h2>
            <div className="asset-library-grid">
              {group.items.map((item) => {
                const selected = selectedSet.has(item.id);
                const previewed = previewSet.has(item.id);
                const duration = formatDuration(item.duration);
                return (
                  <button
                    key={item.id}
                    ref={setCardRef(item.id)}
                    type="button"
                    data-asset-card="true"
                    className={`asset-card ${selected ? 'selected' : ''} ${previewed ? 'preview-selected' : ''}`}
                    onClick={(event) => handleCardClick(event, item)}
                    onPointerDown={(event) => {
                      if (event.pointerType === 'touch') beginTouchSelect(item);
                    }}
                    onPointerUp={clearTouchTimer}
                    onPointerCancel={clearTouchTimer}
                  >
                    <span
                      className="asset-card-check"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleItem(item.id);
                      }}
                    >
                      {selected ? '✓' : ''}
                    </span>
                    <span className="asset-card-media">
                      {item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} alt={item.title} loading="lazy" />
                      ) : (
                        <span className="asset-card-empty">{statusLabel(item.status)}</span>
                      )}
                      {duration && <span className="asset-card-duration">{duration}</span>}
                      <span className="asset-card-hover">
                        <Eye size={16} />
                        查看
                      </span>
                    </span>
                    <span className="asset-card-meta">
                      <strong>{shortText(item.title, '未命名资产', 34)}</strong>
                      <span>{item.project?.name || '未归属项目'} · {formatDateTime(item.createdAt)}</span>
                      {isAdmin && item.owner && <span>{item.owner.displayName}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {pagination && pagination.total_pages > 1 && (
          <div className="asset-library-pagination">
            <span>第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 个资产</span>
            <div>
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                上一页
              </button>
              <button type="button" disabled={!pagination.has_more} onClick={() => setPage((value) => value + 1)}>
                下一页
              </button>
            </div>
          </div>
        )}
      </main>

      {marqueeRect && (
        <div
          className="asset-library-marquee"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}

      {activeItem && (
        <aside className="asset-detail-drawer" aria-label="资产详情">
          <div className="asset-detail-header">
            <div>
              <span>{activeItem.kind === 'video' ? '视频资产' : '图片资产'}</span>
              <h2>{shortText(activeItem.title, '资产详情', 42)}</h2>
            </div>
            <button type="button" onClick={() => setActiveItem(null)} aria-label="关闭详情">
              <X size={18} />
            </button>
          </div>
          <div className="asset-detail-preview">
            {activeItem.kind === 'video' && activeItem.previewUrl ? (
              <video src={activeItem.previewUrl} controls poster={activeItem.thumbnailUrl || undefined} />
            ) : activeItem.thumbnailUrl ? (
              <img src={activeItem.thumbnailUrl} alt={activeItem.title} />
            ) : (
              <div>{statusLabel(activeItem.status)}</div>
            )}
          </div>
          <dl className="asset-detail-list">
            <div>
              <dt>状态</dt>
              <dd>{statusLabel(activeItem.status)}</dd>
            </div>
            <div>
              <dt>项目</dt>
              <dd>{activeItem.project?.name || '未归属项目'}</dd>
            </div>
            {isAdmin && (
              <div>
                <dt>用户</dt>
                <dd>{activeItem.owner?.displayName || '未知用户'}</dd>
              </div>
            )}
            <div>
              <dt>规格</dt>
              <dd>{[activeItem.resolution, activeItem.duration ? `${activeItem.duration}s` : null, activeItem.ratio].filter(Boolean).join(' · ') || '-'}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatDateTime(activeItem.createdAt)}</dd>
            </div>
            <div>
              <dt>完成时间</dt>
              <dd>{formatDateTime(activeItem.completedAt)}</dd>
            </div>
          </dl>
          {activeItem.prompt && (
            <div className="asset-detail-prompt">
              <span>Prompt</span>
              <p>{activeItem.prompt}</p>
            </div>
          )}
          <div className="asset-detail-actions">
            {activeItem.taskId && (
              <Link href={`/tasks/${activeItem.taskId}`}>打开任务详情</Link>
            )}
            {activeItem.downloadable && (
              <button type="button" onClick={() => {
                if (activeItem.taskId) void downloadTaskIds([activeItem.taskId]);
              }}>
                下载视频
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

export default function AssetsPage() {
  return (
    <Suspense fallback={<div className="asset-library-page" aria-busy="true">资产管理加载中...</div>}>
      <AssetsPageContent />
    </Suspense>
  );
}
