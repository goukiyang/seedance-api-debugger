import type { Prisma } from '@prisma/client';
import { defaultStudioModuleId } from './modules';

// The normal template list and its attention receipts share the same ownership/source scope.
export function studioTemplateTaskWhere(
  viewerId: string,
  moduleId?: string,
  historical = false,
  excludedToolBatches: string[] = [],
  historyModuleId?: string,
): Prisma.ImageStudioTaskWhereInput {
  const defaultId = defaultStudioModuleId(viewerId);
  return { owner_id: viewerId, deleted_at: null,
    ...(excludedToolBatches.length ? { batch_id: { notIn: excludedToolBatches } } : {}),
    ...((moduleId === defaultId || historyModuleId === defaultId) && !historical ? { AND: [{ OR: [
      { snapshot_json: null },
      { AND: [{ NOT: { snapshot_json: { contains: '"avatar":' } } }, { NOT: { snapshot_json: { contains: '"avatarLayout":' } } }] },
    ] }] } : {}),
    ...(moduleId ? moduleId === defaultId ? { OR: [{ module_id: null }, { module_id: moduleId }] }
      : historyModuleId === defaultId ? { OR: [{ module_id: null }, { module_id: { in: [moduleId, historyModuleId] } }] }
      : { module_id: historyModuleId ? { in: [moduleId, historyModuleId] } : moduleId } : {}),
  };
}
