'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ImageIcon, Plus, Sparkles } from 'lucide-react';
import type { SerializedGenerationTemplate } from '@/lib/templates/workbench';
import { TemplateEditorDrawer } from '@/components/templates/TemplateEditorDrawer';

type Props = {
  initialTemplateId?: string | null;
  initialCardId?: string | null;
};

type TemplateConfigDraft = {
  templateDraft: {
    name: string;
    description: string | null;
    status: 'draft' | 'active' | 'archived';
    version: string;
    template_key?: string;
  };
  defaultParams: {
    ratio: string | null;
    duration: number | null;
    resolution: string | null;
  };
  modulePlan: Array<{ moduleType: string; source: string; name: string }>;
  promptBlocks: Record<string, string>;
  rules: unknown[];
  assetBindings: unknown[];
  temporal: { enabled: boolean; segment: number; handoff: boolean };
  promptFormat: Record<string, unknown>;
  planStrategy: Record<string, unknown>;
  validationChecklist: string[];
  missingInputs: string[];
};

function statusLabel(status: string) {
  if (status === 'draft') return '草稿';
  if (status === 'archived') return '已停用';
  return '已发布';
}

function cardStats(template: SerializedGenerationTemplate | null) {
  const cards = template?.module_bindings.context_cards || [];
  const enabled = cards.filter((card) => card.enabled);
  return {
    total: cards.length,
    enabled: enabled.length,
    force: enabled.filter((card) => card.mode === 'force').length,
    reference: enabled.filter((card) => card.mode === 'reference').length,
    images: enabled.filter((card) => card.bound_image).length,
  };
}

function publishIssues(template: SerializedGenerationTemplate | null) {
  if (!template) return [];
  const stats = cardStats(template);
  const issues = [];
  if (!template.name.trim()) issues.push('缺少模板名称');
  if (stats.enabled === 0) issues.push('没有启用的上下文卡片');
  if (stats.force === 0) issues.push('至少需要 1 张强制插入卡片');
  if (template.status === 'archived') issues.push('模板已停用');
  return issues;
}

