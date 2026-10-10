import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createTaskRun } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest) { return roleRoute(request, true, createTaskRun); }
