import { randomUUID } from 'crypto';
import type { SessionUser } from '@/lib/auth/session';
import { canvasMetadata, parseCanvasSnapshot, saveCanvasHistory } from '@/lib/canvas-documents';
import { ownedDefinition, roleDocument } from './permissions';
import { roleMutation } from './repository';
import { workflowSnapshots } from './workflow-schema';
import { digest, identifier, integer, record, RoleError, type JsonRecord } from './types';

export async function joinRole(user: SessionUser, body: JsonRecord) {
  const documentId = identifier(body.document_id);
  return roleMutation(user, body, 'role_join', async () => roleDocument(user, documentId, true), async db => {
    await roleDocument(user, documentId, true);
    const document = await db.canvasDocument.findUnique({ where: { id: documentId } });
    if (!document || document.status !== 'active' || document.owner_user_id !== user.id) throw new RoleError('画布不可编辑', 403);
    if (integer(body.document_revision, 0) !== document.revision) throw new RoleError('画布已更新，请重读后保留原请求编号重试', 409, 'revision_conflict');
    const definition = await ownedDefinition(db, user, identifier(body.definition_id), true);
    const version = await db.canvasRoleVersion.findUnique({ where: {
      definition_id_version: { definition_id: definition.id, version: integer(body.version) },
    } });
    if (!version) throw new RoleError('角色版本不存在', 404);
    const graph = parseCanvasSnapshot(document.document_json, document.project_id, true);
    const flows = workflowSnapshots(graph.canvas.roleWorkflows);
    const workflow = typeof body.workflow_id === 'string' ? flows.find(flow => flow.id === body.workflow_id) : null;
    if (body.workflow_id && !workflow) throw new RoleError('所属工作流已失效，请重新选择', 409, 'workflow_unavailable');
    const snapshot = JSON.parse(version.snapshot_json);
    if ((document.schema_version >= 4 || snapshot.workflowOnly) && !workflow) throw new RoleError('请先选择所属角色工作流，原角色仍在库中', 409, 'workflow_required');
    const nodeId = `node-role-${digest([user.id, body.mutation_id])}`;
    const position = record(body.position) ? body.position : { x: 100, y: 100 };
    if (typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new RoleError('加入位置无效');
    const node = { id: nodeId, type: 'role', x: position.x, y: position.y,
      data: { title: snapshot.name, roleConfig: { definitionId: definition.id, version: version.version, snapshot } } };
    graph.canvas.nodes.push(node);
    if (workflow) {
      workflow.nodeIds.push(nodeId);
      workflow.participants.push({ nodeId, participation: workflow.participants.length ? 'excluded' : 'required',
        reviewerNodeId: null, confirmRequired: true, ownerMaySubmit: false, ownerMayReview: false, dependencies: [] });
      if (!workflow.finalNodeId) workflow.finalNodeId = nodeId;
      if (!workflow.coordinatorNodeId) workflow.coordinatorNodeId = nodeId;
      graph.canvas.roleWorkflows = flows;
    }
    if (record(body.pending_connection)) {
      const priorId = identifier(body.pending_connection.nodeId);
      const prior = graph.canvas.nodes.find(n => n.id === priorId && n.id !== nodeId);
      if (!prior || prior.type.startsWith('flow-')) throw new RoleError('原连线节点已失效或不支持角色');
      const incoming = body.pending_connection.role === 'input';
      graph.canvas.connections.push(incoming ? { from: nodeId, to: priorId } : { from: priorId, to: nodeId });
    }
    graph.canvas.selectedNodeId = nodeId;
    graph.schemaVersion = document.schema_version >= 4 || workflow ? 4 : 3;
    graph.requiredCapabilities = graph.schemaVersion === 4 ? ['role.v1', 'role.workflow.v1'] : ['role.v1'];
    const raw = JSON.stringify(parseCanvasSnapshot(JSON.stringify(graph), document.project_id, true));
    const updated = await db.canvasDocument.updateMany({ where: { id: documentId, revision: document.revision, status: 'active' },
      data: { document_json: raw, schema_version: Number(graph.schemaVersion), protocol_version: 2, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new RoleError('画布已更新，请保留加入请求', 409, 'revision_conflict');
    const result = (await db.canvasDocument.findUnique({ where: { id: documentId } }))!;
    await saveCanvasHistory(db, result);
    return { objectId: documentId, result: { nodeId, node, documentId, document: canvasMetadata(result), roleWorkflows: flows, join_receipt_id: randomUUID() } };
  });
}
