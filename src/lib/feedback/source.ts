export type FeedbackPluginSite = 'chatgpt' | 'midjourney' | 'jimeng';
export type FeedbackSource = { version: 1; site: FeedbackPluginSite; extensionVersion: string; pageUrl: string | null };
export const feedbackSourceKey = (id: string) => `feedback-source:v1:${id}`;
const labels: Record<FeedbackPluginSite, string> = { chatgpt: 'ChatGPT', midjourney: 'Midjourney', jimeng: '即梦' };
export function feedbackPluginPageName(pathname: string | null) {
  const site = pathname?.match(/^\/plugin\/(chatgpt|midjourney|jimeng)$/)?.[1] as FeedbackPluginSite | undefined;
  return site ? `插件 · ${labels[site]}` : null;
}
