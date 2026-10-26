import { randomUUID } from 'crypto';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canvasMetadata, parseCanvasSnapshot, saveCanvasHistory } from '@/lib/canvas-documents';
import { assertCurrentRoleUser, assertRoleCollaborationWritable, ownedDefinition, roleDocument, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { workflowSnapshots, remapWorkflows, type RoleWorkflow } from './workflow-schema';
import { COLLABORATION_CAPABILITY, digest, identifier, integer, record, ROLE_PAGE_SIZE, RoleError, roleSnapshot, text, type JsonRecord } from './types';

export async function ownedRoleTemplate(db: RoleDb, user: SessionUser, templateId: string) {
  await assertCurrentRoleUser(db, user);
  const template = await db.canvasRoleWorkflowTemplate.findFirst({ where: { id: identifier(templateId), owner_user_id: user.id } });
  if (!template) throw new RoleError('模板不存在或不可访问', 404, 'template_not_found');
  return template;
}

async function templateSnapshot(db: RoleDb, user: SessionUser, body: JsonRecord) {
  const document = await roleDocument(user, identifier(body.document_id));
  const graph = parseCanvasSnapshot(document.document_json, document.project_id, true);
  const workflow = workflowSnapshots(graph.canvas.roleWorkflows).find(flow => flow.id === identifier(body.workflow_id));
  if (!workflow) throw new RoleError('工作流不存在', 404, 'workflow_not_found');
  const roles = [];
  for (const nodeId of workflow.nodeIds) {
    const node = graph.canvas.nodes.find(item => item.id === nodeId && item.type === 'role');
    const config = node?.data?.roleConfig;
    if (!node || !record(config)) throw new RoleError('岗位配置缺失，请先保存画布', 409, 'role_node_unsaved');
    const definition = await ownedDefinition(db, user, identifier(config.definitionId));
    const version = await db.canvasRoleVersion.findUnique({ where: { definition_id_version: {
      definition_id: definition.id, version: integer(config.version) } } });
    if (!version) throw new RoleError('岗位固定版本已不可用', 409, 'role_version_unavailable');
    roles.push({ nodeId, definitionId: definition.id, version: version.version, x: node.x, y: node.y });
  }
  const minX = roles.length ? Math.min(...roles.map(role => role.x)) : 0;
  const minY = roles.length ? Math.min(...roles.map(role => role.y)) : 0;
  // Store only configuration references. No canvas node payload, run, receipt or media survives this boundary.
  return { schema: 'role.workflow-template.v2', workflow,
    roles: roles.map(role => ({ ...role, x: role.x - minX, y: role.y - minY })), materialSlots: [] };
}

export async function listRoleTemplates(user: SessionUser, params: URLSearchParams) {
  await assertCurrentRoleUser(prisma, user);
  const status = params.get('status') || 'active', q = text(params.get('q') || '', 120);
  if (!['active', 'archived'].includes(status)) throw new RoleError('模板筛选无效');
  const scope = digest([user.id, status, q]);
  let after: { id: string; at: Date } | null = null;
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (value.scope !== scope || !Number.isFinite(Date.parse(value.at))) throw new Error();
      after = { id: identifier(value.id), at: new Date(value.at) };
    } catch { throw new RoleError('模板分页位置失效，请重新读取'); }
  }
  const rows = await prisma.canvasRoleWorkflowTemplate.findMany({ where: { owner_user_id: user.id, status,
    ...(q ? { name: { contains: q } } : {}), ...(after ? { OR: [{ updated_at: { lt: after.at } }, { updated_at: after.at, id: { lt: after.id } }] } : {}) },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: ROLE_PAGE_SIZE + 1 });
  const templates = rows.slice(0, ROLE_PAGE_SIZE), last = templates[templates.length - 1];
  return { templates, next_cursor: rows.length > ROLE_PAGE_SIZE && last
    ? Buffer.from(JSON.stringify({ scope, id: last.id, at: last.updated_at.toISOString() })).toString('base64url') : null };
}

