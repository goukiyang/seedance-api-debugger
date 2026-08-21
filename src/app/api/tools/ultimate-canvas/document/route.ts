import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, type SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { getProjectAccess } from '@/lib/projects/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DOCUMENT_JSON_BYTES = 2 * 1024 * 1024;

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function safeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeDocument(document: {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  title: string;
  document_json: string;
  active_generation_node_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: document.id,
    owner_user_id: document.owner_user_id,
    project_id: document.project_id,
    title: document.title,
    document_json: document.document_json,
    active_generation_node_id: document.active_generation_node_id,
    status: document.status,
    created_at: safeDate(document.created_at),
    updated_at: safeDate(document.updated_at),
  };
}

async function assertCanUseCanvasProject(user: SessionUser, projectId: string | null) {
  if (!projectId) return null;
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canGenerate) throw new AuthError('无权在此项目中编辑无线画布', 403);
  return access.project;
}

async function assertCanEditCanvasDocument(user: SessionUser, documentId: string) {
  const document = await prisma.canvasDocument.findUnique({ where: { id: documentId } });
  if (!document || document.status === 'deleted') throw new AuthError('画布不存在', 404);
  if (user.role === 'admin' || document.owner_user_id === user.id) return document;
  if (!document.project_id) throw new AuthError('无权编辑此画布', 403);
  const access = await getProjectAccess(user, document.project_id);
  if (!access.canGenerate) throw new AuthError('无权编辑此画布', 403);
  return document;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权使用无线画布。');

    const documentId = request.nextUrl.searchParams.get('document_id')?.trim() || '';
    const projectId = request.nextUrl.searchParams.get('project_id')?.trim() || null;

    if (documentId) {
      const document = await assertCanEditCanvasDocument(user, documentId);
      return NextResponse.json({ document: serializeDocument(document) });
    }

    if (projectId) await assertCanUseCanvasProject(user, projectId);
    const document = await prisma.canvasDocument.findFirst({
      where: {
        owner_user_id: user.id,
        project_id: projectId || undefined,
        status: 'active',
      },
      orderBy: { updated_at: 'desc' },
    });

    return NextResponse.json({ document: document ? serializeDocument(document) : null });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[UltimateCanvasDocument] Load failed:', error);
    return NextResponse.json({ error: '画布读取失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权使用无线画布。');

    const body = await request.json() as Record<string, unknown>;
    const documentId = cleanString(body.document_id || body.documentId);
    const projectId = cleanString(body.project_id || body.projectId) || null;
    const title = cleanString(body.title, '无线画布').slice(0, 120);
    const activeNodeId = cleanString(body.active_generation_node_id || body.activeGenerationNodeId) || null;
    const rawDocumentJson = typeof body.document_json === 'string'
      ? body.document_json
      : typeof body.documentJson === 'string'
        ? body.documentJson
        : JSON.stringify(body.document || {});

    if (!rawDocumentJson || rawDocumentJson === '{}') {
      return NextResponse.json({ error: '画布内容不能为空' }, { status: 400 });
    }
    if (byteLength(rawDocumentJson) > MAX_DOCUMENT_JSON_BYTES) {
      return NextResponse.json({ error: '画布内容超过 2MB，请拆分后保存' }, { status: 413 });
    }
    JSON.parse(rawDocumentJson);

    await assertCanUseCanvasProject(user, projectId);

    const document = documentId
      ? await (async () => {
          const existing = await assertCanEditCanvasDocument(user, documentId);
          if (projectId && existing.project_id && existing.project_id !== projectId) {
            throw new AuthError('画布不属于当前项目', 400);
          }
          return prisma.canvasDocument.update({
            where: { id: documentId },
            data: {
              project_id: projectId || existing.project_id,
              title,
              document_json: rawDocumentJson,
              active_generation_node_id: activeNodeId,
              status: 'active',
            },
          });
        })()
      : await prisma.canvasDocument.create({
          data: {
            owner_user_id: user.id,
            project_id: projectId,
            title,
            document_json: rawDocumentJson,
            active_generation_node_id: activeNodeId,
            status: 'active',
          },
        });

    return NextResponse.json({ success: true, document: serializeDocument(document) });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: '画布内容不是有效 JSON' }, { status: 400 });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[UltimateCanvasDocument] Save failed:', error);
    return NextResponse.json({ error: '画布保存失败' }, { status: 500 });
  }
}
