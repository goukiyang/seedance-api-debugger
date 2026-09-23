import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { allocateTaskCredits, settleTaskCredits, type CreditPolicyUser } from '@/lib/credits/policy';
import { createInAppNotification } from '@/lib/notifications';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { defaultImageStudioQuality, normalizeImageStudioQuality, IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';
import { normalizeStudioRatio, studioRatioSize } from '@/lib/image-studio/ratios';
import { assertCanUseToolFlow, parseJsonObject, validateToolFlowGraph, type ToolFlowGraph, type ToolFlowNode } from './toolflow';

type Tx = Prisma.TransactionClient;
type RunSnapshot = {
  schema: 'toolflow.v1';
  flow_id: string;
  flow_owner_id: string;
  version: number;
  name: string;
  project_id: string | null;
  graph: ToolFlowGraph;
  input_asset_ids: string[];
};

type NodeResult = {
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
};

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'uncertain', 'cancelled']);
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial_success', 'failed', 'cancelled']);

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
  return {
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
  let templateReferenceIds: string[] = [];
  const templateVersion = data.template_version ?? data.templateVersion;

  if (templateId) {
    const preset = await tx.imageStudioPreset.findFirst({
      where: {
        id: templateId,
        OR: [{ scope: 'admin' }, { scope: 'creator', owner_id: ownerId }],
      },
    });
    if (!preset) throw new AuthError('图片模板不存在或未授权', 403);
    const presetIds = safeJsonArray(preset.reference_ids);
    if (templateVersion && String(templateVersion) !== preset.updated_at.toISOString()) throw new AuthError('图片模板已更新，请刷新后重新确认节点配置', 409);
    templateReferenceIds = await clonePresetAssets(tx, preset.owner_id, ownerId, presetIds);
    if (data.model && clean(data.model) !== preset.model) throw new AuthError('当前模板不允许切换到该图片模型', 400);
    prompt = [preset.prompt, promptSupplement].filter(Boolean).join('\n\n');
    templateContext = preset.context || '';
    model = preset.model || settings.model;
    quality = normalizeImageStudioQuality(model, data.quality || preset.quality);
    count = numberInRange(data.count, numberInRange(preset.count, 1, 1, 8), 1, 8);
    aspectRatio = clean(data.ratio || data.aspect_ratio, preset.aspect_ratio || 'auto');
    outputSize = clean(data.size || data.output_size) || studioRatioSize(aspectRatio) || null;
  } else if (moduleId) {
    const studioModule = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId } });
    if (!studioModule) throw new AuthError('图片模块不存在或未授权', 403);
    if (templateVersion && String(templateVersion) !== String(studioModule.revision)) throw new AuthError('图片模块已更新，请刷新后重新确认节点配置', 409);
    templateReferenceIds = await clonePresetAssets(tx, ownerId, ownerId, safeJsonArray(studioModule.reference_ids));
    if (data.model && clean(data.model) !== studioModule.model) throw new AuthError('当前模板不允许切换到该图片模型', 400);
    prompt = [studioModule.prompt, promptSupplement].filter(Boolean).join('\n\n');
    templateContext = studioModule.context || '';
    model = studioModule.model || settings.model;
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

  if (!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])) throw new AuthError('当前图片模型未配置或不可用', 409);
  // A saved image module may intentionally keep the user-facing prompt empty
  // and store the reusable instruction in its context. The image worker uses
  // that context as the provider prompt when no extra scene description is
  // supplied, so do not reject a selected module solely for an empty prompt.
  if (!prompt && !context.trim()) throw new AuthError('图片模板没有有效提示词', 400);
  if (!settings.prices[model as keyof typeof settings.prices] && settings.prices[model as keyof typeof settings.prices] !== 0) {
    throw new AuthError('当前图片模型尚未配置工具流生成积分', 409);
  }
  try { aspectRatio = normalizeStudioRatio(aspectRatio); } catch { aspectRatio = 'auto'; }
  const referenceIds = Array.from(new Set(templateReferenceIds.concat(inputAssetIds))).slice(0, 9);
  return {
    prompt: prompt.slice(0, 20000),
    context: context.slice(0, 20000),
    model,
    quality,
    count,
    aspectRatio,
    outputSize: outputSize || studioRatioSize(aspectRatio) || null,
    referenceIds,
    moduleId,
    templateId,
  };
}

