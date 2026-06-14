'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SerializedGenerationTemplate, TemplateAssetType, TemplateRuleType } from '@/lib/templates/workbench';

type Props = {
  open: boolean;
  template: SerializedGenerationTemplate | null;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
};

const ruleTypes: Array<{ key: TemplateRuleType; label: string }> = [
  { key: 'must', label: 'MUST' },
  { key: 'forbid', label: 'FORBID' },
  { key: 'suggest', label: 'SUGGEST' },
];

const assetTypes: Array<{ key: TemplateAssetType; label: string }> = [
  { key: 'character', label: 'Character' },
  { key: 'logo', label: 'Logo' },
  { key: 'style', label: 'Style' },
  { key: 'other', label: 'Other' },
];

type AssetDraft = {
  asset_type: TemplateAssetType;
  label: string;
  url: string;
  thumbnail_url: string;
  reference_image_id: string;
  sort_order: number;
  status: string;
};

type RuleDraft = {
  rule_type: TemplateRuleType;
  content: string;
  priority: number;
  sort_order: number;
  status: string;
};

function promptByType(template: SerializedGenerationTemplate | null, blockType: string) {
  return template?.prompts.find((prompt) => prompt.block_type === blockType && prompt.status === 'active')?.content || '';
}

function assetDraftsFromTemplate(template: SerializedGenerationTemplate | null): AssetDraft[] {
  const existing = template?.assets
    .filter((asset) => asset.status === 'active')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((asset, index) => ({
      asset_type: asset.asset_type,
      label: asset.label,
      url: asset.url || '',
      thumbnail_url: asset.thumbnail_url || '',
      reference_image_id: asset.reference_image_id || '',
      sort_order: asset.sort_order || index + 1,
      status: asset.status,
    })) || [];
  if (existing.length > 0) return existing;
  return [
    { asset_type: 'character', label: '角色参考图', url: '', thumbnail_url: '', reference_image_id: '', sort_order: 1, status: 'active' },
    { asset_type: 'logo', label: 'Logo资源', url: '', thumbnail_url: '', reference_image_id: '', sort_order: 2, status: 'active' },
    { asset_type: 'style', label: '风格参考图', url: '', thumbnail_url: '', reference_image_id: '', sort_order: 3, status: 'active' },
  ];
}

function ruleDraftsFromTemplate(template: SerializedGenerationTemplate | null): RuleDraft[] {
  return template?.rules
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((rule, index) => ({
      rule_type: rule.rule_type,
      content: rule.content,
      priority: rule.priority,
      sort_order: rule.sort_order || index + 1,
      status: rule.status,
    })) || [];
}

