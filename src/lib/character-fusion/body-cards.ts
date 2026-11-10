import type { FusionCard } from './cards';

export const BODY_HEAD_RATIO_ID = 'card-body-head-ratio';
export const BODY_CARDS: readonly FusionCard[] = [
  {
    id: BODY_HEAD_RATIO_ID, title: '头身比', titleEn: 'Head-to-body ratio', value: '2–3头身', joined: false, locked: false,
    tags: [
      ['1.5–2头身', '1.5–2 head lengths tall'], ['2–3头身', '2–3 head lengths tall'], ['3–4头身', '3–4 head lengths tall'],
      ['4–5头身', '4–5 head lengths tall'], ['5–6头身', '5–6 head lengths tall'], ['6–8头身', '6–8 head lengths tall'], ['8+头身', '8 or more head lengths tall'],
    ].map(([label, en]) => ({ label, en, status: 'default' as const })),
  },
  {
    id: 'card-body-type', title: '基础体型', titleEn: 'Base body type', value: '圆球', joined: false, locked: false,
    tags: [
      ['圆球', 'a spherical body'], ['矮胖', 'a short, stout body'], ['瘦小', 'a small, slender body'], ['瘦长', 'a tall, slender body'],
      ['匀称', 'a well-proportioned body'], ['壮硕', 'a powerfully built body'], ['倒三角', 'an inverted-triangle body shape'],
      ['梨形', 'a pear-shaped body'], ['桶形', 'a barrel-shaped body'], ['沙漏', 'an hourglass body shape'], ['畸变', 'a deliberately distorted body shape'],
    ].map(([label, en]) => ({ label, en, status: 'default' as const })),
  },
  {
    id: 'card-body-structure', title: '结构比例', titleEn: 'Structural proportions', value: '短躯长腿', joined: false, locked: false,
    tags: [
      ['大头短身', 'a large head and short body'], ['小头巨躯', 'a small head and massive body'], ['长躯短腿', 'a long torso and short legs'],
      ['短躯长腿', 'a short torso and long legs'], ['长臂短腿', 'long arms and short legs'], ['短臂长腿', 'short arms and long legs'],
      ['宽肩窄胯', 'broad shoulders and narrow hips'], ['头身一体', 'a single continuous head-and-body form'],
    ].map(([label, en]) => ({ label, en, status: 'default' as const })),
  },
  {
    id: 'card-body-exaggeration', title: '夸张部位', titleEn: 'Exaggerated body part', value: '巨掌', joined: false, locked: false,
    tags: [
      ['巨头', 'an oversized head'], ['巨肩', 'oversized shoulders'], ['巨胸', 'an oversized chest'], ['巨腹', 'an oversized belly'],
      ['巨臂', 'oversized arms'], ['巨掌', 'oversized hands with large palms'], ['巨腿', 'oversized legs'], ['巨脚', 'oversized feet'], ['无', 'no exaggerated body part'],
    ].map(([label, en]) => ({ label, en, status: 'default' as const })),
  },
];

// Presets enter saved settings only after an explicit edit or join; old recipes stay unchanged.
export function catalogueCards(cards: FusionCard[]) {
  return [...cards, ...BODY_CARDS.filter(preset => !cards.some(card => card.id === preset.id))];
}

export function updateCard(cards: FusionCard[], id: string, update: (card: FusionCard) => FusionCard) {
  if (cards.some(card => card.id === id)) return cards.map(card => card.id === id ? update(card) : card);
  const preset = BODY_CARDS.find(card => card.id === id);
  if (!preset) return cards;
  if (cards.length >= 16) throw new Error('扩展卡片已达 16 张，请先移除一张不需要的自定义卡片，再启用身形卡片。');
  return [...cards, update({ ...preset, tags: preset.tags.map(tag => ({ ...tag })) })];
}

export function bodyCombination(cards: FusionCard[], language: 'zh' | 'en' | 'both') {
  const chosen = BODY_CARDS.flatMap(preset => cards.filter(card => card.id === preset.id && card.joined));
  if (!chosen.length) return '';
  const cn = chosen.map(card => card.id === 'card-body-type' ? `${card.value}型` : card.value).join(' × ');
  const en = chosen.map(card => card.tags.find(tag => tag.label === card.value)?.en || '').join(' × ');
  return language === 'zh' ? cn : language === 'en' ? en : `${cn}\n\n[ENGLISH]\n${en}`;
}
