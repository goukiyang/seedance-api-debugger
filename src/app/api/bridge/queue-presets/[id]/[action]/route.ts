import { NextRequest } from 'next/server';
import { copyPreset, PresetError, recordUse, toggleLike } from '@/lib/bridge/queue-presets';
import { withUser } from '../../_shared';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string; action: string } };

/** POST /like（切换）· /use（使用次数 +1）· /copy（复制到我名下，默认不共享） */
export async function POST(request: NextRequest, { params }: Ctx) {
  return withUser(request, true, async (user) => {
    if (params.action === 'like') return { preset: await toggleLike(user, params.id) };
    if (params.action === 'use') return { preset: await recordUse(user, params.id) };
    if (params.action === 'copy') return { preset: await copyPreset(user, params.id) };
    throw new PresetError('不支持的操作', 404);
  });
}
