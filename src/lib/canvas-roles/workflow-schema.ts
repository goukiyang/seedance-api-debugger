import { randomUUID } from 'crypto';
import { identifier, record, requirements, text, RoleError, type RoleParticipant } from './types';

export const WORKFLOW_CAPABILITY = 'role.workflow.v1';
export type RoleWorkflow = { id: string; name: string; template: string; nodeIds: string[];
  participants: RoleParticipant[]; finalNodeId: string; coordinatorNodeId: string; guidance: { from: string; to: string }[] };

export function workflowSnapshots(value: unknown): RoleWorkflow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new RoleError('角色工作流最多50个');
  const seen = new Set<string>(), members = new Set<string>();
  return value.map(raw => {
    if (!record(raw) || !Array.isArray(raw.nodeIds) || raw.nodeIds.length > 100) throw new RoleError('工作流岗位配置无效');
    const id = identifier(raw.id), nodeIds = raw.nodeIds.map(identifier);
    if (seen.has(id) || new Set(nodeIds).size !== nodeIds.length || nodeIds.some(node => members.has(node))) throw new RoleError('工作流或岗位归属重复');
    seen.add(id); nodeIds.forEach(node => members.add(node));
    if (!nodeIds.length) return { id, name: text(raw.name, 80, true), template: text(raw.template, 80), nodeIds,
      participants: [], finalNodeId: '', coordinatorNodeId: '', guidance: [] };
    const req = requirements({ goal: '工作流关系配置', criteria: '', participants: raw.participants,
      finalNodeId: raw.finalNodeId, endpoint: 'owner_result', decisionOwnerId: 'configuration', materialNodes: [] }, 'configuration', new Set(nodeIds));
    const coordinatorNodeId = identifier(raw.coordinatorNodeId);
    if (!nodeIds.includes(coordinatorNodeId) || !Array.isArray(raw.guidance) || raw.guidance.length > 100) throw new RoleError('协调或指导关系无效');
    const guidance = raw.guidance.map(edge => {
      if (!record(edge)) throw new RoleError('指导关系无效');
      const from = identifier(edge.from), to = identifier(edge.to);
      if (from === to || !nodeIds.includes(from) || !nodeIds.includes(to)) throw new RoleError('指导关系引用无效');
      return { from, to };
    });
    return { id, name: text(raw.name, 80, true), template: text(raw.template, 80), nodeIds,
      participants: req.participants, finalNodeId: req.finalNodeId, coordinatorNodeId, guidance };
  });
}

export function remapWorkflows(value: unknown, remap: Map<string, string>): RoleWorkflow[] {
  return workflowSnapshots(value).flatMap(flow => {
    const nodeIds = flow.nodeIds.filter(id => remap.has(id)).map(id => remap.get(id)!);
    if (!flow.nodeIds.length) return [{ ...flow, id: 'workflow-' + randomUUID() }];
    if (!nodeIds.length) return [];
    const participants = flow.participants.filter(p => remap.has(p.nodeId)).map(p => ({ ...p, nodeId: remap.get(p.nodeId)!,
      reviewerNodeId: p.reviewerNodeId ? remap.get(p.reviewerNodeId) || null : null,
      dependencies: p.dependencies.filter(d => remap.has(d.nodeId)).map(d => ({ ...d, nodeId: remap.get(d.nodeId)! })) }));
    const finalNodeId = remap.get(flow.finalNodeId) || nodeIds[0];
    const final = participants.find(p => p.nodeId === finalNodeId);
    if (final) final.participation = 'required';
    return [{ ...flow, id: 'workflow-' + nodeIds[0], nodeIds, participants,
      finalNodeId, coordinatorNodeId: remap.get(flow.coordinatorNodeId) || nodeIds[0],
      guidance: flow.guidance.filter(e => remap.has(e.from) && remap.has(e.to)).map(e => ({ from: remap.get(e.from)!, to: remap.get(e.to)! })) }];
  });
}
