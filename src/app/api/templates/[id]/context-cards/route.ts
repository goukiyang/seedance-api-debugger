import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, requireAdmin } from '@/lib/auth/session';
import {
  buildTemplateWritePayload,
  normalizeContextCardTitle,
  serializeGenerationTemplate,
  TEMPLATE_INCLUDE,
  type SerializedGenerationTemplate,
  type TemplateAssetType,
  type TemplateContextCard,
  type TemplatePromptBlockType,
} from '@/lib/templates/workbench';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

const CARD_PROMPT_BLOCKS = new Set<TemplatePromptBlockType>([
  'character',
  'logo',
  'style',
  'camera',
  'rules',
  'asset_rule',
  'temporal',
  'prompt_format',
  'global',
]);

function normalizeCards(value: unknown): TemplateContextCard[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<TemplateContextCard[]>((cards, item, index) => {
      const object = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const content = typeof object.content === 'string' ? object.content.trim() : '';
      const rawBlockType = typeof object.legacy_block_type === 'string' ? object.legacy_block_type : 'global';
      const legacyBlockType = CARD_PROMPT_BLOCKS.has(rawBlockType as TemplatePromptBlockType)
        ? rawBlockType as TemplatePromptBlockType
        : 'global';
      const title = normalizeContextCardTitle(
        typeof object.title === 'string' ? object.title : null,
        legacyBlockType,
        index + 1,
      );
      if (!content && !title) return cards;
      cards.push({
        id: typeof object.id === 'string' && object.id.trim() ? object.id.trim() : `context-card-${index + 1}`,
        title,
        content,
        mode: object.mode === 'reference' ? 'reference' as const : 'force' as const,
        enabled: typeof object.enabled === 'boolean' ? object.enabled : true,
        sort_order: index + 1,
        bound_image: normalizeBoundImage(object.bound_image),
        llm_reference: typeof object.llm_reference === 'string' ? object.llm_reference : '',
        legacy_block_type: legacyBlockType,
      });
      return cards;
    }, []);
}

function normalizeBoundImage(value: unknown): TemplateContextCard['bound_image'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const label = text(object.label) || '绑定图片';
  const url = text(object.url);
  const thumbnailUrl = text(object.thumbnail_url);
  const referenceImageId = text(object.reference_image_id);
  const assetId = text(object.asset_id);
  const id = text(object.id) || referenceImageId || assetId;
  if (!id && !url && !thumbnailUrl) return null;
  const rawSource = text(object.source);
  const source = rawSource === 'reference_album' || rawSource === 'upload_history' || rawSource === 'manual'
    ? rawSource
    : 'template_asset';
  return {
    source,
    id,
    reference_image_id: referenceImageId,
    asset_id: assetId,
    label,
    url,
    thumbnail_url: thumbnailUrl,
  };
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function blockTypeToAssetType(blockType: TemplatePromptBlockType | undefined): TemplateAssetType {
  if (blockType === 'logo') return 'logo';
  if (blockType === 'style') return 'style';
  if (blockType === 'asset_rule') return 'product';
  if (blockType === 'global' || blockType === 'prompt_format' || blockType === 'rules' || blockType === 'temporal' || blockType === 'camera') return 'other';
  return 'character';
}

function promptsFromCards(cards: TemplateContextCard[], existing: SerializedGenerationTemplate) {
  const cardPrompts = cards
    .filter((card) => card.enabled && card.content.trim())
    .map((card, index) => ({
      block_type: card.legacy_block_type || 'global',
      content: card.content.trim(),
      sort_order: index + 1,
      status: 'active',
    }));
  const disabledPrompts = existing.prompts
    .filter((prompt) => !cards.some((card) => card.legacy_block_type === prompt.block_type))
    .map((prompt, index) => ({ ...prompt, sort_order: cardPrompts.length + index + 1 }));
  return [...cardPrompts, ...disabledPrompts];
}

function assetsFromCards(cards: TemplateContextCard[], existing: SerializedGenerationTemplate) {
  const cardAssets = cards
    .filter((card) => card.enabled && card.bound_image)
    .map((card, index) => ({
      asset_type: blockTypeToAssetType(card.legacy_block_type),
      label: card.bound_image?.label || card.title || `绑定图片 ${index + 1}`,
      url: card.bound_image?.url || null,
      thumbnail_url: card.bound_image?.thumbnail_url || card.bound_image?.url || null,
      reference_image_id: card.bound_image?.reference_image_id || null,
      sort_order: index + 1,
      status: 'active',
      metadata: {
        source: card.bound_image?.source,
        context_card_id: card.id,
        context_card_title: card.title,
        asset_id: card.bound_image?.asset_id,
      },
    }));
  const preservedAssets = existing.assets
    .filter((asset) => {
      const metadata = asset.metadata || {};
      return typeof metadata.context_card_id !== 'string';
    })
    .map((asset, index) => ({ ...asset, sort_order: cardAssets.length + index + 1 }));
  return [...cardAssets, ...preservedAssets];
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await getSession();
    requireAdmin(user);

    const body = await request.json();
    const contextCards = normalizeCards(body.context_cards);

    const template = await prisma.$transaction(async (tx) => {
      const existingRecord = await tx.generationTemplate.findUnique({
        where: { id: params.id },
        include: TEMPLATE_INCLUDE,
      });
      if (!existingRecord) throw new Error('TEMPLATE_NOT_FOUND');

      const existing = serializeGenerationTemplate(existingRecord);
      const moduleBindings = {
        ...existing.module_bindings,
        context_cards: contextCards,
      };
      const payload = buildTemplateWritePayload({
        name: existing.name,
        template_key: existing.template_key,
        description: existing.description,
        status: existing.status,
        version: existing.version,
        module_bindings: moduleBindings,
        temporal: existing.temporal,
        defaults: existing.defaults,
        assets: assetsFromCards(contextCards, existing),
        rules: existing.rules,
        prompts: promptsFromCards(contextCards, existing),
      }, user.id);

      await tx.templateAsset.deleteMany({ where: { template_id: params.id } });
      await tx.templateRule.deleteMany({ where: { template_id: params.id } });
      await tx.templatePromptBlock.deleteMany({ where: { template_id: params.id } });

      const updated = await tx.generationTemplate.update({
        where: { id: params.id },
        data: {
          ...payload.data,
          assets: { create: payload.assets.map((asset) => ({
            asset_type: asset.asset_type,
            label: asset.label,
            url: asset.url,
            thumbnail_url: asset.thumbnail_url,
            reference_image_id: asset.reference_image_id,
            sort_order: asset.sort_order,
            status: asset.status,
            metadata_json: JSON.stringify(asset.metadata || {}),
          })) },
          rules: { create: payload.rules.map((rule) => ({
            rule_type: rule.rule_type,
            content: rule.content,
            priority: rule.priority,
            sort_order: rule.sort_order,
            status: rule.status,
          })) },
          prompts: { create: payload.prompts.map((prompt) => ({
            block_type: prompt.block_type,
            content: prompt.content,
            sort_order: prompt.sort_order,
            status: prompt.status,
          })) },
        },
        include: TEMPLATE_INCLUDE,
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'template_context_cards_update',
          target_type: 'GenerationTemplate',
          target_id: updated.id,
          detail: JSON.stringify({ card_count: contextCards.length }),
        },
      });

      return updated;
    });

    return NextResponse.json({ template: serializeGenerationTemplate(template) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message === 'TEMPLATE_NOT_FOUND') {
      return NextResponse.json({ error: '模板不存在' }, { status: 404 });
    }
    console.error('[TemplateContextCards] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
