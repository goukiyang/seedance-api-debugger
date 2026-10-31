import { NextRequest } from 'next/server';
import { ZipFile } from 'yazl';
import { requireLabUser, labFailure, labPrivateHeaders } from '@/lib/character-lab/http';
import { labId, readLabPlan } from '@/lib/character-lab/store';
import { labOutput, labPngFromBytes } from '@/lib/character-lab/media';
import { readStudioImage } from '@/lib/image-studio/media';
import { StudioError } from '@/lib/image-studio/tasks';

export const dynamic = 'force-dynamic';
async function exportResult(request: NextRequest, head: boolean) {
  try {
    const user = await requireLabUser(), plan = await readLabPlan(user.id, labId(request.nextUrl.searchParams.get('plan')));
    if (plan.kind !== 'result') throw new StudioError('请选择已生成的角色成品');
    const { asset } = await labOutput(user, plan);
    const mode = request.nextUrl.searchParams.get('mode') || 'sheet';
    if (!['sheet', 'cells', 'all'].includes(mode)) throw new StudioError('导出方式无效');
    const name = (request.nextUrl.searchParams.get('name') || '角色参考图').replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 80) || '角色参考图';
    const filename = `${name}.${mode === 'sheet' ? 'png' : 'zip'}`;
    const headers = { ...labPrivateHeaders, 'Content-Type': mode === 'sheet' ? 'image/png' : 'application/zip',
      'Content-Disposition': `attachment; filename="character-reference.${mode === 'sheet' ? 'png' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(filename)}` };
    if (head) return new Response(null, { headers });
    const input = await readStudioImage(asset.original_url);
    if (mode === 'sheet') return new Response(new Uint8Array(await labPngFromBytes(input, plan)), { headers });
    const zip = new ZipFile(), buffers: Buffer[] = [];
    const complete = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', (chunk: Buffer) => buffers.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(buffers))); zip.outputStream.on('error', reject); });
    if (mode === 'all') zip.addBuffer(await labPngFromBytes(input, plan), `${name}-整图.png`);
    const names = ['正面特写', '侧面特写', '正面全身', '背面全身'];
    for (let i = 0; i < 4; i++) zip.addBuffer(await labPngFromBytes(input, plan, i), `${name}-${names[i]}.png`);
    zip.end();
    return new Response(new Uint8Array(await complete), { headers });
  } catch (error) { return labFailure(error); }
}
export const GET = (request: NextRequest) => exportResult(request, false);
export const HEAD = (request: NextRequest) => exportResult(request, true);