export async function readRoleTemplate(user: SessionUser, templateId: string, version?: number) {
  const template = await ownedRoleTemplate(prisma, user, templateId);
  const entry = await prisma.canvasRoleWorkflowTemplateVersion.findUnique({ where: { template_id_version: {
    template_id: template.id, version: version === undefined ? template.current_version : integer(version) } } });
  if (!entry) throw new RoleError('模板版本不存在', 404, 'template_version_not_found');
  return { template, version: { id: entry.id, version: entry.version, schema: entry.schema,
    content_digest: entry.content_digest, snapshot: JSON.parse(entry.snapshot_json), provenance: JSON.parse(entry.provenance_json), created_at: entry.created_at } };
}

export async function saveRoleTemplate(user: SessionUser, body: JsonRecord) {
  if (body.action === 'use') return instantiateRoleTemplate(user, body);
  if (body.action !== 'save') throw new RoleError('模板操作无效');
  return roleMutation(user, body, 'role_template_save', () => roleDocument(user, identifier(body.document_id)), async db => {
    assertRoleCollaborationWritable();
    const snapshot = await templateSnapshot(db, user, body), id = 'template-' + digest([user.id, body.mutation_id]);
    const template = await db.canvasRoleWorkflowTemplate.create({ data: { id, owner_user_id: user.id, name: text(body.name, 80, true) } });
    const version = await db.canvasRoleWorkflowTemplateVersion.create({ data: { id: randomUUID(), template_id: id, version: 1,
      snapshot_json: JSON.stringify(snapshot), content_digest: digest(snapshot),
      provenance_json: JSON.stringify({ kind: 'user_configuration', materialValuesRemoved: true, executionRemoved: true }) } });
    return { objectId: id, result: { template, version: { id: version.id, version: 1, content_digest: version.content_digest }, executed: false } };
  });
}

export async function updateRoleTemplate(user: SessionUser, templateId: string, body: JsonRecord) {
  return roleMutation(user, body, `role_template_update:${identifier(templateId)}`, db => ownedRoleTemplate(db, user, templateId), async db => {
    assertRoleCollaborationWritable();
    const template = await ownedRoleTemplate(db, user, templateId);
    if (integer(body.base_revision) !== template.revision) throw new RoleError('模板已更新，请读取当前版本', 409, 'revision_conflict');
    if (!['save_version', 'archive'].includes(String(body.action))) throw new RoleError('模板操作无效');
    if (body.action === 'save_version') {
      if (template.status !== 'active') throw new RoleError('归档模板不能保存新版本', 409, 'template_archived');
      const snapshot = await templateSnapshot(db, user, body);
      await db.canvasRoleWorkflowTemplateVersion.create({ data: { id: randomUUID(), template_id: template.id,
        version: template.current_version + 1, snapshot_json: JSON.stringify(snapshot), content_digest: digest(snapshot),
        provenance_json: JSON.stringify({ kind: 'user_configuration', previousVersion: template.current_version, executionRemoved: true }) } });
    }
    const updated = await db.canvasRoleWorkflowTemplate.update({ where: { id: template.id }, data: { revision: { increment: 1 },
      ...(body.action === 'archive' ? { status: 'archived' } : { name: text(body.name ?? template.name, 80, true), current_version: { increment: 1 } }) } });
    return { objectId: template.id, result: { template: updated, existingInstancesUnchanged: true } };
  });
}

