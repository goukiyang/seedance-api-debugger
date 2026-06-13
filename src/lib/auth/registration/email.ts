interface SendRegistrationCodeResult {
  delivered: boolean;
  provider: 'resend' | 'console';
  debugCode?: string;
  error?: string;
}

const RESEND_API_URL = 'https://api.resend.com/emails';

function emailFromAddress(): string {
  return process.env.AUTH_EMAIL_FROM || process.env.EMAIL_FROM || '';
}

function shouldExposeDebugCode(): boolean {
  return process.env.REGISTER_EMAIL_DEBUG === 'true';
}

function emailHtml(code: string): string {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
      <h2>Seedance 2.0 注册验证码</h2>
      <p>你的邮箱注册验证码是：</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
      <p>验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>
    </div>
  `;
}

export async function sendRegistrationCode(email: string, code: string): Promise<SendRegistrationCodeResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = emailFromAddress();

  if (apiKey && from) {
    try {
      const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Seedance 2.0 注册验证码',
          html: emailHtml(code),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('[RegisterEmail] Resend failed', { status: res.status, body: text });
        return { delivered: false, provider: 'resend', error: '验证码邮件发送失败，请稍后重试或联系管理员' };
      }
      return { delivered: true, provider: 'resend' };
    } catch (error) {
      return {
        delivered: false,
        provider: 'resend',
        error: error instanceof Error ? error.message : '验证码邮件发送失败',
      };
    }
  }

  if (shouldExposeDebugCode()) {
    console.info(`[Register] Verification code for ${email}: ${code}`);
    return { delivered: true, provider: 'console', debugCode: code };
  }

  return { delivered: false, provider: 'resend', error: '验证码邮件服务未配置，请联系管理员配置发件服务' };
}
