import { NextRequest, NextResponse } from 'next/server';
import { uploadAsset } from '@/lib/assets/storage';
import { uploadPublicAsset } from '@/lib/assets/public-storage';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: '请选择图片' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: '仅支持 jpg、jpeg、png、webp 图片' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: '单张图片不能超过 5MB' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const localResult = await uploadAsset(buffer, file.name, file.type);

    try {
      const publicResult = await uploadPublicAsset(buffer, file.name, file.type);
      return NextResponse.json({
        success: true,
        imageUrl: publicResult.publicUrl,
        assetId: localResult.assetId,
        warning: publicResult.warning,
      });
    } catch (error) {
      console.warn('[Feedback Upload] public upload failed:', error);
      return NextResponse.json({
        success: true,
        imageUrl: localResult.originalUrl,
        assetId: localResult.assetId,
        warning: '公网存储暂不可用，已保存到本地上传目录。',
      });
    }
  } catch (error) {
    console.error('[Feedback Upload]', error);
    return NextResponse.json({ error: '图片上传失败，请移除后重试。' }, { status: 500 });
  }
}

