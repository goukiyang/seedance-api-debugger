import { prisma } from '@/lib/prisma';
import { StudioError } from '@/lib/image-studio/tasks';
import type { SessionUser } from '@/lib/auth/session';
import type { CharacterLabConfig, CharacterLabDraft, CharacterLabFace, CharacterLabPlan, CharacterLabPromptFields, CharacterLabWorkspace } from './types';

export const CONFIG_KEY = 'character-lab:v1:config';
export const workspaceKey = (owner: string, id: string) => `character-lab:v1:${owner}:workspace:${id}`;
export const planKey = (owner: string, id: string) => `character-lab:v1:${owner}:plan:${id}`;
export const receiptKey = (owner: string, id: string) => `character-lab:v1:${owner}:receipt:${id}`;
export function labId(value: unknown, label = '记录') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw new StudioError(`${label}编号无效`);
  return value;
}
export function labText(value: unknown, maximum: number, label: string) {
  if (typeof value !== 'string' || value.length > maximum) throw new StudioError(`${label}最多${maximum}字`);
  return value.trim();
}
function face(value: unknown): CharacterLabFace | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('面部选择无效');
  const item = value as Record<string, unknown>;
  if (!Number.isInteger(item.cell) || Number(item.cell) < 0 || Number(item.cell) > 8) throw new StudioError('面部格子无效');
  return { planId: labId(item.planId, '候选'), cell: Number(item.cell) };
}
export function parseLabDraft(value: unknown): CharacterLabDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('工作现场无效');
  const draft = value as Record<string, unknown>;
  if (!['faces', 'selection', 'result'].includes(String(draft.stage)) || ![4, 9].includes(Number(draft.count))
    || !Number.isInteger(draft.diversity) || Number(draft.diversity) < 0 || Number(draft.diversity) > 100
    || !Array.isArray(draft.auxiliaryFaces) || draft.auxiliaryFaces.length > 8
    || draft.adjustmentCell !== null && (!Number.isInteger(draft.adjustmentCell) || Number(draft.adjustmentCell) < 0 || Number(draft.adjustmentCell) > 3)) throw new StudioError('阶段、数量、差异或格子设置无效');
  const auxiliaryFaces = draft.auxiliaryFaces.map(face);
  if (auxiliaryFaces.some(item => !item)) throw new StudioError('辅助面部无效');
  const optionalId = (item: unknown, label: string) => item === null ? null : labId(item, label);
  const sourceAssetId = draft.sourceAssetId === null ? null : labText(draft.sourceAssetId, 100, '素材编号');
  if (sourceAssetId !== null && !/^[\w-]+$/.test(sourceAssetId)) throw new StudioError('素材编号无效');
  const projectId = draft.projectId === null ? null : labText(draft.projectId, 100, '项目编号');
  return { stage: draft.stage as CharacterLabDraft['stage'], sourceAssetId, count: Number(draft.count) as 4 | 9,
    diversity: Number(draft.diversity), context: labText(draft.context, 3000, '角色补充'), model: labText(draft.model, 100, '模型'),
    channelId: labText(draft.channelId, 80, '通道'), quality: labText(draft.quality, 30, '画质'), resolution: labText(draft.resolution, 20, '分辨率'),
    projectId, facePlanId: optionalId(draft.facePlanId, '候选'), mainFace: face(draft.mainFace), auxiliaryFaces: auxiliaryFaces as CharacterLabFace[],
    auxiliaryFeatures: labText(draft.auxiliaryFeatures, 1000, '辅助特征'), resultPlanId: optionalId(draft.resultPlanId, '成品'), resultName: draft.resultName === undefined ? '' : labText(draft.resultName, 80, '作品名称'),
    adjustment: labText(draft.adjustment, 3000, '调整要求'), adjustmentCell: draft.adjustmentCell as number | null };
}
export async function readLabWorkspace(owner: string, id: string) {
  const row = await prisma.platformSetting.findUnique({ where: { key: workspaceKey(owner, labId(id)) } });
  if (!row) throw new StudioError('角色项目不存在或无权访问', 404);
  return JSON.parse(row.value_json) as CharacterLabWorkspace;
}
export async function readLabPlan(owner: string, id: string) {
  const row = await prisma.platformSetting.findUnique({ where: { key: planKey(owner, labId(id)) } });
  if (!row) throw new StudioError('生成记录不存在或无权访问', 404);
  return JSON.parse(row.value_json) as CharacterLabPlan;
}
export const defaultLabConfig: CharacterLabConfig = {
  revision: 0, updatedAt: null,
  basePrompt: '根据原始角色设计图生成真人面部候选。所有格子采用统一的正面头肩构图、摄影环境、平视镜头、中性表情和光线，每格仅一位人物。变化重点是人物身份与面部结构，而不是表情、拍摄角度或服装。',
  characterContext: '从原图判断角色的年龄感、整体气质和关键身份特征。保留必要的发型、眼镜及标志性配饰。原图中的多个视角属于同一角色，不将其误认成不同人物。',
  faceVariables: '系统性改变脸长与脸宽、颧骨、下颌、额头、眉骨、眼形与眼距、鼻梁与鼻翼、唇形与五官比例。各格使用不同的骨相和特征组合；禁止同一张脸仅换表情或角度。',
  styleConstraints: '真实人物摄影，自然皮肤纹理与合理解剖结构，统一灰色摄影背景。避免动漫、插画、游戏建模和塑料皮肤。不添加编号、字幕、标注、边框装饰或水印。',
  resultPrompt: '生成同一个人物的角色参考图，整体宽高比2:3，左右两列等宽，上排占42%高度，下排占58%。左上正面头肩特写，右上侧面头肩特写，左下正面全身，右下背面全身。四格人物身份、发型、眼镜、服装和配饰一致，保留原角色身体设计、服装颜色、比例和辨识特征。全身格必须完整包含头顶和鞋底。统一灰色背景、镜头与光线，不加文字。',
};
export async function labConfig() {
  const row = await prisma.platformSetting.findUnique({ where: { key: CONFIG_KEY } });
  return row ? JSON.parse(row.value_json) as CharacterLabConfig : defaultLabConfig;
}
export async function labConfigVersions() {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: `${CONFIG_KEY}:version:` } }, orderBy: { created_at: 'desc' } });
  return rows.map(row => JSON.parse(row.value_json) as CharacterLabConfig);
}
export async function saveLabConfig(user: SessionUser, revision: unknown, input: unknown) {
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { role: true, status: true, account_type: true } });
  if (!fresh || fresh.role !== 'admin' || fresh.status !== 'active' || fresh.account_type !== 'internal') throw new StudioError('仅管理员可以修改生成规则', 403);
  if (!Number.isInteger(revision) || !input || typeof input !== 'object' || Array.isArray(input)) throw new StudioError('规则版本无效');
  const fields = input as Record<string, unknown>;
  const checked = Object.fromEntries((['basePrompt', 'characterContext', 'faceVariables', 'styleConstraints', 'resultPrompt'] as const)
    .map(key => [key, labText(fields[key], 3000, '生成规则')])) as CharacterLabPromptFields;
  if (Object.values(checked).some(item => !item)) throw new StudioError('生成规则不能为空');
  return prisma.$transaction(async tx => {
    const row = await tx.platformSetting.findUnique({ where: { key: CONFIG_KEY } });
    const current = row ? JSON.parse(row.value_json) as CharacterLabConfig : defaultLabConfig;
    if (current.revision !== revision) throw new StudioError('规则已在另一处更新，请重新读取；当前编辑保留', 409);
    const config = { ...checked, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    const value_json = JSON.stringify(config);
    if (row) {
      if (!(await tx.platformSetting.updateMany({ where: { key: CONFIG_KEY, value_json: row.value_json }, data: { value_json, updated_by: user.id } })).count) throw new StudioError('规则已更新，请重新读取', 409);
    } else await tx.platformSetting.create({ data: { key: CONFIG_KEY, value_json, updated_by: user.id } });
    await tx.platformSetting.create({ data: { key: `${CONFIG_KEY}:version:${config.revision}`, value_json, updated_by: user.id } });
    return config;
  });
}
export async function createLabWorkspace(owner: string, id: unknown, name: unknown, model: string) {
  const workspaceId = labId(id, '角色项目'), key = workspaceKey(owner, workspaceId);
  const existing = await prisma.platformSetting.findUnique({ where: { key } });
  if (existing) return JSON.parse(existing.value_json) as CharacterLabWorkspace;
  const now = new Date().toISOString();
  const workspace: CharacterLabWorkspace = { id: workspaceId, name: name === undefined ? '未命名角色' : labText(name, 80, '角色名称') || '未命名角色', revision: 1, createdAt: now, updatedAt: now,
    draft: { stage: 'faces', sourceAssetId: null, count: 4, diversity: 75, context: '', model, channelId: 'original', quality: 'auto', resolution: '1K', projectId: null, facePlanId: null, mainFace: null, auxiliaryFaces: [], auxiliaryFeatures: '', resultPlanId: null, resultName: '', adjustment: '', adjustmentCell: null }, savedResults: [] };
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value_json: JSON.stringify(workspace), updated_by: owner }, update: {} });
  return readLabWorkspace(owner, workspaceId);
}
export async function updateLabWorkspace(owner: string, id: unknown, revision: unknown, name: unknown, draft: unknown) {
  const workspaceId = labId(id), checked = parseLabDraft(draft), title = labText(name, 80, '角色名称') || '未命名角色';
  if (!Number.isInteger(revision)) throw new StudioError('工作区版本无效');
  return prisma.$transaction(async tx => {
    const key = workspaceKey(owner, workspaceId), row = await tx.platformSetting.findUnique({ where: { key } });
    if (!row) throw new StudioError('角色项目不存在', 404);
    const workspace = JSON.parse(row.value_json) as CharacterLabWorkspace;
    if (workspace.revision !== revision) throw new StudioError('工作现场已在另一页更新，当前编辑保留；请重新读取', 409);
    const next = { ...workspace, name: title, draft: checked, revision: workspace.revision + 1, updatedAt: new Date().toISOString() };
    if (!(await tx.platformSetting.updateMany({ where: { key, value_json: row.value_json }, data: { value_json: JSON.stringify(next), updated_by: owner } })).count) throw new StudioError('工作现场已更新，请重新读取', 409);
    return next;
  });
}
export async function listLabWorkspaces(owner: string) {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: `character-lab:v1:${owner}:workspace:` } }, orderBy: { updated_at: 'desc' } });
  return rows.map(row => JSON.parse(row.value_json) as CharacterLabWorkspace);
}
