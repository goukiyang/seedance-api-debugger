import { NextRequest } from 'next/server';
import { applyStudioPreset } from '@/lib/image-studio/presets';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import {
  assertCanvasStyleContext, canvasStyleFailure, canvasStyleJson, parseCanvasStyleContext,
  readCanvasStyleJson, requireCanvasStyleUser,
} from '@/lib/canvas-style-bridge';
import { AuthError } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const user = await requireCanvasStyleUser();
    const body = await readCanvasStyleJson(request);
    const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : '';
    if (!presetId || presetId.length > 120) throw new AuthError('风格模板编号无效', 400);
    const context = parseCanvasStyleContext(body);
    await assertCanvasStyleContext(user, context);

    const studioModule = await applyStudioPreset(user, presetId);
    const currentSettings = await getImageStudioSettings();
    const unitCredits = currentSettings.prices[studioModule.model] ?? null;
    const settings = {
      model: studioModule.model,
      quality: studioModule.quality,
      resolution: studioModule.resolution,
      count: studioModule.count,
      aspectRatio: studioModule.aspectRatio,
      revision: currentSettings.revision,
      prices: currentSettings.prices,
      unitCredits,
    };
    return canvasStyleJson({
      moduleId: studioModule.id,
      moduleRevision: studioModule.revision,
      presetId,
      name: studioModule.name,
      prompt: studioModule.prompt,
      model: settings.model,
      quality: settings.quality,
      resolution: settings.resolution,
      count: settings.count,
      aspectRatio: settings.aspectRatio,
      referenceIds: studioModule.images.map(image => image.id),
      settingsRevision: currentSettings.revision,
      unitCredits,
      settings,
    }, 201);
  } catch (error) {
    return canvasStyleFailure(error, '应用风格模板失败，请重试');
  }
}
