/**
 * Seedance 2.0 视频生成 API 测试脚本
 *
 * 运行方式:
 *   npx ts-node scripts/test-seedance-api.ts
 *   或
 *   tsx scripts/test-seedance-api.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// 加载 .env 文件
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// 导入 Provider
const {
  createVideoTask,
  getVideoTaskStatus,
  getProviderConfig,
  isApiKeyConfigured,
} = require('../src/lib/provider/jimeng.ts');

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printHeader(title: string): void {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function printConfig(): void {
  const config = getProviderConfig();
  console.log('\n[配置信息]');
  console.log(`  Base URL:   ${config.baseUrl}`);
  console.log(`  Model:      ${config.model}`);
  console.log(`  API Key:    ${config.apiKeyMasked}`);
}

// ============================================================================
// Main Test
// ============================================================================

async function main(): Promise<void> {
  printHeader('Seedance 2.0 视频生成 API 联调测试');

  // 1. 读取配置
  printConfig();

  if (!isApiKeyConfigured()) {
    console.log('\n❌ API Key 未配置!');
    console.log('\n请在 .env 中配置:');
    console.log('  SEEDANCE_API_KEY=your_api_key');
    console.log('  SEEDANCE_BASE_URL=https://etc.seedance-api.net/server/api');
    console.log('  SEEDANCE_MODEL=dreamina-seedance-2-0-260128');
    process.exit(1);
  }

  // 2. 测试参数
  const testPrompt = 'A small white rabbit running across a clean yellow studio background, smooth camera movement, 5 seconds.';

  printHeader('测试参数');
  console.log(`  Prompt: ${testPrompt}`);
  console.log(`  Duration: 5s`);
  console.log(`  Ratio: 16:9`);
  console.log(`  Resolution: 720p`);

  try {
    // 3. 创建任务
    printHeader('步骤 1: 创建视频生成任务');

    console.log('\n提交请求...\n');

    const createResult = await createVideoTask({
      prompt: testPrompt,
      mode: 'text_to_video',
      ratio: '16:9',
      duration: 5,
      resolution: '720p',
    });

    const taskId = createResult.provider_task_id;
    console.log(`\n✅ 创建成功!`);
    console.log(`   Provider Task ID: ${taskId}`);
    console.log(`   Create Response JSON:\n`);
    console.log(JSON.stringify(createResult.raw_response, null, 2));

    // 4. 轮询状态
    printHeader('步骤 2: 查询任务状态 (轮询)');

    const MAX_RETRIES = 60; // 最多查询 60 次
    const POLL_INTERVAL = 10000; // 10 秒

    console.log(`\n轮询设置: 每 ${POLL_INTERVAL / 1000}s 查询一次, 最多 ${MAX_RETRIES} 次\n`);

    for (let i = 1; i <= MAX_RETRIES; i++) {
      console.log(`--- 轮询 #${i}/${MAX_RETRIES} ---`);

      const statusResult = await getVideoTaskStatus(taskId);

      if (statusResult.status === 'succeeded') {
        printHeader('✅ 任务完成!');

        console.log(`\n[最终结果]`);
        console.log(`  Task ID:      ${taskId}`);
        console.log(`  Status:       ${statusResult.status}`);
        console.log(`  Video URL:    ${statusResult.result_video_url}`);
        console.log(`\n[Status Response JSON]:\n`);
        console.log(JSON.stringify(statusResult.raw_response, null, 2));

        console.log(`\n请复制 Video URL 到浏览器预览:`);
        console.log(`  ${statusResult.result_video_url}\n`);

        process.exit(0);
      }

      if (statusResult.status === 'failed') {
        printHeader('❌ 任务失败!');

        console.log(`\n[错误信息]`);
        console.log(`  Task ID:      ${taskId}`);
        console.log(`  Status:       ${statusResult.status}`);
        console.log(`  Error:        ${statusResult.error_message}`);
        console.log(`\n[Status Response JSON]:\n`);
        console.log(JSON.stringify(statusResult.raw_response, null, 2));

        process.exit(1);
      }

      // still in progress
      console.log(`  状态: ${statusResult.status} (进行中)`);

      if (i < MAX_RETRIES) {
        console.log(`\n等待 ${POLL_INTERVAL / 1000}s 后继续查询...\n`);
        await sleep(POLL_INTERVAL);
      }
    }

    // 超时
    printHeader('⏰ 轮询超时');
    console.log(`\n任务在 ${MAX_RETRIES * POLL_INTERVAL / 1000}s 后仍未完成`);
    console.log(`Task ID: ${taskId}`);
    console.log(`请稍后手动查询状态或检查控制台\n`);

  } catch (error) {
    printHeader('❌ 测试失败!');

    console.log(`\n[错误信息]`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);

    // 输出帮助信息
    printHeader('排查指南');

    const config = getProviderConfig();
    console.log(`\n当前配置:`);
    console.log(`  Base URL:   ${config.baseUrl}`);
    console.log(`  Model:     ${config.model}`);
    console.log(`  API Key:   ${config.apiKeyMasked}`);

    console.log(`\nEndpoints:`);
    console.log(`  Create:  POST ${config.baseUrl}/call`);
    console.log(`  Status:  POST ${config.baseUrl}/getResult`);

    console.log(`\n可能的问题:`);
    console.log(`  1. API Key 不正确`);
    console.log(`  2. API Key 已过期或无权限`);
    console.log(`  3. 视频生成服务未开通`);
    console.log(`  4. Base URL 不正确`);
    console.log(`  5. 模型名称不正确`);

    console.log(`\n请确认 API Key 是否正确配置在 .env 文件中.\n`);

    process.exit(1);
  }
}

// 运行
main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
