import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(repoRoot, 'public');
const port = Number(process.argv[2] || 4399);

const mockUser = {
  id: 'preview-user',
  name: '普通测试用户',
  username: 'canvas-preview',
  role: 'user',
  account_type: 'member',
  avatar_url: null,
};

const projects = [
  {
    id: 'project-personal',
    name: '我的默认项目',
    original_name: '我的默认项目',
    display_name: '个人空间',
    type: 'personal',
    status: 'active',
    owner_user_id: 'preview-user',
    owner: mockUser,
    _count: { tasks: 4, reference_albums: 2 },
    my_role: 'project_owner',
    can_generate: true,
    can_manage_project: true,
    can_manage_assets: true,
    group: 'owned',
    meta_label: '个人默认 · 4 任务 · 2 图集',
    removal_action: null,
    removal_reason: '个人默认项目不能删除或归档',
  },
  {
    id: 'project-team',
    name: '夏季产品短片',
    original_name: '夏季产品短片',
    display_name: '夏季产品短片',
    type: 'team',
    status: 'active',
    owner_user_id: 'owner-lin',
    owner: { id: 'owner-lin', name: '林设计', username: 'lin', avatar_url: null },
    _count: { tasks: 12, reference_albums: 3 },
    my_role: 'editor',
    can_generate: true,
    can_manage_project: false,
    can_manage_assets: true,
    group: 'joined',
    meta_label: '协作项目 · 12 任务 · 3 图集',
    removal_action: null,
    removal_reason: '你没有权限管理这个项目',
  },
];

const videoCards = [
  {
    id: 'card-opening',
    project_id: 'project-personal',
    title: '开场镜头',
    objective: '建立产品和人物关系',
    status: 'active',
    status_label: '进行中',
    owner_user_id: 'preview-user',
    owner: mockUser,
    can_generate: true,
    can_manage: true,
    platform: '抖音',
    ratio: '9:16',
    duration: 5,
    target_resolution: '1080p',
    spec_label: '抖音 · 9:16 · 5s · 1080p',
    summary: { task_count: 3, charged_credits: 270 },
    removal_action: 'archive',
    removal_reason: '视频卡已有生成记录，只能归档',
  },
  {
    id: 'card-detail',
    project_id: 'project-personal',
    title: '产品细节特写',
    objective: '突出材质与光影',
    status: 'draft',
    status_label: '草稿',
    owner_user_id: 'preview-user',
    owner: mockUser,
    can_generate: true,
    can_manage: true,
    ratio: '16:9',
    duration: 5,
    target_resolution: '720p',
    spec_label: '16:9 · 5s · 720p',
    summary: { task_count: 0, charged_credits: 0 },
    removal_action: 'discard',
    removal_reason: '空视频卡可以废弃',
  },
];

const videoBranches = [
  {
    id: 'branch-opening-main',
    video_card_id: 'card-opening',
    title: 'Main direction',
    description: 'Default preview direction',
    status: 'primary',
    is_primary: true,
    created_by: mockUser.id,
  },
  {
    id: 'branch-opening-detail',
    video_card_id: 'card-opening',
    title: 'Product close-up',
    description: 'Detail exploration',
    status: 'exploring',
    is_primary: false,
    created_by: mockUser.id,
  },
];

const videoTasks = [
  {
    id: 'task-opening-1',
    provider_task_id: 'provider-task-opening-1',
    project_id: 'project-personal',
    video_card_id: 'card-opening',
    video_branch_id: 'branch-opening-main',
    prompt: 'Opening product reveal',
    local_status: 'succeeded',
    version_role: 'current_best',
    estimated_cost: 90,
    actual_cost: 90,
    frozen_cost: 0,
    result_video_url: '/mock/task-opening-1.mp4',
    owner: mockUser,
    user: mockUser,
    created_at: new Date(Date.now() - 180000).toISOString(),
  },
  {
    id: 'task-opening-2',
    provider_task_id: 'provider-task-opening-2',
    project_id: 'project-personal',
    video_card_id: 'card-opening',
    video_branch_id: 'branch-opening-detail',
    prompt: 'Material close-up',
    local_status: 'failed',
    version_role: 'normal',
    estimated_cost: 90,
    actual_cost: 0,
    frozen_cost: 0,
    error_message: 'Local mock failure',
    owner: mockUser,
    user: mockUser,
    created_at: new Date(Date.now() - 120000).toISOString(),
  },
  {
    id: 'task-opening-3',
    provider_task_id: 'provider-task-opening-3',
    project_id: 'project-personal',
    video_card_id: 'card-opening',
    video_branch_id: 'branch-opening-main',
    prompt: 'Opening motion variation',
    local_status: 'succeeded',
    version_role: 'candidate',
    estimated_cost: 90,
    actual_cost: 90,
    frozen_cost: 0,
    result_video_url: '/mock/task-opening-3.mp4',
    owner: mockUser,
    user: mockUser,
    created_at: new Date(Date.now() - 60000).toISOString(),
  },
];

