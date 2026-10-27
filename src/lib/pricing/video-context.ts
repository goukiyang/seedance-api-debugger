import { signPurpose, verifyPurpose } from '@/lib/security/signatures';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanGenerateInProject } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
import { shouldBillProjectBudget } from '@/lib/projects/budget';
import { authorizeStudioRunForGeneration } from '@/lib/template-studio/handoff';
import { authorizeStudioAssets } from '@/lib/template-studio/assets';
import { StudioError } from '@/lib/template-studio/errors';
import { getMissingRequiredStudioAssetSlot } from '@/lib/template-studio-video-handoff';
import type { StudioAssetInput } from '@/lib/template-studio/types';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { pricingFingerprint, type PricingClient } from './catalog';
import { PRICING_POLICY_KEY } from './admin-contract';
import { PricingChargeError } from './frozen-charge';
import type { PricingVideoPurpose, PricingReferenceVideo } from './pricing-authoring-contract';
import { parseMultiviewSettingsBinding } from '@/lib/video/multiview-generation-contract';

export type VideoPricingContext = {
  fingerprint: string;
  actorId: string;
  projectId: string;
  videoCardId: string | null;
  payer: { kind: 'project' | 'user'; id: string };
  referenceVideo: PricingReferenceVideo;
  purpose: PricingVideoPurpose;
  referenceVideoCount: number;
  referenceVideoFingerprint?: string;
  templateRunId: string | null;
};
export class VideoPricingContextError extends Error {
  constructor(message: string, public readonly status = 409, public readonly code = 'pricing_context_invalid') { super(message); }
}
function list(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 4096)) throw new PricingChargeError('视频报价素材列表无效，原输入未改变');
  return value.map(item => (item as string).trim());
}
export function normalizedVideoPricingReferenceScope(input: unknown, templateReferences?: readonly string[]) {
  const seen = new Set<string>();
  const urls = list(templateReferences === undefined ? input : [...templateReferences], 3).filter(url => {
    const key = videoReferenceScopeUrl(url);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { urls, referenceVideo: urls.length ? 'present' as const : 'none' as const,
    referenceVideoCount: urls.length, referenceVideoFingerprint: pricingFingerprint(urls.map(videoReferenceScopeUrl).sort()) };
}
function videoReferenceScopeUrl(url: string) { return siteUploadPathFromUrl(url) || url; }
export function assertVideoPricingFinalReferences(context: VideoPricingContext, urls: readonly string[]) {
  const actual = normalizedVideoPricingReferenceScope([...urls]);
  if (actual.referenceVideoCount !== context.referenceVideoCount || context.referenceVideoFingerprint
    && actual.referenceVideoFingerprint !== context.referenceVideoFingerprint) throw new VideoPricingContextError('最终参考视频与报价范围不一致，请重新报价；尚未生成', 409, 'pricing_context_changed');
}

/** Read-only: no workspace creation, public upload, approval consumption or upstream request. */
async function resolveContext(user: SessionUser, body: Record<string, unknown>,
  operation: 'create' | 'draft_upgrade' = 'create'): Promise<VideoPricingContext> {
  if (Buffer.byteLength(JSON.stringify(body)) > 262144) throw new PricingChargeError('视频报价上下文过大');
  let projectId = typeof body.project_id === 'string' ? body.project_id : '';
  const videoCardId = typeof body.video_card_id === 'string' && body.video_card_id ? body.video_card_id : null;
  if (videoCardId && !projectId) projectId = (await prisma.videoCard.findUnique({ where: { id: videoCardId }, select: { project_id: true } }))?.project_id || '';
  if (!projectId) throw new PricingChargeError('请先选择报价所属项目');
  const access = await assertCanGenerateInProject(user, projectId);
  if (videoCardId) await assertCanGenerateInVideoCard(user, projectId, videoCardId);
  const payer = shouldBillProjectBudget(access.project!) ? { kind: 'project' as const, id: projectId } : { kind: 'user' as const, id: user.id };
  const templateRunId = typeof body.template_studio_run_id === 'string' && body.template_studio_run_id ? body.template_studio_run_id : null;
  let templateVideoUrls: string[] | undefined;
  let templateBinding: unknown = null;
  if (templateRunId) {
    const handoff = await authorizeStudioRunForGeneration(user, templateRunId);
    if (!Array.isArray(body.template_studio_assets) || body.template_studio_assets.length > 32) throw new PricingChargeError('模板报价缺少最终素材');
    const rawAssets = body.template_studio_assets as Array<Record<string, unknown>>;
    if (rawAssets.some(item => !item || typeof item.assetId !== 'string' || !item.assetId.trim() || !['image', 'video', 'audio'].includes(String(item.type))
      || !['reference', 'first', 'last'].includes(String(item.role)))) throw new PricingChargeError('模板报价素材无效');
    const submitted: StudioAssetInput[] = rawAssets.map(item => ({ assetId: (item.assetId as string).trim(),
      type: item.type as StudioAssetInput['type'], role: item.role as StudioAssetInput['role'],
      ...(typeof item.slotKey === 'string' && item.slotKey.trim() ? { slotKey: item.slotKey.trim() } : {}) }));
    if (new Set(submitted.map(item => item.assetId)).size !== submitted.length) throw new PricingChargeError('模板报价素材重复');
    for (const original of handoff.assets) {
      const item = submitted.find(asset => asset.assetId === original.assetId);
      if (item && (item.role !== original.role || item.type !== original.type || item.slotKey !== original.slotKey)) throw new PricingChargeError('模板原素材角色已变化，请重新准备');
    }
    const slots = handoff.snapshot.recipe?.assetSlots || [];
    const counts = new Map<string, number>();
    for (const item of submitted) {
      if ((item.role === 'first' || item.role === 'last') && item.type !== 'image') throw new PricingChargeError('首尾帧报价只能使用图片');
      if (!item.slotKey) continue;
      const slot = slots.find(value => value.key === item.slotKey);
      if (!slot || slot.role !== item.role || !slot.types.includes(item.type)
        || !handoff.assets.some(original => original.assetId === item.assetId && original.slotKey === item.slotKey)) throw new PricingChargeError('模板报价槽位与已保存来源不符');
      const count = (counts.get(item.slotKey) || 0) + 1;
      if (count > (slot.maxItems || 1)) throw new PricingChargeError('模板报价槽位数量超出原限制');
      counts.set(item.slotKey, count);
    }
    if (getMissingRequiredStudioAssetSlot(slots, submitted)) throw new PricingChargeError('模板报价缺少必填素材，未按无参考视频计价');
    await authorizeStudioAssets(user, submitted);
    const ids = submitted.filter(item => item.type === 'video' && item.role === 'reference').map(item => item.assetId);
    const rows = await prisma.asset.findMany({ where: { id: { in: ids }, status: 'active', type: 'video' }, select: { id: true, original_url: true, created_at: true, hash: true, file_size: true } });
    if (rows.length !== ids.length) throw new AuthError('模板参考视频已失效', 403);
    templateVideoUrls = rows.map(row => row.original_url);
    templateBinding = { runId: templateRunId, template: handoff.snapshot.templateVersion, assets: submitted,
      videoVersions: rows.map(row => ({ id: row.id, version: pricingFingerprint([videoReferenceScopeUrl(row.original_url), row.created_at, row.hash, row.file_size]) }))
        .sort((left, right) => left.id.localeCompare(right.id)) };
  }
  const { referenceVideo, referenceVideoCount, referenceVideoFingerprint } = normalizedVideoPricingReferenceScope(body.reference_video_urls, templateVideoUrls);
  const purpose = operation === 'draft_upgrade' ? 'draft_upgrade' : body.draft === true ? 'draft' : 'standard';
  const snapshot = body.multiview_generation && typeof body.multiview_generation === 'object' && !Array.isArray(body.multiview_generation)
    ? body.multiview_generation as Record<string, unknown> : null;
  const rawSettings = snapshot?.settingsBinding ?? body.multiview_settings;
  const multiviewSettings = rawSettings === undefined ? null : parseMultiviewSettingsBinding(rawSettings);
  if (rawSettings !== undefined && !multiviewSettings || body.multiview_settings !== undefined && snapshot?.settingsBinding !== undefined
    && JSON.stringify(parseMultiviewSettingsBinding(body.multiview_settings)) !== JSON.stringify(multiviewSettings)) {
    throw new PricingChargeError('已保存设置与报价绑定不一致，未提交生成');
  }
  const fingerprint = pricingFingerprint({ v: 1, actorId: user.id, projectId, videoCardId, payer,
    provider: body.provider || 'seedance', model: body.model, resolution: body.resolution, duration: body.duration,
    ratio: body.ratio || null, sourceDraftTaskId: body.source_draft_task_id || null, purpose, referenceVideo, referenceVideoFingerprint, templateBinding,
    ...(multiviewSettings ? { multiviewSettings } : {}) });
  return { fingerprint, actorId: user.id, projectId, videoCardId, payer, referenceVideo, purpose, referenceVideoCount, referenceVideoFingerprint, templateRunId };
}
export async function resolveVideoPricingContext(user: SessionUser, body: Record<string, unknown>, operation: 'create' | 'draft_upgrade' = 'create') {
  try { return await resolveContext(user, body, operation); }
  catch (error) {
    if (error instanceof AuthError || error instanceof StudioError) throw new VideoPricingContextError(error.message, error.status);
    throw error;
  }
}
export function savedVideoPricingContextInput(task: { id: string; provider: string; model: string | null; project_id: string | null;
  video_card_id: string | null; ratio: string | null; duration: number | null; resolution?: string | null; reference_video_urls: string | null },
  upgrade = false): Record<string, unknown> {
  let referenceVideos: unknown = [];
  if (task.reference_video_urls) { try { referenceVideos = JSON.parse(task.reference_video_urls); } catch { throw new PricingChargeError('原视频素材记录无法核实'); } }
  return { project_id: task.project_id, video_card_id: task.video_card_id, provider: task.provider === 'h3' ? 'h3' : 'seedance',
    model: task.model, ratio: task.ratio || '16:9', duration: task.duration || 5, resolution: upgrade ? '1080p' : task.resolution || '480p',
    reference_video_urls: referenceVideos, draft: false, ...(upgrade ? { source_draft_task_id: task.id } : {}) };
}
export async function videoPricingRequiresContext(model: string, channel: string, client: PricingClient = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY } });
  if (!row) return false;
  const policy = JSON.parse(row.value_json);
  if (!Array.isArray(policy.rules)) throw new PricingChargeError('收费规则无法读取');
  return policy.rules.some((rule: { identity: { kind: string; modelId: string; channelId: string; specifications: Record<string, string> } }) =>
    rule.identity.kind === 'video' && rule.identity.modelId === model && rule.identity.channelId === channel
    && (rule.identity.specifications.referenceVideo !== undefined || rule.identity.specifications.pricingPurpose !== undefined));
}
function sign(body: string) {
  return signPurpose('pricing', `video-pricing-context-v1\0${body}`);
}
export function issueVideoPricingCredential(context: VideoPricingContext, revision: string | null, amount: number) {
  const body = Buffer.from(JSON.stringify({ v: 1, scope: context.fingerprint, actor: context.actorId,
    revision, amount, ceiling: amount, expires: Date.now() + 300000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
export function verifyVideoPricingCredential(token: unknown, context: VideoPricingContext, revision: string | null, amount: number) {
  try {
    if (typeof token !== 'string' || token.length > 4096) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error();
    if (!verifyPurpose('pricing', `video-pricing-context-v1\0${parts[0]}`, parts[1], { legacy: true })) throw new Error();
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (value.v !== 1 || value.actor !== context.actorId || value.scope !== context.fingerprint || value.revision !== revision
      || value.amount !== amount || value.ceiling !== amount || !Number.isSafeInteger(value.expires)
      || value.expires <= Date.now() || value.expires > Date.now() + 301000) throw new Error();
  } catch { throw new PricingChargeError('报价范围或有效期已变化，请保留输入重新报价；尚未生成'); }
}

export function videoPricingBusinessFingerprint(body: Record<string, unknown>) {
  const { pricing_quote_token: _token, pricing_revision: _revision, pricing_fingerprint_version: _version, ...stable } = body;
  return `pricing-v2:${pricingFingerprint(stable)}`;
}
