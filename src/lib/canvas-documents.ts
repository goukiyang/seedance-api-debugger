import { createHash, randomUUID } from 'crypto';
import { Prisma, type CanvasDocument } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { assertCanViewTask, getAccessibleProjectIds, getProjectAccess } from '@/lib/projects/permissions';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';

export const MAX_CANVAS_BYTES = 2 * 1024 * 1024;
const HISTORY_LIMIT = 20;
const PAGE_SIZE = 30;
const MUTATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type ObjectValue = Record<string, unknown>;
type Db = Prisma.TransactionClient;
type NodeSnapshot = { id: string; type: string; x: number; y: number; data: ObjectValue };
type Snapshot = ObjectValue & {
  canvas: ObjectValue & { nodes: NodeSnapshot[]; connections: { from: string; to: string }[] };
};

export class CanvasDocumentError extends AuthError {
  constructor(message: string, status: number, public readonly code: string,
    public readonly details: ObjectValue = {}) {
    super(message, status);
  }
}

function invalid(message: string): never {
  throw new CanvasDocumentError(message, 400, 'invalid_document');
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

// Reject executable/binary payloads, rather than silently truncating a saved graph.
function checkJson(value: unknown, depth = 0): void {
  if (depth > 32) invalid('画布嵌套过深，请拆分后保存');
  if (typeof value === 'string') {
    if (/^\s*(data:|blob:|javascript:|vbscript:)/i.test(value)
      || /<\s*\/?\s*(script|iframe|object|embed)\b|\bon\w+\s*=/i.test(value)) {
      invalid('请先上传素材，画布不能包含临时图片、二进制或脚本内容');
    }
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('画布包含无效数值');
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1);
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)
        || /^(api[_-]?key|access[_-]?token|authorization|password|secret|cookie|base64|binary)$/i.test(key)) {
        invalid('画布包含不允许保存的字段');
      }
      checkJson(item, depth + 1);
    }
  }
}

export function parseCanvasSnapshot(raw: string, projectId: string | null, v2: boolean): Snapshot {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CANVAS_BYTES) {
    throw new CanvasDocumentError('画布超过 2MB，请减少节点或拆分后保存', 413, 'document_too_large');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid('画布内容不是有效 JSON'); }
  checkJson(parsed);
  if (!object(parsed) || !object(parsed.canvas)) invalid('画布缺少 canvas 快照');
  if (parsed.schema !== undefined && parsed.schema !== 'ultimate_canvas.v1') invalid('不支持此画布格式');
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    throw new CanvasDocumentError('画布版本较新，请刷新后重试', 426, 'schema_upgrade_required');
  }
  const graph = parsed.canvas;
  if (graph.version !== undefined && graph.version !== 1) invalid('不支持此画布引擎版本');
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.connections)) invalid('画布节点和连线必须是数组');
  if (graph.nodes.length > 1000 || graph.connections.length > 5000) invalid('画布节点或连线过多，请拆分保存');
  const nodeIds = new Set<string>();
  const types = new Set(['text', 'script', 'image', 'video', 'audio', 'director',
    'flow-input', 'flow-template', 'flow-select', 'flow-confirm', 'flow-output']);
  for (const node of graph.nodes) {
    if (!object(node) || !id(node.id) || nodeIds.has(node.id)) invalid('节点 ID 无效或重复');
    if (typeof node.type !== 'string' || !types.has(node.type)) invalid('不支持的节点类型');
    if (typeof node.x !== 'number' || !Number.isFinite(node.x)
      || typeof node.y !== 'number' || !Number.isFinite(node.y) || !object(node.data)) invalid('节点坐标或配置无效');
    nodeIds.add(node.id);
  }
  const connections = new Set<string>();
  for (const edge of graph.connections) {
    if (!object(edge) || !id(edge.from) || !id(edge.to)
      || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) invalid('连线引用了无效节点');
    const key = `${edge.from}:${edge.to}`;
    if (connections.has(key)) invalid('画布存在重复连线');
    connections.add(key);
  }
  if (graph.selectedNodeId != null && (!id(graph.selectedNodeId) || !nodeIds.has(graph.selectedNodeId))) {
    invalid('选中节点不存在');
  }
  if (graph.viewport !== undefined) {
    if (!object(graph.viewport)) invalid('画布视角无效');
    for (const key of ['scale', 'offsetX', 'offsetY', 'nextNodeId']) {
      const value = graph.viewport[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) invalid('画布视角数值无效');
    }
    if (typeof graph.viewport.scale === 'number' && graph.viewport.scale <= 0) invalid('画布缩放必须大于零');
  }
  if (parsed.context !== undefined && !object(parsed.context)) invalid('画布项目上下文无效');
  const context = object(parsed.context) ? parsed.context : {};
  if (context.project_id != null && context.project_id !== projectId) invalid('画布内容与所属项目不一致');
  if (v2) {
    parsed.schemaVersion = 2;
    parsed.context = { ...context, project_id: projectId };
  }
  return parsed as Snapshot;
}

