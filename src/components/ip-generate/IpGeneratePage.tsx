'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  Database,
  KeyRound,
  Lock,
  ShieldCheck,
  Video,
} from 'lucide-react';
import type { AccountMenuUser } from '@/components/AccountMenu';
import ComposerTopbar, { type ComposerCreditSummary } from '@/components/ComposerTopbar';

type IpGenerateUser = AccountMenuUser & { id?: string };

interface AuthMeResponse {
  user: IpGenerateUser | null;
}

type SourceType = 'character' | 'portrait' | 'brand' | 'other';

interface IpGenerateDraft {
  prompt: string;
  sourceType: SourceType;
  sourceNote: string;
  assetIds: string;
  authorizationConfirmed: boolean;
}

const DRAFT_STORAGE_KEY = 'ip_generate_draft_v1';

const defaultDraft: IpGenerateDraft = {
  prompt: '',
  sourceType: 'character',
  sourceNote: '',
  assetIds: '',
  authorizationConfirmed: false,
};

const sourceTypeOptions: Array<{ value: SourceType; label: string }> = [
  { value: 'character', label: '授权角色 / IP' },
  { value: 'portrait', label: '授权真人 / 肖像' },
  { value: 'brand', label: '授权品牌 / 产品' },
  { value: 'other', label: '其他授权素材' },
];

const configItems = [
  {
    icon: KeyRound,
    label: 'API Key',
    value: '未配置',
    detail: '只允许服务端环境变量保存，不在前端输入或展示明文。',
    state: 'blocked',
  },
  {
    icon: Video,
    label: 'Model / Endpoint',
    value: '待配置',
    detail: '需要从火山控制台确认可用的 Seedance 2.0 模型或 Endpoint。',
    state: 'pending',
  },
  {
    icon: Database,
    label: '资源包 / 余额',
    value: '人工确认',
    detail: '真实烟测前确认资源包或余额，避免生成请求失败或产生意外费用。',
    state: 'pending',
  },
  {
    icon: ShieldCheck,
    label: '素材库授权',
    value: '待接入',
    detail: '真人素材和私域素材资产需要先完成官方授权和素材资产配置。',
    state: 'pending',
  },
] as const;

const assetRules = [
  '素材资产上传只接受公网可访问 URL，不接受 Base64。',
  '视频素材要求 2 到 15 秒，单个文件不超过 50 MB。',
  '真人素材必须完成真人认证和授权后，才能使用 asset://<asset ID>。',
  '提示词里用“图片1 / 视频1 / 音频1”引用素材，不直接写 Asset ID。',
];

function readDraft(): IpGenerateDraft {
  if (typeof window === 'undefined') return defaultDraft;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return defaultDraft;
    const parsed = JSON.parse(raw) as Partial<IpGenerateDraft>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : defaultDraft.prompt,
      sourceType: sourceTypeOptions.some((option) => option.value === parsed.sourceType)
        ? parsed.sourceType as SourceType
        : defaultDraft.sourceType,
      sourceNote: typeof parsed.sourceNote === 'string' ? parsed.sourceNote : defaultDraft.sourceNote,
      assetIds: typeof parsed.assetIds === 'string' ? parsed.assetIds : defaultDraft.assetIds,
      authorizationConfirmed: Boolean(parsed.authorizationConfirmed),
    };
  } catch {
    return defaultDraft;
  }
}

