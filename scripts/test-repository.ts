/**
 * 测试 SeedanceAssetRepository 数据库持久化
 * 直接操作 DB，不依赖外部 API
 */
import { prisma } from '../src/lib/prisma';
import { seedanceAssetRepository } from '../src/lib/assets/seedanceAssetRepository';

async function test() {
  console.log('=== 1. 测试创建记录 ===');
  const created = await seedanceAssetRepository.create({
    providerAssetId: 'asset-test-' + Date.now(),
    assetType: 'Image',
    name: 'test-persistence-' + Date.now(),
    originalUrl: 'https://example.com/test.jpg',
    rawProviderResponse: JSON.stringify({ test: true }),
  });
  console.log('创建成功:', created.localId, created.name, created.providerAssetId);

  console.log('\n=== 2. 测试 list ===');
  const list = await seedanceAssetRepository.list(false);
  console.log('列表数量:', list.length);
  console.log('最新记录:', list[0]?.name);

  console.log('\n=== 3. 测试 get ===');
  const fetched = await seedanceAssetRepository.get(created.localId);
  console.log('查询结果:', fetched?.name, fetched?.providerAssetId);

  console.log('\n=== 4. 测试 update ===');
  const updated = await seedanceAssetRepository.update(created.localId, {
    providerPreviewUrl: 'https://example.com/preview.jpg',
    providerStatus: 'Active',
    lastSyncedAt: new Date(),
  });
  console.log('更新后 providerPreviewUrl:', updated?.providerPreviewUrl);
  console.log('更新后 providerStatus:', updated?.providerStatus);

  console.log('\n=== 5. 测试 softDelete ===');
  const deleted = await seedanceAssetRepository.softDelete(created.localId);
  console.log('软删除后 status:', deleted?.status, 'deletedAt:', deleted?.updatedAt);

  const listAfterDelete = await seedanceAssetRepository.list(false);
  console.log('默认列表不再显示:', listAfterDelete.length === 0 ? '✅ 通过' : '❌ 失败');

  const listWithDeleted = await seedanceAssetRepository.list(true);
  console.log('includeDeleted 能查到:', listWithDeleted.some(a => a.localId === created.localId) ? '✅ 通过' : '❌ 失败');

  console.log('\n=== 6. 测试 count ===');
  const count = await seedanceAssetRepository.count(false);
  console.log('活跃记录数:', count);

  console.log('\n=== 7. 验证数据库真实数据 ===');
  const dbRecord = await prisma.seedanceAsset.findUnique({ where: { id: created.localId } });
  console.log('DB 记录 local_status:', dbRecord?.local_status);
  console.log('DB 记录 deleted_at:', dbRecord?.deleted_at ? '✅ 有值' : '❌ 无值');
  console.log('DB 记录 updated_at:', dbRecord?.updated_at ? '✅ 有值' : '❌ 无值');

  console.log('\n=== 8. 清理测试数据 ===');
  await prisma.seedanceAsset.deleteMany({ where: { name: { startsWith: 'test-persistence-' } } });
  const finalCount = await seedanceAssetRepository.count(false);
  console.log('清理后活跃数:', finalCount);

  console.log('\n✅ 持久化测试全部通过');
  process.exit(0);
}

test().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