const approvals = [];

const canvasDocuments = new Map();
const taskPollCounts = new Map();
let sequence = 1;

const mockImageDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <rect width="960" height="540" fill="#17201f"/>
    <path d="M0 400L240 230L420 350L650 140L960 390V540H0Z" fill="#28514d"/>
    <circle cx="750" cy="125" r="58" fill="#4ecdc4" opacity="0.82"/>
    <text x="48" y="72" fill="#f7f7f7" font-size="32" font-family="sans-serif">无线画布本地 Mock 图片</text>
    <text x="48" y="112" fill="#a3a3a3" font-size="18" font-family="sans-serif">未连接线上模型，不消耗点数</text>
  </svg>
`)}`;

const generatedLibraryItems = [];

function previewLibraryItems() {
  return [
    {
      id: 'library-reference-seed',
      kind: 'image',
      status: 'active',
      title: '本地参考图',
      prompt: '本机预览参考图',
      assetId: 'asset-reference-seed',
      referenceImageId: 'reference-seed',
      workspaceAssetId: 'workspace-reference-seed',
      originalUrl: mockImageDataUrl,
      thumbnailUrl: mockImageDataUrl,
      downloadUrl: mockImageDataUrl,
      source: 'local-mock',
    },
    ...generatedLibraryItems,
  ];
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function activeProjects() {
  return projects.filter((project) => project.status === 'active');
}

function cardTasks(cardId) {
  return videoTasks.filter((task) => task.video_card_id === cardId);
}

function cardBranches(cardId) {
  return videoBranches.filter((branch) => branch.video_card_id === cardId);
}

function taskSummary(cardId) {
  const tasks = cardTasks(cardId);
  return {
    task_count: tasks.length,
    succeeded_count: tasks.filter((task) => task.local_status === 'succeeded').length,
    failed_count: tasks.filter((task) => ['failed', 'cancelled'].includes(task.local_status)).length,
    running_count: tasks.filter((task) => ['submitted', 'running'].includes(task.local_status)).length,
    estimated_credits: tasks.reduce((sum, task) => sum + Number(task.estimated_cost || 0), 0),
    charged_credits: tasks.reduce((sum, task) => sum + Number(task.actual_cost || 0), 0),
    refunded_credits: tasks.reduce((sum, task) => sum + Number(task.refund_amount || 0), 0),
    official_cost_totals: {},
  };
}

function normalizeBranch(branch) {
  const tasks = videoTasks.filter((task) => task.video_branch_id === branch.id);
  return {
    ...branch,
    summary: {
      task_count: tasks.length,
      estimated_credits: tasks.reduce((sum, task) => sum + Number(task.estimated_cost || 0), 0),
      charged_credits: tasks.reduce((sum, task) => sum + Number(task.actual_cost || 0), 0),
    },
  };
}

function normalizeTask(task) {
  return {
    generation_mode: 'all_in_one_reference',
    ratio: '16:9',
    duration: 5,
    resolution: '720p',
    provider: 'local-mock',
    result_last_frame_url: null,
    local_video_path: null,
    refund_amount: 0,
    provider_cost_currency: 'credits',
    project: projects.find((project) => project.id === task.project_id) || null,
    video_card: videoCards.find((card) => card.id === task.video_card_id) || null,
    ...task,
  };
}

function normalizeCard(card) {
  const canGenerate = ['draft', 'active', 'reviewing'].includes(card.status);
  const summary = taskSummary(card.id);
  const taskCount = summary.task_count;
  const branchCount = cardBranches(card.id).length;
  const currentBest = cardTasks(card.id).find((task) => task.version_role === 'current_best') || null;
  const finalTask = cardTasks(card.id).find((task) => task.version_role === 'final') || null;
  return {
    ...card,
    can_generate: canGenerate,
    can_manage: true,
    project: projects.find((project) => project.id === card.project_id) || null,
    branch_count: branchCount,
    summary,
    current_best_task_id: card.current_best_task_id || currentBest?.id || null,
    final_task_id: card.final_task_id || finalTask?.id || null,
    current_best_task: currentBest,
    final_task: finalTask,
    status_label: {
      draft: 'Draft',
      active: 'Active',
      reviewing: 'Reviewing',
      finalized: 'Finalized',
      sealed: 'Sealed',
      merged: 'Merged',
      archived: 'Archived',
      discarded: 'Discarded',
    }[card.status] || card.status,
    removal_action: ['sealed', 'merged', 'archived', 'discarded'].includes(card.status)
      ? null
      : taskCount > 0 || branchCount > 0 ? 'archive' : 'discard',
    removal_reason: taskCount > 0 || branchCount > 0
      ? 'Mock card has history and can only be archived'
      : 'Empty mock card can be discarded',
  };
}

function createMockCard(projectId, body = {}) {
  const card = {
    id: `card-mock-${sequence++}`,
    project_id: projectId,
    title: body.title || 'Local mock video card',
    objective: body.objective || null,
    status: body.status || 'active',
    owner_user_id: mockUser.id,
    owner: mockUser,
    platform: body.platform || null,
    ratio: body.ratio || '16:9',
    duration: body.duration || 5,
    target_resolution: body.target_resolution || '720p',
    budget_credits: body.budget_credits ?? null,
    budget_currency: body.budget_currency || 'credits',
    ratio_locked: Boolean(body.ratio_locked),
    is_fallback: false,
  };
  videoCards.push(card);
  return normalizeCard(card);
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.glb': 'model/gltf-binary',
  }[ext] || 'application/octet-stream';
}

