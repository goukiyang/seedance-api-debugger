import { createHash } from 'crypto';
import { AuthError } from '@/lib/auth/session';
import { isStudioTextModel } from '@/lib/template-studio/text-models';

export const ROLE_CAPABILITY = 'role.v1';
export const ROLE_PAGE_SIZE = 30;
export type JsonRecord = Record<string, unknown>;
export type RoleExecutor = { kind: 'person' | 'ai' | 'unassigned'; userId?: string; model?: string };
export type RoleSnapshot = {
  schema: 'role.v1'; name: string; responsibilities: string; delivery: string;
  criteria: string; boundary: string; executor: RoleExecutor;
  tools: ('manual' | 'text')[]; requiredItems: string[];
};
export type RoleNodeConfig = { definitionId: string; version: number; snapshot?: RoleSnapshot };
export type WorkPhase = 'offered' | 'needs_material' | 'rejected' | 'ready' | 'working'
  | 'review' | 'confirmation' | 'revision' | 'delivered' | 'failed' | 'unknown' | 'superseded';
export type RoleParticipant = {
  nodeId: string; participation: 'required' | 'optional' | 'excluded';
  reviewerNodeId: string | null; confirmRequired: boolean;
  ownerMaySubmit: boolean; ownerMayReview: boolean;
  dependencies: { nodeId: string; required: boolean }[];
};
export type TaskRequirements = {
  goal: string; criteria: string; participants: RoleParticipant[];
  finalNodeId: string; endpoint: 'owner_result'; decisionOwnerId: string;
  materialNodes: string[];
  materials?: JsonRecord[];
};
export class RoleError extends AuthError {
  constructor(message: string, status = 400, public readonly code = 'invalid_role', public readonly details: JsonRecord = {}) {
    super(message, status);
  }
}
export function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new RoleError('引用编号无效');
  return value;
}
export function integer(value: unknown, min = 1, max = 1_000_000): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new RoleError('版本或限制数值无效');
  return Number(value);
}
export function pointCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new RoleError('点数限额最多保留两位小数');
  return Math.round(value * 100);
}
// SQLite Int columns retain exact hundredths; API/UI values are ordinary points.
export function roleRunView<T extends { budget_points_limit: number | null; reserved_points: number; settled_points: number }>(run: T) {
  return { ...run, budget_points_limit: run.budget_points_limit == null ? null : run.budget_points_limit / 100,
    reserved_points: run.reserved_points / 100, settled_points: run.settled_points / 100 };
}
export function text(value: unknown, max: number, required = false): string {
  if (value !== undefined && typeof value !== 'string') throw new RoleError('内容必须是文字');
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max || (required && !result)) throw new RoleError(required ? '请填写完整内容，并检查字数限制' : '内容过长');
  return result;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function roleSnapshot(raw: unknown, ownerId: string): RoleSnapshot {
  if (!record(raw) || !record(raw.executor)) throw new RoleError('角色配置不完整');
  const kind = raw.executor.kind;
  if (!['person', 'ai', 'unassigned'].includes(String(kind))) throw new RoleError('执行者类型无效');
  const executor: RoleExecutor = { kind: kind as RoleExecutor['kind'] };
  if (kind === 'person') {
    executor.userId = identifier(raw.executor.userId);
    if (executor.userId !== ownerId) throw new RoleError('同事任务可见范围尚未确认，目前只能指定本人', 409, 'cross_person_pending');
  }
  if (kind === 'ai') {
    const model = text(raw.executor.model, 120, true);
    if (!isStudioTextModel(model)) throw new RoleError('所选文字模型不可用');
    executor.model = model;
  }
  const tools = raw.tools === undefined ? [] : raw.tools;
  if (!Array.isArray(tools) || tools.some(item => !['manual', 'text'].includes(item)) || tools.length > 2) {
    throw new RoleError('当前仅适配人工提交与文字能力，未接通工具不能用于执行');
  }
  const requiredItems = raw.requiredItems === undefined ? [] : raw.requiredItems;
  if (!Array.isArray(requiredItems) || requiredItems.length > 30) throw new RoleError('必交项最多30项');
  const itemNames = requiredItems.map(item => text(item, 160, true));
  if (new Set(itemNames).size !== itemNames.length) throw new RoleError('必交项名称不能重复');
  return {
    schema: ROLE_CAPABILITY, name: text(raw.name, 80, true),
    responsibilities: text(raw.responsibilities, 12000, true), delivery: text(raw.delivery, 12000, true),
    criteria: text(raw.criteria, 8000), boundary: text(raw.boundary, 8000), executor,
    tools: Array.from(new Set(tools)) as RoleSnapshot['tools'],
    requiredItems: itemNames,
  };
}

