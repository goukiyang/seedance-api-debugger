'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeMouseHandler,
  type EdgeProps,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
import { AudioCard, GenerationCard, ImageCard, TextCard, VideoCard } from './nodes';
import { buildSeedanceRequest, exportCanvas, syncGenerationInputs } from './seedanceApi';
import { initialEdges, initialNodes } from './seedanceCanvas';
import type {
  GenerationCardData,
  ImageCardNode,
  NodeDataPatch,
  SeedanceCanvasNode,
  SeedanceModel,
  SeedanceGenerateRequest,
  VideoGenerateRequestPreview,
} from './types';

const nodeTypes: NodeTypes = {
  textCard: TextCard,
  imageCard: ImageCard,
  videoCard: VideoCard,
  audioCard: AudioCard,
  generationCard: GenerationCard,
  agentGenerationCard: GenerationCard,
};

type EdgeMenuOpenPayload = {
  edgeId: string;
  screenX: number;
  screenY: number;
};

type CanvasEdgeData = Record<string, unknown> & {
  onOpenMenu?: (payload: EdgeMenuOpenPayload) => void;
};

type CanvasActionEdge = Edge<CanvasEdgeData, 'actionEdge'>;

function ActionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps<CanvasActionEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const labelText = typeof label === 'string' && label.trim() ? label : 'input';

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    data?.onOpenMenu?.({
      edgeId: id,
      screenX: event.clientX,
      screenY: event.clientY,
    });
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="canvas-edge-label-button nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          title="点击管理这条连线"
          onClick={openMenu}
          onContextMenu={openMenu}
        >
          {labelText}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes: EdgeTypes = {
  actionEdge: ActionEdge,
};

const PROJECT_STORAGE_KEY = 'canvas_workspace_project_id';
const CANVAS_STORAGE_KEY = 'canvas_workspace_canvas_id';
const TAB_ID = 'canvas-workspace';

interface CreditSummary {
  balance: number;
  frozen_credits: number;
  available: number;
  monthly_used: number;
}

interface AuthMeResponse {
  user?: {
    role?: string | null;
  } | null;
}

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  status?: string;
  owner_user_id: string;
  my_role: string | null;
  can_generate?: boolean;
  can_manage_project?: boolean;
  owner?: { name: string | null; username: string | null };
  _count?: { tasks?: number; reference_albums?: number; members?: number };
}

interface CanvasSummary {
  id: string;
  title: string;
  updatedAt?: string;
  createdAt?: string;
  nodes: number;
  edges: number;
  projectId: string | null;
  projectName: string | null;
}

interface StoredCanvasDocument {
  id?: string;
  version: 1;
  title: string;
  activeGenerationId?: string;
  nodes: SeedanceCanvasNode[];
  edges: Edge[];
  viewport?: { x: number; y: number; zoom: number } | null;
}

