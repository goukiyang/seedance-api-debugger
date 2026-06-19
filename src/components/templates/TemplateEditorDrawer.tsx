'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  SerializedGenerationTemplate,
  SerializedTemplateAsset,
  TemplateAssetType,
  TemplateContextCard,
  TemplatePromptBlockType,
} from '@/lib/templates/workbench';
import { TemplateContextCardsPanel } from '@/components/templates/TemplateContextCardsPanel';

type Props = {
  open: boolean;
  template: SerializedGenerationTemplate | null;
  saving?: boolean;
  error?: string | null;
  variant?: 'drawer' | 'inline' | 'card';
  cardId?: string | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
};

type ContextCardsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const BLOCK_TO_ASSET_TYPE: Partial<Record<TemplatePromptBlockType, TemplateAssetType>> = {
  character: 'character',
  logo: 'logo',
  style: 'style',
};

const BLOCK_TO_BUILDER_TYPE: Partial<Record<TemplatePromptBlockType, string>> = {
  character: 'character',
  logo: 'logo',
  style: 'style',
  camera: 'camera',
  rules: 'rule',
  asset_rule: 'asset_rule',
  temporal: 'temporal',
  prompt_format: 'prompt_format',
};

function cleanText(value: string | null | undefined) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function promptBlocksFromContextCards(cards: TemplateContextCard[]) {
  return cards
    .filter((card) => card.enabled && cleanText(card.content))
    .map((card, index) => ({
      block_type: card.legacy_block_type || 'global',
      content: card.content.trim(),
      sort_order: index + 1,
      status: 'active',
    }));
}

function cardAssetType(card: TemplateContextCard): TemplateAssetType {
  return BLOCK_TO_ASSET_TYPE[card.legacy_block_type || 'global'] || 'other';
}

function assetIdentity(asset: Pick<SerializedTemplateAsset, 'reference_image_id' | 'url' | 'thumbnail_url'>) {
  return asset.reference_image_id || asset.url || asset.thumbnail_url || '';
}

function assetsFromContextCards(cards: TemplateContextCard[], existingAssets: SerializedTemplateAsset[]) {
  const cardAssets: SerializedTemplateAsset[] = cards
    .filter((card) => card.enabled && card.bound_image && (card.bound_image.url || card.bound_image.thumbnail_url || card.bound_image.reference_image_id))
    .map((card, index) => ({
      asset_type: cardAssetType(card),
      label: card.bound_image?.label || card.title || '卡片绑定图片',
      url: card.bound_image?.url || null,
      thumbnail_url: card.bound_image?.thumbnail_url || card.bound_image?.url || null,
      reference_image_id: card.bound_image?.reference_image_id || null,
      sort_order: index + 1,
      status: 'active',
      metadata: {
        context_card_id: card.id,
        context_card_title: card.title,
        source: card.bound_image?.source || 'manual',
      },
    }));

  const cardAssetKeys = new Set(cardAssets.map(assetIdentity).filter(Boolean));
  const preservedAssets = existingAssets.filter((asset) => {
    if (typeof asset.metadata?.context_card_id === 'string') return false;
    const key = assetIdentity(asset);
    return !key || !cardAssetKeys.has(key);
  });

  return [...preservedAssets, ...cardAssets].map((asset, index) => ({
    ...asset,
    sort_order: index + 1,
  }));
}

function promptBlockToString(value: unknown) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.values(value as Record<string, unknown>)
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .join('\n');
}

