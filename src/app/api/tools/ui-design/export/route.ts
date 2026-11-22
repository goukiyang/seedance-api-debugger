import { NextRequest, NextResponse } from 'next/server';
import { uiUser, uiFailure, privateHeaders } from '@/lib/ui-design/access';
import { readUiDocument } from '@/lib/ui-design/store';
import { uiImageBytes } from '@/lib/ui-design/media';
import type { JsonObject } from '@/lib/ui-design/types';
import yazl from 'yazl';
export const dynamic = 'force-dynamic';
const escapeHtml = (text: unknown) => String(text || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export async function GET(request: NextRequest) {
  try {
    const user = await uiUser(request), record = await readUiDocument(user.id, 'workspace', request.nextUrl.searchParams.get('id') || '');
    const state = record.data.state, images: Array<{ name: string; bytes: Buffer }> = [], missing: string[] = [];
    const sections: string[] = [];
    for (const run of state.runs || []) for (const job of run.jobs || []) for (const candidate of job.candidates || []) {
      const id = candidate.assetId || /[?&]id=([a-zA-Z0-9-]+)/.exec(candidate.dataUrl || '')?.[1];
      if (!id) { missing.push(job.frameName); continue; }
      try {
        const { asset, bytes } = await uiImageBytes(user, id);
        images.push({ name: `${images.length + 1}-${id}.${asset.mime_type.split('/')[1]}`, bytes });
        sections.push(`<figure><img src="data:${escapeHtml(asset.mime_type)};base64,${bytes.toString('base64')}" alt="${escapeHtml(job.frameName)}"><figcaption>${escapeHtml(job.frameName)}</figcaption></figure>`);
      } catch { missing.push(job.frameName); }
    }
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(record.data.name)}</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:32px auto;padding:16px}img{max-width:100%;height:auto}p{white-space:pre-wrap}</style><h1>${escapeHtml(record.data.name)}</h1><p>已导出 ${images.length} 张；缺失或无权导出 ${missing.length} 张${missing.length ? `：${missing.map(escapeHtml).join('、')}` : ''}。</p>${(state.messages || []).filter((message: JsonObject) => message.role === 'user').map((message: JsonObject) => `<p>${escapeHtml(message.text)}</p>`).join('')}${sections.join('')}<p>${escapeHtml(state.brief)}</p></html>`;
    if (request.nextUrl.searchParams.get('format') === 'zip') {
      const zip = new yazl.ZipFile(), chunks: Buffer[] = [];
      const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject); });
      zip.addBuffer(Buffer.from(html), 'design.html'); for (const image of images) zip.addBuffer(image.bytes, image.name); zip.end();
      return new NextResponse(new Uint8Array(await done), { headers: { ...privateHeaders, 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="ui-design.zip"' } });
    }
    return new NextResponse(html, { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="ui-design.html"' } });
  } catch (error) { return uiFailure(error); }
}
