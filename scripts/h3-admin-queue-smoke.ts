import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

async function main() {
  const routeSource = readFileSync('src/app/api/admin/integrations/h3/queue/route.ts', 'utf8');
  const clientSource = readFileSync('src/app/admin/integrations/AdminIntegrationsClient.tsx', 'utf8');

  assert.match(routeSource, /getAdminUser\(request\)/, 'H3 队列接口必须只允许管理员调用');
  assert.match(routeSource, /isH3Operational/, 'H3 队列后端必须等健康检查通过后才开放');
  assert.match(routeSource, /getH3QueueState/, 'H3 队列 GET 必须走服务端 adapter');
  assert.match(routeSource, /postH3AdminAction/, 'H3 队列写操作必须走服务端 adapter');
  assert.match(routeSource, /pause[\s\S]+resume[\s\S]+cancel[\s\S]+stop[\s\S]+move/, 'H3 队列接口必须覆盖 pause/resume/cancel/stop/move');
  assert.match(routeSource, /MOVE_DIRECTIONS/, 'move 必须限制 top/up/down/bottom');
  assert.match(routeSource, /h3_queue_\$\{action\}/, 'H3 队列写操作必须写 OperationLog 动作');
  assert.equal(routeSource.includes('admin_token:'), false, '队列操作日志和响应源码不应回显 admin token 字段');

  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/admin/integrations/h3/queue/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.GET, 'function');
  assert.equal(typeof routeModule.POST, 'function');
  assert.equal(routeModule.dynamic, 'force-dynamic');

  assert.match(clientSource, /H3 队列管理/, '后台 H3 卡片必须有队列折叠区');
  assert.match(clientSource, /loadH3Queue/, '后台必须提供刷新队列入口');
  assert.match(clientSource, /submitH3QueueAction/, '后台必须提供队列操作提交入口');
  assert.match(clientSource, /window\.confirm/, '取消和停止这类破坏性操作必须二次确认');
  assert.match(clientSource, /h3Config\.admin_queue_ready/, '队列 UI 必须受 admin token 就绪状态控制');
  assert.match(clientSource, /置顶/, 'move 操作必须有中文方向选项');

  console.log('h3-admin-queue smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
