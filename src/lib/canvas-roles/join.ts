import { randomUUID } from 'crypto';
import type { SessionUser } from '@/lib/auth/session';
import { canvasMetadata, parseCanvasSnapshot, saveCanvasHistory } from '@/lib/canvas-documents';
import { ownedDefinition, roleDocument } from './permissions';
import { roleMutation } from './repository';
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
    const nodeId = `node-role-${digest([user.id, body.mutation_id])}`;
    const position = record(body.position) ? body.position : { x: 100, y: 100 };
    if (typeof position.x !== 'number' || typeof position.y !== 'number' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new RoleError('加入位置无效');
    const snapshot = JSON.parse(version.snapshot_json);
    const node = { id: nodeId, type: 'role', x: position.x, y: position.y,
      data: { title: snapshot.name, roleConfig: { definitionId: definition.id, version: version.version, snapshot } } };
    graph.canvas.nodes.push(node);
    if (record(body.pending_connection)) {
      const priorId = identifier(body.pending_connection.nodeId);
      const prior = graph.canvas.nodes.find(n => n.id === priorId && n.id !== nodeId);
      if (!prior || prior.type.startsWith('flow-')) throw new RoleError('原连线节点已失效或不支持角色');
      const incoming = body.pending_connection.role === 'input';
      graph.canvas.connections.push(incoming ? { from: nodeId, to: priorId } : { from: priorId, to: nodeId });
    }
    graph.canvas.selectedNodeId = nodeId;
    graph.schemaVersion = 3; graph.requiredCapabilities = ['role.v1'];
    const raw = JSON.stringify(parseCanvasSnapshot(JSON.stringify(graph), document.project_id, true));
    const updated = await db.canvasDocument.updateMany({ where: { id: documentId, revision: document.revision, status: 'active' },
      data: { document_json: raw, schema_version: 3, protocol_version: 2, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new RoleError('画布已更新，请保留加入请求', 409, 'revision_conflict');
    const result = (await db.canvasDocument.findUnique({ where: { id: documentId } }))!;
    await saveCanvasHistory(db, result);
    return { objectId: documentId, result: { nodeId, node, documentId, document: canvasMetadata(result), join_receipt_id: randomUUID() } };
  });
}
