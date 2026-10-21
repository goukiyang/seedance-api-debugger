'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Eye } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import ProjectActionConfirmModal from '@/components/ProjectActionConfirmModal';
import MediaPreview from '@/components/MediaPreview';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { RelativeTime } from '@/components/RelativeTime';
import PaginationControls from '@/components/PaginationControls';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { formatAmountMicrosWithFixedCny, formatAmountMinorWithFixedCny } from '@/lib/costs/currency';
import { showVideoCardManagementUi } from '@/lib/navigation';
import { sanitizeOptionalReturnTo, taskDetailHref } from '@/lib/navigation/return-to';
import { enhanceWorkspaceHref, taskReuseHref } from '@/lib/navigation/task-reuse';
import { useAppSession } from '@/lib/context/AppSessionContext';
import UsageWorkspace from '@/components/usage/UsageWorkspace';
import { projectStatusExpectation } from '@/lib/projects/client-operations';
import styles from '../Projects.module.css';

type ProjectSection = 'tasks' | 'albums' | 'finance' | 'members';
type ProjectViewState = {
  section: ProjectSection;
  taskPage: number;
  taskSearch: string;
  taskStatus: 'all' | 'running' | 'playable' | 'failed';
  taskSort: 'newest' | 'oldest';
  albumPage: number;
  financePage: number;
};

const DEFAULT_PROJECT_VIEW: ProjectViewState = {
  section: 'tasks', taskPage: 1, taskSearch: '', taskStatus: 'all', taskSort: 'newest', albumPage: 1, financePage: 1,
};

function readProjectViewParams(params: { get: (name: string) => string | null }): Partial<ProjectViewState> {
  const view = params.get('view');
  const status = params.get('task_status');
  const sort = params.get('task_sort');
  const page = (value: string | null) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100_000) : undefined;
  };
  const result: Partial<ProjectViewState> = {};
  if (view === 'albums' || view === 'finance' || view === 'members' || view === 'tasks') result.section = view;
  const taskPage = page(params.get('task_page'));
  const albumPage = page(params.get('album_page'));
  const financePage = page(params.get('finance_page'));
  if (taskPage) result.taskPage = taskPage;
  if (albumPage) result.albumPage = albumPage;
  if (financePage) result.financePage = financePage;
  if (params.get('task_q') !== null) result.taskSearch = (params.get('task_q') || '').slice(0, 120);
  if (status === 'running' || status === 'playable' || status === 'failed' || status === 'all') result.taskStatus = status;
  else if (status === 'succeeded' || status === 'cancelled') result.taskStatus = 'all';
  if (sort === 'oldest' || sort === 'newest') result.taskSort = sort;
  return result;
}

function normalizeStoredProjectView(value: unknown): Partial<ProjectViewState> {
  if (!value || typeof value !== 'object') return {};
  const stored = value as Record<string, unknown>;
  const page = (candidate: unknown) => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
    ? Math.min(candidate, 100_000) : undefined;
  const result: Partial<ProjectViewState> = {};
  if (stored.section === 'tasks' || stored.section === 'albums' || stored.section === 'finance' || stored.section === 'members') result.section = stored.section;
  const taskPage = page(stored.taskPage);
  const albumPage = page(stored.albumPage);
  const financePage = page(stored.financePage);
  if (taskPage) result.taskPage = taskPage;
  if (albumPage) result.albumPage = albumPage;
  if (financePage) result.financePage = financePage;
  if (typeof stored.taskSearch === 'string') result.taskSearch = stored.taskSearch.slice(0, 120);
  if (stored.taskStatus === 'running' || stored.taskStatus === 'playable' || stored.taskStatus === 'failed' || stored.taskStatus === 'all') result.taskStatus = stored.taskStatus;
  else if (stored.taskStatus === 'succeeded' || stored.taskStatus === 'cancelled') result.taskStatus = 'all';
  if (stored.taskSort === 'oldest' || stored.taskSort === 'newest') result.taskSort = stored.taskSort;
  return result;
}

function projectViewStorageKey(projectId: string, viewerId: string) {
  return `sd2:project-detail-view:v1:${viewerId}:${projectId}`;
}

function safeProjectListReturnTo(value: string | null | undefined) {
  const safe = sanitizeOptionalReturnTo(value);
  return safe && safe.split(/[?#]/, 1)[0] === '/projects' ? safe : '/projects';
}

type ProjectOperation = 'member' | 'invite' | 'rename' | 'projectAction' | 'removeMember' | 'videoCard' | 'budget';

type ProjectOperationSnapshot = {
  kind: ProjectOperation;
  identity: string;
  epoch: number;
  requestId: number;
};

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  status: string;
  owner_user_id: string;
  updated_at?: string;
  status_version?: { status: string; updated_at: string };
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  members: Array<{
    id: string;
    user_id: string;
    role: string;
    joined_at: string;
    user: { id: string; name: string; username: string; email: string; avatar_url?: string | null; role: string; status: string; account_type: string };
  }>;
  invites: Array<{ id: string; token: string; default_role: string; expires_at: string | null; used_count: number; max_uses: number | null }>;
  _count?: { members: number; tasks: number; reference_albums?: number };
}

interface ReferenceAlbumItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  updated_at: string;
  image_count: number;
}

interface TaskItem {
  id: string;
  prompt: string;
  provider: string;
  model?: string;
  generation_mode: string;
  ratio?: string | null;
  duration?: number | null;
  resolution?: string | null;
  local_status: string;
  provider_task_id: string | null;
  public_video_url?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  local_video_path?: string | null;
  delivery_stage?: { key?: string | null; label?: string | null } | null;
  stable_download_ready?: boolean | null;
  preview_available?: boolean | null;
  playable_available?: boolean | null;
  play_url?: string | null;
  download_url?: string | null;
  thumbnail_url?: string | null;
  retry_after_ms?: number | null;
  owner_user_id: string | null;
  user_id: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  refund_amount: number | null;
  provider_cost_status: string;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros?: number | null;
  provider_final_amount_micros?: number | null;
  provider_cost_currency: string | null;
  provider_billing_status?: string | null;
  created_at: string;
  owner?: { id: string; name: string; username: string; email?: string; avatar_url?: string | null; account_type?: string | null } | null;
  user?: { id: string; name: string; username: string; email?: string; avatar_url?: string | null; account_type?: string | null } | null;
  video_card_id?: string | null;
  video_card?: { id: string; title: string; objective: string | null; status: string } | null;
}

interface VideoCardSummary {
  task_count: number;
  succeeded_count: number;
  failed_count: number;
  running_count: number;
  estimated_credits: number;
  charged_credits: number;
  refunded_credits: number;
  official_cost_totals: Array<{ currency: string; amount_minor: number; amount_micros: number }>;
  resolution_distribution: Record<string, number>;
}

type ProjectVideoPreviewTask = { id: string; prompt: string; local_status: string; thumbnail_url?: string | null; play_url?: string | null };

interface VideoCardPreviewTask {
  id: string;
  prompt: string;
  provider: string;
  generation_mode: string;
  local_status: string;
  public_video_url: string | null;
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  delivery_stage?: { key?: string | null; label?: string | null } | null;
  stable_download_ready?: boolean | null;
  preview_available?: boolean | null;
  thumbnail_url?: string | null;
  retry_after_ms?: number | null;
  created_at: string;
}

interface VideoCardItem {
  id: string;
  project_id: string;
  title: string;
  objective: string | null;
  status: string;
  owner_user_id: string | null;
  owner?: { id: string; name: string; username: string; email?: string; avatar_url?: string | null; account_type?: string | null } | null;
  platform: string | null;
  ratio: string | null;
  duration: number | null;
  target_resolution: string | null;
  budget_credits: number | null;
  budget_currency: string | null;
  current_best_task_id: string | null;
  final_task_id: string | null;
  current_best_task: VideoCardPreviewTask | null;
  final_task: VideoCardPreviewTask | null;
  is_fallback: boolean;
  created_at: string;
  updated_at: string;
  summary: VideoCardSummary | null;
}

interface SimilarVideoCardItem {
  id: string;
  title: string;
  objective: string | null;
  status: string;
  platform: string | null;
  ratio: string | null;
  score: number;
  reasons: string[];
}

interface ProjectPermissions {
  can_archive?: boolean;
  can_restore?: boolean;
  can_delete?: boolean;
  can_manage_project: boolean;
  can_manage_members: boolean;
  can_manage_assets: boolean;
  can_generate: boolean;
  role: string;
}

interface ProjectBudgetSummary {
  id: string | null;
  project_id: string;
  budget_credits: number;
  used_credits: number;
  frozen_credits: number;
  available_credits: number;
  currency: string;
  status: string;
  freeze_reason: string | null;
  reconciliation_status: string;
  usage_ratio: number;
  committed_ratio: number;
  risk_level: 'normal' | 'warning' | 'critical' | 'exhausted';
  block_reason: string | null;
  updated_at: string | null;
}

type ProjectAction = 'archive' | 'restore' | 'delete';

