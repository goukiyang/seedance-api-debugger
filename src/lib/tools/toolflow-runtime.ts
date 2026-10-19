import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { allocateTaskCredits, settleTaskCredits, type CreditPolicyUser } from '@/lib/credits/policy';
import { createInAppNotification } from '@/lib/notifications';
import { getImageStudioSettings, IMAGE_STUDIO_SETTING_KEY } from '@/lib/image-studio/settings';
import { canUseCompanyTemplates, canViewStudioPreset, type ImageStudioIdentity } from '@/lib/image-studio/access';
import { defaultImageStudioQuality, normalizeImageStudioQuality, IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';
import { normalizeStudioRatio, resolveStudioAspectRatio, legacyStudioRatioSize as studioRatioSize } from '@/lib/image-studio/ratios';
import { captureImageGenerationChannel, getImageGenerationChannelOptions, getImageGenerationSettingsForModel, getManagedImageGenerationChannels, hasLegacyImageGenerationModelOverride, resolveImageGenerationChannelSnapshot, imageGenerationModelOutputPlan, type ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation';
import { normalizeImageResolution, isValidImageDimension, IMAGE_RESOLUTION_OPTIONS } from '@/lib/image-generation/resolution';
import { imageOutputPlanHash, parseImageOutputPlan, publicImageOutputPlan, savedImageRatioContractVersion, type ImageOutputPlan, type ImageRatioContractVersion, type PublicImageOutputPlan } from '@/lib/image-generation/output-plan';
import { assertSharedStudioWorkerReady, safeImageChannelSnapshot } from '@/lib/image-studio/tasks';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { imageBillingScope } from '@/lib/image-studio/billing-scope';
import { fixedImageBillingContract, imageSpecification, withPricingImageContract } from '@/lib/image-studio/billing-quote';
import { creditsToCents, parseImageBillingContract, type ImageBillingContract } from '@/lib/image-studio/billing-contract';
import { studioTaskState, studioBillingState, publicPricingTaskState, studioTaskStates } from '@/lib/image-studio/pricing-state';
import { assertNewPricingCharge, frozenPricingCredits } from '@/lib/pricing/charge';
import { withImagePricing } from '@/lib/pricing/image';
import { addCredits, sumCredits, assertCreditWriteback, creditsFromCents } from '@/lib/credits/precision';
import { reserveImageStudioQueueCapacity, assertImageStudioAdmissionOpen, QueueCapacityError, QueueMaintenanceError } from '@/lib/image-studio/queue-capacity';
import { assertCanUseToolFlow, parseJsonObject, validateToolFlowGraph, type ToolFlowGraph, type ToolFlowNode } from './toolflow';

type Tx = Prisma.TransactionClient;
type ToolFlowOutputIntent = { resolution: string; requestedRatio: string; explicitSize?: string };
type ToolFlowQuoteStep = {
  outputIntent?: ToolFlowOutputIntent;
  outputPlan?: PublicImageOutputPlan | null;
  imageChannel?: ImageGenerationChannelSnapshot;
  nodeId: string;
  templateId: string | null;
  moduleId: string | null;
  templateVersion: string | null;
  model: string;
  count: number;
  unitCredits: number | null;
  estimatedCredits: number | null;
  status: 'fixed' | 'unknown';
  pricingRevision: string | null;
  contractDigest: string;
};
type ToolFlowQuote = {
  ratioContractVersion?: ImageRatioContractVersion;
  inputAssetIds?: string[];
  flowId: string;
  flowVersion: number;
  settingsRevision: number;
  estimatedCredits: number | null;
  expiresAt: string;
  billingMode: 'fixed';
  steps: ToolFlowQuoteStep[];
  retryRunId?: string | null;
  retryNodeId?: string | null;
};
type RunSnapshot = {
  ratioContractVersion?: ImageRatioContractVersion;
  schema: 'toolflow.v1';
  flow_id: string;
  flow_owner_id: string;
  version: number;
  name: string;
  project_id: string | null;
  graph: ToolFlowGraph;
  input_asset_ids: string[];
  billing_mode?: 'fixed';
  billing_quote?: ToolFlowQuote;
  contract_version?: 'toolflow-pricing-v1';
  node_contracts?: Record<string, FrozenToolFlowNode>;
  node_attempts?: Record<string, FrozenToolFlowNode[]>;
};

type FrozenToolFlowNode = {
  config: TemplateConfig;
  billingContract: ImageBillingContract;
  imageChannel: ImageGenerationChannelSnapshot;
  settingsRevision: number;
  authorizedCount: number;
  maxReferences: number;
  quote: ToolFlowQuote;
};

type NodeResult = {
  outputPlans?: Array<{ ordinal: number; taskId: string; outputPlan: ImageOutputPlan; outputPlanHash: string }>;
  taskIds?: string[];
  expected?: number;
  succeededAssetIds?: string[];
  failedTaskIds?: string[];
  candidateAssetIds?: string[];
  inputAssetIds?: string[];
  retryCount?: number;
  error?: string | null;
};

type TemplateConfig = {
  outputIntent?: ToolFlowOutputIntent;
  outputPlan?: ImageOutputPlan;
  imageChannel?: ImageGenerationChannelSnapshot;
  prompt: string;
  context: string;
  model: string;
  quality: string;
  count: number;
  aspectRatio: string;
  outputSize: string | null;
  referenceIds: string[];
  moduleId: string | null;
  templateId: string | null;
  templateVersion: string | null;
  sourcePresetId: string | null;
};

async function assertToolFlowLegacyRoute(tx: Tx, config: TemplateConfig, configuredPrice: number | null | undefined, priced = false) {
  const model = config.model;
  if (!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])) {
    throw new AuthError(`工具流入口不支持图片型号 ${model}；请改用图片工作区选择可用型号。`, 409);
  }
  const mapped = await resolveImageGenerationRequestChannel(model as typeof IMAGE_STUDIO_MODELS[number], undefined, tx);
  if (!mapped) return;
  const legacy = model.startsWith('gemini-') ? 'banana' : 'shared';
  if (mapped === legacy && await hasLegacyImageGenerationModelOverride(model as typeof IMAGE_STUDIO_MODELS[number], legacy, tx)) {
    throw new AuthError('此型号使用独立 API 配置，工具流暂不能固定该配置执行；请使用正常生图入口，原工具流未派发。', 409);
  }
  const options = await getImageGenerationChannelOptions(tx);
  const option = options.items.find((item) => item.id === mapped);
  const managed = option ? null : (await getManagedImageGenerationChannels(tx)).find((item) => item.id === mapped);
  const supplier = option?.supplierName || option?.label || managed?.supplierName || managed?.label || mapped;
  if (mapped && mapped !== legacy) {
    throw new AuthError(`工具流入口暂不支持图片型号 ${model} 的默认供应商「${supplier}」；请恢复该型号的共享/Banana 兼容通道，或改用图片工作区。`, 409);
  }
  const capability = option?.models[model as typeof IMAGE_STUDIO_MODELS[number]];
  const fixedPoints = capability?.fixedPoints;
  const fixedPriceMatches = typeof configuredPrice === 'number' && Number.isFinite(configuredPrice)
    && (priced || typeof fixedPoints === 'number' && Number.isSafeInteger(fixedPoints)
      && creditsToCents(configuredPrice) === creditsToCents(fixedPoints));
  const parametersMatch = Boolean(capability?.qualities?.includes(config.quality)
    && capability.ratios?.includes(config.aspectRatio)
    && capability.maxReferences !== null && capability.maxReferences !== undefined
    && config.referenceIds.length <= capability.maxReferences);
  if (!option?.enabled || !option.configured || !capability?.ready || capability.billingMode !== 'fixed'
    || !fixedPriceMatches || !parametersMatch) {
    const reason = capability?.billingMode === 'actual'
      ? '当前供应商使用实际计费，不符合工具流固定点数合同'
      : !fixedPriceMatches ? '当前供应商固定点数与工具流报价不一致'
        : !parametersMatch ? '当前供应商未确认支持模板的图片参数'
          : capability?.disabledReason || '当前供应商未就绪';
    throw new AuthError(`工具流入口无法按原固定计费与图片参数合同使用型号 ${model} 的默认供应商「${supplier}」：${reason}。请修复兼容配置，或改用图片工作区。`, 409);
  }
}

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'uncertain', 'cancelled']);
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial_success', 'failed', 'cancelled']);
const PRIVATE_FLOW_STATES = new Set(['queued', 'pending', 'running', 'waiting_selection', 'waiting_confirmation', 'paused']);

function publicToolFlowState(status: string) {
  return status.startsWith('rate_') && PRIVATE_FLOW_STATES.has(status.slice(5)) ? status.slice(5) : status;
}

function toolFlowState(run: { id?: string; status?: string; contract_version?: string }, status: string) {
  const adopted = run.contract_version === 'toolflow-pricing-v1' || run.id?.startsWith('rate-tf-') || run.status?.startsWith('rate_');
  const publicStatus = publicToolFlowState(status);
  return adopted && PRIVATE_FLOW_STATES.has(publicStatus) ? `rate_${publicStatus}` : publicStatus;
}

function currentNodeContract(snapshot: RunSnapshot, nodeId: string) {
  const attempts = snapshot.node_attempts?.[nodeId];
  return attempts?.length ? attempts[attempts.length - 1] : snapshot.node_contracts?.[nodeId];
}

class FrozenToolFlowContractError extends AuthError {
  constructor(message = '原工具流缺少完整的受理合同，已保留现场；请核对原运行，不会自动补建或重新生成。') { super(message, 409); }
}

function toolFlowQuoteSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') throw new AuthError('工具流报价校验暂不可用', 503);
  return 'dev-secret-change-in-production';
}

function clean(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  return Number.isFinite(next) ? Math.min(max, Math.max(min, Math.floor(next))) : fallback;
}

function parseIds(value: unknown, limit = 30) {
  return Array.from(new Set(Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : [])).slice(0, limit);
}

function parseNodeResult(value: string | null | undefined): NodeResult {
  const parsed = parseJsonObject(value);
  let outputPlans: NodeResult['outputPlans'];
  if (Object.prototype.hasOwnProperty.call(parsed, 'outputPlans')) {
    // Keep absence distinct for old records. A present malformed field becomes
    // an empty allowlist, never a raw-public fallback or an invented plan.
    outputPlans = [];
    for (const value of Array.isArray(parsed.outputPlans) ? parsed.outputPlans : []) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (typeof item.ordinal !== 'number' || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1
        || typeof item.taskId !== 'string' || !item.taskId || item.taskId.length > 160
        || item.taskId.trim() !== item.taskId || /[\x00-\x1f\x7f]/.test(item.taskId)
        || typeof item.outputPlanHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.outputPlanHash)) continue;
      const outputPlan = parseImageOutputPlan(item.outputPlan);
      if (!outputPlan || imageOutputPlanHash(outputPlan) !== item.outputPlanHash) continue;
      outputPlans.push({ ordinal: item.ordinal, taskId: item.taskId, outputPlan, outputPlanHash: item.outputPlanHash });
    }
  }
  return {
    ...(outputPlans === undefined ? {} : { outputPlans }),
    taskIds: parseIds(parsed.taskIds),
    expected: Number.isInteger(Number(parsed.expected)) ? Number(parsed.expected) : undefined,
    succeededAssetIds: parseIds(parsed.succeededAssetIds),
    failedTaskIds: parseIds(parsed.failedTaskIds),
    candidateAssetIds: parseIds(parsed.candidateAssetIds),
    inputAssetIds: parseIds(parsed.inputAssetIds),
    retryCount: Number.isInteger(Number(parsed.retryCount)) ? Number(parsed.retryCount) : 0,
    error: typeof parsed.error === 'string' ? parsed.error : null,
  };
}

