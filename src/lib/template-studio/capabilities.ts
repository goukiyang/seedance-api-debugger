import { prisma } from '@/lib/prisma';
import { getMuskApiSettings, isMuskApiReady } from '@/lib/integrations/musk';
import type { SessionUser } from '@/lib/auth/session';
import type { StudioCapabilitiesResponse } from './types';

export const TEMPLATE_STUDIO_TEXT_ENABLED_KEY = 'TEMPLATE_STUDIO_TEXT_ENABLED';

export async function getStudioCapabilities(user: SessionUser): Promise<StudioCapabilitiesResponse> {
  const [setting, musk] = await Promise.all([
    prisma.platformSetting.findUnique({ where: { key: TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, select: { value_json: true } }),
    getMuskApiSettings(),
  ]);

  let explicitlyEnabled = false;
  try {
    explicitlyEnabled = setting?.value_json ? JSON.parse(setting.value_json) === true : false;
  } catch {
    explicitlyEnabled = false;
  }

  const canManageTemplates = user.account_type === 'internal' && user.role === 'admin';
  const llmEnabled = explicitlyEnabled && isMuskApiReady(musk);
  const llmReason = llmEnabled
    ? null
    : !explicitlyEnabled
      ? 'AI 整理尚未启用，文字计费策略待确认。'
      : '文字模型服务未配置或已停用。';

  return {
    billingLabel: '文案不扣本站点数；上游文字费用由平台承担。视频生成另行计费。',
    llmEnabled,
    llmReason,
    canManageTemplates,
    canPublish: canManageTemplates,
    canCreatePrivateTemplates: user.account_type === 'internal',
  };
}
