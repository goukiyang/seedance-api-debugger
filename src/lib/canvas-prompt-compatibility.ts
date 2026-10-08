import { AuthError, type SessionUser } from './auth/session';
import { assertCanEditCanvasDocument } from './canvas-documents';

// Also protects an already-open old client from submitting a new bound document as legacy text.
export async function assertCanvasPromptCompatibility(user: SessionUser, documentId: string | null,
  nodeId: string | null, prompt: string, incomingMentions: unknown, supportedVersion = 1) {
  if (!documentId || !nodeId) {
    if (incomingMentions != null) throw new AuthError('图片绑定缺少画布或节点归属，未生成', 400);
    return;
  }
  if (incomingMentions != null && supportedVersion === 0) throw new AuthError('此回退版本不支持已绑定图片，请更新后再生成；正文和原件已保留', 409);
  if (!new RegExp('@图[0-9]+(?![\\p{N}A-Za-z_])', 'u').test(prompt)) return;
  const document = await assertCanEditCanvasDocument(user, documentId);
  let graph;
  try { graph = JSON.parse(document.document_json); } catch { throw new AuthError('画布记录无法读取，未生成', 409); }
  const node = graph?.canvas?.nodes?.find((item: { id: string }) => item.id === nodeId);
  if (incomingMentions != null) {
    if (!node || !['image', 'video'].includes(node.type)) throw new AuthError('绑定目标节点不存在，未生成', 400);
    return;
  }
  if (node?.data?.promptMentions != null) throw new AuthError('当前页面未提交已保存的图片绑定，请刷新后再生成；正文和原件已保留', 409);
}