async function createQueuedTask(tx: Tx, ownerId: string, creditUser: CreditPolicyUser, runId: string, run: RunSnapshot, node: ToolFlowNode, config: TemplateConfig, itemIndex: number, settings: Awaited<ReturnType<typeof getImageStudioSettings>>) {
  const id = `tf-${run.flow_id.slice(0, 12)}-${run.version}-${randomUUID()}`;
  const unitCredits = Number(settings.prices[config.model as keyof typeof settings.prices]);
  const freeze = unitCredits > 0
    ? await allocateTaskCredits(tx, creditUser, unitCredits, id)
    : null;
  await tx.imageStudioTask.create({
    data: {
      id,
      batch_id: `toolflow:${run.flow_id}:${run.version}:${node.id}`,
      owner_id: ownerId,
      module_id: config.moduleId,
      ordinal: itemIndex + 1,
      fingerprint: createHash('sha256').update(stringify({ run: run.flow_id, version: run.version, node: node.id, index: itemIndex, prompt: config.prompt, references: config.referenceIds })).digest('hex'),
      prompt: config.prompt,
      context: config.context,
      revision: settings.revision,
      model: config.model,
      quality: config.quality,
      snapshot_json: stringify({
        schema: 'toolflow.image-task.v1',
        flowId: run.flow_id,
        flowVersion: run.version,
        runId,
        nodeId: node.id,
        templateId: config.templateId,
        prompt: config.prompt,
        context: config.context,
        model: config.model,
        quality: config.quality,
        aspectRatio: config.aspectRatio,
        outputSize: config.outputSize,
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
    } });
  }
  return { id, unitCredits };
}

async function scheduleTemplateNode(
  tx: Tx,
  run: RunSnapshot,
  runRow: { owner_id: string; flow_id: string; id: string; flow_version: number },
  creditUser: CreditPolicyUser,
  node: ToolFlowNode,
  nodeRun: { id: string; result_json: string | null },
  inputAssetIds: string[],
  settings: Awaited<ReturnType<typeof getImageStudioSettings>>,
) {
  const previous = parseNodeResult(nodeRun.result_json);
  const existingSuccesses = previous.succeededAssetIds || [];
  const config = await resolveTemplate(tx, runRow.owner_id, run.flow_owner_id, node, inputAssetIds, settings);
  const expected = Math.max(existingSuccesses.length, config.count);
  const remaining = Math.max(0, expected - existingSuccesses.length);
  const taskIds: string[] = [];
  let frozenCredits = 0;
  for (let index = 0; index < remaining; index += 1) {
    const created = await createQueuedTask(tx, runRow.owner_id, creditUser, runRow.id, run, node, config, existingSuccesses.length + index, settings);
    taskIds.push(created.id);
    frozenCredits += created.unitCredits;
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
    status: 'running',
    input_asset_ids: stringify(inputAssetIds),
    output_asset_ids: stringify(existingSuccesses),
    result_json: stringify({ ...previous, taskIds, expected, inputAssetIds, succeededAssetIds: existingSuccesses, failedTaskIds: [] }),
    started_at: new Date(),
    error: null,
  } });
  await tx.toolFlowRun.update({ where: { id: runRow.id }, data: {
    frozen_credits: { increment: frozenCredits },
    current_node_id: node.id,
  } });
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
  const settings = await getImageStudioSettings();
  await prisma.$transaction(async (tx) => {
    const run = await tx.toolFlowRun.findUnique({ where: { id: runId }, include: { node_runs: true } });
    if (!run || ['cancelled', 'succeeded', 'failed'].includes(run.status)) return;
    if (run.status === 'paused') return;
    const snapshot = parseJsonObject(run.snapshot_json) as unknown as RunSnapshot;
    const graph = snapshot.graph;
    const nodes = nodeMap(graph);
    const nodeRuns = new Map(run.node_runs.map((item) => [item.node_id, item]));
    const creditUser = await tx.user.findUniqueOrThrow({
      where: { id: run.owner_id },
      select: { id: true, role: true, account_type: true, user_profile: true, status: true },
    });
    const existingWaiting = run.node_runs.find((item) => item.status === 'waiting_selection' || item.status === 'waiting_confirmation');
    let waiting: 'selection' | 'confirmation' | null = existingWaiting
      ? existingWaiting.status === 'waiting_selection' ? 'selection' : 'confirmation'
      : null;
    let progressed = false;

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
          await scheduleTemplateNode(tx, snapshot, run, creditUser, node, nodeRun, inputAssetIds, settings);
          const refreshed = await tx.toolFlowNodeRun.findUniqueOrThrow({ where: { id: nodeRun.id } });
          nodeRuns.set(node.id, refreshed);
          progressed = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : '图片模板调度失败';
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
          status: node.type === 'flow-select' ? 'waiting_selection' : 'waiting_confirmation',
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
    const status = waiting
      ? waiting === 'selection' ? 'waiting_selection' : 'waiting_confirmation'
      : hasRunning || hasPending
        ? 'running'
        : finalStatus(nextNodeRuns);
    const previousStatus = run.status;
    await tx.toolFlowRun.update({ where: { id: run.id }, data: {
      status,
      started_at: run.started_at || new Date(),
      finished_at: TERMINAL_RUN_STATUSES.has(status) ? new Date() : undefined,
      error: status === 'partial_success' ? '部分节点或图片失败，成功结果已保留。' : null,
    } });
    if (waiting && previousStatus !== status) {
      await logRunAction(tx, run.owner_id, `toolflow_${waiting}`, run.id, { status });
      await notifyRunOwner(tx, run, `toolflow_${waiting}`, waiting === 'selection' ? '工具流等待筛选' : '工具流等待确认', waiting === 'selection' ? '工具流已生成候选图片，请选择继续使用的结果。' : '工具流已暂停，请确认后继续。', { status });
    } else if (progressed && TERMINAL_RUN_STATUSES.has(status) && !TERMINAL_RUN_STATUSES.has(previousStatus)) {
      await logRunAction(tx, run.owner_id, 'toolflow_finished', run.id, { status });
      await notifyRunOwner(tx, run, 'toolflow_finished', status === 'succeeded' ? '工具流完成' : '工具流部分完成', status === 'succeeded' ? '工具流已完成，结果已进入资产库。' : '工具流部分完成，成功结果已保留。', { status });
    }
  }, { timeout: 30000 });
}