export function requirements(raw: unknown, ownerId: string, nodeIds: Set<string>): TaskRequirements {
  if (!record(raw) || !Array.isArray(raw.participants) || raw.participants.length < 1 || raw.participants.length > 100) {
    throw new RoleError('请配置本次参与角色');
  }
  const seen = new Set<string>();
  const participants = raw.participants.map(item => {
    if (!record(item)) throw new RoleError('分工配置无效');
    const nodeId = identifier(item.nodeId);
    if (!nodeIds.has(nodeId) || seen.has(nodeId)) throw new RoleError('参与角色不存在或重复');
    seen.add(nodeId);
    if (!['required', 'optional', 'excluded'].includes(String(item.participation))) throw new RoleError('请区分必交、可选和不参与');
    if ([item.confirmRequired, item.ownerMaySubmit, item.ownerMayReview].some(value => typeof value !== 'boolean')) {
      throw new RoleError('请明确本人确认和代提交、代检查规则');
    }
    const reviewerNodeId = item.reviewerNodeId == null ? null : identifier(item.reviewerNodeId);
    if (reviewerNodeId === nodeId) throw new RoleError('执行和检查须由不同角色负责');
    if (!Array.isArray(item.dependencies) || item.dependencies.length > 100) throw new RoleError('材料依赖配置无效');
    const dependencies = item.dependencies.map(dep => {
      if (!record(dep) || typeof dep.required !== 'boolean') throw new RoleError('材料依赖配置无效');
      return { nodeId: identifier(dep.nodeId), required: dep.required };
    });
    if (new Set(dependencies.map(dep => dep.nodeId)).size !== dependencies.length) throw new RoleError('材料依赖重复');
    return { nodeId, participation: item.participation as RoleParticipant['participation'], reviewerNodeId,
      confirmRequired: item.confirmRequired === true, ownerMaySubmit: item.ownerMaySubmit as boolean,
      ownerMayReview: item.ownerMayReview as boolean, dependencies };
  });
  const active = new Set(participants.filter(item => item.participation !== 'excluded').map(item => item.nodeId));
  for (const p of participants) {
    if (p.reviewerNodeId && !active.has(p.reviewerNodeId)) throw new RoleError('检查角色必须参与本次任务');
    for (const dep of p.dependencies) if (!active.has(dep.nodeId) || dep.nodeId === p.nodeId) throw new RoleError('材料依赖不能自连或引用不参与角色');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(node: string) {
    if (visiting.has(node)) throw new RoleError('材料流向存在互等，请调整依赖；交流与检查关系不受此限制');
    if (visited.has(node)) return;
    visiting.add(node);
    participants.find(p => p.nodeId === node)!.dependencies.forEach(dep => visit(dep.nodeId));
    visiting.delete(node); visited.add(node);
  }
  participants.forEach(p => visit(p.nodeId));
  const finalNodeId = identifier(raw.finalNodeId);
  if (!active.has(finalNodeId)) throw new RoleError('请指定参与本次工作的最终交付角色');
  if (raw.endpoint !== 'owner_result' || raw.decisionOwnerId !== ownerId) throw new RoleError('本次只交付给本人，不新增外发或他人决策权限');
  if (!Array.isArray(raw.materialNodes) || raw.materialNodes.length > 100) throw new RoleError('输入材料配置无效');
  return { goal: text(raw.goal, 12000, true), criteria: text(raw.criteria, 8000), participants,
    finalNodeId, endpoint: 'owner_result', decisionOwnerId: ownerId,
    materialNodes: Array.from(new Set(raw.materialNodes.map(identifier))) };
}
