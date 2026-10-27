import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createRoleWorkflow } from '@/lib/canvas-roles/workflows';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = declaredRoute({ access: 'internal', rateLimit: false }, function POST(request: NextRequest) { return roleRoute(request, true, createRoleWorkflow); });