export default function IpGeneratePage() {
  const [user, setUser] = useState<IpGenerateUser | null>(null);
  const [credits, setCredits] = useState<ComposerCreditSummary | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [draft, setDraft] = useState<IpGenerateDraft>(defaultDraft);
  const [draftLoaded, setDraftLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: AuthMeResponse) => {
        if (!cancelled) {
          setUser(data.user || null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingUser(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetch('/api/me/credits', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled && data) {
          setCredits(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCredits(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    setDraft(readDraft());
    setDraftLoaded(true);
  }, []);

  useEffect(() => {
    if (!draftLoaded) return;
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  }, [draft, draftLoaded]);

  const authorizationMetadata = useMemo(() => ({
    authorization_confirmed: draft.authorizationConfirmed,
    source_type: draft.sourceType,
    source_note: draft.sourceNote.trim(),
    asset_ids: draft.assetIds
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    confirmed_at: draft.authorizationConfirmed ? 'submit_time' : null,
    confirmed_by: draft.authorizationConfirmed ? 'current_user' : null,
  }), [draft]);

  return (
    <div className="composer-page ip-generate-page">
      <ComposerTopbar user={user} loadingUser={loadingUser} credits={credits} />

      <main className="composer-main ip-generate-main">
        <section className="ip-generate-hero" aria-labelledby="ip-generate-title">
          <div className="ip-generate-hero-copy">
            <span className="ip-generate-kicker">Volcengine Ark / Seedance 2.0</span>
            <h1 id="ip-generate-title">IP生成</h1>
            <p>
              面向授权角色、授权真人素材和品牌 IP 的视频生成入口。当前 API 凭据未到位，页面只做配置与授权准备，不会提交生成任务。
            </p>
          </div>
          <div className="ip-generate-hero-actions">
            <Link href="/generate" className="composer-hero-action composer-hero-action-secondary">
              普通生成
            </Link>
            <Link href="/projects" className="composer-hero-action composer-hero-action-secondary">
              我的项目
            </Link>
            <button type="button" className="ip-generate-disabled-action" disabled>
              生成暂未开启
            </button>
          </div>
        </section>

        <section className="ip-generate-status" aria-label="火山配置状态">
          <div className="ip-generate-status-summary">
            <AlertCircle size={18} aria-hidden="true" />
            <div>
              <strong>当前不会扣点，也不会创建任务</strong>
              <span>缺少 API Key、Model ID 和资源包确认前，/generate/ip 不调用 /api/tasks/create。</span>
            </div>
          </div>
          <div className="ip-generate-config-grid">
            {configItems.map((item) => {
              const Icon = item.icon;
              return (
                <article className={`ip-generate-config-item is-${item.state}`} key={item.label}>
                  <div className="ip-generate-config-icon" aria-hidden="true">
                    <Icon size={18} />
                  </div>
                  <div>
                    <div className="ip-generate-config-head">
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                    <p>{item.detail}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <div className="ip-generate-layout">
          <section className="ip-generate-panel" aria-labelledby="ip-draft-title">
            <div className="ip-generate-panel-head">
              <div>
                <h2 id="ip-draft-title">生成草稿</h2>
                <p>先整理 IP 素材、授权说明和提示词，真实提交等 API 配置完成后再开启。</p>
              </div>
              <span className="ip-generate-panel-badge">本地保存</span>
            </div>

            <label className="ip-generate-field">
              <span>素材类型</span>
              <select
                value={draft.sourceType}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  sourceType: event.target.value as SourceType,
                }))}
              >
                {sourceTypeOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="ip-generate-field">
              <span>素材来源说明</span>
              <input
                value={draft.sourceNote}
                onChange={(event) => setDraft((current) => ({ ...current, sourceNote: event.target.value }))}
                placeholder="例如：品牌方已授权的角色三视图，授权合同编号..."
                maxLength={160}
              />
            </label>

            <label className="ip-generate-field">
              <span>受控 Asset ID</span>
              <input
                value={draft.assetIds}
                onChange={(event) => setDraft((current) => ({ ...current, assetIds: event.target.value }))}
                placeholder="asset://...，多个用英文逗号分隔"
                maxLength={240}
              />
            </label>

            <label className="ip-generate-field">
              <span>提示词草稿</span>
              <textarea
                value={draft.prompt}
                onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                placeholder="写清画面主体、动作、镜头、风格。引用素材时使用图片1、视频1、音频1。"
                rows={7}
                maxLength={1200}
              />
            </label>

            <label className="ip-generate-confirm">
              <input
                type="checkbox"
                checked={draft.authorizationConfirmed}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  authorizationConfirmed: event.target.checked,
                }))}
              />
              <span>我确认这些 IP、肖像、声音、商标或素材已获得授权，并允许用于生成测试。</span>
            </label>

            <div className="ip-generate-disabled-submit">
              <button type="button" disabled>
                API 未配置，暂不能生成
              </button>
              <span>当前只保存草稿，不冻结点数。</span>
            </div>
          </section>

          <aside className="ip-generate-panel" aria-labelledby="ip-config-title">
            <div className="ip-generate-panel-head">
              <div>
                <h2 id="ip-config-title">配置清单</h2>
                <p>这些项目完成后，才能打开真实火山方舟生成链路。</p>
              </div>
            </div>

            <div className="ip-generate-endpoints">
              <div>
                <span>视频生成 Base URL</span>
                <code>https://ark.cn-beijing.volces.com/api/v3</code>
              </div>
              <div>
                <span>素材管理 Base URL</span>
                <code>https://ark.cn-beijing.volcengineapi.com/?Action=...&amp;Version=2024-01-01</code>
              </div>
            </div>

            <ul className="ip-generate-rule-list">
              {assetRules.map((rule) => (
                <li key={rule}>
                  <CheckCircle2 size={15} aria-hidden="true" />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>

            <div className="ip-generate-metadata-preview">
              <div className="ip-generate-metadata-title">
                <ClipboardCheck size={16} aria-hidden="true" />
                <span>后续写入 metadata</span>
              </div>
              <pre>{JSON.stringify(authorizationMetadata, null, 2)}</pre>
            </div>

            <div className="ip-generate-lock-note">
              <Lock size={15} aria-hidden="true" />
              <span>API Key、Access Key 和签名参数只允许放在服务端，不进入浏览器。</span>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
