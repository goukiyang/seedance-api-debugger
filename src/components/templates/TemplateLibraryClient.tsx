'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ImageIcon,
  Pencil,
  PlayCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import type { SerializedGenerationTemplate, SerializedTemplateAsset } from '@/lib/templates/workbench';
import { TemplateEditorDrawer } from '@/components/templates/TemplateEditorDrawer';

type TemplateLibraryUser = {
  id: string;
  role: 'admin' | 'user';
};

type TemplateViewModel = {
  template: SerializedGenerationTemplate;
  previewUrl: string | null;
  scenario: string;
  ratio: string;
  duration: string;
  statusLabel: string;
  statusTone: 'ready' | 'draft' | 'archived';
  assetTone: 'complete' | 'partial' | 'missing';
  assetLabel: string;
  activeAssets: SerializedTemplateAsset[];
  activeRulesCount: number;
  activePromptsCount: number;
  modules: string[];
  searchText: string;
};

const SCENE_FILTERS = ['全部场景', '品牌宣传', '产品展示', 'IP角色', '活动推广', '科技感'] as const;
const STATUS_FILTERS = ['全部状态', '可直接用', '需补素材', '维护中'] as const;

function cleanText(value: string | null | undefined) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function inferScenario(template: SerializedGenerationTemplate) {
  const text = [
    template.name,
    template.description,
    template.template_key,
    ...Object.values(template.module_bindings || {}),
    ...template.rules.map((rule) => rule.content),
    ...template.prompts.map((prompt) => prompt.content),
  ].join(' ').toLowerCase();

  if (/ip|角色|character|mascot|形象|人物|兔/.test(text)) return 'IP角色';
  if (/产品|product|卖点|功能|展示|电商|转化/.test(text)) return '产品展示';
  if (/活动|节日|campaign|促销|发布会|上新/.test(text)) return '活动推广';
  if (/科技|tech|未来|数字|芯片|ai|智能/.test(text)) return '科技感';
  return '品牌宣传';
}

function isUsableImageUrl(value: string | null | undefined) {
  if (!value) return false;
  return !/\.(mp4|mov|webm|m4v)(\?|$)/i.test(value);
}

function getPreviewUrl(template: SerializedGenerationTemplate) {
  const activeAssets = template.assets.filter((asset) => asset.status === 'active');
  const preferred = activeAssets.find((asset) => isUsableImageUrl(asset.thumbnail_url))
    || activeAssets.find((asset) => isUsableImageUrl(asset.url));
  return preferred?.thumbnail_url || preferred?.url || null;
}

function getStatusMeta(template: SerializedGenerationTemplate) {
  if (template.status === 'draft') return { label: '维护中', tone: 'draft' as const };
  if (template.status === 'archived') return { label: '已归档', tone: 'archived' as const };
  return { label: '可直接用', tone: 'ready' as const };
}

function getAssetMeta(template: SerializedGenerationTemplate) {
  const activeAssets = template.assets.filter((asset) => asset.status === 'active');
  const types = new Set(activeAssets.map((asset) => asset.asset_type));
  if (activeAssets.length === 0) return { label: '需补素材', tone: 'missing' as const };
  if (types.has('character') && types.has('logo') && types.has('style')) {
    return { label: '素材完整', tone: 'complete' as const };
  }
  return { label: '部分素材', tone: 'partial' as const };
}

function getDurationLabel(template: SerializedGenerationTemplate) {
  if (template.temporal.enabled) return `${template.temporal.segment}s 分段`;
  if (template.defaults.duration) return `${template.defaults.duration}s`;
  return '默认时长';
}

