import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';

const SETTING_KEY = 'ultimate_canvas_text_context_v1';
export type CanvasTextSettings = { context: string; revision: number };

function decode(raw: string): CanvasTextSettings {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.context !== 'string' || value.context.length > 4000
      || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error();
    return { context: value.context, revision: value.revision };
  } catch { throw new AuthError('画布通用规则暂时无法读取，请稍后重试', 503); }
}

export async function getCanvasTextSettings(): Promise<CanvasTextSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTING_KEY }, select: { value_json: true } });
  return row ? decode(row.value_json) : { context: '', revision: 0 };
}

export async function saveCanvasTextSettings(userId: string, input: CanvasTextSettings, confirmClear: boolean) {
  try {
    return await prisma.$transaction(async tx => {
      const row = await tx.platformSetting.findUnique({ where: { key: SETTING_KEY } });
      const current = row ? decode(row.value_json) : { context: '', revision: 0 };
      if (current.revision !== input.revision) throw new AuthError('通用规则已在别处更新，草稿已保留；请重新读取后再保存', 409);
      if (current.context.trim() && !input.context.trim() && !confirmClear) throw new AuthError('清空全站通用规则需要明确确认', 409);
      const next = { context: input.context, revision: current.revision + 1 };
      const data = { value_json: JSON.stringify(next), updated_by: userId };
      if (row) {
        const updated = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data });
        if (updated.count !== 1) throw new AuthError('通用规则已变化，请重新读取后保存', 409);
      } else await tx.platformSetting.create({ data: { key: SETTING_KEY, ...data } });
      return next;
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new AuthError('通用规则已变化，请重新读取后保存', 409);
    }
    throw error;
  }
}
