import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import {
  normalizeCanvasDocumentInput,
  parseCanvasDocumentJson,
  summarizeCanvasDocument,
} from '@/lib/canvas/document';
import {
  assertCanDeleteCanvas,
  assertCanEditCanvas,
  assertCanViewCanvas,
} from '@/lib/canvas/permissions';
import { prisma } from '@/lib/prisma';
import { getProjectForGeneration } from '@/lib/projects/permissions';

export const dynamic = 'force-dynamic';

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

function serializeCanvasDetail(
  canvas: {
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
  },
) {
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
    document: {
      ...document,
      activeGenerationId: canvas.active_generation_node_id || document.activeGenerationId || '',
    },
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanViewCanvas(user, params.id);

    const canvas = await prisma.canvasDocument.findUnique({
      where: { id: params.id },
      include: {
        project: {
          select: { id: true, name: true, type: true, status: true, owner_user_id: true },
        },
        owner: {
          select: { id: true, name: true, username: true, email: true },
        },
      },
    });

    if (!canvas || canvas.status === 'deleted') {
      return NextResponse.json({ error: '画布不存在' }, { status: 404 });
    }

    return NextResponse.json({
      canvas: serializeCanvasDetail(canvas),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Canvases] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanEditCanvas(user, params.id);

    const body = await request.json();
    const currentCanvas = await prisma.canvasDocument.findUnique({
      where: { id: params.id },
    });

    if (!currentCanvas || currentCanvas.status === 'deleted') {
      return NextResponse.json({ error: '画布不存在' }, { status: 404 });
    }

    const requestedTitle = typeof body.title === 'string' ? body.title.trim() : currentCanvas.title;
    const project = await getProjectForGeneration(
      user,
      typeof body.project_id === 'string' && body.project_id.trim()
        ? body.project_id
        : currentCanvas.project_id,
    );
    const document = normalizeDocumentPayload(body.document, requestedTitle || currentCanvas.title || '未命名画布');
    const title = requestedTitle || document.title || currentCanvas.title || '未命名画布';
    const nextDocument = {
      ...document,
      title,
    };

    const canvas = await prisma.canvasDocument.update({
      where: { id: params.id },
      data: {
        title,
        project_id: project.id,
        document_json: JSON.stringify(nextDocument),
        active_generation_node_id: nextDocument.activeGenerationId || null,
        status: body.status === 'archived' ? 'archived' : 'active',
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
        action: 'canvas_document_update',
        target_type: 'CanvasDocument',
        target_id: canvas.id,
        detail: JSON.stringify({
          title,
          project_id: project.id,
          node_count: nextDocument.nodes.length,
          edge_count: nextDocument.edges.length,
          status: canvas.status,
        }),
      },
    });

    return NextResponse.json({
      canvas: serializeCanvasDetail(canvas),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Canvases] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanDeleteCanvas(user, params.id);

    await prisma.canvasDocument.update({
      where: { id: params.id },
      data: { status: 'deleted' },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'canvas_document_delete',
        target_type: 'CanvasDocument',
        target_id: params.id,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Canvases] Delete error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
