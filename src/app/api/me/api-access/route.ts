import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiError, apiJson, CustomerApiError, isMemberApiSessionWrite, readJson, requestId } from '@/lib/customer-api/auth';
import { claimMemberApiKey, memberApiStatus, requestMemberApi, revokeMemberApiKey } from '@/lib/customer-api/members';
import contract from '../../../../../api-contracts/customer-api/openapi.json';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new CustomerApiError('LOGIN_REQUIRED', '请先登录。', 401);
    const status = await memberApiStatus(user.id);
    if (request.nextUrl.searchParams.get('contract') === '1') return apiJson(contract);
    return apiJson({ ...status, actor_id: user.id });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new CustomerApiError('LOGIN_REQUIRED', '请先登录。', 401);
    if (!isMemberApiSessionWrite(request, user.id)) {
      throw new CustomerApiError('ACCOUNT_CHANGED', '请在原账号下重新打开个人页。', 403);
    }
    const input = await readJson(request);
    if (input.action === 'apply') await requestMemberApi(user.id);
    else if (input.action === 'claim') {
      const result = await claimMemberApiKey(user.id);
      return apiJson({ ...result, actor_id: user.id });
    } else if (input.action === 'revoke') await revokeMemberApiKey(user.id, requestId(input.key_id));
    else throw new CustomerApiError('INVALID_ACTION', '无效的操作。');
    return apiJson({ ...await memberApiStatus(user.id), actor_id: user.id });
  } catch (error) {
    return apiError(error);
  }
}