function stringify(value: unknown) {
  return JSON.stringify(value);
}

function quoteProofPayload(userId: string, value: unknown) {
  const quote = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const steps = Array.isArray(quote.steps) ? quote.steps.map((value) => {
    const step = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return ['nodeId', 'templateId', 'moduleId', 'templateVersion', 'model', 'count', 'unitCredits', 'estimatedCredits', 'status', 'pricingRevision', 'contractDigest',
      ...(quote.ratioContractVersion === 3 ? ['outputIntent', 'outputPlan', 'imageChannel'] : [])]
      .map((key) => step[key] ?? null);
  }) : [];
  return JSON.stringify([userId, quote.flowId ?? null, quote.flowVersion ?? null, quote.settingsRevision ?? null,
    quote.estimatedCredits ?? null, quote.expiresAt ?? null, quote.billingMode ?? null,
    quote.retryRunId ?? null, quote.retryNodeId ?? null, steps,
    ...(quote.ratioContractVersion === 3 ? [3, quote.inputAssetIds] : [])]);
}

export function parseToolFlowQuoteInputAssets(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30 || value.some(id => typeof id !== 'string'
    || !id || id.length > 100 || id.trim() !== id)) throw new AuthError('工具流输入图片清单无效，尚未报价或派发', 400);
  return parseIds(value);
}

/** null means a future generation/selection has not produced its actual input yet. */
export function toolFlowKnownQuoteInputs(graph: ToolFlowGraph, nodeId: string, inputAssetIds: string[]): string[] | null {
  const byId = nodeMap(graph);
  const visit = (id: string, seen: Set<string>): string[] | null => {
    if (seen.has(id)) throw new AuthError('工具流连接存在循环，尚未报价', 400);
    const node = byId.get(id);
    if (!node) throw new AuthError('工具流上游节点已失效，尚未报价', 400);
    if (node.type === 'flow-input') return inputAssetIds;
    if (['flow-template', 'flow-select', 'flow-confirm'].includes(node.type)) return null;
    const next = new Set(seen).add(id);
    const values = parents(graph, id).map(parent => visit(parent, next));
    return values.some(value => value === null) ? null : Array.from(new Set(values.flatMap(value => value || [])));
  };
  const values = parents(graph, nodeId).map(parent => visit(parent, new Set([nodeId])));
  return values.some(value => value === null) ? null : Array.from(new Set(values.flatMap(value => value || [])));
}

export function toolFlowQuoteCookieName(flowId: string, expiresAt: string) {
  const id = createHash('sha256').update(`${flowId}\0${expiresAt}`).digest('hex').slice(0, 24);
  return `toolflow_quote_${id}`;
}

export function createToolFlowQuoteProof(userId: string, quote: ToolFlowQuote) {
  return createHmac('sha256', toolFlowQuoteSecret()).update(quoteProofPayload(userId, quote)).digest('base64url');
}

export function assertToolFlowQuoteProof(userId: string, quote: unknown, proof: string | undefined) {
  if (!proof || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new AuthError('工具流报价凭据无效或已过期，请重新报价', 409);
  const expected = createHmac('sha256', toolFlowQuoteSecret()).update(quoteProofPayload(userId, quote)).digest();
  const received = Buffer.from(proof, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AuthError('工具流报价凭据无效或已过期，请重新报价', 409);
  }
}

// A new run may reuse only the channels authenticated by the existing quote
// proof. This private map is never accepted from a client or used for old runs.
function authenticatedToolFlowQuoteChannels(userId: string, value: unknown, proof: string | undefined,
  current: { flowId: string; flowVersion: number; settingsRevision: number; inputAssetIds: string[]; nodeIds: string[]; retryRunId?: string; retryNodeId?: string }) {
  assertToolFlowQuoteProof(userId, value, proof);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('工具流报价无效，请重新报价', 409);
  const quote = value as Partial<ToolFlowQuote>;
  const now = Date.now(), expiresAt = typeof quote.expiresAt === 'string' ? Date.parse(quote.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 60_000
    || quote.ratioContractVersion !== 3 || quote.billingMode !== 'fixed'
    || quote.flowId !== current.flowId || quote.flowVersion !== current.flowVersion
    || quote.settingsRevision !== current.settingsRevision
    || (quote.retryRunId ?? null) !== (current.retryRunId ?? null)
    || (quote.retryNodeId ?? null) !== (current.retryNodeId ?? null)
    || typeof quote.estimatedCredits !== 'number' || !Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0
    || JSON.stringify(quote.inputAssetIds) !== JSON.stringify(current.inputAssetIds)
    || !Array.isArray(quote.steps) || quote.steps.length !== current.nodeIds.length) {
    throw new AuthError('工具流报价已过期或设置已变化，请重新报价', 409);
  }
  const channels = new Map<string, ImageGenerationChannelSnapshot>();
  for (let index = 0; index < current.nodeIds.length; index++) {
    const step = quote.steps[index];
    const channel = step && safeImageChannelSnapshot(step.imageChannel);
    if (!step || typeof step !== 'object' || Array.isArray(step)
      || step.nodeId !== current.nodeIds[index] || channels.has(step.nodeId)
      || !step.outputIntent || typeof step.outputIntent !== 'object' || Array.isArray(step.outputIntent)
      || !channel || channel.channelId !== 'original' || !/^[0-9a-f-]{36}$/i.test(channel.configRevision)) {
      throw new AuthError('工具流图片规格报价节点不完整或已变化，请重新报价', 409);
    }
    channels.set(step.nodeId, channel);
  }
  return channels;
}

async function currentImageSettingsRevision(tx: Tx) {
  const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
  if (!row) return 0;
  try {
    const revision = Number((JSON.parse(row.value_json) as { revision?: unknown }).revision);
    if (Number.isInteger(revision) && revision >= 0) return revision;
  } catch { /* Invalid settings cannot validate a quote. */ }
  throw new AuthError('图片设置已变化，请重新获取报价', 409);
}

function nodeMap(graph: ToolFlowGraph) {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function parents(graph: ToolFlowGraph, nodeId: string) {
  return graph.connections.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
}

function childNodes(graph: ToolFlowGraph, nodeId: string) {
  return graph.connections.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
}

function resultAssets(nodeRun: { output_asset_ids: string; result_json: string | null }) {
  const result = parseNodeResult(nodeRun.result_json);
  return Array.from(new Set(parseIds(JSON.parse(nodeRun.output_asset_ids || '[]')).concat(result.succeededAssetIds || [])));
}

function safeJsonArray(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || '[]');
    return parseIds(parsed);
  } catch {
    return [];
  }
}

async function logRunAction(tx: Tx, userId: string, action: string, runId: string, detail: Record<string, unknown> = {}) {
  await tx.operationLog.create({
    data: {
      operator_id: userId,
      action,
      target_type: 'ToolFlowRun',
      target_id: runId,
      detail: stringify(detail),
    },
  });
}

async function notifyRunOwner(tx: Tx, run: { owner_id: string; flow_id: string; id: string }, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  await createInAppNotification(tx, {
    targetUserId: run.owner_id,
    type,
    title,
    body,
    metadata: { toolflow_run_id: run.id, toolflow_id: run.flow_id, ...metadata, feishu_delivery: 'existing_notification_boundary' },
  });
}

async function markFinalAssets(tx: Tx, ownerId: string, assetIds: string[], run: { flow_id: string; flow_version: number; id: string }, nodeId: string) {
  if (!assetIds.length) return;
  const assets = await tx.asset.findMany({ where: { id: { in: assetIds }, owner_id: ownerId, status: 'active', type: 'image' } });
  for (const asset of assets) {
    const metadata = parseJsonObject(asset.metadata_json);
    const currentToolflow = parseJsonObject(typeof metadata.toolflow === 'object' && metadata.toolflow ? JSON.stringify(metadata.toolflow) : null);
    await tx.asset.update({
      where: { id: asset.id },
      data: {
        metadata_json: stringify({
          ...metadata,
          toolflow: {
            ...currentToolflow,
            flowId: run.flow_id,
            version: run.flow_version,
            runId: run.id,
            nodeId: currentToolflow.nodeId || nodeId,
            finalOutput: true,
            outputNodeId: nodeId,
          },
        }),
      },
    });
  }
}

async function clonePresetAssets(tx: Tx, presetOwnerId: string, userId: string, ids: string[]) {
  if (!ids.length) return [];
  const sources = await tx.asset.findMany({
    where: { id: { in: ids }, owner_id: presetOwnerId, status: 'active', type: 'image' },
  });
  if (sources.length !== new Set(ids).size) throw new AuthError('模板引用的图片已不可用，请管理员重新保存模板', 409);
  const mapped = new Map<string, string>();
  for (const source of sources) {
    if (source.owner_id === userId) {
      mapped.set(source.id, source.id);
      continue;
    }
    const clone = await tx.asset.create({
      data: {
        owner_id: userId,
        type: source.type,
        original_url: source.original_url,
        thumbnail_url: source.thumbnail_url,
        file_name: source.file_name,
        mime_type: source.mime_type,
        width: source.width,
        height: source.height,
        file_size: source.file_size,
        hash: null,
        status: 'active',
        metadata_json: stringify({ toolflow_template_source: source.id }),
      },
    });
    mapped.set(source.id, clone.id);
  }
  return ids.map((id) => mapped.get(id)).filter((id): id is string => Boolean(id));
}

