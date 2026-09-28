import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { BANANA_IMAGE_API_SETTING_KEY, buildImageGenerationApiSettingsPatch, getImageGenerationApiSettings, isImageGenerationApiReady } from '@/lib/integrations/image-generation';

export const dynamic = 'force-dynamic';
const safeConfig = (settings: Awaited<ReturnType<typeof getImageGenerationApiSettings>>) => ({
  enabled: settings.enabled, ready: isImageGenerationApiReady(settings),
  base_url: settings.base_url, api_key_configured: Boolean(settings.api_key),
});

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    return NextResponse.json({ config: safeConfig(await getImageGenerationApiSettings(prisma, 'banana')) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '读取 Banana 通道失败，请重试' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.base_url !== 'string' || body.base_url.length > 500
      || typeof body.enabled !== 'boolean'
      || (body.api_key !== undefined && (typeof body.api_key !== 'string' || body.api_key.length > 4096))
      || (body.clear_api_key !== undefined && typeof body.clear_api_key !== 'boolean')) {
      return NextResponse.json({ error: '通道设置无效' }, { status: 400 });
    }
    let url: URL;
    try { url = new URL(body.base_url.trim()); }
    catch { return NextResponse.json({ error: '请输入有效的 HTTPS API 地址' }, { status: 400 }); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isPrivateNetworkHost(url.hostname)) {
      return NextResponse.json({ error: 'API 地址须为公网 HTTPS 地址，不能含账号、密码或查询参数' }, { status: 400 });
    }
    const input = { base_url: url.toString(), enabled: body.enabled, api_key: body.api_key, clear_api_key: body.clear_api_key };
    const saved = await prisma.$transaction(async tx => {
      const current = await getImageGenerationApiSettings(tx, 'banana');
      const candidate = buildImageGenerationApiSettingsPatch(current, input);
      candidate.enabled = body.clear_api_key === true ? false : body.enabled;
      if (candidate.enabled && !candidate.api_key) throw new AuthError('请先填写 Banana 专用 API Key', 400);
      await tx.platformSetting.upsert({
        where: { key: BANANA_IMAGE_API_SETTING_KEY },
        create: { key: BANANA_IMAGE_API_SETTING_KEY, value_json: JSON.stringify(candidate), updated_by: admin.id },
        update: { value_json: JSON.stringify(candidate), updated_by: admin.id },
      });
      await tx.operationLog.create({ data: {
        operator_id: admin.id, action: 'banana_image_api_config_update', target_type: 'PlatformSetting', target_id: BANANA_IMAGE_API_SETTING_KEY,
        detail: JSON.stringify({ enabled: candidate.enabled, base_url: candidate.base_url, api_key_configured: Boolean(candidate.api_key), api_key_changed: Boolean(body.api_key?.trim()), api_key_cleared: body.clear_api_key === true }),
      } });
      return candidate;
    });
    return NextResponse.json({ config: safeConfig(saved) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '通道设置格式无效' }, { status: 400 });
    return NextResponse.json({ error: '保存 Banana 通道失败，请重试' }, { status: 500 });
  }
}
