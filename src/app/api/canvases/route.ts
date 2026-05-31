import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import {
  normalizeCanvasDocumentInput,
  parseCanvasDocumentJson,
  summarizeCanvasDocument,
} from '@/lib/canvas/document';
import { prisma } from '@/lib/prisma';
import {
  ensureDefaultProjectForUser,
  getAccessibleProjectIds,
  getProjectForGeneration,
} from '@/lib/projects/permissions';

export const dynamic = 'force-dynamic';

type CanvasSummaryRecord = {
  id: string;
  title: string;
  status: string;
  project_id: string | null;
  owner_user_id: string;
  document_json: string;
  active_generation_node_id: string | null;
  created_at: Date;
  updated_at: Date;
  project: {
    id: string;
    name: string;
    type: string;
    status: string;
    owner_user_id: string;
  } | null;
  owner: {
    id: string;
    name: string;
    username: string;
    email: string;
  };
};

function normalizeDocumentPayload(input: unknown, fallbackTitle: string) {
  if (typeof input === 'string') {
    try {
      return normalizeCanvasDocumentInput(JSON.parse(input), fallbackTitle);
    } catch {
      return normalizeCanvasDocumentInput(null, fallbackTitle);
    }
  }

  return normalizeCanvasDocumentInput(input, fallbackTitle);
}

function serializeCanvasSummary(canvas: CanvasSummaryRecord) {
  const document = parseCanvasDocumentJson(canvas.document_json, canvas.title);
  const summary = summarizeCanvasDocument({
    ...document,
    activeGenerationId: canvas.active_generation_node_id || document.activeGenerationId || '',
  });

  return {
    id: canvas.id,
    title: canvas.title,
    status: canvas.status,
    project_id: canvas.project_id,
    owner_user_id: canvas.owner_user_id,
    active_generation_node_id: canvas.active_generation_node_id,
    created_at: canvas.created_at,
    updated_at: canvas.updated_at,
    node_count: summary.nodeCount,
    edge_count: summary.edgeCount,
    generation_count: summary.generationCount,
    project: canvas.project,
    owner: canvas.owner,
  };
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await ensureDefaultProjectForUser(user.id);

    const includeArchived = request.nextUrl.searchParams.get('include_archived') === 'true';
    const includeAll = user.role === 'admin' && request.nextUrl.searchParams.get('include_all') === 'true';
    const projectId = request.nextUrl.searchParams.get('project_id');
    const statusWhere = includeArchived ? { not: 'deleted' } : 'active';

    const include = {
      project: {
        select: { id: true, name: true, type: true, status: true, owner_user_id: true },
      },
      owner: {
        select: { id: true, name: true, username: true, email: true },
      },
    } as const;

    const canvases = includeAll
      ? await prisma.canvasDocument.findMany({
          where: {
            status: statusWhere,
            ...(projectId ? { project_id: projectId } : {}),
          },
          orderBy: [{ updated_at: 'desc' }],
          include,
        })
      : await prisma.canvasDocument.findMany({
          where: {
            status: statusWhere,
            ...(projectId ? { project_id: projectId } : {}),
            OR: [
              { owner_user_id: user.id },
              { project_id: { in: await getAccessibleProjectIds(user, { includeAdminAll: false }) } },
            ],
          },
          orderBy: [{ updated_at: 'desc' }],
          include,
        });

    return NextResponse.json({
      canvases: canvases.map((canvas) => serializeCanvasSummary(canvas)),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Canvases] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const requestedTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const project = await getProjectForGeneration(
      user,
      typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id : null,
    );
    const document = normalizeDocumentPayload(body.document, requestedTitle || '未命名画布');
    const title = requestedTitle || document.title || '未命名画布';
    const nextDocument = {
      ...document,
      title,
    };

    const canvas = await prisma.canvasDocument.create({
      data: {
        owner_user_id: user.id,
        project_id: project.id,
        title,
        document_json: JSON.stringify(nextDocument),
        active_generation_node_id: nextDocument.activeGenerationId || null,
        status: 'active',
      },
      include: {
        project: {
          select: { id: true, name: true, type: true, status: true, owner_user_id: true },
        },
        owner: {
          select: { id: true, name: true, username: true, email: true },
        },
      },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'canvas_document_create',
        target_type: 'CanvasDocument',
        target_id: canvas.id,
        detail: JSON.stringify({
          title,
          project_id: project.id,
          node_count: nextDocument.nodes.length,
          edge_count: nextDocument.edges.length,
        }),
      },
    });

    return NextResponse.json({
      canvas: {
        ...serializeCanvasSummary(canvas),
        document: nextDocument,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Canvases] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