export const canvasMetadataSelect = {
  id: true, owner_user_id: true, project_id: true, title: true,
  active_generation_node_id: true, status: true, revision: true, schema_version: true,
  protocol_version: true, access_scope: true, created_at: true, updated_at: true,
} satisfies Prisma.CanvasDocumentSelect;

type Metadata = Prisma.CanvasDocumentGetPayload<{ select: typeof canvasMetadataSelect }>;
export function canvasMetadata(document: Metadata) {
  return {
    id: document.id, owner_user_id: document.owner_user_id, project_id: document.project_id,
    title: document.title, active_generation_node_id: document.active_generation_node_id,
    status: document.status, revision: document.revision, schema_version: document.schema_version,
    protocol_version: document.protocol_version, access_scope: document.access_scope,
    created_at: document.created_at.toISOString(), updated_at: document.updated_at.toISOString(),
  };
}

export function canvasDetail(document: CanvasDocument) {
  return { ...canvasMetadata(document), document_json: document.document_json };
}

async function assertProject(user: SessionUser, projectId: string | null, write: boolean) {
  if (!projectId) return;
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!(write ? access.canGenerate : access.canView)) throw new AuthError('无权访问此项目画布', 403);
}

async function assertDocument(user: SessionUser, document: Metadata | null, write: boolean): Promise<void> {
  if (!document || document.status === 'deleted') throw new AuthError('画布不存在', 404);
  await assertProject(user, document.project_id, write);
  if (user.role === 'admin' || document.owner_user_id === user.id) return;
  if (document.access_scope !== 'legacy' || !document.project_id) throw new AuthError('无权访问此画布', 403);
  // Historical direct-link collaboration stays compatible, but never expands the list.
  await assertProject(user, document.project_id, true);
}

export async function readCanvasDocument(user: SessionUser, documentId: string) {
  return assertCanReadCanvasDocument(user, documentId);
}

export async function assertCanReadCanvasDocument(user: SessionUser, documentId: string, projectId?: string | null) {
  return assertCanAccessCanvasDocument(user, documentId, { projectId });
}

export async function assertCanEditCanvasDocument(user: SessionUser, documentId: string, projectId?: string | null) {
  return assertCanAccessCanvasDocument(user, documentId, { write: true, projectId });
}

/** Generation callers must pass write: true and their resolved projectId. */
export async function assertCanAccessCanvasDocument(user: SessionUser, documentId: string,
  options: { write?: boolean; projectId?: string | null } = {}) {
  assertInternalOnly(user, '外部账号无权使用无线画布。');
  const document = await prisma.canvasDocument.findUnique({ where: { id: documentId } });
  await assertDocument(user, document, options.write ?? false);
  if (options.projectId !== undefined && options.projectId !== document!.project_id) {
    throw new AuthError('画布不属于当前项目', 400);
  }
  if (options.write && document!.status !== 'active') {
    throw new CanvasDocumentError('画布已归档，请先恢复后操作', 409, 'document_archived');
  }
  return document!;
}

