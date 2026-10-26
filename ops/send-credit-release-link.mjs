import { execFileSync } from 'node:child_process';

const approver = process.argv[process.argv.indexOf('--approver') + 1];
if (!process.argv.includes('--approver') || !/^[a-z0-9]+$/.test(approver || '')) throw new Error('approver_required');
const recipient = execFileSync('sqlite3', ['-readonly', '/data/video-api-debugger/var-lib/dev.db',
  `SELECT feishu_open_id FROM User WHERE id='${approver}' AND role='admin' AND status='active';`], { encoding: 'utf8' }).trim();
if (!recipient) throw new Error('release_recipient_missing');
async function api(path, body, token) {
  const r = await fetch(`https://open.feishu.cn/open-apis/${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  if (!r.ok || data.code !== 0) throw new Error(`feishu_${Number(data.code) || r.status}`);
  return data;
}
const auth = await api('auth/v3/tenant_access_token/internal', { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
await api('im/v1/messages?receive_id_type=open_id', { receive_id: recipient, msg_type: 'interactive', uuid: 'sd2-credit-release-20260915-v020', content: JSON.stringify({
  header: { title: { tag: 'plain_text', content: 'SD2 积分入口验收' } },
  elements: [
    { tag: 'div', text: { tag: 'plain_text', content: '积分申请新入口已部署，正在做最后验收。此消息不扣除或增加积分。' } },
    { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开积分页面' }, type: 'primary', url: 'https://sd2.youdooart.com/points' }] },
  ],
}) }, auth.tenant_access_token);
console.log('PASS: release entry card delivered to configured administrator');
