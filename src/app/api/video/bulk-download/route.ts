import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  buildBulkVideoDownloadPackage,
  parseBulkDownloadScope,
} from '@/lib/video/bulk-download';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未登录' },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const result = await buildBulkVideoDownloadPackage(
      user,
      parseBulkDownloadScope(body),
    );

    if (result.kind === 'json') {
      return NextResponse.json(result.body, { status: result.status });
    }

    const webStream = Readable.toWeb(result.stream as Readable) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: result.status,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.fileName}"`,
        'Cache-Control': 'no-store',
        'X-Bulk-Download-Total': String(result.summary.total),
        'X-Bulk-Download-Success': String(result.summary.success),
        'X-Bulk-Download-Failed': String(result.summary.failed),
      },
    });
  } catch (error) {
    console.error('[BulkVideoDownload] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: '批量下载失败',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
