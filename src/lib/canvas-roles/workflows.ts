import { randomUUID } from 'crypto';
import type { SessionUser } from '@/lib/auth/session';
import { canvasMetadata, parseCanvasSnapshot, saveCanvasHistory } from '@/lib/canvas-documents';
import { roleMutation } from './repository';
import { assertRoleCollaborationWritable, roleDocument } from './permissions';
import { COLLABORATION_CAPABILITY, digest, identifier, integer, record, roleSnapshot, RoleError, text, type JsonRecord, type RoleRelation } from './types';
import { workflowSnapshots, type RoleWorkflow } from './workflow-schema';
import { directorRoles } from './director-template';

const dependencies: Record<string, string[]> = { pm: [], dd: ['pm'], sy: ['dd'], wz: ['dd'],
  art: ['sy'], by: ['wz'], fx: ['sy', 'wz', 'art'], cj: ['sy', 'wz', 'art', 'by', 'fx'], sc: ['dd', 'cj'] };

export async function createRoleWorkflow(user: SessionUser, body: JsonRecord) {
  const documentId = identifier(body.document_id);
  if (!['director-group.v1', 'director-group.v2', 'blank.v1', 'blank.v2'].includes(String(body.template))) throw new RoleError('工作流模板不可用');
  return roleMutation(user, body, 'role_workflow_create', () => roleDocument(user, documentId, true), async db => {
    assertRoleCollaborationWritable();
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
    const roles = String(body.template).startsWith('director-group.') ? directorRoles : [];
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
    const relations: RoleRelation[] = [];
    const relation = (type: RoleRelation['type'], from: string, to: string, authority: RoleRelation['authority'] = 'suggestion') => {
      relations.push({ id: 'relation-' + randomUUID(), type, from, to, required: type === 'handoff', items: [], stage: 'effective', authority });
    };
    for (const entry of roles) {
      if (entry.key === 'pm') relation('accepts_requirement', 'requirement', nodeMap.pm);
      else relation('guidance', nodeMap.pm, nodeMap[entry.key]);
      for (const dep of dependencies[entry.key] || []) relation('handoff', nodeMap[dep], nodeMap[entry.key]);
      if (!['pm', 'dd'].includes(entry.key)) relation('review', nodeMap[entry.key], nodeMap[['cj', 'sc'].includes(entry.key) ? 'dd' : 'cj'], 'approve');
    }
    const flow: RoleWorkflow = { id: workflowId, name: text(body.name, 80, true), template: roles.length ? 'director-group.v2' : 'blank.v2',
      nodeIds: addedNodes.map(n => n.id), finalNodeId: nodeMap.sc || '', coordinatorNodeId: nodeMap.pm || '',
      relations,
      guidance: roles.filter(r => r.key !== 'pm').map(r => ({ from: nodeMap.pm, to: nodeMap[r.key] })),
      participants: roles.map(r => ({ nodeId: nodeMap[r.key], participation: 'required',
        reviewerNodeId: null, assignment: r.snapshot.responsibilities, deliverableItems: r.snapshot.requiredItems,
        requiredInputs: (dependencies[r.key] || []).map(key => directorRoles.find(entry => entry.key === key)!.snapshot.name + '的有效稿'),
        acceptanceCriteria: r.snapshot.criteria,
        confirmRequired: ['dd', 'sc'].includes(r.key), ownerMaySubmit: false, ownerMayReview: false,
        dependencies: (dependencies[r.key] || []).map(key => ({ nodeId: nodeMap[key], required: true })) })) };
    graph.canvas.roleWorkflows = [...flows, flow]; graph.schemaVersion = 5;
    graph.requiredCapabilities = Array.from(new Set([...(Array.isArray(graph.requiredCapabilities) ? graph.requiredCapabilities : []), 'role.v1', 'role.workflow.v1', COLLABORATION_CAPABILITY]));
    const connections: { from: string; to: string }[] = [];
    graph.canvas.selectedNodeId = nodeMap.pm || graph.canvas.selectedNodeId;
    const raw = JSON.stringify(parseCanvasSnapshot(JSON.stringify(graph), document.project_id, true));
    const changed = await db.canvasDocument.updateMany({ where: { id: documentId, revision: document.revision, status: 'active', owner_user_id: user.id },
      data: { document_json: raw, schema_version: 5, protocol_version: 2, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new RoleError('画布已变化，原模板请求未重复创建', 409, 'revision_conflict');
    const updated = await db.canvasDocument.findUniqueOrThrow({ where: { id: documentId } });
    await saveCanvasHistory(db, updated);
    return { objectId: documentId, result: { workflowId, documentId, document: canvasMetadata(updated),
      workflow: flow, nodes: addedNodes, connections, receipt_id: randomUUID(), created_task: false, executed: false } };
  });
}