export async function listCanvasDocuments(user: SessionUser, params: URLSearchParams) {
  const projectId = string(params.get('project_id')) || null;
  await assertProject(user, projectId, false);
  const status = params.get('status') || 'active';
  if (status !== 'active' && status !== 'archived') invalid('不支持的画布状态');
  const q = string(params.get('q'));
  if (q.length > 120) invalid('搜索内容过长');
  const scope = createHash('sha256').update(canonical([user.id, projectId, status, q])).digest('hex');
  let after: { id: string; updated_at: Date } | null = null;
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!object(value) || !id(value.id) || value.scope !== scope || typeof value.updated_at !== 'string') throw new Error();
      const date = new Date(value.updated_at);
      if (!Number.isFinite(date.getTime())) throw new Error();
      after = { id: value.id, updated_at: date };
    } catch { invalid('分页游标无效，请重新加载列表'); }
  }
  const projectIds = projectId ? [projectId] : await getAccessibleProjectIds(user);
  const documents = await prisma.canvasDocument.findMany({
    where: {
      owner_user_id: user.id, status, title: q ? { contains: q } : undefined,
      AND: [
        projectId ? { project_id: projectId } : { OR: [{ project_id: null }, { project_id: { in: projectIds } }] },
        ...(after ? [{ OR: [{ updated_at: { lt: after.updated_at } },
          { updated_at: after.updated_at, id: { lt: after.id } }] }] : []),
      ],
    },
    select: canvasMetadataSelect,
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: PAGE_SIZE + 1,
  });
  const page = documents.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    documents: page.map(canvasMetadata),
    next_cursor: documents.length > PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ id: last.id, updated_at: last.updated_at.toISOString(), scope })).toString('base64url') : null,
  };
}

export async function latestCanvasDocument(user: SessionUser, projectId: string | null) {
  const listed = await listCanvasDocuments(user, new URLSearchParams(projectId ? { project_id: projectId } : {}));
  return listed.documents[0] ? readCanvasDocument(user, listed.documents[0].id) : null;
}

export async function canvasHistory(user: SessionUser, documentId: string) {
  await readCanvasDocument(user, documentId);
  const revisions = await prisma.canvasDocumentRevision.findMany({
    where: { document_id: documentId }, orderBy: { revision: 'desc' }, take: HISTORY_LIMIT,
    select: { revision: true, schema_version: true, title: true, created_at: true },
  });
  return { revisions, history_limit: HISTORY_LIMIT };
}

function resourceRefs(snapshot: Snapshot) {
  const assets = new Set<string>();
  const references = new Set<string>();
  const tasks = new Set<string>();
  function walk(value: unknown) {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!object(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const compact = key.replace(/_/g, '').toLowerCase();
      const target = ['assetid', 'assetids', 'inputassetids'].includes(compact) ? assets
        : ['referenceimageid', 'referenceimageids'].includes(compact) ? references
          : compact === 'taskid' ? tasks : null;
      if (target) for (const entry of Array.isArray(item) ? item : [item]) {
        if (entry != null && entry !== '') {
          if (!id(entry)) invalid('素材或任务引用无效');
          target.add(entry);
        }
      }
      walk(item);
    }
  }
  walk(snapshot.canvas.nodes);
  if (assets.size + references.size + tasks.size > 1000) invalid('素材或任务引用过多，请拆分画布');
  return { asset_ids: Array.from(assets).sort(), reference_image_ids: Array.from(references).sort(), task_ids: Array.from(tasks).sort() };
}

