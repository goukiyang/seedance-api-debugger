import type { Prisma } from '@prisma/client';
import { defaultStudioModuleId } from './modules';

// The normal template list and its attention receipts share the same ownership/source scope.
export function studioTemplateTaskWhere(viewerId: string, moduleId?: string, historical = false): Prisma.ImageStudioTaskWhereInput {
  return { owner_id: viewerId, deleted_at: null,
    ...(moduleId === defaultStudioModuleId(viewerId) && !historical ? { AND: [{ OR: [
      { snapshot_json: null },
      { AND: [{ NOT: { snapshot_json: { contains: '"avatar":' } } }, { NOT: { snapshot_json: { contains: '"avatarLayout":' } } }] },
    ] }] } : {}),
    ...(moduleId ? moduleId === defaultStudioModuleId(viewerId) ? { OR: [{ module_id: null }, { module_id: moduleId }] } : { module_id: moduleId } : {}),
  };
}
