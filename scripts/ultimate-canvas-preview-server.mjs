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

function normalizeCard(card) {
  const canGenerate = ['draft', 'active', 'reviewing'].includes(card.status);
  const taskCount = card.summary?.task_count || 0;
  return {
    ...card,
    can_generate: canGenerate,
    status_label: {
      draft: '草稿',
      active: '进行中',
      reviewing: '评审中',
      archived: '已归档',
      discarded: '已废弃',
    }[card.status] || card.status,
    removal_action: ['archived', 'discarded'].includes(card.status) ? null : taskCount > 0 ? 'archive' : 'discard',
    removal_reason: taskCount > 0 ? '视频卡已有生成记录，只能归档' : '空视频卡可以废弃',
  };
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
      image: { enabled: true, model: 'Seedream 5.0 Pro', endpoint: '/api/assets/generate', message: '可用' },
      video: { enabled: true, model: 'Seedance 2.0', endpoint: '/api/tasks/create', status_endpoint_template: '/api/video/status/:taskId?refresh=true', message: '可用' },
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
  if (url.pathname === '/api/assets/library') return sendJson(response, { items: [] });
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
  if (cardMatch && request.method === 'PATCH') {
    const body = await readJsonBody(request);
    const card = videoCards.find((item) => item.id === decodeURIComponent(cardMatch[1]));
    if (!card) return sendJson(response, { error: '视频卡不存在' }, 404);
    if (body.action === 'archive') card.status = 'archived';
    if (body.action === 'discard') card.status = 'discarded';
    return sendJson(response, { video_card: normalizeCard(card), action: body.action });
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
    return sendJson(response, {
      success: true,
      status: 'succeeded',
      assets: [asset],
      asset_id: asset.assetId,
      reference_image_id: asset.referenceImageId,
      workspace_asset_id: asset.workspaceAssetId,
    });
  }

  if (url.pathname === '/api/tasks/create' && request.method === 'POST') {
    const taskId = `task-mock-${sequence++}`;
    taskPollCounts.set(taskId, 0);
    return sendJson(response, { id: taskId, task_id: taskId, status: 'submitted', provider_task_id: `provider-${taskId}`, frozen_cost: 0 });
  }

  const statusMatch = url.pathname.match(/^\/api\/video\/status\/([^/]+)$/);
  if (statusMatch) {
    const taskId = decodeURIComponent(statusMatch[1]);
    const pollCount = (taskPollCounts.get(taskId) || 0) + 1;
    taskPollCounts.set(taskId, pollCount);
    const succeeded = pollCount >= 2;
    return sendJson(response, {
      id: taskId,
      provider_task_id: `provider-${taskId}`,
      local_status: succeeded ? 'succeeded' : 'running',
      result_video_url: succeeded ? `/mock/${taskId}.mp4` : null,
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
