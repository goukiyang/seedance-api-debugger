import { readFileSync } from 'fs';
import path from 'path';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function main() {
  const adminProjectsClient = readProjectFile('src/app/admin/projects/AdminProjectsClient.tsx');
  const globals = readProjectFile('src/app/globals.css');

  assert(
    adminProjectsClient.includes('function AdminProjectsTableSkeleton')
      && adminProjectsClient.includes('PROJECT_TABLE_SKELETON_ROWS')
      && adminProjectsClient.includes('admin-projects-table-skeleton'),
    '项目管理表格首屏加载必须使用布局匹配的骨架表格',
  );
  assert(
    adminProjectsClient.includes('initialTableLoading')
      && adminProjectsClient.includes('refreshingTable')
      && adminProjectsClient.includes('正在更新项目列表'),
    '项目管理表格刷新时必须保留旧表格，并给出轻量更新提示',
  );
  assert(
    !adminProjectsClient.includes('<p className="text-gray">加载中...</p>'),
    '项目管理表格不能退回单行“加载中...”占位',
  );
  assert(
    globals.includes('.admin-projects-skeleton-line')
      && globals.includes('@keyframes admin-projects-skeleton-pulse')
      && globals.includes('.admin-projects-update-note'),
    '项目管理表格加载动画样式必须存在',
  );

  console.log('admin-projects-loading-smoke passed');
}

main();