async function resolveTemplate(
  tx: Tx,
  ownerId: string,
  flowOwnerId: string,
  node: ToolFlowNode,
  inputAssetIds: string[],
  settings: Awaited<ReturnType<typeof getImageStudioSettings>>,
  identity: ImageStudioIdentity,
  options: { cloneReferenceAssets?: boolean; allowUnknownModel?: boolean; allowUnknownPrice?: boolean;
    ratioContractVersion?: ImageRatioContractVersion; deferAuto?: boolean; outputIntent?: ToolFlowOutputIntent;
    imageChannel?: ImageGenerationChannelSnapshot; forSubmission?: boolean } = {},
): Promise<TemplateConfig> {
  const data = node.data || {};
  const templateId = clean(data.template_id || data.templateId) || null;
  const moduleId = clean(data.module_id || data.moduleId) || null;
  if (!templateId && !moduleId && clean(data.source, 'system') !== 'system' && flowOwnerId !== ownerId) {
    throw new AuthError('共享工具流中的图片模板未绑定授权模板', 403);
  }

  const promptSupplement = clean(data.prompt);
  let prompt = '';
  let context = settings.context;
  let templateContext = '';
  let model: string = settings.model;
  let quality = defaultImageStudioQuality(model);
  let count = numberInRange(data.count, 1, 1, 8);
  let aspectRatio = clean(data.ratio || data.aspect_ratio, 'auto');
  let outputSize: string | null = clean(data.size || data.output_size) || null;
  let templateResolution = '1K';
  let templateReferenceIds: string[] = [];
  let sourcePresetId: string | null = null;
  const requestedTemplateVersion = data.template_version ?? data.templateVersion;
  let resolvedTemplateVersion: string | null = null;

  if (templateId) {
    const preset = await tx.imageStudioPreset.findUnique({ where: { id: templateId } });
    if (!preset || !canViewStudioPreset(identity, preset)) throw new AuthError('图片模板不存在或未授权', 403);
    sourcePresetId = preset.id;
    const presetIds = safeJsonArray(preset.reference_ids);
    resolvedTemplateVersion = preset.updated_at.toISOString();
    if (requestedTemplateVersion && String(requestedTemplateVersion) !== resolvedTemplateVersion) throw new AuthError('图片模板已更新，请刷新后重新确认节点配置', 409);
    templateReferenceIds = options.cloneReferenceAssets === false ? presetIds : await clonePresetAssets(tx, preset.owner_id, ownerId, presetIds);
    if (data.model && clean(data.model) !== preset.model) throw new AuthError('当前模板不允许切换到该图片模型', 400);
    prompt = [preset.prompt, promptSupplement].filter(Boolean).join('\n\n');
    templateContext = preset.context || '';
    model = preset.model || settings.model;
    templateResolution = (preset as { resolution?: string | null }).resolution || templateResolution;
    quality = normalizeImageStudioQuality(model, data.quality || preset.quality);
    count = numberInRange(data.count, numberInRange(preset.count, 1, 1, 8), 1, 8);
    aspectRatio = clean(data.ratio || data.aspect_ratio, preset.aspect_ratio || 'auto');
    outputSize = clean(data.size || data.output_size) || studioRatioSize(aspectRatio) || null;
  } else if (moduleId) {
    const studioModule = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId } });
    if (!studioModule) throw new AuthError('图片模块不存在或未授权', 403);
    if (studioModule.source_preset_id) {
      sourcePresetId = studioModule.source_preset_id;
      const source = await tx.imageStudioPreset.findUnique({ where: { id: studioModule.source_preset_id }, select: { owner_id: true, scope: true, is_shared: true } });
      if (!source || !canViewStudioPreset(identity, source)) throw new AuthError('该模板已停止共享，不能新建任务', 403);
    }
    resolvedTemplateVersion = String(studioModule.revision);
    if (requestedTemplateVersion && String(requestedTemplateVersion) !== resolvedTemplateVersion) throw new AuthError('图片模块已更新，请刷新后重新确认节点配置', 409);
    const moduleReferenceIds = safeJsonArray(studioModule.reference_ids);
    templateReferenceIds = options.cloneReferenceAssets === false ? moduleReferenceIds : await clonePresetAssets(tx, ownerId, ownerId, moduleReferenceIds);
    if (data.model && clean(data.model) !== studioModule.model) throw new AuthError('当前模板不允许切换到该图片模型', 400);
    prompt = [studioModule.prompt, promptSupplement].filter(Boolean).join('\n\n');
    templateContext = studioModule.context || '';
    model = studioModule.model || settings.model;
    templateResolution = studioModule.resolution || templateResolution;
    quality = normalizeImageStudioQuality(model, data.quality || studioModule.quality);
    count = numberInRange(data.count, numberInRange(studioModule.count, 1, 1, 8), 1, 8);
    aspectRatio = clean(data.ratio || data.aspect_ratio, studioModule.aspect_ratio || 'auto');
    outputSize = clean(data.size || data.output_size) || studioRatioSize(aspectRatio) || null;
  } else {
    prompt = promptSupplement;
    model = clean(data.model, settings.model);
    quality = normalizeImageStudioQuality(model, data.quality || defaultImageStudioQuality(model));
    count = numberInRange(data.count, 1, 1, 8);
    aspectRatio = clean(data.ratio || data.aspect_ratio, 'auto');
    outputSize = clean(data.size || data.output_size) || null;
  }

  const nodeContext = clean(data.context || data.module_context || data.moduleContext);
  context = [settings.context, templateContext, nodeContext].map((value) => clean(value)).filter(Boolean).join('\n\n---\n');

  if (!options.allowUnknownModel && !IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])) throw new AuthError('当前图片模型未配置或不可用', 409);
  // A saved image module may intentionally keep the user-facing prompt empty
  // and store the reusable instruction in its context. The image worker uses
  // that context as the provider prompt when no extra scene description is
  // supplied, so do not reject a selected module solely for an empty prompt.
  if (!prompt && !context.trim()) throw new AuthError('图片模板没有有效提示词', 400);
  if (options.allowUnknownPrice !== true && !settings.prices[model as keyof typeof settings.prices] && settings.prices[model as keyof typeof settings.prices] !== 0) {
    throw new AuthError('当前图片模型尚未配置工具流生成积分', 409);
  }
  try { aspectRatio = normalizeStudioRatio(aspectRatio); }
  catch (error) { if (options.ratioContractVersion === 3) throw error; aspectRatio = 'auto'; }
  const allReferenceIds = Array.from(new Set(templateReferenceIds.concat(inputAssetIds)));
  if (options.ratioContractVersion === 3 && allReferenceIds.length > 9) {
    throw new AuthError('当前工具流最多使用9张参考图；输入未被删减，尚未派发生成', 409);
  }
  const referenceIds = allReferenceIds.slice(0, 9);
  let outputIntent: ToolFlowOutputIntent | undefined, outputPlan: ImageOutputPlan | undefined;
  let imageChannel: ImageGenerationChannelSnapshot | undefined;
  if (options.ratioContractVersion === 3 && IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])) {
    const rawSize = clean(data.size || data.output_size);
    const explicitSize = isValidImageDimension(rawSize, true) ? rawSize : undefined;
    if (rawSize && !explicitSize && !IMAGE_RESOLUTION_OPTIONS.includes(rawSize as typeof IMAGE_RESOLUTION_OPTIONS[number]) && rawSize !== 'auto') {
      throw new AuthError('工具流指定尺寸无效，未替换尺寸或派发生成', 409);
    }
    const resolution = normalizeImageResolution(model, clean(data.resolution)
      || (IMAGE_RESOLUTION_OPTIONS.includes(rawSize as typeof IMAGE_RESOLUTION_OPTIONS[number]) ? rawSize : templateResolution));
    outputIntent = { resolution, requestedRatio: aspectRatio, ...(explicitSize ? { explicitSize } : {}) };
    if (options.outputIntent && JSON.stringify(outputIntent) !== JSON.stringify(options.outputIntent)) {
      throw new AuthError('工具流图片规格已变化，请重新报价；原运行记录保持', 409);
    }
    imageChannel = options.imageChannel || await captureImageGenerationChannel(model, 'original', tx);
    const api = await resolveImageGenerationChannelSnapshot(imageChannel, tx, options.forSubmission === true, model);
    if (!(aspectRatio === 'auto' && options.deferAuto && !explicitSize)) {
      const firstInput = inputAssetIds[0] ? await tx.asset.findFirst({ where: { id: inputAssetIds[0], owner_id: ownerId, status: 'active', type: 'image' },
        select: { width: true, height: true } }) : null;
      if (aspectRatio === 'auto' && !explicitSize && (!inputAssetIds.length || !firstInput?.width || !firstInput?.height)) {
        throw new AuthError('工具流主图尺寸尚未确定，请选择可用输入后重新报价；未改为1:1', 409);
      }
      const resolved = aspectRatio === 'auto' && explicitSize
        ? { requested: 'auto', resolved: normalizeStudioRatio(explicitSize.replace('x', ':')), source: 'explicit' as const }
        : resolveStudioAspectRatio(aspectRatio, firstInput, true, true);
      outputPlan = imageGenerationModelOutputPlan(api, model, resolution, resolved.resolved,
        { requestedRatio: resolved.requested, aspectRatioSource: resolved.source, explicitSize });
    }
    outputSize = outputPlan?.outputSize || null;
  }
  return {
    prompt: prompt.slice(0, 20000),
    context: context.slice(0, 20000),
    model,
    quality,
    count,
    aspectRatio,
    outputSize: options.ratioContractVersion === 3 ? outputSize : outputSize || studioRatioSize(aspectRatio) || null,
    ...(outputIntent ? { outputIntent, outputPlan, imageChannel } : {}),
    referenceIds,
    moduleId,
    templateId,
    templateVersion: resolvedTemplateVersion,
    sourcePresetId,
  };
}

async function resolveFrozenToolFlowOutput(tx: Tx, ownerId: string, config: TemplateConfig,
  imageChannel: ImageGenerationChannelSnapshot, inputAssetIds: string[], forSubmission = false): Promise<TemplateConfig> {
  const intent = config.outputIntent;
  if (!intent) throw new FrozenToolFlowContractError('原节点缺少图片规格意图，已保留现场，未派发任务。');
  const api = await resolveImageGenerationChannelSnapshot(imageChannel, tx, forSubmission, config.model);
  const firstInput = inputAssetIds[0] ? await tx.asset.findFirst({ where: { id: inputAssetIds[0], owner_id: ownerId, status: 'active', type: 'image' },
    select: { width: true, height: true } }) : null;
  if (intent.requestedRatio === 'auto' && !intent.explicitSize && (!inputAssetIds.length || !firstInput?.width || !firstInput?.height)) {
    throw new FrozenToolFlowContractError('工具流实际主图尺寸尚未确定，已保留输入，未改为1:1或派发任务。');
  }
  const resolved = intent.requestedRatio === 'auto' && intent.explicitSize
    ? { requested: 'auto', resolved: normalizeStudioRatio(intent.explicitSize.replace('x', ':')), source: 'explicit' as const }
    : resolveStudioAspectRatio(intent.requestedRatio, firstInput, true, true);
  const outputPlan = imageGenerationModelOutputPlan(api, config.model, intent.resolution, resolved.resolved,
    { requestedRatio: resolved.requested, aspectRatioSource: resolved.source, explicitSize: intent.explicitSize });
  return { ...config, imageChannel, outputPlan, outputSize: outputPlan.outputSize };
}

type ToolFlowRetryQuote = { runId: string; nodeId: string; config: TemplateConfig; remaining: number;
  inputAssetIds: string[]; ratioContractVersion: ImageRatioContractVersion };

