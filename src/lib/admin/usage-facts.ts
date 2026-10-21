import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { UsageAttributionBasis, UsageCoverage, UsageFact, UsageKind, UsageSourceKind } from './usage-types';
import { usageInteger, usageDecimalUnits, usageUnitsText, usageMoneyTotals, usageCnyMicros } from './usage-money';
import { usageRecordHref } from './usage-record-link';

type Cell = string | number | bigint | Date | boolean | null;
type Row = Record<string, Cell>;
type Db = Prisma.TransactionClient;
const ZERO = BigInt(0);
const CHUNK = 500;
const sourceLabels: Record<UsageSourceKind, string> = {
  video_task: '视频任务', image_task: '图片任务', video_studio_run: '视频工作台独立文字调用',
  agent_text_step: 'Agent 独立文字调用',
  role_run: '角色任务分组', role_attempt: '角色文字调用', toolflow_run: '工具流分组', cutout_receipt: '本站抠图提交回执',
};
const keyOf = (kind: string, id: string) => `${kind}:${id}`;
const str = (value: Cell | undefined): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const bool = (value: Cell | undefined) => value === true || value === 1 || value === BigInt(1);

function iso(value: Cell | undefined): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'bigint' ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Cutout's frozen local receipt uses epoch milliseconds; original Job uses
// epoch seconds. Do not guess units from magnitude or parse mutable phaseAt.
function epochIso(value: Cell | undefined, unit: 'milliseconds' | 'seconds'): string | null {
  if (typeof value !== 'number' && typeof value !== 'bigint') return null;
  const time = Number(value) * (unit === 'seconds' ? 1000 : 1);
  if (!Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER) return null;
  return iso(time);
}

// All fragments passed here are static whitelist projections, never user SQL.
async function rows(db: Db, from: Prisma.Sql, fields: Prisma.Sql, id: Prisma.Sql, condition = Prisma.sql`1 = 1`): Promise<Row[]> {
  const result: Row[] = [];
  let cursor = '';
  for (;;) {
    const page = await db.$queryRaw<Row[]>(Prisma.sql`SELECT ${fields} FROM ${from}
      WHERE (${condition}) AND ${id} > ${cursor} ORDER BY ${id} ASC LIMIT ${CHUNK}`);
    result.push(...page);
    if (page.length < CHUNK) return result;
    cursor = String(page[page.length - 1].id);
  }
}

// JSON is reduced inside SQLite. Prompts, references, raw responses, and settings
// blobs never cross the DB boundary into this reader.
const imageFields = Prisma.sql`"id", "owner_id", "batch_id", "model", "output_size", "status", "billing_status",
  "actual_credits", "unit_credits", "billing_settled_at", "tool_flow_run_id", "created_at", "updated_at", "finished_at",
  "billing_scope", "gateway_request_id", CASE WHEN "deleted_at" IS NOT NULL THEN 'user_deleted' ELSE 'active' END AS "retention",
  CASE WHEN "asset_id" IS NOT NULL AND "asset_id" <> '' THEN 1 ELSE 0 END AS "has_output",
  json_extract(CASE WHEN json_valid("snapshot_json") THEN "snapshot_json" ELSE '{}' END, '$.imageChannel.channelId') AS "channel_id",
  json_extract(CASE WHEN json_valid("usage_json") THEN "usage_json" ELSE '{}' END, '$.studioDelivery.code') AS "delivery_code"`;

const agentTextFields = Prisma.sql`s."id", s."agent_run_id", s."created_at", r."user_id", r."status" AS "run_status", r."updated_at",
  CASE WHEN json_type(CASE WHEN json_valid(s."input_json") THEN s."input_json" ELSE '{}' END, '$.provider') = 'text'
    THEN json_extract(CASE WHEN json_valid(s."input_json") THEN s."input_json" ELSE '{}' END, '$.provider') ELSE NULL END AS "provider",
  CASE WHEN json_type(CASE WHEN json_valid(s."input_json") THEN s."input_json" ELSE '{}' END, '$.model') = 'text'
    THEN json_extract(CASE WHEN json_valid(s."input_json") THEN s."input_json" ELSE '{}' END, '$.model') ELSE NULL END AS "input_model",
  CASE WHEN json_type(CASE WHEN json_valid(s."output_json") THEN s."output_json" ELSE '{}' END, '$.model') = 'text'
    THEN json_extract(CASE WHEN json_valid(s."output_json") THEN s."output_json" ELSE '{}' END, '$.model') ELSE NULL END AS "model"`;

const attemptFields = Prisma.sql`a."id", a."state", a."fee_state", a."reserved_points", a."settled_points",
  a."settled_usd_micros", a."settlement_applied", a."provider_scope", a."provider_reference", a."started_at", a."finished_at",
  w."role_task_run_id" AS "run_id", r."owner_user_id", r."document_id",
  json_extract(CASE WHEN json_valid(a."quote_json") THEN a."quote_json" ELSE '{}' END, '$.contract.model') AS "model",
  json_extract(CASE WHEN json_valid(a."quote_json") THEN a."quote_json" ELSE '{}' END, '$.contract.scope') AS "contract_scope",
  json_extract(CASE WHEN json_valid(a."settlement_receipt") THEN a."settlement_receipt" ELSE '{}' END, '$.source') AS "bill_source",
  json_extract(CASE WHEN json_valid(a."settlement_receipt") THEN a."settlement_receipt" ELSE '{}' END, '$.amountMicros') AS "bill_micros",
  json_extract(CASE WHEN json_valid(a."settlement_receipt") THEN a."settlement_receipt" ELSE '{}' END, '$.reference') AS "bill_reference",
  json_extract(CASE WHEN json_valid(a."settlement_receipt") THEN a."settlement_receipt" ELSE '{}' END, '$.model') AS "bill_model",
  json_extract(CASE WHEN json_valid(a."settlement_receipt") THEN a."settlement_receipt" ELSE '{}' END, '$.occurredAt') AS "bill_time"`;

const receiptFields = Prisma.sql`"id", "key", "created_at", "updated_at",
  json_valid("value_json") AS "valid_json",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.version') AS "version",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.receiptId') AS "receipt_id",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.ownerId') AS "owner_id",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.intent') AS "intent",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.stage') AS "stage",
  CASE WHEN json_type(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.createdAt') IN ('integer', 'real')
    THEN json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.createdAt') ELSE NULL END AS "receipt_created",
  CASE WHEN json_type(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.submittedAt') IN ('integer', 'real')
    THEN json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.submittedAt') ELSE NULL END AS "submitted_at",
  json_type(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.settings') AS "settings_type",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.job.job_id') AS "job_id",
  CASE WHEN json_type(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.job.created_at') IN ('integer', 'real')
    THEN json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.job.created_at') ELSE NULL END AS "job_created",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.job.status') AS "job_status",
  json_extract(CASE WHEN json_valid("value_json") THEN "value_json" ELSE '{}' END, '$.job.model') AS "job_model"`;

