import { NextRequest, NextResponse } from 'next/server';
import { verifyFeedbackRelay, FEEDBACK_CARD_SOURCE } from '@/lib/feishu/feedback-relay';
import { feedbackPrisma } from '@/lib/feedback/notification';
import { acknowledgeFeedback } from '@/lib/feedback/lifecycle';
import { FeedbackFlowError } from '@/lib/feedback/flow-state';
import { feedbackRequestText } from '@/lib/feedback/action-request';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  let verified;
  try { verified = verifyFeedbackRelay(await feedbackRequestText(request, 32768), request.headers); }
  catch { return NextResponse.json({ error: 'callback_verification_failed' }, { status: 401 }); }
  try {
    const value = verified.event?.action?.value;
    if (!value || value.source !== FEEDBACK_CARD_SOURCE || value.action !== 'ack') throw new FeedbackFlowError('卡片操作无效', 400);
    const result = await feedbackPrisma.$transaction(tx => acknowledgeFeedback(tx, {
      feedbackId: value.feedbackId, nonce: value.nonce, openId: verified.event.operator?.open_id,
      messageId: verified.context?.open_message_id,
    }), { maxWait: 750, timeout: 1250 });
    // The durable receipt is authoritative even if Feishu cannot refresh the card.
    let card;
    try { if (result.message?.msgType === 'interactive') {
      const saved = JSON.parse(result.message.content);
      saved.elements = saved.elements.map((element: { tag: string; actions?: Array<{ value?: { source?: string } }> }) => element.tag === 'action'
        ? { ...element, actions: element.actions?.filter(action => action.value?.source !== FEEDBACK_CARD_SOURCE) } : element)
        .filter((element: { tag: string; actions?: unknown[] }) => element.tag !== 'action' || element.actions?.length);
      saved.elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '已收到' }] });
      card = { type: 'raw', data: saved };
    } } catch { /* Receipt is committed; a card-render failure cannot undo it. */ }
    return NextResponse.json({ toast: { type: 'success', content: '已收到' }, ...(card ? { card } : {}) });
  } catch (error) {
    return NextResponse.json({ toast: { type: 'error', content: error instanceof FeedbackFlowError ? error.message : '暂未确认，请稍后或在后台查看反馈' } });
  }
}
