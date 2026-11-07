import { Prisma } from '@prisma/client';

// These child namespaces contain task-settings source metadata, never private reference bindings.
export const studioSettingsSourcePrefixes = [
  'studio_shared_reproduction_v1:workspace:', 'studio_shared_reproduction_v1:preset:',
] as const;

export const studioReproductionBindingWhere = {
  key: { startsWith: 'studio_shared_reproduction_v1:' },
  NOT: studioSettingsSourcePrefixes.map(prefix => ({ key: { startsWith: prefix } })),
} satisfies Prisma.PlatformSettingWhereInput;

export function studioReproductionBindingSql(key: Prisma.Sql) {
  return Prisma.sql`(${key} GLOB 'studio_shared_reproduction_v1:*'
    AND ${Prisma.join(studioSettingsSourcePrefixes.map(prefix => Prisma.sql`${key} NOT GLOB ${prefix + '*'}`), ' AND ')})`;
}
