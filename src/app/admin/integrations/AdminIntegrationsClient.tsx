'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PageBanner from '@/components/PageBanner';
import Link from 'next/link';
import { useProductDialog } from '@/components/useProductDialog';
import ModelOptionsField, { type ModelOption } from '@/components/ModelOptionsField';
import { useSettingsPageSubmit } from '@/lib/hooks/use-settings-page-submit';
import { RelativeTime } from '@/components/RelativeTime';
import { LoadingSkeleton } from '@/components/LoadingState';
import ImageModelApiSettings from './ImageModelApiSettings';
import ImageQualityRoutingSettings from './ImageQualityRoutingSettings';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import dialogStyles from '@/components/ProductDialog.module.css';
import { Settings, X } from 'lucide-react';
import { STUDIO_TEXT_MODELS } from '@/lib/template-studio/text-models';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { displayUserSubtitle } from '@/lib/users/display';
import { VOLCENGINE_IP_MODEL_OPTIONS } from '@/lib/integrations/volcengine-ip-models';
import { IMAGE_API_GROUPS } from '@/lib/integrations/image-generation-channel';
import { useAppSession } from '@/lib/context/AppSessionContext';
import workbenchStyles from './workbench.module.css';

type UserSelectorType = 'id' | 'email' | 'username';
const INTEGRATION_OBJECTS = [
  ['image', '图片模型'], ['h3-video', '视频服务 · H3'], ['volcengine-ip', '视频服务 · 火山 IP'],
  ['aimediakit-enhance-video', '视频超分 · AI MediaKit'], ['text', '文字服务 · Musk'], ['codex', '外部接入 · Codex 视频'],
] as const;

type CodexConfig = {
  enabled: boolean;
  ready: boolean;
  source_label: string;
  user_selector: {
    type: UserSelectorType;
    value: string;
  };
  token_configured: boolean;
  token_preview: string | null;
  linked_user: {
    id: string;
    name: string;
    username: string;
    email: string;
    avatar_url?: string | null;
    account_type?: string | null;
    role: string;
    status: string;
  } | null;
};

type MuskConfig = {
  enabled: boolean;
  ready: boolean;
  base_url: string;
  default_model: string;
  allowed_models: string[];
  api_key_configured: boolean;
};

type VolcengineIpConfig = {
  enabled: boolean;
  ready: boolean;
  provider: 'volcengine_ip';
  base_url: string;
  create_task_path: string;
  default_model: string;
  model: string;
  api_key_configured: boolean;
  model_configured: boolean;
  missing: Array<'api_key' | 'model'>;
};

type AiMediaKitConfig = {
  enabled: boolean;
  ready: boolean;
  provider: 'aimediakit_enhance_video';
  base_url: string;
  enhance_video_path: string;
  task_status_path: string;
  request_upload_path: string;
  api_key_configured: boolean;
  missing: Array<'api_key'>;
};

type H3Config = {
  enabled: boolean;
  ready: boolean;
  configured: boolean;
  admin_queue_ready: boolean;
  provider: 'h3_video';
  base_url: string;
  health_path: string;
  presets_path: string;
  generate_path: string;
  default_preset_id: 'lightx2v_4step_turbo' | 'larry_v4_6step' | 'larry_v4_8step';
  default_lora_id: 'lightx2v_turbo_lora' | 'larry_v4_turbo_lora';
  preset_options: Array<{
    id: 'lightx2v_4step_turbo' | 'larry_v4_6step' | 'larry_v4_8step';
    label: string;
    detail: string;
  }>;
  lora_options: Array<{
    id: 'lightx2v_turbo_lora' | 'larry_v4_turbo_lora';
    label: string;
    detail: string;
  }>;
  api_token_configured: boolean;
  admin_token_configured: boolean;
  health: {
    api: string | null;
    worker: string | null;
    comfyui: string | null;
    worker_url: string | null;
    preset_count: number | null;
    checked_at: string | null;
  } | null;
  missing: Array<'api_token' | 'preset'>;
};

type SubmitState = {
  type: 'success' | 'error';
  message: string;
} | null;

type MuskTestState = {
  type: 'success' | 'error';
  message: string;
  model?: string;
  latency_ms?: number;
  tested_at?: string;
} | null;

type H3TestState = {
  type: 'success' | 'error';
  message: string;
  tested_at?: string;
  health_api?: string;
  worker?: string;
  comfyui?: string;
} | null;

const EMPTY_CONFIG: CodexConfig = {
  enabled: false,
  ready: false,
  source_label: 'Codex API',
  user_selector: {
    type: 'email',
    value: 'admin@local.test',
  },
  token_configured: false,
  token_preview: null,
  linked_user: null,
};

const EMPTY_MUSK_CONFIG: MuskConfig = {
  enabled: false,
  ready: false,
  base_url: 'https://api.muskapis.com/',
  default_model: 'gpt-5.5',
  allowed_models: [],
  api_key_configured: false,
};

const EMPTY_VOLCENGINE_IP_CONFIG: VolcengineIpConfig = {
  enabled: false,
  ready: false,
  provider: 'volcengine_ip',
  base_url: 'https://ark.cn-beijing.volces.com/api/v3',
  create_task_path: '/contents/generations/tasks',
  default_model: '',
  model: '',
  api_key_configured: false,
  model_configured: false,
  missing: ['api_key', 'model'],
};

const EMPTY_AIMEDIAKIT_CONFIG: AiMediaKitConfig = {
  enabled: false,
  ready: false,
  provider: 'aimediakit_enhance_video',
  base_url: 'https://mediakit.cn-beijing.volces.com',
  enhance_video_path: '/api/v1/tools/enhance-video',
  task_status_path: '/api/v1/tasks/{task_id}',
  request_upload_path: '/api/v1/tools-sync/request-media-upload-url',
  api_key_configured: false,
  missing: ['api_key'],
};

const EMPTY_H3_CONFIG: H3Config = {
  enabled: false,
  ready: false,
  configured: false,
  admin_queue_ready: false,
  provider: 'h3_video',
  base_url: 'http://127.0.0.1:8893',
  health_path: '/health',
  presets_path: '/api/h3/presets',
  generate_path: '/api/h3/generate',
  default_preset_id: 'lightx2v_4step_turbo',
  default_lora_id: 'lightx2v_turbo_lora',
  preset_options: [
    { id: 'lightx2v_4step_turbo', label: '推荐', detail: '默认 · 速度优先，显存风险更低' },
    { id: 'larry_v4_6step', label: '质量增强', detail: '质量更好但更慢，720P 长秒数有显存风险' },
    { id: 'larry_v4_8step', label: '画质优先', detail: '更多步数，更慢，适合谨慎测试' },
  ],
  lora_options: [
    { id: 'lightx2v_turbo_lora', label: 'LightX2V 快速 LoRA', detail: '默认 · 4-step turbo，显存压力更低，适合先跑通' },
    { id: 'larry_v4_turbo_lora', label: 'Larry 高质量 LoRA', detail: '画质优先，15 秒 16:9 场景显存风险更高' },
  ],
  api_token_configured: false,
  admin_token_configured: false,
  health: null,
  missing: ['api_token'],
};