export async function createToolFlowRun(user: SessionUser, flowId: string, inputAssetIds: string[]) {
  const flow = await assertCanUseToolFlow(user, flowId);
  const graph = validateToolFlowGraph(JSON.parse(flow.graph_json));
  const ids = parseIds(inputAssetIds);
  if (!ids.length) throw new AuthError('工具流至少需要一个输入图片', 400);
  const ownedAssets = await prisma.asset.count({ where: { id: { in: ids }, owner_id: user.id, status: 'active', type: 'image' } });
  if (ownedAssets !== new Set(ids).size) throw new AuthError('输入图片不存在或无权使用', 403);
  const snapshot: RunSnapshot = { schema: 'toolflow.v1', flow_id: flow.id, flow_owner_id: flow.owner_id, version: flow.version, name: flow.name, project_id: flow.project_id, graph, input_asset_ids: ids };
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.toolFlowRun.create({
      data: {
        flow_id: flow.id,
        owner_id: user.id,
        flow_version: flow.version,
        status: 'queued',
        snapshot_json: stringify(snapshot),
        node_runs: { create: graph.nodes.map((node) => ({
          node_id: node.id,
          status: node.type === 'flow-input' ? 'succeeded' : 'pending',
          input_asset_ids: node.type === 'flow-input' ? stringify(ids) : '[]',
          output_asset_ids: node.type === 'flow-input' ? stringify(ids) : '[]',
          result_json: node.type === 'flow-input' ? stringify({ succeededAssetIds: ids }) : null,
          finished_at: node.type === 'flow-input' ? new Date() : null,
        })) },
      },
      include: { node_runs: true },
    });
    await logRunAction(tx, user.id, 'toolflow_run_created', created.id, { flow_id: flow.id, version: flow.version, input_asset_count: ids.length });
    return created;
  });
  await advanceToolFlowRun(run.id);
  return getToolFlowRun(user, run.id);
}

