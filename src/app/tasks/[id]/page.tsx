'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { GenerationMode } from '@/types';
import { GENERATION_MODE_LABELS } from '@/types';
import { ThumbnailCard } from '@/components/ThumbnailCard';

interface VideoTask {
  id: string;
  provider: string;
  model: string;
  generation_mode: GenerationMode;
  prompt: string;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  seed: number | null;
  generate_audio: boolean | null;
  return_last_frame: boolean | null;
  watermark: boolean | null;
  reference_image_urls: string | null;
  reference_video_urls: string | null;
  reference_audio_urls: string | null;
  first_frame_url: string | null;
  last_frame_url: string | null;
  frame_image_urls: string | null;
  callback_url: string | null;
  execution_expires_after: number | null;
  local_status: string;
  provider_task_id: string | null;
  provider_status: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  raw_create_response: string | null;
  raw_status_response: string | null;
  error_message: string | null;
  project_id: string | null;
  project?: { id: string; name: string; type: string } | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  frozen_cost: number | null;
  refund_amount: number | null;
  provider_cost_status: string;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros?: number | null;
  provider_final_amount_micros?: number | null;
  provider_cost_currency: string | null;
  provider_cost_confirmed_at: string | null;
  provider_billing_status?: string | null;
  provider_billing_time?: string | number | null;
  provider_usage_snapshot?: string | null;
  provider_client_request_id?: string | null;
  cost_allocation_status: string;
  cost_ledgers?: OfficialChargeLedger[];
  costLedgers?: OfficialChargeLedger[];
  params_json: string | null;
  reference_images_json: string | null;
  provider_payload_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
  type: string;
  status: string;
  my_role?: string | null;
  can_manage_project?: boolean;
}

interface OfficialChargeLedger {
  id: string;
  event_type?: string | null;
  amount_minor?: number | null;
  amount_micros?: number | null;
  currency?: string | null;
  provider_task_id?: string | null;
  billing_status?: string | null;
  billing_time?: string | number | null;
  usage_total_tokens?: number | null;
  usage_quantity?: number | null;
  usage_unit?: string | null;
  official_charge_id?: string | null;
  confidence?: string | null;
  cost_source?: string | null;
  occurred_at?: string | null;
  created_at?: string | null;
}

interface ProviderBillingMeta {
  actualCost: number | null;
  currency: string | null;
  billingStatus: string | null;
  billingTime: string | number | null;
  usageTotalTokens: number | null;
  completionTokens: number | null;
  providerTaskId: string | null;
  clientRequestId: string | null;
}

// Seedance 参考图资产元数据（与 generate/page.tsx 的 SelectedReferenceAsset 对应）
interface ReferenceAssetMeta {
  localAssetId: string;
  provider: string;
  providerAssetId: string;
  name: string;
  originalUrl: string;
  providerPreviewUrl?: string | null;
  providerStatus?: string | null;
  order: number;
}

// ============================================================================
// ReferenceImageDebug — 参考图调试信息区块
// ============================================================================

interface RefImageDebugEntry {
  index: number;
  label: string;
  originalUrl: string;
  resolvedUrl: string | null;
  fileSize: number;
  mimeType: string;
  status: 'resolved' | 'skipped' | 'failed';
}

interface ProviderPayloadDebug {
  model?: string;
  generation_mode?: string;
  resolved_mode?: string;
  prompt?: string;
  content_item_count?: number;
  reference_images_count?: number;
  first_frame_base64_status?: string;
  last_frame_base64_status?: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  content?: Array<Record<string, unknown>>;
}

interface ReferenceImageDebugProps {
  task: VideoTask;
  refImagesDebug: RefImageDebugEntry[];
  providerPayload: ProviderPayloadDebug;
}