function normalizeH3Config(value: unknown): H3Config {
  const input = value && typeof value === 'object' ? value as Partial<H3Config> : {};
  return {
    ...EMPTY_H3_CONFIG,
    ...input,
    preset_options: Array.isArray(input.preset_options) && input.preset_options.length > 0
      ? input.preset_options
      : EMPTY_H3_CONFIG.preset_options,
    lora_options: Array.isArray(input.lora_options) && input.lora_options.length > 0
      ? input.lora_options
      : EMPTY_H3_CONFIG.lora_options,
    default_lora_id: input.default_lora_id || EMPTY_H3_CONFIG.default_lora_id,
  };
}

function selectorLabel(type: UserSelectorType) {
  if (type === 'id') return '用户 ID';
  if (type === 'username') return '用户名';
  return '邮箱';
}

function linkedUserSubtitle(config: CodexConfig) {
  if (!config.linked_user) return '未匹配到用户';
  const user = config.linked_user;
  return `${displayUserSubtitle(user) || user.id.slice(0, 8)} · ${user.status}`;
}

type RoleTextPolicyDto = {
  revision: number; enabled: boolean; allowUnpricedText: boolean; allowedModels: string[];
  maxInputBytes: number; maxOutputTokens: number; consentValid: boolean; needsConsent: boolean;
  pointsPerUsd: 35; riskNoticeVersion: string;
};
type RoleTextPolicyDraft = Pick<RoleTextPolicyDto, 'enabled' | 'allowUnpricedText' | 'allowedModels' | 'maxInputBytes' | 'maxOutputTokens'>;

function isRoleTextPolicyDto(value: unknown): value is RoleTextPolicyDto {
  if (!value || typeof value !== 'object') return false;
  const policy = value as RoleTextPolicyDto;
  return Number.isSafeInteger(policy.revision) && policy.revision >= 0 && policy.pointsPerUsd === 35
    && typeof policy.enabled === 'boolean' && typeof policy.allowUnpricedText === 'boolean'
    && typeof policy.consentValid === 'boolean' && typeof policy.needsConsent === 'boolean'
    && typeof policy.riskNoticeVersion === 'string' && Array.isArray(policy.allowedModels)
    && policy.allowedModels.every(id => STUDIO_TEXT_MODELS.some(model => model.id === id))
    && Number.isSafeInteger(policy.maxInputBytes) && policy.maxInputBytes > 0 && policy.maxInputBytes <= 131072
    && Number.isSafeInteger(policy.maxOutputTokens) && policy.maxOutputTokens > 0 && policy.maxOutputTokens <= 4096;
}

function policyDraft(policy: RoleTextPolicyDto): RoleTextPolicyDraft {
  return { enabled: policy.enabled, allowUnpricedText: policy.allowUnpricedText, allowedModels: policy.allowedModels,
    maxInputBytes: policy.maxInputBytes, maxOutputTokens: policy.maxOutputTokens };
}

function RoleTextPolicySettings({ accountId, onClose, onDirtyChange, onSavingChange, confirm }: {
  accountId: string; onClose: () => void; onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void; confirm: ReturnType<typeof useProductDialog>['confirm'];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const dismissing = useRef(false);
  const [policy, setPolicy] = useState<RoleTextPolicyDto | null>(null);
  const [draft, setDraft] = useState<RoleTextPolicyDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [providerReady, setProviderReady] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [reading, setReading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [needsRead, setNeedsRead] = useState(false);
  const [error, setError] = useState('');
  const dirty = Boolean(draft && (JSON.stringify(draft) !== baseline || riskAcknowledged));

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  async function read(preserve = false) {
    if (lock.current) return;
    const epoch = generation.current;
    lock.current = true; setReading(true); setError('');
    try {
      const response = await fetch('/api/admin/integrations/musk', { cache: 'no-store' });
      const data = await response.json();
      if (!alive.current || generation.current !== epoch) return;
      if (!response.ok || data.ok !== true || !isRoleTextPolicyDto(data.role_text_policy)) {
        throw new Error(data.role_text_policy_error || data.error || '未读取到有效角色文字政策，未按默认启用处理。');
      }
      const next: RoleTextPolicyDto = data.role_text_policy;
      setPolicy(next); setNeedsRead(false); setRiskAcknowledged(false);
      setProviderReady(data.config?.enabled === true && data.config?.api_key_configured === true
        && typeof data.config.base_url === 'string' && new URL(data.config.base_url).origin === 'https://api.muskapis.com');
      if (!preserve) { const values = policyDraft(next); setDraft(values); setBaseline(JSON.stringify(values)); }
    } catch (cause) {
      if (alive.current && generation.current === epoch) { setNeedsRead(true); setError(cause instanceof Error ? cause.message : '读取角色文字政策失败'); }
    } finally {
      if (alive.current && generation.current === epoch) { lock.current = false; setReading(false); }
    }
  }
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: () => { void dismiss(); } });
  useEffect(() => {
    generation.current++; alive.current = true; lock.current = false; dialog.current?.showModal(); void read();
    return () => { generation.current++; alive.current = false; onDirtyChange(false); onSavingChange(false); };
  }, [accountId]);

  async function dismiss() {
    if (savingPolicy || dismissing.current) return;
    dismissing.current = true;
    try {
      if (dirty && !await confirm('角色文字设置尚未保存，放弃本次修改？', { title: '放弃修改', confirmLabel: '放弃修改' })) return;
      if (alive.current) onClose();
    } finally { dismissing.current = false; }
  }
  function change(patch: Partial<RoleTextPolicyDraft>) {
    setDraft(current => current ? { ...current, ...patch } : current);
    setRiskAcknowledged(false);
  }
  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!policy || !draft || lock.current || needsRead) return;
    if (!draft.allowedModels.length) { setError('至少选择一个可用模型。'); return; }
    if (draft.enabled && (!providerReady || !draft.allowUnpricedText || !riskAcknowledged)) {
      setError('请先保存可用的主文字配置，并明确确认无报价费用风险。'); return;
    }
    const epoch = generation.current;
    let definiteFailure = false;
    lock.current = true; setSavingPolicy(true); onSavingChange(true); setError('');
    try {
      const response = await fetch('/api/admin/integrations/musk', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_text_policy: { ...draft, riskAcknowledged }, base_revision: policy.revision }) });
      const data = await response.json();
      if (!alive.current || generation.current !== epoch) return;
      if (!response.ok || data.ok !== true) {
        definiteFailure = !response.ok && response.status < 500;
        if (response.status >= 500 || response.status === 409) setNeedsRead(true);
        throw new Error(data.error || '保存结果未确认，输入已保留。');
      }
      if (!isRoleTextPolicyDto(data.role_text_policy) || data.role_text_policy.revision !== policy.revision + 1
        || JSON.stringify(policyDraft(data.role_text_policy)) !== JSON.stringify(draft)
        || draft.enabled && !data.role_text_policy.consentValid) {
        setNeedsRead(true); throw new Error('未收到匹配的保存回执，输入已保留，请重新读取。');
      }
      onDirtyChange(false); onClose();
    } catch (cause) {
      if (alive.current && generation.current === epoch) { setError(cause instanceof Error ? cause.message : '保存结果未确认，输入已保留。');
        if (!definiteFailure) setNeedsRead(true); }
    } finally {
      if (alive.current && generation.current === epoch) { lock.current = false; setSavingPolicy(false); onSavingChange(false); }
    }
  }

  return createPortal(<dialog ref={dialog} className={dialogStyles.dialog} aria-modal="true" aria-labelledby="role-text-policy-title">
    <form onSubmit={savePolicy} aria-busy={reading || savingPolicy}>
      <header className={dialogStyles.header}><h2 id="role-text-policy-title">角色文字</h2>
        <button type="button" className={dialogStyles.close} title="关闭" aria-label="关闭" disabled={savingPolicy} onClick={() => void dismiss()}><X size={18} /></button></header>
      <p className={dialogStyles.message}>仅控制角色协作的文字调用，不代替本人任务授权。启用后仍须本人明确确认模型、期限和预算，保存不会调用模型。</p>
      {reading && <p role="status">正在读取已保存政策</p>}
      {draft && <fieldset disabled={reading || savingPolicy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className={dialogStyles.checkbox}><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />允许角色文字调用</label>
        {!providerReady && <p className={dialogStyles.message}>主文字配置尚未就绪；请先在Musk API区域保存已启用、已设置Key的配置。角色开关不会代开主配置。</p>}
        {policy?.needsConsent && <p className={dialogStyles.message}>尚无有效风险同意，或账号范围已变化；启用须重新确认。</p>}
        <div className="form-group"><span className="form-label">允许模型</span>
          {STUDIO_TEXT_MODELS.map(model => <label key={model.id} className={dialogStyles.checkbox}>
            <input type="checkbox" checked={draft.allowedModels.includes(model.id)} onChange={event => change({
              allowedModels: STUDIO_TEXT_MODELS.filter(item => item.id === model.id ? event.target.checked : draft.allowedModels.includes(item.id)).map(item => item.id),
            })} />{model.label}</label>)}</div>
        <div className="form-group"><label className="form-label" htmlFor="role-text-input-limit">单次输入上限（字节）</label>
          <input id="role-text-input-limit" type="number" className={dialogStyles.input} min={1} max={131072} step={1} required value={draft.maxInputBytes || ''} onChange={event => change({ maxInputBytes: Number(event.target.value) })} /></div>
        <div className="form-group"><label className="form-label" htmlFor="role-text-output-limit">单次输出上限（Token）</label>
          <input id="role-text-output-limit" type="number" className={dialogStyles.input} min={1} max={4096} step={1} required value={draft.maxOutputTokens || ''} onChange={event => change({ maxOutputTokens: Number(event.target.value) })} /></div>
        <label className={dialogStyles.checkbox}><input type="checkbox" checked={draft.allowUnpricedText} onChange={event => change({ allowUnpricedText: event.target.checked })} />允许没有预先报价的文字调用</label>
        <p className={dialogStyles.message}>实际美元账单按1美元＝35点结算，预留点数向上取整。本人授权预留不是供应商报价，也不保证封顶；没有可匹配账单时费用保持待确认，超出预留须本人另行授权差额。</p>
        {draft.enabled && <label className={dialogStyles.checkbox}><input type="checkbox" checked={riskAcknowledged} onChange={event => setRiskAcknowledged(event.target.checked)} />我已了解无报价调用可能产生超出预留的供应商费用，确认本次模型及限制。</label>}
      </fieldset>}
      {error && <p role="alert" className={dialogStyles.message}>{error}</p>}
      {needsRead && <p className={dialogStyles.message}>输入仍保留。重新读取只更新设置版本，不代表此前保存成功；请核对后再决定是否保存。</p>}
      <footer className={dialogStyles.actions}>
        {(needsRead || !draft) && <button type="button" className={dialogStyles.secondary} disabled={reading || savingPolicy} onClick={() => void read(Boolean(draft))}>重新读取</button>}
        <button type="button" className={dialogStyles.secondary} disabled={savingPolicy} onClick={() => void dismiss()}>取消</button>
        <button type="submit" className={dialogStyles.primary} disabled={!draft || reading || savingPolicy || needsRead
          || draft.enabled && (!providerReady || !draft.allowUnpricedText || !riskAcknowledged)}>{savingPolicy ? '正在保存' : '保存'}</button>
      </footer>
    </form>
  </dialog>, document.body);
}