export function AdminTemplatesClient({ initialTemplateId = null, initialCardId = null }: Props) {
  const detailWorkspaceMode = Boolean(initialTemplateId);
  const cardEditorMode = Boolean(initialTemplateId && initialCardId);
  const router = useRouter();
  const [templates, setTemplates] = useState<SerializedGenerationTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialTemplateId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderInput, setBuilderInput] = useState('');
  const [builderBusy, setBuilderBusy] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [builderNotice, setBuilderNotice] = useState<string | null>(null);
  const [builderDraft, setBuilderDraft] = useState<TemplateConfigDraft | null>(null);
  const [builderAgentRunId, setBuilderAgentRunId] = useState<string | null>(null);

  const loadTemplates = useCallback(async (preferredId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/templates?include_inactive=true', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '模板列表加载失败');
      const items: SerializedGenerationTemplate[] = data.templates || [];
      setTemplates(items);
      setSelectedId((current) => {
        const preferred = preferredId || current || initialTemplateId;
        return preferred && items.some((item) => item.id === preferred) ? preferred : items[0]?.id || null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '模板列表加载失败');
      setTemplates([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, [initialTemplateId]);

  useEffect(() => {
    void loadTemplates(initialTemplateId);
  }, [initialTemplateId, loadTemplates]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) || templates[0] || null,
    [selectedId, templates],
  );
  const stats = cardStats(selectedTemplate);
  const issues = publishIssues(selectedTemplate);

  const handleSaveTemplate = useCallback(async (payload: Record<string, unknown>) => {
    if (!selectedTemplate) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/templates/${selectedTemplate.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '模板保存失败');
      await loadTemplates(data.template?.id || selectedTemplate.id);
      if (!detailWorkspaceMode) setDrawerOpen(false);
    } catch (saveTemplateError) {
      setSaveError(saveTemplateError instanceof Error ? saveTemplateError.message : '模板保存失败');
    } finally {
      setSaving(false);
    }
  }, [detailWorkspaceMode, loadTemplates, selectedTemplate]);

  const generateTemplateDraft = async () => {
    if (!builderInput.trim()) {
      setBuilderError('请先描述要创建的模板。');
      return;
    }
    setBuilderBusy(true);
    setBuilderError(null);
    setBuilderNotice(null);
    setBuilderDraft(null);
    setBuilderAgentRunId(null);
    try {
      const response = await fetch('/api/templates/config-builder/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: builderInput }),
      });
      const data = await response.json();
      setBuilderAgentRunId(data.agent_run_id || null);
      if (!response.ok) throw new Error(data.error || data.message || '模板草稿生成失败');
      if (data.needs_clarification) {
        setBuilderNotice(`LLM 需要先追问：${(data.questions || []).join(' / ') || '缺少关键信息'}`);
        return;
      }
      if (!data.draft) throw new Error((data.validation_errors || []).join(' / ') || 'LLM 没有返回模板草稿');
      setBuilderDraft(data.draft);
      setBuilderNotice('已生成模板草稿，保存后会进入模板工作台继续编排上下文卡片。');
    } catch (generateError) {
      setBuilderError(generateError instanceof Error ? generateError.message : '模板草稿生成失败');
    } finally {
      setBuilderBusy(false);
    }
  };

  const saveBuilderDraft = async () => {
    if (!builderDraft) return;
    setBuilderBusy(true);
    setBuilderError(null);
    try {
      const response = await fetch('/api/templates/config-builder/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft: builderDraft,
          agent_run_id: builderAgentRunId,
          mode: 'draft',
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.template) throw new Error(data.error || data.message || '保存模板草稿失败');
      setBuilderOpen(false);
      setBuilderInput('');
      setBuilderDraft(null);
      await loadTemplates(data.template.id);
      setDrawerOpen(false);
      router.push(`/admin/templates/${data.template.id}`);
    } catch (saveDraftError) {
      setBuilderError(saveDraftError instanceof Error ? saveDraftError.message : '保存模板草稿失败');
    } finally {
      setBuilderBusy(false);
    }
  };

  if (cardEditorMode) {
    const pageTitle = selectedTemplate?.name || '模板上下文卡片';

    return (
      <div className="admin-template-page is-card-editor">
        <header className="template-card-page-head">
          <Link className="template-card-page-back" href={`/admin/templates/${initialTemplateId}`}>
            返回卡片列表
          </Link>
          <div>
            <span>上下文卡片二级编辑</span>
            <h1>{pageTitle}</h1>
            <p>编辑这张卡片最终写入 LLM 的内容、参考设置和绑定图片。</p>
          </div>
        </header>

        <main className="template-card-page-body">
          {loading && <div className="admin-template-state">读取模板中...</div>}
          {!loading && error && <div className="admin-template-state is-error">{error}</div>}
          {!loading && !selectedTemplate && !error && (
            <div className="admin-template-state">没有找到这个模板</div>
          )}
          {!loading && selectedTemplate && (
            <TemplateEditorDrawer
              open
              variant="card"
              template={selectedTemplate}
              cardId={initialCardId}
              saving={saving}
              error={saveError}
              onClose={() => undefined}
              onSave={handleSaveTemplate}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="admin-template-page">
      <header className="admin-template-head">
        <div>
          <span>模板工作台</span>
          <h1>模板上下文卡片</h1>
          <p>管理员只需要维护卡片、绑定图片、预览最终提示词，再试生成和发布。</p>
        </div>
        <div className="admin-template-actions">
          <button type="button" onClick={() => setBuilderOpen((current) => !current)}>
            <Sparkles size={16} aria-hidden="true" />
            用 LLM 新建模板
          </button>
          <Link href="/admin/integrations">API 设置</Link>
        </div>
      </header>

      {builderOpen && (
        <section className="admin-template-builder">
          <label>
            <span>描述模板目标</span>
            <textarea
              value={builderInput}
              onChange={(event) => setBuilderInput(event.currentTarget.value)}
              rows={4}
              placeholder="例如：做一个品牌宣传用的兔子 IP 视频模板，角色活泼，Logo 要清晰，适合 15 秒短视频。"
            />
          </label>
          <div className="admin-template-builder-actions">
            <button type="button" onClick={generateTemplateDraft} disabled={builderBusy}>
              {builderBusy ? 'LLM 生成中...' : builderDraft ? '重新生成草稿' : '生成模板草稿'}
            </button>
            <button type="button" onClick={saveBuilderDraft} disabled={!builderDraft || builderBusy}>
              保存草稿并编辑卡片
            </button>
            {builderAgentRunId && <Link href={`/admin/agent-runs/${builderAgentRunId}`}>查看链路</Link>}
          </div>
          {builderError && <div className="template-drawer-error">{builderError}</div>}
          {builderNotice && <div className="template-builder-notice">{builderNotice}</div>}
          {builderDraft && (
            <div className="admin-template-draft-preview">
              <strong>{builderDraft.templateDraft.name}</strong>
              <p>{builderDraft.templateDraft.description || 'LLM 已生成模板结构草稿。'}</p>
              <dl>
                <div><dt>模块</dt><dd>{builderDraft.modulePlan.length}</dd></div>
                <div><dt>规则</dt><dd>{builderDraft.rules.length}</dd></div>
                <div><dt>缺失信息</dt><dd>{builderDraft.missingInputs.length ? builderDraft.missingInputs.join(' / ') : '无'}</dd></div>
              </dl>
            </div>
          )}
        </section>
      )}

      <section className={detailWorkspaceMode ? 'admin-template-shell is-workspace' : 'admin-template-shell'}>
        {!detailWorkspaceMode && (
          <aside className="admin-template-list">
            {loading && <div className="admin-template-state">读取模板中...</div>}
            {!loading && error && <div className="admin-template-state is-error">{error}</div>}
            {!loading && !error && templates.length === 0 && (
              <div className="admin-template-state">
                <Plus size={18} aria-hidden="true" />
                <span>还没有模板，先用 LLM 新建一个草稿。</span>
              </div>
            )}
            {templates.map((template) => {
              const templateStats = cardStats(template);
              const selected = selectedTemplate?.id === template.id;
              return (
                <button
                  key={template.id}
                  type="button"
                  className={selected ? 'is-active' : ''}
                  onClick={() => setSelectedId(template.id)}
                >
                  <strong>{template.name}</strong>
                  <span>{statusLabel(template.status)} · {templateStats.enabled}/{templateStats.total} 张卡片启用 · {templateStats.images} 张图</span>
                </button>
              );
            })}
          </aside>
        )}

        <main className={detailWorkspaceMode ? 'admin-template-workspace-detail' : 'admin-template-detail'}>
          {selectedTemplate ? (
            detailWorkspaceMode ? (
              <TemplateEditorDrawer
                open
                variant={cardEditorMode ? 'card' : 'inline'}
                template={selectedTemplate}
                cardId={initialCardId}
                saving={saving}
                error={saveError}
                onClose={() => undefined}
                onSave={handleSaveTemplate}
              />
            ) : (
              <>
              <div className="admin-template-detail-head">
                <div>
                  <span>{statusLabel(selectedTemplate.status)} · {selectedTemplate.version}</span>
                  <h2>{selectedTemplate.name}</h2>
                  <p>{selectedTemplate.description || '暂无模板说明。'}</p>
                </div>
                <Link href={`/admin/templates/${selectedTemplate.id}`}>编辑上下文卡片</Link>
              </div>

              <div className="admin-template-metrics">
                <div><span>启用卡片</span><strong>{stats.enabled}</strong></div>
                <div><span>强制插入</span><strong>{stats.force}</strong></div>
                <div><span>仅供参考</span><strong>{stats.reference}</strong></div>
                <div><span>绑定图片</span><strong>{stats.images}</strong></div>
              </div>

              <section className="admin-template-card-preview">
                <h3>卡片预览</h3>
                {(selectedTemplate.module_bindings.context_cards || []).slice(0, 8).map((card) => (
                  <article key={card.id} className={card.enabled ? '' : 'is-disabled'}>
                    <div className="admin-template-card-thumb">
                      {card.bound_image?.thumbnail_url || card.bound_image?.url ? (
                        <img src={card.bound_image.thumbnail_url || card.bound_image.url || ''} alt={card.bound_image.label} />
                      ) : (
                        <ImageIcon size={18} aria-hidden="true" />
                      )}
                    </div>
                    <div>
                      <strong>{card.title}</strong>
                      <p>{card.content}</p>
                    </div>
                    <span>{card.mode === 'force' ? '强制插入' : '仅供参考'}</span>
                  </article>
                ))}
              </section>

              <section className="admin-template-publish">
                <h3>发布检查</h3>
                {issues.length === 0 ? (
                  <div className="admin-template-check-ok">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    已具备发布基础条件，下一步进行试生成。
                  </div>
                ) : (
                  <ul>
                    {issues.map((issue) => (
                      <li key={issue}><AlertTriangle size={15} aria-hidden="true" /> {issue}</li>
                    ))}
                  </ul>
                )}
                <div className="admin-template-publish-actions">
                  <Link href={`/template-generate?templateId=${selectedTemplate.id}`}>试生成</Link>
                  <Link href="/admin/agent-runs">查看生成链路</Link>
                </div>
              </section>
              </>
            )
          ) : (
            <div className="admin-template-state">请选择一个模板</div>
          )}
        </main>
      </section>

      <TemplateEditorDrawer
        open={drawerOpen}
        template={selectedTemplate}
        saving={saving}
        error={saveError}
        onClose={() => setDrawerOpen(false)}
        onSave={handleSaveTemplate}
      />
    </div>
  );
}
