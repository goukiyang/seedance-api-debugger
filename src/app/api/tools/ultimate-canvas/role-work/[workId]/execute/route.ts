import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { executeWork } from '@/lib/canvas-roles/execution';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest, { params }: { params: { workId: string } }) { return roleRoute(request, true, (user, body) => executeWork(user, params.workId, body)); }
