import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateCodexVideoApi,
  CodexApiAuthError,
  codexVideoApiStatus,
} from '@/lib/integrations/codex';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const context = await authenticateCodexVideoApi(request);
    const status = await codexVideoApiStatus();

    return NextResponse.json({
      ok: true,
      enabled: status.enabled,
      ready: status.ready,
      source_type: status.source_type,
      source_label: status.source_label,
      config_source: 'sd2_admin_backend',
      linked_user: {
        id: context.user.id,
        username: context.user.username,
        email: context.user.email,
        role: context.user.role,
      },
      endpoints: {
        upload_asset: '/api/codex/assets/upload',
        create_video: '/api/codex/video/create',
        create_video_direct: '/api/tasks/create',
      },
      auth: {
        type: 'bearer',
        header: 'Authorization',
      },
      supported_settings: {
        generation_mode: ['all_in_one_reference', 'first_last_frame', 'smart_multi_frame'],
        ratio: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        resolution: ['480p', '720p', '1080p'],
        reference_fields: [
          'reference_image_ids',
          'reference_image_urls',
          'first_frame_url',
          'last_frame_url',
          'frame_image_urls',
        ],
      },
    });
  } catch (error) {
    if (error instanceof CodexApiAuthError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[CodexConfig] Failed:', error);
    return NextResponse.json({ error: 'codex_config_failed', message: 'Codex 接口配置检查失败' }, { status: 500 });
  }
}