async function validateAssets(db: Db, user: SessionUser, snapshot: Snapshot, hydrateInputs = false) {
  const refs = resourceRefs(snapshot);
  const authorizedReferenceAssets = new Set<string>();
  const previews = new Map<string, { id: string; originalUrl: string; thumbnailUrl: string; title: string }>();
  const referencePreviews = new Map<string, { url: string; thumbnail: string }>();
  for (const referenceId of refs.reference_image_ids) {
    const image = await assertCanUseReferenceImage(user, referenceId);
    if (image.asset && image.asset.status !== 'active') {
      throw new CanvasDocumentError('参考素材已不可用，请重新选择素材', 403, 'resource_unavailable');
    }
    if (image.asset_id) authorizedReferenceAssets.add(image.asset_id);
    referencePreviews.set(image.id, { url: image.url, thumbnail: image.thumbnail_url || image.url });
  }
  // A valid shared reference may authorize its asset without transferring ownership.
  const directAssets = refs.asset_ids.filter(assetId => !authorizedReferenceAssets.has(assetId));
  for (let offset = 0; offset < directAssets.length; offset += 200) {
    const batch = directAssets.slice(offset, offset + 200);
    const count = await db.asset.count({ where: {
      id: { in: batch }, status: 'active', ...(user.role === 'admin' ? {} : { owner_id: user.id }),
    } });
    if (count !== batch.length) throw new CanvasDocumentError('素材不存在或无权使用，请重新选择素材', 403, 'resource_unavailable');
  }
  if (hydrateInputs) {
    for (let offset = 0; offset < refs.asset_ids.length; offset += 200) {
      const assets = await db.asset.findMany({
        where: { id: { in: refs.asset_ids.slice(offset, offset + 200) }, status: 'active' },
        select: { id: true, original_url: true, thumbnail_url: true, file_name: true },
      });
      for (const asset of assets) previews.set(asset.id, {
        id: asset.id, originalUrl: asset.original_url, thumbnailUrl: asset.thumbnail_url || asset.original_url, title: asset.file_name,
      });
    }
    for (const node of snapshot.canvas.nodes) {
      const assetIds = node.data.assetIds ?? node.data.asset_ids;
      if (node.type === 'flow-input' && Array.isArray(assetIds)) {
        node.data.assetPreviews = assetIds.map(assetId => previews.get(String(assetId))).filter(Boolean);
      }
      const asset = previews.get(string(node.data.assetId ?? node.data.asset_id));
      const reference = referencePreviews.get(string(node.data.referenceImageId ?? node.data.reference_image_id));
      const url = reference?.url || asset?.originalUrl;
      if (url) Object.assign(node.data, { originalUrl: url, imageUrl: url, referenceImage: url,
        thumbnailUrl: reference?.thumbnail || asset?.thumbnailUrl || url,
        previewImage: reference?.thumbnail || asset?.thumbnailUrl || url });
    }
  }
  return refs;
}

async function validateNewReferences(db: Db, user: SessionUser, snapshot: Snapshot, existing: CanvasDocument | null) {
  const refs = resourceRefs(snapshot);
  let previous: ReturnType<typeof resourceRefs> = { asset_ids: [], reference_image_ids: [], task_ids: [] };
  if (existing) {
    try { previous = resourceRefs(parseCanvasSnapshot(existing.document_json, existing.project_id, false)); }
    catch { /* Invalid legacy JSON is backed up on upgrade, but cannot authorize new references. */ }
  }
  const newAssets = refs.asset_ids.filter(value => !previous.asset_ids.includes(value));
  const newReferences = new Set(refs.reference_image_ids.filter(value => !previous.reference_image_ids.includes(value)));
  // Revalidate an existing reference only when it is used to authorize a newly attached asset.
  for (let offset = 0; offset < newAssets.length; offset += 200) {
    const images = await db.referenceImage.findMany({
      where: { asset_id: { in: newAssets.slice(offset, offset + 200) }, id: { in: refs.reference_image_ids } },
      select: { id: true },
    });
    images.forEach(image => newReferences.add(image.id));
  }
  if (newAssets.length || newReferences.size) {
    await validateAssets(db, user, {
      canvas: { nodes: [{ id: 'references', type: 'flow-input', x: 0, y: 0,
        data: { assetIds: newAssets, referenceImageIds: Array.from(newReferences) } }], connections: [] },
    });
  }
  const newTasks = refs.task_ids.filter(value => !previous.task_ids.includes(value));
  for (let offset = 0; offset < newTasks.length; offset += 200) {
    const batch = newTasks.slice(offset, offset + 200);
    const tasks = await db.videoTask.findMany({
      where: { id: { in: batch } },
      select: { id: true, project_id: true, owner_user_id: true, user_id: true, retention_status: true },
    });
    for (const task of tasks) await assertCanViewTask(user, task);
    const missingIds = batch.filter(taskId => !tasks.some(task => task.id === taskId));
    if (missingIds.length) {
      const imageTaskCount = await db.imageStudioTask.count({ where: {
        id: { in: missingIds }, ...(user.role === 'admin' ? {} : { owner_id: user.id }),
      } });
      if (imageTaskCount !== missingIds.length) throw new CanvasDocumentError('引用任务不存在或无权访问', 403, 'resource_unavailable');
    }
  }
}

