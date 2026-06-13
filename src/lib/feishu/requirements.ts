import type { Prisma } from '@prisma/client';

type FeishuRequirementClient = Prisma.TransactionClient;

type RawFields = Record<string, unknown>;

function stringField(fields: RawFields, keys: string[], fallback = '') {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function numberField(fields: RawFields, keys: string[]) {
  for (const key of keys) {
    const value = fields[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function videoItems(fields: RawFields): RawFields[] {
  const value = fields.video_items ?? fields.videoItems ?? fields['视频条目'];
  return Array.isArray(value)
    ? value.filter((item): item is RawFields => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

export async function syncFeishuRequirementDraft(
  tx: FeishuRequirementClient,
  input: {
    appToken: string;
    tableId: string;
    recordId: string;
    fields: RawFields;
    actorUserId: string;
  },
) {
  const idempotencyKey = `${input.appToken}:${input.tableId}:${input.recordId}`;
  const existing = await tx.feishuRequirement.findUnique({
    where: { idempotency_key: idempotencyKey },
  });
  if (existing?.created_project_id) {
    return { requirement: existing, deduplicated: true };
  }

  const projectName = stringField(input.fields, ['project_name', 'projectName', 'name', '需求名称', '项目名称'], '飞书需求草稿');
  const projectDescription = stringField(input.fields, ['description', 'project_description', '需求描述', '使用场景'], '');
  const platform = stringField(input.fields, ['platform', '平台'], '') || null;
  const ratio = stringField(input.fields, ['ratio', '比例', '原始需求比例'], '') || null;
  const duration = numberField(input.fields, ['duration', '时长']);
  const targetResolution = stringField(input.fields, ['target_resolution', 'targetResolution', '目标分辨率'], '') || null;
  const items = videoItems(input.fields);
  const hasVideoItems = items.length > 0;

  const project = await tx.project.create({
    data: {
      name: projectName,
      description: projectDescription || null,
      type: 'public',
      visibility: 'private',
      owner_user_id: input.actorUserId,
      created_by: input.actorUserId,
      status: 'draft',
    },
  });
  await tx.projectMember.create({
    data: {
      project_id: project.id,
      user_id: input.actorUserId,
      role: 'project_owner',
      joined_by: input.actorUserId,
    },
  });

  const cardInputs = hasVideoItems
    ? items.map((item, index) => ({
        title: stringField(item, ['title', 'name', '视频名称', '条目名称'], `视频需求 ${index + 1}`),
        objective: stringField(item, ['objective', 'description', '内容目标', '使用场景'], projectDescription),
        platform: stringField(item, ['platform', '平台'], platform || '') || platform,
        ratio: stringField(item, ['ratio', '比例'], ratio || '') || ratio,
        duration: numberField(item, ['duration', '时长']) ?? duration,
        target_resolution: stringField(item, ['target_resolution', 'targetResolution', '目标分辨率'], targetResolution || '') || targetResolution,
      }))
    : [{
        title: '未拆分视频需求',
        objective: '飞书需求未提供视频条目，需要负责人补充拆分',
        platform,
        ratio,
        duration,
        target_resolution: targetResolution,
      }];

  const cards = [];
  for (const item of cardInputs) {
    const card = await tx.videoCard.create({
      data: {
        project_id: project.id,
        title: item.title,
        objective: item.objective || null,
        status: 'draft',
        owner_user_id: input.actorUserId,
        platform: item.platform || null,
        ratio: item.ratio || null,
        original_ratio: item.ratio || ratio,
        ratio_locked: Boolean(item.ratio || ratio),
        duration: item.duration,
        target_resolution: item.target_resolution || null,
        delivery_specs_json: JSON.stringify({
          platform: item.platform || null,
          ratio: item.ratio || null,
          duration: item.duration,
          target_resolution: item.target_resolution || null,
          source: 'feishu_requirement',
        }),
        created_by: input.actorUserId,
      },
    });
    cards.push(card);
  }

  const payload = {
    feishu: {
      app_token: input.appToken,
      table_id: input.tableId,
      record_id: input.recordId,
    },
    project: { id: project.id, name: project.name, status: project.status },
    video_cards: cards.map((card) => ({ id: card.id, title: card.title, status: card.status })),
    writeback_status: hasVideoItems ? '已生成项目草稿和视频卡草稿' : '已生成项目草稿，待补充视频条目',
  };

  const requirement = await tx.feishuRequirement.upsert({
    where: { idempotency_key: idempotencyKey },
    update: {
      raw_fields_json: JSON.stringify(input.fields),
      sync_status: hasVideoItems ? 'draft' : 'needs_input',
      project_draft_json: JSON.stringify(payload.project),
      video_cards_json: JSON.stringify(payload.video_cards),
      created_project_id: project.id,
      error_message: hasVideoItems ? null : '飞书需求未提供视频条目，已生成未拆分草稿卡',
      last_synced_at: new Date(),
    },
    create: {
      app_token: input.appToken,
      table_id: input.tableId,
      record_id: input.recordId,
      idempotency_key: idempotencyKey,
      record_type: 'project',
      sync_status: hasVideoItems ? 'draft' : 'needs_input',
      raw_fields_json: JSON.stringify(input.fields),
      project_draft_json: JSON.stringify(payload.project),
      video_cards_json: JSON.stringify(payload.video_cards),
      created_project_id: project.id,
      error_message: hasVideoItems ? null : '飞书需求未提供视频条目，已生成未拆分草稿卡',
      last_synced_at: new Date(),
    },
  });

  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'feishu_requirement_sync',
      target_type: 'feishu_requirement',
      target_id: requirement.id,
      detail: JSON.stringify(payload),
    },
  });

  return { requirement, project, video_cards: cards, deduplicated: false };
}

export async function confirmFeishuRequirementDraft(
  tx: FeishuRequirementClient,
  input: {
    requirementId: string;
    actorUserId: string;
  },
) {
  const requirement = await tx.feishuRequirement.findUnique({ where: { id: input.requirementId } });
  if (!requirement?.created_project_id) throw new Error('飞书需求草稿不存在');

  await tx.project.update({
    where: { id: requirement.created_project_id },
    data: { status: 'active' },
  });
  await tx.videoCard.updateMany({
    where: { project_id: requirement.created_project_id, status: 'draft' },
    data: { status: 'active' },
  });
  const updated = await tx.feishuRequirement.update({
    where: { id: requirement.id },
    data: {
      sync_status: 'confirmed',
      error_message: null,
      last_synced_at: new Date(),
    },
  });
  await tx.operationLog.create({
    data: {
      operator_id: input.actorUserId,
      action: 'feishu_requirement_confirm',
      target_type: 'feishu_requirement',
      target_id: requirement.id,
      detail: JSON.stringify({ project_id: requirement.created_project_id }),
    },
  });
  return updated;
}