async function buildToolFlowQuote(
  tx: Tx,
  user: SessionUser,
  flow: { id: string; owner_id: string; version: number; graph_json: string },
  settings: Awaited<ReturnType<typeof getImageStudioSettings>>,
  now = Date.now(),
  retry?: ToolFlowRetryQuote,
  options: { inputAssetIds?: string[]; authenticatedChannels?: ReadonlyMap<string, ImageGenerationChannelSnapshot> } = {},
) {
  const graph = validateToolFlowGraph(JSON.parse(flow.graph_json));
  const ratioContractVersion = retry?.ratioContractVersion ?? 3;
  const inputNode = graph.nodes.find(node => node.type === 'flow-input');
  const inputAssetIds = parseToolFlowQuoteInputAssets(retry?.inputAssetIds ?? options.inputAssetIds
    ?? inputNode?.data.assetIds ?? inputNode?.data.asset_ids ?? []);
  const assets = await tx.asset.count({ where: { id: { in: inputAssetIds }, owner_id: user.id, status: 'active', type: 'image' } });
  if (assets !== inputAssetIds.length) throw new AuthError('工具流输入图片不存在或无权使用，尚未报价', 403);
  const steps: ToolFlowQuoteStep[] = [];
  const prepared = new Map<string, { config: TemplateConfig; pricing: Awaited<ReturnType<typeof withImagePricing>>; scope: string;
    knownInputs: string[] | null }>();
  let totalCents = 0;
  let hasUnknown = false;
  for (const node of graph.nodes) {
    if (node.type !== 'flow-template') continue;
    if (retry && node.id !== retry.nodeId) continue;
    const knownInputs = retry ? retry.inputAssetIds : toolFlowKnownQuoteInputs(graph, node.id, inputAssetIds);
    const authenticatedChannel = options.authenticatedChannels?.get(node.id);
    if (options.authenticatedChannels && !authenticatedChannel) throw new AuthError('工具流报价缺少原节点的图片通道，请重新报价', 409);
    let config: TemplateConfig;
    if (retry) {
      config = { ...retry.config };
      if (ratioContractVersion === 3) {
        const referenceIds = Array.from(new Set(config.referenceIds.concat(knownInputs || [])));
        if (referenceIds.length > 9) throw new FrozenToolFlowContractError('重试参考图超出原上限，已保留输入，未删减或派发任务。');
        config = { ...config, referenceIds };
        const channel = authenticatedChannel || await captureImageGenerationChannel(config.model, 'original', tx);
        config = await resolveFrozenToolFlowOutput(tx, user.id, config, channel, knownInputs || [], Boolean(authenticatedChannel));
      }
    } else {
      config = await resolveTemplate(tx, flow.owner_id, flow.owner_id, node, knownInputs || [], settings,
        user as unknown as ImageStudioIdentity, { cloneReferenceAssets: false, allowUnknownModel: true, allowUnknownPrice: true,
          ratioContractVersion, deferAuto: knownInputs === null,
          ...(authenticatedChannel ? { imageChannel: authenticatedChannel, forSubmission: true } : {}) });
    }
    const api = ratioContractVersion === 3 && config.imageChannel
      ? await resolveImageGenerationChannelSnapshot(config.imageChannel, tx, Boolean(authenticatedChannel), config.model)
      : await getImageGenerationSettingsForModel(config.model, tx);
    let pricing: Awaited<ReturnType<typeof withImagePricing>>;
    try { pricing = await withImagePricing(api, config.model, tx); }
    catch (error) { throw new AuthError(error instanceof Error ? error.message : '收费规则暂不可用，请重新报价', 409); }
    if (pricing.quote?.charge.identity.billingMode === 'actual'
      || pricing.settings.modelCapabilities[config.model as keyof typeof pricing.settings.modelCapabilities]?.billingMode === 'actual') {
      throw new AuthError('工具流仅支持原固定计费合同，当前实际费用模式不能在此提交。', 409);
    }
    const rawPrice = pricing.quote ? pricing.quote.credits : settings.prices[config.model as keyof typeof settings.prices];
    await assertToolFlowLegacyRoute(tx, config, rawPrice, Boolean(pricing.quote));
    const count = retry ? retry.remaining : config.count;
    const scope = imageBillingScope(api);
    const contractDigest = createHash('sha256').update(stringify({ config, scope, api, count })).digest('hex');
    let unitCredits: number | null = null;
    let estimatedCredits: number | null = null;
    let status: ToolFlowQuoteStep['status'] = 'unknown';
    try {
      if (!IMAGE_STUDIO_MODELS.includes(config.model as typeof IMAGE_STUDIO_MODELS[number])
        || typeof rawPrice !== 'number' || !Number.isFinite(rawPrice)) throw new Error('unknown price');
      const unitCents = creditsToCents(rawPrice);
      const stepCents = unitCents * count;
      if (!Number.isSafeInteger(stepCents)) throw new Error('unsafe price');
      unitCredits = creditsFromCents(unitCents);
      estimatedCredits = creditsFromCents(stepCents);
      totalCents += stepCents;
      if (!Number.isSafeInteger(totalCents)) throw new Error('unsafe total');
      status = 'fixed';
    } catch {
      hasUnknown = true;
    }
    steps.push({ nodeId: node.id, templateId: config.templateId, moduleId: config.moduleId,
      templateVersion: config.templateVersion, model: config.model, count,
      unitCredits, estimatedCredits, status, pricingRevision: pricing.quote?.charge.revision || null, contractDigest,
      ...(ratioContractVersion === 3 ? { outputIntent: config.outputIntent, outputPlan: publicImageOutputPlan(config.outputPlan),
        imageChannel: config.imageChannel } : {}) });
    prepared.set(node.id, { config, pricing, scope, knownInputs });
  }
  const quote: ToolFlowQuote = {
    ...(ratioContractVersion === 3 ? { ratioContractVersion, inputAssetIds } : {}),
    flowId: flow.id,
    flowVersion: flow.version,
    settingsRevision: settings.revision,
    estimatedCredits: hasUnknown ? null : creditsFromCents(totalCents),
    expiresAt: new Date(now + 60_000).toISOString(),
    billingMode: 'fixed',
    steps,
    ...(retry ? { retryRunId: retry.runId, retryNodeId: retry.nodeId } : {}),
  };
  return { quote, prepared };
}

export function validateSubmittedToolFlowQuote(value: unknown, current: ToolFlowQuote): ToolFlowQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('请先获取有效的工具流固定点数报价', 409);
  const submitted = value as Partial<ToolFlowQuote>;
  const expiresAt = typeof submitted.expiresAt === 'string' ? Date.parse(submitted.expiresAt) : NaN;
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 60_000
    || submitted.billingMode !== 'fixed' || current.estimatedCredits === null
    || submitted.flowId !== current.flowId || submitted.flowVersion !== current.flowVersion
    || submitted.settingsRevision !== current.settingsRevision
    || (submitted.retryRunId ?? null) !== (current.retryRunId ?? null)
    || (submitted.retryNodeId ?? null) !== (current.retryNodeId ?? null)
    || submitted.estimatedCredits !== current.estimatedCredits || !Array.isArray(submitted.steps)
    || submitted.steps.length !== current.steps.length
    || savedImageRatioContractVersion(submitted) !== savedImageRatioContractVersion(current)
    || current.ratioContractVersion === 3 && stringify(submitted.inputAssetIds) !== stringify(current.inputAssetIds)) {
    throw new AuthError('工具流报价已过期或设置已变化，请重新报价', 409);
  }
  const fields: Array<keyof ToolFlowQuoteStep> = ['nodeId', 'templateId', 'moduleId', 'templateVersion', 'model', 'count', 'unitCredits', 'estimatedCredits', 'status', 'pricingRevision', 'contractDigest'];
  for (let index = 0; index < current.steps.length; index += 1) {
    const received = submitted.steps[index] as Partial<ToolFlowQuoteStep> | null;
    const expected = current.steps[index];
    if (!received || typeof received !== 'object' || fields.some((field) => received[field] !== expected[field])) {
      throw new AuthError('工具流模板或报价已变化，请重新报价', 409);
    }
    if (current.ratioContractVersion === 3 && ['outputIntent', 'outputPlan', 'imageChannel'].some(field =>
      stringify(received[field as keyof ToolFlowQuoteStep]) !== stringify(expected[field as keyof ToolFlowQuoteStep]))) {
      throw new AuthError('工具流图片规格已更新，请重新获取实际尺寸与报价；输入保留，尚未派发', 409);
    }
  }
  return { ...current, expiresAt: submitted.expiresAt! };
}

export async function getToolFlowQuote(user: SessionUser, flowId: string,
  options: { retry?: { runId: string; nodeId: string }; inputAssetIds?: string[] } = {}) {
  if (!canUseCompanyTemplates(user)) throw new AuthError('仅限公司飞书账号使用工具流', 403);
  const flow = await assertCanUseToolFlow(user, flowId);
  const settings = await getImageStudioSettings();
  return prisma.$transaction(async (tx) => {
    const currentFlow = await tx.toolFlow.findUnique({ where: { id: flow.id } });
    if (!currentFlow || currentFlow.owner_id !== user.id || currentFlow.status === 'deleted') throw new AuthError('工具流不存在', 404);
    if (currentFlow.version !== flow.version || await currentImageSettingsRevision(tx) !== settings.revision) {
      throw new AuthError('工具流或图片设置已变化，请重新获取报价', 409);
    }
    if (options.retry) {
      const context = await retryQuoteContext(tx, user, options.retry.runId, options.retry.nodeId);
      if (context.run.flow_id !== flowId) throw new AuthError('重试报价与原工具流不一致', 409);
      return (await buildToolFlowQuote(tx, user, { ...currentFlow, version: context.run.flow_version,
        graph_json: stringify(context.snapshot.graph) }, settings, Date.now(), context.retry)).quote;
    }
    return (await buildToolFlowQuote(tx, user, currentFlow, settings, Date.now(), undefined,
      { inputAssetIds: options.inputAssetIds })).quote;
  });
}

async function assertFrozenTemplateAccess(tx: Tx, ownerId: string, config: TemplateConfig, identity: ImageStudioIdentity) {
  if (config.moduleId && !await tx.imageStudioModule.findFirst({ where: { id: config.moduleId, owner_id: ownerId } })) {
    throw new FrozenToolFlowContractError('原图片模块不存在或已无权使用，原工具流已保留。');
  }
  if (config.sourcePresetId) {
    const source = await tx.imageStudioPreset.findUnique({ where: { id: config.sourcePresetId } });
    if (!source || !canViewStudioPreset(identity, source)) throw new FrozenToolFlowContractError('原模板已停止共享或无权使用，原工具流已保留。');
  }
}

async function freezeToolFlowNodes(tx: Tx, user: SessionUser, graph: ToolFlowGraph,
  built: Awaited<ReturnType<typeof buildToolFlowQuote>>, acceptedQuote: ToolFlowQuote,
  settings: Awaited<ReturnType<typeof getImageStudioSettings>>, retry = false) {
  const contracts: Record<string, FrozenToolFlowNode> = {};
  const ratioContractVersion = savedImageRatioContractVersion(acceptedQuote);
  for (const step of acceptedQuote.steps) {
    const prepared = built.prepared.get(step.nodeId);
    const node = graph.nodes.find(item => item.id === step.nodeId);
    if (!prepared || !node || step.unitCredits === null || step.status !== 'fixed') throw new AuthError('节点报价不完整，未受理工具流', 409);
    const charge = prepared.pricing.quote?.charge;
    if (charge) {
      try { await assertNewPricingCharge(charge, step.pricingRevision, tx); }
      catch (error) { throw new AuthError(error instanceof Error ? error.message : '收费规则已变化，请重新报价', 409); }
    }
    // Reuse the authenticated quote channel and its concrete inputs. Only template
    // references are cloned through the existing source-owner authorization.
    const config = retry ? prepared.config : await resolveTemplate(tx, user.id, user.id, node,
      prepared.knownInputs || [], settings, user as unknown as ImageStudioIdentity,
      { allowUnknownPrice: true, ratioContractVersion, deferAuto: prepared.knownInputs === null,
        ...(ratioContractVersion === 3 ? { imageChannel: prepared.config.imageChannel, forSubmission: true,
          outputIntent: prepared.config.outputIntent } : {}) });
    await assertFrozenTemplateAccess(tx, user.id, config, user as unknown as ImageStudioIdentity);
    const imageChannel = ratioContractVersion === 3 ? prepared.config.imageChannel
      : await captureImageGenerationChannel(config.model, 'original', tx);
    if (!imageChannel) throw new AuthError('图片规格报价缺少原通道，尚未受理工具流', 409);
    const api = await resolveImageGenerationChannelSnapshot(imageChannel, tx, true, config.model);
    if (imageBillingScope(api) !== prepared.scope) throw new AuthError('图片调用配置已变化，请重新报价', 409);
    if (ratioContractVersion === 3 && (stringify(publicImageOutputPlan(config.outputPlan)) !== stringify(step.outputPlan)
      || stringify(config.outputIntent) !== stringify(step.outputIntent)
      || stringify(imageChannel) !== stringify(step.imageChannel))) {
      throw new AuthError('图片规格或通道已变化，请重新报价；尚未受理工具流', 409);
    }
    const outputPlanHash = config.outputPlan ? imageOutputPlanHash(config.outputPlan) : undefined;
    let billingContract = fixedImageBillingContract({ scope: prepared.scope, model: config.model, credits: step.unitCredits,
      specification: imageSpecification({ model: config.model, quality: config.quality, outputSize: config.outputSize,
        aspectRatio: config.outputPlan?.resolvedRatio || config.aspectRatio, ...(outputPlanHash ? { outputPlanHash } : {}),
        referenceCount: config.referenceIds.length,
        inputCharacters: config.context.length + config.prompt.length, inputDigest: step.contractDigest }) });
    if (charge) billingContract = withPricingImageContract(billingContract, charge, step.unitCredits);
    contracts[step.nodeId] = { config, billingContract, imageChannel, settingsRevision: settings.revision,
      authorizedCount: step.count, maxReferences: api.modelCapabilities[config.model as keyof typeof api.modelCapabilities]?.maxReferences ?? 9,
      quote: acceptedQuote };
  }
  return contracts;
}

