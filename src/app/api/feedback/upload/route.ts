import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(_request: NextRequest) {
  return NextResponse.json(
    {
      success: false,
      code: 'CURRENT_UPLOAD_ENTRYPOINT_UPGRADED',
      error: '反馈截图上传入口已升级，请刷新页面后重试；如果仍出现，请重新登录。',
    },
    { status: 400 },
  );
}
