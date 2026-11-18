import { randomUUID } from 'node:crypto';
import { prisma, retrySqliteBusy } from '@/lib/prisma';

export class DirectoryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Project = { id: string; name: string; color: string; icon: string; version: string };
type Conversation = { id: string; title: string; projectId: string; projectKnown: boolean; createdAt: number | null; updatedAt: number | null; version: string };
type Directory = { schema: 1; revision: string; projects: Project[]; conversations: Conversation[] };
type Observation = { base: string | null; value: Record<string, unknown> };
const empty = (): Directory => ({ schema: 1, revision: '', projects: [], conversations: [] });
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008]/.test(value);
const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_~:-]{1,200}$/.test(value);
function keyFor(scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new DirectoryError('无法确认目录所属账号');
  return 'bridge_gpt_directory_v1:' + scope;
}
function parseObservation(raw: unknown, project: boolean): Observation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DirectoryError('目录格式无效');
  const { base, value } = raw as Observation;
  if (base !== null && !text(base, 64)) throw new DirectoryError('目录版本无效');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !id(value.id)) throw new DirectoryError('目录条目无效');
  const allowed = project ? ['id', 'name', 'color', 'icon'] : ['id', 'title', 'projectId', 'projectKnown', 'createdAt', 'updatedAt'];
  if (Object.keys(value).some(field => !allowed.includes(field))) throw new DirectoryError('目录只接受名称、图标和所属信息');
  if (project) {
    if (!/^g-p-[a-zA-Z0-9_-]+$/.test(String(value.id)) || !text(value.name, 120) || !String(value.name).trim()) throw new DirectoryError('项目名称无效');
    if (!text(value.color, 80) || value.color && !/^(#[a-f\d]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\))$/i.test(String(value.color))) throw new DirectoryError('项目颜色无效');
    if (!text(value.icon, 16000) || value.icon && !/^data:image\/svg\+xml;base64,[a-zA-Z0-9+/]+=*$/.test(String(value.icon))) throw new DirectoryError('项目图标无效');
  } else {
    if (typeof value.projectKnown !== 'boolean') throw new DirectoryError('对话项目状态无效');
    if (!text(value.title, 160) || !text(value.projectId, 120) || value.projectId && !/^g-p-[a-zA-Z0-9_-]+$/.test(String(value.projectId))) throw new DirectoryError('对话名称或项目无效');
    for (const field of ['createdAt', 'updatedAt']) if (value[field] !== null && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || Number(value[field]) < 946684800000 || Number(value[field]) > Date.now() + 86400000)) throw new DirectoryError('对话时间无效');
  }
  return { base, value: Object.fromEntries(allowed.map(field => [field, value[field]])) };
}
function decode(raw?: string): Directory {
  if (!raw) return empty();
  const data = JSON.parse(raw) as Directory;
  if (data.schema !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.conversations)) throw new DirectoryError('目录暂时无法读取', 503);
  return data;
}
export async function readDirectory(userId: string, scope: string, revision: string) {
  const row = await prisma.userPreference.findUnique({ where: { user_id_key: { user_id: userId, key: keyFor(scope) } }, select: { value_json: true } });
  const directory = decode(row?.value_json);
  return { userId, scope, revision: directory.revision, unchanged: revision === directory.revision, ...(revision === directory.revision ? {} : { directory }) };
}
export async function updateDirectory(userId: string, scope: string, body: Record<string, unknown>) {
  const key = keyFor(scope);
  if (Object.keys(body).some(field => !['scope', 'projects', 'conversations'].includes(field))) throw new DirectoryError('目录包含不支持的数据');
  if (!Array.isArray(body.projects) || body.projects.length > 500 || !Array.isArray(body.conversations) || body.conversations.length > 5000) throw new DirectoryError('目录条目过多');
  const projects = body.projects.map(row => parseObservation(row, true)), conversations = body.conversations.map(row => parseObservation(row, false));
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await retrySqliteBusy(() => prisma.$transaction(async tx => {
      const where = { user_id_key: { user_id: userId, key } };
      const previous = await tx.userPreference.findUnique({ where });
      const directory = decode(previous?.value_json), revision = randomUUID(), conflicts: string[] = [];
      let changed = false;
      function merge<T extends { id: string; version: string }>(current: T[], incoming: Observation[]) {
        const rows = new Map(current.map(row => [row.id, row]));
        for (const { base, value } of incoming) {
          const old = rows.get(String(value.id));
          if ((old?.version ?? null) !== base) { conflicts.push(String(value.id)); continue; }
          const next = { ...value, version: old?.version || '' } as T;
          if (JSON.stringify(next) === JSON.stringify(old)) continue;
          rows.set(next.id, { ...next, version: revision }); changed = true;
        }
        return Array.from(rows.values()).sort((a, b) => a.id.localeCompare(b.id));
      }
      const next: Directory = { schema: 1, revision: directory.revision, projects: merge(directory.projects, projects), conversations: merge(directory.conversations, conversations) };
      if (next.projects.length > 500 || next.conversations.length > 5000) throw new DirectoryError('目录已达保存上限', 409);
      if (changed) {
        next.revision = revision;
        const value_json = JSON.stringify(next);
        if (Buffer.byteLength(value_json) > 512 * 1024) throw new DirectoryError('目录过大，请减少自定义图标', 413);
        if (previous) {
          const saved = await tx.userPreference.updateMany({ where: { user_id: userId, key, value_json: previous.value_json }, data: { value_json } });
          if (saved.count !== 1) return null;
        } else await tx.userPreference.create({ data: { user_id: userId, key, value_json } });
      }
      return { userId, scope, revision: next.revision, directory: next, conflicts };
    }));
    if (result) return result;
  }
  throw new DirectoryError('目录正在另一台设备更新，请稍后重试', 409);
}