function isStoredCanvasDocument(value: unknown): value is StoredCanvasDocument {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

function isInlineBrowserUrl(value: unknown) {
  return typeof value === 'string' && /^(data|blob|file):/i.test(value);
}

function prepareNodesForPersistence(nodes: SeedanceCanvasNode[]) {
  return nodes.map((node) => {
    if (
      (node.type === 'imageCard' || node.type === 'videoCard' || node.type === 'audioCard') &&
      node.data.publicUrl &&
      isInlineBrowserUrl(node.data.url)
    ) {
      return {
        ...node,
        data: {
          ...node.data,
          url: node.data.publicUrl,
        },
      } as SeedanceCanvasNode;
    }
    return node;
  });
}

function formatTime(value?: string) {
  if (!value) return '未保存';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatCredit(value?: number) {
  return Math.max(0, Math.floor(value || 0)).toString();
}

function safeDownloadName(value: string) {
  return (value.trim() || 'seedance-flow-canvas')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

function canvasPayload(
  title: string,
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  activeGenerationId: string,
  reactFlowInstance?: ReactFlowInstance<SeedanceCanvasNode> | null,
) {
  const persistedNodes = prepareNodesForPersistence(nodes);
  return {
    title: title.trim() || '未命名画布',
    document: {
      version: 1 as const,
      title: title.trim() || '未命名画布',
      nodes: syncGenerationInputs(persistedNodes, edges),
      edges,
      activeGenerationId,
      viewport: reactFlowInstance?.getViewport() ?? null,
    },
  };
}

function edgeId(source: string, target: string) {
  return `${source}->${target}`;
}

function edgeLabelForSource(node?: SeedanceCanvasNode) {
  if (!node) return 'input';
  if (node.type === 'textCard') return 'prompt';
  if (node.type === 'imageCard') return node.data.refId || '@图片';
  if (node.type === 'videoCard') return node.data.refId || '@视频';
  if (node.type === 'audioCard') return node.data.refId || '@音频';
  return 'output';
}

function isGenerationNode(node?: SeedanceCanvasNode) {
  return node?.type === 'generationCard' || node?.type === 'agentGenerationCard';
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function apiUrl(path: string) {
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.origin).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPath(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function apiError(payload: unknown, fallback: string) {
  const direct = isRecord(payload) && typeof payload.error === 'string' ? payload.error : undefined;
  const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message : getPath(payload, ['data', 'message']);
  const code = getPath(payload, ['data', 'code']);
  if (direct) return direct;
  if (typeof message === 'string') return typeof code === 'string' ? `${message} (${code})` : message;
  return fallback;
}

function extractTaskId(data: unknown) {
  const candidates = [getPath(data, ['output', 'task_id']), getPath(data, ['task_id']), getPath(data, ['id']), getPath(data, ['data', 'output', 'task_id']), getPath(data, ['data', 'id'])];
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function extractTaskStatus(data: unknown) {
  const candidates = [getPath(data, ['output', 'task_status']), getPath(data, ['task_status']), getPath(data, ['status']), getPath(data, ['local_status']), getPath(data, ['data', 'output', 'task_status']), getPath(data, ['data', 'status'])];
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function findFirstVideoUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && /^https?:\/\//.test(value) && /\.(mp4|mov|webm)(\?|$)/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstVideoUrl(item);
      if (found) return found;
    }
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findFirstVideoUrl(item);
      if (found) return found;
    }
  }
  return undefined;
}

function extractVideoUrl(data: unknown) {
  const candidates = [
    getPath(data, ['output', 'video_url']),
    getPath(data, ['output', 'video_urls', '0']),
    getPath(data, ['content', 'video_url']),
    getPath(data, ['data', 'content', 'video_url']),
    getPath(data, ['data', 'output', 'video_url']),
    getPath(data, ['data', 'output', 'video_urls', '0']),
    getPath(data, ['result_video_url']),
  ];
  return candidates.find((value): value is string => typeof value === 'string' && /^https?:\/\//.test(value)) ?? findFirstVideoUrl(data);
}

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

function nodeDisplayLabel(node?: SeedanceCanvasNode) {
  if (!node) return '未知节点';
  return node.data.title || node.id;
}

function normalizeCanvasSummary(value: unknown): CanvasSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null;
  return {
    id: value.id,
    title: value.title,
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    createdAt: typeof value.created_at === 'string' ? value.created_at : typeof value.createdAt === 'string' ? value.createdAt : undefined,
    nodes: typeof value.node_count === 'number' ? value.node_count : typeof value.nodes === 'number' ? value.nodes : 0,
    edges: typeof value.edge_count === 'number' ? value.edge_count : typeof value.edges === 'number' ? value.edges : 0,
    projectId: typeof value.project_id === 'string' ? value.project_id : null,
    projectName: isRecord(value.project) && typeof value.project.name === 'string' ? value.project.name : null,
  };
}

async function dataUrlToFile(url: string, fileName: string, mimeType: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  return new File([blob], fileName, { type: mimeType || blob.type || 'application/octet-stream' });
}

async function uploadCanvasAsset(fileData: { url: string; fileName: string; mimeType: string }) {
  const file = await dataUrlToFile(fileData.url, fileData.fileName, fileData.mimeType);
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(apiUrl('/api/assets/upload'), {
    method: 'POST',
    body: formData,
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || payload.success !== true || !isRecord(payload.asset)) {
    throw new Error(apiError(payload, '素材上传失败。'));
  }
  const asset = payload.asset;
  const assetId = typeof asset.id === 'string' ? asset.id : '';
  const publicUrl = typeof asset.originalUrl === 'string' ? asset.originalUrl : '';
  if (!assetId || !publicUrl) {
    throw new Error('素材上传成功，但缺少 assetId 或 originalUrl。');
  }
  return { assetId, publicUrl };
}

async function resetWorkspaceAssets() {
  const response = await fetch(apiUrl('/api/workspace/assets'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tab-id': TAB_ID,
    },
    body: JSON.stringify({ replace: true }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(apiError(payload, '清空当前工作台失败。'));
}

async function addImageAssetsToWorkspace(assetIds: string[]) {
  await resetWorkspaceAssets();
  for (const assetId of assetIds) {
    const response = await fetch(apiUrl('/api/workspace/assets'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tab-id': TAB_ID,
      },
      body: JSON.stringify({ assetId, role: 'reference_image' }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(apiError(payload, '同步参考图到当前工作台失败。'));
    }
  }
}

function normalizeResolution(quality: SeedanceGenerateRequest['quality']) {
  return quality === '1080p' ? '720p' : quality;
}

function buildTaskPayload(
  preview: VideoGenerateRequestPreview,
  syncedNodes: SeedanceCanvasNode[],
  nodeId: string,
  projectId: string,
) {
  if (preview.provider !== 'volcengine-ark') {
    throw new Error('Wan 2.7 预览已迁入，但站内正式任务链路目前只接 Seedance 2.0 / Fast。');
  }

  const imageNodes = preview.references
    .filter((item) => item.type === 'image')
    .map((item) => syncedNodes.find((node) => node.id === item.nodeId))
    .filter((node): node is ImageCardNode => !!node && node.type === 'imageCard');

  const imageAssetIds = imageNodes.map((node) => node.data.assetId).filter((value): value is string => Boolean(value));
  if (imageNodes.length !== imageAssetIds.length) {
    throw new Error('有图片卡尚未完成平台上传，请重新上传后再生成。');
  }

  const videoUrls = preview.references
    .filter((item) => item.type === 'video' && typeof item.url === 'string' && item.url.length > 0)
    .map((item) => item.url as string)
    .slice(0, 3);
  const audioUrls = preview.references
    .filter((item) => item.type === 'audio' && typeof item.url === 'string' && item.url.length > 0)
    .map((item) => item.url as string)
    .slice(0, 3);

  const imageContents = preview.body.content.filter(
    (item): item is Extract<SeedanceGenerateRequest['body']['content'][number], { type: 'image_url' }> => item.type === 'image_url',
  );
  const firstFrameUrl = imageContents.find((item) => item.role === 'first_frame')?.image_url.url;
  const lastFrameUrl = imageContents.find((item) => item.role === 'last_frame')?.image_url.url;

  if (videoUrls.some((url) => !/^https?:\/\//.test(url)) || audioUrls.some((url) => !/^https?:\/\//.test(url))) {
    throw new Error('视频和音频参考必须先上传到可外网访问的地址，当前素材还不能直接提交。');
  }

  const referenceMode = preview.referenceMode ?? 'omni-reference';
  const basePayload = {
    prompt: preview.prompt,
    project_id: projectId,
    ratio: preview.aspectRatio,
    duration: Math.max(4, preview.durationSec),
    resolution: normalizeResolution(preview.quality),
    generate_audio: preview.body.generate_audio,
    reference_video_urls: videoUrls,
    reference_audio_urls: audioUrls,
    idempotency_key: `canvas:${nodeId}:${Date.now()}`,
  };

  if (referenceMode === 'first-last-frame') {
    if (!firstFrameUrl) {
      throw new Error('首尾帧模式至少需要 1 张首帧图片。');
    }
    if (!/^https?:\/\//.test(firstFrameUrl) || (lastFrameUrl && !/^https?:\/\//.test(lastFrameUrl))) {
      throw new Error('首尾帧图片需要先转换成可外网访问的地址后才能提交正式任务。');
    }
    return {
      syncWorkspaceImageIds: [] as string[],
      payload: {
        ...basePayload,
        generation_mode: 'first_last_frame',
        first_frame_url: firstFrameUrl,
        last_frame_url: lastFrameUrl,
      },
    };
  }

  return {
    syncWorkspaceImageIds: imageAssetIds,
    payload: {
      ...basePayload,
      generation_mode: 'all_in_one_reference',
    },
  };
}

function CanvasWorkspace() {
  const [nodes, setNodes, onNodesChange] = useNodesState<SeedanceCanvasNode>(syncGenerationInputs(initialNodes, initialEdges));
  const [edges, setEdges] = useEdgesState(initialEdges);
  const [activeGenerationId, setActiveGenerationId] = useState('');
  const [preview, setPreview] = useState(() => buildSeedanceRequest(initialNodes, initialEdges, ''));

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectMessage, setProjectMessage] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [projectConfirmAction, setProjectConfirmAction] = useState<'delete' | 'archive' | null>(null);
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [canExportCanvasJson, setCanExportCanvasJson] = useState(false);

  const [canvasList, setCanvasList] = useState<CanvasSummary[]>([]);
  const [currentCanvasId, setCurrentCanvasId] = useState('');
  const [canvasTitle, setCanvasTitle] = useState('未命名画布');
  const [canvasStatus, setCanvasStatus] = useState('尚未保存');
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance<SeedanceCanvasNode> | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    screenX: number;
    screenY: number;
    flowPosition: XYPosition;
  } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{
    edgeId: string;
    sourceId: string;
    targetId: string;
    label: string;
    screenX: number;
    screenY: number;
  } | null>(null);

  const duplicateProjectNames = useMemo(
    () =>
      projects.reduce<Record<string, number>>((counts, project) => {
        const name = projectDisplayName(project);
        counts[name] = (counts[name] || 0) + 1;
        return counts;
      }, {}),
    [projects],
  );

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const currentCanvasSummary = useMemo(
    () => canvasList.find((canvas) => canvas.id === currentCanvasId) ?? null,
    [canvasList, currentCanvasId],
  );

  const selectedProjectLabel = selectedProject ? projectDisplayLabel(selectedProject, duplicateProjectNames) : '未选择项目';
  const selectedProjectTaskCount = selectedProject?._count?.tasks || 0;
  const selectedProjectAlbumCount = selectedProject?._count?.reference_albums || 0;
  const selectedProjectHasContent = selectedProjectTaskCount > 0 || selectedProjectAlbumCount > 0;
  const selectedProjectCanRemove = Boolean(
    selectedProject
    && selectedProject.can_manage_project
    && selectedProject.type !== 'personal'
    && selectedProject.type !== 'system',
  );
  const selectedProjectTypeLabel = selectedProject?.type === 'personal'
    ? '个人空间'
    : selectedProject?.type === 'team'
      ? '团队项目'
      : selectedProject?.type || '项目';
  const selectedProjectRoleLabel = selectedProject?.my_role === 'owner'
    ? '所有者'
    : selectedProject?.my_role === 'admin'
      ? '管理员'
      : selectedProject?.my_role === 'member'
        ? '成员'
        : selectedProject?.my_role || '可生成';
  const projectRemovalLabel = selectedProjectHasContent ? '归档' : '删除';
  const projectRemovalTitle = !selectedProject
    ? '先选择项目'
    : selectedProject.type === 'personal' || selectedProject.type === 'system'
      ? '默认项目不能删除'
      : !selectedProject.can_manage_project
        ? '你没有权限管理这个项目'
        : selectedProjectHasContent
          ? '项目已有历史内容，只能归档'
          : '删除空项目';
  const currentCanvasLabel = currentCanvasSummary?.title || canvasTitle || '未命名画布';
  const currentCanvasMeta = currentCanvasSummary?.updatedAt ? `最近保存 ${formatTime(currentCanvasSummary.updatedAt)}` : '尚未保存';

  const applyCanvasDocument = useCallback((document: StoredCanvasDocument) => {
    const nextEdges = Array.isArray(document.edges) ? document.edges : [];
    const syncedNodes = syncGenerationInputs(Array.isArray(document.nodes) ? document.nodes : [], nextEdges);
    const nextActive = document.activeGenerationId && syncedNodes.some((node) => node.id === document.activeGenerationId && isGenerationNode(node))
      ? document.activeGenerationId
      : syncedNodes.find(isGenerationNode)?.id ?? '';
    const nextNodes = syncedNodes.map((node) => ({
      ...node,
      selected: nextActive ? node.id === nextActive : false,
    })) as SeedanceCanvasNode[];

    setCanvasTitle(document.title || '未命名画布');
    setActiveGenerationId(nextActive);
    setEdges(nextEdges);
    setNodes(nextNodes);
    setPreview(buildSeedanceRequest(nextNodes, nextEdges, nextActive));

    if (document.viewport && reactFlowInstance) {
      reactFlowInstance.setViewport(document.viewport, { duration: 0 });
    }
  }, [reactFlowInstance, setEdges, setNodes]);

  const newBlankCanvas = useCallback(() => {
    setCurrentCanvasId('');
    setCanvasTitle('未命名画布');
    setActiveGenerationId('');
    setEdges([]);
    setNodes([]);
    setPreview(buildSeedanceRequest([], [], ''));
    setCanvasStatus('新画布，尚未保存');
  }, [setEdges, setNodes]);

  const loadProjects = useCallback(async (options: { preferredProjectId?: string | null; keepSelected?: boolean } = {}) => {
    setLoadingProjects(true);
    try {
      const response = await fetch(apiUrl('/api/projects'), { cache: 'no-store' });
      if (response.status === 401) {
        window.location.href = '/login?next=/generate/canvas';
        return;
      }

      const payload = await response.json();
      const availableProjects: ProjectOption[] = (payload.projects || []).filter(
        (project: ProjectOption) => project.can_generate !== false,
      );
      setProjects(availableProjects);

      const rememberedProjectId = window.localStorage.getItem(PROJECT_STORAGE_KEY) || '';
      const preferredId = options.preferredProjectId || rememberedProjectId;
      setSelectedProjectId((current) => {
        const preferredProject = preferredId ? availableProjects.find((project) => project.id === preferredId) : null;
        if (preferredProject) return preferredProject.id;

        const currentProject = options.keepSelected !== false && current
          ? availableProjects.find((project) => project.id === current)
          : null;
        if (currentProject) return currentProject.id;

        return (availableProjects.find((project) => project.type === 'personal') || availableProjects[0])?.id || '';
      });
    } catch {
      setProjectMessage({ type: 'error', text: '项目列表加载失败，请刷新后重试。' });
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  const loadCanvas = useCallback(async (id: string, options?: { silent?: boolean }) => {
    if (!id) return;
    const response = await fetch(apiUrl(`/api/canvases/${encodeURIComponent(id)}`), { cache: 'no-store' });
    const payload: unknown = await response.json();
    const detail = isRecord(payload) && isRecord(payload.canvas) ? payload.canvas : null;
    const document = detail?.document;
    if (!response.ok || !detail || !isStoredCanvasDocument(document)) {
      throw new Error(apiError(payload, '加载画布失败。'));
    }

    const summary = normalizeCanvasSummary(detail);
    setCurrentCanvasId(id);
    if (summary?.projectId) setSelectedProjectId(summary.projectId);
    applyCanvasDocument(document);
    if (!options?.silent) {
      setCanvasStatus(`已加载：${document.title}`);
    }
  }, [applyCanvasDocument]);

  const refreshCanvasList = useCallback(async (preferredCanvasId?: string) => {
    const query = selectedProjectId ? `?project_id=${encodeURIComponent(selectedProjectId)}` : '';
    const response = await fetch(apiUrl(`/api/canvases${query}`), { cache: 'no-store' });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload) || !Array.isArray(payload.canvases)) {
      throw new Error(apiError(payload, '读取画布列表失败。'));
    }

    const nextList = payload.canvases.map(normalizeCanvasSummary).filter((item): item is CanvasSummary => Boolean(item));
    setCanvasList(nextList);

    const rememberedId = preferredCanvasId || window.localStorage.getItem(CANVAS_STORAGE_KEY) || '';
    const nextId = rememberedId && nextList.some((canvas) => canvas.id === rememberedId)
      ? rememberedId
      : nextList[0]?.id || '';

    if (nextId) {
      await loadCanvas(nextId, { silent: true });
      setCanvasStatus(`已加载：${nextList.find((canvas) => canvas.id === nextId)?.title || '画布'}`);
    } else {
      newBlankCanvas();
    }
  }, [loadCanvas, newBlankCanvas, selectedProjectId]);

  const handleCreateProject = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) {
      setProjectMessage({ type: 'error', text: '项目名称不能为空。' });
      return;
    }

    setProjectBusy(true);
    setProjectMessage(null);
    try {
      const response = await fetch(apiUrl('/api/projects'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'team' }),
      });
      const payload = await response.json();
      if (!response.ok || !isRecord(payload.project) || typeof payload.project.id !== 'string') {
        throw new Error(apiError(payload, '新建项目失败。'));
      }

      setProjectName('');
      setProjectCreateOpen(false);
      setProjectConfirmAction(null);
      setProjectMessage({ type: 'success', text: `已新建项目「${typeof payload.project.name === 'string' ? payload.project.name : name}」。` });
      await loadProjects({ preferredProjectId: payload.project.id, keepSelected: false });
    } catch (error) {
      setProjectMessage({ type: 'error', text: error instanceof Error ? error.message : '新建项目失败。' });
    } finally {
      setProjectBusy(false);
    }
  }, [loadProjects, projectName]);

  const handleProjectRemoval = useCallback(async () => {
    if (!selectedProject) return;

    if (selectedProject.type === 'personal' || selectedProject.type === 'system') {
      setProjectMessage({ type: 'error', text: '默认项目不能删除。' });
      return;
    }
    if (!selectedProject.can_manage_project) {
      setProjectMessage({ type: 'error', text: '你没有权限管理这个项目。' });
      return;
    }

    const action = selectedProjectHasContent ? 'archive' : 'delete';
    if (projectConfirmAction !== action) {
      setProjectConfirmAction(action);
      setProjectMessage({
        type: 'info',
        text: action === 'archive'
          ? `项目「${projectDisplayName(selectedProject)}」已有任务或图集，再点一次归档，历史记录会保留。`
          : `再点一次删除空项目「${projectDisplayName(selectedProject)}」。`,
      });
      return;
    }

    setProjectBusy(true);
    setProjectMessage(null);
    try {
      const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProject.id)}`), {
        method: action === 'archive' ? 'PATCH' : 'DELETE',
        headers: action === 'archive' ? { 'Content-Type': 'application/json' } : undefined,
        body: action === 'archive' ? JSON.stringify({ action: 'archive' }) : undefined,
      });
      const payload = await response.json();
      if (!response.ok) {
        if (action === 'delete' && isRecord(payload) && typeof payload.error === 'string' && payload.error.includes('归档')) {
          setProjectConfirmAction('archive');
          setProjectMessage({ type: 'info', text: '项目已有历史内容，删除会断链；请再次点击归档。' });
          return;
        }
        throw new Error(apiError(payload, '项目操作失败。'));
      }

      setProjectConfirmAction(null);
      setProjectMessage({
        type: 'success',
        text: action === 'archive'
          ? `已归档项目「${projectDisplayName(selectedProject)}」。`
          : `已删除项目「${projectDisplayName(selectedProject)}」。`,
      });
      await loadProjects({ keepSelected: false });
    } catch (error) {
      setProjectMessage({ type: 'error', text: error instanceof Error ? error.message : '项目操作失败。' });
    } finally {
      setProjectBusy(false);
    }
  }, [loadProjects, projectConfirmAction, selectedProject, selectedProjectHasContent]);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: AuthMeResponse) => {
        if (!cancelled) setCanExportCanvasJson(payload.user?.role === 'admin');
      })
      .catch(() => {
        if (!cancelled) setCanExportCanvasJson(false);
      });

    fetch('/api/me/credits', { cache: 'no-store' })
      .then((response) => {
        if (response.status === 401) {
          window.location.href = '/login?next=/generate/canvas';
          return null;
        }
        return response.json();
      })
      .then((payload) => {
        if (!cancelled && payload) setCredits(payload);
      })
      .catch(() => {});

    void loadProjects({ keepSelected: false });

    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
    setProjectConfirmAction(null);
    void refreshCanvasList().catch((error) => {
      setCanvasStatus(error instanceof Error ? error.message : '读取画布列表失败。');
    });
  }, [refreshCanvasList, selectedProjectId]);

  useEffect(() => {
    if (!currentCanvasId) {
      window.localStorage.removeItem(CANVAS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CANVAS_STORAGE_KEY, currentCanvasId);
  }, [currentCanvasId]);

  useEffect(() => {
    if (!projectMessage || projectMessage.type === 'error') return;
    const timeoutId = window.setTimeout(() => {
      setProjectMessage(null);
      if (projectMessage.type === 'info') setProjectConfirmAction(null);
    }, 3600);
    return () => window.clearTimeout(timeoutId);
  }, [projectMessage]);

  const refreshPreviewFor = useCallback((nextNodes: SeedanceCanvasNode[], nextEdges: Edge[], generationId = activeGenerationId) => {
    const syncedNodes = syncGenerationInputs(nextNodes, nextEdges);
    setPreview(buildSeedanceRequest(syncedNodes, nextEdges, generationId));
    return syncedNodes;
  }, [activeGenerationId]);

  const generationExists = useCallback(
    (id: string, sourceNodes = nodes) => sourceNodes.some((node) => node.id === id && isGenerationNode(node)),
    [nodes],
  );

  const activeOrFirstGenerationId = useCallback((sourceNodes: SeedanceCanvasNode[]) => {
    if (generationExists(activeGenerationId, sourceNodes)) return activeGenerationId;
    return sourceNodes.find(isGenerationNode)?.id ?? '';
  }, [activeGenerationId, generationExists]);

  const handleDataChange = useCallback(
    (nodeId: string, patch: NodeDataPatch) => {
      setNodes((currentNodes) => {
        const patchedNodes = currentNodes.map((node) => {
          let normalizedPatch = patch;
          if (node.id === nodeId && isGenerationNode(node)) {
            if (patch.model === 'wan2.7-t2v-2026-04-25' || patch.model === 'wan2.7-i2v-2026-04-25' || patch.model === 'wan2.7-r2v') {
              normalizedPatch = { ...patch, quality: node.data.quality === '1080p' ? '1080p' : '720p' };
            } else if ((patch.model === 'seedance-2.0' || patch.model === 'seedance-2.0-fast') && node.data.quality === '1080p') {
              normalizedPatch = { ...patch, quality: '720p' };
            }
          }
          return node.id === nodeId ? { ...node, data: { ...node.data, ...normalizedPatch } } : node;
        }) as SeedanceCanvasNode[];
        return refreshPreviewFor(patchedNodes, edges);
      });
    },
    [edges, refreshPreviewFor, setNodes],
  );

  const handleImageChange = useCallback(
    (nodeId: string, image: { url: string; fileName: string; mimeType: string }) => {
      handleDataChange(nodeId, {
        ...image,
        publicUrl: undefined,
        assetId: undefined,
        uploadStatus: 'uploading',
        uploadError: undefined,
      });

      void uploadCanvasAsset(image)
        .then(({ assetId, publicUrl }) => {
          handleDataChange(nodeId, {
            assetId,
            publicUrl,
            url: image.url,
            fileName: image.fileName,
            mimeType: image.mimeType,
            uploadStatus: 'uploaded',
            uploadError: undefined,
          });
        })
        .catch((error) => {
          handleDataChange(nodeId, {
            uploadStatus: 'failed',
            uploadError: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [handleDataChange],
  );

  const handleMediaChange = useCallback(
    (nodeId: string, media: { url: string; fileName: string; mimeType: string }) => {
      handleDataChange(nodeId, {
        ...media,
        publicUrl: undefined,
        assetId: undefined,
        uploadStatus: 'uploading',
        uploadError: undefined,
      });

      void uploadCanvasAsset(media)
        .then(({ assetId, publicUrl }) => {
          handleDataChange(nodeId, {
            assetId,
            publicUrl,
            url: media.url,
            fileName: media.fileName,
            mimeType: media.mimeType,
            uploadStatus: 'uploaded',
            uploadError: undefined,
          });
        })
        .catch((error) => {
          handleDataChange(nodeId, {
            uploadStatus: 'failed',
            uploadError: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [handleDataChange],
  );

  const patchGenerationData = useCallback((nodeId: string, patch: Partial<GenerationCardData>) => {
    setNodes((currentNodes) => currentNodes.map((node) => (
      node.id === nodeId && isGenerationNode(node)
        ? { ...node, data: { ...node.data, ...patch } }
        : node
    )) as SeedanceCanvasNode[]);
  }, [setNodes]);

  const persistGenerationResult = useCallback(async (nodeId: string, patch: Partial<GenerationCardData>, baseNodes: SeedanceCanvasNode[], baseEdges: Edge[]) => {
    if (!currentCanvasId) return;
    const patchedNodes = baseNodes.map((node) => (
      node.id === nodeId && isGenerationNode(node)
        ? { ...node, data: { ...node.data, ...patch } }
        : node
    )) as SeedanceCanvasNode[];
    const response = await fetch(apiUrl(`/api/canvases/${encodeURIComponent(currentCanvasId)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...canvasPayload(canvasTitle, patchedNodes, baseEdges, nodeId, reactFlowInstance),
        project_id: selectedProjectId,
      }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(apiError(payload, '视频已生成，但自动保存画布失败。'));
    }
    await refreshCanvasList(currentCanvasId);
  }, [canvasTitle, currentCanvasId, reactFlowInstance, refreshCanvasList, selectedProjectId]);

  const handleGeneratePreview = useCallback(async (nodeId: string) => {
    setActiveGenerationId(nodeId);

    const syncedNodes = syncGenerationInputs(nodes, edges);
    const nextPreview = buildSeedanceRequest(syncedNodes, edges, nodeId) as VideoGenerateRequestPreview | null;
    setPreview(nextPreview);

    if (!nextPreview) {
      patchGenerationData(nodeId, { status: 'failed', generationNotice: '未能生成请求，请检查卡片配置和输入素材。' });
      return;
    }
    if (!selectedProjectId) {
      patchGenerationData(nodeId, { status: 'failed', generationNotice: '请先选择当前项目。' });
      return;
    }

    patchGenerationData(nodeId, {
      status: 'generating',
      generationNotice: '正在创建正式任务并冻结点数…',
      taskId: undefined,
      videoUrl: undefined,
    });

    try {
      const { payload, syncWorkspaceImageIds } = buildTaskPayload(nextPreview, syncedNodes, nodeId, selectedProjectId);
      await addImageAssetsToWorkspace(syncWorkspaceImageIds);

      const createResponse = await fetch(apiUrl('/api/tasks/create'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': TAB_ID,
        },
        body: JSON.stringify(payload),
      });
      const createPayload: unknown = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(apiError(createPayload, '创建任务失败。'));
      }

      const taskId = extractTaskId(createPayload);
      if (!taskId) throw new Error('任务创建成功，但没有返回内部 task id。');

      patchGenerationData(nodeId, {
        status: 'generating',
        taskId,
        generationNotice: `任务已创建：${taskId}。正在轮询结果…`,
      });

      for (let attempt = 1; attempt <= 90; attempt += 1) {
        await sleep(4000);

        const pollResponse = await fetch(apiUrl(`/api/video/status/${encodeURIComponent(taskId)}`), {
          headers: { 'x-tab-id': TAB_ID },
          cache: 'no-store',
        });
        const pollPayload: unknown = await pollResponse.json();
        if (!pollResponse.ok) {
          throw new Error(apiError(pollPayload, '查询任务状态失败。'));
        }

        const status = (extractTaskStatus(pollPayload) || '').toLowerCase();
        const videoUrl = extractVideoUrl(pollPayload);

        if (videoUrl && (status === 'succeeded' || status === 'done' || status === 'success')) {
          const donePatch = {
            status: 'done' as const,
            generationNotice: currentCanvasId ? '视频生成完成，画布结果已自动更新。' : '视频生成完成。',
            taskId,
            videoUrl,
          };
          patchGenerationData(nodeId, donePatch);
          await persistGenerationResult(nodeId, donePatch, syncedNodes, edges);
          return;
        }

        if (status === 'failed' || status === 'cancelled') {
          throw new Error(
            (isRecord(pollPayload) && typeof pollPayload.error_message === 'string' && pollPayload.error_message)
            || apiError(pollPayload, `任务失败：${status}`),
          );
        }

        patchGenerationData(nodeId, {
          generationNotice: `任务 ${taskId} 生成中… 当前状态：${status || 'submitted'}，第 ${attempt} 次轮询。`,
        });
      }

      throw new Error('轮询超时，请到“我的任务”继续查看。');
    } catch (error) {
      patchGenerationData(nodeId, {
        status: 'failed',
        generationNotice: error instanceof Error ? error.message : String(error),
      });
    }
  }, [currentCanvasId, edges, nodes, patchGenerationData, persistGenerationResult, selectedProjectId]);

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const nextEdges = edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
      setEdges(nextEdges);
      setNodes((currentNodes) => {
        const nextNodes = currentNodes.filter((node) => node.id !== nodeId) as SeedanceCanvasNode[];
        const nextActive = activeOrFirstGenerationId(nextNodes);
        if (nextActive !== activeGenerationId) setActiveGenerationId(nextActive);
        return refreshPreviewFor(nextNodes, nextEdges, nextActive);
      });
    },
    [activeGenerationId, activeOrFirstGenerationId, edges, refreshPreviewFor, setEdges, setNodes],
  );

  const handleDuplicateNode = useCallback(
    (nodeId: string) => {
      const sourceNode = nodes.find((node) => node.id === nodeId);
      if (!sourceNode) return;
      const newId = `${sourceNode.type.replace('Card', '')}-${Date.now()}`;
      const sourceIsGeneration = isGenerationNode(sourceNode);
      const clonedNode = {
        ...sourceNode,
        id: newId,
        selected: sourceIsGeneration,
        position: { x: sourceNode.position.x + 36, y: sourceNode.position.y + 36 },
        data: {
          ...sourceNode.data,
          title: `${sourceNode.data.title ?? '卡片'} Copy`,
        },
      } as SeedanceCanvasNode;

      if (sourceNode.type === 'imageCard') {
        const imageIndex = nodes.filter((node) => node.type === 'imageCard').length + 1;
        const isFrameCard = sourceNode.data.variant === 'frame';
        clonedNode.data = {
          ...clonedNode.data,
          refId: `@图片${imageIndex}`,
          title: isFrameCard ? sourceNode.data.title : `图片卡片｜@图片${imageIndex}`,
        };
      }
      if (sourceNode.type === 'videoCard') {
        const videoIndex = nodes.filter((node) => node.type === 'videoCard').length + 1;
        clonedNode.data = {
          ...clonedNode.data,
          refId: `@视频${videoIndex}`,
          title: `视频卡片｜@视频${videoIndex}`,
        };
      }
      if (sourceNode.type === 'audioCard') {
        const audioIndex = nodes.filter((node) => node.type === 'audioCard').length + 1;
        clonedNode.data = {
          ...clonedNode.data,
          refId: `@音频${audioIndex}`,
          title: `音频卡片｜@音频${audioIndex}`,
        };
      }

      const nextNodes = sourceIsGeneration
        ? nodes.map((node) => ({ ...node, selected: false }) as SeedanceCanvasNode).concat(clonedNode)
        : [...nodes, clonedNode];
      const nextEdges = edges;
      if (sourceIsGeneration) {
        setActiveGenerationId(newId);
      }
      setEdges(nextEdges);
      setNodes(refreshPreviewFor(nextNodes, nextEdges, sourceIsGeneration ? newId : activeGenerationId));
    },
    [activeGenerationId, edges, nodes, refreshPreviewFor, setEdges, setNodes],
  );

  const nodesWithCallbacks = useMemo(() => {
    const textAssets = nodes
      .filter((node) => node.type === 'textCard')
      .map((node) => ({
        nodeId: node.id,
        label: node.data.title || node.id,
        detail: node.data.role,
      }));
    const imageAssets = nodes
      .filter((node) => node.type === 'imageCard')
      .map((node) => ({
        nodeId: node.id,
        label: node.data.variant === 'frame' ? `${node.data.title || (node.data.usage === 'end-frame' ? '尾帧' : '首帧')} · ${node.data.refId}` : `${node.data.refId} · ${node.data.title}`,
        detail: node.data.fileName || (node.data.variant === 'frame' ? (node.data.usage === 'end-frame' ? 'last_frame' : 'first_frame') : node.data.title || '图片'),
        url: node.data.publicUrl || node.data.url,
        publicUrl: node.data.publicUrl,
        refId: node.data.refId,
      }));
    const videoAssets = nodes
      .filter((node) => node.type === 'videoCard')
      .map((node) => ({
        nodeId: node.id,
        label: `${node.data.refId} · ${node.data.title}`,
        detail: node.data.fileName || '视频',
        url: node.data.publicUrl || node.data.url,
        publicUrl: node.data.publicUrl,
        refId: node.data.refId,
      }));
    const audioAssets = nodes
      .filter((node) => node.type === 'audioCard')
      .map((node) => ({
        nodeId: node.id,
        label: `${node.data.refId} · ${node.data.title}`,
        detail: node.data.fileName || '音频',
        url: node.data.publicUrl || node.data.url,
        publicUrl: node.data.publicUrl,
        refId: node.data.refId,
      }));

    return syncGenerationInputs(nodes, edges).map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(isGenerationNode(node) ? { assetOptions: { text: textAssets, image: imageAssets, video: videoAssets, audio: audioAssets } } : {}),
        onDataChange: handleDataChange,
        onDelete: handleDeleteNode,
        onDuplicate: handleDuplicateNode,
        ...(isGenerationNode(node) ? { onGeneratePreview: handleGeneratePreview } : {}),
        ...(node.type === 'imageCard' ? { onImageChange: handleImageChange } : {}),
        ...(node.type === 'videoCard' || node.type === 'audioCard' ? { onMediaChange: handleMediaChange } : {}),
      },
    })) as SeedanceCanvasNode[];
  }, [edges, handleDataChange, handleDeleteNode, handleDuplicateNode, handleGeneratePreview, handleImageChange, handleMediaChange, nodes]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const nextEdges = addEdge(
        {
          ...connection,
          id: edgeId(connection.source, connection.target),
          label: edgeLabelForSource(nodes.find((node) => node.id === connection.source)),
          animated: true,
        },
        edges,
      );
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (isGenerationNode(targetNode)) setActiveGenerationId(targetNode.id);
      setEdges(nextEdges);
      setNodes((currentNodes) => refreshPreviewFor(currentNodes, nextEdges, isGenerationNode(targetNode) ? targetNode.id : activeGenerationId));
    },
    [activeGenerationId, edges, nodes, refreshPreviewFor, setEdges, setNodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((currentEdges) => {
        const nextEdges = applyEdgeChanges(changes, currentEdges);
        setNodes((currentNodes) => refreshPreviewFor(currentNodes, nextEdges));
        return nextEdges;
      });
    },
    [refreshPreviewFor, setEdges, setNodes],
  );

  const openEdgeMenu = useCallback((payload: EdgeMenuOpenPayload) => {
    const edge = edges.find((item) => item.id === payload.edgeId);
    if (!edge) return;
    setContextMenu(null);
    setEdgeMenu({
      edgeId: edge.id,
      sourceId: edge.source,
      targetId: edge.target,
      label: typeof edge.label === 'string' && edge.label.trim() ? edge.label : 'input',
      screenX: payload.screenX,
      screenY: payload.screenY,
    });
  }, [edges]);

  const edgesWithActions = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: 'actionEdge',
        data: {
          ...(edge.data || {}),
          onOpenMenu: openEdgeMenu,
        },
      })),
    [edges, openEdgeMenu],
  );

  const handleEdgeContextMenu: EdgeMouseHandler = useCallback((event, edge) => {
    event.preventDefault();
    event.stopPropagation();
    openEdgeMenu({ edgeId: edge.id, screenX: event.clientX, screenY: event.clientY });
  }, [openEdgeMenu]);

  const handleNodeClick: NodeMouseHandler<SeedanceCanvasNode> = useCallback((_, node) => {
    setContextMenu(null);
    setEdgeMenu(null);
    if (!isGenerationNode(node)) return;
    setActiveGenerationId(node.id);
    setNodes((currentNodes) => refreshPreviewFor(currentNodes, edges, node.id));
  }, [edges, refreshPreviewFor, setNodes]);

  const deleteEdge = useCallback(
    (edgeToDeleteId: string) => {
      const nextEdges = edges.filter((edge) => edge.id !== edgeToDeleteId);
      setEdges(nextEdges);
      setNodes((currentNodes) => refreshPreviewFor(currentNodes, nextEdges));
      setEdgeMenu(null);
    },
    [edges, refreshPreviewFor, setEdges, setNodes],
  );

  const selectNodeFromEdgeMenu = useCallback(
    (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      if (isGenerationNode(node)) setActiveGenerationId(node.id);
      setNodes((currentNodes) => currentNodes.map((item) => ({
        ...item,
        selected: item.id === nodeId,
      })) as SeedanceCanvasNode[]);
      setContextMenu(null);
      setEdgeMenu(null);
    },
    [nodes, setNodes],
  );

  const saveCanvas = useCallback(async (mode: 'save' | 'saveAs' = 'save') => {
    if (!selectedProjectId) {
      setCanvasStatus('请先选择当前项目。');
      return;
    }

    try {
      const shouldCreate = mode === 'saveAs' || !currentCanvasId;
      const response = await fetch(
        shouldCreate ? apiUrl('/api/canvases') : apiUrl(`/api/canvases/${encodeURIComponent(currentCanvasId)}`),
        {
          method: shouldCreate ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...canvasPayload(canvasTitle, nodes, edges, activeGenerationId, reactFlowInstance),
            project_id: selectedProjectId,
          }),
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(apiError(payload, '保存画布失败。'));
      const summary = isRecord(payload) && isRecord(payload.canvas) ? normalizeCanvasSummary(payload.canvas) : null;
      if (summary?.id) setCurrentCanvasId(summary.id);
      if (summary?.title) setCanvasTitle(summary.title);
      setCanvasStatus(`已保存：${summary?.title || canvasTitle} · ${formatTime(summary?.updatedAt)}`);
      await refreshCanvasList(summary?.id);
    } catch (error) {
      setCanvasStatus(error instanceof Error ? error.message : String(error));
    }
  }, [activeGenerationId, canvasTitle, currentCanvasId, edges, nodes, reactFlowInstance, refreshCanvasList, selectedProjectId]);

  const deleteCurrentCanvas = useCallback(async () => {
    if (!currentCanvasId) {
      newBlankCanvas();
      return;
    }
    try {
      const response = await fetch(apiUrl(`/api/canvases/${encodeURIComponent(currentCanvasId)}`), { method: 'DELETE' });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(apiError(payload, '删除画布失败。'));
      await refreshCanvasList();
      newBlankCanvas();
      setCanvasStatus('已删除当前画布');
    } catch (error) {
      setCanvasStatus(error instanceof Error ? error.message : String(error));
    }
  }, [currentCanvasId, newBlankCanvas, refreshCanvasList]);

  const canvasJson = useMemo(() => ({
    ...exportCanvas(prepareNodesForPersistence(nodes), edges),
    title: canvasTitle.trim() || '未命名画布',
    activeGenerationId,
    viewport: reactFlowInstance?.getViewport() ?? null,
  }), [activeGenerationId, canvasTitle, edges, nodes, reactFlowInstance]);

  const refreshPreview = useCallback(() => {
    setNodes((currentNodes) => refreshPreviewFor(currentNodes, edges));
  }, [edges, refreshPreviewFor, setNodes]);

  const nextPosition = useCallback((position?: XYPosition) =>
    position ?? {
      x: 120 + (nodes.length % 3) * 260,
      y: 120 + Math.floor(nodes.length / 3) * 210,
    }, [nodes.length]);

  const addTextCard = useCallback((position?: XYPosition) => {
    const id = `text-${Date.now()}`;
    const newNode: SeedanceCanvasNode = {
      id,
      type: 'textCard',
      position: nextPosition(position),
      data: {
        title: `文本卡片 ${nodes.filter((node) => node.type === 'textCard').length + 1}`,
        role: 'prompt',
        prompt: '',
        seedanceRef: '文本输入',
      },
    };
    const nextNodes = [...nodes, newNode];
    setNodes(refreshPreviewFor(nextNodes, edges));
  }, [edges, nextPosition, nodes, refreshPreviewFor, setNodes]);

  const addImageCard = useCallback((position?: XYPosition, variant: 'semantic' | 'frame' = 'semantic') => {
    const imageIndex = nodes.filter((node) => node.type === 'imageCard').length + 1;
    const id = `image-${Date.now()}`;
    const isFrameCard = variant === 'frame';
    const newNode: SeedanceCanvasNode = {
      id,
      type: 'imageCard',
      position: nextPosition(position),
      data: {
        title: isFrameCard ? '首帧' : `图片卡片｜@图片${imageIndex}`,
        refId: `@图片${imageIndex}`,
        variant,
        url: '',
        usage: isFrameCard ? 'first-frame' : 'character-reference',
        description: '',
      },
    };
    const nextNodes = [...nodes, newNode];
    setNodes(refreshPreviewFor(nextNodes, edges));
  }, [edges, nextPosition, nodes, refreshPreviewFor, setNodes]);

  const addMediaCard = useCallback((kind: 'video' | 'audio', position?: XYPosition) => {
    const index = nodes.filter((node) => node.type === `${kind}Card`).length + 1;
    const isVideo = kind === 'video';
    const refId = isVideo ? `@视频${index}` : `@音频${index}`;
    const id = `${kind}-${Date.now()}`;
    const newNode: SeedanceCanvasNode = {
      id,
      type: isVideo ? 'videoCard' : 'audioCard',
      position: nextPosition(position),
      data: {
        title: `${isVideo ? '视频' : '音频'}卡片｜${refId}`,
        refId,
        url: '',
      },
    };
    const nextNodes = [...nodes, newNode];
    setNodes(refreshPreviewFor(nextNodes, edges));
  }, [edges, nextPosition, nodes, refreshPreviewFor, setNodes]);

  const addGenerationCard = useCallback((position?: XYPosition, model: SeedanceModel = 'seedance-2.0', agentMode = false) => {
    const id = `${agentMode ? 'agent-generation' : 'generation'}-${Date.now()}`;
    const generationCount = nodes.filter(isGenerationNode).length;
    const newNode: SeedanceCanvasNode = {
      id,
      type: agentMode ? 'agentGenerationCard' : 'generationCard',
      selected: true,
      position: position ?? { x: 560, y: 160 + generationCount * 260 },
      data: {
        title: agentMode
          ? 'Agent 生成卡｜Seedance 2.0'
          : model === 'wan2.7-t2v-2026-04-25'
          ? '生成卡片｜Wan2.7 文生'
          : model === 'wan2.7-i2v-2026-04-25'
            ? '生成卡片｜Wan2.7 图生/首帧'
            : model === 'wan2.7-r2v'
              ? '生成卡片｜Wan2.7 参考生'
              : '生成卡片｜Seedance 2.0',
        agentMode,
        prePrompt: agentMode ? '' : undefined,
        model,
        mode: model === 'wan2.7-t2v-2026-04-25' ? 'text-to-video' : 'image-to-video',
        referenceMode: model === 'wan2.7-t2v-2026-04-25'
          ? 'text-reference'
          : model === 'wan2.7-i2v-2026-04-25'
            ? 'first-last-frame'
            : 'omni-reference',
        durationSec: 15,
        aspectRatio: '9:16',
        quality: model === 'wan2.7-t2v-2026-04-25' || model === 'wan2.7-i2v-2026-04-25' || model === 'wan2.7-r2v' ? '720p' : '480p',
        sound: 'auto-sfx-music',
        prompt: '',
        negativePrompt: model === 'wan2.7-t2v-2026-04-25' || model === 'wan2.7-i2v-2026-04-25' || model === 'wan2.7-r2v'
          ? '不要水印、不要乱码字幕、不要人物变脸、不要无关物体乱入。'
          : '生成约束：避免水印、字幕、乱码文字、Logo、人物脸部变形、额外肢体、主体漂移、无关物体乱入；保持主体身份、服装、场景与镜头连续。',
        inputs: { textNodeIds: [], imageNodeIds: [], videoNodeIds: [], audioNodeIds: [] },
        status: 'draft',
      },
    };
    const nextNodes = nodes.map((node) => ({ ...node, selected: false }) as SeedanceCanvasNode).concat(newNode);
    setActiveGenerationId(id);
    setNodes(refreshPreviewFor(nextNodes, edges, id));
  }, [edges, nodes, refreshPreviewFor, setNodes]);

  const addNodeFromContextMenu = useCallback((kind: 'text' | 'image' | 'frame' | 'video' | 'audio' | 'generation' | 'agentGeneration') => {
    if (!contextMenu) return;
    if (kind === 'text') addTextCard(contextMenu.flowPosition);
    if (kind === 'image') addImageCard(contextMenu.flowPosition);
    if (kind === 'frame') addImageCard(contextMenu.flowPosition, 'frame');
    if (kind === 'video') addMediaCard('video', contextMenu.flowPosition);
    if (kind === 'audio') addMediaCard('audio', contextMenu.flowPosition);
    if (kind === 'generation') addGenerationCard(contextMenu.flowPosition);
    if (kind === 'agentGeneration') addGenerationCard(contextMenu.flowPosition, 'seedance-2.0', true);
    setContextMenu(null);
  }, [addGenerationCard, addImageCard, addMediaCard, addTextCard, contextMenu]);

  const handlePaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent<Element, MouseEvent>) => {
    event.preventDefault();
    if (!reactFlowInstance) return;
    setEdgeMenu(null);
    setContextMenu({
      screenX: event.clientX,
      screenY: event.clientY,
      flowPosition: reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    });
  }, [reactFlowInstance]);

  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
    setEdgeMenu(null);
    setNodes((currentNodes) => currentNodes.map((node) => (
      node.selected ? { ...node, selected: false } : node
    )) as SeedanceCanvasNode[]);
  }, [setNodes]);

  const downloadJson = useCallback(async () => {
    if (!canExportCanvasJson) {
      setCanvasStatus('只有管理员可以导出 Canvas JSON。');
      return;
    }

    const response = await fetch(apiUrl('/api/canvases/export'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: canvasTitle,
        document: canvasJson,
      }),
    });

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      throw new Error(apiError(payload, '导出 Canvas JSON 失败。'));
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeDownloadName(canvasJson.title || canvasTitle)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setCanvasStatus('已导出 Canvas JSON');
  }, [canExportCanvasJson, canvasJson, canvasTitle]);

  const edgeMenuSourceNode = edgeMenu ? nodes.find((node) => node.id === edgeMenu.sourceId) : undefined;
  const edgeMenuTargetNode = edgeMenu ? nodes.find((node) => node.id === edgeMenu.targetId) : undefined;

  return (
    <div className="canvas-full-workspace">
      <header className="canvas-page-header">
        <div className="canvas-page-main">
          <div className="canvas-page-title-row">
            <span className="canvas-page-kicker">生成工作台</span>
            <h1>画布</h1>
            <span className="canvas-page-badge">Beta</span>
          </div>
          <div className="canvas-page-summary">
            <span className="canvas-summary-chip">
              <strong>项目</strong>
              <span>{selectedProjectLabel}</span>
            </span>
            <span className="canvas-summary-chip">
              <strong>画布</strong>
              <span>{currentCanvasLabel}</span>
            </span>
            <span className="canvas-summary-chip">
              <strong>状态</strong>
              <span>{currentCanvasMeta}</span>
            </span>
          </div>
        </div>
        <div className="canvas-page-actions">
          <Link href="/generate" className="canvas-page-link">
            返回标准生成
          </Link>
          {canExportCanvasJson && (
            <button
              type="button"
              onClick={() => void downloadJson().catch((error) => {
                setCanvasStatus(error instanceof Error ? error.message : '导出 Canvas JSON 失败。');
              })}
            >
              导出 Canvas JSON
            </button>
          )}
        </div>
      </header>

      <main className="app-shell">
        <aside className="sidebar">
          <section className="add-panel add-panel-primary">
            <h2>添加卡片</h2>
            <button type="button" onClick={() => addTextCard()}>＋ 文本卡片</button>
            <button type="button" onClick={() => addImageCard()}>＋ 图片卡片</button>
            <button type="button" onClick={() => addImageCard(undefined, 'frame')}>＋ 首尾帧卡片</button>
            <button type="button" onClick={() => addMediaCard('video')}>＋ 视频卡片</button>
            <button type="button" onClick={() => addMediaCard('audio')}>＋ 音频卡片</button>
            <button type="button" onClick={() => addGenerationCard()}>＋ 生成卡片</button>
            <button type="button" onClick={() => addGenerationCard(undefined, 'seedance-2.0', true)}>＋ Agent 生成卡</button>
          </section>

          <section className="canvas-manager-panel canvas-project-panel">
            <div className="config-panel-header">
              <div>
                <h2>当前项目</h2>
                <p className="muted tiny">画布保存、任务创建和成本归属都会写入所选项目。</p>
              </div>
              <button
                type="button"
                onClick={() => void loadProjects({ keepSelected: true })}
                disabled={loadingProjects || projectBusy}
              >
                刷新
              </button>
            </div>

            <div className="canvas-project-switcher">
              {projects.length > 0 ? (
                <select
                  className="canvas-select canvas-project-select"
                  value={selectedProjectId}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                  disabled={loadingProjects || projectBusy}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {projectDisplayLabel(project, duplicateProjectNames)}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="canvas-project-empty">
                  {loadingProjects ? '正在加载项目...' : '暂无可生成项目'}
                </div>
              )}

              <div className="canvas-project-actions">
                <button
                  type="button"
                  className="canvas-project-action canvas-project-action-primary"
                  onClick={() => {
                    setProjectCreateOpen((open) => !open);
                    setProjectConfirmAction(null);
                    setProjectMessage(null);
                  }}
                  disabled={projectBusy}
                >
                  新建
                </button>
                <Link
                  className={`canvas-project-action canvas-project-action-link ${selectedProject ? '' : 'disabled'}`}
                  href={selectedProject ? `/projects/${encodeURIComponent(selectedProject.id)}` : '/projects'}
                  aria-disabled={!selectedProject}
                >
                  管理
                </Link>
                <button
                  type="button"
                  className="canvas-project-action canvas-project-action-danger"
                  onClick={() => void handleProjectRemoval()}
                  disabled={!selectedProjectCanRemove || projectBusy}
                  title={projectRemovalTitle}
                >
                  {projectBusy && projectConfirmAction ? '处理中' : projectRemovalLabel}
                </button>
              </div>
            </div>

            {selectedProject && (
              <div className="canvas-project-summary" title={selectedProjectLabel}>
                <span>{selectedProjectTypeLabel}</span>
                <span>{selectedProjectRoleLabel}</span>
                <span>{selectedProjectTaskCount} 任务</span>
                <span>{selectedProjectAlbumCount} 图集</span>
              </div>
            )}

            {projectCreateOpen && (
              <form className="canvas-project-create" onSubmit={handleCreateProject}>
                <input
                  className="canvas-project-input"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="输入项目名称"
                  maxLength={40}
                  autoFocus
                />
                <button
                  type="submit"
                  className="canvas-project-action canvas-project-action-primary"
                  disabled={projectBusy}
                >
                  {projectBusy ? '创建中' : '创建'}
                </button>
                <button
                  type="button"
                  className="canvas-project-action"
                  onClick={() => {
                    setProjectCreateOpen(false);
                    setProjectName('');
                    setProjectMessage(null);
                  }}
                  disabled={projectBusy}
                >
                  取消
                </button>
              </form>
            )}

            {projectMessage && (
              <div className={`canvas-project-message ${projectMessage.type}`}>
                {projectMessage.text}
              </div>
            )}

            <p className="muted tiny">
              可用 {formatCredit(credits?.available)} 点 · 冻结 {formatCredit(credits?.frozen_credits)} 点 · 本月已用 {formatCredit(credits?.monthly_used)} 点
            </p>
          </section>

          <section className="canvas-manager-panel">
            <div className="config-panel-header">
              <div>
                <h2>画布管理</h2>
                <p className="muted tiny">{currentCanvasId || '新画布'} · {nodes.length} 节点 / {edges.length} 连线</p>
              </div>
              <button type="button" onClick={() => void refreshCanvasList(currentCanvasId)}>刷新</button>
            </div>
            <label className="canvas-title-field">
              <span>标题</span>
              <input value={canvasTitle} onChange={(event) => setCanvasTitle(event.target.value)} placeholder="给这个工作流起个名字" />
            </label>
            <div className="canvas-actions">
              <button type="button" onClick={() => void saveCanvas('save')}>{currentCanvasId ? '保存' : '保存新画布'}</button>
              <button type="button" onClick={() => void saveCanvas('saveAs')}>另存为</button>
              <button type="button" onClick={newBlankCanvas}>新建</button>
              <button type="button" className="danger-button" onClick={() => void deleteCurrentCanvas()}>删除</button>
            </div>
            <select
              className="canvas-select"
              value={currentCanvasId}
              onChange={(event) => {
                const nextId = event.target.value;
                setCurrentCanvasId(nextId);
                if (nextId) {
                  void loadCanvas(nextId).catch((error) => {
                    setCanvasStatus(error instanceof Error ? error.message : '加载画布失败。');
                  });
                } else {
                  newBlankCanvas();
                }
              }}
            >
              <option value="">选择已保存画布…</option>
              {canvasList.map((canvas) => (
                <option key={canvas.id} value={canvas.id}>
                  {canvas.title} · {formatTime(canvas.updatedAt)} · {canvas.nodes}卡
                </option>
              ))}
            </select>
            <p className="muted tiny canvas-status">{canvasStatus}</p>
          </section>

          <details className="legend compact-disclosure">
            <summary>卡片类型</summary>
            <span><b className="dot text" /> 文本卡</span>
            <span><b className="dot image" /> 参考图卡 / @图片N</span>
            <span><b className="dot video" /> 视频卡 / @视频N</span>
            <span><b className="dot audio" /> 音频卡 / @音频N</span>
            <span><b className="dot generation" /> 生成卡</span>
            <span><b className="dot agent" /> Agent 生成卡 / 前置提示词</span>
          </details>

          <details className="config-panel compact-disclosure">
            <summary>提交规则</summary>
            <div className="config-form">
              <p className="muted tiny">Seedance 2.0 / Fast 会走站内正式任务链路；Wan 2.7 当前保留请求预览。</p>
              <p className="muted tiny">1. 图片、视频、音频会先上传到平台资产存储。</p>
              <p className="muted tiny">2. 点击生成会创建内部任务、冻结点数，然后轮询主站任务状态。</p>
              <p className="muted tiny">3. 成功结果会回填到当前生成卡，历史任务仍可在「我的任务」查看。</p>
            </div>
          </details>

          <details className="preview-panel compact-disclosure">
            <summary>请求预览</summary>
            <button type="button" onClick={refreshPreview}>刷新请求预览</button>
            <pre>{JSON.stringify(preview, null, 2)}</pre>
          </details>
        </aside>

        <section className="canvas-wrap" onContextMenu={handlePaneContextMenu} onClick={() => { setContextMenu(null); setEdgeMenu(null); }}>
          <ReactFlow
            nodes={nodesWithCallbacks}
            edges={edgesWithActions}
            onNodesChange={onNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onEdgeContextMenu={handleEdgeContextMenu}
            onInit={setReactFlowInstance}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            onPaneContextMenu={handlePaneContextMenu}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
          >
            <Background gap={20} size={1} color="rgba(148, 163, 184, 0.18)" />
            {contextMenu && (
              <div
                className="context-menu nodrag nowheel"
                style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
                onClick={(event) => event.stopPropagation()}
              >
                <strong>添加卡片</strong>
                <button type="button" className="opt-text" onClick={() => addNodeFromContextMenu('text')}>＋ 文本</button>
                <button type="button" className="opt-image" onClick={() => addNodeFromContextMenu('image')}>＋ 图片</button>
                <button type="button" className="opt-frame" onClick={() => addNodeFromContextMenu('frame')}>＋ 首尾帧</button>
                <button type="button" className="opt-video" onClick={() => addNodeFromContextMenu('video')}>＋ 视频</button>
                <button type="button" className="opt-audio" onClick={() => addNodeFromContextMenu('audio')}>＋ 音频</button>
                <button type="button" className="opt-generation" onClick={() => addNodeFromContextMenu('generation')}>＋ 生成</button>
                <button type="button" className="opt-agent" onClick={() => addNodeFromContextMenu('agentGeneration')}>＋ Agent 生成</button>
              </div>
            )}
            {edgeMenu && (
              <div
                className="context-menu edge-context-menu nodrag nowheel"
                style={{ left: edgeMenu.screenX, top: edgeMenu.screenY }}
                onClick={(event) => event.stopPropagation()}
              >
                <strong>连线操作</strong>
                <p className="edge-menu-meta">
                  {nodeDisplayLabel(edgeMenuSourceNode)} → {nodeDisplayLabel(edgeMenuTargetNode)}
                </p>
                <span className="edge-menu-label">{edgeMenu.label}</span>
                <button type="button" onClick={() => selectNodeFromEdgeMenu(edgeMenu.sourceId)}>选中来源卡片</button>
                <button type="button" onClick={() => selectNodeFromEdgeMenu(edgeMenu.targetId)}>选中目标卡片</button>
                <button type="button" className="danger-button" onClick={() => deleteEdge(edgeMenu.edgeId)}>取消这条连线</button>
              </div>
            )}
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </section>
      </main>
    </div>
  );
}

export default CanvasWorkspace;
