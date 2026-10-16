const preferenceKey = (owner: string) => `sd2:image-studio:replace-main-reminder:v1:${owner}`;

export function skipMainImageReminder(owner: string) {
  try { return localStorage.getItem(preferenceKey(owner)) !== 'ask'; }
  catch { return false; }
}
export function saveMainImageReminder(owner: string, skip: boolean) {
  try { const value = skip ? 'skip' : 'ask'; localStorage.setItem(preferenceKey(owner), value);
    if (localStorage.getItem(preferenceKey(owner)) !== value) throw new Error('reminder_not_saved'); }
  catch { throw new Error('提醒设置未能确认保存，请重试。'); }
}