function bootstrapPayload(url) {
  const projectId = url.searchParams.get('project_id') || 'project-personal';
  const availableProjects = activeProjects();
  const selectedProject = availableProjects.find((project) => project.id === projectId) || availableProjects[0] || null;
  const cards = selectedProject
    ? videoCards.filter((card) => card.project_id === selectedProject.id && card.status !== 'discarded').map(normalizeCard)
    : [];
  const requestedCardId = url.searchParams.get('video_card_id');
  const selectedCard = cards.find((card) => card.id === requestedCardId) || cards.find((card) => card.can_generate) || null;
  return {
    tool: { id: 'ultimate-canvas', name: '无线画布', mode: 'preview', billing: 'unified_sd2' },
    user: mockUser,
    context: {
      projects: availableProjects,
      selected_project_id: selectedProject?.id || null,
      video_cards: cards,
      selected_video_card_id: selectedCard?.id || null,
      selected_video_card_can_generate: Boolean(selectedCard?.can_generate),
      credits: { balance: 1000, available: 860, frozen_credits: 140 },
      canvas_document: null,
      needs_project_selection: !selectedProject,
      needs_video_card_selection: !selectedCard,
      generation_blocked_reason: null,
    },
    capabilities: {
      text: { enabled: true, model: 'gpt-5.4', endpoint: '/api/tools/ultimate-canvas/generate', message: '可用' },
      image: {
        enabled: true,
        model: 'Seedream 5.0 Pro',
        size: '1K',
        endpoint: '/api/assets/generate',
        message: '可用',
        capabilities: {
          reference_image_limit: 10,
          max_outputs_per_request: 1,
          size_options: ['1K', '2K'],
          output_formats: ['png', 'jpeg'],
        },
        interaction: {
          modes: ['text-to-image', 'image-to-image', 'upscale-image', 'first-frame-draft', 'last-frame-draft'],
          ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
          size_options: ['1K', '2K'],
          max_outputs_per_request: 1,
          max_reference_images: 10,
        },
      },
      video: {
        enabled: true,
        model: 'Seedance 2.0',
        interaction: {
          modes: [
            'text-to-video',
            'all-reference-video',
            'image-to-video',
            'first-frame-video',
            'first-last-frame-video',
            'image-reference-video',
            'smart-multi-frame-video',
          ],
          ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
          durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolutions: ['480p', '720p', '1080p'],
          supports_audio: true,
          supports_last_frame: true,
          supports_watermark: true,
          max_reference_images: 9,
        },
        endpoint: '/api/tasks/create',
        status_endpoint_template: '/api/video/status/:taskId?refresh=true',
        message: '可用',
      },
    },
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/auth/me') return sendJson(response, { user: mockUser });
  if (url.pathname === '/api/tools/ultimate-canvas/bootstrap') return sendJson(response, bootstrapPayload(url));
  if (url.pathname === '/api/tools/ultimate-canvas/document') {
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const projectId = body.project_id || 'project-personal';
      const document = {
        id: body.document_id || `canvas-preview-${projectId}`,
        project_id: projectId,
        title: body.title || '无线画布本地预览',
        document_json: body.document_json || '{}',
        updated_at: new Date().toISOString(),
      };
      canvasDocuments.set(projectId, document);
      return sendJson(response, { document });
    }
    return sendJson(response, { document: canvasDocuments.get(url.searchParams.get('project_id')) || null });
  }
  if (url.pathname === '/api/assets/library') {
    const type = url.searchParams.get('type') || 'all';
    const items = previewLibraryItems().filter((item) => type === 'all' || item.kind === type);
    return sendJson(response, { items });
  }
  if (url.pathname === '/api/projects' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const project = {
      id: `project-mock-${sequence++}`,
      name: body.name || '本地测试项目',
      original_name: body.name || '本地测试项目',
      display_name: body.name || '本地测试项目',
      type: 'team',
      status: 'active',
      owner_user_id: mockUser.id,
      owner: mockUser,
      _count: { tasks: 0, reference_albums: 0 },
      my_role: 'project_owner',
      can_generate: true,
      can_manage_project: true,
      can_manage_assets: true,
      group: 'owned',
      meta_label: '协作项目 · 0 任务 · 0 图集',
      removal_action: 'delete',
      removal_reason: '空项目可以删除',
    };
    projects.push(project);
    return sendJson(response, { project }, 201);
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const project = projects.find((item) => item.id === decodeURIComponent(projectMatch[1]));
    if (!project) return sendJson(response, { error: '项目不存在' }, 404);
    if (request.method === 'PATCH') {
      const body = await readJsonBody(request);
      if (body.action === 'archive') project.status = 'archived';
    } else {
      project.status = 'deleted';
    }
    return sendJson(response, { project });
  }

  const createCardMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/video-cards$/);
  if (createCardMatch && request.method === 'GET') {
    const projectId = decodeURIComponent(createCardMatch[1]);
    const cards = videoCards
      .filter((card) => card.project_id === projectId)
      .map(normalizeCard);
    return sendJson(response, {
      video_cards: cards,
      permissions: {
        role: 'project_owner',
        can_generate: true,
        can_manage_project: true,
      },
    });
  }
  if (createCardMatch && request.method === 'POST') {
    const body = await readJsonBody(request);
    const projectId = decodeURIComponent(createCardMatch[1]);
    const card = normalizeCard({
      id: `card-mock-${sequence++}`,
      project_id: projectId,
      title: body.title || '本地测试视频卡',
      objective: body.objective || null,
      status: 'active',
      owner_user_id: mockUser.id,
      owner: mockUser,
      can_manage: true,
      ratio: '16:9',
      duration: 5,
      target_resolution: '720p',
      spec_label: '16:9 · 5s · 720p',
      summary: { task_count: 0 },
    });
    videoCards.push(card);
    return sendJson(response, { video_card: card }, 201);
  }

  const cardMatch = url.pathname.match(/^\/api\/video-cards\/([^/]+)$/);
  if (cardMatch && request.method === 'GET') {
    const card = videoCards.find((item) => item.id === decodeURIComponent(cardMatch[1]));
    if (!card) return sendJson(response, { error: 'Video card not found' }, 404);
    return sendJson(response, {
      video_card: normalizeCard(card),
      permissions: {
        can_generate: ['draft', 'active', 'reviewing'].includes(card.status),
        can_manage: true,
        project_role: 'project_owner',
      },
    });
  }
  if (cardMatch && request.method === 'PATCH') {
    const body = await readJsonBody(request);
    const card = videoCards.find((item) => item.id === decodeURIComponent(cardMatch[1]));
    if (!card) return sendJson(response, { error: '视频卡不存在' }, 404);
    for (const key of [
      'title',
      'objective',
      'platform',
      'ratio',
      'duration',
      'target_resolution',
      'budget_credits',
      'budget_currency',
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, key)) card[key] = body[key];
    }
    if (body.seal === true) card.status = 'sealed';
    if (body.candidate_task_id) {
      const task = videoTasks.find((item) => item.id === body.candidate_task_id && item.video_card_id === card.id);
      if (!task) return sendJson(response, { error: 'Task not found in video card' }, 400);
      task.version_role = 'candidate';
    }
    if (body.current_best_task_id) {
      videoTasks.filter((task) => task.video_card_id === card.id && task.version_role === 'current_best')
        .forEach((task) => { task.version_role = 'normal'; });
      const task = videoTasks.find((item) => item.id === body.current_best_task_id && item.video_card_id === card.id);
      if (!task) return sendJson(response, { error: 'Task not found in video card' }, 400);
      task.version_role = 'current_best';
      card.current_best_task_id = task.id;
    }
    if (body.final_task_id) {
      videoTasks.filter((task) => task.video_card_id === card.id && task.version_role === 'final')
        .forEach((task) => { task.version_role = 'normal'; });
      const task = videoTasks.find((item) => item.id === body.final_task_id && item.video_card_id === card.id);
      if (!task) return sendJson(response, { error: 'Task not found in video card' }, 400);
      task.version_role = 'final';
      card.final_task_id = task.id;
      card.status = 'finalized';
    }
    if (body.action === 'archive') card.status = 'archived';
    if (body.action === 'discard') card.status = 'discarded';
    return sendJson(response, { video_card: normalizeCard(card), action: body.action });
  }

  const branchesMatch = url.pathname.match(/^\/api\/video-cards\/([^/]+)\/branches$/);
  if (branchesMatch && request.method === 'GET') {
    const cardId = decodeURIComponent(branchesMatch[1]);
    return sendJson(response, { branches: cardBranches(cardId).map(normalizeBranch) });
  }
  if (branchesMatch && request.method === 'POST') {
    const cardId = decodeURIComponent(branchesMatch[1]);
    const body = await readJsonBody(request);
    const existing = cardBranches(cardId);
    if (existing.filter((branch) => ['exploring', 'candidate', 'primary'].includes(branch.status)).length >= 5
      && body.confirm_over_limit !== true) {
      return sendJson(response, { error: 'Active branch limit requires confirmation' }, 400);
    }
    const isPrimary = existing.length === 0 || body.is_primary === true;
    if (isPrimary) {
      existing.forEach((branch) => {
        branch.is_primary = false;
        if (branch.status === 'primary') branch.status = 'candidate';
      });
    }
    const branch = {
      id: `branch-mock-${sequence++}`,
      video_card_id: cardId,
      title: body.title || 'Local mock branch',
      description: body.description || null,
      status: isPrimary ? 'primary' : 'exploring',
      is_primary: isPrimary,
      created_by: mockUser.id,
    };
    videoBranches.push(branch);
    return sendJson(response, { branch: normalizeBranch(branch) }, 201);
  }

  const branchMatch = url.pathname.match(/^\/api\/video-cards\/([^/]+)\/branches\/([^/]+)$/);
  if (branchMatch && request.method === 'PATCH') {
    const cardId = decodeURIComponent(branchMatch[1]);
    const branchId = decodeURIComponent(branchMatch[2]);
    const body = await readJsonBody(request);
    const branch = videoBranches.find((item) => item.id === branchId && item.video_card_id === cardId);
    if (!branch) return sendJson(response, { error: 'Branch not found' }, 404);
    if (body.action === 'set_primary') {
      cardBranches(cardId).forEach((item) => {
        item.is_primary = item.id === branchId;
        if (item.id === branchId) item.status = 'primary';
        else if (item.status === 'primary') item.status = 'candidate';
      });
      return sendJson(response, { branch: normalizeBranch(branch) });
    }
    if (body.action === 'close') {
      branch.status = 'closed';
      branch.is_primary = false;
      return sendJson(response, { branch: normalizeBranch(branch) });
    }
    if (body.action === 'merge') {
      const targetBranchId = body.target_branch_id;
      if (!videoBranches.some((item) => item.id === targetBranchId && item.video_card_id === cardId)) {
        return sendJson(response, { error: 'Target branch not found' }, 400);
      }
      videoTasks.filter((task) => task.video_branch_id === branchId)
        .forEach((task) => { task.video_branch_id = targetBranchId; });
      branch.status = 'merged';
      branch.is_primary = false;
      return sendJson(response, { branch: normalizeBranch(branch) });
    }
    if (body.action === 'promote_to_card') {
      const source = videoCards.find((card) => card.id === cardId);
      const promoted = createMockCard(source?.project_id || 'project-personal', {
        title: body.title || branch.title,
        objective: branch.description,
        ratio: source?.ratio,
        duration: source?.duration,
        target_resolution: source?.target_resolution,
      });
      videoTasks.filter((task) => task.video_branch_id === branchId)
        .forEach((task) => {
          task.video_card_id = promoted.id;
          task.video_branch_id = null;
        });
      branch.status = 'promoted';
      branch.is_primary = false;
      return sendJson(response, { branch: normalizeBranch(branch), video_card: normalizeCard(promoted) });
    }
    return sendJson(response, { error: 'Unsupported branch action' }, 400);
  }

  const tasksMatch = url.pathname.match(/^\/api\/video-cards\/([^/]+)\/tasks$/);
  if (tasksMatch && request.method === 'GET') {
    const cardId = decodeURIComponent(tasksMatch[1]);
    const tasks = cardTasks(cardId).map(normalizeTask);
    return sendJson(response, {
      tasks,
      pagination: { page: 1, limit: 30, total: tasks.length, total_pages: 1 },
    });
  }
  if (tasksMatch && request.method === 'PATCH') {
    const sourceCardId = decodeURIComponent(tasksMatch[1]);
    const body = await readJsonBody(request);
    if (body.action !== 'move') return sendJson(response, { error: 'Unsupported task action' }, 400);
    const targetCard = videoCards.find((card) => card.id === body.target_video_card_id);
    if (!targetCard) return sendJson(response, { error: 'Target card not found' }, 404);
    const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
    videoTasks.filter((task) => task.video_card_id === sourceCardId && taskIds.includes(task.id))
      .forEach((task) => {
        task.video_card_id = targetCard.id;
        task.project_id = targetCard.project_id;
        task.video_branch_id = body.target_branch_id || null;
        task.version_role = 'normal';
      });
    return sendJson(response, { moved_task_ids: taskIds, target_video_card_id: targetCard.id });
  }

  const splitMatch = url.pathname.match(/^\/api\/video-cards\/([^/]+)\/split$/);
  if (splitMatch && request.method === 'POST') {
    const sourceCardId = decodeURIComponent(splitMatch[1]);
    const source = videoCards.find((card) => card.id === sourceCardId);
    if (!source) return sendJson(response, { error: 'Source card not found' }, 404);
    const body = await readJsonBody(request);
    const newCard = createMockCard(source.project_id, {
      title: body.title,
      objective: body.reason || source.objective,
      ratio: source.ratio,
      duration: source.duration,
      target_resolution: source.target_resolution,
    });
    const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
    videoTasks.filter((task) => task.video_card_id === sourceCardId && taskIds.includes(task.id))
      .forEach((task) => {
        task.video_card_id = newCard.id;
        task.video_branch_id = null;
        task.version_role = 'normal';
      });
    return sendJson(response, { source_card: normalizeCard(source), new_card: normalizeCard(newCard) }, 201);
  }

  const mergeMatch = url.pathname.match(/^\/api\/video-cards\/([^/]+)\/merge$/);
  if (mergeMatch && request.method === 'POST') {
    const sourceCardId = decodeURIComponent(mergeMatch[1]);
    const source = videoCards.find((card) => card.id === sourceCardId);
    const body = await readJsonBody(request);
    const target = videoCards.find((card) => card.id === body.target_video_card_id);
    if (!source || !target) return sendJson(response, { error: 'Merge card not found' }, 404);
    videoTasks.filter((task) => task.video_card_id === sourceCardId)
      .forEach((task) => {
        task.video_card_id = target.id;
        task.project_id = target.project_id;
        task.video_branch_id = null;
        task.version_role = 'normal';
      });
    source.status = 'merged';
    source.merged_into_card_id = target.id;
    source.merge_reason = body.reason || null;
    return sendJson(response, { source_card: normalizeCard(source), target_card: normalizeCard(target) });
  }

  if (url.pathname === '/api/approvals' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const approval = {
      id: `approval-mock-${sequence++}`,
      ...body,
      requester_user_id: mockUser.id,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    approvals.push(approval);
    return sendJson(response, { approval }, 201);
  }

  const retryMatch = url.pathname.match(/^\/api\/video\/retry\/([^/]+)$/);
  if (retryMatch && request.method === 'POST') {
    const original = videoTasks.find((task) => task.id === decodeURIComponent(retryMatch[1]));
    if (!original) return sendJson(response, { error: 'Task not found' }, 404);
    const taskId = `task-mock-${sequence++}`;
    const task = {
      ...original,
      id: taskId,
      provider_task_id: `provider-${taskId}`,
      local_status: 'submitted',
      version_role: 'normal',
      frozen_cost: 0,
      result_video_url: null,
      error_message: null,
      created_at: new Date().toISOString(),
    };
    videoTasks.push(task);
    taskPollCounts.set(taskId, 0);
    return sendJson(response, { ...normalizeTask(task), task_id: taskId, status: 'submitted' }, 201);
  }

  if (url.pathname === '/api/tools/ultimate-canvas/upload' && request.method === 'POST') {
    return sendJson(response, {
      success: true,
      workspace_id: 'workspace-mock',
      workspace_asset_id: `workspace-asset-${sequence}`,
      reference_image_id: `reference-mock-${sequence}`,
      asset: {
        id: `asset-mock-${sequence++}`,
        originalUrl: mockImageDataUrl,
        thumbnailUrl: mockImageDataUrl,
        fileName: '本地-mock-上传.png',
        fileSize: 1024,
        mimeType: 'image/png',
        warning: '本地 Mock：文件未上传到线上',
      },
    });
  }

  if (url.pathname === '/api/tools/ultimate-canvas/generate' && request.method === 'POST') {
    const body = await readJsonBody(request);
    return sendJson(response, {
      status: 'succeeded',
      title: body.kind === 'script' ? '本地 Mock 脚本' : '本地 Mock 文本',
      text: `这是本地 Mock 返回内容。\n\n提示词：${body.prompt || '未填写'}\n\n没有连接线上模型，也没有消耗点数。`,
      message: '本地 Mock 文本生成完成',
    });
  }

  if (url.pathname === '/api/assets/generate' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const assetId = `asset-generated-${sequence++}`;
    const asset = {
      assetId,
      referenceImageId: `reference-${assetId}`,
      workspaceAssetId: `workspace-${assetId}`,
      originalUrl: mockImageDataUrl,
      thumbnailUrl: mockImageDataUrl,
      fileName: '本地-mock-生成图.svg',
      mimeType: 'image/svg+xml',
    };
    generatedLibraryItems.unshift({
      id: `library-${assetId}`,
      kind: 'image',
      status: 'succeeded',
      title: asset.fileName,
      prompt: body.input?.prompt || '本地 Mock 生图',
      assetId: asset.assetId,
      referenceImageId: asset.referenceImageId,
      workspaceAssetId: asset.workspaceAssetId,
      originalUrl: asset.originalUrl,
      thumbnailUrl: asset.thumbnailUrl,
      downloadUrl: asset.originalUrl,
      source: 'image-generation-mock',
    });
    return sendJson(response, {
      success: true,
      status: 'succeeded',
      assets: [asset],
      asset_id: asset.assetId,
      reference_image_id: asset.referenceImageId,
      workspace_asset_id: asset.workspaceAssetId,
      mock_request: body,
    });
  }

  if (url.pathname === '/api/tasks/estimate' && request.method === 'GET') {
    const duration = Number(url.searchParams.get('duration') || 0);
    return sendJson(response, { estimatedCost: Math.ceil(duration * 3) });
  }

  if (url.pathname === '/api/tasks/create' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const taskId = `task-mock-${sequence++}`;
    const card = videoCards.find((item) => item.id === body.video_card_id);
    const task = {
      id: taskId,
      provider_task_id: `provider-${taskId}`,
      project_id: body.project_id || card?.project_id || 'project-personal',
      video_card_id: body.video_card_id || null,
      video_branch_id: body.video_branch_id || null,
      prompt: body.prompt || 'Local mock video task',
      generation_mode: body.generation_mode || 'all_in_one_reference',
      ratio: body.ratio || '16:9',
      duration: Number(body.duration || 5),
      resolution: body.resolution || '720p',
      generate_audio: body.generate_audio === true,
      return_last_frame: body.return_last_frame === true,
      watermark: body.watermark === true,
      reference_image_ids: Array.isArray(body.reference_image_ids) ? body.reference_image_ids : [],
      source_metadata: body.source_metadata || {},
      local_status: 'submitted',
      version_role: 'normal',
      estimated_cost: 0,
      actual_cost: 0,
      frozen_cost: 0,
      result_video_url: null,
      owner: mockUser,
      user: mockUser,
      created_at: new Date().toISOString(),
    };
    videoTasks.push(task);
    taskPollCounts.set(taskId, 0);
    return sendJson(response, { ...normalizeTask(task), task_id: taskId, status: 'submitted', frozen_cost: 0 });
  }

  const statusMatch = url.pathname.match(/^\/api\/video\/status\/([^/]+)$/);
  if (statusMatch) {
    const taskId = decodeURIComponent(statusMatch[1]);
    const pollCount = (taskPollCounts.get(taskId) || 0) + 1;
    taskPollCounts.set(taskId, pollCount);
    const succeeded = pollCount >= 2;
    const task = videoTasks.find((item) => item.id === taskId);
    if (task) {
      task.local_status = succeeded ? 'succeeded' : 'running';
      task.result_video_url = succeeded ? `/mock/${taskId}.mp4` : null;
      task.result_last_frame_url = succeeded && task.return_last_frame ? mockImageDataUrl : null;
      task.actual_cost = 0;
    }
    return sendJson(response, {
      id: taskId,
      provider_task_id: `provider-${taskId}`,
      local_status: succeeded ? 'succeeded' : 'running',
      result_video_url: succeeded ? `/mock/${taskId}.mp4` : null,
      result_last_frame_url: succeeded && task?.return_last_frame ? mockImageDataUrl : null,
    });
  }

  const thumbnailMatch = url.pathname.match(/^\/api\/video\/thumbnail\/([^/]+)$/);
  if (thumbnailMatch) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#17201f"/><text x="48" y="80" fill="#4ecdc4" font-size="32" font-family="sans-serif">本地 Mock 视频已完成</text><text x="48" y="125" fill="#a3a3a3" font-size="18" font-family="sans-serif">无真实视频、无点数消耗</text></svg>';
    response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
    response.end(svg);
    return;
  }

  if (url.pathname.startsWith('/api/')) return sendJson(response, { error: '预览服务器未实现此接口' }, 501);

  const pathname = url.pathname === '/' ? '/tools/ultimate-canvas/index.html' : url.pathname;
  const filePath = path.resolve(publicRoot, `.${pathname}`);
  if (!filePath.startsWith(publicRoot)) return sendJson(response, { error: 'invalid path' }, 400);
  try {
    let content = await readFile(filePath);
    if (filePath.endsWith('index.html') && url.searchParams.get('open')) {
      const kind = url.searchParams.get('open') === 'video-card' ? 'video-card' : 'project';
      const injection = `<script>setTimeout(function(){document.querySelector('[data-context-toggle="${kind}"]')?.click();},900);</script>`;
      content = Buffer.from(content.toString('utf8').replace('</body>', `${injection}</body>`));
    }
    response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ultimate canvas preview: http://127.0.0.1:${port}/tools/ultimate-canvas/index.html`);
});