async function saveHistory(db: Db, document: CanvasDocument) {
  const snapshot = parseCanvasSnapshot(document.document_json, document.project_id, true);
  await db.canvasDocumentRevision.create({ data: {
    document_id: document.id, revision: document.revision, schema_version: document.schema_version,
    title: document.title, document_json: document.document_json,
    active_generation_node_id: document.active_generation_node_id,
    resource_refs_json: JSON.stringify(resourceRefs(snapshot)),
  } });
  const excess = await db.canvasDocumentRevision.findMany({
    where: { document_id: document.id }, orderBy: { revision: 'desc' }, skip: HISTORY_LIMIT, select: { id: true },
  });
  if (excess.length) await db.canvasDocumentRevision.deleteMany({ where: { id: { in: excess.map(row => row.id) } } });
}

function meaningfulContent(raw: string) {
  const snapshot = JSON.parse(raw) as Snapshot;
  const { savedAt: _savedAt, schemaVersion: _schemaVersion, ...content } = snapshot;
  const { selectedNodeId: _selected, viewport: _viewport, ...graph } = snapshot.canvas;
  return canonical({ ...content, canvas: graph });
}

// Duplication copies configuration, not output history, private previews or live tasks.
function duplicateSnapshot(snapshot: Snapshot): Snapshot {
  const configKeys = new Set(['title', 'prompt', 'description', 'context', 'savedContext', 'contextRules',
    'mode', 'imageSettings', 'videoSettings', 'settings', 'model', 'quality', 'ratio', 'size', 'resolution',
    'count', 'duration', 'cameraPresets', 'templateId', 'template_id', 'templateVersion', 'moduleId', 'module_id',
    'source', 'executionMode', 'inputSource', 'retryCount', 'outputMode']);
  const remap = new Map(snapshot.canvas.nodes.map(node => [node.id, `node-${randomUUID()}`]));
  return {
    schema: 'ultimate_canvas.v1', schemaVersion: 2,
    context: { project_id: object(snapshot.context) ? snapshot.context.project_id : null },
    canvas: {
      version: 1, viewport: snapshot.canvas.viewport, selectedNodeId: null,
      nodes: snapshot.canvas.nodes.map(node => {
        const data = Object.fromEntries(Object.entries(node.data).filter(([key]) => configKeys.has(key)));
        if (node.type === 'flow-input') {
          data.assetIds = node.data.assetIds || node.data.asset_ids || [];
          data.asset_ids = data.assetIds;
        } else if (['upload', 'asset', 'reference_image'].includes(String(node.data.source))
          && !node.data.taskId && !node.data.generationResult && node.data.generationStatus !== 'succeeded') {
          data.assetId = node.data.assetId || node.data.asset_id || null;
          data.referenceImageId = node.data.referenceImageId || node.data.reference_image_id || null;
        }
        data.generationStatus = 'idle';
        return { ...node, id: remap.get(node.id)!, data };
      }),
      connections: snapshot.canvas.connections.map(edge => ({ from: remap.get(edge.from)!, to: remap.get(edge.to)! })),
    },
  };
}

