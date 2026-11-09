export type FusionMessage = { role: 'user' | 'assistant'; content: string; reply?: string };

export async function fusionAssistant(system: string, messages: FusionMessage[], signal?: AbortSignal, model?: string): Promise<unknown> {
  if (messages.length > 38 || system.length + messages.reduce((n, m) => n + m.content.length, 0) > 23500) throw new Error('本轮对话已较长，请确认当前卡片，或保留草稿后开始新对话。');
  const response = await fetch('/api/llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ messages: [{ role: 'system', content: system }, ...messages.map(({ role, content }) => ({ role, content }))], model: model || undefined, temperature: .4 }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '对话暂未完成，请稍后主动重试。');
  if (typeof data.content !== 'string') throw new Error('模型未返回可读取的草稿，本轮没有加入卡片。');
  try { return JSON.parse(data.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('模型回复不是有效卡片草稿，本轮没有加入卡片，请继续说明要求。'); }
}
