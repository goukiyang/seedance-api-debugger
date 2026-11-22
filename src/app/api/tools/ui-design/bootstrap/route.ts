import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { privateManifest } from '@/lib/ui-design/runtime';
import { listUiDocuments } from '@/lib/ui-design/store';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, imageStudioNewQualityOptions, imageStudioQualityLabel } from '@/lib/image-studio/model-catalog';
import { STUDIO_RATIOS } from '@/lib/image-studio/ratios';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { const user = await uiUser(request), manifest = await privateManifest();
    return uiJson({ user: { id: user.id, name: user.name }, sourceVersion: manifest.sourceSha256, counts: manifest.counts,
      imageParameters: { models: Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, {
        qualities: imageStudioNewQualityOptions(model).map(value => ({ value, label: imageStudioQualityLabel(model, value) })),
        resolutions: IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model].map(value => ({ value, label: value })),
      }])), ratios: ['auto', ...STUDIO_RATIOS].map(value => ({ value, label: value === 'auto' ? '自动' : value })) },
      capabilities: manifest.dependencies, history: await listUiDocuments(user.id, 'workspace') });
  } catch (error) { return uiFailure(error); }
}