async function retryQuoteContext(tx: Tx, user: SessionUser, runId: string, nodeId: string) {
  const run = await tx.toolFlowRun.findUnique({ where: { id: runId }, include: { node_runs: true } });
  if (!run || run.owner_id !== user.id) throw new AuthError('工具流运行不存在', 404);
  const snapshot = parseJsonObject(run.snapshot_json) as unknown as RunSnapshot;
  const contract = currentNodeContract(snapshot, nodeId);
  const node = run.node_runs.find(item => item.node_id === nodeId);
  if (!contract || !node || !['failed', 'succeeded'].includes(node.status)) throw new AuthError('该节点当前不能重新报价重试；原运行已保留。', 409);
  const tasks = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: run.id, tool_flow_node_id: nodeId }, select: { status: true } });
  if (tasks.some(task => !['succeeded', 'failed', 'cancelled'].includes(publicPricingTaskState(task.status)))) {
    throw new AuthError('原节点仍有执行或结果待确认的请求，请继续核对原请求，不能重新生成。', 409);
  }
  await assertFrozenTemplateAccess(tx, user.id, contract.config, user as unknown as ImageStudioIdentity);
  const successes = parseNodeResult(node.result_json).succeededAssetIds || [];
  const remaining = Math.max(0, contract.config.count - successes.length);
  if (!remaining) throw new AuthError('该节点已有全部结果，没有需要重试的图片', 409);
  return { run, snapshot, node, retry: { runId, nodeId, config: contract.config, remaining,
    inputAssetIds: safeJsonArray(node.input_asset_ids), ratioContractVersion: savedImageRatioContractVersion(snapshot) } };
}

async function reopenUnstartedDescendants(tx: Tx, run: RunSnapshot, runId: string, nodeId: string) {
  const pending = childNodes(run.graph, nodeId);
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = await tx.toolFlowNodeRun.findUnique({ where: { run_id_node_id: { run_id: runId, node_id: id } } });
    if (!node || ['cancelled', 'running', 'waiting_selection', 'waiting_confirmation'].includes(publicToolFlowState(node.status))
      || resultAssets(node).length || safeJsonArray(node.selected_asset_ids).length
      || await tx.imageStudioTask.count({ where: { tool_flow_run_id: runId, tool_flow_node_id: id } })) continue;
    await tx.toolFlowNodeRun.update({ where: { id: node.id }, data: {
      status: toolFlowState(run, 'pending'), error: null, finished_at: null,
    } });
    pending.push(...childNodes(run.graph, id));
  }
}

async function createQueuedTask(tx: Tx, ownerId: string, creditUser: CreditPolicyUser, runId: string, run: RunSnapshot, node: ToolFlowNode, config: TemplateConfig, itemIndex: number) {
  const accepted = currentNodeContract(run, node.id);
  const parentContract = parseImageBillingContract(accepted ? stringify(accepted.billingContract) : null);
  if (!accepted || !parentContract || parentContract.mode !== 'fixed' || parentContract.model !== config.model) throw new FrozenToolFlowContractError();
  const ratioContractVersion = savedImageRatioContractVersion(run);
  if (ratioContractVersion === 3 && (!config.outputPlan || !config.outputIntent)) throw new FrozenToolFlowContractError('工具流实际图片规格尚未确定，未创建图片任务。');
  const outputPlanHash = config.outputPlan ? imageOutputPlanHash(config.outputPlan) : undefined;
  const id = `${parentContract.pricing ? 'rate-' : ''}tf-${run.flow_id.slice(0, 12)}-${run.version}-${randomUUID()}`;
  const unitCredits = parentContract.pricing ? frozenPricingCredits(parentContract.pricing).credits : parentContract.authorizedCredits;
  if (creditsToCents(unitCredits) !== creditsToCents(parentContract.authorizedCredits)) throw new FrozenToolFlowContractError();
  // Only the concrete downstream inputs are filled in here. Price and API
  // identity were accepted by the parent; never resolve today's price again.
  const billingScope = parentContract.scope;
  const billingContract: ImageBillingContract = { ...parentContract,
    specification: imageSpecification({ model: config.model, quality: config.quality, outputSize: config.outputSize,
      aspectRatio: config.outputPlan?.resolvedRatio || config.aspectRatio, ...(outputPlanHash ? { outputPlanHash } : {}), referenceCount: config.referenceIds.length,
      inputCharacters: config.context.length + config.prompt.length,
      inputDigest: createHash('sha256').update(stringify({ flowId: run.flow_id, flowVersion: run.version,
        settingsRevision: accepted.settingsRevision, nodeId: node.id,
        parentSpecification: parentContract.specification,
        prompt: config.prompt, context: config.context, referenceIds: config.referenceIds })).digest('hex') }) };
  const referenceImages = ratioContractVersion === 3 ? await tx.asset.findMany({ where: {
    id: { in: config.referenceIds }, owner_id: ownerId, status: 'active', type: 'image' },
    select: { id: true, owner_id: true, hash: true, width: true, height: true, file_size: true, mime_type: true } }) : [];
  const referenceById = new Map(referenceImages.map(reference => [reference.id, reference]));
  if (ratioContractVersion === 3 && referenceById.size !== config.referenceIds.length) throw new FrozenToolFlowContractError('工具流原件已不可用，未创建图片任务。');
  const taskState = { id, billing_contract_json: stringify(billingContract) };
  const freeze = unitCredits > 0
    ? await allocateTaskCredits(tx, creditUser, unitCredits, id)
    : null;
  await tx.imageStudioTask.create({
    data: {
      id,
      batch_id: `${parentContract.pricing ? 'toolflow_pricing_v1' : 'toolflow'}:${run.flow_id}:${run.version}:${node.id}`,
      owner_id: ownerId,
      module_id: config.moduleId,
      source_preset_id: config.sourcePresetId,
      ordinal: itemIndex + 1,
      fingerprint: createHash('sha256').update(stringify({ run: run.flow_id, version: run.version, node: node.id, index: itemIndex, prompt: config.prompt, references: config.referenceIds })).digest('hex'),
      prompt: config.prompt,
      context: config.context,
      revision: accepted.settingsRevision,
      model: config.model,
      quality: config.quality,
      billing_mode: 'fixed',
      status: studioTaskState(taskState, 'queued'),
      billing_status: studioBillingState(taskState, 'awaiting_response'),
      billing_scope: billingScope,
      billing_contract_json: stringify(billingContract),
      snapshot_json: stringify({
        schema: 'toolflow.image-task.v1',
        flowId: run.flow_id,
        flowVersion: run.version,
        runId,
        nodeId: node.id,
        templateId: config.templateId,
        sourcePresetId: config.sourcePresetId,
        prompt: config.prompt,
        context: config.context,
        model: config.model,
        quality: config.quality,
        billingMode: 'fixed',
        billingContract,
        imageChannel: accepted.imageChannel,
        quotedSettingsRevision: accepted.settingsRevision,
        aspectRatio: config.aspectRatio,
        outputSize: config.outputSize,
        ...(ratioContractVersion === 3 ? { ratioContractVersion, outputPlan: config.outputPlan, outputPlanHash,
          resolution: config.outputIntent!.resolution, resolvedAspectRatio: config.outputPlan!.resolvedRatio,
          aspectRatioSource: config.outputPlan!.aspectRatioSource,
          referenceImages: config.referenceIds.map(id => { const reference = referenceById.get(id)!; return { id, hash: reference.hash,
            width: reference.width, height: reference.height, fileSize: reference.file_size, mimeType: reference.mime_type }; }),
          authorizedReferenceOwners: Object.fromEntries(referenceImages.map(reference => [reference.id, reference.owner_id])) } : {}),
        referenceIds: config.referenceIds,
      }),
      aspect_ratio: config.aspectRatio,
      output_size: config.outputSize,
      reference_ids: stringify(config.referenceIds),
      unit_credits: unitCredits,
      freeze_snapshot: freeze?.snapshot,
      tool_flow_run_id: runId,
      tool_flow_node_id: node.id,
      tool_flow_version: run.version,
      tool_flow_item_index: itemIndex,
    },
  });
  if (freeze) {
    await tx.creditLedger.create({ data: {
      user_id: ownerId,
      type: 'task_freeze',
      amount: -unitCredits,
      balance_before: freeze.balance_before,
      balance_after: freeze.balance_after,
      frozen_before: freeze.frozen_before,
      frozen_after: freeze.frozen_after,
      related_task_id: id,
      idempotency_key: `image-studio:freeze:${id}`,
      reason: '工具流图片节点冻结积分',
      metadata_json: JSON.stringify({ allocations: freeze.allocations }),
    } });
  }
  return { id, unitCredits, outputPlan: config.outputPlan, outputPlanHash };
}

