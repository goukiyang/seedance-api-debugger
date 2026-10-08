import { AuthError, type SessionUser } from './auth/session';
import { assertCanEditCanvasDocument } from './canvas-documents';

// Guarded e227 cannot compile v1 bindings. Preserve them and reject before fee/provider work.
export async function assertCanvasPromptCompatibility(user: SessionUser, documentId: string | null,
  nodeId: string | null, prompt: string, incomingMentions: unknown, canvasRequest = false) {
  const hasMarker = new RegExp('@图[0-9]+(?![\\p{N}A-Za-z_])', 'u').test(prompt);
  if (incomingMentions != null) throw new AuthError('保护回退版本不支持已绑定图片，请更新后再生成；正文和原件已保留', 409);
  if (!hasMarker) return;
  if (!documentId || !nodeId) {
    if (canvasRequest) throw new AuthError('无法核实画布图片绑定，请更新后再生成；原输入已保留', 409);
    return;
  }
  const document = await assertCanEditCanvasDocument(user, documentId);
  let graph;
  try { graph = JSON.parse(document.document_json); } catch { throw new AuthError('画布记录无法读取，未生成', 409); }
  const node = graph?.canvas?.nodes?.find((item: { id: string }) => item.id === nodeId);
  if (canvasRequest && (!node || !['image', 'video'].includes(node.type))) throw new AuthError('绑定目标节点无法核实，未生成', 409);
  if (node?.data?.promptMentions != null) throw new AuthError('保护回退版本不支持已保存的图片绑定，请更新后再生成；正文和原件已保留', 409);
  // An old client may have stripped the binding while retaining its marker. Never guess its ID.
  if (canvasRequest) throw new AuthError('保护回退版本无法核实画布图片编号，请更新后再生成；原输入已保留', 409);
}