export async function instantiateRoleTemplate(user: SessionUser, body: JsonRecord) {
  const templateId = identifier(body.template_id), documentId = identifier(body.document_id);
  const authorize = async (db: RoleDb) => { await ownedRoleTemplate(db, user, templateId); await roleDocument(user, documentId, true); };
  return roleMutation(user, body, `role_template_use:${templateId}`, authorize, async db => {
    assertRoleCollaborationWritable();
    await authorize(db);
    const template = await ownedRoleTemplate(db, user, templateId);
    if (template.status !== 'active') throw new RoleError('模板已归档，不能创建新实例', 409, 'template_archived');
    const version = await db.canvasRoleWorkflowTemplateVersion.findUnique({ where: { template_id_version: {
      template_id: template.id, version: integer(body.version) } } });
    if (!version) throw new RoleError('模板版本不存在', 404, 'template_version_not_found');
    const document = await db.canvasDocument.findUniqueOrThrow({ where: { id: documentId } });
    if (integer(body.document_revision, 0) !== document.revision) throw new RoleError('画布已更新，请重读后再使用模板', 409, 'revision_conflict');
    const snapshot = JSON.parse(version.snapshot_json);
    if (snapshot.schema !== 'role.workflow-template.v2' || digest(snapshot) !== version.content_digest || !Array.isArray(snapshot.roles)) throw new RoleError('模板记录无法核对', 409, 'template_integrity');
    const graph = parseCanvasSnapshot(document.document_json, document.project_id, true), flows = workflowSnapshots(graph.canvas.roleWorkflows);
    if (flows.length >= 50) throw new RoleError('当前画布工作流已达上限');
    const source = workflowSnapshots([snapshot.workflow])[0];
    const remap = new Map<string, string>(), nodes = [];
    const x = record(body.position) && typeof body.position.x === 'number' && Number.isFinite(body.position.x) ? body.position.x : 100;
    const y = record(body.position) && typeof body.position.y === 'number' && Number.isFinite(body.position.y) ? body.position.y : 100;
    for (const entry of snapshot.roles) {
      const definition = await ownedDefinition(db, user, identifier(entry.definitionId), true);
      const roleVersion = await db.canvasRoleVersion.findUnique({ where: { definition_id_version: {
        definition_id: definition.id, version: integer(entry.version) } } });
      if (!roleVersion) throw new RoleError('模板岗位版本不可用', 409, 'role_version_unavailable');
      const role = roleSnapshot(JSON.parse(roleVersion.snapshot_json), user.id);
      const id = 'node-' + digest([document.id, body.mutation_id, identifier(entry.nodeId)]);
      remap.set(entry.nodeId, id);
      nodes.push({ id, type: 'role', x: x + Number(entry.x || 0), y: y + Number(entry.y || 0),
        data: { title: role.name, roleConfig: { definitionId: definition.id, version: roleVersion.version, snapshot: role } } });
    }
    if (source.nodeIds.some(id => !remap.has(id)) || nodes.length !== source.nodeIds.length) throw new RoleError('模板岗位关系不完整', 409, 'template_integrity');
    const workflow: RoleWorkflow = remapWorkflows([source], remap)[0];
    workflow.name = template.name;
    workflow.template = 'saved.v2';
    workflow.sourceTemplate = { id: template.id, version: version.version };
    if (!workflow.relations) {
      workflow.relations = [
        ...workflow.participants.flatMap(p => p.dependencies.map(dep => ({ id: 'relation-' + randomUUID(), type: 'handoff' as const,
          from: dep.nodeId, to: p.nodeId, required: dep.required, items: [], stage: 'effective' as const, authority: 'suggestion' as const }))),
        ...workflow.guidance.map(edge => ({ ...edge, id: 'relation-' + randomUUID(), type: 'guidance' as const,
          required: false, items: [], stage: 'effective' as const, authority: 'suggestion' as const })),
        ...workflow.participants.filter(p => p.reviewerNodeId).map(p => ({ id: 'relation-' + randomUUID(), type: 'review' as const,
          from: p.nodeId, to: p.reviewerNodeId!, required: false, items: [], stage: 'effective' as const, authority: 'suggestion' as const })),
      ];
      workflow.participants = workflow.participants.map(p => ({ ...p, reviewerNodeId: null }));
    }
    graph.canvas.nodes.push(...nodes); graph.canvas.roleWorkflows = [...flows, workflow];
    graph.schemaVersion = 5;
    graph.requiredCapabilities = Array.from(new Set([...(Array.isArray(graph.requiredCapabilities) ? graph.requiredCapabilities : []), 'role.v1', 'role.workflow.v1', COLLABORATION_CAPABILITY]));
    const raw = JSON.stringify(parseCanvasSnapshot(JSON.stringify(graph), document.project_id, true));
    const changed = await db.canvasDocument.updateMany({ where: { id: document.id, revision: document.revision, status: 'active', owner_user_id: user.id },
      data: { document_json: raw, schema_version: 5, protocol_version: 2, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new RoleError('画布已更新，原模板未重复使用', 409, 'revision_conflict');
    const updated = await db.canvasDocument.findUniqueOrThrow({ where: { id: document.id } });
    await saveCanvasHistory(db, updated);
    return { objectId: document.id, result: { documentId: document.id, document: canvasMetadata(updated), workflowId: workflow.id,
      workflow, nodes, connections: [], templateId: template.id, templateVersion: version.version, created_task: false, executed: false } };
  });
}
