import { CREDIT_GRANT_AMOUNTS } from './request-rules';

const plain = (content: string) => ({ tag: 'plain_text', content });
const section = (content: string) => ({ tag: 'div', text: plain(content) });

export function creditApprovalCard(input: {
  id: string; nonce: string; purpose: string; name: string; available: number;
}) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: plain('SD2 积分申请'), template: 'blue' },
    elements: [
      section(`${input.name}\n申请时可用：${input.available} 点\n用途：${input.purpose}`),
      { tag: 'action', actions: CREDIT_GRANT_AMOUNTS.map((amount) => ({
        tag: 'button', text: plain(`发放 ${amount}`), type: 'primary',
        value: { requestId: input.id, nonce: input.nonce, action: 'prepare', amount },
      })) },
      { tag: 'action', actions: [{
        tag: 'button', text: plain('暂不发放'), type: 'default',
        confirm: { title: plain('确认暂不发放'), text: plain('申请人将收到未通过通知，可在网站查看结果。') },
        value: { requestId: input.id, nonce: input.nonce, action: 'reject' },
      }] },
    ],
  };
}

export function creditConfirmationCard(input: {
  id: string; nonce: string; confirmationNonce: string; amount: number; name: string; available: number;
}) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: plain('确认发放'), template: 'orange' },
    elements: [
      section(`${input.name}\n当前可用：${input.available} 点\n本次增加：${input.amount} 点\n发放到个人长期积分。确认有效期 5 分钟。`),
      { tag: 'action', actions: [
        { tag: 'button', text: plain(`确认发放 ${input.amount}`), type: 'primary',
          value: { requestId: input.id, nonce: input.nonce, confirmationNonce: input.confirmationNonce, action: 'confirm' } },
        { tag: 'button', text: plain('重新选择'), type: 'default',
          value: { requestId: input.id, nonce: input.nonce, action: 'back' } },
      ] },
    ],
  };
}

export function creditResultCard(message: string) {
  return { header: { title: plain('申请已处理'), template: 'green' }, elements: [section(message)] };
}
