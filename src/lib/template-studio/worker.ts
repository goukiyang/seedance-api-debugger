import { randomUUID } from 'node:crypto';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getMuskApiSettings, isMuskApiReady, createMuskChatCompletion, MuskApiError } from '@/lib/integrations/musk';
import { authorizeStudioAssets } from './assets';
import { requireStudioUser } from './common';
import { StudioError } from './errors';
import { ensureStudioSnapshotSourceStillUsable } from './handoff';
import { parseWorkerSnapshot, workerSafeUsage } from './runs';
import { TEMPLATE_STUDIO_TEXT_ENABLED_KEY } from './capabilities';
import { TEMPLATE_STUDIO_LIMITS } from './validation';

const LEASE_MS = 90_000;
const MUSK_TIMEOUT_MS = 45_000;

export type StudioWorkerControl = { shouldStop(): boolean };

type WorkerUserRecord = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;

function parseFeishuDepartmentIds(value: string | null) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function projectWorkerSessionUser(owner: WorkerUserRecord): SessionUser | null {
  if (owner.status !== 'active' || (owner.expires_at && owner.expires_at.getTime() <= Date.now())
    || (owner.role !== 'admin' && owner.role !== 'user')
    || (owner.account_type !== 'internal' && owner.account_type !== 'external')) return null;

  return {
    id: owner.id,
    name: owner.name,
    username: owner.username,
    email: owner.email,
    role: owner.role,
    account_type: owner.account_type,
    user_profile: owner.user_profile,
    feature_profile_id: owner.feature_profile_id,
    status: owner.status,
    expires_at: owner.expires_at,
    mobile: owner.mobile,
    avatar_url: owner.avatar_url,
    feishu: {
      user_id: owner.feishu_user_id,
      open_id: owner.feishu_open_id,
      union_id: owner.feishu_union_id,
      tenant_key: owner.feishu_tenant_key,
      employee_no: owner.feishu_employee_no,
      department_ids: parseFeishuDepartmentIds(owner.feishu_department_ids),
      last_sync_at: owner.last_feishu_sync_at,
    },
  };
}

function textFeatureEnabled(value: string | null | undefined) {
  try { return value ? JSON.parse(value) === true : false; } catch { return false; }
}

async function updateRun(id: string, token: string, where: { delivery_state?: string }, data: Record<string, unknown>) {
  return prisma.videoStudioRun.updateMany({
    where: { id, status: 'running', lease_token: token, ...where },
    data: { ...data, updated_at: new Date() },
  });
}

export async function recoverExpiredStudioRuns() {
  const expired = await prisma.videoStudioRun.findMany({
    where: { mode: 'llm', status: 'running', lease_expires_at: { lt: new Date() } },
    select: { id: true, lease_token: true, delivery_state: true },
    take: 50,
  });
  for (const row of expired) {
    if (row.delivery_state === 'not_sent') {
      await prisma.videoStudioRun.updateMany({
        where: { id: row.id, status: 'running', lease_token: row.lease_token, delivery_state: 'not_sent', lease_expires_at: { lt: new Date() } },
        data: { status: 'queued', lease_token: null, lease_expires_at: null, updated_at: new Date() },
      });
    } else {
      await prisma.videoStudioRun.updateMany({
        where: { id: row.id, status: 'running', lease_token: row.lease_token, delivery_state: row.delivery_state, lease_expires_at: { lt: new Date() } },
        data: { status: 'uncertain', delivery_state: 'unknown', lease_token: null, lease_expires_at: null, error_message: '处理连接中断，结果未确认；系统不会自动重复提交。', completed_at: new Date(), updated_at: new Date() },
      });
    }
  }
  return expired.length;
}

async function claimStudioRun() {
  const candidates = await prisma.videoStudioRun.findMany({
    where: { mode: 'llm', status: 'queued', delivery_state: 'not_sent' },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: 5,
  });
  for (const run of candidates) {
    const token = randomUUID();
    const result = await prisma.videoStudioRun.updateMany({
      where: { id: run.id, status: 'queued', delivery_state: 'not_sent', lease_token: null },
      data: { status: 'running', lease_token: token, lease_expires_at: new Date(Date.now() + LEASE_MS), attempt: { increment: 1 }, updated_at: new Date() },
    });
    if (result.count === 1) return { run, token };
  }
  return null;
}

function outputPrompt(content: string) {
  if (content.length > TEMPLATE_STUDIO_LIMITS.llmOutput) throw new Error('AI 返回内容超出长度限制');
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('AI 返回格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 返回格式无效');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.prompt !== 'string' || !record.prompt.trim() || record.prompt.length > TEMPLATE_STUDIO_LIMITS.prompt) {
    throw new Error('AI 返回格式无效');
  }
  return record.prompt.trim();
}

