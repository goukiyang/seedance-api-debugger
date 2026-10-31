import { isEncryptedStudioPersonalPrompt } from '@/lib/image-studio/personal-prompt';

export const UNKNOWN_PERSONAL_PROMPT_NOTICE = '这份旧记录的个人补充暂时无法确认，未回填加密内容。当前明文输入保留，你可以继续编辑后生成。';
export type PersonalPromptSource = { personalPrompt?: unknown; personalPromptState?: unknown; personalPromptReason?: unknown };

// Only a separately recorded personal field can recover an unreadable candidate.
// A combined/template prompt is never a substitute for the user's input.
export function recoverStudioPersonalPrompt(candidate: unknown, current: string, source?: PersonalPromptSource) {
  if (typeof candidate === 'string' && !isEncryptedStudioPersonalPrompt(candidate)) return { prompt: candidate.slice(0, 20000), restored: true, notice: '' };
  if (source && source.personalPromptState !== 'unknown' && typeof source.personalPrompt === 'string'
    && !isEncryptedStudioPersonalPrompt(source.personalPrompt)) {
    return { prompt: source.personalPrompt.slice(0, 20000), restored: true, notice: '' };
  }
  return { prompt: isEncryptedStudioPersonalPrompt(current) ? '' : current, restored: false, notice: UNKNOWN_PERSONAL_PROMPT_NOTICE };
}
