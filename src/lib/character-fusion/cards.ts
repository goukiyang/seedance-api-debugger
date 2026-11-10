export type CardTag = { label: string; en: string; status: 'default' | 'must' | 'exclude' };
export type FusionCard = { id: string; title: string; titleEn: string; tags: CardTag[]; joined: boolean; value: string; locked: boolean };
export type CardDraft = Pick<FusionCard, 'title' | 'titleEn' | 'tags'>;

export function parseCardDraft(input: unknown): CardDraft {
  const c = input as CardDraft;
  if (!c || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 40
    || typeof c.titleEn !== 'string' || !c.titleEn.trim() || c.titleEn.length > 100 || /[\u3400-\u9fff]/.test(c.titleEn)
    || !Array.isArray(c.tags) || !c.tags.length || c.tags.length > 40
    || c.tags.some(t => !t || typeof t.label !== 'string' || !t.label.trim() || t.label.length > 60
      || typeof t.en !== 'string' || !t.en.trim() || t.en.length > 180 || /[\u3400-\u9fff]/.test(t.en))
    || new Set(c.tags.map(t => t.label.trim())).size !== c.tags.length) throw new Error('卡片需有名称及 1–40 个中英对应标签，请继续对话补齐。');
  return { title: c.title.trim(), titleEn: c.titleEn.trim(), tags: c.tags.map(t => ({ label: t.label.trim(), en: t.en.trim(), status: ['must', 'exclude'].includes(t.status) ? t.status : 'default' })) };
}

export const CARD_CHAT_SYSTEM = `你是角色融合规则卡片设计助手。用户要新增一个可反复组合的维度卡片，不是直接新增一位角色。可讨论主角、配角、伙伴、反派、Boss等任何定位，不能默认Boss。先理解用户意图，必要时简短追问；每轮可按反馈修改草稿，不能声称已加入或保存。
只返回JSON：{"reply":"给用户的简短中文回复","draft":null或{"title":"中文卡片名","titleEn":"English card title","tags":[{"label":"中文选项","en":"semantically equivalent English option"}]}}。
草稿最多40个标签。中英表达必须对应同一概念，英文不得夹带中文。不要添加用户未要求的画风或限制。只有用户在页面确认加入后卡片才生效。每张卡片只描述一个独立属性，不把职业、身体部位、比例、角色数量等不同属性混成互斥选项；中英文共同表达相同能力与限制。`;