function withoutLiveTasks(snapshot: Snapshot): Snapshot {
  const runtimeKeys = new Set([
    'taskid', 'taskids', 'providertaskid', 'providertaskids', 'upstreamtaskid',
    'imagetaskid', 'videotaskid', 'studiotaskid', 'imagestudiotaskid',
    'runid', 'runids', 'flowrunid', 'toolflowrunid', 'batchid', 'batchids',
    'requestid', 'mutationid', 'idempotencykey', 'submissionid',
    'documentid', 'canvasdocumentid', 'activegenerationnodeid',
    'generationresult', 'generationerror', 'generationprogress',
    'taskstatus', 'runstatus', 'batchstatus', 'statusendpoint', 'pollingurl', 'pollurl',
  ]);
  const mediaKeys = new Set([
    'previewimage', 'referenceimage', 'referenceimages', 'thumbnail', 'thumbnails',
    'poster', 'cover', 'preview', 'previews', 'src', 'srcset', 'href',
    'assetpreviews', 'stabledownloadready', 'image', 'images', 'video', 'audio',
  ]);
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean);
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => {
        const normalized = key.replace(/[_-]/g, '').toLowerCase();
        // A snapshot URL is not proof of access, even when a task ID was removed.
        // Only current authorized Asset/ReferenceImage records may supply media again.
        return !runtimeKeys.has(normalized) && !mediaKeys.has(normalized)
          && !/(?:url|urls|uri|uris)$/.test(normalized);
      })
      .map(([key, item]) => [key, key.replace(/[_-]/g, '').toLowerCase() === 'generationstatus' ? 'idle' : clean(item)]));
  }
  const detached = clean(snapshot) as Snapshot;
  // Keep input/configuration and resource IDs, never old task ownership or media URLs.
  for (const node of detached.canvas.nodes) node.data.generationStatus = 'idle';
  return detached;
}

async function prepareDetachedSnapshot(db: Db, user: SessionUser, snapshot: Snapshot, projectId: string | null) {
  const detached = withoutLiveTasks(snapshot);
  await validateAssets(db, user, detached, true);
  return parseCanvasSnapshot(JSON.stringify(detached), projectId, true);
}

function rawSnapshot(body: ObjectValue) {
  const raw = body.document_json ?? body.documentJson ?? body.document;
  if (raw === undefined) invalid('缺少画布内容');
  const result = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(result, 'utf8') > MAX_CANVAS_BYTES) {
    throw new CanvasDocumentError('画布超过 2MB，请减少节点或拆分后保存', 413, 'document_too_large');
  }
  return result;
}

function titleFor(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  const title = string(value);
  if (!title || title.length > 120) invalid('画布名称须为 1 至 120 个字符');
  checkJson(title);
  return title;
}

function conflict(document: CanvasDocument): never {
  throw new CanvasDocumentError('画布已在其他页面更新，请加载最新版本或另存副本', 409, 'revision_conflict', {
    current_revision: document.revision, document: canvasMetadata(document),
  });
}