export function TemplateEditorDrawer({ open, template, saving = false, error, onClose, onSave }: Props) {
  const [activeTab, setActiveTab] = useState<'modules' | 'rules' | 'assets'>('modules');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('active');
  const [version, setVersion] = useState('v1');
  const [character, setCharacter] = useState('');
  const [logo, setLogo] = useState('');
  const [style, setStyle] = useState('');
  const [camera, setCamera] = useState('');
  const [segmentEnabled, setSegmentEnabled] = useState(true);
  const [segment, setSegment] = useState(15);
  const [handoff, setHandoff] = useState(false);
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>([]);
  const [characterPrompt, setCharacterPrompt] = useState('');
  const [logoPrompt, setLogoPrompt] = useState('');
  const [stylePrompt, setStylePrompt] = useState('');
  const [globalPrompt, setGlobalPrompt] = useState('');
  const [assets, setAssets] = useState<AssetDraft[]>([]);

  useEffect(() => {
    if (!template) return;
    setName(template.name);
    setDescription(template.description || '');
    setStatus(template.status);
    setVersion(template.version);
    setCharacter(template.module_bindings.character || '');
    setLogo(template.module_bindings.logo || '');
    setStyle(template.module_bindings.style || '');
    setCamera(template.module_bindings.camera || '');
    setSegmentEnabled(template.temporal.enabled);
    setSegment(template.temporal.segment);
    setHandoff(template.temporal.handoff);
    setRuleDrafts(ruleDraftsFromTemplate(template));
    setCharacterPrompt(promptByType(template, 'character'));
    setLogoPrompt(promptByType(template, 'logo'));
    setStylePrompt(promptByType(template, 'style'));
    setGlobalPrompt(promptByType(template, 'global'));
    setAssets(assetDraftsFromTemplate(template));
    setActiveTab('modules');
  }, [template]);

  const ruleCount = useMemo(() => {
    return ruleDrafts.filter((rule) => rule.status === 'active' && rule.content.trim()).length;
  }, [ruleDrafts]);

  if (!open || !template) return null;

  const buildPayload = () => ({
      name,
      description,
      status,
      version,
      module_bindings: { character, logo, style, camera },
      temporal: { enabled: segmentEnabled, segment, handoff },
      defaults: template.defaults,
      assets: assets
        .filter((asset) => asset.label.trim())
        .map((asset, index) => ({
          asset_type: asset.asset_type,
          label: asset.label.trim(),
          url: asset.url.trim() || null,
          thumbnail_url: asset.thumbnail_url.trim() || null,
          reference_image_id: asset.reference_image_id.trim() || null,
          sort_order: index + 1,
          status: asset.status,
        })),
      rules: ruleDrafts
        .filter((rule) => rule.content.trim())
        .map((rule, index) => ({
          rule_type: rule.rule_type,
          content: rule.content.trim(),
          priority: rule.priority,
          sort_order: index + 1,
          status: rule.status,
        })),
      prompts: [
        { block_type: 'character', content: characterPrompt, sort_order: 1, status: 'active' },
        { block_type: 'logo', content: logoPrompt, sort_order: 2, status: 'active' },
        { block_type: 'style', content: stylePrompt, sort_order: 3, status: 'active' },
        { block_type: 'global', content: globalPrompt, sort_order: 4, status: 'active' },
      ].filter((prompt) => prompt.content.trim()),
  });

  const initialPayload = {
    name: template.name,
    description: template.description || '',
    status: template.status,
    version: template.version,
    module_bindings: template.module_bindings,
    temporal: template.temporal,
    defaults: template.defaults,
    assets: assetDraftsFromTemplate(template).map((asset, index) => ({
      asset_type: asset.asset_type,
      label: asset.label.trim(),
      url: asset.url.trim() || null,
      thumbnail_url: asset.thumbnail_url.trim() || null,
      reference_image_id: asset.reference_image_id.trim() || null,
      sort_order: index + 1,
      status: asset.status,
    })),
    rules: ruleDraftsFromTemplate(template)
      .filter((rule) => rule.content.trim())
      .map((rule, index) => ({
        rule_type: rule.rule_type,
        content: rule.content.trim(),
        priority: rule.priority,
        sort_order: index + 1,
        status: rule.status,
      })),
    prompts: [
      { block_type: 'character', content: promptByType(template, 'character'), sort_order: 1, status: 'active' },
      { block_type: 'logo', content: promptByType(template, 'logo'), sort_order: 2, status: 'active' },
      { block_type: 'style', content: promptByType(template, 'style'), sort_order: 3, status: 'active' },
      { block_type: 'global', content: promptByType(template, 'global'), sort_order: 4, status: 'active' },
    ].filter((prompt) => prompt.content.trim()),
  };

  const isDirty = JSON.stringify(buildPayload()) !== JSON.stringify(initialPayload);

  const handleClose = () => {
    if (isDirty && !window.confirm('模板有未保存修改，确定关闭吗？')) return;
    onClose();
  };

  const handleSubmit = async () => {
    await onSave(buildPayload());
  };

  const modulePreviewCards = [
    { type: 'character', label: 'Character', value: character || '未绑定角色模块' },
    { type: 'logo', label: 'Logo', value: logo || '未绑定 Logo 模块' },
    { type: 'style', label: 'Style', value: style || '未绑定风格模块' },
    { type: 'other', label: 'Camera', value: camera || '未绑定镜头策略' },
  ] as const;

  const addRuleDraft = (ruleType: TemplateRuleType) => {
    setRuleDrafts((current) => [
      ...current,
      {
        rule_type: ruleType,
        content: '',
        priority: ruleType === 'suggest' ? 60 : 90,
        sort_order: current.length + 1,
        status: 'active',
      },
    ]);
  };

  const updateRuleDraft = (index: number, patch: Partial<RuleDraft>) => {
    setRuleDrafts((current) => current.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    )));
  };

  return (
    <div className="template-drawer-shell" role="dialog" aria-modal="true" aria-label="模板编辑">
      <button type="button" className="template-drawer-backdrop" aria-label="关闭模板编辑" onClick={handleClose} />
      <aside className="template-drawer">
        <header className="template-drawer-head">
          <div>
            <span>模板编辑</span>
            <h2>{template.name}</h2>
          </div>
          <button type="button" onClick={handleClose}>关闭</button>
        </header>

        <nav className="template-drawer-tabs" aria-label="模板编辑分组">
          <button type="button" className={activeTab === 'modules' ? 'is-active' : ''} onClick={() => setActiveTab('modules')}>模块</button>
          <button type="button" className={activeTab === 'rules' ? 'is-active' : ''} onClick={() => setActiveTab('rules')}>规则 <span>{ruleCount}</span></button>
          <button type="button" className={activeTab === 'assets' ? 'is-active' : ''} onClick={() => setActiveTab('assets')}>资产 <span>{assets.length}</span></button>
        </nav>

        {error && <div className="template-drawer-error">{error}</div>}

        {activeTab === 'modules' && (
        <>
        <section className="template-drawer-section">
          <h3>基础信息</h3>
          <label>
            <span>名称</span>
            <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <label>
            <span>描述</span>
            <textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} rows={3} />
          </label>
          <div className="template-drawer-grid">
            <label>
              <span>状态</span>
              <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
                <option value="draft">草稿</option>
                <option value="active">启用</option>
                <option value="archived">归档</option>
              </select>
            </label>
            <label>
              <span>版本</span>
              <input value={version} onChange={(event) => setVersion(event.currentTarget.value)} />
            </label>
          </div>
        </section>

        <section className="template-drawer-section">
          <h3>模块绑定</h3>
          <div className="template-drawer-grid">
            <label><span>Character</span><input value={character} onChange={(event) => setCharacter(event.currentTarget.value)} /></label>
            <label><span>Logo</span><input value={logo} onChange={(event) => setLogo(event.currentTarget.value)} /></label>
            <label><span>Style</span><input value={style} onChange={(event) => setStyle(event.currentTarget.value)} /></label>
            <label><span>Camera</span><input value={camera} onChange={(event) => setCamera(event.currentTarget.value)} /></label>
          </div>
          <div className="template-drawer-preview-grid" aria-label="模块素材预览">
            {modulePreviewCards.map((card) => {
              const previewAsset = assets.find((asset) => asset.asset_type === card.type && (asset.thumbnail_url || asset.url));
              return (
                <article className="template-drawer-preview-card" key={card.label}>
                  <div className="template-drawer-preview-thumb">
                    {previewAsset ? <img src={previewAsset.thumbnail_url || previewAsset.url} alt="" /> : <span>无预览</span>}
                  </div>
                  <div>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <small>{previewAsset?.label || '可在资产页绑定参考素材'}</small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="template-drawer-section">
          <h3>专属提示词</h3>
          <label><span>Character Prompt</span><textarea value={characterPrompt} onChange={(event) => setCharacterPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Logo Prompt</span><textarea value={logoPrompt} onChange={(event) => setLogoPrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Style Prompt</span><textarea value={stylePrompt} onChange={(event) => setStylePrompt(event.currentTarget.value)} rows={3} /></label>
          <label><span>Global Prompt</span><textarea value={globalPrompt} onChange={(event) => setGlobalPrompt(event.currentTarget.value)} rows={3} /></label>
        </section>
        <section className="template-drawer-section">
          <h3>Temporal 策略</h3>
          <div className="template-drawer-check-row">
            <label><input type="checkbox" checked={segmentEnabled} onChange={(event) => setSegmentEnabled(event.currentTarget.checked)} /> 启用分段</label>
            <label><input type="checkbox" checked={handoff} onChange={(event) => setHandoff(event.currentTarget.checked)} /> 启用帧传递</label>
          </div>
          <label>
            <span>默认分段秒数</span>
            <input type="number" min={5} max={60} value={segment} onChange={(event) => setSegment(Number(event.currentTarget.value) || 15)} />
          </label>
        </section>
        </>
        )}

        {activeTab === 'assets' && (
        <section className="template-drawer-section">
          <h3>固定素材</h3>
          <div className="template-asset-editor-list">
            {assets.map((asset, index) => {
              const previewUrl = asset.thumbnail_url || asset.url;
              return (
                <div className="template-asset-editor-row" key={`${asset.asset_type}-${index}`}>
                  <div className="template-asset-editor-thumb">
                    {previewUrl ? <img src={previewUrl} alt="" /> : <span>暂无</span>}
                  </div>
                  <select
                    value={asset.asset_type}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, asset_type: event.currentTarget.value as TemplateAssetType } : item
                    )))}
                  >
                    {assetTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
                  </select>
                  <input
                    value={asset.label}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, label: event.currentTarget.value } : item
                    )))}
                    placeholder="素材名称"
                  />
                  <input
                    value={asset.url}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, url: event.currentTarget.value } : item
                    )))}
                    placeholder="素材 URL"
                  />
                  <input
                    value={asset.thumbnail_url}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, thumbnail_url: event.currentTarget.value } : item
                    )))}
                    placeholder="缩略图 URL"
                  />
                  <input
                    value={asset.reference_image_id}
                    onChange={(event) => setAssets((current) => current.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, reference_image_id: event.currentTarget.value } : item
                    )))}
                    placeholder="ReferenceImage ID"
                  />
                  <small>{asset.reference_image_id ? '来源：参考图资产' : previewUrl ? '来源：外部素材 URL' : '来源：待补充'}</small>
                  <button
                    type="button"
                    onClick={() => setAssets((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    删除
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="template-drawer-secondary"
            onClick={() => setAssets((current) => [
              ...current,
              { asset_type: 'other', label: '', url: '', thumbnail_url: '', reference_image_id: '', sort_order: current.length + 1, status: 'active' },
            ])}
          >
            增加素材
          </button>
        </section>
        )}

        {activeTab === 'rules' && (
        <section className="template-drawer-section">
          <h3>规则集合 <small>{ruleCount} 条</small></h3>
          {ruleTypes.map((rule) => {
            const indexedRules = ruleDrafts
              .map((draft, index) => ({ draft, index }))
              .filter((item) => item.draft.rule_type === rule.key);
            const activeCount = indexedRules.filter((item) => item.draft.status === 'active' && item.draft.content.trim()).length;
            return (
            <div className="template-rule-editor-block" key={rule.key}>
              <div className="template-rule-editor-head">
                <span>{rule.label} · {activeCount}/{indexedRules.length} 启用</span>
                <small>默认 P{rule.key === 'suggest' ? 60 : 90}</small>
                <button type="button" onClick={() => addRuleDraft(rule.key)}>新增规则</button>
              </div>
              {indexedRules.length === 0 ? (
                <p className="template-rule-editor-empty">暂无规则，点击新增规则。</p>
              ) : indexedRules.map(({ draft, index }) => (
                <div className="template-rule-editor-row" key={`${draft.rule_type}-${index}`}>
                  <select
                    value={draft.status}
                    onChange={(event) => updateRuleDraft(index, { status: event.currentTarget.value })}
                    aria-label={`${rule.label} 启停状态`}
                  >
                    <option value="active">启用</option>
                    <option value="disabled">停用</option>
                  </select>
                  <label>
                    <span>优先级</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={draft.priority}
                      onChange={(event) => updateRuleDraft(index, { priority: Number(event.currentTarget.value) || 1 })}
                    />
                  </label>
                  <textarea
                    aria-label={`${rule.label} 规则内容`}
                    value={draft.content}
                    onChange={(event) => updateRuleDraft(index, { content: event.currentTarget.value })}
                    rows={2}
                    placeholder="输入单条规则"
                  />
                  <button
                    type="button"
                    onClick={() => setRuleDrafts((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          );
          })}
        </section>
        )}

        <footer className="template-drawer-actions">
          <button type="button" disabled title="下一批接入模板变更记录">查看变更记录</button>
          <button type="button" onClick={handleClose}>取消</button>
          <button type="button" className="is-primary" onClick={handleSubmit} disabled={saving || !name.trim()}>
            {saving ? '保存中...' : '保存为新版本'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
