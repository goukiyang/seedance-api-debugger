import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const skip = (page - 1) * limit;

    // Get total count
    const total = await prisma.videoTask.count();

    // Get tasks
    const tasks = await prisma.videoTask.findMany({
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        provider_task_id: true,
        prompt: true,
        generation_mode: true,
        local_status: true,
        local_video_path: true,
        created_at: true,
        completed_at: true,
      },
    });

    return NextResponse.json({
      tasks,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('List tasks error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
