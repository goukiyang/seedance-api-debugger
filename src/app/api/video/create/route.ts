import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', message: '请先登录后再生成视频' },
      { status: 401 },
    );
  }

  return NextResponse.json(
    {
      error: 'Deprecated',
      message: '此接口已弃用，请改用 /api/tasks/create',
      migration: {
        from: '/api/video/create',
        to: '/api/tasks/create',
        note: '统一闭环已在 /api/tasks/create 落地，包含点数冻结、Provider 请求追踪、失败回退与扣费结算',
      },
      user: {
        id: user.id,
        role: user.role,
      },
    },
    { status: 410 },
  );
}