async function markTerminal(id: string, token: string, status: 'failed' | 'uncertain', message: string, deliveryState: 'not_sent' | 'response_received' | 'unknown') {
  await updateRun(id, token, {}, {
    status, delivery_state: deliveryState, lease_token: null, lease_expires_at: null,
    error_message: message, completed_at: new Date(),
  });
}

export async function processStudioPromptOnce() {
  const claimed = await claimStudioRun();
  if (!claimed) return false;
  const { run, token } = claimed;
  let sent = false;
  try {
    const owner = await prisma.user.findUnique({ where: { id: run.owner_user_id } });
    const user = owner ? projectWorkerSessionUser(owner) : null;
    if (!user || user.account_type !== 'internal') {
      await markTerminal(run.id, token, 'failed', '账号当前不可用，AI 整理未提交。', 'not_sent');
      return true;
    }
    requireStudioUser(user);
    const snapshot = parseWorkerSnapshot(run.snapshot_json);
    await ensureStudioSnapshotSourceStillUsable(user, snapshot);
    await authorizeStudioAssets(user, snapshot.assets);

    const setting = await prisma.platformSetting.findUnique({ where: { key: TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, select: { value_json: true } });
    const settings = await getMuskApiSettings();
    if (!textFeatureEnabled(setting?.value_json) || !isMuskApiReady(settings)) {
      await markTerminal(run.id, token, 'failed', 'AI 整理当前未启用或服务未就绪，未提交上游。', 'not_sent');
      return true;
    }

    const send = await updateRun(run.id, token, { delivery_state: 'not_sent' }, {
      delivery_state: 'sending', lease_expires_at: new Date(Date.now() + LEASE_MS),
    });
    if (send.count !== 1) return true;
    sent = true;
    const completion = await createMuskChatCompletion({
      settings,
      timeoutMs: MUSK_TIMEOUT_MS,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是视频提示词整理助手。根据用户文字要求整理为可直接使用的视频提示词。素材仅以类型和槽位文字说明提供，不代表你看到了素材内容。只能输出严格 JSON，且对象只能包含一个字符串字段 prompt；不要输出其他字段、Markdown、解释或素材 URL。' },
        { role: 'user', content: JSON.stringify({
          requirements: snapshot.recipe?.instruction || '',
          fields: snapshot.input.values,
          userPrompt: snapshot.input.draftPrompt,
          currentPrompt: snapshot.prompt,
          parameters: snapshot.parameters,
          assets: snapshot.assets.map(({ role, type, slotKey }) => ({ role, type, ...(slotKey ? { slotKey } : {}) })),
        }) },
      ],
    });
    const receipt = await updateRun(run.id, token, { delivery_state: 'sending' }, {
      delivery_state: 'response_received', model: completion.model?.slice(0, 100) || null,
      usage_json: JSON.stringify(workerSafeUsage(completion.usage)),
    });
    if (receipt.count !== 1) return true;
    let prompt: string;
    try { prompt = outputPrompt(completion.content); }
    catch (error) {
      await updateRun(run.id, token, { delivery_state: 'response_received' }, {
        status: 'failed', lease_token: null, lease_expires_at: null,
        error_message: error instanceof Error ? error.message : 'AI 返回格式无效', completed_at: new Date(),
      });
      return true;
    }
    await updateRun(run.id, token, { delivery_state: 'response_received' }, {
      status: 'succeeded', prompt, error_message: null, lease_token: null, lease_expires_at: null, completed_at: new Date(),
    });
  } catch (error) {
    const definiteClientRejection = error instanceof MuskApiError && error.code === 'musk_api_upstream_error' && error.status >= 400 && error.status < 500;
    await markTerminal(
      run.id,
      token,
      sent && !definiteClientRejection ? 'uncertain' : 'failed',
      sent && !definiteClientRejection ? '上游结果未确认；系统不会自动重复提交。' : error instanceof StudioError ? error.message : 'AI 整理失败，未保存上游原始输出。',
      sent && !definiteClientRejection ? 'unknown' : sent ? 'response_received' : 'not_sent',
    );
  }
  return true;
}

export async function runStudioPromptWorker(control: StudioWorkerControl, options: { idleMs?: number; once?: boolean } = {}) {
  const idleMs = Math.max(250, Math.min(options.idleMs || 1500, 10000));
  while (!control.shouldStop()) {
    await recoverExpiredStudioRuns();
    if (control.shouldStop()) break;
    const worked = await processStudioPromptOnce();
    if (options.once || control.shouldStop()) break;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, idleMs));
  }
}