interface ArchiveAnomalies {
  total_count: number;
  unfiled_tasks: Array<{
    id: string;
    prompt: string;
    local_status: string;
    created_at: string;
    estimated_cost: number | null;
    actual_cost: number | null;
  }>;
  project_card_mismatches: Array<{
    id: string;
    prompt: string;
    local_status: string;
    created_at: string;
    project_id: string;
    video_card_id: string;
    card_project_id: string;
  }>;
}

interface ReviewTaskItem {
  id: string;
  prompt: string;
  provider?: string | null;
  generation_mode?: string | null;
  local_status: string;
  estimated_cost: number | null;
  actual_cost?: number | null;
  refund_amount?: number | null;
  provider_cost_status: string;
  error_message?: string | null;
  public_video_url?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  local_video_path?: string | null;
  delivery_stage?: { key?: string | null; label?: string | null } | null;
  stable_download_ready?: boolean | null;
  preview_available?: boolean | null;
  thumbnail_url?: string | null;
  retry_after_ms?: number | null;
  created_at: string;
  owner?: { id?: string; name: string; username: string; email?: string; avatar_url?: string | null; account_type?: string | null } | null;
  user?: { id?: string; name: string; username: string; email?: string; avatar_url?: string | null; account_type?: string | null } | null;
}

interface ProjectReviewSummary {
  task_count: number;
  succeeded_count: number;
  failed_count: number;
  running_count: number;
  success_rate: number;
  estimated_credits: number;
  charged_credits: number;
  refunded_credits: number;
  official_cost_minor: number;
  official_cost_micros?: number;
  official_cost_currency: string | null;
  official_cost_totals?: Array<{ currency: string; amount_minor: number; amount_micros: number }>;
  official_pending_count: number;
  cost_unknown_count: number;
  high_cost_tasks: ReviewTaskItem[];
  failed_tasks: ReviewTaskItem[];
}

interface CostLedgerItem {
  id: string;
  source_type: string;
  source_id: string | null;
  task_id: string | null;
  user_id: string | null;
  project_id: string | null;
  provider_name: string;
  provider_task_id: string | null;
  event_type: string;
  amount_minor: number | null;
  amount_micros: number | null;
  currency: string | null;
  usage_quantity: number | null;
  usage_unit: string | null;
  cost_source: string;
  confidence: string;
  official_charge_id: string | null;
  reason: string | null;
  occurred_at: string;
  created_at: string;
  user?: { id: string; name: string; username: string; email?: string; avatar_url?: string | null; account_type?: string | null } | null;
  task?: (TaskItem & {
    provider_official_amount_micros?: number | null;
    provider_final_amount_micros?: number | null;
    provider_billing_status?: string | null;
  }) | null;
  allocations?: Array<{
    id: string;
    allocation_type: string;
    allocation_id: string;
    amount_minor: number | null;
    amount_micros: number | null;
    currency: string | null;
    reason: string | null;
  }>;
}

interface ProjectPagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

function projectDisplayName(project: ProjectDetail): string {
  if (project.type === 'personal') return '个人空间';
  return project.name;
}

function roleLabel(role: string): string {
  if (role === 'admin') return '管理员';
  if (role === 'project_owner') return '负责人';
  if (role === 'editor') return '可编辑';
  if (role === 'member') return '可生成';
  if (role === 'viewer') return '仅查看';
  return role || '-';
}

function statusLabel(status: string): string {
  if (status === 'active') return '进行中';
  if (status === 'archived') return '已归档';
  if (status === 'locked') return '已锁定';
  return status;
}

function videoCardStatusLabel(status: string): string {
  if (status === 'draft') return '草稿';
  if (status === 'active') return '生成中';
  if (status === 'reviewing') return '评审中';
  if (status === 'finalized') return '已定稿';
  if (status === 'sealed') return '已封板';
  if (status === 'merged') return '已合并';
  if (status === 'archived') return '已归档';
  if (status === 'discarded') return '已废弃';
  return status || '-';
}

function canShowDeleteProjectAction(project: ProjectDetail): boolean {
  return project.type === 'team';
}

function projectActionMeta(project: ProjectDetail): string {
  return [
    statusLabel(project.status),
    `成员 ${project._count?.members ?? 0}`,
    `任务 ${project._count?.tasks ?? 0}`,
    `图集 ${project._count?.reference_albums ?? 0}`,
  ].join(' · ');
}

function formatAmountMinor(amount: number | null | undefined, currency?: string | null): string {
  return formatAmountMinorWithFixedCny(amount, currency);
}

function formatAmountMicros(amount: number | null | undefined, currency?: string | null): string {
  return formatAmountMicrosWithFixedCny(amount, currency);
}

function formatLedgerAmount(item: {
  amount_micros?: number | null;
  amount_minor?: number | null;
  currency?: string | null;
}): string {
  if (item.amount_micros !== null && item.amount_micros !== undefined) {
    return formatAmountMicros(item.amount_micros, item.currency);
  }
  return formatAmountMinor(item.amount_minor, item.currency);
}

function formatCostTotals(totals?: Array<{ currency: string; amount_minor: number; amount_micros: number }>): string {
  if (!totals || totals.length === 0) return '待官方确认';
  return totals.map((item) => formatAmountMicros(item.amount_micros, item.currency)).join(' · ');
}

function videoCardPreviewTask(card: VideoCardItem) {
  return card.final_task || card.current_best_task || null;
}

function isEnhanceTask(task?: { provider?: string | null; generation_mode?: string | null } | null) {
  return task?.generation_mode === 'enhance_video' || task?.provider === 'volcengine_mediakit';
}

function costStatusLabel(status: string): string {
  if (status === 'estimated_by_rule') return '规则预估';
  if (status === 'provisional_settled') return '临时结算';
  if (status === 'official_confirmed') return '官方确认';
  if (status === 'reconciled') return '已对账';
  if (status === 'failed_no_charge') return '失败未收费';
  if (status === 'unknown') return '待确认';
  if (status === 'disputed') return '异常';
  return '未记录';
}

function costEventLabel(eventType: string): string {
  if (eventType === 'official_charge') return '官方扣费';
  if (eventType === 'adjustment') return '调整';
  if (eventType === 'reversal') return '冲正';
  return eventType;
}

function projectTaskStatusLabel(task: TaskItem) {
  if (task.local_status === 'failed') return '失败';
  if (task.local_status === 'cancelled') return '已取消';
  if (task.local_status === 'submitted') return '排队中';
  if (task.local_status === 'running') return '生成中';
  if (task.local_status === 'succeeded') return task.delivery_stage?.label || '已完成';
  return task.local_status || '状态待同步';
}

function confidenceLabel(confidence: string): string {
  if (confidence === 'confirmed') return '已确认';
  if (confidence === 'reconciled') return '已对账';
  if (confidence === 'provisional') return '临时';
  if (confidence === 'estimated') return '预估';
  if (confidence === 'disputed') return '异常';
  if (confidence === 'unknown') return '待确认';
  return confidence || '-';
}

function budgetRiskLabel(level?: ProjectBudgetSummary['risk_level']) {
  if (level === 'exhausted') return '已用尽';
  if (level === 'critical') return '高风险';
  if (level === 'warning') return '需关注';
  return '正常';
}