async function scheduleTemplateNode(
  tx: Tx,
  run: RunSnapshot,
  runRow: { owner_id: string; flow_id: string; id: string; flow_version: number; status?: string },
  creditUser: CreditPolicyUser,
  node: ToolFlowNode,
  nodeRun: { id: string; result_json: string | null },
  inputAssetIds: string[],
) {
  const previous = parseNodeResult(nodeRun.result_json);
  const existingSuccesses = previous.succeededAssetIds || [];
  const quoteStep = run.billing_mode === 'fixed'
    ? run.billing_quote?.steps.find((step) => step.nodeId === node.id)
    : undefined;
  if (run.billing_mode === 'fixed' && (!quoteStep || quoteStep.status !== 'fixed' || quoteStep.unitCredits === null)) {
    throw new FrozenToolFlowContractError('工具流固定报价缺少有效节点价格，原运行已保留，未派发任务。');
  }
  const accepted = currentNodeContract(run, node.id);
  if (!accepted || !parseImageBillingContract(stringify(accepted.billingContract))) throw new FrozenToolFlowContractError();
  await assertFrozenTemplateAccess(tx, runRow.owner_id, accepted.config, creditUser as unknown as ImageStudioIdentity);
  const ratioContractVersion = savedImageRatioContractVersion(run);
  if (ratioContractVersion === 3 && await tx.imageStudioTask.findFirst({ where: {
    owner_id: runRow.owner_id, tool_flow_run_id: runRow.id, tool_flow_node_id: node.id,
    status: { in: studioTaskStates(['queued', 'running', 'channel_queued', 'channel_running', 'uncertain']) },
  }, select: { id: true } })) {
    await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
      status: toolFlowState(run, 'running'), error: '原图片请求仍在途或结果待核对；没有重新生成' } });
    return { frozenCredits: 0, waiting: true };
  }
  const allReferenceIds = Array.from(new Set(accepted.config.referenceIds.concat(inputAssetIds)));
  if (ratioContractVersion === 3 && allReferenceIds.length > 9) throw new FrozenToolFlowContractError('参考图超出原上限，已保留输入，未删减或派发任务。');
  let config = { ...accepted.config, referenceIds: allReferenceIds.slice(0, 9) };
  if (ratioContractVersion === 3) {
    config = await resolveFrozenToolFlowOutput(tx, runRow.owner_id, config, accepted.imageChannel, inputAssetIds);
    if (accepted.config.outputPlan && stringify(publicImageOutputPlan(config.outputPlan)) !== stringify(publicImageOutputPlan(accepted.config.outputPlan))) {
      throw new FrozenToolFlowContractError('实际主图规格与已确认报价不符，原运行已保留，未派发任务。');
    }
  }
  if (config.referenceIds.length > accepted.maxReferences) throw new FrozenToolFlowContractError('原节点的参考图片超出受理时的上限，已保留输入，未向供应商提交。');
  const usableAssets = await tx.asset.count({ where: { id: { in: config.referenceIds }, owner_id: runRow.owner_id, type: 'image', status: 'active' } });
  if (usableAssets !== config.referenceIds.length) throw new FrozenToolFlowContractError('原节点参考图已不可用或无权使用，已保留工具流现场。');
  const expected = Math.max(existingSuccesses.length, config.count);
  const remaining = Math.max(0, expected - existingSuccesses.length);
  if (remaining > accepted.authorizedCount) throw new FrozenToolFlowContractError();
  if (accepted.billingContract.pricing) {
    try {
      const frozenApi = await resolveImageGenerationChannelSnapshot(accepted.imageChannel, tx, false, config.model);
      await withImagePricing(frozenApi, config.model, tx, accepted.billingContract);
    } catch (error) { throw new FrozenToolFlowContractError(error instanceof Error ? error.message : undefined); }
  }
  // A node keeps its original identity and requested count while other image
  // entries occupy the shared queue. No task or credit freeze exists yet.
  try {
    if (ratioContractVersion === 3) await assertSharedStudioWorkerReady(tx);
    await reserveImageStudioQueueCapacity(tx, runRow.owner_id, remaining);
  } catch (error) {
    if (!(error instanceof QueueCapacityError) && !(error instanceof QueueMaintenanceError)) throw error;
    await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
      status: toolFlowState(run, 'pending'), input_asset_ids: stringify(inputAssetIds),
      result_json: stringify({ ...previous, expected, inputAssetIds, succeededAssetIds: existingSuccesses }),
      error: error.message,
    } });
    return { frozenCredits: 0, waiting: true };
  }
  const taskIds: string[] = [];
  const outputPlans = [...(previous.outputPlans || [])];
  let frozenCredits = 0;
  for (let index = 0; index < remaining; index += 1) {
    const created = await createQueuedTask(tx, runRow.owner_id, creditUser, runRow.id, run, node, config, existingSuccesses.length + index);
    taskIds.push(created.id);
    if (created.outputPlan && created.outputPlanHash) outputPlans.push({ ordinal: existingSuccesses.length + index + 1,
      taskId: created.id, outputPlan: created.outputPlan, outputPlanHash: created.outputPlanHash });
    frozenCredits = addCredits(frozenCredits, created.unitCredits);
  }
  if (!taskIds.length && existingSuccesses.length) {
    await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
      status: 'succeeded',
      input_asset_ids: stringify(inputAssetIds),
      output_asset_ids: stringify(existingSuccesses),
      result_json: stringify({ ...previous, expected, inputAssetIds, succeededAssetIds: existingSuccesses }),
      finished_at: new Date(),
    } });
    return { frozenCredits: 0, waiting: false };
  }
  await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
    status: toolFlowState(run, 'running'),
    input_asset_ids: stringify(inputAssetIds),
    output_asset_ids: stringify(existingSuccesses),
    result_json: stringify({ ...previous, taskIds, expected, inputAssetIds, succeededAssetIds: existingSuccesses, failedTaskIds: [],
      ...(ratioContractVersion === 3 ? { outputPlans } : {}) }),
    started_at: new Date(),
    error: null,
  } });
  const currentRun = await tx.toolFlowRun.findUniqueOrThrow({ where: { id: runRow.id }, select: { frozen_credits: true } });
  const nextFrozen = addCredits(currentRun.frozen_credits || 0, frozenCredits);
  const written = await tx.toolFlowRun.update({ where: { id: runRow.id }, data: {
    frozen_credits: nextFrozen,
    current_node_id: node.id,
  } });
  assertCreditWriteback(written, { frozen_credits: nextFrozen });
  return { frozenCredits, waiting: false };
}

function finalStatus(nodeRuns: Array<{ status: string; result_json: string | null }>) {
  const hasFailure = nodeRuns.some((nodeRun) => {
    if (nodeRun.status === 'failed' || nodeRun.status === 'cancelled' || nodeRun.status === 'skipped') return true;
    return (parseNodeResult(nodeRun.result_json).failedTaskIds || []).length > 0;
  });
  return hasFailure ? 'partial_success' : 'succeeded';
}

export async function advanceToolFlowRun(runId: string) {
  await prisma.$transaction(async (tx) => {
    const stored = await tx.toolFlowRun.findUnique({ where: { id: runId }, include: { node_runs: true } });
    if (!stored || TERMINAL_RUN_STATUSES.has(stored.status)) return;
    const run = { ...stored, status: publicToolFlowState(stored.status),
      node_runs: stored.node_runs.map(item => ({ ...item, status: publicToolFlowState(item.status) })) };
    if (run.status === 'paused') return;
    const snapshot = parseJsonObject(run.snapshot_json) as unknown as RunSnapshot;
    const graph = snapshot.graph;
    const nodes = nodeMap(graph);
    const nodeRuns = new Map(run.node_runs.map((item) => [item.node_id, item]));
    const creditUser = await tx.user.findUniqueOrThrow({
      where: { id: run.owner_id },
      select: { id: true, role: true, account_type: true, user_profile: true, feature_profile_id: true, status: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true },
    });
    if (!canUseCompanyTemplates(creditUser)) throw new AuthError('仅限公司飞书账号使用工具流', 403);
    const existingWaiting = run.node_runs.find((item) => item.status === 'waiting_selection' || item.status === 'waiting_confirmation');
    let waiting: 'selection' | 'confirmation' | null = existingWaiting
      ? existingWaiting.status === 'waiting_selection' ? 'selection' : 'confirmation'
      : null;
    let progressed = false;
    let blocked = false;

    // Build one topological ready wave up front. Every branch in the same wave
    // is queued in this transaction, while a merge waits for all parents and
    // receives their combined asset results.
    const readyNodes = graph.nodes.filter((node) => {
      const nodeRun = nodeRuns.get(node.id);
      if (!nodeRun || nodeRun.status !== 'pending') return false;
      const upstreamRuns = parents(graph, node.id).map((id) => nodeRuns.get(id)).filter(Boolean) as typeof run.node_runs;
      return upstreamRuns.every((item) => TERMINAL_TASK_STATUSES.has(item.status));
    });
    for (const node of readyNodes) {
      const nodeRun = nodeRuns.get(node.id);
      if (!nodeRun || nodeRun.status !== 'pending') continue;
      const upstreamIds = parents(graph, node.id);
      const upstreamRuns = upstreamIds.map((id) => nodeRuns.get(id)).filter(Boolean) as typeof run.node_runs;
      const inputAssetIds = Array.from(new Set(upstreamRuns.flatMap(resultAssets)));
      if (node.type === 'flow-input') {
        await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
          status: 'succeeded', input_asset_ids: stringify(snapshot.input_asset_ids), output_asset_ids: stringify(snapshot.input_asset_ids),
          result_json: stringify({ succeededAssetIds: snapshot.input_asset_ids }), finished_at: new Date(),
        } });
        nodeRuns.set(node.id, { ...nodeRun, status: 'succeeded', output_asset_ids: stringify(snapshot.input_asset_ids), result_json: stringify({ succeededAssetIds: snapshot.input_asset_ids }) });
        progressed = true;
        continue;
      }
      if (!inputAssetIds.length) {
        await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
          status: node.type === 'flow-output' ? 'succeeded' : 'failed',
          input_asset_ids: stringify(inputAssetIds), output_asset_ids: '[]', error: '上游没有可用图片结果', finished_at: new Date(),
        } });
        nodeRuns.set(node.id, { ...nodeRun, status: node.type === 'flow-output' ? 'succeeded' : 'failed', output_asset_ids: '[]', result_json: stringify({ error: '上游没有可用图片结果' }) });
        progressed = true;
        continue;
      }
      if (node.type === 'flow-template') {
        try {
          await scheduleTemplateNode(tx, snapshot, run, creditUser, node, nodeRun, inputAssetIds);
          const refreshed = await tx.toolFlowNodeRun.findUniqueOrThrow({ where: { id: nodeRun.id } });
          nodeRuns.set(node.id, { ...refreshed, status: publicToolFlowState(refreshed.status) });
          progressed = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : '图片模板调度失败';
          if (error instanceof FrozenToolFlowContractError) {
            await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
              status: toolFlowState(run, 'pending'), input_asset_ids: stringify(inputAssetIds), error: message,
            } });
            blocked = true;
            continue;
          }
          // A later allocation failure must roll back the whole ready wave,
          // not leave earlier child freezes behind a failed node marker.
          if (snapshot.contract_version === 'toolflow-pricing-v1') throw error;
          await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
            status: 'failed', input_asset_ids: stringify(inputAssetIds), output_asset_ids: '[]', error: message, finished_at: new Date(),
          } });
          nodeRuns.set(node.id, { ...nodeRun, status: 'failed', output_asset_ids: '[]', result_json: stringify({ error: message }) });
          progressed = true;
        }
        continue;
      }
      if (node.type === 'flow-select' || node.type === 'flow-confirm') {
        const kind = node.type === 'flow-select' ? 'selection' : 'confirmation';
        await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
          status: toolFlowState(run, node.type === 'flow-select' ? 'waiting_selection' : 'waiting_confirmation'),
          input_asset_ids: stringify(inputAssetIds), output_asset_ids: '[]', selected_asset_ids: '[]',
          result_json: stringify({ candidateAssetIds: inputAssetIds, inputAssetIds }), started_at: new Date(),
        } });
        nodeRuns.set(node.id, { ...nodeRun, status: node.type === 'flow-select' ? 'waiting_selection' : 'waiting_confirmation', input_asset_ids: stringify(inputAssetIds), result_json: stringify({ candidateAssetIds: inputAssetIds, inputAssetIds }) });
        waiting = kind;
        progressed = true;
        continue;
      }
      if (node.type === 'flow-output') {
        await markFinalAssets(tx, run.owner_id, inputAssetIds, run, node.id);
        await tx.toolFlowNodeRun.update({ where: { id: nodeRun.id }, data: {
          status: 'succeeded', input_asset_ids: stringify(inputAssetIds), output_asset_ids: stringify(inputAssetIds),
          result_json: stringify({ succeededAssetIds: inputAssetIds }), finished_at: new Date(),
        } });
        nodeRuns.set(node.id, { ...nodeRun, status: 'succeeded', output_asset_ids: stringify(inputAssetIds), result_json: stringify({ succeededAssetIds: inputAssetIds }) });
        progressed = true;
      }
    }

    const nextNodeRuns = Array.from(nodeRuns.values());
    const hasRunning = nextNodeRuns.some((item) => item.status === 'running');
    const hasPending = nextNodeRuns.some((item) => item.status === 'pending');
    const status = blocked ? 'paused' : waiting
      ? waiting === 'selection' ? 'waiting_selection' : 'waiting_confirmation'
      : hasRunning || hasPending
        ? 'running'
        : finalStatus(nextNodeRuns);
    const previousStatus = run.status;
    await tx.toolFlowRun.update({ where: { id: run.id }, data: {
      status: toolFlowState(run, status),
      started_at: run.started_at || new Date(),
      finished_at: TERMINAL_RUN_STATUSES.has(status) ? new Date() : undefined,
      error: blocked ? '原受理合同或执行条件需要核对，工具流现场已保留，未自动重发。'
        : status === 'partial_success' ? '部分节点或图片失败，成功结果已保留。' : null,
    } });
    if (waiting && previousStatus !== status) {
      await logRunAction(tx, run.owner_id, `toolflow_${waiting}`, run.id, { status });
      await notifyRunOwner(tx, run, `toolflow_${waiting}`, waiting === 'selection' ? '工具流等待筛选' : '工具流等待确认', waiting === 'selection' ? '工具流已生成候选图片，请选择继续使用的结果。' : '工具流已暂停，请确认后继续。', { status });
    } else if (progressed && TERMINAL_RUN_STATUSES.has(status) && !TERMINAL_RUN_STATUSES.has(previousStatus)) {
      await logRunAction(tx, run.owner_id, 'toolflow_finished', run.id, { status });
      await notifyRunOwner(tx, run, 'toolflow_finished', status === 'succeeded' ? '工具流完成' : '工具流部分完成', status === 'succeeded' ? '工具流已完成，结果已进入资产库。' : '工具流部分完成，成功结果已保留。', { status });
    }
  }, { timeout: 30000 }).catch(async error => {
    if (!runId.startsWith('rate-tf-')) throw error;
    await prisma.toolFlowRun.updateMany({ where: { id: runId,
      status: { in: ['rate_queued', 'rate_running', 'rate_waiting_selection', 'rate_waiting_confirmation'] } },
    data: { status: 'rate_paused', error: error instanceof Error ? error.message : '节点调度暂不可用，原合同与现场已保留，未重复提交。' } });
  });
}

