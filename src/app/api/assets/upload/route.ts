/**
 * POST /api/assets/upload
 * 上传单个文件（图片/视频/音频）
 */

import { NextRequest, NextResponse } from 'next/server';
import { uploadAsset } from '@/lib/assets/storage';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // 校验文件类型
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
      'video/mp4', 'video/quicktime', 'video/webm',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
    ];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}` },
        { status: 400 }
      );
    }

    // 校验文件大小（最大 50MB）
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadAsset(buffer, file.name, file.type);

    return NextResponse.json({
      success: true,
      asset: {
        id: result.assetId,
        originalUrl: result.originalUrl,
        thumbnailUrl: result.thumbnailUrl,
        width: result.width,
        height: result.height,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        hash: result.hash,
      },
    });
  } catch (error) {
    console.error('[Upload] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
