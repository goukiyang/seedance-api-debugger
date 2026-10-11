import { randomUUID } from 'crypto';
import type { SessionUser } from '@/lib/auth/session';
import { canvasMetadata, parseCanvasSnapshot, saveCanvasHistory } from '@/lib/canvas-documents';
import { roleMutation } from './repository';
import { roleDocument } from './permissions';
import { digest, identifier, integer, record, roleSnapshot, RoleError, text, type JsonRecord } from './types';
import { workflowSnapshots, type RoleWorkflow } from './workflow-schema';
import { directorRoles } from './director-template';

const dependencies: Record<string, string[]> = { pm: [], dd: ['pm'], sy: ['dd'], wz: ['dd'],
  art: ['sy'], by: ['wz'], fx: ['sy', 'wz', 'art'], cj: ['sy', 'wz', 'art', 'by', 'fx'], sc: ['dd', 'cj'] };

export async function createRoleWorkflow(user: SessionUser, body: JsonRecord) {
  const documentId = identifier(body.document_id);
  if (!['director-group.v1', 'blank.v1'].includes(String(body.template))) throw new RoleError('工作流模板不可用');
  return roleMutation(user, body, 'role_workflow_create', () => roleDocument(user, documentId, true), async db => {
    await roleDocument(user, documentId, true);
    const document = await db.canvasDocument.findUniqueOrThrow({ where: { id: documentId } });
    if (document.owner_user_id !== user.id || document.status !== 'active' || integer(body.document_revision, 0) !== document.revision) {
      throw new RoleError('画布已更新，请重读后再使用模板', 409, 'revision_conflict');
    }
    const graph = parseCanvasSnapshot(document.document_json, document.project_id, true);
    const flows = workflowSnapshots(graph.canvas.roleWorkflows);
    if (flows.length >= 50) throw new RoleError('当前画布工作流已达上限，请拆分画布');
    const workflowId = 'workflow-' + digest([user.id, body.mutation_id]);
    const nodeMap: Record<string, string> = {}, addedNodes = [];
    const x = record(body.position) && typeof body.position.x === 'number' && Number.isFinite(body.position.x) ? body.position.x : 100;
    const y = record(body.position) && typeof body.position.y === 'number' && Number.isFinite(body.position.y) ? body.position.y : 100;
    const roles = body.template === 'director-group.v1' ? directorRoles : [];
    for (let i = 0; i < roles.length; i++) {
      const entry = roles[i];
      const snapshot = roleSnapshot(entry.snapshot, user.id);
      const definitionId = 'role-' + digest([user.id, body.mutation_id, entry.key]);
      await db.canvasRoleDefinition.create({ data: { id: definitionId, owner_user_id: user.id, name: snapshot.name } });
      await db.canvasRoleVersion.create({ data: { id: definitionId + '-v1', definition_id: definitionId, version: 1, snapshot_json: JSON.stringify(snapshot) } });
      const nodeId = 'node-' + digest([workflowId, entry.key]); nodeMap[entry.key] = nodeId;
      const node = { id: nodeId, type: 'role', x: x + (i % 3) * 390, y: y + Math.floor(i / 3) * 500,
        data: { title: snapshot.name, roleConfig: { definitionId, version: 1, snapshot } } };
      addedNodes.push(node); graph.canvas.nodes.push(node);
    }
    const flow: RoleWorkflow = { id: workflowId, name: text(body.name, 80, true), template: String(body.template),
      nodeIds: addedNodes.map(n => n.id), finalNodeId: nodeMap.sc || '', coordinatorNodeId: nodeMap.pm || '',
      guidance: roles.filter(r => r.key !== 'pm').map(r => ({ from: nodeMap.pm, to: nodeMap[r.key] })),
      participants: roles.map(r => ({ nodeId: nodeMap[r.key], participation: 'required',
        reviewerNodeId: ['pm', 'dd'].includes(r.key) ? null : ['cj', 'sc'].includes(r.key) ? nodeMap.dd : nodeMap.cj,
        confirmRequired: ['dd', 'sc'].includes(r.key), ownerMaySubmit: false, ownerMayReview: false,
        dependencies: (dependencies[r.key] || []).map(key => ({ nodeId: nodeMap[key], required: true })) })) };
    graph.canvas.roleWorkflows = [...flows, flow]; graph.schemaVersion = 4;
    const connections = flow.participants.flatMap(p => p.dependencies.map(d => ({ from: d.nodeId, to: p.nodeId })));
    graph.canvas.connections.push(...connections);
    graph.canvas.selectedNodeId = nodeMap.pm || graph.canvas.selectedNodeId;
    const raw = JSON.stringify(parseCanvasSnapshot(JSON.stringify(graph), document.project_id, true));
    const changed = await db.canvasDocument.updateMany({ where: { id: documentId, revision: document.revision, status: 'active', owner_user_id: user.id },
      data: { document_json: raw, schema_version: 4, protocol_version: 2, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new RoleError('画布已变化，原模板请求未重复创建', 409, 'revision_conflict');
    const updated = await db.canvasDocument.findUniqueOrThrow({ where: { id: documentId } });
    await saveCanvasHistory(db, updated);
    return { objectId: documentId, result: { workflowId, documentId, document: canvasMetadata(updated),
      workflow: flow, nodes: addedNodes, connections, receipt_id: randomUUID(), created_task: false, executed: false } };
  });
}