export function TemplateEditorDrawer({ open, template, saving = false, error, variant = 'drawer', cardId = null, onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('draft');
  const [version, setVersion] = useState('v1');
  const [contextCards, setContextCards] = useState<TemplateContextCard[]>([]);
  const [contextCardsSaveStatus, setContextCardsSaveStatus] = useState<ContextCardsSaveStatus>('idle');
  const [contextCardsSaveError, setContextCardsSaveError] = useState('');
  const initialCardsJsonRef = useRef('');

  useEffect(() => {
    if (!template) return;
    const nextCards = template.module_bindings.context_cards || [];
    setName(template.name);
    setDescription(template.description || '');
    setStatus(template.status);
    setVersion(template.version);
    setContextCards(nextCards);
    initialCardsJsonRef.current = JSON.stringify(nextCards);
    setContextCardsSaveStatus('idle');
    setContextCardsSaveError('');
  }, [template]);

  useEffect(() => {
    if (!open || !template) return undefined;
    const serialized = JSON.stringify(contextCards);
    if (serialized === initialCardsJsonRef.current) return undefined;

    setContextCardsSaveStatus('saving');
    setContextCardsSaveError('');
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/templates/${template.id}/context-cards`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context_cards: contextCards }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || '上下文卡片保存失败');
        initialCardsJsonRef.current = JSON.stringify(contextCards);
        setContextCardsSaveStatus('saved');
      } catch (saveError) {
        setContextCardsSaveStatus('error');
        setContextCardsSaveError(saveError instanceof Error ? saveError.message : '上下文卡片保存失败');
      }
    }, 700);

    return () => window.clearTimeout(timer);
  }, [contextCards, open, template]);

  const payload = useMemo(() => {
    if (!template) return null;
    return {
      name,
      description,
      status,
      version,
      module_bindings: {
        ...template.module_bindings,
        context_cards: contextCards,
      },
      temporal: template.temporal,
      defaults: template.defaults,
      assets: assetsFromContextCards(contextCards, template.assets).map((asset, index) => ({
        asset_type: asset.asset_type,
        label: asset.label,
        url: asset.url,
        thumbnail_url: asset.thumbnail_url,
        reference_image_id: asset.reference_image_id,
        sort_order: index + 1,
        status: asset.status,
        metadata: asset.metadata || {},
      })),
      rules: template.rules.map((rule, index) => ({
        rule_type: rule.rule_type,
        content: rule.content,
        priority: rule.priority,
        sort_order: index + 1,
        status: rule.status,
      })),
      prompts: promptBlocksFromContextCards(contextCards),
    };
  }, [contextCards, description, name, status, template, version]);

  const rewriteContextCard = async (card: TemplateContextCard, userInput: string) => {
    if (!template) throw new Error('模板不存在');
    const intent = [
      `卡片标题：${card.title}`,
      `当前内容：${card.content || '空'}`,
      card.llm_reference ? `LLM 参考与设置：${card.llm_reference}` : '',
      `管理员要求：${userInput}`,
    ].filter(Boolean).join('\n');

    const response = await fetch('/api/templates/module-builder/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent,
        module_type: BLOCK_TO_BUILDER_TYPE[card.legacy_block_type || 'global'] || 'auto',
        template_id: template.id,
        current_template_context: {
          name: template.name,
          description: template.description,
          context_card_title: card.title,
          mode: card.mode,
        },
        one_time_rules: '只改写这张上下文卡片的最终内容，只返回可直接替换上方内容的文本，不要改变卡片模式。',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || 'LLM 改写失败');
    const draftText = promptBlockToString(data.draft?.promptBlock);
    return draftText || cleanText(data.draft?.summary) || cleanText(userInput);
  };

  if (!open || !template || !payload) return null;

  const editorActions = (
    <>
      <span className={`template-drawer-save-state is-${contextCardsSaveStatus}`}>
        {contextCardsSaveStatus === 'saving'
          ? '卡片正在自动保存'
          : contextCardsSaveStatus === 'saved'
            ? '卡片已自动保存'
            : contextCardsSaveStatus === 'error'
              ? '卡片保存失败'
              : '卡片修改会自动保存'}
      </span>
      <button type="button" className="is-primary" onClick={() => onSave(payload)} disabled={saving || !name.trim()}>
        {saving ? '保存中...' : '保存模板版本'}
      </button>
    </>
  );

  const workspaceContent = (
    <>
      {variant !== 'card' && (
        <header className="template-drawer-head">
          <div>
            <span>模板工作台</span>
            <h2>{template.name}</h2>
          </div>
          {variant === 'drawer' && <button type="button" onClick={onClose}>关闭</button>}
          {variant === 'inline' && (
            <div className="template-drawer-head-actions">
              {editorActions}
            </div>
          )}
        </header>
      )}

      {error && <div className="template-drawer-error">{error}</div>}

      <TemplateContextCardsPanel
        cards={contextCards}
        saveStatus={contextCardsSaveStatus}
        saveError={contextCardsSaveError}
        editorActions={variant === 'card' ? editorActions : undefined}
        templateRules={template.rules}
        templateId={template.id}
        editorMode={variant === 'card' ? 'card-page' : 'overview'}
        editingCardId={cardId}
        backHref={`/admin/templates/${template.id}`}
        onChange={setContextCards}
        onRewriteCard={rewriteContextCard}
      />
    </>
  );

  if (variant === 'inline') {
    return (
      <section className="template-inline-workspace" aria-label="模板上下文卡片编辑">
        {workspaceContent}
      </section>
    );
  }

  if (variant === 'card') {
    return (
      <section className="template-card-modal-shell" role="dialog" aria-modal="true" aria-label="上下文卡片三级编辑弹窗">
        <button type="button" className="template-card-modal-backdrop" aria-label="关闭卡片编辑" onClick={onClose} />
        <aside className="template-card-modal">
          <header className="template-card-modal-head">
            <div>
              <span>上下文卡片三级弹窗</span>
              <h2>{template.name}</h2>
            </div>
            <button type="button" onClick={onClose}>关闭</button>
          </header>
          <section className="template-card-route-workspace" aria-label="上下文卡片编辑">
            {workspaceContent}
          </section>
        </aside>
      </section>
    );
  }

  return (
    <div className="template-drawer-shell" role="dialog" aria-modal="true" aria-label="模板上下文卡片编辑">
      <button type="button" className="template-drawer-backdrop" aria-label="关闭模板编辑" onClick={onClose} />
      <aside className="template-drawer">
        {workspaceContent}
      </aside>
    </div>
  );
}