export async function getToolFlowRun(user: SessionUser, runId: string) {
  const run = await prisma.toolFlowRun.findUnique({ where: { id: runId }, include: { flow: true, node_runs: true } });
  if (!run || (user.role !== 'admin' && run.owner_id !== user.id)) throw new AuthError('工具流运行不存在', 404);
  return run;
}

export async function listToolFlowRuns(user: SessionUser, flowId?: string) {
  return prisma.toolFlowRun.findMany({
    where: { ...(user.role === 'admin' ? {} : { owner_id: user.id }), ...(flowId ? { flow_id: flowId } : {}) },
    orderBy: { created_at: 'desc' },
    take: 30,
    include: { node_runs: true },
  });
}

async function cancelQueuedTask(tx: Tx, task: { id: string; owner_id: string; unit_credits: number; freeze_snapshot: string | null }) {
  const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, status: 'queued' }, data: { status: 'cancelled', error: '工具流已取消，未请求上游图片服务。', finished_at: new Date() } });
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
  } });
}

export async function updateToolFlowRun(user: SessionUser, runId: string, body: Record<string, unknown>) {
  const run = await getToolFlowRun(user, runId);
  const action = clean(body.action, 'status');
  if (action === 'start') {
    await prisma.toolFlowRun.updateMany({ where: { id: run.id, status: 'queued' }, data: { status: 'running', started_at: new Date() } });
    await prisma.operationLog.create({ data: { operator_id: user.id, action: 'toolflow_run_started', target_type: 'ToolFlowRun', target_id: run.id } }).catch(() => undefined);
    await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  if (action === 'pause' || action === 'resume') {
    const from = action === 'pause' ? ['running', 'waiting_selection', 'waiting_confirmation'] : ['paused'];
    const to = action === 'pause' ? 'paused' : 'running';
    await prisma.toolFlowRun.updateMany({ where: { id: run.id, status: { in: from } }, data: { status: to } });
    await prisma.operationLog.create({ data: { operator_id: user.id, action: `toolflow_run_${action}`, target_type: 'ToolFlowRun', target_id: run.id } }).catch(() => undefined);
    if (action === 'resume') await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  if (action === 'cancel') {
    await prisma.$transaction(async (tx) => {
      const current = await tx.toolFlowRun.findUnique({ where: { id: run.id } });
      if (!current || TERMINAL_RUN_STATUSES.has(current.status)) return;
      const queued = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: run.id, status: 'queued' }, select: { id: true, owner_id: true, unit_credits: true, freeze_snapshot: true } });
      for (const task of queued) await cancelQueuedTask(tx, task);
      await tx.toolFlowRun.update({ where: { id: run.id }, data: { status: 'cancelled', error: '已取消', finished_at: new Date() } });
      await logRunAction(tx, user.id, 'toolflow_run_cancelled', run.id, { queued_task_count: queued.length });
    }, { timeout: 30000 });
    return getToolFlowRun(user, run.id);
  }
  if (action === 'decision') {
    const nodeId = clean(body.node_id || body.nodeId);
    const node = await prisma.toolFlowNodeRun.findUnique({ where: { run_id_node_id: { run_id: run.id, node_id: nodeId } } });
    if (!node || !['waiting_selection', 'waiting_confirmation'].includes(node.status)) throw new AuthError('该节点当前不等待人工操作', 409);
    const result = parseNodeResult(node.result_json);
    const candidates = result.candidateAssetIds || safeJsonArray(node.input_asset_ids);
    const selected = body.confirmed === false ? [] : parseIds(body.selected_asset_ids || body.selectedAssetIds || candidates);
    if (node.status === 'waiting_selection' && !selected.length) throw new AuthError('至少选择一个结果后才能继续', 400);
    const validSelected = selected.filter((id) => candidates.includes(id));
    if (node.status === 'waiting_selection' && validSelected.length !== selected.length) throw new AuthError('选择结果已失效，请刷新后重试', 409);
    await prisma.$transaction(async (tx) => {
      await tx.toolFlowNodeRun.update({ where: { id: node.id }, data: {
        status: selected.length ? 'succeeded' : 'cancelled',
        selected_asset_ids: stringify(validSelected),
        output_asset_ids: stringify(validSelected),
        result_json: stringify({ ...result, succeededAssetIds: validSelected, candidateAssetIds: candidates }),
        finished_at: new Date(),
        error: selected.length ? null : '人工确认取消后续流程',
      } });
      await tx.toolFlowRun.update({ where: { id: run.id }, data: { status: selected.length ? 'running' : 'cancelled', current_node_id: null, ...(selected.length ? {} : { finished_at: new Date() }) } });
      await logRunAction(tx, user.id, 'toolflow_decision', run.id, { node_id: nodeId, selected_count: validSelected.length });
    });
    if (selected.length) await advanceToolFlowRun(run.id);
    return getToolFlowRun(user, run.id);
  }
  if (action === 'retry') {
    const nodeId = clean(body.node_id || body.nodeId);
    const node = await prisma.toolFlowNodeRun.findUnique({ where: { run_id_node_id: { run_id: run.id, node_id: nodeId } } });
    if (!node || !['failed', 'succeeded'].includes(node.status)) throw new AuthError('该节点当前不能重试', 409);
    await prisma.$transaction(async (tx) => {
      await tx.toolFlowNodeRun.update({ where: { id: node.id }, data: { status: 'pending', error: null } });
      await tx.toolFlowRun.update({ where: { id: run.id }, data: { status: 'running', finished_at: null, error: null } });
      await logRunAction(tx, user.id, 'toolflow_node_retry', run.id, { node_id: nodeId });
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
    if (!run || !node || run.status === 'cancelled') return;
    const result = parseNodeResult(node.result_json);
    const successIds = new Set(result.succeededAssetIds || []);
    const failedTaskIds = new Set(result.failedTaskIds || []);
    if (task.status === 'succeeded' && task.asset_id) {
      successIds.add(task.asset_id);
      const asset = await tx.asset.findFirst({ where: { id: task.asset_id, owner_id: task.owner_id } });
      if (asset) {
        const metadata = parseJsonObject(asset.metadata_json);
        await tx.asset.update({ where: { id: asset.id }, data: { metadata_json: stringify({ ...metadata, toolflow: { flowId: run.flow_id, version: run.flow_version, runId: run.id, nodeId: task.tool_flow_node_id } }) } });
      }
    } else {
      failedTaskIds.add(task.id);
    }
    const tasks = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: toolFlowRunId, tool_flow_node_id: toolFlowNodeId }, select: { id: true, status: true } });
    const allDone = tasks.length > 0 && tasks.every((item) => TERMINAL_TASK_STATUSES.has(item.status));
    await tx.toolFlowNodeRun.update({ where: { id: node.id }, data: {
      output_asset_ids: stringify(Array.from(successIds)),
      result_json: stringify({ ...result, succeededAssetIds: Array.from(successIds), failedTaskIds: Array.from(failedTaskIds) }),
      ...(allDone ? {
        status: successIds.size ? 'succeeded' : 'failed',
        finished_at: new Date(),
        ...(!successIds.size ? { error: '图片生成失败' } : failedTaskIds.size ? { error: '部分图片生成失败，成功结果已保留。' } : {}),
      } : {}),
    } });
    const creditRows = await tx.imageStudioTask.findMany({ where: { tool_flow_run_id: run.id }, select: { status: true, unit_credits: true } });
    const frozen = creditRows.filter((item) => ['queued', 'running'].includes(item.status)).reduce((sum, item) => sum + item.unit_credits, 0);
    const actual = creditRows.filter((item) => item.status === 'succeeded').reduce((sum, item) => sum + item.unit_credits, 0);
    await tx.toolFlowRun.update({ where: { id: run.id }, data: { frozen_credits: frozen, actual_credits: actual } });
  }, { timeout: 30000 });
  await advanceToolFlowRun(toolFlowRunId);
}
