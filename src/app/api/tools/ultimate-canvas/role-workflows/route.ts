import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createRoleWorkflow } from '@/lib/canvas-roles/workflows';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest) { return roleRoute(request, true, createRoleWorkflow); }