export async function mutateCanvasDocument(user: SessionUser, body: ObjectValue, method: 'POST' | 'PATCH') {
  assertInternalOnly(user, '外部账号无权使用无线画布。');
  checkJson(body);
  const documentId = string(body.document_id ?? body.documentId);
  const projectSpecified = body.project_id !== undefined || body.projectId !== undefined;
  const requestedProject = string(body.project_id ?? body.projectId) || null;
  const v2 = body.protocol_version === 2;
  if (body.protocol_version !== undefined && body.protocol_version !== 1 && !v2) invalid('不支持此保存协议');
  if ((!documentId || method === 'PATCH') && !v2) {
    throw new CanvasDocumentError('请刷新页面后使用新版画布保存', 426, 'protocol_upgrade_required');
  }
  const mutationId = string(body.mutation_id);
  const baseRevision = body.base_revision;
  if (v2 && (!id(mutationId) || !Number.isSafeInteger(baseRevision) || Number(baseRevision) < 0)) {
    invalid('保存需要 mutation_id 和非负整数 base_revision');
  }
  const action = method === 'POST' ? 'save' : string(body.action);
  if (!['save', 'rename', 'archive', 'restore', 'duplicate', 'restore_revision'].includes(action)) invalid('不支持此画布操作');
  if (method === 'PATCH' && !documentId) invalid('缺少 document_id');
  const hashBody = { ...body };
  delete hashBody.save_reason;
  // Object key ordering and JSON whitespace are not semantically different requests.
  if (action === 'save') {
    hashBody.document_json = JSON.parse(rawSnapshot(body));
    checkJson(hashBody.document_json);
  }
  delete hashBody.documentJson;
  delete hashBody.document;
  const requestHash = createHash('sha256').update(canonical({ method, body: hashBody })).digest('hex');
  const now = new Date();
  const receiptCutoff = new Date(now.getTime() - MUTATION_TTL_MS);
  const mutationExpiresAt = new Date(now.getTime() + MUTATION_TTL_MS).toISOString();

  async function replay(db: Db) {
    if (!v2) return null;
    const receipt = await db.canvasDocumentMutation.findUnique({
      where: { actor_user_id_mutation_id: { actor_user_id: user.id, mutation_id: mutationId } },
    });
    if (!receipt || receipt.created_at < receiptCutoff) return null;
    if (receipt.request_hash !== requestHash) {
      throw new CanvasDocumentError('此请求编号已用于不同内容，请使用新的 mutation_id', 409, 'mutation_conflict');
    }
    const document = await db.canvasDocument.findUnique({ where: { id: receipt.document_id }, select: canvasMetadataSelect });
    await assertDocument(user, document, true);
    if (documentId && documentId !== receipt.document_id) {
      await assertDocument(user, await db.canvasDocument.findUnique({ where: { id: documentId }, select: canvasMetadataSelect }), true);
    }
    return { ...JSON.parse(receipt.response_json), replayed: true };
  }

  try {
    return await prisma.$transaction(async db => {
      if (v2) await db.canvasDocumentMutation.deleteMany({ where: { created_at: { lt: receiptCutoff } } });
      const repeated = await replay(db);
      if (repeated) return repeated;
      const existing = documentId ? await db.canvasDocument.findUnique({ where: { id: documentId } }) : null;
      if (documentId) await assertDocument(user, existing, true);
      if (existing && !v2 && existing.protocol_version >= 2) {
        throw new CanvasDocumentError('此画布已使用新版保存，请刷新页面并保留本地草稿', 426, 'protocol_upgrade_required');
      }
      const projectId = existing ? existing.project_id : requestedProject;
      if (existing && projectSpecified && requestedProject !== existing.project_id) invalid('不能移动画布到其他项目');
      if (!existing && !projectId) invalid('新建画布必须选择项目');
      await assertProject(user, projectId, true);
      if (v2 && baseRevision !== (existing?.revision ?? 0)) {
        if (existing) conflict(existing);
        invalid('新建画布 base_revision 必须为 0');
      }
      if (existing?.status === 'archived' && action === 'save') {
        throw new CanvasDocumentError('画布已归档，请先恢复后编辑', 409, 'document_archived');
      }
      if (existing && existing.protocol_version < 2 && action === 'restore_revision') {
        throw new CanvasDocumentError('请先用新版保存此画布，再恢复历史版本', 409, 'history_unavailable');
      }
      let snapshot: Snapshot | null = null;
      let activeNode: string | null = existing?.active_generation_node_id ?? null;
      let title = titleFor(body.title, existing?.title ?? '未命名画布');
      if (action === 'save') {
        snapshot = parseCanvasSnapshot(rawSnapshot(body), projectId, v2);
        // POST creation also serves conflict/draft copies, not only empty canvases.
        // Strip runtime bindings before reference validation and before any snapshot is stored.
        if (!existing) snapshot = await prepareDetachedSnapshot(db, user, snapshot, projectId);
        else if (v2) await validateNewReferences(db, user, snapshot, existing);
        if (body.active_generation_node_id !== undefined || body.activeGenerationNodeId !== undefined) {
          activeNode = string(body.active_generation_node_id ?? body.activeGenerationNodeId) || null;
        }
        if (activeNode && !snapshot.canvas.nodes.some(node => node.id === activeNode)) invalid('当前节点不存在');
        if (!existing) activeNode = null;
      } else if (action === 'duplicate') {
        snapshot = await prepareDetachedSnapshot(db, user,
          duplicateSnapshot(parseCanvasSnapshot(existing!.document_json, projectId, true)), projectId);
        title = titleFor(body.title, `${existing!.title.slice(0, 115)} 副本`);
        activeNode = null;
      } else if (action === 'restore_revision') {
        if (!Number.isSafeInteger(body.target_revision) || Number(body.target_revision) < 1) invalid('历史版本无效');
        const revision = await db.canvasDocumentRevision.findUnique({
          where: { document_id_revision: { document_id: documentId, revision: Number(body.target_revision) } },
        });
        if (!revision) throw new CanvasDocumentError('历史版本已过期或不存在', 404, 'revision_not_found');
        snapshot = await prepareDetachedSnapshot(db, user,
          parseCanvasSnapshot(revision.document_json, projectId, true), projectId);
        title = revision.title;
        activeNode = null;
      } else if (action === 'rename' && body.title === undefined) invalid('请输入新的画布名称');

      const newDocument = !existing || action === 'duplicate';
      const data = {
        title, active_generation_node_id: activeNode,
        ...(snapshot ? { document_json: JSON.stringify(snapshot) } : {}),
        ...(action === 'archive' ? { status: 'archived' } : action === 'restore' ? { status: 'active' } : {}),
        // Metadata actions must not implicitly upgrade historical JSON/protocol.
        ...(v2 && action === 'save' ? { protocol_version: 2, schema_version: 2,
          ...(existing?.protocol_version === 1 ? { legacy_document_json: existing.document_json } : {}) } : {}),
      };
      let document: CanvasDocument;
      if (newDocument) {
        // Even after receipt expiry, retrying a create/duplicate cannot create a second document.
        const newId = `canvas-${createHash('sha256').update(`${user.id}\0${mutationId}`).digest('hex')}`;
        const prior = await db.canvasDocument.findUnique({ where: { id: newId }, select: canvasMetadataSelect });
        if (prior) {
          await assertDocument(user, prior, true);
          throw new CanvasDocumentError('此创建请求的回执已过期，请打开已创建的画布', 409, 'mutation_expired', {
            document: canvasMetadata(prior),
          });
        }
        document = await db.canvasDocument.create({ data: {
          ...data, id: newId, owner_user_id: user.id, project_id: projectId, document_json: JSON.stringify(snapshot),
          revision: 1, schema_version: 2, protocol_version: 2, access_scope: 'private', status: 'active',
        } });
      } else {
        // This predicate also fences a legacy write racing the first v2 save.
        const updated = await db.canvasDocument.updateMany({
          where: { id: existing.id, revision: existing.revision, protocol_version: existing.protocol_version },
          data: { ...data, revision: { increment: 1 } },
        });
        if (updated.count !== 1) conflict((await db.canvasDocument.findUnique({ where: { id: existing.id } })) ?? existing);
        document = (await db.canvasDocument.findUnique({ where: { id: existing.id } }))!;
      }
      if (document.protocol_version >= 2 && (newDocument || existing!.protocol_version < 2
        || document.title !== existing!.title
        || meaningfulContent(document.document_json) !== meaningfulContent(existing!.document_json))) {
        await saveHistory(db, document);
      }
      if (!v2) return { success: true, document: canvasDetail(document) };
      const response = { success: true, document: canvasMetadata(document), mutation_id: mutationId,
        mutation_expires_at: mutationExpiresAt, replayed: false };
      await db.canvasDocumentMutation.create({ data: {
        actor_user_id: user.id, mutation_id: mutationId, request_hash: requestHash,
        document_id: document.id, response_json: JSON.stringify(response),
      } });
      return response;
    }, { timeout: 15000 });
  } catch (error) {
    // Another request may have committed the same mutation while this transaction waited.
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034', 'P1008', 'P2028'].includes(error.code)) {
      const repeated = await replay(prisma);
      if (repeated) return repeated;
      throw new CanvasDocumentError('保存遇到并发操作，请保留原 mutation_id 重试', 409, 'write_conflict');
    }
    throw error;
  }
}
