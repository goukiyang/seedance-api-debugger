import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { getProjectAccess } from '@/lib/projects/permissions';
import {
  generationDefaultsPreferenceKey,
  normalizeGenerationDefaults,
  parseStoredGenerationDefaults,
  serializeGenerationDefaults,
  type GenerationSurface,
  type GenerationDefaults,
} from '@/lib/preferences/generation';
import type { SessionUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

function requestSurface(value: string | null | undefined): GenerationSurface {
  return value === 'ip' ? 'ip' : 'normal';
}

function isMissingPreferenceTable(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'P2021'
  );
}

async function stripInaccessibleProject(user: SessionUser, settings: GenerationDefaults) {
  if (!settings.projectId) return settings;
  try {
    const access = await getProjectAccess(user, settings.projectId);
    if (access.canGenerate) return settings;
  } catch {
    // 如果项目不存在或权限读取失败，不把旧 project_id 返回给前端。
  }
  return { ...settings, projectId: null };
}

function authError(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    const surface = requestSurface(request.nextUrl.searchParams.get('surface'));
    try {
      const row = await prisma.userPreference.findUnique({
        where: {
          user_id_key: {
            user_id: user.id,
            key: generationDefaultsPreferenceKey(surface),
          },
        },
        select: { value_json: true, updated_at: true },
      });

      const parsed = parseStoredGenerationDefaults(row?.value_json, surface);
      const settings = parsed ? await stripInaccessibleProject(user, parsed) : null;
      return NextResponse.json({
        settings,
        persisted: Boolean(row),
        updated_at: row?.updated_at ?? null,
      });
    } catch (error) {
      if (isMissingPreferenceTable(error)) {
        return NextResponse.json({
          settings: null,
          persisted: false,
          unavailable: 'user_preference_table_missing',
        });
      }
      throw error;
    }
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    console.error('[GenerationPreference] GET error:', error);
    return NextResponse.json({ error: '读取生成偏好失败' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    const body = await request.json().catch(() => ({}));
    const surface = requestSurface((body as { surface?: unknown }).surface as string | undefined);
    const settings = await stripInaccessibleProject(
      user,
      normalizeGenerationDefaults((body as { settings?: unknown }).settings ?? body, surface),
    );
    const preferenceKey = generationDefaultsPreferenceKey(surface);
    const valueJson = serializeGenerationDefaults(settings, surface);

    try {
      await prisma.userPreference.upsert({
        where: {
          user_id_key: {
            user_id: user.id,
            key: preferenceKey,
          },
        },
        update: { value_json: valueJson },
        create: {
          user_id: user.id,
          key: preferenceKey,
          value_json: valueJson,
        },
      });

      return NextResponse.json({ settings, persisted: true });
    } catch (error) {
      if (isMissingPreferenceTable(error)) {
        return NextResponse.json({
          settings,
          persisted: false,
          unavailable: 'user_preference_table_missing',
        }, { status: 202 });
      }
      throw error;
    }
  } catch (error) {
    const response = authError(error);
    if (response) return response;
    console.error('[GenerationPreference] PATCH error:', error);
    return NextResponse.json({ error: '保存生成偏好失败' }, { status: 500 });
  }
}
