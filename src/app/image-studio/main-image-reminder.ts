const preferenceKey = (owner: string) => `sd2:image-studio:replace-main-reminder:v1:${owner}`;

export function skipMainImageReminder(owner: string) {
  try { return localStorage.getItem(preferenceKey(owner)) === 'skip'; }
  catch { return false; }
}
export function saveMainImageReminder(owner: string, skip: boolean) {
  try { localStorage.setItem(preferenceKey(owner), skip ? 'skip' : 'ask'); }
  catch { throw new Error('本机无法保存提醒设置，原设置未改变。'); }
}