interface Attribution {
  owner: string | null;
  actor: string | null;
  project: string | null;
  time: string | null;
  payer: string | null;
  parentKind: string | null;
  parentId: string | null;
  valid: boolean;
}

async function readAttributions(db: Db): Promise<{ available: boolean; values: Map<string, Attribution> }> {
  // Compatible guards may run before the additive migration. Only absence of
  // this exact table is tolerated; all query/column/connection failures propagate.
  const exists = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'UsageAttribution'`;
  const values = new Map<string, Attribution>();
  if (!exists.length) return { available: false, values };
  let kind = '', id = '';
  for (;;) {
    const page = await db.$queryRaw<Row[]>`SELECT "source_kind", "source_id", "actor_user_id", "owner_user_id",
      "billing_subject_type", "billing_subject_id", "project_id", "occurred_at", "context_version", "parent_source_kind", "parent_source_id"
      FROM "UsageAttribution" WHERE "source_kind" > ${kind} OR ("source_kind" = ${kind} AND "source_id" > ${id})
      ORDER BY "source_kind", "source_id" LIMIT ${CHUNK}`;
    for (const row of page) {
      const time = iso(row.occurred_at);
      values.set(keyOf(String(row.source_kind), String(row.source_id)), {
        owner: str(row.owner_user_id), actor: str(row.actor_user_id), project: str(row.project_id), time,
        payer: str(row.billing_subject_type) && str(row.billing_subject_id) ? `${row.billing_subject_type}:${row.billing_subject_id}` : null,
        parentKind: str(row.parent_source_kind), parentId: str(row.parent_source_id),
        valid: usageInteger(row.context_version) === BigInt(1) && time !== null,
      });
    }
    if (page.length < CHUNK) return { available: true, values };
    kind = String(page[page.length - 1].source_kind); id = String(page[page.length - 1].source_id);
  }
}

export interface UsageCashEvent {
  id: string;
  sourceKey: string | null;
  eventType: string;
  occurredAt: string;
  currency: string | null;
  amountMicros: string | null;
  status: 'confirmed' | 'conflict' | 'pending';
  provider: string | null;
  proofId: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  detail: string;
  cashEvidence: boolean;
  ledgerUserId: string | null;
  ledgerProjectId: string | null;
  providerReference: string | null;
  providerScopeFingerprint: string | null;
}

export interface UsageFactSnapshot {
  facts: UsageFact[];
  coverage: UsageCoverage[];
  cashEvents: UsageCashEvent[];
  sourceFingerprintParts: string[];
  memberDirectory: Array<{ id: string; label: string }>;
  projectDirectory: Array<{ id: string; label: string }>;
}

interface InternalFact {
  fact: UsageFact;
  raw: Row;
  providerScope: string | null;
  providerReference: string | null;
  pointsKey: string | null;
  pointsScale: 'points' | 'cents';
  fallbackCharged: Cell | undefined;
  fallbackReserve: Cell | undefined;
  settlementKnown: boolean;
}

const decimal = (value: Cell | undefined) => usageDecimalUnits(value, 2);
const pointsText = (value: bigint | null) => value === null ? null : usageUnitsText(value);

function initialFact(kind: UsageSourceKind, id: string, business: UsageKind, time: string, update: string): UsageFact {
  return {
    sourceKind: kind, sourceId: id, parentSourceKind: null, parentSourceId: null, kind: business, leaf: business !== 'flow', occurredAt: time, updatedAt: update,
    ownerUserId: null, ownerLabel: '成员未归属', actorUserId: null, billingSubject: null,
    projectId: null, projectLabel: '未归属项目', currentOwnerUserId: null, currentProjectId: null,
    attribution: 'unassigned', attributionDetail: '', model: null, provider: null, resolution: null,
    status: 'unknown', retentionStatus: null, outputCount: 0, resultReady: null, costStatus: 'unconnected',
    confirmedCost: [], confirmedCostCnyMicros: null, chargedPoints: null, reservedPoints: null,
    releasedPoints: null, refundedPoints: null, ledgerIds: [], href: null,
  };
}

function sourceStatus(value: Cell | undefined) {
  return (str(value) || 'unknown').replace(/^rate_/, '').replace(/^channel_(queued|running)$/, '$1');
}

function attribute(fact: UsageFact, a: Attribution | undefined, owner: string | null, project: string | null,
  legacy: UsageAttributionBasis, currentProjectKnown: boolean, actor: string | null = null) {
  fact.currentOwnerUserId = owner;
  fact.currentProjectId = currentProjectKnown ? project : null;
  fact.ownerUserId = a ? a.valid ? a.owner : null : owner;
  fact.actorUserId = a ? a.valid ? a.actor : null : actor;
  fact.projectId = a ? a.valid ? a.project : null : project;
  fact.billingSubject = a?.valid ? a.payer : null;
  if (a) {
    if (a.valid && a.time) fact.occurredAt = a.time;
    fact.parentSourceId = a.valid ? a.parentId : null;
    fact.parentSourceKind = a.valid && a.parentKind && Object.hasOwn(sourceLabels, a.parentKind) ? a.parentKind as UsageSourceKind : null;
    const conflict = !a.valid || owner !== null && owner !== a.owner || currentProjectKnown && project !== a.project;
    fact.attribution = conflict ? 'conflict' : 'frozen';
    fact.attributionDetail = !a.valid ? '冻结归属版本或时间不可读，成员/项目/付款主体未猜测，时间暂按可证源时间；需核对原归属。' : conflict
      ? '原使用归属已冻结；与当前管理归属不同或冻结版本不可读。统计保留原归属，不改历史。'
      : '按原操作首建时冻结的消费归属；操作者与付费主体独立。';
    if (a.parentKind && a.parentId) fact.attributionDetail += ` 原父级 ${a.parentKind}:${a.parentId}。`;
  } else {
    fact.attribution = legacy;
    fact.attributionDetail = legacy === 'legacy_snapshot'
      ? '项目仅取工具流原 RunSnapshot.project_id；成员按原任务现存消费归属。'
      : legacy === 'legacy_current'
        ? '历史按现有归属；转项目或账号合并前的原归属无法还原。'
        : '原记录没有可证的历史项目；成员按原任务消费归属，未从模板、素材或当前画布猜项目。';
  }
}

async function directories(db: Db, model: 'user' | 'project') {
  const result = new Map<string, string>();
  const values = await rows(db, model === 'user' ? Prisma.sql`"User"` : Prisma.sql`"Project"`, Prisma.sql`"id", "name"`, Prisma.sql`"id"`);
  for (const value of values) {
    const id = String(value.id), name = str(value.name);
    result.set(id, name && !name.includes('@') ? name : `${model === 'user' ? '成员' : '项目'} ${id.slice(0, 8)}`);
  }
  return result;
}

/** Read-only whitelist projection. Caller owns the enclosing interactive snapshot. */
export async function readUsageFacts(db: Db, dataAsOf: string): Promise<UsageFactSnapshot> {
  const attribution = await readAttributions(db);
  const videos = await rows(db, Prisma.sql`"VideoTask"`, Prisma.sql`"id", "provider", "model", "local_status", "user_id", "owner_user_id", "project_id",
    "resolution", "created_at", "updated_at", "completed_at", "retention_status", "actual_cost", "frozen_cost", "refund_amount",
    "billing_scope", "billing_account_id", "provider_cost_status", "provider_task_id", "provider_client_request_id", "template_studio_run_id",
    CASE WHEN ("local_video_path" IS NOT NULL AND "local_video_path" <> '') OR ("public_video_url" IS NOT NULL AND "public_video_url" <> '') THEN 1 ELSE 0 END AS "has_output"`, Prisma.sql`"id"`);
  const images = await rows(db, Prisma.sql`"ImageStudioTask"`, imageFields, Prisma.sql`"id"`);
  const studio = await rows(db, Prisma.sql`"VideoStudioRun"`, Prisma.sql`"id", "owner_user_id", "model", "mode", "status", "created_at", "updated_at", "completed_at"`, Prisma.sql`"id"`, Prisma.sql`"mode" = 'llm'`);
  const agentText = await rows(db, Prisma.sql`"AgentRunStep" s JOIN "AgentRun" r ON r."id" = s."agent_run_id"`,
    agentTextFields, Prisma.sql`s."id"`, Prisma.sql`s."step_key" = 'llm_generate'`);
  const roleRuns = await rows(db, Prisma.sql`"CanvasRoleTaskRun"`, Prisma.sql`"id", "owner_user_id", "document_id", "status", "created_at", "updated_at"`, Prisma.sql`"id"`);
  const attempts = await rows(db, Prisma.sql`"CanvasRoleAttempt" a LEFT JOIN "CanvasRoleWork" w ON w."id" = a."work_id"
    LEFT JOIN "CanvasRoleTaskRun" r ON r."id" = w."role_task_run_id"`, attemptFields, Prisma.sql`a."id"`);
  const flows = await rows(db, Prisma.sql`"ToolFlowRun"`, Prisma.sql`"id", "owner_id", "status", "created_at", "updated_at",
    json_valid("snapshot_json") AS "valid_snapshot",
    json_extract(CASE WHEN json_valid("snapshot_json") THEN "snapshot_json" ELSE '{}' END, '$.schema') AS "snapshot_schema",
    json_extract(CASE WHEN json_valid("snapshot_json") THEN "snapshot_json" ELSE '{}' END, '$.project_id') AS "original_project"`, Prisma.sql`"id"`);
  const bindings = await rows(db, Prisma.sql`"CanvasRoleMediaBinding"`, Prisma.sql`"id", "run_id", "source_kind", "source_task_id", "updated_at"`, Prisma.sql`"id"`);
  const receipts = await rows(db, Prisma.sql`"PlatformSetting"`, receiptFields, Prisma.sql`"id"`, Prisma.sql`substr("key", 1, 21) = 'image_result_next_v1:'`);
  const flowsById = new Map(flows.map(row => [String(row.id), row]));
  const mediaParents = new Map(bindings.map(row => [keyOf(row.source_kind === 'image_studio_task' ? 'image_task' : String(row.source_kind), String(row.source_task_id)), String(row.run_id)]));
  const internal: InternalFact[] = [];
  const invalidCounts = new Map<string, number>();
  const add = (row: Row, kind: UsageSourceKind, business: UsageKind, options: {
    id?: string; time?: Cell; owner: string | null; project?: string | null; legacy?: UsageAttributionBasis;
    currentProjectKnown?: boolean; status?: Cell; parent?: string | null; parentKind?: UsageSourceKind; href?: string | null;
    charged?: Cell; reserve?: Cell; settled?: boolean; scale?: 'points' | 'cents'; scope?: string | null; reference?: string | null;
  }) => {
    const id = options.id || String(row.id), created = iso(options.time ?? row.created_at), updated = iso(row.updated_at) || iso(row.finished_at) || created;
    if (!created || !updated) { invalidCounts.set(kind, (invalidCounts.get(kind) || 0) + 1); return; }
    const fact = initialFact(kind, id, business, created, updated);
    const a = attribution.values.get(keyOf(kind, id));
    attribute(fact, a, options.owner, options.project ?? null, options.legacy || 'unassigned', !!options.currentProjectKnown, kind === 'video_task' ? str(row.user_id) : null);
    if (!fact.parentSourceId) {
      fact.parentSourceId = options.parent || mediaParents.get(keyOf(kind, id)) || null;
      fact.parentSourceKind = options.parent ? options.parentKind || null : mediaParents.has(keyOf(kind, id)) ? 'role_run' : null;
    }
    if (!a && !fact.billingSubject) {
      if (kind === 'video_task') fact.billingSubject = str(row.billing_scope) && str(row.billing_account_id) ? `${row.billing_scope}:${row.billing_account_id}` : null;
      else if (kind === 'image_task' || kind === 'role_attempt') fact.billingSubject = options.owner ? `user:${options.owner}` : null;
    }
    fact.model = str(row.model) || str(row.job_model);
    fact.status = sourceStatus(options.status ?? row.status);
    fact.href = options.href || null;
    internal.push({ fact, raw: row, providerScope: options.scope || null, providerReference: options.reference || null,
      pointsKey: fact.leaf && kind !== 'cutout_receipt' && kind !== 'video_studio_run' && kind !== 'agent_text_step' ? kind === 'role_attempt' ? `role-attempt:${id}` : id : null,
      pointsScale: options.scale || 'points', fallbackCharged: options.charged, fallbackReserve: options.reserve,
      settlementKnown: !!options.settled });
  };
  for (const row of videos) {
    add(row, 'video_task', 'video', { owner: str(row.owner_user_id) || str(row.user_id), project: str(row.project_id), legacy: 'legacy_current', currentProjectKnown: true,
      status: row.local_status, charged: row.actual_cost, reserve: row.frozen_cost, settled: row.actual_cost !== null,
      parent: str(row.template_studio_run_id), parentKind: 'video_studio_run', href: `/tasks/${encodeURIComponent(String(row.id))}?return_to=%2Fadmin`,
      reference: str(row.provider_task_id) || str(row.provider_client_request_id) });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId !== String(row.id) || fact.sourceKind !== 'video_task') continue;
    fact.provider = str(row.provider); fact.resolution = str(row.resolution); fact.retentionStatus = str(row.retention_status);
    fact.outputCount = fact.status === 'succeeded' ? 1 : 0;
    fact.resultReady = fact.status === 'succeeded' ? bool(row.has_output) : null;
  }
  for (const row of images) {
    const flow = flowsById.get(str(row.tool_flow_run_id) || '');
    const project = flow?.snapshot_schema === 'toolflow.v1' && bool(flow.valid_snapshot) ? str(flow.original_project) : null;
    add(row, 'image_task', 'image', { owner: str(row.owner_id), project, parent: str(row.tool_flow_run_id), parentKind: 'toolflow_run', legacy: flow?.snapshot_schema === 'toolflow.v1' ? 'legacy_snapshot' : 'unassigned',
      charged: row.actual_credits, reserve: row.unit_credits, settled: row.billing_settled_at !== null,
      scope: str(row.billing_scope), reference: str(row.gateway_request_id),
      href: `/admin/image-studio?task_id=${encodeURIComponent(String(row.id))}` });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId !== String(row.id) || fact.sourceKind !== 'image_task') continue;
    fact.resolution = str(row.output_size); fact.retentionStatus = str(row.retention);
    const retainedOutput = ['generated_dimensions_mismatch', 'generated_format_mismatch'].includes(str(row.delivery_code) || '');
    fact.outputCount = bool(row.has_output) && (fact.status === 'succeeded' || retainedOutput) ? 1 : 0;
    fact.resultReady = fact.status === 'succeeded' || retainedOutput ? bool(row.has_output) : null;
    if (str(row.tool_flow_run_id) && mediaParents.has(keyOf('image_task', fact.sourceId)) && fact.parentSourceId !== mediaParents.get(keyOf('image_task', fact.sourceId))) {
      fact.attributionDetail += ' 同时有工具流及角色媒体分组关联；叶子仍只计一次。';
    }
  }
  for (const row of studio) {
    add(row, 'video_studio_run', 'text', { owner: str(row.owner_user_id),
      href: `/admin/agent-runs/template-prompts/${encodeURIComponent(String(row.id))}` });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId === String(row.id) && fact.sourceKind === 'video_studio_run') {
      fact.outputCount = fact.status === 'succeeded' ? 1 : 0; fact.resultReady = fact.status === 'succeeded' ? true : null;
    }
  }
  for (const row of agentText) {
    add(row, 'agent_text_step', 'text', { owner: str(row.user_id), parent: str(row.agent_run_id), status: 'recorded',
      href: `/admin/agent-runs/${encodeURIComponent(String(row.agent_run_id))}` });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId !== String(row.id) || fact.sourceKind !== 'agent_text_step') continue;
    fact.model = str(row.model) || str(row.input_model);
    fact.provider = str(row.provider);
    // These persisted steps are written only after the independent text call
    // returns. A parent Run's failed status can mean draft validation failed;
    // it does not establish a text-call failure or a ready result file.
    fact.outputCount = 1;
    fact.resultReady = null;
    fact.attributionDetail += ` 仅计原 llm_generate 独立文字步骤；父级状态 ${sourceStatus(row.run_status)} 不作为文字调用失败。未记录的历史失败不补造。`;
    if (!attribution.values.has(keyOf('agent_text_step', fact.sourceId))) {
      fact.attributionDetail += ' 历史时间按步骤写入时间近似，原调用开始时间不可还原；无原项目证据。';
    }
  }
  for (const row of roleRuns) {
    add(row, 'role_run', 'flow', { owner: str(row.owner_user_id), href: usageRecordHref('role_run', String(row.id)) });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId === String(row.id) && fact.sourceKind === 'role_run') {
      fact.attributionDetail += ' 原记录详情仅展示本站已存元数据，不代开画布或扩大原内容权限。';
    }
  }
  for (const row of attempts) {
    add(row, 'role_attempt', 'text', { owner: str(row.owner_user_id), time: row.started_at, parent: str(row.run_id), parentKind: 'role_run', status: row.state,
      charged: row.settled_points, reserve: row.reserved_points, scale: 'cents', settled: bool(row.settlement_applied),
      scope: str(row.provider_scope), reference: str(row.provider_reference), href: usageRecordHref('role_attempt', String(row.id)) });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId === String(row.id) && fact.sourceKind === 'role_attempt') {
      fact.outputCount = ['succeeded', 'completed', 'adopted', 'received'].includes(fact.status) ? 1 : 0;
      fact.resultReady = fact.outputCount ? true : null;
      fact.attributionDetail += ' 原记录详情沿同一只读投影，不读取角色正文或重新执行。';
    }
  }
  for (const row of flows) {
    add(row, 'toolflow_run', 'flow', { owner: str(row.owner_id),
      project: row.snapshot_schema === 'toolflow.v1' ? str(row.original_project) : null,
      legacy: row.snapshot_schema === 'toolflow.v1' ? 'legacy_snapshot' : 'unassigned', href: usageRecordHref('toolflow_run', String(row.id)) });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId === String(row.id) && fact.sourceKind === 'toolflow_run') {
      fact.attributionDetail += ' 原记录详情只查看本站流程与子任务元数据，不启动工具流。';
    }
  }
  for (const row of receipts) {
    if (!bool(row.valid_json)) { invalidCounts.set('cutout_receipt', (invalidCounts.get('cutout_receipt') || 0) + 1); continue; }
    if (row.intent !== 'cutout') continue;
    // An unknown *upload* is not an unknown job submission. settings only freezes
    // at startCutoutImageHandoff; imports/transport failures stay excluded.
    const stage = str(row.stage);
    if (!(stage === 'accepted' || ['submitting', 'unknown'].includes(stage || '') && row.settings_type === 'object')) continue;
    if (usageInteger(row.version) !== BigInt(1) || !str(row.receipt_id) || String(row.key) !== `image_result_next_v1:${row.receipt_id}`) {
      invalidCounts.set('cutout_receipt', (invalidCounts.get('cutout_receipt') || 0) + 1); continue;
    }
    const a = attribution.values.get(keyOf('cutout_receipt', String(row.receipt_id)));
    const frozenTime = a?.valid ? a.time : null;
    const submittedTime = epochIso(row.submitted_at, 'milliseconds');
    const jobTime = str(row.job_id) ? epochIso(row.job_created, 'seconds') : null;
    const receiptTime = iso(row.created_at) || epochIso(row.receipt_created, 'milliseconds');
    add(row, 'cutout_receipt', 'cutout', { id: String(row.receipt_id), owner: str(row.owner_id), time: frozenTime || submittedTime || jobTime || receiptTime,
      status: str(row.job_status) || (stage === 'accepted' ? 'accepted' : 'submission_unknown'), reference: str(row.job_id),
      href: usageRecordHref('cutout_receipt', String(row.receipt_id)) });
    const fact = internal[internal.length - 1]?.fact;
    if (fact?.sourceId === String(row.receipt_id) && fact.sourceKind === 'cutout_receipt') {
      fact.outputCount = fact.status === 'succeeded' ? 1 : 0;
      // No media read or upstream GET to assert file availability.
      fact.resultReady = null;
      fact.attributionDetail += frozenTime ? ' 发生时间取原冻结提交归属。'
        : submittedTime ? ' 发生时间取首次进入提交中的不可变 submittedAt。'
          : jobTime ? ' 历史提交时间按原回执内已保存的 Job 创建时间近似，不查询上游历史。'
            : ' 历史缺少提交及 Job 创建时间，暂按原回执创建时间近似；不能当成精确首次提交时间。';
      fact.attributionDetail += ' 原记录详情仅查看本站已存回执元数据；接续/媒体仍沿原本人权限，不查询供应商。';
    }
  }
  const cashEvents = await attachCash(db, internal);
  const pointVersions: string[] = [];
  const pointDetail = await attachPoints(db, internal, pointVersions);
  // Include present members/projects with no use as actual empty groups.
  const memberNames = await directories(db, 'user');
  const projectNames = await directories(db, 'project');
  for (const { fact } of internal) {
    fact.ownerLabel = fact.ownerUserId ? memberNames.get(fact.ownerUserId) || `成员已不可用 (${fact.ownerUserId})` : '成员未归属';
    fact.projectLabel = fact.projectId ? projectNames.get(fact.projectId) || `项目已不可用 (${fact.projectId})` : '未归属项目';
  }
  const coverage: UsageCoverage[] = (Object.keys(sourceLabels) as UsageSourceKind[]).map(source => {
    const items = internal.filter(item => item.fact.sourceKind === source), invalid = invalidCounts.get(source) || 0;
    const frozen = items.filter(item => item.fact.attribution === 'frozen' || item.fact.attribution === 'conflict').length;
    const unavailableCash = items.filter(item => item.fact.leaf && item.fact.costStatus !== 'confirmed').length;
    return { source, label: sourceLabels[source], status: invalid || frozen < items.length || unavailableCash || pointDetail.get(source) ? 'partial' : 'complete',
      total: items.length, frozen, legacy: items.length - frozen,
      detail: `${source === 'video_studio_run' ? '仅独立 LLM，direct 不计文字调用。' : source === 'agent_text_step' ? '仅 AgentRunStep.step_key=llm_generate 的已存独立文字叶子，按原 AgentRun.user_id 归人；不计父 Run、确定性计划或视频，不补造未存历史失败。无原费用证明则未接入；无历史项目证据则未归属。' : source === 'role_run' || source === 'toolflow_run' ? '父记录只计流程次数，金额与点数在原叶子，不加父镜像。' : ''}${source === 'cutout_receipt' ? '仅本站受理/提交未知回执，不含导入；冻结归属优先，其次不可变 submittedAt、原 Job 创建时间、原回执创建时间；后两项明确历史近似，不用可变 phaseAt。费用及结果文件留存未接入，不查询上游历史。' : ''}历史缺失不回填；费用截至 ${dataAsOf}。${invalid ? ` ${invalid} 条投影损坏/缺少有效时间，未冒充零使用。` : ''}${unavailableCash ? ` ${unavailableCash} 条叶子现金费用未确认或有冲突。` : ''}${pointDetail.get(source) || ''}` };
  });
  const ledgerEvents = cashEvents.filter(event => !event.id.startsWith('role-bill:'));
  const invalidLedgerTimes = ledgerEvents.filter(event => !event.occurredAt).length;
  coverage.push({ source: 'cost_ledger', label: '原成本账本与未关联费用',
    status: invalidLedgerTimes || ledgerEvents.some(event => event.cashEvidence && event.status !== 'confirmed') ? 'partial' : 'complete',
    total: ledgerEvents.length, frozen: 0, legacy: ledgerEvents.length,
    detail: `全量白名单读取原 CostLedger，不复制分摊或按现价估算。非现金事件保留为证据，不并入确认成本。${invalidLedgerTimes ? ` ${invalidLedgerTimes} 行没有有效发生时间，无法放入时间范围，仍明确列为覆盖缺口。` : ''}` });
  const attributionPartial = internal.some(item => item.fact.attribution !== 'frozen');
  coverage.push({ source: 'usage_attribution', label: '原使用归属冻结', status: attribution.available ? attributionPartial ? 'partial' : 'complete' : 'unavailable',
    total: internal.length, frozen: internal.filter(item => ['frozen', 'conflict'].includes(item.fact.attribution)).length,
    legacy: internal.filter(item => !['frozen', 'conflict'].includes(item.fact.attribution)).length,
    detail: attribution.available ? '仅读取现存首建归属；缺行按已支持的历史依据，报表 GET 不补写。' : '兼容部署尚无 UsageAttribution 表；使用已支持的历史依据，不写入、不回填。' });
  return { facts: internal.map(item => item.fact), coverage, cashEvents,
    sourceFingerprintParts: [...bindings.map(row => `binding:${row.id}:${row.run_id}:${row.source_kind}:${row.source_task_id}:${iso(row.updated_at)}`),
      ...cashEvents.map(event => JSON.stringify(event)), ...pointVersions],
    memberDirectory: Array.from(memberNames, ([id, label]) => ({ id, label })),
    projectDirectory: Array.from(projectNames, ([id, label]) => ({ id, label })) };
}

// Cash and point ledgers are attached below. These readers never import an
// execution/finalizer/provider module or read an unbounded JSON blob.
async function attachCash(db: Db, items: InternalFact[]): Promise<UsageCashEvent[]> {
  const ledgers = await rows(db, Prisma.sql`"CostLedger"`, Prisma.sql`"id", "source_type", "source_id", "task_id", "image_task_id", "user_id", "project_id",
    "provider_request_id", "provider_name", "provider_account_id", "provider_task_id", "event_type", "amount_micros", "amount_minor", "currency",
    "cost_source", "confidence", "official_charge_id", "occurred_at", "created_at"`, Prisma.sql`"id"`);
  const byKey = new Map(items.map(item => [keyOf(item.fact.sourceKind, item.fact.sourceId), item]));
  const referenceMap = new Map<string, Set<string>>();
  const addReference = (reference: string, key: string) => {
    const values = referenceMap.get(reference) || new Set<string>(); values.add(key); referenceMap.set(reference, values);
  };
  for (const item of items) {
    // A provider-local ID without its frozen account scope cannot establish
    // either an association or a duplicate across different accounts.
    if (!item.fact.leaf || !item.providerReference || !item.providerScope) continue;
    addReference(`${item.fact.provider || ''}\0${item.providerScope || ''}\0${item.providerReference}`, keyOf(item.fact.sourceKind, item.fact.sourceId));
  }
  const events: UsageCashEvent[] = [], groups = new Map<string, UsageCashEvent[]>();
  const groupScopes = new Map<string, string>();
  const linked = new Map<string, UsageCashEvent[]>();
  const allLinked = new Map<string, UsageCashEvent[]>();
  const requestIds = Array.from(new Set(ledgers.flatMap(row => [str(row.provider_request_id), row.source_type === 'provider_request' ? str(row.source_id) : null]).filter((id): id is string => !!id)));
  const requestTasks = new Map<string, string>();
  for (let offset = 0; offset < requestIds.length; offset += CHUNK) {
    const page = await db.providerApiRequest.findMany({ where: { id: { in: requestIds.slice(offset, offset + CHUNK) } }, select: { id: true, task_id: true } });
    for (const request of page) if (request.task_id) requestTasks.set(request.id, request.task_id);
  }
  for (const row of ledgers) {
    // A rule refund/release is not a supplier cash refund. Keep only supported
    // cash evidence; pending official rows remain visible as unknown.
    const cashEvidence = row.source_type !== 'transfer' && ['official_charge', 'refund', 'reversal'].includes(String(row.event_type))
      && ['official_bill', 'provider_usage', 'manual'].includes(String(row.cost_source));
    const candidates = new Set<string>();
    if (str(row.task_id)) candidates.add(keyOf('video_task', String(row.task_id)));
    if (str(row.image_task_id)) candidates.add(keyOf('image_task', String(row.image_task_id)));
    const requestTask = requestTasks.get(str(row.provider_request_id) || '')
      || (row.source_type === 'provider_request' ? requestTasks.get(str(row.source_id) || '') : null);
    if (requestTask) candidates.add(keyOf('video_task', requestTask));
    const sourceId = str(row.source_id);
    if (sourceId && ['task', 'video_task', 'image_task', 'image_studio_task', 'role_attempt', 'video_studio_run', 'agent_text_step'].includes(String(row.source_type))) {
      const kind = row.source_type === 'task' ? 'video_task' : row.source_type === 'image_studio_task' ? 'image_task' : String(row.source_type);
      candidates.add(keyOf(kind, sourceId));
    }
    if (!candidates.size && str(row.provider_task_id) && str(row.provider_account_id)) {
      const matched = referenceMap.get(`${row.provider_name || ''}\0${row.provider_account_id || ''}\0${row.provider_task_id}`)
        || referenceMap.get(`\0${row.provider_account_id || ''}\0${row.provider_task_id}`);
      if (matched) for (const value of Array.from(matched)) candidates.add(value);
    }
    const existing = Array.from(candidates).filter(value => byKey.has(value));
    const sourceKey = candidates.size === 1 && existing.length === 1 ? existing[0] : null;
    const amount = usageInteger(row.amount_micros) ?? (() => { const minor = usageInteger(row.amount_minor); return minor === null ? null : minor * BigInt(10000); })();
    const currency = str(row.currency)?.toUpperCase() || null;
    const officialId = str(row.official_charge_id);
    const supported = cashEvidence && ['confirmed', 'reconciled'].includes(String(row.confidence)) && amount !== null && currency !== null && /^[A-Z]{3}$/.test(currency)
      && (row.cost_source !== 'manual' || !!officialId);
    const signed = amount === null ? null : ['refund', 'reversal'].includes(String(row.event_type)) && amount > ZERO ? -amount : amount;
    const event: UsageCashEvent = { id: String(row.id), sourceKey, eventType: String(row.event_type),
      occurredAt: iso(row.occurred_at) || '', currency, amountMicros: signed?.toString() ?? null,
      status: existing.length > 1 || candidates.size > 1 || row.confidence === 'disputed' || row.event_type === 'official_charge' && amount !== null && amount < ZERO
        ? 'conflict' : supported ? 'confirmed' : 'pending', provider: str(row.provider_name), proofId: officialId,
      ownerUserId: sourceKey ? byKey.get(sourceKey)!.fact.ownerUserId : null,
      projectId: sourceKey ? byKey.get(sourceKey)!.fact.projectId : null,
      ledgerUserId: str(row.user_id), ledgerProjectId: str(row.project_id), cashEvidence,
      providerReference: str(row.provider_task_id) || str(row.provider_request_id),
      providerScopeFingerprint: str(row.provider_account_id) ? createHash('sha256').update(String(row.provider_account_id)).digest('hex') : null,
      detail: `${sourceKey ? '原费用事件关联原消费任务；未叠加任务镜像或分摊。' : candidates.size > 1 ? '原事件关联多个任务，费用冲突，未任意分摊。' : '没有可唯一关联的原消费任务；单列未关联费用，不并入任务群。账本人/项目不是原任务消费归属。'}${cashEvidence ? '' : ' 此行为估计、请求记录、规则结算、分摊或转移，不是新增真实现金。'}` };
    events.push(event);
    if (!event.occurredAt) event.detail += ' 原费用发生时间不可读，未拿保存时间冒充；只能列入全部历史的未定时证据。';
    if (sourceKey) {
      const all = allLinked.get(sourceKey) || []; all.push(event); allLinked.set(sourceKey, all);
      if (cashEvidence) { const values = linked.get(sourceKey) || []; values.push(event); linked.set(sourceKey, values); }
    }
    if (candidates.size > 1) {
      for (const key of existing) {
        const fact = byKey.get(key)!.fact;
        fact.costStatus = 'conflict';
        fact.attributionDetail += ' 同一成本事件有多个相互冲突的原任务关联，未任意归人或分摊。';
        const all = allLinked.get(key) || []; all.push(event); allLinked.set(key, all);
      }
    }
    if (!cashEvidence) continue;
    // Event IDs prove distinct charges; a missing ID in the same request group
    // cannot prove independence. A duplicate official ID is always a conflict.
    const request = str(row.provider_task_id) || str(row.provider_request_id) || sourceKey || sourceId;
    const scope = `${row.provider_name || ''}\0${row.provider_account_id || ''}`;
    groupScopes.set(event.id, scope);
    const group = `${scope}\0${request || `ledger:${row.id}`}\0${row.event_type}`;
    const values = groups.get(group) || []; values.push(event); groups.set(group, values);
  }
  const proofGroups = new Map<string, UsageCashEvent[]>();
  for (const event of events) {
    if (!event.cashEvidence || !event.proofId) continue;
    const key = `${groupScopes.get(event.id)}\0${event.proofId}\0${event.eventType}`;
    const values = proofGroups.get(key) || []; values.push(event); proofGroups.set(key, values);
  }
  for (const group of [...Array.from(groups.values()).filter(group => group.length > 1 && group.some(event => !event.proofId)),
    ...Array.from(proofGroups.values()).filter(group => group.length > 1)]) {
    for (const event of group) { event.status = 'conflict'; event.detail += ' 同账单/原请求存在无法证实独立的多行，原行保留，未任意求和。'; }
  }
  // Only the original role Attempt's supported supplier_text_bill is cash proof.
  // Run/Binding settled mirrors and token usage never become cash events.
  for (const item of items) {
    if (item.fact.sourceKind !== 'role_attempt') continue;
    const row = item.raw, amount = usageInteger(row.bill_micros);
    const valid = row.bill_source === 'supplier_text_bill' && amount !== null && amount >= ZERO
      && str(row.bill_reference) !== null && row.bill_reference === row.provider_reference
      && str(row.bill_model) !== null && row.bill_model === row.model && str(row.provider_scope) !== null && row.provider_scope === row.contract_scope
      && iso(row.bill_time) !== null && ['confirmed', 'authorization_required'].includes(String(row.fee_state));
    if (!valid) continue;
    const key = keyOf('role_attempt', item.fact.sourceId), values = linked.get(key) || [];
    // A linked cash ledger and a receipt are two proofs of one event, not two
    // charges. Retain the receipt separately in the export evidence if equal.
    const event: UsageCashEvent = { id: `role-bill:${item.fact.sourceId}`, sourceKey: key, eventType: 'official_charge',
      occurredAt: iso(row.bill_time)!, currency: 'USD', amountMicros: amount!.toString(), status: 'confirmed', provider: 'musk',
      proofId: str(row.bill_reference), ownerUserId: item.fact.ownerUserId, projectId: item.fact.projectId,
      ledgerUserId: null, ledgerProjectId: null, cashEvidence: true,
      providerReference: str(row.provider_reference), providerScopeFingerprint: createHash('sha256').update(String(row.provider_scope)).digest('hex'),
      detail: '原 Attempt supplier_text_bill 证明；不叠角色父级或媒体镜像。' };
    const settledMicros = usageInteger(row.settled_usd_micros);
    if (bool(row.settlement_applied) && settledMicros !== null && settledMicros !== amount) {
      event.status = 'conflict'; event.detail += ` 原 Attempt 已结算现金镜像 ${settledMicros} USD micros 与原账单金额不同，保留两种依据待核。`;
    }
    const charges = values.filter(value => value.eventType === 'official_charge');
    if (charges.length) {
      const same = charges.length === 1 && charges[0].currency === 'USD' && charges[0].amountMicros === event.amountMicros
        && charges[0].status === 'confirmed' && event.status === 'confirmed'
        && charges[0].provider === event.provider && charges[0].providerReference === event.providerReference
        && charges[0].providerScopeFingerprint === event.providerScopeFingerprint;
      if (!same) {
        for (const value of charges) value.status = 'conflict'; event.status = 'conflict';
        event.detail += ' 账本与原文字账单的范围/原号/金额未同时对应，未仅凭金额相同合并。';
        values.push(event); events.push(event);
      } else charges[0].detail += ' 同原 Attempt 的范围、原号及金额均一致，未再累计一次。';
    } else { values.push(event); events.push(event); }
    linked.set(key, values);
  }
  const acceptanceEvents = new Map<string, UsageCashEvent[]>();
  for (const event of events) {
    if (!event.cashEvidence || !event.providerReference || event.eventType !== 'official_charge') continue;
    const key = `${event.provider || ''}\0${event.providerScopeFingerprint || ''}\0${event.providerReference}`;
    const values = acceptanceEvents.get(key) || []; values.push(event); acceptanceEvents.set(key, values);
  }
  for (const group of Array.from(acceptanceEvents.values())) {
    if (new Set(group.map(event => event.sourceKey).filter(Boolean)).size < 2) continue;
    for (const event of group) {
      event.status = 'conflict'; event.detail += ' 同一供应商范围/原受理号关联多个本站消费源，未重复累计现金。';
      if (event.sourceKey) {
        const fact = byKey.get(event.sourceKey)?.fact;
        if (fact) fact.costStatus = 'conflict';
      }
    }
  }
  // Same upstream acceptance linked to several local tasks is an exception even
  // when there is only one ledger row. Never choose one of them arbitrarily.
  for (const keys of Array.from(referenceMap.values())) {
    if (keys.size < 2) continue;
    for (const key of Array.from(keys)) {
      const fact = byKey.get(key)!.fact;
      fact.costStatus = 'conflict'; fact.attributionDetail += ' 同一供应商受理号关联多个本站任务，需核对，未按相似内容去重。';
      for (const event of linked.get(key) || []) event.status = 'conflict';
    }
  }
  for (const item of items) {
    const fact = item.fact;
    if (!fact.leaf) continue;
    const values = linked.get(keyOf(fact.sourceKind, fact.sourceId)) || [];
    fact.ledgerIds = Array.from(new Set([...(allLinked.get(keyOf(fact.sourceKind, fact.sourceId)) || []), ...values].map(event => event.id)));
    if (values.some(event => event.status === 'conflict')) fact.costStatus = 'conflict';
    else if (fact.costStatus !== 'conflict') fact.costStatus = values.length ? values.every(event => event.status === 'confirmed') ? 'confirmed' : 'pending'
      : fact.sourceKind === 'agent_text_step' ? 'unconnected'
        : ['queued', 'running', 'uncertain', 'unknown', 'submission_unknown', 'reserved', 'sending', 'accepted'].includes(fact.status)
          || /(^|_)(pending|unknown|reconciling|authorization_required)$/.test(str(item.raw.billing_status) || str(item.raw.fee_state) || '') ? 'pending' : 'unconnected';
    fact.confirmedCost = usageMoneyTotals(values.filter(event => event.status === 'confirmed' && event.currency && event.amountMicros !== null)
      .map(event => ({ currency: event.currency!, amountMicros: event.amountMicros! })));
    fact.confirmedCostCnyMicros = usageCnyMicros(fact.confirmedCost);
    const providers = Array.from(new Set(values.map(event => event.provider).filter((value): value is string => !!value)));
    if (!fact.provider && providers.length === 1) fact.provider = providers[0];
    if (fact.sourceKind === 'image_task' && String(item.raw.billing_status).includes('conflict')) fact.costStatus = 'conflict';
  }
  return events;
}

async function attachPoints(db: Db, items: InternalFact[], versions: string[]): Promise<Map<string, string>> {
  const byTask = new Map<string, Array<Row & { ledger_kind: string }>>();
  const ids = Array.from(new Set(items.map(item => item.pointsKey).filter((value): value is string => !!value)));
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const batch = ids.slice(offset, offset + CHUNK);
    const userRows = await db.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "related_task_id", "type", "amount", "frozen_before", "frozen_after", "created_at",
      json_extract(CASE WHEN json_valid("metadata_json") THEN "metadata_json" ELSE '{}' END, '$.unused_released') AS "unused_released"
      FROM "CreditLedger" WHERE "related_task_id" IN (${Prisma.join(batch)})
      AND "type" IN ('task_freeze', 'task_success_deduct', 'task_failed_refund', 'task_freeze_release', 'task_billing_release', 'task_refund', 'manual_refund') ORDER BY "created_at", "id"`);
    const projectRows = await db.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "related_task_id", "type", "amount", "frozen_before", "frozen_after", "created_at", NULL AS "unused_released"
      FROM "ProjectBudgetLedger" WHERE "related_task_id" IN (${Prisma.join(batch)})
      AND "type" IN ('task_freeze', 'task_success_deduct', 'task_failed_refund', 'task_freeze_release', 'task_billing_release', 'task_refund') ORDER BY "created_at", "id"`);
    for (const [kind, values] of [['user', userRows], ['project', projectRows]] as const) {
      for (const row of values) {
        const key = String(row.related_task_id), value = byTask.get(key) || [];
        value.push({ ...row, ledger_kind: kind }); byTask.set(key, value);
        versions.push(JSON.stringify({ ...row, ledger_kind: kind }, (_key, cell) => typeof cell === 'bigint' ? cell.toString() : cell));
      }
    }
  }
  const missing = new Map<string, number>(), conflicts = new Map<string, number>();
  for (const item of items) {
    const fact = item.fact;
    if (!fact.leaf) continue;
    const values = item.pointsKey ? byTask.get(item.pointsKey) || [] : [];
    const kinds = new Set(values.map(row => row.ledger_kind));
    let charged = ZERO, reserve = ZERO, released = ZERO, refunded = ZERO, valid = true;
    if (kinds.size > 1) valid = false;
    if (values.length) {
      for (const row of values) {
        const amount = decimal(row.amount), before = decimal(row.frozen_before), after = decimal(row.frozen_after);
        if (amount === null || before === null || after === null) { valid = false; continue; }
        const delta = after - before;
        reserve += delta;
        if (row.type === 'task_freeze') { if (delta < ZERO) valid = false; continue; }
        const debit = row.type === 'task_success_deduct' && amount < ZERO ? -amount : ZERO;
        charged += debit;
        const reduction = delta < ZERO ? -delta : ZERO;
        // A failed_refund with falling frozen balance returns a reservation.
        // Only money returned beyond that release is an actual spend refund.
        released += reduction > debit ? reduction - debit : ZERO;
        if (['task_refund', 'task_failed_refund', 'manual_refund'].includes(String(row.type)) && amount > ZERO) refunded += amount > reduction ? amount - reduction : ZERO;
        if (row.type === 'task_success_deduct' && amount > ZERO || delta > ZERO) valid = false;
      }
      if (reserve < ZERO) valid = false;
      if (valid) {
        fact.chargedPoints = pointsText(charged); fact.reservedPoints = pointsText(reserve);
        fact.releasedPoints = pointsText(released); fact.refundedPoints = pointsText(refunded);
        const mirror = item.pointsScale === 'cents' ? usageInteger(item.fallbackCharged) : decimal(item.fallbackCharged);
        if (item.settlementKnown && mirror !== null && mirror !== charged && mirror !== charged - refunded) {
          fact.attributionDetail += ` 任务实扣镜像 ${pointsText(mirror)} 点与原点数账本不同；本报表按账本，不相加。`;
          conflicts.set(fact.sourceKind, (conflicts.get(fact.sourceKind) || 0) + 1);
        }
      } else {
        fact.attributionDetail += ' 原点数账本缺字段、跨付费主体或余额变化不闭合，点数待核，未任意求和。';
        conflicts.set(fact.sourceKind, (conflicts.get(fact.sourceKind) || 0) + 1);
      }
      fact.ledgerIds.push(...values.map(row => `${row.ledger_kind}-points:${row.id}`));
    } else {
      // Mirrors are a fallback projection, never another debit. Missing release
      // or refund evidence remains null rather than silently becoming zero.
      const mirror = item.pointsScale === 'cents' ? usageInteger(item.fallbackCharged) : decimal(item.fallbackCharged);
      const frozen = item.pointsScale === 'cents' ? usageInteger(item.fallbackReserve) : decimal(item.fallbackReserve);
      fact.chargedPoints = item.settlementKnown && mirror !== null && mirror >= ZERO ? pointsText(mirror) : null;
      fact.reservedPoints = frozen !== null && frozen >= ZERO ? item.settlementKnown ? '0' : pointsText(frozen) : null;
      if (fact.sourceKind === 'role_attempt' && item.settlementKnown && mirror !== null && frozen !== null && mirror <= frozen) fact.releasedPoints = pointsText(frozen - mirror);
      if (fact.chargedPoints !== null || fact.reservedPoints !== null) fact.attributionDetail += ' 点数取原任务现存镜像；释放及实扣退款无原证的部分未填零。';
      missing.set(fact.sourceKind, (missing.get(fact.sourceKind) || 0) + 1);
    }
  }
  const detail = new Map<string, string>();
  for (const source of Object.keys(sourceLabels)) detail.set(source,
    `${missing.get(source) ? ` ${missing.get(source)} 条点数无完整原账本，只显示可证镜像/未知。` : ''}${conflicts.get(source) ? ` ${conflicts.get(source)} 条点数账本/镜像冲突待核。` : ''}`);
  return detail;
}
