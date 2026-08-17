#!/usr/bin/env node
/**
 * 无线画布 — 纯 API 验收脚本(sd2 线上后端)
 *
 * 默认只读:校验登录态 → 读取 bootstrap 能力 → 列出项目/点数。
 * 真实写入/扣费步骤必须显式加开关:
 *   --create-project   新建测试项目(写库)
 *   --create-card      在项目下新建视频卡(写库)
 *   --save-doc         保存一份画布文档并回读(写库)
 *   --text             真实文本生成(调 LLM,轻微扣费)
 *   --upload           上传一张小图(写库)
 *   --image            真实图片生成(扣费,默认 size=1K 低风险)
 *   --video            真实视频生成 + 轮询到终态(重度扣费,必须明确授权)
 *
 * 登录方式(任选):
 *   1. --login <username>  密码从环境变量 SD2_PASSWORD 读取,登录后 cookie 存 .acceptance-cookie
 *   2. SD2_SESSION_COOKIE  直接给 session cookie 值(飞书登录账号推荐此方式)
 *   3. 已有 .acceptance-cookie 文件(登录一次后复用)
 *
 * 注:线上 sd2 为飞书登录时,账号密码登录不可用;请在浏览器飞书登录后,
 *    通过 DevTools → Application → Cookies → https://sd2.youdoodesign.com
 *    复制名为 session 的 Value(session 是 HttpOnly,document.cookie 拿不到)。
 *
 * 用法示例:
 *   SD2_PASSWORD=xxx node scripts/acceptance/ultimate-canvas-api-acceptance.mjs --login test@example.com
 *   node scripts/acceptance/ultimate-canvas-api-acceptance.mjs --create-project --create-card --save-doc --text
 *
 * 注意:对线上执行写库/生成前,确认测试账号有点数且授权本次扣费。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COOKIE_FILE = path.join(REPO_ROOT, '.acceptance-cookie');

const BASE = (process.env.SD2_BASE_URL || 'https://sd2.youdoodesign.com').replace(/\/+$/, '');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// cookie 管理
// ---------------------------------------------------------------------------
let cookie = process.env.SD2_SESSION_COOKIE || '';
if (!cookie && fs.existsSync(COOKIE_FILE)) {
  cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
}

function saveCookie(value) {
  cookie = value;
  fs.writeFileSync(COOKIE_FILE, value, { mode: 0o600 });
  console.log(`💾 已保存 cookie 到 ${COOKIE_FILE}(600 权限,已入 .gitignore)`);
}

function parseSetCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const raw of list) {
    const m = /^session=([^;]+)/.exec(raw);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------
async function req(method, urlPath, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.Cookie = `session=${cookie}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
async function doLogin(username) {
  const password = process.env.SD2_PASSWORD;
  if (!password) {
    console.error('❌ 需要密码:请设置环境变量 SD2_PASSWORD(不要写在命令行/聊天里)');
    process.exit(2);
  }
  const { status, data, headers } = await req('POST', '/api/auth/login', {
    identifier: username, password,
  });
  if (status !== 200) {
    console.error(`❌ 登录失败 HTTP ${status}:`, JSON.stringify(data));
    process.exit(2);
  }
  const token = parseSetCookie(headers);
  if (!token) { console.error('❌ 登录响应缺少 session cookie'); process.exit(2); }
  saveCookie(token);
  console.log(`👤 已登录:${data?.user?.name || data?.user?.username || username}(role=${data?.user?.role || '?'})`);
}

// ---------------------------------------------------------------------------
// 只读检查
// ---------------------------------------------------------------------------
async function checkMe() {
  const { status, data } = await req('GET', '/api/auth/me');
  if (status !== 200 || !data?.user) {
    record('登录态', false, `HTTP ${status} ${JSON.stringify(data).slice(0, 120)}`);
    return null;
  }
  record('登录态', true, `${data.user.name || data.user.username} / role=${data.user.role} / status=${data.user.status}`);
  return data.user;
}

async function checkBootstrap() {
  const { status, data } = await req('GET', '/api/tools/ultimate-canvas/bootstrap');
  if (status !== 200) {
    record('bootstrap', false, `HTTP ${status} ${JSON.stringify(data).slice(0, 150)}`);
    return null;
  }
  record('bootstrap', true, '能力上下文已返回');
  const caps = data.capabilities || {};
  for (const key of ['text', 'image', 'video']) {
    const c = caps[key] || {};
    record(`capabilities.${key}`, Boolean(c.enabled),
      `${c.model || c.provider || '?'} | enabled=${c.enabled}${c.enabled ? '' : ` | ${c.message || '不可用'}`}`);
  }
  return data;
}

async function checkCredits() {
  const { status, data } = await req('GET', '/api/me/credits');
  if (status !== 200) {
    record('点数', false, `HTTP ${status}`);
    return null;
  }
  const summary = data?.summary || data?.account || data;
  record('点数', true, JSON.stringify(summary).slice(0, 200));
  return summary;
}

// ---------------------------------------------------------------------------
// 写入/生成步骤
// ---------------------------------------------------------------------------
async function createProject() {
  const name = `API验收-${Date.now().toString(36)}`;
  // 注意:type=personal 不会新建,后端会返回默认项目(deduplicated:true);
  // 只有 type=team 才会真正创建项目。
  const { status, data } = await req('POST', '/api/projects', { name, type: 'team' });
  if (status !== 201 && status !== 200) {
    record('新建项目', false, `HTTP ${status} ${JSON.stringify(data).slice(0, 120)}`);
    return null;
  }
  const id = data?.project?.id || data?.id;
  if (!id) {
    record('新建项目', false, `未解析到 id:${JSON.stringify(data).slice(0, 120)}`);
    return null;
  }
  record('新建项目', Boolean(id), `${name} → ${id}${data.deduplicated ? '(注意:返回的是默认项目,未真正新建)' : ''}`);
  return id;
}

async function createVideoCard(projectId) {
  const { status, data } = await req('POST', `/api/projects/${projectId}/video-cards`, {
    title: `API验收卡-${Date.now().toString(36)}`,
  });
  if (status !== 201 && status !== 200) {
    record('新建视频卡', false, `HTTP ${status} ${JSON.stringify(data).slice(0, 120)}`);
    return null;
  }
  const id = data?.video_card?.id || data?.videoCard?.id || data?.card?.id || data?.id;
  record('新建视频卡', Boolean(id), id ? `card → ${id}` : `未解析到 id:${JSON.stringify(data).slice(0, 120)}`);
  return id || null;
}

async function saveAndLoadDocument(projectId, videoCardId) {
  const documentJson = JSON.stringify({
    schema: 'ultimate_canvas.v1',
    context: { project_id: projectId, video_card_id: videoCardId },
    canvas: { nodes: [{ id: 'node-accept-1', type: 'text', data: { text: 'API 验收' } }], connections: [], viewport: { scale: 1, offsetX: 0, offsetY: 0 } },
  });
  const save = await req('POST', '/api/tools/ultimate-canvas/document', {
    project_id: projectId,
    title: 'API 验收文档',
    active_generation_node_id: 'node-accept-1',
    document_json: documentJson,
  });
  if (save.status !== 200 && save.status !== 201) {
    record('保存画布', false, `HTTP ${save.status} ${JSON.stringify(save.data).slice(0, 150)}`);
    return null;
  }
  const docId = save.data?.document?.id || save.data?.id;
  record('保存画布', true, `doc → ${docId}`);
  const load = await req('GET', `/api/tools/ultimate-canvas/document?project_id=${encodeURIComponent(projectId)}`);
  if (load.status !== 200) {
    record('回读画布', false, `HTTP ${load.status}`);
    return null;
  }
  const parsed = load.data?.document?.document_json || load.data?.document_json || '';
  const hasContext = videoCardId ? parsed.includes(videoCardId) : false;
  record('回读画布', hasContext, hasContext ? 'context.video_card_id 命中' : videoCardId ? '未命中 context' : '跳过(无视频卡上下文)');
  return docId;
}

async function generateText(projectId, videoCardId) {
  const { status, data } = await req('POST', '/api/tools/ultimate-canvas/generate', {
    kind: 'text',
    mode: 'rewrite',
    prompt: '把下面这句话改写成更口语化的短视频口播:这是一条用于 API 验收的测试文本。',
    project_id: projectId,
    video_card_id: videoCardId,
  });
  if (status !== 200) {
    record('文本生成', false, `HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  const content = data?.result?.content || data?.content || data?.text || JSON.stringify(data).slice(0, 120);
  record('文本生成', true, String(content).slice(0, 120));
  return data;
}

async function uploadTinyImage(projectId, videoCardId) {
  // 1x1 红色 PNG(最小编码)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'acceptance-1x1.png');
  form.append('project_id', projectId);
  form.append('video_card_id', videoCardId);
  const headers = {};
  if (cookie) headers.Cookie = `session=${cookie}`;
  const res = await fetch(`${BASE}/api/tools/ultimate-canvas/upload`, { method: 'POST', headers, body: form });
  const data = await res.json().catch(() => null);
  if (res.status !== 200 && res.status !== 201) {
    record('图片上传', false, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 150)}`);
    return null;
  }
  record('图片上传', true, `asset → ${data?.asset?.id || data?.id || '?'}`);
  return data;
}

async function generateImage(projectId, videoCardId) {
  const { status, data } = await req('POST', '/api/assets/generate', {
    prompt: '一只红色苹果,纯色背景,极简',
    project_id: projectId,
    video_card_id: videoCardId,
    size: '1K',
    output_format: 'png',
    response_format: 'url',
    watermark: false,
  });
  if (status !== 200) {
    record('图片生成', false, `HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  record('图片生成', true, JSON.stringify(data).slice(0, 200));
  return data;
}

async function createAndPollVideo(projectId, videoCardId) {
  const paidHeaders = {
    'x-paid-generation-intent': 'user_authorized_real_provider',
    'x-paid-generation-reason': 'API 验收:用户明确授权本次真实视频生成',
  };
  const create = await req('POST', '/api/tasks/create', {
    prompt: '一只小猫在草地上打滚,近景,柔和光线',
    project_id: projectId,
    video_card_id: videoCardId,
    client_name: 'ultimate_canvas',
    source_metadata: { source: 'ultimate_canvas', canvas_node_id: 'node-accept-video' },
  }, paidHeaders);
  if (create.status !== 200 && create.status !== 201) {
    record('视频创建', false, `HTTP ${create.status} ${JSON.stringify(create.data).slice(0, 200)}`);
    return null;
  }
  const taskId = create.data?.task?.id || create.data?.id;
  record('视频创建', true, `task → ${taskId}`);
  if (!taskId) return null;

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const poll = await req('GET', `/api/video/status/${encodeURIComponent(taskId)}?refresh=true`);
    if (poll.status !== 200) {
      record('视频轮询', false, `HTTP ${poll.status} ${JSON.stringify(poll.data).slice(0, 120)}`);
      return null;
    }
    const status = poll.data?.task?.status || poll.data?.status || poll.data?.local_status;
    console.log(`  ⏳ 轮询 ${taskId} → ${status}`);
    if (['succeeded', 'failed', 'cancelled'].includes(status)) {
      record('视频终态', status === 'succeeded', status);
      return poll.data;
    }
    await sleep(8000);
  }
  record('视频轮询', false, '10 分钟超时未到终态');
  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const loginUser = flagValue('--login');
  if (loginUser) await doLogin(loginUser);
  if (!cookie) {
    console.error('❌ 无登录态。请用 --login <username>(配 SD2_PASSWORD)或 SD2_SESSION_COOKIE 提供。');
    process.exit(2);
  }

  const user = await checkMe();
  if (!user) process.exit(1);
  const bootstrap = await checkBootstrap();
  await checkCredits();

  if (flags.has('--list-projects')) {
    const { status, data } = await req('GET', '/api/projects');
    record('项目列表', status === 200, status === 200 ? `${(data?.projects || []).length} 个项目` : `HTTP ${status}`);
  }

  const context = {};
  if (flags.has('--create-project')) context.projectId = await createProject();
  if (flags.has('--create-card') && context.projectId) context.videoCardId = await createVideoCard(context.projectId);
  const needCard = flags.has('--save-doc') || flags.has('--text') || flags.has('--upload') || flags.has('--image') || flags.has('--video');
  if (needCard && !context.videoCardId) {
    record('依赖步骤', false, '缺少视频卡上下文(新建视频卡失败),已跳过保存/生成/上传步骤');
    context.projectId = null;
  }
  if (flags.has('--save-doc') && context.projectId) await saveAndLoadDocument(context.projectId, context.videoCardId);
  if (flags.has('--text') && context.projectId) await generateText(context.projectId, context.videoCardId);
  if (flags.has('--upload') && context.projectId) await uploadTinyImage(context.projectId, context.videoCardId);
  if (flags.has('--image') && context.projectId) await generateImage(context.projectId, context.videoCardId);
  if (flags.has('--video') && context.projectId) await createAndPollVideo(context.projectId, context.videoCardId);

  if (flags.has('--text') || flags.has('--image') || flags.has('--video')) {
    await checkCredits(); // 生成后对比点数
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n================ 验收汇总 ================');
  console.log(`通过 ${results.length - failed}/${results.length},失败 ${failed}`);
  if (context.projectId) console.log(`测试项目:${context.projectId} 测试卡:${context.videoCardId || '(未创建)'}`);
  console.log('提示:请在后台为测试账号核对点数流水;不需要的测试项目可删除/归档。');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 脚本异常:', err);
  process.exit(1);
});
