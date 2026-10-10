import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { updateTaskRun } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function PATCH(request: NextRequest, { params }: { params: { runId: string } }) { return roleRoute(request, true, (user, body) => updateTaskRun(user, params.runId, body)); }
