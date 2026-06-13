import { NextRequest } from 'next/server';
import { POST as createVideoTask } from '@/app/api/tasks/create/route';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return createVideoTask(request);
}