function buildTemplateView(template: SerializedGenerationTemplate): TemplateViewModel {
  const status = getStatusMeta(template);
  const asset = getAssetMeta(template);
  const activeAssets = template.assets.filter((item) => item.status === 'active');
  const activeRules = template.rules.filter((item) => item.status === 'active');
  const activePrompts = template.prompts.filter((item) => item.status === 'active');
  const modules = Object.values(template.module_bindings || {}).filter((value): value is string => Boolean(value));
  const scenario = inferScenario(template);
  const searchText = [
    template.name,
    template.description,
    template.version,
    template.template_key,
    scenario,
    ...modules,
    ...activeAssets.map((item) => item.label),
    ...activeRules.map((item) => item.content),
    ...activePrompts.map((item) => item.content),
  ].join(' ').toLowerCase();

  return {
    template,
    previewUrl: getPreviewUrl(template),
    scenario,
    ratio: template.defaults.ratio || '默认比例',
    duration: getDurationLabel(template),
    statusLabel: status.label,
    statusTone: status.tone,
    assetTone: asset.tone,
    assetLabel: asset.label,
    activeAssets,
    activeRulesCount: activeRules.length,
    activePromptsCount: activePrompts.length,
    modules,
    searchText,
  };
}

function formatUpdatedAt(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function TemplateLibraryClient() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<TemplateLibraryUser | null>(null);
  const [templates, setTemplates] = useState<SerializedGenerationTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sceneFilter, setSceneFilter] = useState<(typeof SCENE_FILTERS)[number]>('全部场景');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('全部状态');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [failedPreviewIds, setFailedPreviewIds] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canManageTemplates = currentUser?.role === 'admin';

  const loadTemplates = useCallback(async (preferredTemplateId?: string | null) => {
    setLoading(true);
    setError('');
    try {
      const authResponse = await fetch('/api/auth/me', { cache: 'no-store' });
      const authData = authResponse.ok ? await authResponse.json() : {};
      const user = authData.user || null;
      setCurrentUser(user);

      const listUrl = user?.role === 'admin' ? '/api/templates?include_inactive=true' : '/api/templates';
      const response = await fetch(listUrl, { cache: 'no-store' });
      const data = await response.json();
      if (response.status === 401) throw new Error('请先登录后查看动画模板');
      if (!response.ok) throw new Error(data.message || data.error || '模板列表加载失败');

      const items = Array.isArray(data.templates) ? data.templates as SerializedGenerationTemplate[] : [];
      setTemplates(items);
      setSelectedTemplateId((current) => {
        const preferred = preferredTemplateId || current;
        return (preferred && items.some((item) => item.id === preferred)) ? preferred : items[0]?.id || null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '模板列表加载失败');
      setTemplates([]);
      setSelectedTemplateId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const templateViews = useMemo(() => templates.map(buildTemplateView), [templates]);
  const filteredViews = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return templateViews.filter((view) => {
      const sceneMatched = sceneFilter === '全部场景' || view.scenario === sceneFilter;
      const statusMatched = statusFilter === '全部状态'
        || (statusFilter === '可直接用' && view.statusTone === 'ready')
        || (statusFilter === '需补素材' && view.assetTone === 'missing')
        || (statusFilter === '维护中' && view.statusTone === 'draft');
      const keywordMatched = !keyword || view.searchText.includes(keyword);
      return sceneMatched && statusMatched && keywordMatched;
    });
  }, [sceneFilter, search, statusFilter, templateViews]);

  useEffect(() => {
    if (filteredViews.length === 0) return;
    if (!selectedTemplateId || !filteredViews.some((view) => view.template.id === selectedTemplateId)) {
      setSelectedTemplateId(filteredViews[0].template.id);
    }
  }, [filteredViews, selectedTemplateId]);

  const selectedView = useMemo(() => {
    return templateViews.find((view) => view.template.id === selectedTemplateId)
      || filteredViews[0]
      || templateViews[0]
      || null;
  }, [filteredViews, selectedTemplateId, templateViews]);

  const handleUseTemplate = useCallback(() => {
    if (!selectedView) return;
    router.push(`/template-generate?templateId=${encodeURIComponent(selectedView.template.id)}`);
  }, [router, selectedView]);

  const handleSaveTemplate = useCallback(async (payload: Record<string, unknown>) => {
    if (!selectedView) return;
    setSavingTemplate(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/templates/${selectedView.template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || '模板保存失败');
      await loadTemplates(data.template?.id || selectedView.template.id);
      setDrawerOpen(false);
    } catch (saveTemplateError) {
      setSaveError(saveTemplateError instanceof Error ? saveTemplateError.message : '模板保存失败');
    } finally {
      setSavingTemplate(false);
    }
  }, [loadTemplates, selectedView]);

  const selectedPreviewFailed = selectedView ? failedPreviewIds.includes(selectedView.template.id) : false;

  return (
    <div className="template-library-page">
      <section className="template-library-head" aria-label="动画模板选择">
        <div>
          <span className="template-library-kicker">Animation Templates</span>
          <h1>选择动画模板</h1>
          <p>先选一个结构稳定的模板，再进入模板生成工作台填写本次需求。</p>
        </div>
        <div className="template-library-head-actions">
          <Link href="/generate">普通生成</Link>
          <Link href="/template-generate">直接进入工作台</Link>
        </div>
      </section>

      <section className="template-library-shell" aria-label="模板库">
        <aside className="template-library-filters" aria-label="模板筛选">
          <label className="template-library-search">
            <Search size={16} aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="搜索模板、场景、素材或规则"
            />
          </label>

          <div className="template-library-filter-group">
            <span><SlidersHorizontal size={15} aria-hidden="true" /> 场景</span>
            <div className="template-library-filter-list">
              {SCENE_FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={sceneFilter === item ? 'is-active' : ''}
                  onClick={() => setSceneFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="template-library-filter-group">
            <span>状态</span>
            <div className="template-library-filter-list">
              {STATUS_FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={statusFilter === item ? 'is-active' : ''}
                  onClick={() => setStatusFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="template-library-filter-summary">
            <strong>{filteredViews.length}</strong>
            <span>个模板匹配当前条件</span>
          </div>
        </aside>

        <main className="template-library-main" aria-label="模板列表">
          {loading && (
            <div className="template-library-state">
              <span className="template-library-spinner" aria-hidden="true" />
              <strong>正在加载模板库</strong>
              <p>读取可用模板、固定素材和规则摘要。</p>
            </div>
          )}

          {!loading && error && (
            <div className="template-library-state is-error">
              <AlertTriangle size={22} aria-hidden="true" />
              <strong>{error}</strong>
              <p>如果登录状态已过期，请重新登录后再试。</p>
              <Link href="/login?next=/templates">去登录</Link>
            </div>
          )}

          {!loading && !error && templates.length === 0 && (
            <div className="template-library-state">
              <ImageIcon size={22} aria-hidden="true" />
              <strong>还没有可用模板</strong>
              <p>管理员创建模板后，这里会显示可选择的动画模板。</p>
            </div>
          )}

          {!loading && !error && templates.length > 0 && filteredViews.length === 0 && (
            <div className="template-library-state">
              <Search size={22} aria-hidden="true" />
              <strong>没有匹配模板</strong>
              <p>清空搜索或筛选条件后再选择。</p>
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setSceneFilter('全部场景');
                  setStatusFilter('全部状态');
                }}
              >
                清空筛选
              </button>
            </div>
          )}

          {!loading && !error && filteredViews.length > 0 && (
            <div className="template-library-grid">
              {filteredViews.map((view) => {
                const selected = selectedView?.template.id === view.template.id;
                const previewFailed = failedPreviewIds.includes(view.template.id);
                return (
                  <button
                    key={view.template.id}
                    type="button"
                    className={`template-library-card ${selected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedTemplateId(view.template.id)}
                    aria-pressed={selected}
                  >
                    <span className="template-library-card-preview">
                      {view.previewUrl && !previewFailed ? (
                        <img
                          src={view.previewUrl}
                          alt={`${view.template.name} 模板预览`}
                          loading="lazy"
                          onError={() => setFailedPreviewIds((current) => (
                            current.includes(view.template.id) ? current : [...current, view.template.id]
                          ))}
                        />
                      ) : (
                        <span>
                          <ImageIcon size={24} aria-hidden="true" />
                          暂无预览
                        </span>
                      )}
                      <em className={`template-library-status ${view.statusTone}`}>{view.statusLabel}</em>
                    </span>
                    <span className="template-library-card-body">
                      <span className="template-library-card-topline">
                        <strong>{view.template.name}</strong>
                        <small>{view.template.version}</small>
                      </span>
                      <span className="template-library-card-desc">
                        {cleanText(view.template.description) || `${view.scenario}模板，适合快速生成结构一致的视频。`}
                      </span>
                      <span className="template-library-card-meta">
                        <span>{view.scenario}</span>
                        <span>{view.ratio}</span>
                        <span>{view.duration}</span>
                      </span>
                      <span className={`template-library-asset ${view.assetTone}`}>
                        {view.assetTone === 'complete' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                        {view.assetLabel}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </main>

        <aside className="template-library-preview" aria-label="模板预览">
          {selectedView ? (
            <>
              <div className="template-library-preview-media">
                {selectedView.previewUrl && !selectedPreviewFailed ? (
                  <img
                    src={selectedView.previewUrl}
                    alt={`${selectedView.template.name} 大图预览`}
                    onError={() => setFailedPreviewIds((current) => (
                      current.includes(selectedView.template.id) ? current : [...current, selectedView.template.id]
                    ))}
                  />
                ) : (
                  <span>
                    <ImageIcon size={34} aria-hidden="true" />
                    暂无预览
                  </span>
                )}
              </div>

              <div className="template-library-preview-title">
                <span className="template-library-kicker">{selectedView.scenario}</span>
                <h2>{selectedView.template.name}</h2>
                <p>{cleanText(selectedView.template.description) || '适合按固定角色、Logo、风格和规则生成一致的视频。'}</p>
              </div>

              <div className="template-library-preview-actions">
                <button type="button" className="is-primary" onClick={handleUseTemplate}>
                  <PlayCircle size={17} aria-hidden="true" />
                  使用此模板
                </button>
                {canManageTemplates && (
                  <button type="button" onClick={() => setDrawerOpen(true)}>
                    <Pencil size={16} aria-hidden="true" />
                    编辑模板
                  </button>
                )}
              </div>

              <div className="template-library-facts">
                <div>
                  <span>比例</span>
                  <strong>{selectedView.ratio}</strong>
                </div>
                <div>
                  <span>时长</span>
                  <strong>{selectedView.duration}</strong>
                </div>
                <div>
                  <span>规则</span>
                  <strong>{selectedView.activeRulesCount} 条</strong>
                </div>
                <div>
                  <span>素材</span>
                  <strong>{selectedView.activeAssets.length} 个</strong>
                </div>
              </div>

              <div className="template-library-detail-block">
                <span><Sparkles size={15} aria-hidden="true" /> 模板结构</span>
                <p>
                  {selectedView.modules.length > 0
                    ? selectedView.modules.slice(0, 4).join(' / ')
                    : '模块未绑定，进入工作台后仍可按模板默认流程生成。'}
                </p>
              </div>

              <div className="template-library-detail-block">
                <span><Clock3 size={15} aria-hidden="true" /> 决策信息</span>
                <p>
                  {selectedView.activePromptsCount} 个提示词模块，更新于 {formatUpdatedAt(selectedView.template.updated_at)}。
                  {selectedView.template.temporal.enabled ? ` 已启用 ${selectedView.template.temporal.segment}s 分段。` : ' 未启用分段。'}
                </p>
              </div>

              {selectedView.activeAssets.length > 0 && (
                <div className="template-library-asset-strip" aria-label="固定素材">
                  {selectedView.activeAssets.slice(0, 4).map((asset) => (
                    <span key={asset.id || `${asset.asset_type}-${asset.label}`}>
                      {asset.thumbnail_url || asset.url ? <img src={asset.thumbnail_url || asset.url || ''} alt={asset.label} /> : <ImageIcon size={16} />}
                      <small>{asset.label}</small>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="template-library-state">
              <ImageIcon size={22} aria-hidden="true" />
              <strong>选择一个模板</strong>
              <p>点击左侧模板后，这里会显示结构、素材和使用入口。</p>
            </div>
          )}
        </aside>
      </section>

      {canManageTemplates && (
        <TemplateEditorDrawer
          open={drawerOpen}
          template={selectedView?.template || null}
          saving={savingTemplate}
          error={saveError}
          onClose={() => setDrawerOpen(false)}
          onSave={handleSaveTemplate}
        />
      )}
    </div>
  );
}