type ToolFlowDispatchPosition = { at: Date; id: string };
let toolFlowDispatchSweep: { cursor: ToolFlowDispatchPosition | null; ceiling: ToolFlowDispatchPosition } | null = null;

/** Called by the sole image coordinator when capacity becomes available. */
export async function dispatchWaitingToolFlowRuns() {
  const eligible: Prisma.ToolFlowRunWhereInput = { status: { in: ['queued', 'running', 'rate_queued', 'rate_running'] }, node_runs: { some: { status: { in: ['pending', 'rate_pending'] } } } };
  if (!toolFlowDispatchSweep) {
    const last = await prisma.toolFlowRun.findFirst({ where: eligible, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: { created_at: true, id: true } });
    if (!last) return;
    toolFlowDispatchSweep = { cursor: null, ceiling: { at: last.created_at, id: last.id } };
  }
  const sweep = toolFlowDispatchSweep;
  const bounds: Prisma.ToolFlowRunWhereInput[] = [{ OR: [
    { created_at: { lt: sweep.ceiling.at } }, { created_at: sweep.ceiling.at, id: { lte: sweep.ceiling.id } },
  ] }];
  if (sweep.cursor) bounds.push({ OR: [
    { created_at: { gt: sweep.cursor.at } }, { created_at: sweep.cursor.at, id: { gt: sweep.cursor.id } },
  ] });
  const runs = await prisma.toolFlowRun.findMany({
    where: { ...eligible, AND: bounds }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 32, select: { id: true, created_at: true },
  });
  if (!runs.length) { toolFlowDispatchSweep = null; return; }
  // Fixed sweep ceiling excludes new tails until the next wrap. Store the
  // loaded tuple so deletion/reordering never jumps past unchecked entries.
  for (const run of runs.slice(0, 10)) {
    sweep.cursor = { at: run.created_at, id: run.id };
    await advanceToolFlowRun(run.id).catch(() => {
      // Leave the durable run and its node numbers intact; don't synthesize
      // failed tasks or change their quoted price just to release capacity.
      console.error('[toolflow] pending image dispatch deferred');
    });
  }
  if (runs.length <= 10) toolFlowDispatchSweep = null;
}

export async function createToolFlowRun(user: SessionUser, flowId: string, inputAssetIds: string[], submittedQuote: unknown, quoteProof?: string) {
  if (!canUseCompanyTemplates(user)) throw new AuthError('仅限公司飞书账号使用工具流', 403);
  assertToolFlowQuoteProof(user.id, submittedQuote, quoteProof);
  const acceptanceId = `rate-tf-${createHash('sha256').update(`${user.id}\0${flowId}\0${quoteProof}`).digest('hex')}`;
  const originalIds = parseIds(inputAssetIds);
  const accepted = await prisma.toolFlowRun.findUnique({ where: { id: acceptanceId }, include: { node_runs: true } });
  if (accepted) {
    const original = parseJsonObject(accepted.snapshot_json) as unknown as RunSnapshot;
    if (accepted.owner_id !== user.id || stringify(original.input_asset_ids) !== stringify(originalIds)) throw new AuthError('原提交的输入不同，请核对原工具流运行', 409);
    return getToolFlowRun(user, accepted.id);
  }
  if (!submittedQuote || typeof submittedQuote !== 'object' || Array.isArray(submittedQuote)
    || (submittedQuote as Record<string, unknown>).ratioContractVersion !== 3) {
    throw new AuthError('工具流图片规格已更新，请重新获取实际尺寸与报价；输入保留，尚未派发', 409);
  }
  const flow = await assertCanUseToolFlow(user, flowId);
  validateToolFlowGraph(JSON.parse(flow.graph_json));
  const settings = await getImageStudioSettings();
  const ids = parseToolFlowQuoteInputAssets(inputAssetIds);
  if (!ids.length) throw new AuthError('工具流至少需要一个输入图片', 400);
  const ownedAssets = await prisma.asset.count({ where: { id: { in: ids }, owner_id: user.id, status: 'active', type: 'image' } });
  if (ownedAssets !== new Set(ids).size) throw new AuthError('输入图片不存在或无权使用', 403);
  const run = await prisma.$transaction(async (tx) => {
    const prior = await tx.toolFlowRun.findUnique({ where: { id: acceptanceId }, include: { node_runs: true } });
    if (prior) {
      const original = parseJsonObject(prior.snapshot_json) as unknown as RunSnapshot;
      if (prior.owner_id !== user.id || stringify(original.input_asset_ids) !== stringify(ids)) throw new AuthError('原提交的输入不同，请核对原工具流运行', 409);
      return prior;
    }
    assertImageStudioAdmissionOpen();
    await assertSharedStudioWorkerReady(tx);
    const currentFlow = await tx.toolFlow.findUnique({ where: { id: flow.id } });
    if (!currentFlow || currentFlow.owner_id !== user.id || currentFlow.status === 'deleted') throw new AuthError('工具流不存在', 404);
    if (currentFlow.version !== flow.version || await currentImageSettingsRevision(tx) !== settings.revision) {
      throw new AuthError('工具流或图片设置已变化，请重新获取报价', 409);
    }
    const graph = validateToolFlowGraph(JSON.parse(currentFlow.graph_json));
    const authenticatedChannels = authenticatedToolFlowQuoteChannels(user.id, submittedQuote, quoteProof,
      { flowId: currentFlow.id, flowVersion: currentFlow.version, settingsRevision: settings.revision,
        inputAssetIds: ids, nodeIds: graph.nodes.filter(node => node.type === 'flow-template').map(node => node.id) });
    const built = await buildToolFlowQuote(tx, user, currentFlow, settings, Date.now(), undefined, { inputAssetIds: ids, authenticatedChannels });
    const billingQuote = validateSubmittedToolFlowQuote(submittedQuote, built.quote);
    const nodeContracts = await freezeToolFlowNodes(tx, user, graph, built, billingQuote, settings);
    const snapshot: RunSnapshot = {
      ratioContractVersion: 3,
      schema: 'toolflow.v1', flow_id: currentFlow.id, flow_owner_id: currentFlow.owner_id,
      version: currentFlow.version, name: currentFlow.name, project_id: currentFlow.project_id,
      graph, input_asset_ids: ids, billing_mode: 'fixed', billing_quote: billingQuote,
      contract_version: 'toolflow-pricing-v1', node_contracts: nodeContracts,
    };
    const created = await tx.toolFlowRun.create({
      data: {
        id: acceptanceId,
        flow_id: currentFlow.id,
        owner_id: user.id,
        flow_version: currentFlow.version,
        status: toolFlowState(snapshot, 'queued'),
        estimated_credits: billingQuote.estimatedCredits,
        frozen_credits: 0,
        actual_credits: 0,
        snapshot_json: stringify(snapshot),
        node_runs: { create: graph.nodes.map((node) => ({
          node_id: node.id,
          status: toolFlowState(snapshot, node.type === 'flow-input' ? 'succeeded' : 'pending'),
          input_asset_ids: node.type === 'flow-input' ? stringify(ids) : '[]',
          output_asset_ids: node.type === 'flow-input' ? stringify(ids) : '[]',
          result_json: node.type === 'flow-input' ? stringify({ succeededAssetIds: ids }) : null,
          finished_at: node.type === 'flow-input' ? new Date() : null,
        })) },
      },
      include: { node_runs: true },
    });
    await logRunAction(tx, user.id, 'toolflow_run_created', created.id, { flow_id: currentFlow.id, version: currentFlow.version, input_asset_count: ids.length, billing_mode: 'fixed', estimated_credits: billingQuote.estimatedCredits });
    return created;
  });
  await advanceToolFlowRun(run.id);
  return getToolFlowRun(user, run.id);
}

async function ownedToolFlowRun(user: SessionUser, runId: string) {
  const run = await prisma.toolFlowRun.findUnique({ where: { id: runId }, include: { flow: true, node_runs: true } });
  if (!run || run.owner_id !== user.id) throw new AuthError('工具流运行不存在', 404);
  return run;
}

export function publicToolFlowRun<T extends { status: string; snapshot_json: string; node_runs: Array<{ status: string; result_json?: string | null }> }>(run: T): T {
  const snapshot = parseJsonObject(run.snapshot_json);
  // Private pricing bindings and API-version handles never cross the DTO boundary.
  delete snapshot.node_contracts;
  delete snapshot.node_attempts;
  const frozen = parseJsonObject(run.snapshot_json) as unknown as RunSnapshot;
  snapshot.retry_receipts = Object.fromEntries(Object.entries(frozen.node_attempts || {})
    .map(([nodeId, attempts]) => [nodeId, attempts.map(attempt => attempt.quote)]));
  return { ...run, status: publicToolFlowState(run.status), snapshot_json: stringify(snapshot),
    node_runs: run.node_runs.map(node => {
      if (!Object.prototype.hasOwnProperty.call(parseJsonObject(node.result_json), 'outputPlans')) return { ...node, status: publicToolFlowState(node.status) };
      const result = parseNodeResult(node.result_json);
      return { ...node, status: publicToolFlowState(node.status), result_json: stringify({ ...result,
        outputPlans: (result.outputPlans || []).map(item => ({ ordinal: item.ordinal, taskId: item.taskId,
          outputPlan: publicImageOutputPlan(item.outputPlan) })) }) };
    }) } as T;
}

export async function getToolFlowRun(user: SessionUser, runId: string) {
  return publicToolFlowRun(await ownedToolFlowRun(user, runId));
}

export async function listToolFlowRuns(user: SessionUser, flowId?: string) {
  const runs = await prisma.toolFlowRun.findMany({
    where: { owner_id: user.id, ...(flowId ? { flow_id: flowId } : {}) },
    orderBy: { created_at: 'desc' },
    take: 30,
    include: { node_runs: true },
  });
  return runs.map(publicToolFlowRun);
}

async function cancelQueuedTask(tx: Tx, task: { id: string; owner_id: string; unit_credits: number; freeze_snapshot: string | null; status: string }) {
  const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, status: task.status }, data: {
    status: 'cancelled', billing_status: studioBillingState(task, 'cancelled'), actual_credits: 0, billing_settled_at: new Date(),
    error: '工具流已取消，未请求上游图片服务。', finished_at: new Date(),
  } });
  if (!changed.count || task.unit_credits <= 0) return;
  const settlement = await settleTaskCredits(tx, { taskId: task.id, userId: task.owner_id, terminalStatus: 'cancelled', frozenAmount: task.unit_credits, freezeSnapshot: task.freeze_snapshot });
  await tx.creditLedger.create({ data: {
    user_id: task.owner_id,
    type: 'task_failed_refund',
    amount: settlement.refundedAmount,
    balance_before: settlement.balanceBefore,
    balance_after: settlement.balanceAfter,
    frozen_before: settlement.frozenBefore,
    frozen_after: settlement.frozenAfter,
    related_task_id: task.id,
    idempotency_key: `image-studio:settle:${task.id}`,
    reason: '取消工具流，释放冻结积分',
    metadata_json: JSON.stringify({ allocations: settlement.allocations, expired_closed: settlement.expiredClosedAmount }),
  } });
}

