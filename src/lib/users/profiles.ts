export const USER_PROFILE_OPTIONS = [
  {
    value: 'core_video',
    label: '核心 · 视频制作',
    defaultFeatureProfileId: 'power_creator',
    description: '高频视频生成、参考图沉淀和项目资产使用者。',
  },
  {
    value: 'core_animation',
    label: '核心 · 动画',
    defaultFeatureProfileId: 'power_creator',
    description: '动画、镜头、角色动作等高频创作使用者。',
  },
  {
    value: 'core_design',
    label: '核心 · 设计视觉',
    defaultFeatureProfileId: 'standard_internal',
    description: '视觉设计、风格参考、素材整理使用者。',
  },
  {
    value: 'noncore_planning',
    label: '策划',
    defaultFeatureProfileId: 'standard_internal',
    description: '方案、脚本、分镜和需求协作使用者。',
  },
  {
    value: 'noncore_ops',
    label: '运营',
    defaultFeatureProfileId: 'viewer_internal',
    description: '轻量查看、复用和少量生成使用者。',
  },
  {
    value: 'noncore_pm',
    label: '项目管理',
    defaultFeatureProfileId: 'standard_internal',
    description: '项目协调、记录查看和有限生成使用者。',
  },
  {
    value: 'other',
    label: '其他内部用户',
    defaultFeatureProfileId: 'standard_internal',
    description: '默认内部用户类型，管理员可后续细分。',
  },
] as const;

export const FEATURE_PROFILE_OPTIONS = [
  {
    value: 'power_creator',
    label: '强创作者',
    description: '适合视频制作和动画等高频创作人员。',
  },
  {
    value: 'standard_internal',
    label: '标准内部',
    description: '默认内部能力，支持常规生成和项目协作。',
  },
  {
    value: 'viewer_internal',
    label: '内部轻使用',
    description: '适合查看、协作和少量使用。',
  },
  {
    value: 'external_limited',
    label: '外部受限',
    description: '外部协作预留档案，默认不开放内部素材和原图权限。',
  },
] as const;

export type UserProfile = (typeof USER_PROFILE_OPTIONS)[number]['value'];
export type FeatureProfileId = (typeof FEATURE_PROFILE_OPTIONS)[number]['value'];
export type AccountType = 'internal' | 'external';

const USER_PROFILE_VALUES = new Set<string>(USER_PROFILE_OPTIONS.map((option) => option.value));
const FEATURE_PROFILE_VALUES = new Set<string>(FEATURE_PROFILE_OPTIONS.map((option) => option.value));

export function normalizeUserProfile(value: unknown): UserProfile {
  return typeof value === 'string' && USER_PROFILE_VALUES.has(value)
    ? value as UserProfile
    : 'other';
}

export function normalizeFeatureProfileId(value: unknown): FeatureProfileId | null {
  return typeof value === 'string' && FEATURE_PROFILE_VALUES.has(value)
    ? value as FeatureProfileId
    : null;
}

export function getDefaultFeatureProfileId(
  accountType: AccountType,
  userProfile: UserProfile,
): FeatureProfileId {
  if (accountType === 'external') return 'external_limited';
  return USER_PROFILE_OPTIONS.find((option) => option.value === userProfile)?.defaultFeatureProfileId
    || 'standard_internal';
}

export function getUserProfileLabel(value: string | null | undefined) {
  const normalized = normalizeUserProfile(value);
  return USER_PROFILE_OPTIONS.find((option) => option.value === normalized)?.label || '其他内部用户';
}

export function getFeatureProfileLabel(value: string | null | undefined) {
  const normalized = normalizeFeatureProfileId(value) || 'standard_internal';
  return FEATURE_PROFILE_OPTIONS.find((option) => option.value === normalized)?.label || '标准内部';
}
