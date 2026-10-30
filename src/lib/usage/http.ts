import { NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { createProjectUsageScope, createSelfUsageScope } from './access';
import { parseUsageQuery, UsageQueryError } from './query';
import { getUsageExportSnapshot, getUsageReport } from './personal';
import { usageCsvChunks } from './csv';

export const usagePrivateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function handleUsageRequest(request: Request, projectId?: string, csv = false): Promise<Response> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers: usagePrivateHeaders });
    const params = new URL(request.url).searchParams;
    const scope = projectId !== undefined
      ? await createProjectUsageScope(user, projectId, params.has('member_owner_id') ? params.get('member_owner_id')! : undefined)
      : createSelfUsageScope(user);
    const query = parseUsageQuery(params, scope);
    if (!csv) return NextResponse.json(await getUsageReport(scope, query), { headers: usagePrivateHeaders });
    // Finish the safe snapshot before sending bytes; no database transaction
    // remains open while the browser downloads the completed projection.
    const snapshot = await getUsageExportSnapshot(scope, query);
    const chunks = usageCsvChunks(snapshot);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) { await snapshot.dispose?.(); controller.error(error); }
      },
      async cancel() { await chunks.return(undefined); await snapshot.dispose?.(); },
    });
    return new Response(stream, { headers: { ...usagePrivateHeaders, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${scope.kind}-usage-${query.month}-${query.type}.csv"`,
      'X-Usage-As-Of': snapshot.report.asOf, 'X-Usage-Fingerprint': snapshot.report.fingerprint,
      'X-Usage-Total': String(snapshot.records.length) } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UsageQueryError) return NextResponse.json({ error: error.message }, { status: error.status, headers: usagePrivateHeaders });
    return NextResponse.json({ error: csv ? '用量导出暂时失败，请保留条件后重试' : '用量暂时无法读取，请保留条件后重试' }, { status: 503, headers: usagePrivateHeaders });
  }
}