async function refreshToolFlowCredits(tx: Tx, runId: string) {
  const rows = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: runId }, select: { status: true, unit_credits: true } });
  const frozen = sumCredits(rows.filter(item => ['queued', 'running', 'channel_queued', 'channel_running', 'uncertain']
    .includes(publicPricingTaskState(item.status))).map(item => item.unit_credits));
  const actual = sumCredits(rows.filter(item => item.status === 'succeeded').map(item => item.unit_credits));
  const written = await tx.toolFlowRun.update({ where: { id: runId }, data: { frozen_credits: frozen, actual_credits: actual } });
  assertCreditWriteback(written, { frozen_credits: frozen, actual_credits: actual });
}

export async function updateToolFlowRun(user: SessionUser, runId: string, body: Record<string, unknown>, quoteProof?: string) {
  const run = await ownedToolFlowRun(user, runId);
  const action = clean(body.action, 'status');
  if (action === 'start') {
    await prisma.toolFlowRun.updateMany({ where: { id: run.id, status: toolFlowState(run, 'queued') }, data: { status: toolFlowState(run, 'running'), started_at: new Date() } });
    await prisma.operationLog.create({ data: { operator_id: user.id, action: 'toolflow_run_started', target_type: 'ToolFlowRun', target_id: run.id } }).catch(() => undefined);
    await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  if (action === 'pause' || action === 'resume') {
    const from = action === 'pause' ? ['running', 'waiting_selection', 'waiting_confirmation'] : ['paused'];
    const to = action === 'pause' ? 'paused' : 'running';
    await prisma.toolFlowRun.updateMany({ where: { id: run.id, status: { in: from.map(status => toolFlowState(run, status)) } }, data: { status: toolFlowState(run, to) } });
    await prisma.operationLog.create({ data: { operator_id: user.id, action: `toolflow_run_${action}`, target_type: 'ToolFlowRun', target_id: run.id } }).catch(() => undefined);
    if (action === 'resume') await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  if (action === 'cancel') {
    await prisma.$transaction(async (tx) => {
      const current = await tx.toolFlowRun.findUnique({ where: { id: run.id } });
      if (!current || TERMINAL_RUN_STATUSES.has(current.status)) return;
      const queued = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: run.id, status: { in: studioTaskStates(['queued']) } }, select: { id: true, owner_id: true, unit_credits: true, freeze_snapshot: true, status: true } });
      for (const task of queued) await cancelQueuedTask(tx, task);
      await tx.toolFlowRun.update({ where: { id: run.id }, data: { status: 'cancelled', error: '已取消', finished_at: new Date() } });
      await refreshToolFlowCredits(tx, run.id);
      await logRunAction(tx, user.id, 'toolflow_run_cancelled', run.id, { queued_task_count: queued.length });
    }, { timeout: 30000 });
    return getToolFlowRun(user, run.id);
  }
  if (action === 'decision') {
    const nodeId = clean(body.node_id || body.nodeId);
    const node = await prisma.toolFlowNodeRun.findUnique({ where: { run_id_node_id: { run_id: run.id, node_id: nodeId } } });
    if (!node || !['waiting_selection', 'waiting_confirmation'].includes(publicToolFlowState(node.status))) throw new AuthError('该节点当前不等待人工操作', 409);
    const result = parseNodeResult(node.result_json);
    const candidates = result.candidateAssetIds || safeJsonArray(node.input_asset_ids);
    const selected = body.confirmed === false ? [] : parseIds(body.selected_asset_ids || body.selectedAssetIds || candidates);
    if (publicToolFlowState(node.status) === 'waiting_selection' && !selected.length) throw new AuthError('至少选择一个结果后才能继续', 400);
    const validSelected = selected.filter((id) => candidates.includes(id));
    if (publicToolFlowState(node.status) === 'waiting_selection' && validSelected.length !== selected.length) throw new AuthError('选择结果已失效，请刷新后重试', 409);
    await prisma.$transaction(async (tx) => {
      const current = await tx.toolFlowRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } });
      if (current.status === 'cancelled') throw new AuthError('原工具流已取消，未恢复或重新提交任务。', 409);
      const changed = await tx.toolFlowNodeRun.updateMany({ where: { id: node.id, status: node.status }, data: {
        status: selected.length ? 'succeeded' : 'cancelled',
        selected_asset_ids: stringify(validSelected),
        output_asset_ids: stringify(validSelected),
        result_json: stringify({ ...result, succeededAssetIds: validSelected, candidateAssetIds: candidates }),
        finished_at: new Date(),
        error: selected.length ? null : '人工确认取消后续流程',
      } });
      if (!changed.count) throw new AuthError('节点状态已变化，请核对原运行，未重复处理。', 409);
      await tx.toolFlowRun.update({ where: { id: run.id }, data: { status: toolFlowState(run, selected.length ? 'running' : 'cancelled'), current_node_id: null, ...(selected.length ? {} : { finished_at: new Date() }) } });
      await logRunAction(tx, user.id, 'toolflow_decision', run.id, { node_id: nodeId, selected_count: validSelected.length });
    });
    if (selected.length) await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  if (action === 'retry') {
    const nodeId = clean(body.node_id || body.nodeId);
    const settings = await getImageStudioSettings();
    await prisma.$transaction(async (tx) => {
      const submitted = body.quote;
      assertToolFlowQuoteProof(user.id, submitted, quoteProof);
      const fresh = await tx.toolFlowRun.findUniqueOrThrow({ where: { id: run.id } });
      const frozen = parseJsonObject(fresh.snapshot_json) as unknown as RunSnapshot;
      const previousAttempts = frozen.node_attempts?.[nodeId] || [];
      if (previousAttempts.some(attempt => quoteProofPayload(user.id, attempt.quote) === quoteProofPayload(user.id, submitted))) return;
      const context = await retryQuoteContext(tx, user, run.id, nodeId);
      if (await currentImageSettingsRevision(tx) !== settings.revision) throw new AuthError('图片设置已变化，请重新报价', 409);
      const ratioContractVersion = savedImageRatioContractVersion(context.snapshot);
      const authenticatedChannels = ratioContractVersion === 3 ? authenticatedToolFlowQuoteChannels(user.id, submitted, quoteProof,
        { flowId: run.flow_id, flowVersion: run.flow_version, settingsRevision: settings.revision,
          inputAssetIds: context.retry.inputAssetIds, nodeIds: [nodeId], retryRunId: run.id, retryNodeId: nodeId }) : undefined;
      const built = await buildToolFlowQuote(tx, user, { id: run.flow_id, owner_id: user.id, version: run.flow_version,
        graph_json: stringify(context.snapshot.graph) }, settings, Date.now(), context.retry, { authenticatedChannels });
      const quote = validateSubmittedToolFlowQuote(submitted, built.quote);
      const contracts = await freezeToolFlowNodes(tx, user, context.snapshot.graph, built, quote, settings, true);
      const snapshot = { ...context.snapshot, node_attempts: { ...context.snapshot.node_attempts,
        [nodeId]: previousAttempts.concat(contracts[nodeId]) } };
      const estimate = addCredits(context.run.estimated_credits || 0, quote.estimatedCredits || 0);
      const result = parseNodeResult(context.node.result_json);
      await tx.toolFlowNodeRun.update({ where: { id: context.node.id }, data: { status: toolFlowState(run, 'pending'), error: null,
        result_json: stringify({ ...result, retryCount: (result.retryCount || 0) + 1 }) } });
      await reopenUnstartedDescendants(tx, snapshot, run.id, nodeId);
      const written = await tx.toolFlowRun.update({ where: { id: run.id }, data: { status: toolFlowState(run, 'running'),
        snapshot_json: stringify(snapshot), estimated_credits: estimate, finished_at: null, error: null } });
      assertCreditWriteback(written, { estimated_credits: estimate });
      await logRunAction(tx, user.id, 'toolflow_node_retry', run.id, { node_id: nodeId, estimated_credits: quote.estimatedCredits });
    });
    await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  return getToolFlowRun(user, run.id);
}

export async function completeToolFlowTask(taskId: string) {
  const task = await prisma.imageStudioTask.findUnique({ where: { id: taskId } });
  if (!task?.tool_flow_run_id || !task.tool_flow_node_id) return;
  const toolFlowRunId = task.tool_flow_run_id;
  const toolFlowNodeId = task.tool_flow_node_id;
  await prisma.$transaction(async (tx) => {
    const run = await tx.toolFlowRun.findUnique({ where: { id: toolFlowRunId } });
    const node = await tx.toolFlowNodeRun.findUnique({ where: { run_id_node_id: { run_id: toolFlowRunId, node_id: toolFlowNodeId } } });
    if (!run || !node) return;
    if (run.status === 'cancelled') { await refreshToolFlowCredits(tx, run.id); return; }
    const result = parseNodeResult(node.result_json);
    const snapshot = parseJsonObject(run.snapshot_json) as unknown as RunSnapshot;
    const version3 = savedImageRatioContractVersion(snapshot) === 3;
    const taskStatus = publicPricingTaskState(task.status);
    const successIds = new Set(result.succeededAssetIds || []);
    const failedTaskIds = new Set(result.failedTaskIds || []);
    if (taskStatus === 'succeeded' && task.asset_id) {
      successIds.add(task.asset_id);
      const asset = await tx.asset.findFirst({ where: { id: task.asset_id, owner_id: task.owner_id } });
      if (asset) {
        const metadata = parseJsonObject(asset.metadata_json);
        await tx.asset.update({ where: { id: asset.id }, data: { metadata_json: stringify({ ...metadata, toolflow: { flowId: run.flow_id, version: run.flow_version, runId: run.id, nodeId: task.tool_flow_node_id } }) } });
      }
    } else if (!version3 || taskStatus !== 'uncertain') {
      failedTaskIds.add(task.id);
    }
    const tasks = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: toolFlowRunId, tool_flow_node_id: toolFlowNodeId }, select: { id: true, status: true } });
    const allDone = tasks.length > 0 && tasks.every((item) => TERMINAL_TASK_STATUSES.has(publicPricingTaskState(item.status))
      && (!version3 || publicPricingTaskState(item.status) !== 'uncertain'));
    await tx.toolFlowNodeRun.update({ where: { id: node.id }, data: {
      output_asset_ids: stringify(Array.from(successIds)),
      result_json: stringify({ ...result, succeededAssetIds: Array.from(successIds), failedTaskIds: Array.from(failedTaskIds) }),
      ...(version3 && taskStatus === 'uncertain' ? { status: toolFlowState(run, 'running'),
        error: '原图片请求结果待核对，费用预留保留；未重新生成' } : {}),
      ...(allDone ? {
        status: successIds.size ? 'succeeded' : 'failed',
        finished_at: new Date(),
        ...(!successIds.size ? { error: '图片生成失败' } : failedTaskIds.size ? { error: '部分图片生成失败，成功结果已保留。' } : version3 ? { error: null } : {}),
      } : {}),
    } });
    await refreshToolFlowCredits(tx, run.id);
  }, { timeout: 30000 });
  await advanceToolFlowRun(toolFlowRunId);
}
