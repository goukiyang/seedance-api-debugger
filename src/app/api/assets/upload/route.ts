/**
 * POST /api/assets/upload
 * 上传单个文件（图片/视频/音频）
 * - 优先使用公网上传（R2/TOS），返回公网 HTTPS URL
 * - 回退本地存储（development / 未配置公网存储时）
 */

import { NextRequest, NextResponse } from 'next/server';
import { uploadAsset } from '@/lib/assets/storage';
import { uploadPublicAsset } from '@/lib/assets/public-storage';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

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

    // 优先公网上传（R2/TOS → 公网 HTTPS URL，可被 Seedance 直接下载）
    // 只有未配置公网存储时才回退本地
    let uploadResult: {
      assetId: string;
      originalUrl: string;
      thumbnailUrl: string | null;
      width?: number;
      height?: number;
      fileName: string;
      fileSize: number;
      mimeType: string;
      hash: string;
      isPubliclyReachable: boolean;
      storageProvider?: string;
      publicUploadWarning?: string;
    };

    try {
      const pubResult = await uploadPublicAsset(buffer, file.name, file.type);
      console.log(`[Upload] 公网上传成功: ${pubResult.storageProvider} → ${pubResult.publicUrl}`);
      // 公网上传成功后，创建本地 asset 记录，original_url 存公网 URL
      const localResult = await uploadAsset(buffer, file.name, file.type, user.id);
      uploadResult = {
        ...localResult,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        isPubliclyReachable: pubResult.isPubliclyReachable,
        storageProvider: pubResult.storageProvider,
        publicUploadWarning: pubResult.warning,
      };
      // 关键：original_url 使用公网 URL，Seedance 可直接下载
      uploadResult.originalUrl = pubResult.publicUrl;
    } catch (pubError) {
      // 公网上传失败，打印警告但不阻断，使用本地 URL
      const localResult = await uploadAsset(buffer, file.name, file.type, user.id);
      uploadResult = {
        ...localResult,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        isPubliclyReachable: false,
        publicUploadWarning: `公网上传失败: ${pubError instanceof Error ? pubError.message : String(pubError)}，已回退到本地存储。Seedance 无法访问本地 URL。`,
      };
    }

    return NextResponse.json({
      success: true,
      asset: {
        id: uploadResult.assetId,
        originalUrl: uploadResult.originalUrl,
        thumbnailUrl: uploadResult.thumbnailUrl,
        width: uploadResult.width,
        height: uploadResult.height,
        fileName: uploadResult.fileName,
        fileSize: uploadResult.fileSize,
        mimeType: uploadResult.mimeType,
        hash: uploadResult.hash,
        isPubliclyReachable: uploadResult.isPubliclyReachable,
        storageProvider: uploadResult.storageProvider,
        warning: uploadResult.publicUploadWarning,
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
