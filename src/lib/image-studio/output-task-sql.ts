import { Prisma } from '@prisma/client';
import { jsonField, validJson } from '@/lib/assets/directory-permissions-sql';

/** Exact boolean counterpart of studioTaskHasViewableOutput; no failed-asset shortcut. */
export function studioViewableOutputSql(alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('invalid_sql_alias');
  const column = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const usage = column('usage_json'), delivery = jsonField(usage, '$.studioDelivery');
  const validation = jsonField(usage, '$.studioDelivery.validation');
  const field = (name: string) => jsonField(usage, '$.studioDelivery.' + name);
  const spec = (name: string) => jsonField(usage, '$.studioDelivery.validation.' + name);
  const status = Prisma.sql`CASE WHEN ${column('status')} = 'rate_uncertain' THEN 'uncertain' ELSE ${column('status')} END`;
  return Prisma.sql`${column('asset_id')} IS NOT NULL AND ${column('asset_id')} <> '' AND (${column('status')} = 'succeeded' OR (${status} IN ('failed', 'uncertain')
    AND json_type(${validJson(delivery)}) = 'object' AND json_type(${validJson(validation)}) = 'object'
    AND ${field('code')} IN ('generated_dimensions_mismatch', 'generated_format_mismatch')
    AND json_type(${validJson(delivery)}, '$.originalSha256') = 'text' AND length(${field('originalSha256')}) = 64 AND ${field('originalSha256')} NOT GLOB '*[^0-9a-f]*'
    AND json_type(${validJson(delivery)}, '$.originalBytes') IN ('integer', 'real') AND CAST(${field('originalBytes')} AS INTEGER) = ${field('originalBytes')} AND ${field('originalBytes')} BETWEEN 1 AND 9007199254740991
    AND ${spec('originalFormat')} IN ('png', 'jpeg', 'webp', 'avif', 'tiff') AND json_type(${validJson(validation)}, '$.storedFormat') = 'text'
    AND json_type(${validJson(validation)}, '$.width') IN ('integer', 'real') AND CAST(${spec('width')} AS INTEGER) = ${spec('width')} AND ${spec('width')} BETWEEN 1 AND 9007199254740991
    AND json_type(${validJson(validation)}, '$.height') IN ('integer', 'real') AND CAST(${spec('height')} AS INTEGER) = ${spec('height')} AND ${spec('height')} BETWEEN 1 AND 9007199254740991
    AND json_type(${validJson(validation)}, '$.requestedSize') = 'text' AND instr(${spec('requestedSize')}, 'x') > 1
    AND substr(${spec('requestedSize')}, 1, instr(${spec('requestedSize')}, 'x') - 1) NOT GLOB '*[^0-9]*'
    AND length(substr(${spec('requestedSize')}, instr(${spec('requestedSize')}, 'x') + 1)) > 0
    AND substr(${spec('requestedSize')}, instr(${spec('requestedSize')}, 'x') + 1) NOT GLOB '*[^0-9]*'
    AND (${field('code')} <> 'generated_dimensions_mismatch' OR ${spec('originalFormat')} = 'png' AND ${spec('requestedSize')} <> (CAST(${spec('width')} AS INTEGER) || 'x' || CAST(${spec('height')} AS INTEGER)))
    AND (${field('code')} <> 'generated_format_mismatch' OR ${spec('originalFormat')} <> 'png' AND ${spec('storedFormat')} = ${spec('originalFormat')})))`;
}