export default function AdminIntegrationsClient() {
  const { confirm, productDialog } = useProductDialog();
  const { user: currentUser, hasLoadedUser, refreshUser } = useAppSession();
  const [config, setConfig] = useState<CodexConfig>(EMPTY_CONFIG);
  const [muskConfig, setMuskConfig] = useState<MuskConfig>(EMPTY_MUSK_CONFIG);
  const [volcengineConfig, setVolcengineConfig] = useState<VolcengineIpConfig>(EMPTY_VOLCENGINE_IP_CONFIG);
  const [aiMediaKitConfig, setAiMediaKitConfig] = useState<AiMediaKitConfig>(EMPTY_AIMEDIAKIT_CONFIG);
  const [h3Config, setH3Config] = useState<H3Config>(EMPTY_H3_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [muskSaving, setMuskSaving] = useState(false);
  const [muskTesting, setMuskTesting] = useState(false);
  const [volcengineSaving, setVolcengineSaving] = useState(false);
  const [aiMediaKitSaving, setAiMediaKitSaving] = useState(false);
  const [h3Saving, setH3Saving] = useState(false);
  const [h3Testing, setH3Testing] = useState(false);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [muskApiKey, setMuskApiKey] = useState('');
  const [clearMuskApiKey, setClearMuskApiKey] = useState(false);
  const [volcengineApiKey, setVolcengineApiKey] = useState('');
  const [clearVolcengineApiKey, setClearVolcengineApiKey] = useState(false);
  const [aiMediaKitApiKey, setAiMediaKitApiKey] = useState('');
  const [clearAiMediaKitApiKey, setClearAiMediaKitApiKey] = useState(false);
  const [h3ApiToken, setH3ApiToken] = useState('');
  const [h3AdminToken, setH3AdminToken] = useState('');
  const [clearH3ApiToken, setClearH3ApiToken] = useState(false);
  const [clearH3AdminToken, setClearH3AdminToken] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(null);
  const [muskTestState, setMuskTestState] = useState<MuskTestState>(null);
  const [muskModelOptions, setMuskModelOptions] = useState<ModelOption[]>([]);
  const [muskModelsLoading, setMuskModelsLoading] = useState(false);
  const [muskModelsRefreshing, setMuskModelsRefreshing] = useState(false);
  const [h3TestState, setH3TestState] = useState<H3TestState>(null);
  const [h3QueueOpen, setH3QueueOpen] = useState(false);
  const [h3QueueLoading, setH3QueueLoading] = useState(false);
  const [h3QueueState, setH3QueueState] = useState<unknown>(null);
  const [h3QueueAction, setH3QueueAction] = useState<'pause' | 'resume' | 'cancel' | 'stop' | 'move'>('pause');
  const [h3QueueJobId, setH3QueueJobId] = useState('');
  const [h3QueueDirection, setH3QueueDirection] = useState<'top' | 'up' | 'down' | 'bottom'>('top');
  const [h3QueueReason, setH3QueueReason] = useState('');
  const [h3QueueMessage, setH3QueueMessage] = useState<SubmitState>(null);
  const [imageDrafts, setImageDrafts] = useState<Record<string, boolean>>({});
  const [selectedObject, setSelectedObject] = useState('image');
  const [objectReady, setObjectReady] = useState(false);
  const [rolePolicyOpen, setRolePolicyOpen] = useState(false);
  const [rolePolicyDirty, setRolePolicyDirty] = useState(false);
  const [rolePolicySaving, setRolePolicySaving] = useState(false);
  const rolePolicyAccount = useRef(currentUser?.id);
  const onImageDraftChange = useCallback((drafts: Record<string, boolean>) => setImageDrafts(drafts), []);
  const imageDraftSnapshot = Object.fromEntries([...IMAGE_API_GROUPS, 'model'].map(group => [`imageGroup:${group}`, Boolean(imageDrafts[group])]));
  const settingsSubmit = useSettingsPageSubmit({
    codex: { config, entered: Boolean(token), clearToken },
    musk: { config: muskConfig, entered: Boolean(muskApiKey), clearMuskApiKey },
    volcengine: { config: volcengineConfig, entered: Boolean(volcengineApiKey), clearVolcengineApiKey },
    mediakit: { config: aiMediaKitConfig, entered: Boolean(aiMediaKitApiKey), clearAiMediaKitApiKey },
    h3: { config: h3Config, apiEntered: Boolean(h3ApiToken), adminEntered: Boolean(h3AdminToken), clearH3ApiToken, clearH3AdminToken },
    roleText: rolePolicyDirty,
    ...imageDraftSnapshot,
  }, !loading, '/admin', confirm, muskTesting || h3Testing || h3QueueLoading || rolePolicySaving);

  useEffect(() => {
    if (rolePolicyAccount.current === currentUser?.id) return;
    rolePolicyAccount.current = currentUser?.id;
    setRolePolicyOpen(false); setRolePolicyDirty(false); setRolePolicySaving(false); setImageDrafts({});
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;
    const restore = () => {
      const url = new URL(window.location.href);
      let value = url.searchParams.get('object') || url.hash.slice(1);
      if (!value && url.pathname === '/admin/integrations/aimediakit') value = 'aimediakit-enhance-video';
      if (!value) {
        try { value = localStorage.getItem(`sd2-admin-integration-object-v1:${currentUser.id}`) || 'image'; } catch { value = 'image'; }
      }
      setSelectedObject(INTEGRATION_OBJECTS.some(([id]) => id === value) ? value : 'image'); setObjectReady(true);
    };
    restore(); window.addEventListener('popstate', restore); window.addEventListener('hashchange', restore);
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore); };
  }, [currentUser?.id]);
  function selectObject(value: string) {
    setSelectedObject(value);
    const url = new URL(window.location.href); url.searchParams.set('object', value); url.hash = '';
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    if (currentUser?.id && objectReady) {
      try { localStorage.setItem(`sd2-admin-integration-object-v1:${currentUser.id}`, value); } catch { /* Only the selected object is persisted. */ }
    }
  }

  useEffect(() => {
    if (!hasLoadedUser) void refreshUser();
  }, [hasLoadedUser, refreshUser]);

  const statusText = useMemo(() => {
    if (config.ready) return '已启用，可被 Codex 调用';
    if (!config.enabled) return '未启用';
    if (!config.token_configured) return '缺少 token';
    if (!config.linked_user) return '绑定用户无效';
    return '配置未就绪';
  }, [config]);

  const muskStatusText = useMemo(() => {
    if (muskConfig.ready) return '已启用';
    if (!muskConfig.enabled) return '未启用';
    if (!muskConfig.base_url) return '缺少 API 地址';
    if (!muskConfig.default_model) return '缺少默认模型';
    if (!muskConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [muskConfig]);

  const volcengineStatusText = useMemo(() => {
    if (volcengineConfig.ready) return '已启用';
    if (!volcengineConfig.enabled) return '未启用';
    if (!volcengineConfig.base_url) return '缺少 API 地址';
    if (!volcengineConfig.default_model) return '缺少 Model ID';
    if (!volcengineConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [volcengineConfig]);

  const aiMediaKitStatusText = useMemo(() => {
    if (aiMediaKitConfig.ready) return '已启用';
    if (!aiMediaKitConfig.enabled) return '未启用';
    if (!aiMediaKitConfig.base_url) return '缺少 API 地址';
    if (!aiMediaKitConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [aiMediaKitConfig]);

  const h3StatusText = useMemo(() => {
    if (h3Config.ready) return '已启用';
    if (!h3Config.enabled) return '未启用';
    if (!h3Config.base_url) return '缺少 API 地址';
    if (!h3Config.api_token_configured) return '缺少用户 token';
    if (!h3Config.configured) return '配置未就绪';
    if (!h3Config.health) return '待测试连接';
    return '健康检查未通过';
  }, [h3Config]);

  const loadConfig = async () => {
    try {
      const [codexRes, muskRes, volcengineRes, aiMediaKitRes, h3Res] = await Promise.all([
        fetch('/api/admin/integrations/codex', { cache: 'no-store' }),
        fetch('/api/admin/integrations/musk', { cache: 'no-store' }),
        fetch('/api/admin/integrations/volcengine-ip', { cache: 'no-store' }),
        fetch('/api/admin/integrations/aimediakit', { cache: 'no-store' }),
        fetch('/api/admin/integrations/h3', { cache: 'no-store' }),
      ]);
      const [codexData, muskData, volcengineData, aiMediaKitData, h3Data] = await Promise.all([
        codexRes.json(),
        muskRes.json(),
        volcengineRes.json(),
        aiMediaKitRes.json(),
        h3Res.json(),
      ]);

      if (!codexRes.ok) {
        setSubmitState({ type: 'error', message: codexData.error || '读取 Codex 配置失败' });
        return;
      }
      if (!muskRes.ok) {
        setSubmitState({ type: 'error', message: muskData.error || '读取 Musk API 配置失败' });
        return;
      }
      if (!volcengineRes.ok) {
        setSubmitState({ type: 'error', message: volcengineData.error || '读取火山 IP 生成配置失败' });
        return;
      }
      if (!aiMediaKitRes.ok) {
        setSubmitState({ type: 'error', message: aiMediaKitData.error || '读取 AI MediaKit 配置失败' });
        return;
      }
      if (!h3Res.ok) {
        setSubmitState({ type: 'error', message: h3Data.error || '读取 H3 配置失败' });
        return;
      }
      setConfig(codexData.config || EMPTY_CONFIG);
      const nextMusk = {
        ...(muskData.config || EMPTY_MUSK_CONFIG),
        allowed_models: Array.isArray(muskData.config?.allowed_models) ? muskData.config.allowed_models : [],
      };
      setMuskConfig(nextMusk);
      setMuskModelOptions((prev) => {
        const ids = new Set([...nextMusk.allowed_models, nextMusk.default_model, ...prev.map((m) => m.id)].filter(Boolean));
        return Array.from(ids).map((id) => ({ id, label: id, available: true }));
      });
      setVolcengineConfig(volcengineData.config || EMPTY_VOLCENGINE_IP_CONFIG);
      setAiMediaKitConfig(aiMediaKitData.config || EMPTY_AIMEDIAKIT_CONFIG);
      setH3Config(normalizeH3Config(h3Data.config));
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '读取配置失败' });
    } finally {
      setLoading(false);
    }
  };


  const refreshMuskModels = async () => {
    setMuskModelsRefreshing(true);
    try {
      const res = await fetch('/api/admin/integrations/musk/refresh-models', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSubmitState({ type: 'error', message: data.error || '刷新上游模型失败' });
        return;
      }
      const models = Array.isArray(data.models) ? data.models as ModelOption[] : [];
      setMuskModelOptions(models);
      setSubmitState({ type: 'success', message: `已刷新上游模型 ${models.length} 个` });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '刷新上游模型失败' });
    } finally {
      setMuskModelsRefreshing(false);
    }
  };

  const saveMuskConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setMuskSaving(true);
    setSubmitState(null);
    setMuskTestState(null);

    try {
      const res = await fetch('/api/admin/integrations/musk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: muskConfig.enabled,
          base_url: muskConfig.base_url,
          default_model: muskConfig.default_model,
          allowed_models: muskConfig.allowed_models,
          api_key: muskApiKey,
          clear_api_key: clearMuskApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setMuskConfig(data.config || muskConfig);
      setMuskApiKey('');
      setClearMuskApiKey(false);
      setSubmitState({ type: 'success', message: 'Musk API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setMuskSaving(false);
      settingsSubmit.finish('musk', saved);
    }
  };

  const testMuskConfig = async () => {
    setMuskTesting(true);
    setSubmitState(null);
    setMuskTestState(null);

    try {
      const res = await fetch('/api/admin/integrations/musk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        setMuskTestState({
          type: 'error',
          message: data.error || data.message || 'Musk API 测试失败',
        });
        return;
      }
      setMuskConfig(data.config || muskConfig);
      setMuskTestState({
        type: 'success',
        message: 'Musk API 连通性测试通过。',
        model: data.test?.model || muskConfig.default_model,
        latency_ms: data.test?.latency_ms,
        tested_at: data.test?.tested_at,
      });
    } catch (error) {
      setMuskTestState({
        type: 'error',
        message: error instanceof Error ? error.message : 'Musk API 测试失败',
      });
    } finally {
      setMuskTesting(false);
    }
  };

  const saveVolcengineConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setVolcengineSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/volcengine-ip', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: volcengineConfig.enabled,
          base_url: volcengineConfig.base_url,
          default_model: volcengineConfig.default_model,
          api_key: volcengineApiKey,
          clear_api_key: clearVolcengineApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setVolcengineConfig(data.config || volcengineConfig);
      setVolcengineApiKey('');
      setClearVolcengineApiKey(false);
      setSubmitState({ type: 'success', message: '火山 IP 生成 API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setVolcengineSaving(false);
      settingsSubmit.finish('volcengine', saved);
    }
  };

  const saveAiMediaKitConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setAiMediaKitSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/aimediakit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: aiMediaKitConfig.enabled,
          base_url: aiMediaKitConfig.base_url,
          api_key: aiMediaKitApiKey,
          clear_api_key: clearAiMediaKitApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setAiMediaKitConfig(data.config || aiMediaKitConfig);
      setAiMediaKitApiKey('');
      setClearAiMediaKitApiKey(false);
      setSubmitState({ type: 'success', message: 'AI MediaKit 视频超分 API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setAiMediaKitSaving(false);
      settingsSubmit.finish('mediakit', saved);
    }
  };

  const saveH3Config = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setH3Saving(true);
    setSubmitState(null);
    setH3TestState(null);

    try {
      const res = await fetch('/api/admin/integrations/h3', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: h3Config.enabled,
          base_url: h3Config.base_url,
          default_preset_id: h3Config.default_preset_id,
          default_lora_id: h3Config.default_lora_id,
          api_token: h3ApiToken,
          admin_token: h3AdminToken,
          clear_api_token: clearH3ApiToken,
          clear_admin_token: clearH3AdminToken,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setH3Config(normalizeH3Config(data.config || h3Config));
      setH3ApiToken('');
      setH3AdminToken('');
      setClearH3ApiToken(false);
      setClearH3AdminToken(false);
      setSubmitState({ type: 'success', message: 'H3 本地生成服务配置已保存。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setH3Saving(false);
      settingsSubmit.finish('h3', saved);
    }
  };

  const testH3Config = async () => {
    setH3Testing(true);
    setSubmitState(null);
    setH3TestState(null);

    try {
      const res = await fetch('/api/admin/integrations/h3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        setH3TestState({
          type: 'error',
          message: data.error || data.message || 'H3 连接测试失败',
        });
        return;
      }
      const health = data.test?.health || {};
      setH3Config(normalizeH3Config(data.config || h3Config));
      setH3TestState({
        type: 'success',
        message: 'H3 连接测试通过。',
        tested_at: data.test?.tested_at,
        health_api: typeof health.api === 'string' ? health.api : undefined,
        worker: typeof health.worker?.worker === 'string' ? health.worker.worker : undefined,
        comfyui: typeof health.worker?.comfyui === 'string' ? health.worker.comfyui : undefined,
      });
    } catch (error) {
      setH3TestState({
        type: 'error',
        message: error instanceof Error ? error.message : 'H3 连接测试失败',
      });
    } finally {
      setH3Testing(false);
    }
  };

  const loadH3Queue = async () => {
    setH3QueueLoading(true);
    setH3QueueMessage(null);
    try {
      const res = await fetch('/api/admin/integrations/h3/queue', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setH3QueueMessage({ type: 'error', message: data.error || data.message || '读取 H3 队列失败' });
        return;
      }
      setH3QueueState(data.queue || null);
      setH3QueueMessage({ type: 'success', message: 'H3 队列状态已刷新。' });
    } catch (error) {
      setH3QueueMessage({ type: 'error', message: error instanceof Error ? error.message : '读取 H3 队列失败' });
    } finally {
      setH3QueueLoading(false);
    }
  };

  const submitH3QueueAction = async () => {
    setH3QueueMessage(null);
    const needsJobId = h3QueueAction === 'cancel' || h3QueueAction === 'stop' || h3QueueAction === 'move';
    const trimmedJobId = h3QueueJobId.trim();
    if (needsJobId && !trimmedJobId) {
      setH3QueueMessage({ type: 'error', message: '请先填写 H3 job_id。' });
      return;
    }
    if ((h3QueueAction === 'cancel' || h3QueueAction === 'stop')
      && !await confirm(`确认执行 H3 ${h3QueueAction === 'cancel' ? '取消排队任务' : '停止运行任务'}？`, { title: '确认停止', confirmLabel: '确认' })) {
      return;
    }
    setH3QueueLoading(true);
    try {
      const res = await fetch('/api/admin/integrations/h3/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: h3QueueAction,
          job_id: trimmedJobId || undefined,
          direction: h3QueueAction === 'move' ? h3QueueDirection : undefined,
          reason: h3QueueReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setH3QueueMessage({ type: 'error', message: data.error || data.message || 'H3 队列操作失败' });
        return;
      }
      setH3QueueMessage({ type: 'success', message: 'H3 队列操作已提交，并已写入操作日志。' });
      await loadH3Queue();
    } catch (error) {
      setH3QueueMessage({ type: 'error', message: error instanceof Error ? error.message : 'H3 队列操作失败' });
    } finally {
      setH3QueueLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const saveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/codex', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: config.enabled,
          source_label: config.source_label,
          user_selector: config.user_selector,
          token,
          clear_token: clearToken,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setConfig(data.config || config);
      setToken('');
      setClearToken(false);
      setSubmitState({ type: 'success', message: 'Codex 接口配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSaving(false);
      settingsSubmit.finish('codex', saved);
    }
  };

  const updateSelector = (patch: Partial<CodexConfig['user_selector']>) => {
    setConfig((prev) => ({
      ...prev,
      user_selector: {
        ...prev.user_selector,
        ...patch,
      },
    }));
  };

  if (loading) {
    return (
      <div>
        <PageBanner
          eyebrow="管理后台"
          title="API 设置"
          description="统一维护火山 IP 生成、AI MediaKit 超分、Musk API、图形生成 API、Codex API 和外部工具调用 sd2 的后端配置。"
        />
        <div className="card">
          <LoadingSkeleton label="正在读取配置" />
        </div>
      </div>
    );
  }

  return (
    <fieldset disabled={settingsSubmit.busy} className={`admin-integrations-page ${workbenchStyles.surface}`} style={{ border: 0, margin: 0, minWidth: 0 }}>
      {productDialog}
      {settingsSubmit.notice && <p role="status">{settingsSubmit.notice}</p>}
      <PageBanner
        eyebrow="管理后台"
        title="API 设置"
        description="按模型或服务维护供应商与调用配置。"
        actions={<Link className="btn btn-secondary" href="/admin/pricing">点数与费率</Link>}
      />

      <label className="form-group" style={{ display: 'block', maxWidth: 640 }}><span className="form-label">模型或服务</span>
        <select className="input" value={selectedObject} onChange={event => selectObject(event.target.value)}>
          {INTEGRATION_OBJECTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <p className="text-gray text-sm">保存只影响所选对象未来的新请求；已报价、已受理或结果未知的请求继续使用原配置。切换对象不会提交或丢弃当前输入。</p>

      {submitState && (
        <div className="outputs-message mt-4" role="status">
          {submitState.message}
        </div>
      )}

      <section hidden={selectedObject !== 'h3-video'}>
      <p>H3 · {h3StatusText} · {h3Config.api_token_configured ? '用户 token 已设置' : '用户 token 未设置'}</p>
      <details><summary>具体配置与队列管理</summary>
      <form id="h3-video" className="codex-config-form" onSubmit={saveH3Config}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">H3 本地生成服务</h2>
            <p className="text-gray text-sm mt-2">
              保存 H3 API 网关地址、用户 token 和管理员 token。普通生成只走服务端转发，不把 token 暴露给浏览器。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 H3 本地生成服务">
            <input
              type="checkbox"
              checked={h3Config.enabled}
              onChange={(event) => setH3Config((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="h3-base-url">API 地址</label>
            <input
              id="h3-base-url"
              className="input"
              value={h3Config.base_url}
              onChange={(event) => setH3Config((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://h3-api.example.com"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-default-preset">默认预设</label>
            <select
              id="h3-default-preset"
              className="input"
              value={h3Config.default_preset_id}
              onChange={(event) => setH3Config((prev) => ({
                ...prev,
                default_preset_id: event.target.value as H3Config['default_preset_id'],
              }))}
            >
              {h3Config.preset_options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.detail}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-default-lora">默认 LoRA</label>
            <select
              id="h3-default-lora"
              className="input"
              value={h3Config.default_lora_id}
              onChange={(event) => setH3Config((prev) => ({
                ...prev,
                default_lora_id: event.target.value as H3Config['default_lora_id'],
              }))}
            >
              {h3Config.lora_options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.detail}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-api-token">用户 token</label>
            <input
              id="h3-api-token"
              className="input"
              type="password"
              value={h3ApiToken}
              onChange={(event) => {
                setH3ApiToken(event.target.value);
                if (event.target.value.trim()) setClearH3ApiToken(false);
              }}
              placeholder={h3Config.api_token_configured ? '当前已设置，留空不变' : '输入 H3_API_TOKEN'}
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-admin-token">管理员 token</label>
            <input
              id="h3-admin-token"
              className="input"
              type="password"
              value={h3AdminToken}
              onChange={(event) => {
                setH3AdminToken(event.target.value);
                if (event.target.value.trim()) setClearH3AdminToken(false);
              }}
              placeholder={h3Config.admin_token_configured ? '当前已设置，留空不变' : '输入 H3_ADMIN_TOKEN'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{h3StatusText}</strong>
          </div>
          <div>
            <span className="info-label">健康检查</span>
            <strong>
              {h3Config.health
                ? `API ${h3Config.health.api || '-'} · Worker ${h3Config.health.worker || '-'} · ComfyUI ${h3Config.health.comfyui || '-'}`
                : h3Config.health_path}
            </strong>
          </div>
          <div>
            <span className="info-label">最近测试</span>
            <strong>{h3Config.health?.checked_at ? <RelativeTime value={h3Config.health.checked_at} /> : '未测试'}</strong>
          </div>
          <div>
            <span className="info-label">提交任务</span>
            <strong>{h3Config.generate_path}</strong>
          </div>
          <div>
            <span className="info-label">队列管理</span>
            <strong>{h3Config.admin_queue_ready ? '已可用' : '未就绪'}</strong>
          </div>
          <div>
            <span className="info-label">用户 token</span>
            <strong>{h3Config.api_token_configured ? '已设置' : '未设置'}</strong>
          </div>
          <div>
            <span className="info-label">管理员 token</span>
            <strong>{h3Config.admin_token_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <details
          className="h3-queue-panel"
          open={h3QueueOpen}
          onToggle={(event) => setH3QueueOpen(event.currentTarget.open)}
        >
          <summary>
            <div>
              <strong>H3 队列管理</strong>
              <span>{h3Config.admin_queue_ready ? '可读取队列并执行管理员操作' : '需要健康检查通过并配置管理员 token'}</span>
            </div>
          </summary>
          <div className="h3-queue-body">
            <div className="h3-queue-toolbar">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={loadH3Queue}
                disabled={h3QueueLoading || !h3Config.admin_queue_ready}
              >
                {h3QueueLoading ? '正在刷新' : '刷新队列'}
              </button>
              {!h3Config.admin_queue_ready && (
                <span className="text-gray text-sm">队列操作只在 H3 健康检查通过且管理员 token 就绪后开放。</span>
              )}
            </div>

            {h3QueueMessage && (
              <div className={`codex-config-test-result ${h3QueueMessage.type === 'success' ? 'is-success' : ''}`}>
                <strong>{h3QueueMessage.message}</strong>
              </div>
            )}

            <div className="h3-queue-action-grid">
              <label className="form-group">
                <span className="form-label">动作</span>
                <select
                  className="input"
                  value={h3QueueAction}
                  onChange={(event) => setH3QueueAction(event.target.value as typeof h3QueueAction)}
                  disabled={!h3Config.admin_queue_ready}
                >
                  <option value="pause">暂停新任务启动</option>
                  <option value="resume">恢复队列</option>
                  <option value="cancel">取消排队任务</option>
                  <option value="stop">停止运行任务</option>
                  <option value="move">调整排队顺序</option>
                </select>
              </label>
              <label className="form-group">
                <span className="form-label">job_id</span>
                <input
                  className="input"
                  value={h3QueueJobId}
                  onChange={(event) => setH3QueueJobId(event.target.value)}
                  placeholder="cancel / stop / move 时填写"
                  disabled={!h3Config.admin_queue_ready || h3QueueAction === 'pause' || h3QueueAction === 'resume'}
                  autoComplete="off"
                />
              </label>
              <label className="form-group">
                <span className="form-label">移动方向</span>
                <select
                  className="input"
                  value={h3QueueDirection}
                  onChange={(event) => setH3QueueDirection(event.target.value as typeof h3QueueDirection)}
                  disabled={!h3Config.admin_queue_ready || h3QueueAction !== 'move'}
                >
                  <option value="top">置顶</option>
                  <option value="up">上移</option>
                  <option value="down">下移</option>
                  <option value="bottom">置底</option>
                </select>
              </label>
              <label className="form-group">
                <span className="form-label">原因</span>
                <input
                  className="input"
                  value={h3QueueReason}
                  onChange={(event) => setH3QueueReason(event.target.value)}
                  placeholder="会写入操作日志"
                  disabled={!h3Config.admin_queue_ready}
                  maxLength={240}
                />
              </label>
              <button
                className="btn btn-primary"
                type="button"
                onClick={submitH3QueueAction}
                disabled={h3QueueLoading || !h3Config.admin_queue_ready}
              >
                执行队列操作
              </button>
            </div>

            <pre className="h3-queue-json">
              {h3QueueState ? JSON.stringify(h3QueueState, null, 2) : '暂未读取队列。'}
            </pre>
          </div>
        </details>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearH3ApiToken}
              disabled={!h3Config.api_token_configured || Boolean(h3ApiToken.trim())}
              onChange={(event) => setClearH3ApiToken(event.target.checked)}
            />
            清除当前用户 token
          </label>
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearH3AdminToken}
              disabled={!h3Config.admin_token_configured || Boolean(h3AdminToken.trim())}
              onChange={(event) => setClearH3AdminToken(event.target.checked)}
            />
            清除当前管理员 token
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={testH3Config}
            disabled={h3Testing || h3Saving || !h3Config.base_url}
          >
            {h3Testing ? '正在测试' : '测试连接'}
          </button>
          <button className="btn btn-primary sd2-loading-surface" data-busy={h3Saving} type="submit" disabled={h3Saving}>
            {h3Saving ? '正在保存' : '保存 H3 本地生成服务'}
          </button>
        </div>

        {h3TestState && (
          <div className={`codex-config-test-result ${h3TestState.type === 'success' ? 'is-success' : ''}`}>
            <strong>{h3TestState.message}</strong>
            {h3TestState.type === 'success' && (
              <span>
                API {h3TestState.health_api || '-'} · Worker {h3TestState.worker || '-'} · ComfyUI {h3TestState.comfyui || '-'}
                {h3TestState.tested_at && <> · <RelativeTime value={h3TestState.tested_at} /></>}
              </span>
            )}
            {h3TestState.type === 'error' && <span>请确认 H3 API 公网地址、用户 token 和工作站服务状态。</span>}
          </div>
        )}
      </form>

      </details></section>
      <section hidden={selectedObject !== 'aimediakit-enhance-video'}>
      <p>AI MediaKit · {aiMediaKitStatusText} · {aiMediaKitConfig.api_key_configured ? 'Key 已设置' : 'Key 未设置'}</p>
      <details><summary>具体配置</summary>
      <form id="aimediakit-enhance-video" className="codex-config-form" onSubmit={saveAiMediaKitConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">AI MediaKit 视频超分 API</h2>
            <p className="text-gray text-sm mt-2">
              保存视频超分/画质增强所需的 AI MediaKit API Key。API Key 只提交到服务端保存，页面和接口不会回显明文。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 AI MediaKit 视频超分 API">
            <input
              type="checkbox"
              checked={aiMediaKitConfig.enabled}
              onChange={(event) => setAiMediaKitConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="aimediakit-base-url">API 地址</label>
            <input
              id="aimediakit-base-url"
              className="input"
              value={aiMediaKitConfig.base_url}
              onChange={(event) => setAiMediaKitConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://mediakit.cn-beijing.volces.com"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="aimediakit-api-key">API Key</label>
            <input
              id="aimediakit-api-key"
              className="input"
              type="password"
              value={aiMediaKitApiKey}
              onChange={(event) => {
                setAiMediaKitApiKey(event.target.value);
                if (event.target.value.trim()) setClearAiMediaKitApiKey(false);
              }}
              placeholder={aiMediaKitConfig.api_key_configured ? '当前已设置，留空不变' : '输入 AI MediaKit API Key'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{aiMediaKitStatusText}</strong>
          </div>
          <div>
            <span className="info-label">提交任务</span>
            <strong>{aiMediaKitConfig.enhance_video_path}</strong>
          </div>
          <div>
            <span className="info-label">查询任务</span>
            <strong>{aiMediaKitConfig.task_status_path}</strong>
          </div>
          <div>
            <span className="info-label">本地上传</span>
            <strong>{aiMediaKitConfig.request_upload_path}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{aiMediaKitConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearAiMediaKitApiKey}
              disabled={!aiMediaKitConfig.api_key_configured || Boolean(aiMediaKitApiKey.trim())}
              onChange={(event) => setClearAiMediaKitApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={aiMediaKitSaving} type="submit" disabled={aiMediaKitSaving}>
            {aiMediaKitSaving ? '正在保存' : '保存 AI MediaKit 视频超分 API'}
          </button>
        </div>
      </form>

      </details></section>
      <section hidden={selectedObject !== 'volcengine-ip'}>
      <p>火山 IP · {volcengineStatusText} · {volcengineConfig.default_model || '未设置型号'}</p>
      <details><summary>具体配置</summary>
      <form id="volcengine-ip" className="codex-config-form" onSubmit={saveVolcengineConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">火山 IP 生成 API</h2>
            <p className="text-gray text-sm mt-2">
              保存火山 Ark 视频生成密钥和 Model ID。API Key 只会提交到服务端保存，页面和接口不会回显明文。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用火山 IP 生成 API">
            <input
              type="checkbox"
              checked={volcengineConfig.enabled}
              onChange={(event) => setVolcengineConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="volcengine-base-url">API 地址</label>
            <input
              id="volcengine-base-url"
              className="input"
              value={volcengineConfig.base_url}
              onChange={(event) => setVolcengineConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="volcengine-model">Model ID</label>
            <input
              id="volcengine-model"
              className="input"
              list="volcengine-model-options"
              value={volcengineConfig.default_model}
              onChange={(event) => setVolcengineConfig((prev) => ({ ...prev, default_model: event.target.value }))}
              placeholder="按火山控制台已开通模型填写"
              autoComplete="off"
              maxLength={120}
              required
            />
            <datalist id="volcengine-model-options">
              {VOLCENGINE_IP_MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </datalist>
            <div className="volcengine-model-presets" aria-label="火山 IP 模型预设">
              {VOLCENGINE_IP_MODEL_OPTIONS.map((option) => {
                const active = volcengineConfig.default_model === option.id;
                return (
                  <button
                    key={option.id}
                    className={`volcengine-model-preset${active ? ' is-active' : ''}`}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setVolcengineConfig((prev) => ({ ...prev, default_model: option.id }))}
                  >
                    <span>{option.label}</span>
                    <small>{option.detail}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="volcengine-api-key">API Key</label>
            <input
              id="volcengine-api-key"
              className="input"
              type="password"
              value={volcengineApiKey}
              onChange={(event) => {
                setVolcengineApiKey(event.target.value);
                if (event.target.value.trim()) setClearVolcengineApiKey(false);
              }}
              placeholder={volcengineConfig.api_key_configured ? '当前已设置，留空不变' : '输入火山 API Key'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{volcengineStatusText}</strong>
          </div>
          <div>
            <span className="info-label">Base URL</span>
            <strong>{volcengineConfig.base_url || '-'}</strong>
          </div>
          <div>
            <span className="info-label">创建任务路径</span>
            <strong>{volcengineConfig.create_task_path}</strong>
          </div>
          <div>
            <span className="info-label">Model ID</span>
            <strong>{volcengineConfig.default_model || '-'}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{volcengineConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearVolcengineApiKey}
              disabled={!volcengineConfig.api_key_configured || Boolean(volcengineApiKey.trim())}
              onChange={(event) => setClearVolcengineApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={volcengineSaving} type="submit" disabled={volcengineSaving}>
            {volcengineSaving ? '正在保存' : '保存火山 IP 生成 API'}
          </button>
        </div>
      </form>

      </details></section>
      <section hidden={selectedObject !== 'text'}>
      <p>Musk · {muskStatusText} · {muskConfig.default_model || '未设置型号'}</p>
      <details><summary>具体配置与角色文字设置</summary>
      <form className="codex-config-form" onSubmit={saveMuskConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">Musk API</h2>
            <p className="text-gray text-sm mt-2">
              保存外部 LLM 服务地址和默认模型，后续模板配置 Agent、模块生成 Agent 可从这里读取。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 Musk API">
            <input
              type="checkbox"
              checked={muskConfig.enabled}
              onChange={(event) => setMuskConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="musk-base-url">API 地址</label>
            <input
              id="musk-base-url"
              className="input"
              value={muskConfig.base_url}
              onChange={(event) => setMuskConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://api.muskapis.com/"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="musk-default-model">默认模型</label>
            <input
              id="musk-default-model"
              className="input"
              value={muskConfig.default_model}
              onChange={(event) => setMuskConfig((prev) => ({ ...prev, default_model: event.target.value }))}
              placeholder="gpt-5.5"
              autoComplete="off"
              maxLength={80}
              required
            />
          </div>

          <ModelOptionsField
            id="musk-allowed-models"
            label="对话可选模型"
            options={muskModelOptions}
            value={muskConfig.allowed_models || []}
            onChange={(next) => setMuskConfig((prev) => ({ ...prev, allowed_models: next }))}
            loading={muskModelsLoading}
            onRefresh={refreshMuskModels}
            refreshing={muskModelsRefreshing}
            hint="白名单为空时只开放默认模型；刷新会从上游 /models 拉取最新列表"
          />

          <div className="form-group">
            <label className="form-label" htmlFor="musk-api-key">API Key</label>
            <input
              id="musk-api-key"
              className="input"
              type="password"
              value={muskApiKey}
              onChange={(event) => {
                setMuskApiKey(event.target.value);
                if (event.target.value.trim()) setClearMuskApiKey(false);
              }}
              placeholder={muskConfig.api_key_configured ? '当前已设置，留空不变' : '输入 Musk API Key'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{muskStatusText}</strong>
          </div>
          <div>
            <span className="info-label">API 地址</span>
            <strong>{muskConfig.base_url || '-'}</strong>
          </div>
          <div>
            <span className="info-label">默认模型</span>
            <strong>{muskConfig.default_model || '-'}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{muskConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearMuskApiKey}
              disabled={!muskConfig.api_key_configured || Boolean(muskApiKey.trim())}
              onChange={(event) => setClearMuskApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={testMuskConfig}
            disabled={muskTesting || muskSaving || !muskConfig.ready}
          >
            {muskTesting ? '正在测试' : '测试连接'}
          </button>
          <button type="button" className="btn btn-secondary" title="角色文字设置" onClick={() => setRolePolicyOpen(true)} disabled={!currentUser?.id}>
            <Settings size={16} aria-hidden="true" /> 角色文字
          </button>
          <button className="btn btn-primary sd2-loading-surface" data-busy={muskSaving} type="submit" disabled={muskSaving}>
            {muskSaving ? '正在保存' : '保存 Musk API'}
          </button>
        </div>

        {muskTestState && (
          <div className={`codex-config-test-result ${muskTestState.type === 'success' ? 'is-success' : ''}`}>
            <strong>{muskTestState.message}</strong>
            {muskTestState.type === 'success' && (
              <span>
                {muskTestState.model || muskConfig.default_model}
                {typeof muskTestState.latency_ms === 'number' ? ` · ${muskTestState.latency_ms}ms` : ''}
                {muskTestState.tested_at && <> · <RelativeTime value={muskTestState.tested_at} /></>}
              </span>
            )}
            {muskTestState.type === 'error' && <span>请先确认地址、模型和 API Key 已保存。</span>}
          </div>
        )}
      </form>

      </details></section>
      <section hidden={selectedObject !== 'image'}>
      <ImageModelApiSettings accountId={currentUser?.id || null} onDraftChange={onImageDraftChange}
        onSaveStart={settingsSubmit.start} onSaveFinish={(group, saved) => settingsSubmit.finish(`imageGroup:${group}`, saved)} />
      <details><summary>Image 2.5 质量分档路由</summary><ImageQualityRoutingSettings accountId={currentUser?.id || null} /></details>
      </section>

      <section hidden={selectedObject !== 'codex'}>
      <p>Codex 视频接口 · {statusText} · {config.source_label}</p>
      <details><summary>具体配置与扣费用户</summary>
      <form className="codex-config-form" onSubmit={saveConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">Codex 视频接口</h2>
            <p className="text-gray text-sm mt-2">
              token 只保存哈希，页面不会回显明文。留空表示沿用当前 token。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 Codex 视频接口">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="codex-source-label">后台来源名称</label>
            <input
              id="codex-source-label"
              className="input"
              value={config.source_label}
              onChange={(event) => setConfig((prev) => ({ ...prev, source_label: event.target.value }))}
              placeholder="Codex API"
              maxLength={80}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="codex-user-selector-type">绑定用户方式</label>
            <select
              id="codex-user-selector-type"
              className="input"
              value={config.user_selector.type}
              onChange={(event) => updateSelector({ type: event.target.value as UserSelectorType })}
            >
              <option value="email">邮箱</option>
              <option value="username">用户名</option>
              <option value="id">用户 ID</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="codex-user-selector-value">
              {selectorLabel(config.user_selector.type)}
            </label>
            <input
              id="codex-user-selector-value"
              className="input"
              value={config.user_selector.value}
              onChange={(event) => updateSelector({ value: event.target.value })}
              placeholder={config.user_selector.type === 'email' ? 'admin@local.test' : '输入绑定用户'}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="codex-token">接口 token</label>
            <input
              id="codex-token"
              className="input"
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                if (event.target.value.trim()) setClearToken(false);
              }}
              placeholder={config.token_configured ? `当前 ${config.token_preview || '已设置'}，留空不变` : '输入长随机 token'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{statusText}</strong>
          </div>
          <div>
            <span className="info-label">Token</span>
            <strong>{config.token_configured ? (config.token_preview || '已设置') : '未设置'}</strong>
          </div>
          <div>
            <span className="info-label">绑定用户</span>
            <strong>
              {config.linked_user ? (
                <UserIdentityBadge user={config.linked_user} size="sm" subtitle={linkedUserSubtitle(config)} />
              ) : linkedUserSubtitle(config)}
            </strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearToken}
              disabled={!config.token_configured || Boolean(token.trim())}
              onChange={(event) => setClearToken(event.target.checked)}
            />
            清除当前 token
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={saving} type="submit" disabled={saving}>
            {saving ? '正在保存' : '保存配置'}
          </button>
        </div>

      </form>
      </details></section>
      {rolePolicyOpen && currentUser?.id && <RoleTextPolicySettings key={currentUser.id} accountId={currentUser.id}
        onClose={() => setRolePolicyOpen(false)} onDirtyChange={setRolePolicyDirty} onSavingChange={setRolePolicySaving} confirm={confirm} />}
    </fieldset>
  );
}
