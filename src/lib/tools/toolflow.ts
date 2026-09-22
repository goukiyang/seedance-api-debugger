import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { getProjectAccess } from '@/lib/projects/permissions';

export const TOOLFLOW_NODE_TYPES = new Set([
  'flow-input',
  'flow-template',
  'flow-select',
  'flow-confirm',
  'flow-output',
]);

export const TOOLFLOW_TERMINAL_NODE_STATUSES = new Set([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

export const TOOLFLOW_ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'waiting_selection',
  'waiting_confirmation',
  'paused',
]);

export type ToolFlowNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  data: Record<string, unknown>;
};

export type ToolFlowConnection = { from: string; to: string };

export type ToolFlowGraph = {
  version: number;
  nodes: ToolFlowNode[];
  connections: ToolFlowConnection[];
};

function clean(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseToolFlowGraph(value: unknown): ToolFlowGraph {
  const source = objectValue(value);
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const sourceConnections = Array.isArray(source.connections) ? source.connections : [];
  const normalizedNodes = sourceNodes.map((node) => {
    const item = objectValue(node);
    return {
      id: clean(item.id),
      type: clean(item.type),
      x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
      y: Number.isFinite(Number(item.y)) ? Number(item.y) : 0,
      data: objectValue(item.data),
    };
  }).filter((node) => node.id && TOOLFLOW_NODE_TYPES.has(node.type));
  const nodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedConnections = sourceConnections.map((connection) => {
    const item = objectValue(connection);
    return { from: clean(item.from), to: clean(item.to) };
  }).filter((connection) => (
    nodeIds.has(connection.from)
    && nodeIds.has(connection.to)
    && connection.from !== connection.to
  ));
  return {
    version: Number.isInteger(Number(source.version)) ? Number(source.version) : 1,
    nodes: normalizedNodes,
    connections: normalizedConnections,
  };
}

const ALLOWED_CONNECTIONS: Record<string, Set<string>> = {
  'flow-input': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-template': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-select': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-confirm': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-output': new Set(),
};

export function isToolFlowConnectionAllowed(fromType: string, toType: string) {
  return Boolean(ALLOWED_CONNECTIONS[fromType]?.has(toType));
}

export function validateToolFlowGraph(value: unknown) {
  const graph = parseToolFlowGraph(value);
  if (graph.nodes.length === 0) throw new AuthError('工具流至少需要一个节点', 400);
  if (graph.nodes.length > 60) throw new AuthError('工具流最多支持 60 个节点', 400);
  if (graph.connections.length > 180) throw new AuthError('工具流连线过多，请拆分流程', 400);
  if (!graph.nodes.some((node) => node.type === 'flow-input')) throw new AuthError('工具流需要输入节点', 400);
  if (!graph.nodes.some((node) => node.type === 'flow-output')) throw new AuthError('工具流需要输出节点', 400);
  if (new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length) {
    throw new AuthError('工具流节点编号重复，请重新添加节点', 400);
  }

  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  graph.nodes.forEach((node) => {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  });
  const seenEdges = new Set<string>();
  graph.connections.forEach(({ from, to }) => {
    const source = nodeMap.get(from);
    const target = nodeMap.get(to);
    if (!source || !target || !isToolFlowConnectionAllowed(source.type, target.type)) {
      throw new AuthError('工具流包含不兼容的连线', 400);
    }
    const edgeKey = `${from}->${to}`;
    if (seenEdges.has(edgeKey)) throw new AuthError('工具流不能重复连线', 400);
    seenEdges.add(edgeKey);
    incoming.get(to)!.push(from);
    outgoing.get(from)!.push(to);
  });

  graph.nodes.forEach((node) => {
    if (node.type === 'flow-input' && incoming.get(node.id)!.length) {
      throw new AuthError('输入节点不能接收上游连线', 400);
    }
    if (node.type === 'flow-output' && outgoing.get(node.id)!.length) {
      throw new AuthError('输出节点不能继续连线', 400);
    }
    if (node.type !== 'flow-input' && !incoming.get(node.id)!.length) {
      throw new AuthError('除输入节点外，每个节点都需要上游连线', 400);
    }
    if (node.type === 'flow-template') {
      const data = node.data || {};
      const hasAuthorizedBinding = Boolean(clean(data.template_id || data.templateId || data.module_id || data.moduleId));
      const hasPrompt = Boolean(clean(data.prompt));
      if (!hasAuthorizedBinding && !hasPrompt) throw new AuthError('图片模板节点需要选择模板或填写提示词', 400);
    }
  });

  const indegree = new Map(graph.nodes.map((node) => [node.id, incoming.get(node.id)!.length]));
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of outgoing.get(id) || []) {
      const nextDegree = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }
  if (visited !== graph.nodes.length) throw new AuthError('工具流不能包含循环连线', 400);

  const reachableFromInput = new Set<string>();
  const forward = graph.nodes.filter((node) => node.type === 'flow-input').map((node) => node.id);
  while (forward.length) {
    const id = forward.shift()!;
    if (reachableFromInput.has(id)) continue;
    reachableFromInput.add(id);
    forward.push(...(outgoing.get(id) || []));
  }
  const reachableToOutput = new Set<string>();
  const backward = graph.nodes.filter((node) => node.type === 'flow-output').map((node) => node.id);
  while (backward.length) {
    const id = backward.shift()!;
    if (reachableToOutput.has(id)) continue;
    reachableToOutput.add(id);
    backward.push(...(incoming.get(id) || []));
  }
  if (graph.nodes.some((node) => !reachableFromInput.has(node.id) || !reachableToOutput.has(node.id))) {
    throw new AuthError('工具流中存在无法从输入到达输出的节点', 400);
  }

  return graph;
}

export async function assertToolFlowProjectAccess(user: SessionUser, projectId: string | null) {
  if (!projectId) return null;
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canGenerate) throw new AuthError('无权在此项目中运行工具流', 403);
  return access.project;
}

export async function assertCanUseToolFlow(user: SessionUser, flowId: string) {
  const flow = await prisma.toolFlow.findUnique({ where: { id: flowId } });
  if (!flow || flow.status === 'deleted') throw new AuthError('工具流不存在', 404);
  if (user.role === 'admin' || flow.owner_id === user.id || flow.visibility === 'public' || flow.visibility === 'shared') {
    await assertToolFlowProjectAccess(user, flow.project_id);
    return flow;
  }
  throw new AuthError('无权使用此工具流', 403);
}

export function parseIdList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim()))).slice(0, 30);
}

export function parseJsonObject(value: string | null | undefined) {
  if (!value) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}