function ReferenceImageDebug({ task, refImagesDebug, providerPayload }: ReferenceImageDebugProps) {
  const [showDebug, setShowDebug] = useState(false);

  const hasRefImages = refImagesDebug.length > 0;
  const hasPayload = Object.keys(providerPayload).length > 0;

  if (!hasRefImages && !hasPayload) {
    return null;
  }

  const referenceImages = parseJsonArray(task.reference_image_urls);

  return (
    <div className="task-debug-block">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title mb-0">
          参考图调试信息
          {refImagesDebug.length > 0 && (
            <span className={`ml-2 text-xs px-2 py-0.5 rounded ${
              refImagesDebug.some(i => i.status === 'resolved')
                ? 'bg-green-100 text-green-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}>
              {refImagesDebug.filter(i => i.status === 'resolved').length}/{refImagesDebug.length} 已解析
            </span>
          )}
        </h2>
        <button
          className="text-sm text-blue-500"
          onClick={() => setShowDebug(!showDebug)}
        >
          {showDebug ? '收起' : '展开'}
        </button>
      </div>

      {showDebug && (
        <div className="space-y-4">

          {/* 1. 前端输入 — Workspace 中的参考图 */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">1</span>
              前端输入 — Workspace 参考图 ({referenceImages.length} 张)
            </h3>
            <div className="flex flex-wrap gap-2">
              {referenceImages.map((url, i) => (
                <div key={i} className="flex-shrink-0">
                  <ThumbnailCard
                    thumbnailUrl={url}
                    originalUrl={url}
                    fileName={`图${i + 1}`}
                    type="image"
                    index={i}
                    isDragging={false}
                    isDragOver={false}
                  />
                </div>
              ))}
              {referenceImages.length === 0 && (
                <span className="text-xs text-gray-400 py-2">无</span>
              )}
            </div>
          </div>

          {/* 2. 后端接收 — base64 解析状态 */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">2</span>
              后端接收 — 图片解析状态
            </h3>
            <div className="space-y-1">
              {refImagesDebug.map((img) => (
                <div key={img.index} className={`text-xs p-2 rounded ${
                  img.status === 'resolved' ? 'bg-green-50' :
                  img.status === 'failed' ? 'bg-red-50' : 'bg-gray-50'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{img.label}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      img.status === 'resolved' ? 'bg-green-200 text-green-800' :
                      img.status === 'failed' ? 'bg-red-200 text-red-800' : 'bg-gray-200 text-gray-600'
                    }`}>
                      {img.status === 'resolved' ? '✓ base64 已解析' :
                       img.status === 'failed' ? '✗ 解析失败' : '跳过'}
                    </span>
                    <span className="text-gray-500">{img.mimeType}</span>
                    {img.fileSize > 0 && (
                      <span className="text-gray-500">{(img.fileSize / 1024).toFixed(1)} KB</span>
                    )}
                  </div>
                  <div className="text-gray-400 mt-0.5 truncate" title={img.originalUrl}>
                    原始路径: {img.originalUrl}
                  </div>
                  {img.resolvedUrl && img.resolvedUrl !== img.originalUrl && (
                    <div className="text-green-600 mt-0.5 truncate" title={img.resolvedUrl}>
                      已解析: {img.resolvedUrl}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 3. Provider 请求 — resolved mode + content array */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">3</span>
              Provider 请求 — 最终 Payload
            </h3>

            <div className="bg-gray-50 p-3 rounded text-xs space-y-1 mb-2">
              <div><span className="text-gray-500">resolved_mode:</span> <span className="font-medium">{providerPayload.resolved_mode || task.generation_mode}</span></div>
              <div><span className="text-gray-500">content items:</span> <span className="font-medium">{providerPayload.content_item_count ?? 0}</span></div>
              <div><span className="text-gray-500">reference_images_count:</span> <span className="font-medium">{providerPayload.reference_images_count ?? 0}</span></div>
              <div><span className="text-gray-500">first_frame:</span> <span className="font-medium">{providerPayload.first_frame_base64_status ?? 'none'}</span></div>
            </div>

            {/* 渲染后的 Prompt */}
            {providerPayload.prompt && (
              <div className="mb-2">
                <div className="text-xs text-gray-500 mb-1">Prompt (渲染后):</div>
                <div className="bg-gray-50 p-3 rounded text-xs text-gray-700 whitespace-pre-wrap break-all">
                  {providerPayload.prompt}
                </div>
              </div>
            )}

            {/* Content Array 详情 */}
            {providerPayload.content && providerPayload.content.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Content Array ({providerPayload.content.length} 项):</div>
                <div className="space-y-1">
                  {providerPayload.content.map((item, i) => {
                    const itemWithUnknown = item as Record<string, unknown>;
                    return (
                      <div key={i} className="bg-gray-50 p-2 rounded text-xs">
                        <span className="font-medium text-gray-700">[{i + 1}]</span>{' '}
                        <span className="text-blue-600">{String(itemWithUnknown.type || '')}</span>
                        {itemWithUnknown.role ? <span className="ml-1 text-gray-500">({String(itemWithUnknown.role)})</span> : null}
                        {itemWithUnknown.text ? <span className="ml-1 text-gray-600 truncate max-w-xs">"{String(itemWithUnknown.text).slice(0, 60)}..."</span> : null}
                        {itemWithUnknown.image_url ? <span className="ml-1 text-green-600 break-all">{String((itemWithUnknown.image_url as Record<string, unknown>).url || '').slice(0, 80)}</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 4. Provider 返回 */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs">4</span>
              Provider 返回
            </h3>
            {task.raw_create_response ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-blue-500 mb-1">raw_create_response</summary>
                <pre className="bg-gray-900 text-green-400 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap break-all">
                  {JSON.stringify(JSON.parse(task.raw_create_response || '{}'), null, 2)}
                </pre>
              </details>
            ) : (
              <span className="text-xs text-gray-400">暂无</span>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

function getStatusClass(status: string) {
  const statusMap: Record<string, string> = {
    draft: 'status-draft',
    submitted: 'status-submitted',
    running: 'status-running',
    succeeded: 'status-succeeded',
    failed: 'status-failed',
    cancelled: 'status-cancelled',
  };
  return statusMap[status] || 'status-draft';
}

function getStatusText(status: string) {
  const textMap: Record<string, string> = {
    draft: '草稿',
    submitted: '已提交',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return textMap[status] || status;
}

function costStatusLabel(status: string) {
  if (status === 'estimated_by_rule') return '规则预估';
  if (status === 'provisional_settled') return '临时结算';
  if (status === 'official_confirmed') return '官方确认';
  if (status === 'reconciled') return '已对账';
  if (status === 'failed_no_charge') return '失败未收费';
  if (status === 'unknown') return '待确认';
  if (status === 'disputed') return '异常';
  return '未记录';
}

function formatAmountMinor(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '待官方确认';
  const value = amount / 100;
  if (currency === 'USD') return `$${value.toFixed(2)}`;
  return `¥${value.toFixed(2)}`;
}

function formatProviderAmount(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined) return '待官方确认';
  const text = Number.isInteger(amount) ? amount.toFixed(2) : amount.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return currency ? `${text} ${currency}` : text;
}

function formatLedgerAmount(ledger: OfficialChargeLedger): string {
  if (ledger.amount_micros !== null && ledger.amount_micros !== undefined) {
    return formatProviderAmount(ledger.amount_micros / 1_000_000, ledger.currency);
  }
  return formatAmountMinor(ledger.amount_minor, ledger.currency);
}

function formatJson(str: string | null): string {
  if (!str) return '{}';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function parseJsonArray(str: string | null): string[] {
  if (!str) return [];
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function formatBillingTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number') {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toLocaleString('zh-CN');
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value)) {
    return formatBillingTime(numeric);
  }
  return formatDateTime(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function pickStringValue(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumberValue(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function usageTotalTokensFrom(value: unknown): { total: number | null; completion: number | null } {
  const usage = typeof value === 'string' ? parseJsonObject(value) : asRecord(value);
  return {
    total: pickNumberValue(usage, ['total_tokens', 'totalTokens']),
    completion: pickNumberValue(usage, ['completion_tokens', 'completionTokens']),
  };
}

function extractProviderBilling(task: VideoTask): ProviderBillingMeta {
  const raw = parseJsonObject(task.raw_status_response);
  const rawCandidates = [
    raw,
    asRecord(raw?.data),
    asRecord(raw?.result),
    asRecord(raw?.response),
  ].filter(Boolean) as Record<string, unknown>[];
  const firstWithValue = (keys: string[]) => {
    for (const candidate of rawCandidates) {
      const value = pickStringValue(candidate, keys);
      if (value) return value;
    }
    return null;
  };
  const firstNumberWithValue = (keys: string[]) => {
    for (const candidate of rawCandidates) {
      const value = pickNumberValue(candidate, keys);
      if (value !== null) return value;
    }
    return null;
  };
  const usageSnapshot = parseJsonObject(task.provider_usage_snapshot);
  const usageFromRaw = rawCandidates.map((candidate) => candidate.usage).find((value) => value !== undefined);
  const usage = usageTotalTokensFrom(usageSnapshot || usageFromRaw);

  return {
    actualCost: firstNumberWithValue(['actual_cost', 'actualCost']),
    currency: task.provider_cost_currency || firstWithValue(['currency_or_credit_type', 'currencyOrCreditType', 'currency']),
    billingStatus: task.provider_billing_status || firstWithValue(['billing_status', 'billingStatus']),
    billingTime: task.provider_billing_time || firstNumberWithValue(['billing_time', 'billingTime']) || firstWithValue(['billing_time', 'billingTime']),
    usageTotalTokens: usage.total,
    completionTokens: usage.completion,
    providerTaskId: task.provider_task_id || firstWithValue(['provider_task_id', 'providerTaskId', 'task_id', 'id']),
    clientRequestId: task.provider_client_request_id || firstWithValue(['clientRequestId', 'client_request_id', 'client_requestId']),
  };
}

function normalizeOfficialChargeLedger(value: unknown): OfficialChargeLedger | null {
  const record = asRecord(value);
  if (!record) return null;
  const eventType = pickStringValue(record, ['event_type', 'eventType']);
  if (eventType && eventType !== 'official_charge') return null;
  const id = pickStringValue(record, ['id', 'ledger_id', 'ledgerId']);
  if (!id) return null;
  return {
    id,
    event_type: eventType || 'official_charge',
    amount_minor: pickNumberValue(record, ['amount_minor', 'amountMinor']),
    amount_micros: pickNumberValue(record, ['amount_micros', 'amountMicros']),
    currency: pickStringValue(record, ['currency']),
    provider_task_id: pickStringValue(record, ['provider_task_id', 'providerTaskId']),
    billing_status: pickStringValue(record, ['billing_status', 'billingStatus']),
    billing_time: pickStringValue(record, ['billing_time', 'billingTime']) || pickNumberValue(record, ['billing_time', 'billingTime']),
    usage_total_tokens: pickNumberValue(record, ['usage_total_tokens', 'usageTotalTokens', 'total_tokens', 'totalTokens']),
    usage_quantity: pickNumberValue(record, ['usage_quantity', 'usageQuantity']),
    usage_unit: pickStringValue(record, ['usage_unit', 'usageUnit']),
    official_charge_id: pickStringValue(record, ['official_charge_id', 'officialChargeId']),
    confidence: pickStringValue(record, ['confidence']),
    cost_source: pickStringValue(record, ['cost_source', 'costSource']),
    occurred_at: pickStringValue(record, ['occurred_at', 'occurredAt']),
    created_at: pickStringValue(record, ['created_at', 'createdAt']),
  };
}

function extractEmbeddedOfficialCharges(task: VideoTask): OfficialChargeLedger[] {
  const candidates = [
    task.cost_ledgers,
    task.costLedgers,
    (task as unknown as { official_charge_ledgers?: unknown[] }).official_charge_ledgers,
    (task as unknown as { officialCharges?: unknown[] }).officialCharges,
  ];
  return candidates
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
    .map(normalizeOfficialChargeLedger)
    .filter((ledger): ledger is OfficialChargeLedger => Boolean(ledger));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCostLedgerCsv(csv: string, taskId: string): OfficialChargeLedger[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return headers.reduce<Record<string, string>>((row, header, index) => {
      row[header] = cells[index] || '';
      return row;
    }, {});
  }).filter((row) => row.task_id === taskId && row.event_type === 'official_charge').map((row) => normalizeOfficialChargeLedger({
    id: row.ledger_id,
    event_type: row.event_type,
    amount_minor: row.amount_minor,
    currency: row.currency,
    provider_task_id: row.provider_task_id,
    usage_quantity: row.usage_quantity,
    usage_unit: row.usage_unit,
    official_charge_id: row.official_charge_id,
    confidence: row.confidence,
    cost_source: row.cost_source,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  })).filter((ledger): ledger is OfficialChargeLedger => Boolean(ledger));
}

function mergeLedgers(current: OfficialChargeLedger[], incoming: OfficialChargeLedger[]) {
  const map = new Map<string, OfficialChargeLedger>();
  [...current, ...incoming].forEach((ledger) => {
    map.set(ledger.id, { ...map.get(ledger.id), ...ledger });
  });
  return Array.from(map.values()).sort((a, b) => {
    const aTime = new Date(a.occurred_at || a.created_at || 0).getTime();
    const bTime = new Date(b.occurred_at || b.created_at || 0).getTime();
    return bTime - aTime;
  });
}

function shortId(value: string | null | undefined, length = 10): string {
  if (!value) return '-';
  if (value.length <= length) return value;
  return `${value.slice(0, length)}...`;
}

function truncateUrl(value: string, length = 56): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length)}...`;
}

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const [task, setTask] = useState<VideoTask | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [movingProject, setMovingProject] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState('');
  const [moveReason, setMoveReason] = useState('项目成本归属调整');
  const [moveMessage, setMoveMessage] = useState('');
  const [officialCharges, setOfficialCharges] = useState<OfficialChargeLedger[]>([]);
  const [officialChargeStatus, setOfficialChargeStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');

  // 下载状态
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  
  // 视频预览错误状态
  const [videoError, setVideoError] = useState(false);
  const [copied, setCopied] = useState(false);

  // 显示原始响应
  const [showCreateResponse, setShowCreateResponse] = useState(false);
  const [showStatusResponse, setShowStatusResponse] = useState(false);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/video/status/${taskId}`);
      const data = await res.json();
      if (res.ok) {
        setTask(data);
        setTargetProjectId(data.project_id || '');
        setVideoError(false);
        const embeddedLedgers = extractEmbeddedOfficialCharges(data);
        if (embeddedLedgers.length > 0) {
          setOfficialCharges((current) => mergeLedgers(current, embeddedLedgers));
          setOfficialChargeStatus('ready');
        }
      }
    } catch (error) {
      console.error('Failed to fetch task:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects?include_archived=true&include_all=true', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) {
        setProjects((data.projects || []).filter((project: ProjectOption) => (
          project.status === 'active' && project.type !== 'system'
        )));
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  }, []);

  const fetchOfficialCharges = useCallback(async () => {
    setOfficialChargeStatus('loading');
    try {
      const res = await fetch('/api/admin/costs/export', { cache: 'no-store' });
      if (!res.ok) {
        setOfficialChargeStatus((current) => current === 'ready' ? current : 'unavailable');
        return;
      }
      const csv = await res.text();
      const ledgers = parseCostLedgerCsv(csv, taskId);
      setOfficialCharges((current) => mergeLedgers(current, ledgers));
      setOfficialChargeStatus('ready');
    } catch (error) {
      console.error('Failed to fetch official charge ledgers:', error);
      setOfficialChargeStatus((current) => current === 'ready' ? current : 'error');
    }
  }, [taskId]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    fetchOfficialCharges();
  }, [fetchOfficialCharges]);

  // Auto polling
  useEffect(() => {
    if (!autoPoll) return;

    const interval = setInterval(() => {
      fetchTask();
    }, 5000);

    return () => clearInterval(interval);
  }, [autoPoll, fetchTask]);

  // Stop polling when task is terminal
  useEffect(() => {
    if (task && ['succeeded', 'failed', 'cancelled'].includes(task.local_status)) {
      setAutoPoll(false);
    }
  }, [task]);

  const queryStatus = async () => {
    setQuerying(true);
    await fetchTask();
    await fetchOfficialCharges();
    setQuerying(false);
  };

  // 重新查询结果 — 强制刷新最新结果（可用于"其实生成好了但前端没更新"的情况）
  const handleReQueryResult = async () => {
    setQuerying(true);
    // 直接调用 status API 强制 getResult
    try {
      const res = await fetch(`/api/video/status/${taskId}`);
      const data = await res.json();
      if (res.ok) {
        const hadVideoBefore = task?.result_video_url;
        setTask(data);
        setVideoError(false);
        const embeddedLedgers = extractEmbeddedOfficialCharges(data);
        if (embeddedLedgers.length > 0) {
          setOfficialCharges((current) => mergeLedgers(current, embeddedLedgers));
          setOfficialChargeStatus('ready');
        }
        await fetchOfficialCharges();
        // 如果之前没有视频，现在有了，说明结果刚就绪
        if (data.result_video_url && !hadVideoBefore) {
          alert('视频已就绪，请刷新查看');
        }
      }
    } catch (error) {
      console.error('Re-query failed:', error);
    } finally {
      setQuerying(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/video/retry/${taskId}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        router.push(`/tasks/${data.id}`);
      } else {
        alert(`重试失败: ${data.message}`);
      }
    } catch (error) {
      alert(`重试失败: ${error}`);
    } finally {
      setRetrying(false);
    }
  };

  const handleMoveProject = async () => {
    if (!task || !targetProjectId || targetProjectId === task.project_id) return;
    setMovingProject(true);
    setMoveMessage('');
    try {
      const res = await fetch(`/api/tasks/${task.id}/project`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: targetProjectId,
          reason: moveReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMoveMessage(data.error || data.message || '移动项目失败');
        return;
      }
      setTask(data.task);
      setTargetProjectId(data.task.project_id || '');
      setMoveMessage('任务已移动，成本归属流水已记录');
    } catch (error) {
      setMoveMessage(error instanceof Error ? error.message : '移动项目失败');
    } finally {
      setMovingProject(false);
    }
  };

  // 后端下载视频（支持进度追踪）
  const handleDownloadToLocal = async () => {
    if (!task) return;
    
    setDownloading(true);
    setDownloadProgress('正在下载视频...');
    setDownloadPercent(0);
    setDownloadSpeed('');
    setDownloadError(null);
    
    const startTime = Date.now();
    let lastUpdateTime = startTime;
    let lastBytes = 0;
    
    try {
      const res = await fetch(`/api/video/download/${taskId}`, {
        method: 'POST',
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const fileSizeMB = (data.file_size / 1024 / 1024).toFixed(2);
        
        setDownloadProgress(`✅ 下载完成! 文件大小: ${fileSizeMB} MB，耗时: ${elapsed}s`);
        setDownloadPercent(100);
        setDownloadSpeed('');
        
        // 如果文件已存在，提示用户
        if (data.already_exists) {
          setDownloadProgress(`✅ 视频已存在于本地: ${fileSizeMB} MB`);
        }
        
        await fetchTask();
      } else {
        const errorMsg = data.message || data.error || '未知错误';
        setDownloadError(errorMsg);
        setDownloadProgress(`❌ 下载失败: ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setDownloadError(errorMsg);
      setDownloadProgress(`❌ 下载失败: ${errorMsg}`);
    } finally {
      setDownloading(false);
    }
  };

  // 复制视频 URL
  const handleCopyUrl = () => {
    if (task?.result_video_url) {
      navigator.clipboard.writeText(task.result_video_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 直接打开视频 URL
  const handleOpenUrl = () => {
    if (task?.result_video_url) {
      window.open(task.result_video_url, '_blank');
    }
  };

  // 获取视频播放源
  const getVideoSrc = () => {
    if (!task) return '';
    if (task.local_video_path) {
      return task.local_video_path;
    }
    return task.result_video_url || '';
  };

  if (loading) {
    return (
      <div className="card">
        <p className="text-gray">加载中...</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="card">
        <p className="text-red">任务不存在</p>
        <Link href="/tasks" className="btn btn-secondary mt-4">
          返回列表
        </Link>
      </div>
    );
  }

  const referenceImages = parseJsonArray(task.reference_image_urls);
  const referenceVideos = parseJsonArray(task.reference_video_urls);
  const referenceAudios = parseJsonArray(task.reference_audio_urls);
  const frameImages = parseJsonArray(task.frame_image_urls);
  const videoSrc = getVideoSrc();
  const hasLocalVideo = !!task.local_video_path;
  
  // 从 provider_payload_json 解析 resolved_mode
  const resolvedMode = (() => {
    if (!task.provider_payload_json) return null;
    try {
      const payload = JSON.parse(task.provider_payload_json);
      return payload.resolved_mode || null;
    } catch {
      return null;
    }
  })();

  const referenceAssets: ReferenceAssetMeta[] = (() => {
    if (!task.params_json) return [];
    try {
      const params = JSON.parse(task.params_json);
      if (!Array.isArray(params.referenceAssets)) return [];
      return [...params.referenceAssets].sort((a, b) => a.order - b.order);
    } catch {
      return [];
    }
  })();

  const refImagesDebug: RefImageDebugEntry[] = (() => {
    if (!task.reference_images_json) return [];
    try {
      const parsed = JSON.parse(task.reference_images_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const providerPayload: ProviderPayloadDebug = (() => {
    if (!task.provider_payload_json) return {};
    try {
      return JSON.parse(task.provider_payload_json);
    } catch {
      return {};
    }
  })();

  const providerBilling = extractProviderBilling(task);
  const hasResultVideo = task.local_status === 'succeeded' && !!videoSrc;
  const isProcessing = ['submitted', 'running'].includes(task.local_status);
  const modeLabel = GENERATION_MODE_LABELS[task.generation_mode] || task.generation_mode;
  const resolvedModeLabel = resolvedMode && resolvedMode !== task.generation_mode ? resolvedMode : null;
  const resultStateTitle = task.local_status === 'failed'
    ? '生成失败'
    : isProcessing
      ? '生成中'
      : hasResultVideo
        ? '生成结果'
        : '暂无结果';

  const parameterItems = [
    { label: '模型', value: task.model || 'Seedance 2.0' },
    { label: '模式', value: modeLabel },
    { label: '比例', value: task.ratio || '-' },
    { label: '时长', value: task.duration ? `${task.duration} 秒` : '-' },
    { label: '分辨率', value: task.resolution || '-' },
    { label: '随机种子', value: task.seed === -1 ? '随机' : (task.seed ?? '-') },
    { label: '音频', value: task.generate_audio ? '开启' : '关闭' },
    { label: '尾帧', value: task.return_last_frame ? '返回' : '不返回' },
    { label: '水印', value: task.watermark ? '开启' : '关闭' },
  ];

  const timelineItems = [
    { label: '创建', value: formatDateTime(task.created_at) },
    { label: '更新', value: formatDateTime(task.updated_at) },
    { label: '完成', value: formatDateTime(task.completed_at) },
  ];
  const officialCostMicros = task.provider_final_amount_micros ?? task.provider_official_amount_micros;
  const officialCostMinor = task.provider_final_amount_minor ?? task.provider_official_amount_minor;
  const officialCostText = officialCostMicros !== null && officialCostMicros !== undefined
    ? formatProviderAmount(officialCostMicros / 1_000_000, task.provider_cost_currency)
    : officialCostMinor !== null && officialCostMinor !== undefined
      ? formatAmountMinor(officialCostMinor, task.provider_cost_currency)
      : formatProviderAmount(providerBilling.actualCost, providerBilling.currency);
  const officialBillingTime = providerBilling.billingTime || task.provider_cost_confirmed_at;

  return (
    <div className="task-detail-page">
      <div className="task-detail-header">
        <div className="task-detail-nav">
          <Link href="/tasks" className="task-detail-back">返回任务列表</Link>
          <Link href="/generate" className="btn btn-primary">创建新任务</Link>
        </div>
        <div className="task-detail-title-row">
          <div>
            <div className="task-detail-kicker">任务 {shortId(task.id, 12)}</div>
            <h1 className="task-detail-title">{resultStateTitle}</h1>
            <p className="task-detail-subtitle">{task.prompt || '无提示词'}</p>
          </div>
          <span className={`status-badge ${getStatusClass(task.local_status)}`}>
            {getStatusText(task.local_status)}
          </span>
        </div>
      </div>

      <div className="task-detail-layout">
        <main className="task-detail-main">
          <section className="task-detail-card task-result-panel">
            <div className="task-card-head">
              <div>
                <h2>生成结果</h2>
                <p>{hasLocalVideo ? '本地已保存' : task.result_video_url ? '远程结果可用' : '等待 Provider 返回结果'}</p>
              </div>
              <div className="task-action-row">
                <button className="btn btn-secondary" onClick={queryStatus} disabled={querying}>
                  {querying ? '查询中...' : '查询状态'}
                </button>
                {isProcessing && (
                  <button className="btn btn-secondary" onClick={handleReQueryResult} disabled={querying}>
                    {querying ? '查询中...' : '重新查询结果'}
                  </button>
                )}
                {task.local_status === 'failed' && (
                  <button className="btn btn-danger" onClick={handleRetry} disabled={retrying}>
                    {retrying ? '重试中...' : '重新生成'}
                  </button>
                )}
              </div>
            </div>

            <div className="task-result-stage">
              {hasResultVideo ? (
                <video
                  key={videoSrc}
                  controls
                  playsInline
                  src={videoSrc}
                  onError={() => setVideoError(true)}
                  onCanPlay={() => setVideoError(false)}
                >
                  您的浏览器不支持视频播放
                </video>
              ) : (
                <div className={`task-result-empty task-result-empty-${task.local_status}`}>
                  <strong>{resultStateTitle}</strong>
                  <span>
                    {task.local_status === 'failed'
                      ? (task.error_message || 'Provider 返回失败，请查看下方错误信息或重试。')
                      : isProcessing
                        ? '任务仍在生成中，可手动查询或开启自动轮询。'
                        : '当前任务还没有可播放的视频结果。'}
                  </span>
                </div>
              )}
            </div>

            {videoError && (
              <div className="alert alert-warning">
                视频预览失败。可以直接打开远程链接，或复制 URL 到浏览器检查。
              </div>
            )}

            {task.result_last_frame_url && (
              <div className="task-last-frame">
                <span className="task-muted-label">尾帧图片</span>
                <img
                  src={task.result_last_frame_url}
                  alt="Last Frame"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            )}

            <div className="task-result-actions">
              <button className="btn btn-secondary" onClick={handleOpenUrl} disabled={!task.result_video_url}>
                打开远程视频
              </button>
              <button className="btn btn-secondary" onClick={handleCopyUrl} disabled={!task.result_video_url}>
                {copied ? '已复制' : '复制视频 URL'}
              </button>
              <button className="btn btn-primary" onClick={handleDownloadToLocal} disabled={downloading || hasLocalVideo || !task.result_video_url}>
                {downloading ? '下载中...' : hasLocalVideo ? '已保存到本地' : '转存到本地'}
              </button>
              {downloadError && (
                <button className="btn btn-secondary" onClick={handleDownloadToLocal}>
                  重试下载
                </button>
              )}
              <label className="task-poll-toggle">
                <span>自动轮询</span>
                <div className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={autoPoll}
                    onChange={(e) => setAutoPoll(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </div>
              </label>
            </div>

            {(downloading || downloadProgress) && (
              <div className="task-download-state">
                <div className="task-download-meta">
                  <span>{downloading ? '下载中' : '下载状态'}</span>
                  <span>{downloadPercent}%{downloadSpeed && ` · ${downloadSpeed}`}</span>
                </div>
                <div className="task-progress-track">
                  <div
                    className={`task-progress-fill ${downloadError ? 'is-error' : downloading ? 'is-running' : 'is-done'}`}
                    style={{ width: `${downloadPercent}%` }}
                  />
                </div>
                <p className={downloadError ? 'task-download-error' : ''}>{downloadProgress}</p>
              </div>
            )}
          </section>

          {task.local_status === 'failed' && task.error_message && (
            <section className="task-detail-card task-error-card">
              <div className="task-card-head">
                <h2>错误信息</h2>
              </div>
              <p>{task.error_message}</p>
            </section>
          )}

          <section className="task-detail-card">
            <div className="task-card-head">
              <div>
                <h2>官方扣费明细</h2>
                <p>这里展示 Provider 官方真实成本；它和用户内部点数扣除是两套账。</p>
              </div>
            </div>

            <div className="task-param-grid">
              <div className="task-param-item">
                <span>官方成本状态</span>
                <strong>{costStatusLabel(task.provider_cost_status)}</strong>
              </div>
              <div className="task-param-item">
                <span>官方真实成本</span>
                <strong>{officialCostText}</strong>
              </div>
              <div className="task-param-item">
                <span>Provider 返回扣费</span>
                <strong>{formatProviderAmount(providerBilling.actualCost, providerBilling.currency)}</strong>
              </div>
              <div className="task-param-item">
                <span>billing_status</span>
                <strong>{providerBilling.billingStatus || '待官方确认'}</strong>
              </div>
              <div className="task-param-item">
                <span>billing_time</span>
                <strong>{formatBillingTime(officialBillingTime)}</strong>
              </div>
              <div className="task-param-item">
                <span>usage total_tokens</span>
                <strong>{providerBilling.usageTotalTokens ?? '待官方确认'}</strong>
              </div>
              <div className="task-param-item">
                <span>provider_task_id</span>
                <strong title={providerBilling.providerTaskId || ''}>{shortId(providerBilling.providerTaskId, 16)}</strong>
              </div>
              <div className="task-param-item">
                <span>clientRequestId</span>
                <strong title={providerBilling.clientRequestId || ''}>{shortId(providerBilling.clientRequestId, 16)}</strong>
              </div>
            </div>

            {officialChargeStatus === 'loading' && officialCharges.length === 0 && (
              <div className="task-empty-line">正在读取 official_charge 账本...</div>
            )}

            {officialCharges.length > 0 ? (
              <div className="task-reference-list">
                {officialCharges.map((ledger) => {
                  const ledgerBillingTime = ledger.billing_time || officialBillingTime || ledger.occurred_at;
                  const ledgerUsageTokens = ledger.usage_total_tokens ?? providerBilling.usageTotalTokens;
                  return (
                    <div key={ledger.id} className="task-empty-line">
                      <div className="task-param-grid" style={{ marginBottom: 0 }}>
                        <div className="task-param-item">
                          <span>ledger_id</span>
                          <strong title={ledger.id}>{shortId(ledger.id, 18)}</strong>
                        </div>
                        <div className="task-param-item">
                          <span>金额</span>
                          <strong>{formatLedgerAmount(ledger)}</strong>
                        </div>
                        <div className="task-param-item">
                          <span>币种</span>
                          <strong>{ledger.currency || providerBilling.currency || '-'}</strong>
                        </div>
                        <div className="task-param-item">
                          <span>billing_status</span>
                          <strong>{ledger.billing_status || providerBilling.billingStatus || '待官方确认'}</strong>
                        </div>
                        <div className="task-param-item">
                          <span>billing_time / occurred_at</span>
                          <strong>{formatBillingTime(ledgerBillingTime)}</strong>
                        </div>
                        <div className="task-param-item">
                          <span>usage total_tokens</span>
                          <strong>{ledgerUsageTokens ?? '待官方确认'}</strong>
                        </div>
                        <div className="task-param-item">
                          <span>provider_task_id</span>
                          <strong title={ledger.provider_task_id || providerBilling.providerTaskId || ''}>
                            {shortId(ledger.provider_task_id || providerBilling.providerTaskId, 16)}
                          </strong>
                        </div>
                        <div className="task-param-item">
                          <span>official_charge_id</span>
                          <strong title={ledger.official_charge_id || ''}>{shortId(ledger.official_charge_id, 16)}</strong>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : officialChargeStatus !== 'loading' ? (
              <div className="task-empty-line">
                暂无该任务的 official_charge 账本记录。
                {officialChargeStatus === 'unavailable'
                  ? ' 当前账号可能没有读取总账权限，已显示任务和 Provider 返回字段作为兜底。'
                  : ' 等 Seedance 返回 actual_cost 并完成入账后，这里会出现对应账本行。'}
              </div>
            ) : null}
          </section>

          <section className="task-detail-card">
            <div className="task-card-head">
              <div>
                <h2>提示词与参考素材</h2>
                <p>按提交时的顺序展示，便于对应提示词里的图 1、图 2。</p>
              </div>
            </div>

            <div className="task-prompt-box">{task.prompt || '无提示词'}</div>

            <div className="task-param-grid">
              {parameterItems.map((item) => (
                <div key={item.label} className="task-param-item">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
              {resolvedModeLabel && (
                <div className="task-param-item">
                  <span>Resolved 模式</span>
                  <strong>{resolvedModeLabel}</strong>
                </div>
              )}
            </div>

            {(referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0 || frameImages.length > 0 || task.first_frame_url || task.last_frame_url) ? (
              <div className="task-reference-section">
                {referenceImages.length > 0 && (
                  <div>
                    <div className="task-muted-label">参考图片 ({referenceImages.length})</div>
                    <div className="task-reference-grid">
                      {referenceImages.map((url, i) => (
                        <a key={url + i} className="task-reference-thumb" href={url} target="_blank" rel="noopener noreferrer" title={url}>
                          <img src={url} alt={`参考图片 ${i + 1}`} />
                          <span>图 {i + 1}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {frameImages.length > 0 && (
                  <div>
                    <div className="task-muted-label">多帧图片 ({frameImages.length})</div>
                    <div className="task-reference-list">
                      {frameImages.map((url, i) => (
                        <a key={url + i} href={url} target="_blank" rel="noopener noreferrer">
                          第 {i + 1} 帧 · {truncateUrl(url)}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {(task.first_frame_url || task.last_frame_url) && (
                  <div>
                    <div className="task-muted-label">首尾帧</div>
                    <div className="task-reference-list">
                      {task.first_frame_url && (
                        <a href={task.first_frame_url} target="_blank" rel="noopener noreferrer">
                          首帧 · {truncateUrl(task.first_frame_url)}
                        </a>
                      )}
                      {task.last_frame_url && (
                        <a href={task.last_frame_url} target="_blank" rel="noopener noreferrer">
                          尾帧 · {truncateUrl(task.last_frame_url)}
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {referenceVideos.length > 0 && (
                  <div>
                    <div className="task-muted-label">参考视频 ({referenceVideos.length})</div>
                    <div className="task-reference-list">
                      {referenceVideos.map((url, i) => (
                        <a key={url + i} href={url} target="_blank" rel="noopener noreferrer">
                          视频 {i + 1} · {truncateUrl(url)}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {referenceAudios.length > 0 && (
                  <div>
                    <div className="task-muted-label">参考音频 ({referenceAudios.length})</div>
                    <div className="task-reference-list">
                      {referenceAudios.map((url, i) => (
                        <a key={url + i} href={url} target="_blank" rel="noopener noreferrer">
                          音频 {i + 1} · {truncateUrl(url)}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="task-empty-line">本任务没有参考素材。</div>
            )}
          </section>

          {referenceAssets.length > 0 && (
            <section className="task-detail-card">
              <div className="task-card-head">
                <div>
                  <h2>Seedance 参考图资产</h2>
                  <p>{referenceAssets.length} 张 Provider 资产，按提交顺序展示。</p>
                </div>
              </div>
              <div className="task-asset-grid">
                {referenceAssets.map((asset, i) => {
                  const imgUrl = asset.providerPreviewUrl || asset.originalUrl;
                  return (
                    <div key={asset.localAssetId} className="task-asset-thumb">
                      <div className="task-asset-image">
                        {imgUrl ? (
                          <img
                            src={imgUrl}
                            alt={asset.name}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : null}
                        <span>{i + 1}</span>
                      </div>
                      <strong title={asset.name}>{asset.name}</strong>
                      <small title={asset.providerAssetId}>{shortId(asset.providerAssetId, 12)}</small>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <details className="task-detail-card task-manage-panel">
            <summary>项目归属调整</summary>
            <div className="project-move-panel task-project-move">
              <div>
                <div className="info-label">移动到其他项目</div>
                <p className="text-gray text-sm">用于修正选错项目后的成本归属，旧账本不会被覆盖，会追加转移记录。</p>
              </div>
              <select className="input" value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)}>
                <option value="">选择目标项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}{project.type === 'personal' ? ' · 个人' : ''}
                  </option>
                ))}
              </select>
              <input
                className="input"
                value={moveReason}
                onChange={(event) => setMoveReason(event.target.value)}
                placeholder="移动原因"
              />
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleMoveProject}
                disabled={movingProject || !targetProjectId || targetProjectId === task.project_id}
              >
                {movingProject ? '移动中...' : '移动项目'}
              </button>
              {moveMessage && <p className="task-move-message">{moveMessage}</p>}
            </div>
          </details>

          <details className="task-detail-card task-technical-panel">
            <summary>技术调试与原始响应</summary>
            <ReferenceImageDebug
              task={task}
              refImagesDebug={refImagesDebug}
              providerPayload={providerPayload}
            />

            <div className="task-raw-grid">
              <div className="collapsible">
                <div
                  className="collapsible-header"
                  onClick={() => setShowCreateResponse(!showCreateResponse)}
                >
                  <span>创建任务响应</span>
                  <span>{showCreateResponse ? '收起' : '展开'}</span>
                </div>
                {showCreateResponse && (
                  <div className="collapsible-content">
                    <div className="json-viewer">
                      {formatJson(task.raw_create_response)}
                    </div>
                  </div>
                )}
              </div>

              <div className="collapsible">
                <div
                  className="collapsible-header"
                  onClick={() => setShowStatusResponse(!showStatusResponse)}
                >
                  <span>状态查询响应</span>
                  <span>{showStatusResponse ? '收起' : '展开'}</span>
                </div>
                {showStatusResponse && (
                  <div className="collapsible-content">
                    <div className="json-viewer">
                      {formatJson(task.raw_status_response)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </details>
        </main>

        <aside className="task-detail-sidebar">
          <section className="task-side-card">
            <h2>任务概览</h2>
            <div className="task-summary-list">
              <div>
                <span>项目</span>
                <strong>
                  {task.project ? (
                    <Link className="table-link" href={`/projects/${task.project.id}`}>{task.project.name}</Link>
                  ) : (
                    <span className="text-red">未归属</span>
                  )}
                </strong>
              </div>
              <div>
                <span>Provider 状态</span>
                <strong>{task.provider_status || '-'}</strong>
              </div>
              <div>
                <span>官方成本状态</span>
                <strong>{costStatusLabel(task.provider_cost_status)} · {task.cost_allocation_status}</strong>
              </div>
              <div>
                <span>官方真实成本</span>
                <strong>{officialCostText}</strong>
              </div>
              <div>
                <span>内部点数扣除</span>
                <strong>预估 {task.estimated_cost ?? '-'} / 冻结 {task.frozen_cost ?? 0} / 扣除 {task.actual_cost ?? '-'} / 返还 {task.refund_amount ?? 0}</strong>
              </div>
              <div>
                <span>official_charge 账本</span>
                <strong>{officialCharges.length > 0 ? `${officialCharges.length} 条` : '待官方确认'}</strong>
              </div>
              <div>
                <span>本地任务 ID</span>
                <strong title={task.id}>{shortId(task.id, 14)}</strong>
              </div>
              <div>
                <span>Provider ID</span>
                <strong title={task.provider_task_id || ''}>{shortId(task.provider_task_id, 14)}</strong>
              </div>
            </div>
          </section>

          <section className="task-side-card">
            <h2>时间线</h2>
            <div className="task-summary-list">
              {timelineItems.map((item) => (
                <div key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
              {task.provider_cost_confirmed_at && (
                <div>
                  <span>成本确认</span>
                  <strong>{formatDateTime(task.provider_cost_confirmed_at)}</strong>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
