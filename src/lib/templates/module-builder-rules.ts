import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { DEFAULT_MODULE_BUILDER_RULES } from '@/lib/templates/module-builder';

export const MODULE_BUILDER_RULES_SETTING_KEY = 'module_builder_default_rules_v1';

function cleanRules(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 12000)
    : DEFAULT_MODULE_BUILDER_RULES;
}

export async function getModuleBuilderRules(
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const setting = await client.platformSetting.findUnique({ where: { key: MODULE_BUILDER_RULES_SETTING_KEY } });
  if (!setting) return DEFAULT_MODULE_BUILDER_RULES;
  try {
    const parsed = JSON.parse(setting.value_json) as Record<string, unknown>;
    return cleanRules(parsed.rules);
  } catch {
    return DEFAULT_MODULE_BUILDER_RULES;
  }
}

export async function saveModuleBuilderRules(
  rules: string,
  updatedBy: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const nextRules = cleanRules(rules);
  await client.platformSetting.upsert({
    where: { key: MODULE_BUILDER_RULES_SETTING_KEY },
    update: {
      value_json: JSON.stringify({ rules: nextRules }),
      updated_by: updatedBy,
    },
    create: {
      key: MODULE_BUILDER_RULES_SETTING_KEY,
      value_json: JSON.stringify({ rules: nextRules }),
      updated_by: updatedBy,
    },
  });
  return nextRules;
}
