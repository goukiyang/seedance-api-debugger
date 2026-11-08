import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { parseSettings, type FusionSettings } from '@/lib/character-fusion/engine';
import type { FusionRecipe } from '@/lib/character-fusion/recipes';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const PREFIX = 'character_fusion_recipe_v1:';
class RecipeError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
function failure(error: unknown) {
  if (error instanceof AuthError || error instanceof RecipeError) return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return json({ error: '配方内容格式无效。' }, 400);
  return json({ error: '配方操作未确认，请重新读取后重试；当前设置仍保留。' }, 503);
}
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
    const rows = await prisma.userPreference.findMany({ where: { user_id: user.id, key: { startsWith: PREFIX } }, orderBy: { updated_at: 'desc' }, select: { value_json: true } });
    return json({ recipes: rows.map(row => JSON.parse(row.value_json) as FusionRecipe) });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
    const raw = await request.text();
    if (raw.length > 120000) throw new RecipeError('配方内容过长。');
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || !['save', 'rename', 'delete'].includes(body.action)
      || typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.id)) throw new RecipeError('配方操作无效。');
    if (body.action !== 'delete' && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60)) throw new RecipeError('配方名称须为 1–60 字。');
    let settings: FusionSettings | undefined;
    if (body.action === 'save') {
      try { settings = parseSettings(body.settings); } catch (error) { throw new RecipeError(error instanceof Error ? error.message : '配方设置无效。'); }
    } else if (typeof body.revision !== 'string' || body.revision.length > 60) throw new RecipeError('请重新读取配方后操作。');
    const key = PREFIX + body.id;
    const recipe = await retrySqliteBusy(() => prisma.$transaction(async tx => {
      const current = await tx.userPreference.findUnique({ where: { user_id_key: { user_id: user.id, key } } });
      if (body.action === 'save') {
        if (current) {
          const saved = JSON.parse(current.value_json) as FusionRecipe;
          if (saved.name !== body.name.trim() || JSON.stringify(saved.settings) !== JSON.stringify(settings)) throw new RecipeError('此保存编号已使用，请重新读取配方。', 409);
          return saved;
        }
        const saved: FusionRecipe = { id: body.id, name: body.name.trim(), settings: settings!, revision: randomUUID(), updatedAt: new Date().toISOString() };
        await tx.userPreference.create({ data: { user_id: user.id, key, value_json: JSON.stringify(saved) } });
        return saved;
      }
      if (!current) { if (body.action === 'delete') return null; throw new RecipeError('配方已不存在。', 404); }
      const saved = JSON.parse(current.value_json) as FusionRecipe;
      if (saved.revision !== body.revision) throw new RecipeError('配方已更新，请重新读取后操作。', 409);
      const where = { user_id: user.id, key, value_json: current.value_json };
      if (body.action === 'delete') { await tx.userPreference.deleteMany({ where }); return null; }
      const renamed: FusionRecipe = { ...saved, name: body.name.trim(), revision: randomUUID(), updatedAt: new Date().toISOString() };
      const changed = await tx.userPreference.updateMany({ where, data: { value_json: JSON.stringify(renamed) } });
      if (changed.count !== 1) throw new RecipeError('配方已更新，请重新读取后操作。', 409);
      return renamed;
    }));
    return json({ recipe });
  } catch (error) { return failure(error); }
}