function formatBudgetPoint(value: number | null | undefined) {
  const amount = Number(value || 0);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function taskOwnerUser(task: TaskItem | ReviewTaskItem) {
  return task.owner || task.user || null;
}

function ledgerOwnerUser(ledger: CostLedgerItem) {
  return ledger.task ? taskOwnerUser(ledger.task) : ledger.user;
}

function ProjectVideoPoster({ src, alt }: { src?: string | null; alt: string }) {
  const [failed, setFailed] = useState(!src);
  if (failed || !src) {
    return <span className="task-video-thumbnail-placeholder">暂无截图/预览不可用</span>;
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
}

function providerTaskIdLabel(ledger: CostLedgerItem): string {
  return ledger.provider_task_id || ledger.task?.provider_task_id || '-';
}

function MemberRemovalConfirmModal({
  memberName,
  busy,
  onCancel,
  onConfirm,
}: {
  memberName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogDismiss({
    open: true,
    dialogRef: panelRef,
    dismissSurfaceRef: overlayRef,
    onDismiss: onCancel,
    dismissOnOutside: !busy,
    dismissOnEscape: !busy,
  });

  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true" aria-label="移除成员确认">
      <div ref={panelRef} className="modal-panel project-removal-modal">
        <div className="modal-header">
          <div>
            <h2>移除成员</h2>
            <p>确认后，该成员将从此项目的成员列表中移除。</p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} disabled={busy} aria-label="关闭">×</button>
        </div>
        <div className="project-removal-summary"><strong>{memberName}</strong></div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? '处理中...' : '移除成员'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  const router = useRouter();
  const { user: currentUser, hasLoadedUser, loadingUser, refreshUser } = useAppSession();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const routeQuery = searchParams.toString();
  const projectId = params.id;
  const currentUserId = currentUser?.id || '';
  const accountKey = currentUserId ? `${currentUserId}:${currentUser?.role || ''}` : 'anonymous';
  const identityKey = `${accountKey}:${projectId}`;
  const [workspace, setWorkspace] = useState<ProjectViewState>(() => ({
    ...DEFAULT_PROJECT_VIEW,
    ...readProjectViewParams(searchParams),
  }));
  const activeIdentityRef = useRef(identityKey);
  const identityEpochRef = useRef(0);
  if (activeIdentityRef.current !== identityKey) {
    activeIdentityRef.current = identityKey;
    identityEpochRef.current += 1;
  }
  const activeSectionQueryKey = (() => {
    const query = new URLSearchParams({ section: workspace.section });
    if (workspace.section === 'tasks') {
      query.set('page', String(workspace.taskPage));
      query.set('q', workspace.taskSearch);
      query.set('status', workspace.taskStatus);
      query.set('sort', workspace.taskSort);
    } else if (workspace.section === 'albums') {
      query.set('page', String(workspace.albumPage));
    } else if (workspace.section === 'finance') {
      query.set('page', String(workspace.financePage));
    }
    return `${identityKey}?${query.toString()}`;
  })();
  const activeSectionQueryRef = useRef(activeSectionQueryKey);
  activeSectionQueryRef.current = activeSectionQueryKey;
  const projectListReturnTo = safeProjectListReturnTo(searchParams.get('return_to'));
  const projectReturnTo = (() => {
    const query = new URLSearchParams({
      view: workspace.section,
      task_page: String(workspace.taskPage),
      task_status: workspace.taskStatus,
      task_sort: workspace.taskSort,
      album_page: String(workspace.albumPage),
      finance_page: String(workspace.financePage),
    });
    if (workspace.taskSearch) query.set('task_q', workspace.taskSearch);
    query.set('return_to', projectListReturnTo);
    return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`;
  })();
  const projectTaskReturnTo = (taskId: string) => {
    const query = new URLSearchParams({
      view: 'tasks', task_page: String(workspace.taskPage), task_status: workspace.taskStatus,
      task_sort: workspace.taskSort, album_page: String(workspace.albumPage), finance_page: String(workspace.financePage),
    });
    if (workspace.taskSearch) query.set('task_q', workspace.taskSearch);
    query.set('return_to', projectListReturnTo);
    return `/projects/${encodeURIComponent(projectId)}?${query.toString()}#task-${encodeURIComponent(taskId)}`;
  };
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [videoCards, setVideoCards] = useState<VideoCardItem[]>([]);
  const [costLedgers, setCostLedgers] = useState<CostLedgerItem[]>([]);
  const [referenceAlbums, setReferenceAlbums] = useState<ReferenceAlbumItem[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ProjectReviewSummary | null>(null);
  const [budget, setBudget] = useState<ProjectBudgetSummary | null>(null);
  const [archiveAnomalies, setArchiveAnomalies] = useState<ArchiveAnomalies | null>(null);
  const [permissions, setPermissions] = useState<ProjectPermissions>({
    can_manage_project: false,
    can_manage_members: false,
    can_manage_assets: false,
    can_generate: false,
    role: '',
  });
  const [loading, setLoading] = useState(true);
  const [sectionLoading, setSectionLoading] = useState(false);
  const [loadedDataIdentity, setLoadedDataIdentity] = useState('');
  const [loadErrorIdentity, setLoadErrorIdentity] = useState('');
  const [viewerId, setViewerId] = useState('');
  const [sectionPagination, setSectionPagination] = useState<ProjectPagination | null>(null);
  const [sectionPaginationQueryKey, setSectionPaginationQueryKey] = useState('');
  const [activePreviewTask, setActivePreviewTask] = useState<ProjectVideoPreviewTask | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [joinUrl, setJoinUrl] = useState('');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const savingProjectRef = useRef(false);
  const addingMemberRef = useRef(false);
  const creatingInviteRef = useRef(false);
  const [videoCardTitle, setVideoCardTitle] = useState('');
  const [videoCardObjective, setVideoCardObjective] = useState('');
  const [creatingVideoCard, setCreatingVideoCard] = useState(false);
  const [similarVideoCards, setSimilarVideoCards] = useState<SimilarVideoCardItem[]>([]);
  const [confirmDuplicateVideoCard, setConfirmDuplicateVideoCard] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);
  const [pendingProjectAction, setPendingProjectAction] = useState<ProjectAction | null>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [pendingMemberRemoval, setPendingMemberRemoval] = useState<{ identity: string; userId: string; memberName: string } | null>(null);
  const [memberRemovalBusy, setMemberRemovalBusy] = useState(false);
  const routeStatePendingRef = useRef(false);
  const requestSequence = useRef(0);
  const operationTokensRef = useRef<Record<ProjectOperation, number>>({
    member: 0, invite: 0, rename: 0, projectAction: 0, removeMember: 0, videoCard: 0, budget: 0,
  });
  const loadedPreferencesFor = useRef('');
  const initializedDraftsFor = useRef('');
  const initializedBudgetDraftFor = useRef('');
  const loadedProjectIdentity = useRef('');
  const viewerIdRef = useRef('');

  const beginOperation = (kind: ProjectOperation): ProjectOperationSnapshot => {
    const requestId = operationTokensRef.current[kind] + 1;
    operationTokensRef.current[kind] = requestId;
    return { kind, identity: identityKey, epoch: identityEpochRef.current, requestId };
  };
  const isCurrentOperation = (snapshot: ProjectOperationSnapshot) => (
    activeIdentityRef.current === snapshot.identity
    && identityEpochRef.current === snapshot.epoch
    && operationTokensRef.current[snapshot.kind] === snapshot.requestId
  );

  const clearProjectData = useCallback(() => {
    setLoadedDataIdentity('');
    setProject(null);
    setTasks([]);
    setVideoCards([]);
    setCostLedgers([]);
    setReferenceAlbums([]);
    setReviewSummary(null);
    setBudget(null);
    setArchiveAnomalies(null);
    setPermissions({ can_manage_project: false, can_manage_members: false, can_manage_assets: false, can_generate: false, role: '' });
    setSectionPagination(null);
    setSectionPaginationQueryKey('');
    setViewerId('');
    viewerIdRef.current = '';
    setActivePreviewTask(null);
    setMessage('');
    setError('');
    setLoadErrorIdentity('');
    setMemberUserId('');
    setMemberRole('member');
    setJoinUrl('');
    setEditName('');
    setEditDescription('');
    setSettingsOpen(false); setSavingProject(false); setAddingMember(false); setCreatingInvite(false);
    savingProjectRef.current = false; addingMemberRef.current = false; creatingInviteRef.current = false;
    setVideoCardTitle('');
    setVideoCardObjective('');
    setCreatingVideoCard(false);
    setSimilarVideoCards([]);
    setConfirmDuplicateVideoCard(false);
    setBudgetDraft('');
    setSavingBudget(false);
    setPendingProjectAction(null);
    setProjectActionBusy(false);
    setPendingMemberRemoval(null);
    setMemberRemovalBusy(false);
    loadedPreferencesFor.current = '';
    initializedDraftsFor.current = '';
    initializedBudgetDraftFor.current = '';
    loadedProjectIdentity.current = '';
  }, []);

  const reportApiFailure = (res: Response, data: { error?: string; message?: string }, fallback: string) => {
    const message = data.error || data.message || fallback;
    if (res.status === 401) {
      clearProjectData();
      router.replace('/login');
      return;
    }
    if (res.status === 403 || res.status === 404) {
      clearProjectData();
      setError(message);
      setLoadErrorIdentity(identityKey);
      return;
    }
    setError(message);
  };

  const loadProject = async () => {
    if (!hasLoadedUser || loadingUser || !currentUserId) return;
    const requestId = ++requestSequence.current;
    const requestIdentity = identityKey;
    const requestQueryKey = activeSectionQueryKey;
    const isCurrentRequest = () => (
      requestId === requestSequence.current
      && activeIdentityRef.current === requestIdentity
      && activeSectionQueryRef.current === requestQueryKey
    );
    const section = workspace.section;
    if (loadedProjectIdentity.current !== identityKey) {
      loadedProjectIdentity.current = identityKey;
      clearProjectData();
      loadedProjectIdentity.current = identityKey;
      setLoading(true);
    }
    const query = new URLSearchParams({ section });
    if (section === 'tasks') {
      query.set('page', String(workspace.taskPage));
      query.set('q', workspace.taskSearch);
      query.set('status', workspace.taskStatus);
      query.set('sort', workspace.taskSort);
    } else if (section === 'albums') {
      query.set('page', String(workspace.albumPage));
    } else if (section === 'finance') {
      query.set('page', String(workspace.financePage));
    }
    if (!project) setLoading(true);
    else setSectionLoading(true);
    setError('');
    setLoadErrorIdentity('');
    try {
      const res = await fetch(`/api/projects/${projectId}?${query.toString()}`, { cache: 'no-store' });
      if (!isCurrentRequest()) return;
      if (res.status === 401) {
        clearProjectData();
        router.replace('/login');
        return;
      }
      const data = await res.json();
      if (!isCurrentRequest()) return;
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) clearProjectData();
        setError(data.error || data.message || '项目加载失败');
        setLoadErrorIdentity(identityKey);
        return;
      }
      const nextViewerId = typeof data.viewer_id === 'string' ? data.viewer_id : '';
      if (nextViewerId !== currentUserId || data.project?.id !== projectId) {
        clearProjectData();
        setError('登录状态或项目已变化，请重试读取。');
        setLoadErrorIdentity(identityKey);
        void refreshUser({ force: true });
        return;
      }
      const viewerChanged = Boolean(viewerIdRef.current && nextViewerId && viewerIdRef.current !== nextViewerId);
      if (viewerChanged) {
        setProject(null);
        setTasks([]);
        setCostLedgers([]);
        setReferenceAlbums([]);
        setReviewSummary(null);
        setBudget(null);
        setVideoCards([]);
        setArchiveAnomalies(null);
        setJoinUrl('');
        setMemberUserId('');
        setMessage('');
        setActivePreviewTask(null);
        setPendingProjectAction(null);
        setPermissions({ can_manage_project: false, can_manage_members: false, can_manage_assets: false, can_generate: false, role: '' });
        loadedPreferencesFor.current = '';
        initializedDraftsFor.current = '';
        initializedBudgetDraftFor.current = '';
        setBudgetDraft('');
      }
      viewerIdRef.current = nextViewerId;
      setViewerId(nextViewerId);
      setPermissions(data.permissions || {
        can_manage_project: false,
        can_manage_members: false,
        can_manage_assets: false,
        can_generate: false,
        role: '',
      });
      if (viewerChanged) {
        setProject({ ...data.project, members: section === 'members' ? data.project.members || [] : [], invites: data.project.invites || [] });
      } else setProject((previous) => {
        if (!previous || previous.id !== data.project.id) return data.project;
        return {
          ...previous,
          ...data.project,
          members: section === 'members' ? data.project.members || [] : previous.members || [],
          invites: !data.permissions?.can_manage_members ? [] : section === 'members' ? data.project.invites || [] : previous.invites || [],
          _count: { ...previous._count, ...data.project._count },
        };
      });
      const draftIdentity = `${nextViewerId}:${data.project?.id || projectId}`;
      if (initializedDraftsFor.current !== draftIdentity) {
        let draft: { name?: string; description?: string } | null = null;
        try { const raw = localStorage.getItem(`sd2:project-info-draft:v1:${draftIdentity}`); if (raw) draft = JSON.parse(raw); } catch { /* Keep server values when local drafts cannot be read. */ }
        setEditName(typeof draft?.name === 'string' ? draft.name : data.project?.name || '');
        setEditDescription(typeof draft?.description === 'string' ? draft.description : data.project?.description || '');
        initializedDraftsFor.current = draftIdentity;
      }
      if (section === 'tasks') {
        setTasks(data.tasks || []);
        if (data.pagination?.page && data.pagination.page !== workspace.taskPage) setWorkspace((current) => ({ ...current, taskPage: data.pagination.page }));
      }
      if (section === 'members') {
        setProject((previous) => previous ? { ...previous, members: data.project.members || [], invites: data.project.invites || [] } : data.project);
      }
      if (section === 'albums') {
        setReferenceAlbums(data.reference_albums || []);
        if (data.pagination?.page && data.pagination.page !== workspace.albumPage) setWorkspace((current) => ({ ...current, albumPage: data.pagination.page }));
      }
      if (section === 'finance') {
        setCostLedgers(data.cost_ledgers || []);
        setReviewSummary(data.review_summary || null);
        if (data.pagination?.page && data.pagination.page !== workspace.financePage) setWorkspace((current) => ({ ...current, financePage: data.pagination.page }));
      }
      setSectionPagination(data.pagination || null);
      setSectionPaginationQueryKey(requestQueryKey);
      setLoadedDataIdentity(identityKey);
      setBudget(data.budget || null);
      if (data.budget && initializedBudgetDraftFor.current !== draftIdentity) {
        setBudgetDraft(String(data.budget.budget_credits));
        initializedBudgetDraftFor.current = draftIdentity;
      }
      setArchiveAnomalies(data.archive_anomalies || null);

      const preferenceIdentity = `${nextViewerId}:${data.project?.id || projectId}`;
      if (nextViewerId && loadedPreferencesFor.current !== preferenceIdentity) {
        let saved: Partial<ProjectViewState> = {};
        try {
          const raw = window.localStorage.getItem(projectViewStorageKey(data.project.id, nextViewerId));
          if (raw) saved = normalizeStoredProjectView(JSON.parse(raw));
        } catch { /* Storage can be disabled or contain an older/corrupt value. */ }
        const urlState = readProjectViewParams(new URLSearchParams(window.location.search));
        setWorkspace({ ...DEFAULT_PROJECT_VIEW, ...saved, ...urlState });
        loadedPreferencesFor.current = preferenceIdentity;
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      setError(err instanceof Error ? err.message : '项目加载失败');
      setLoadErrorIdentity(identityKey);
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
        setSectionLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!hasLoadedUser && !loadingUser) void refreshUser();
  }, [hasLoadedUser, loadingUser, refreshUser]);

  useEffect(() => {
    if (hasLoadedUser && !currentUserId) router.replace('/login');
  }, [hasLoadedUser, currentUserId, router]);

  useEffect(() => {
    requestSequence.current += 1;
    clearProjectData();
    setLoading(true);
    setWorkspace({ ...DEFAULT_PROJECT_VIEW, ...readProjectViewParams(new URLSearchParams(window.location.search)) });
  }, [identityKey, clearProjectData]);

  useEffect(() => {
    if (!hasLoadedUser || loadingUser || !currentUserId) return;
    const timer = window.setTimeout(() => { void loadProject(); }, workspace.section === 'tasks' ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
    };
  }, [hasLoadedUser, loadingUser, currentUserId, currentUser?.role, projectId, workspace.section, workspace.taskPage, workspace.taskSearch, workspace.taskStatus, workspace.taskSort, workspace.albumPage, workspace.financePage]);

  useEffect(() => {
    const urlState = readProjectViewParams(new URLSearchParams(routeQuery));
    if (!Object.keys(urlState).length) return;
    routeStatePendingRef.current = true;
    setWorkspace((current) => ({ ...current, ...urlState }));
  }, [routeQuery]);

  useEffect(() => {
    if (!viewerId || loadedDataIdentity !== identityKey || !loadedPreferencesFor.current) return;
    if (routeStatePendingRef.current) {
      routeStatePendingRef.current = false;
      return;
    }
    try {
      window.localStorage.setItem(projectViewStorageKey(projectId, viewerId), JSON.stringify(workspace));
    } catch { /* Local preferences are best-effort and never block project work. */ }
    const query = new URLSearchParams(window.location.search);
    query.set('view', workspace.section);
    query.set('task_page', String(workspace.taskPage));
    query.set('task_status', workspace.taskStatus);
    query.set('task_sort', workspace.taskSort);
    query.set('album_page', String(workspace.albumPage));
    query.set('finance_page', String(workspace.financePage));
    if (workspace.taskSearch) query.set('task_q', workspace.taskSearch);
    else query.delete('task_q');
    query.set('return_to', projectListReturnTo);
    window.history.replaceState(window.history.state, '', `/projects/${encodeURIComponent(projectId)}?${query.toString()}${window.location.hash}`);
  }, [workspace, viewerId, projectId, identityKey, loadedDataIdentity, projectListReturnTo]);

  useEffect(() => {
    if (!viewerId || loadedDataIdentity !== identityKey || initializedDraftsFor.current !== `${viewerId}:${projectId}`) return;
    try { localStorage.setItem(`sd2:project-info-draft:v1:${viewerId}:${projectId}`, JSON.stringify({ name: editName, description: editDescription })); }
    catch { /* A failed save keeps the current form visible; it never submits automatically. */ }
  }, [editDescription, editName, identityKey, loadedDataIdentity, projectId, viewerId]);

  useEffect(() => {
    if (workspace.section !== 'tasks' || !tasks.length || !window.location.hash.startsWith('#task-')) return;
    const timer = window.setTimeout(() => document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView({ block: 'center' }), 0);
    return () => window.clearTimeout(timer);
  }, [tasks, workspace.section]);

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (addingMemberRef.current || !permissions.can_manage_members) return;
    addingMemberRef.current = true; setAddingMember(true);
    const operation = beginOperation('member');
    if (!isCurrentOperation(operation)) return;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: memberUserId, role: memberRole }),
      });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        reportApiFailure(res, data, '添加成员失败');
        return;
      }
      setMemberUserId('');
      setMessage('成员已加入项目');
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) setError(err instanceof Error ? err.message : '添加成员失败');
    } finally {
      if (isCurrentOperation(operation)) { addingMemberRef.current = false; setAddingMember(false); }
    }
  };

  const createInvite = async () => {
    if (creatingInviteRef.current || !permissions.can_manage_members) return;
    creatingInviteRef.current = true; setCreatingInvite(true);
    const operation = beginOperation('invite');
    if (!isCurrentOperation(operation)) return;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    try {
      const res = await fetch(`/api/projects/${projectId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_role: 'member', expires_days: 7 }),
      });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        reportApiFailure(res, data, '创建邀请失败');
        return;
      }
      const url = `${window.location.origin}${data.join_url}`;
      setJoinUrl(url);
      setMessage('邀请链接已创建');
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) setError(err instanceof Error ? err.message : '创建邀请失败');
    } finally {
      if (isCurrentOperation(operation)) { creatingInviteRef.current = false; setCreatingInvite(false); }
    }
  };

  const updateProjectInfo = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project || savingProjectRef.current) return;
    const operation = beginOperation('rename');
    if (!isCurrentOperation(operation)) return;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    const submittedName = editName;
    const submittedDescription = editDescription;
    savingProjectRef.current = true; setSavingProject(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: submittedName, description: submittedDescription, ...projectStatusExpectation(project) }),
      });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        if (res.status === 409 && data.current) setProject((previous) => previous ? { ...previous, status_version: data.current } : previous);
        reportApiFailure(res, data, '更新项目失败');
        return;
      }
      setMessage('项目信息已更新');
      setSettingsOpen(false);
      try { localStorage.removeItem(`sd2:project-info-draft:v1:${currentUserId}:${projectId}`); } catch { /* Current saved values remain available. */ }
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) setError(err instanceof Error ? err.message : '更新项目失败');
    } finally {
      if (isCurrentOperation(operation)) { savingProjectRef.current = false; setSavingProject(false); }
    }
  };

  const requestProjectAction = (action: ProjectAction) => {
    if (!project || activeIdentityRef.current !== identityKey) return;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    setPendingProjectAction(action);
  };

  const confirmProjectAction = async () => {
    if (!project || !pendingProjectAction || projectActionBusy) return;
    const operation = beginOperation('projectAction');
    if (!isCurrentOperation(operation)) return;
    const action = pendingProjectAction;
    const label = action === 'archive' ? '归档为只读' : action === 'restore' ? '恢复' : '删除';

    setProjectActionBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, action === 'delete'
        ? { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(projectStatusExpectation(project)) }
        : {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...projectStatusExpectation(project) }),
          });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        setPendingProjectAction(null);
        if (res.status === 409 && data.current) setProject((previous) => previous ? { ...previous, status_version: data.current } : previous);
        reportApiFailure(res, data, `${label}项目失败`);
        return;
      }
      setPendingProjectAction(null);
      if (action === 'delete') {
        window.location.href = projectListReturnTo;
        return;
      }
      setMessage(`项目已${label}`);
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) {
        setError(err instanceof Error ? err.message : `${label}项目失败`);
        setPendingProjectAction(null);
      }
    } finally {
      if (isCurrentOperation(operation)) setProjectActionBusy(false);
    }
  };

  const removeMember = (userId: string, memberName: string) => {
    if (!project || activeIdentityRef.current !== identityKey) return;
    if (userId === project.owner_user_id || !project.members.some((member) => member.user_id === userId)) return;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    setPendingMemberRemoval({ identity: identityKey, userId, memberName });
  };

  const confirmMemberRemoval = async () => {
    const target = pendingMemberRemoval;
    if (!project || !target || target.identity !== identityKey || activeIdentityRef.current !== identityKey) return;
    if (target.userId === project.owner_user_id || !project.members.some((member) => member.user_id === target.userId)) {
      setPendingMemberRemoval(null);
      return;
    }
    const operation = beginOperation('removeMember');
    if (!isCurrentOperation(operation)) return;
    setMemberRemovalBusy(true);
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${target.userId}`, { method: 'DELETE' });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        reportApiFailure(res, data, '移除成员失败');
        if (isCurrentOperation(operation)) setPendingMemberRemoval(null);
        return;
      }
      setPendingMemberRemoval(null);
      setMessage('成员已移除');
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) {
        setError(err instanceof Error ? err.message : '移除成员失败');
        setPendingMemberRemoval(null);
      }
    } finally {
      if (isCurrentOperation(operation)) setMemberRemovalBusy(false);
    }
  };

  const createVideoCard = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project) return;
    const operation = beginOperation('videoCard');
    if (!isCurrentOperation(operation)) return;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    const title = videoCardTitle.trim();
    if (!title) {
      setError('请先填写视频卡标题');
      return;
    }
    setCreatingVideoCard(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/video-cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          objective: videoCardObjective.trim() || null,
          confirm_duplicate: confirmDuplicateVideoCard,
        }),
      });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        if (res.status === 409 && data.code === 'SIMILAR_VIDEO_CARD_EXISTS') {
          setSimilarVideoCards(data.similar_video_cards || []);
          setConfirmDuplicateVideoCard(true);
          setError('发现可能重复的视频卡。可以进入已有卡继续归档，或再次点击“仍然新建”。');
          return;
        }
        reportApiFailure(res, data, '创建视频卡失败');
        return;
      }
      setVideoCardTitle('');
      setVideoCardObjective('');
      setSimilarVideoCards([]);
      setConfirmDuplicateVideoCard(false);
      setMessage('视频卡已创建');
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) setError(err instanceof Error ? err.message : '创建视频卡失败');
    } finally {
      if (isCurrentOperation(operation)) setCreatingVideoCard(false);
    }
  };

  const updateProjectBudget = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project) return;
    const operation = beginOperation('budget');
    if (!isCurrentOperation(operation)) return;
    const submittedBudgetDraft = budgetDraft;
    setError('');
    setLoadErrorIdentity('');
    setMessage('');
    const budgetCredits = Number(submittedBudgetDraft);
    if (!Number.isFinite(budgetCredits) || budgetCredits < 0) {
      setError('预算必须是非负数字');
      return;
    }
    setSavingBudget(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budget_credits: budgetCredits,
          reason: '项目详情页调整预算',
        }),
      });
      if (!isCurrentOperation(operation)) return;
      const data = await res.json();
      if (!isCurrentOperation(operation)) return;
      if (!res.ok) {
        reportApiFailure(res, data, '更新预算失败');
        return;
      }
      setBudget(data.budget || null);
      if (budgetDraft === submittedBudgetDraft) setBudgetDraft(data.budget ? String(data.budget.budget_credits) : submittedBudgetDraft);
      setMessage('项目预算已更新');
      await loadProject();
    } catch (err) {
      if (isCurrentOperation(operation)) setError(err instanceof Error ? err.message : '更新预算失败');
    } finally {
      if (isCurrentOperation(operation)) setSavingBudget(false);
    }
  };

  const sectionPaginationIsCurrent = sectionPaginationQueryKey === activeSectionQueryKey;

  if (!hasLoadedUser || loadingUser || loading || (Boolean(currentUserId) && loadedDataIdentity !== identityKey && loadErrorIdentity !== identityKey)) {
    return <div className="card"><p className="text-gray">加载中...</p></div>;
  }

  if (hasLoadedUser && !currentUserId) {
    return <div className="card"><p className="text-gray">正在返回登录页…</p></div>;
  }

  if (!project) {
    return (
      <div className="card">
        <p className="text-gray">{error || '项目不存在或无权访问'}</p>
        <div className="flex items-center mt-4" style={{ gap: 10, flexWrap: 'wrap' }}>
          {error && <button type="button" className="btn btn-secondary" onClick={() => void loadProject()}>重试读取</button>}
          <Link href={projectListReturnTo} className="btn btn-secondary">返回项目列表</Link>
        </div>
      </div>
    );
  }

  const generatorQuery = new URLSearchParams({ project_id: project.id, return_to: projectReturnTo });
  const generatorHref = `/generate?${generatorQuery.toString()}`;

  return (
    <div>
      <PageBanner
        eyebrow="项目详情"
        title={projectDisplayName(project)}
        description={`${project.description || '项目中的生成任务、参考图集和成员协作。'} · ${statusLabel(project.status)} · ${roleLabel(permissions.role)}`}
        actions={permissions.can_generate && project.status === 'active' && !budget?.block_reason ? (
          <a href={generatorHref} className="btn btn-primary">生成视频</a>
        ) : permissions.can_generate && project.status === 'active' && budget?.block_reason ? (
          <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="text-gray text-sm">暂不可生成：{budget.block_reason}</span>
            <button type="button" className="btn btn-secondary" onClick={() => setWorkspace((current) => ({ ...current, section: 'finance' }))}>查看费用</button>
          </div>
        ) : project.status !== 'active' ? (
          <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="text-gray text-sm">当前项目为{statusLabel(project.status)}，不能继续生成。</span>
            <button type="button" className="btn btn-secondary" onClick={() => setWorkspace((current) => ({ ...current, section: 'members' }))}>查看项目选项</button>
          </div>
        ) : (
          <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="text-gray text-sm">当前角色没有生成权限。</span>
            <button type="button" className="btn btn-secondary" onClick={() => setWorkspace((current) => ({ ...current, section: 'members' }))}>查看成员与设置</button>
          </div>
        )}
        backHref={projectListReturnTo}
        backLabel="返回项目"
      />

      {(message || error) && (
        <div className="card" style={{ borderColor: error ? 'var(--border-color)' : 'rgba(74,222,128,0.35)' }}>
          <p className={error ? 'text-gray' : 'text-green'}>{error || message}</p>
          {joinUrl && (
            <p className="text-sm mt-2">
              邀请链接：<a className="link" href={joinUrl}>{joinUrl}</a>
            </p>
          )}
          {error && loadErrorIdentity === identityKey && <button type="button" className="btn btn-secondary mt-2" onClick={() => void loadProject()}>重试读取</button>}
        </div>
      )}

      {project.status === 'archived' && (
        <div className="card" style={{ borderColor: 'rgba(250,204,21,0.35)' }}>
          <p className="text-gray">此项目已归档为只读，历史任务和图集仍可查看，但不能继续生成或新增素材。</p>
        </div>
      )}

      <nav className={styles.sections} aria-label="项目分区">
          {([
            ['tasks', '生成记录'], ['albums', '参考图集'],
            ['finance', '用量与费用'], ['members', '成员与设置'],
          ] as Array<[ProjectSection, string]>).map(([section, label]) => (
            <button key={section} type="button" aria-pressed={workspace.section === section}
              onClick={() => setWorkspace((current) => ({ ...current, section }))}>
              {label}
            </button>
          ))}
      </nav>
      {sectionLoading && <p className="text-gray text-sm" aria-live="polite">正在更新当前分区…</p>}
      {workspace.section === 'finance' && <section className={styles.section} id="project-usage">
        <h2 className="section-title">项目用量与费用</h2>
        <UsageWorkspace key={identityKey} ownerId={currentUserId} projectId={projectId} />
      </section>}

      {workspace.section === 'finance' && project.type === 'public' && budget && (
        <details className={styles.disclosure}>
          <summary>项目预算与充值</summary>
          <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 className="section-title mb-0">项目预算</h2>
              <p className="text-gray text-sm mt-2">
                状态 {budget.status} · 对账 {budget.reconciliation_status} · 已用 {Math.round(budget.usage_ratio * 100)}% · 含冻结 {Math.round(budget.committed_ratio * 100)}%
              </p>
            </div>
            <span className={`project-budget-risk ${budget.risk_level}`}>{budgetRiskLabel(budget.risk_level)}</span>
          </div>
          {budget.block_reason && (
            <div className="project-budget-blocked">
              <strong>预算暂不可生成</strong>
              <span>{budget.block_reason}</span>
            </div>
          )}
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">预算总额</span>
              <strong className="stat-value">{formatBudgetPoint(budget.budget_credits)}</strong>
              <span className="stat-sub">{budget.currency}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">已用</span>
              <strong className="stat-value">{formatBudgetPoint(budget.used_credits)}</strong>
              <span className="stat-sub">成功任务实扣</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">冻结</span>
              <strong className="stat-value">{formatBudgetPoint(budget.frozen_credits)}</strong>
              <span className="stat-sub">进行中任务预占</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">剩余</span>
              <strong className="stat-value">{formatBudgetPoint(budget.available_credits)}</strong>
              <span className="stat-sub">可继续生成</span>
            </div>
          </div>
          {permissions.role === 'admin' ? (
            <form className="project-budget-form" onSubmit={updateProjectBudget}>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={budgetDraft}
                disabled={savingBudget}
                onChange={(event) => setBudgetDraft(event.target.value)}
                placeholder="预算点数"
              />
              <button className="btn btn-secondary" type="submit" disabled={savingBudget}>
                {savingBudget ? '保存中...' : '更新预算'}
              </button>
            </form>
          ) : (
            <p className="text-gray text-sm mt-4">追加预算需要管理员处理。</p>
          )}
        </details>
      )}

      {showVideoCardManagementUi && (
      <div className="card" id="project-video-cards">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">视频卡</h2>
            <p className="text-gray text-sm mt-2">每张视频卡对应一条视频目标，生成记录、最佳版本和成本都归档在卡内。</p>
          </div>
          <span className="text-gray text-sm">{videoCards.length} 张</span>
        </div>

        {archiveAnomalies && archiveAnomalies.total_count > 0 && (
          <div className="video-card-anomaly-panel">
            <strong>异常归档池</strong>
            <span>
              未归档任务 {archiveAnomalies.unfiled_tasks.length} 条 · 项目/视频卡错配 {archiveAnomalies.project_card_mismatches.length} 条
            </span>
            <small>这些任务不会自动重新计费；请通过移动归档或巡检脚本处理归属。</small>
          </div>
        )}

        {permissions.can_generate && project.status === 'active' && (
          <form className="video-card-create" onSubmit={createVideoCard}>
            <input
              className="input"
              value={videoCardTitle}
              onChange={(event) => {
                setVideoCardTitle(event.target.value);
                setSimilarVideoCards([]);
                setConfirmDuplicateVideoCard(false);
              }}
              placeholder="视频卡标题，例如：产品首屏宣传短片"
              maxLength={80}
            />
            <input
              className="input"
              value={videoCardObjective}
              onChange={(event) => {
                setVideoCardObjective(event.target.value);
                setSimilarVideoCards([]);
                setConfirmDuplicateVideoCard(false);
              }}
              placeholder="视频目标，可选"
              maxLength={160}
            />
            <button className="btn btn-primary" type="submit" disabled={creatingVideoCard || !videoCardTitle.trim()}>
              {creatingVideoCard ? '创建中...' : confirmDuplicateVideoCard ? '仍然新建' : '创建视频卡'}
            </button>
          </form>
        )}

        {similarVideoCards.length > 0 && (
          <div className="video-card-duplicate-panel">
            <strong>可能已有同目标视频卡</strong>
            <span>优先进入已有卡继续生成或整理；如果确实是不同交付目标，再选择仍然新建。</span>
            <div>
              {similarVideoCards.map((card) => (
                <Link className="video-card-duplicate-item" href={`/projects/${project.id}/video-cards/${card.id}`} key={card.id}>
                  <span>{card.title}</span>
                  <small>{[videoCardStatusLabel(card.status), card.platform, card.ratio, ...card.reasons].filter(Boolean).join(' · ')}</small>
                </Link>
              ))}
            </div>
          </div>
        )}

        {videoCards.length === 0 ? (
          <div className="video-card-empty">
            <strong>暂无视频卡</strong>
            <span>先创建视频卡，再进入生成页；新生成任务必须绑定到具体视频卡。</span>
          </div>
        ) : (
          <div className="video-card-grid">
            {videoCards.map((card) => {
              const previewTask = videoCardPreviewTask(card);
              const summary = card.summary;
              return (
                <article key={card.id} className="video-card-item">
                  <div className="video-card-preview">
                    <ProjectVideoPoster key={previewTask?.thumbnail_url || 'no-cover'} src={previewTask?.thumbnail_url} alt={`${card.title}视频封面`} />
                    {isEnhanceTask(previewTask) ? (
                      <span className="task-video-thumbnail-enhance-badge">超分</span>
                    ) : null}
                  </div>
                  <div className="video-card-main">
                    <div className="video-card-head">
                      <div>
                        <Link className="video-card-title" href={`/projects/${project.id}/video-cards/${card.id}`}>
                          {card.title}
                        </Link>
                        <p className="video-card-objective">{card.objective || '未填写视频目标'}</p>
                      </div>
                      <span className={`video-card-status ${card.status}`}>{videoCardStatusLabel(card.status)}</span>
                    </div>
                    <div className="video-card-meta">
                      <span>{card.ratio || '比例未定'}</span>
                      <span>{card.duration ? `${card.duration}s` : '时长未定'}</span>
                      <span>{card.target_resolution || '分辨率未定'}</span>
                      <UserIdentityBadge user={card.owner} size="sm" />
                    </div>
                    <div className="video-card-stats">
                      <span>生成 {summary?.task_count ?? 0}</span>
                      <span>成功 {summary?.succeeded_count ?? 0}</span>
                      <span>点数 {summary?.charged_credits ?? 0}</span>
                      <span>官方 {formatCostTotals(summary?.official_cost_totals)}</span>
                    </div>
                  <div className="video-card-actions">
                      {previewTask?.preview_available && <button className="btn btn-secondary" type="button" onClick={() => setActivePreviewTask(previewTask)} aria-label={`预览${card.title}`} title="预览视频">
                        <Eye size={16} aria-hidden="true" />预览
                      </button>}
                      <Link className="btn btn-secondary" href={`/projects/${project.id}/video-cards/${card.id}`}>
                        查看视频卡
                      </Link>
                      {permissions.can_generate && card.status !== 'sealed' && card.status !== 'archived' && (
                        <Link className="btn btn-primary" href={`/generate?project_id=${encodeURIComponent(project.id)}&video_card_id=${encodeURIComponent(card.id)}&return_to=${encodeURIComponent(projectReturnTo)}`}>
                          在此卡生成
                        </Link>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      )}

      {workspace.section === 'finance' && <details className={styles.legacy}>
      <summary>历史账务与项目复盘（原账务范围）</summary>
      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">项目复盘</h2>
            <p className="text-gray text-sm mt-2">这里看项目怎么被使用：点数、任务、失败和官方成本确认状态。</p>
          </div>
          <a className="link" href="#project-usage">按月份查看与导出</a>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">任务数</span>
            <strong className="stat-value">{reviewSummary?.task_count ?? 0}</strong>
            <span className="stat-sub">成功率 {reviewSummary?.success_rate ?? 0}%</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">点数消耗</span>
            <strong className="stat-value">{reviewSummary?.charged_credits ?? 0}</strong>
            <span className="stat-sub">预估 {reviewSummary?.estimated_credits ?? 0} · 返还 {reviewSummary?.refunded_credits ?? 0}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">官方成本</span>
            <strong className="stat-value">
              {reviewSummary?.official_cost_totals
                ? formatCostTotals(reviewSummary.official_cost_totals)
                : formatAmountMinor(reviewSummary?.official_cost_minor, reviewSummary?.official_cost_currency)}
            </strong>
            <span className="stat-sub">待确认 {reviewSummary?.official_pending_count ?? 0} 条</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">失败 / 异常</span>
            <strong className="stat-value">{reviewSummary?.failed_count ?? 0}</strong>
            <span className="stat-sub">成本待确认 {reviewSummary?.cost_unknown_count ?? 0} 条</span>
          </div>
        </div>

        {reviewSummary && reviewSummary.high_cost_tasks.length > 0 && (
          <div className="mt-6">
            <h3 className="section-title">高点数任务</h3>
            <table className="table">
	              <thead>
	                <tr>
	                  <th>截图</th>
	                  <th>任务</th>
	                  <th>创建者</th>
                  <th>状态</th>
                  <th>点数</th>
                  <th>成本状态</th>
                </tr>
              </thead>
              <tbody>
	                {reviewSummary.high_cost_tasks.map((task) => (
	                  <tr key={task.id}>
	                    <td>
	                      <TaskVideoThumbnail
	                        taskId={task.id}
	                        thumbnailUrl={task.thumbnail_url}
	                        publicVideoUrl={task.public_video_url}
	                        localVideoPath={task.local_video_path}
	                        resultVideoUrl={task.result_video_url}
	                        resultLastFrameUrl={task.result_last_frame_url}
	                        status={task.local_status}
	                        deliveryStage={task.delivery_stage}
	                        previewAvailable={task.preview_available}
	                        stableDownloadReady={task.stable_download_ready}
	                        retryAfterMs={task.retry_after_ms}
	                        isEnhanceTask={isEnhanceTask(task)}
	                        href={taskDetailHref(task.id, projectReturnTo)}
	                        size="compact"
	                      />
	                    </td>
	                    <td className="truncate" style={{ maxWidth: 360 }}>
	                      <Link className="link" href={taskDetailHref(task.id, projectReturnTo)}>{task.prompt || task.id}</Link>
                    </td>
                    <td><UserIdentityBadge user={taskOwnerUser(task)} size="sm" /></td>
                    <td>{task.local_status}</td>
                    <td>{task.actual_cost ?? task.estimated_cost ?? 0}</td>
                    <td>{costStatusLabel(task.provider_cost_status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">官方真实成本明细</h2>
            <p className="text-gray text-sm mt-2">按 official_charge / adjustment / reversal 账本行展示，可从每笔成本追到视频任务。</p>
          </div>
          <span className="text-gray text-sm">{sectionPaginationIsCurrent && sectionPagination
            ? `当前页 ${costLedgers.length} 条 · 共 ${sectionPagination.total} 条`
            : '明细读取中'}</span>
        </div>

        {costLedgers.length === 0 ? (
          <p className="text-gray">暂无官方真实成本账本。Seedance 返回实际扣费后，或管理员录入官方账单后会显示在这里。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>视频 / 任务</th>
                <th>创建人</th>
                <th>Provider Task</th>
                <th>官方成本</th>
                <th>成本状态</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {costLedgers.map((ledger) => {
	                const task = ledger.task;
	                const providerTaskId = providerTaskIdLabel(ledger);

                return (
                  <tr key={ledger.id}>
	                    <td>
	                      <div className="flex items-center" style={{ gap: 10, minWidth: 300 }}>
	                        {task ? (
	                          <TaskVideoThumbnail
	                            taskId={task.id}
	                            thumbnailUrl={task.thumbnail_url}
	                            publicVideoUrl={task.public_video_url}
	                            localVideoPath={task.local_video_path}
	                            resultVideoUrl={task.result_video_url}
	                            resultLastFrameUrl={task.result_last_frame_url}
	                            status={task.local_status}
	                            deliveryStage={task.delivery_stage}
	                            previewAvailable={task.preview_available}
	                            stableDownloadReady={task.stable_download_ready}
	                            retryAfterMs={task.retry_after_ms}
	                            isEnhanceTask={isEnhanceTask(task)}
	                            href={taskDetailHref(task.id, projectReturnTo)}
	                            size="compact"
	                          />
	                        ) : (
	                          <span className="task-video-thumbnail task-video-thumbnail-compact">
	                            <span className="task-video-thumbnail-placeholder">无任务</span>
	                          </span>
	                        )}
                        <div style={{ minWidth: 0 }}>
                          {task ? (
                            <Link className="link truncate" style={{ display: 'block', maxWidth: 320 }} href={taskDetailHref(task.id, projectReturnTo)} title={task.prompt || task.id}>
                              {task.prompt || task.id}
                            </Link>
                          ) : (
                            <span className="truncate" style={{ display: 'block', maxWidth: 320 }} title={ledger.reason || ledger.source_id || ledger.id}>
                              {ledger.reason || ledger.source_id || ledger.id}
                            </span>
                          )}
                          <span className="text-gray text-sm">
                            {task?.local_status || ledger.source_type} · {costEventLabel(ledger.event_type)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td><UserIdentityBadge user={ledgerOwnerUser(ledger)} size="sm" /></td>
                    <td>
                      <span title={providerTaskId} style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {providerTaskId === '-' ? '-' : `${providerTaskId.slice(0, 18)}${providerTaskId.length > 18 ? '...' : ''}`}
                      </span>
                    </td>
                    <td>
                      <strong>{formatLedgerAmount(ledger)}</strong>
                      {ledger.allocations && ledger.allocations.length > 0 && (
                        <div className="text-gray text-sm">
                          项目分摊 {formatLedgerAmount(ledger.allocations[0])}
                        </div>
                      )}
                    </td>
                    <td>
                      <span>{task ? costStatusLabel(task.provider_cost_status) : confidenceLabel(ledger.confidence)}</span>
                      <div className="text-gray text-sm">
                        {confidenceLabel(ledger.confidence)}
                        {task?.provider_billing_status ? ` · ${task.provider_billing_status}` : ''}
                      </div>
                    </td>
                    <td><RelativeTime value={ledger.occurred_at || ledger.created_at} /></td>
                    <td>
                      {task ? (
                        <Link className="link" href={taskDetailHref(task.id, projectReturnTo)}>查看任务</Link>
                      ) : (
                        <span className="text-gray">无任务</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {sectionPaginationIsCurrent && sectionPagination && <PaginationControls page={sectionPagination.page} totalPages={sectionPagination.total_pages}
          total={sectionPagination.total} pageSize={sectionPagination.page_size} busy={sectionLoading}
          onPageChange={(page) => setWorkspace((current) => ({ ...current, financePage: page }))} label="条成本明细" />}
      </div>

      </details>}

      {workspace.section === 'tasks' && <section className={styles.section}>
        <div className="flex items-start justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <h2 className="section-title mb-0">生成记录</h2>
          <span className="text-gray text-sm">{sectionPaginationIsCurrent && sectionPagination ? `${sectionPagination.total} 条记录` : '记录数读取中'}</span>
        </div>
        <div className="flex items-center mb-4" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: '1 1 220px', maxWidth: 420 }} value={workspace.taskSearch}
            onChange={(event) => setWorkspace((current) => ({ ...current, taskSearch: event.target.value.slice(0, 120), taskPage: 1 }))}
            placeholder="搜索提示词、模型或任务编号" aria-label="搜索生成记录" />
          <select className="input" style={{ width: 170 }} value={workspace.taskStatus}
            onChange={(event) => setWorkspace((current) => ({ ...current, taskStatus: event.target.value as ProjectViewState['taskStatus'], taskPage: 1 }))} aria-label="筛选生成状态">
            <option value="all">全部记录</option><option value="running">进行中</option><option value="playable">可播放</option><option value="failed">失败或已取消</option>
          </select>
          <select className="input" style={{ width: 150 }} value={workspace.taskSort}
            onChange={(event) => setWorkspace((current) => ({ ...current, taskSort: event.target.value as ProjectViewState['taskSort'], taskPage: 1 }))} aria-label="排序生成记录">
            <option value="newest">最近生成</option><option value="oldest">最早生成</option>
          </select>
        </div>
        {tasks.length === 0 ? (
          <p className="text-gray">{workspace.taskSearch || workspace.taskStatus !== 'all' ? '没有符合条件的生成记录。' : '暂无生成记录。'}</p>
        ) : (
          <div className={styles.taskGrid}>
            {tasks.map((task) => {
              const returnTo = projectTaskReturnTo(task.id);
              const detailHref = taskDetailHref(task.id, returnTo);
              const reuseHref = taskReuseHref({ ...task, project_id: project.id }, returnTo);
              const enhanceHref = task.local_status === 'succeeded' && task.playable_available && !isEnhanceTask(task)
                && Boolean(task.video_card_id && task.duration && task.duration > 0)
                ? enhanceWorkspaceHref(returnTo, task.id) : null;
              return (
                <article id={`task-${task.id}`} key={task.id} className={styles.taskCard}>
                  <TaskVideoThumbnail taskId={task.id} thumbnailUrl={task.thumbnail_url} status={task.local_status}
                    deliveryStage={task.delivery_stage} previewAvailable={task.preview_available} stableDownloadReady={task.stable_download_ready}
                    retryAfterMs={task.retry_after_ms} provider={task.provider} generationMode={task.generation_mode} size="medium" href={detailHref} />
                  <div style={{ minWidth: 0 }}>
                    <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
                      <span className="video-card-status">{projectTaskStatusLabel(task)}</span>
                      <UserIdentityBadge user={taskOwnerUser(task)} size="sm" />
                      <RelativeTime value={task.created_at} />
                    </div>
                    <Link className={`link ${styles.taskPrompt}`} href={detailHref} title={task.prompt || task.id}><strong>{task.prompt || task.id}</strong></Link>
                    <p className="text-gray text-sm mt-2">{[task.model || task.provider, task.ratio, task.duration ? `${task.duration} 秒` : null, task.resolution].filter(Boolean).join(' · ') || '生成参数待同步'}</p>
                    <div className="flex items-center mt-2" style={{ gap: 14, flexWrap: 'wrap' }}>
                      {task.playable_available && <button type="button" className="link" onClick={() => setActivePreviewTask(task)}><Eye size={15} aria-hidden="true" /> 播放</button>}
                      {task.stable_download_ready && task.download_url && <a className="link" href={task.download_url}>下载</a>}
                      {reuseHref && <Link className="link" href={reuseHref}>复用参数</Link>}
                      {enhanceHref && <Link className="link" href={enhanceHref}>视频增强</Link>}
                      {isEnhanceTask(task) && <Link className="link" href={enhanceWorkspaceHref(returnTo)}>重新选择源视频</Link>}
                      <Link className="link" href={detailHref}>查看详情</Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {sectionPaginationIsCurrent && sectionPagination && <PaginationControls page={sectionPagination.page} totalPages={sectionPagination.total_pages}
          total={sectionPagination.total} pageSize={sectionPagination.page_size} busy={sectionLoading}
          onPageChange={(page) => setWorkspace((current) => ({ ...current, taskPage: page }))} label="条生成记录" />}
      </section>}

      {workspace.section === 'albums' && <section className={styles.section}>
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div><h2 className="section-title mb-0">参考图集</h2><p className="text-gray text-sm mt-2">保存和复用项目参考素材。</p></div>
          <Link className="btn btn-secondary" href={`/collections?scope=project&project_id=${encodeURIComponent(project.id)}&return_to=${encodeURIComponent(projectReturnTo)}`}>{permissions.can_manage_assets && project.status === 'active' ? '新建项目图集 / 查看图集' : '查看图集'}</Link>
        </div>
        {referenceAlbums.length === 0 ? <p className="text-gray">暂无项目图集</p> : (
          <div className={styles.albumGrid}>
            {referenceAlbums.map((album) => <article key={album.id} className={styles.album}>
              <Link href={`/collections/${encodeURIComponent(album.id)}?return_to=${encodeURIComponent(projectReturnTo)}`}>
                <strong>{album.name}</strong><span>{album.description || '项目参考图集'}</span>
                <span>{album.image_count} 张 · {statusLabel(album.status)}</span>
              </Link>
              <span className="text-gray text-sm">更新 <RelativeTime value={album.updated_at} /></span>
            </article>)}
          </div>
        )}
        {!permissions.can_manage_assets && <p className="text-gray text-sm mt-4">当前角色可查看或使用项目素材，但不能修改项目图集。</p>}
        {sectionPaginationIsCurrent && sectionPagination && <PaginationControls page={sectionPagination.page} totalPages={sectionPagination.total_pages}
          total={sectionPagination.total} pageSize={sectionPagination.page_size} busy={sectionLoading}
          onPageChange={(page) => setWorkspace((current) => ({ ...current, albumPage: page }))} label="个图集" />}
      </section>}

      {workspace.section === 'members' && <>
      <section className={styles.section}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title mb-0">项目成员</h2>
          <div className={styles.actions}>
            <span className="text-gray text-sm">{project.members.length} 人</span>
            {permissions.can_manage_members && <button className="btn btn-primary" type="button" onClick={createInvite} disabled={creatingInvite}>{creatingInvite ? '正在创建…' : '生成邀请链接'}</button>}
          </div>
        </div>
        <div className={styles.tableWrap}>
        <table className="table">
          <thead>
            <tr>
              <th>成员</th>
              <th>项目权限</th>
              <th>加入时间</th>
              {permissions.can_manage_members && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {project.members.map((member) => (
              <tr key={member.id}>
                <td>
                  <UserIdentityBadge
                    user={member.user}
                    size="sm"
                  />
                  <details className={styles.memberMeta}>
                    <summary>账号信息</summary>
                    <p>{member.user.email || '未登记邮箱'}</p>
                    <p>ID：{member.user.id}</p>
                    <p>{member.user.account_type} · {member.user.role}</p>
                  </details>
                </td>
                <td>{roleLabel(member.role)}</td>
                <td><RelativeTime value={member.joined_at} /></td>
                {permissions.can_manage_members && (
                  <td>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => removeMember(member.user_id, member.user.name || member.user.username || member.user.email || `ID ${member.user.id.slice(0, 8)}`)}
                      disabled={member.user_id === project.owner_user_id}
                    >
                      移除
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      {permissions.can_manage_members && (
        <details className={styles.disclosure}>
          <summary>通过用户 ID 添加成员</summary>
          <form onSubmit={addMember} className={styles.memberForm}>
            <input className="input" value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)} placeholder="用户 ID" aria-label="要添加的用户 ID" disabled={addingMember} />
            <select className="input" value={memberRole} onChange={(event) => setMemberRole(event.target.value)} aria-label="项目权限" disabled={addingMember}>
              <option value="editor">可编辑</option>
              <option value="member">可生成</option>
              <option value="viewer">仅查看</option>
            </select>
            <button className="btn btn-primary" type="submit" disabled={!memberUserId.trim() || addingMember}>{addingMember ? '正在添加…' : '添加成员'}</button>
          </form>
        </details>
      )}

      {permissions.can_manage_project && (
        <details className={styles.disclosure} open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
          <summary>项目设置</summary>
          <form onSubmit={updateProjectInfo} style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
            <input
              className="input"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="项目名称"
              disabled={project.type === 'personal' || savingProject}
              aria-label="项目名称"
            />
            <textarea
              className="input"
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
              placeholder="项目说明"
              rows={3}
              disabled={savingProject}
              aria-label="项目说明"
            />
            <button className="btn btn-primary" type="submit" disabled={!editName.trim() || savingProject}>
              {savingProject ? '正在保存…' : '保存信息'}
            </button>
          </form>
        </details>
      )}

      {permissions.can_manage_project && (
        <details className={styles.disclosure}>
          <summary>归档与删除</summary>
          <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
            {permissions.can_restore ? (
              <button className="btn btn-secondary" type="button" onClick={() => requestProjectAction('restore')}>
                恢复项目
              </button>
            ) : (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => requestProjectAction('archive')}
                disabled={!permissions.can_archive}
              >
                归档为只读
              </button>
            )}
            {canShowDeleteProjectAction(project) && (
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => requestProjectAction('delete')}
                disabled={!permissions.can_delete}
                title={permissions.can_delete ? '删除已核对为空的协作项目' : '存在内容、账务或历史记录，请使用归档'}
              >
                删除空项目
              </button>
            )}
          </div>
          <p className="text-gray text-sm mt-4">
            {project.type === 'team'
              ? '归档保留历史任务、图集与账务；只有没有业务内容、费用和历史记录的空项目可删除。'
              : '个人空间是系统保留项目，不提供删除操作。'}
          </p>
        </details>
      )}
      <button className="link" type="button" onClick={() => setWorkspace(DEFAULT_PROJECT_VIEW)}>重置查看设置</button>
      </>}

      {activePreviewTask && <MediaPreview
        src={activePreviewTask.play_url || `/api/video/play/${encodeURIComponent(activePreviewTask.id)}`}
        type="video"
        title={activePreviewTask.prompt || '项目视频'}
        poster={activePreviewTask.thumbnail_url || undefined}
        contentKey={`video_task:${activePreviewTask.id}`}
        previewKey={activePreviewTask.id}
        details={<div><p>{activePreviewTask.local_status}</p></div>}
        onClose={() => setActivePreviewTask(null)}
      />}

      {pendingProjectAction && project && (
        <ProjectActionConfirmModal
          action={pendingProjectAction}
          projectName={projectDisplayName(project)}
          meta={projectActionMeta(project)}
          busy={projectActionBusy}
          onCancel={() => setPendingProjectAction(null)}
          onConfirm={() => void confirmProjectAction()}
        />
      )}
      {pendingMemberRemoval?.identity === identityKey && loadedDataIdentity === identityKey && project && (
        <MemberRemovalConfirmModal
          memberName={pendingMemberRemoval.memberName}
          busy={memberRemovalBusy}
          onCancel={() => { if (!memberRemovalBusy) setPendingMemberRemoval(null); }}
          onConfirm={() => void confirmMemberRemoval()}
        />
      )}
    </div>
  );
}
