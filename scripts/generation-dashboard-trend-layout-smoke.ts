import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const clientPath = join(root, 'src/app/admin/AdminGenerationDashboardClient.tsx');
const cssPath = join(root, 'src/app/globals.css');
const packagePath = join(root, 'package.json');

const client = readFileSync(clientPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  dependencies?: Record<string, string>;
};

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const requiredClientMarkers = [
  "from 'recharts'",
  '<ResponsiveContainer',
  '<ComposedChart',
  '<Bar',
  '<LabelList',
  '<Tooltip',
  'function TrendTooltip',
  'renderTrendBarValueLabel',
  '官方额度',
  '视频条数',
  '生成秒数',
  '周期明细',
  '待官方确认',
  '暂无生成',
];

const requiredCssMarkers = [
  '.admin-dashboard-trend-recharts',
  '.admin-dashboard-trend-tooltip',
  '.admin-dashboard-trend-chart-head',
  '.admin-dashboard-trend-value-label',
  '.admin-dashboard-trend-day em',
  'overflow-x: auto;',
  'max-height: 280px;',
];

const forbiddenMarkers = [
  'admin-dashboard-trend-plot',
  'admin-dashboard-trend-axis',
  'admin-dashboard-trend-count-label',
  'admin-dashboard-trend-node-label',
  'trendCostLabelY',
  'trendPolyline',
  '<Line',
  '橙线看',
];

assert(pkg.dependencies?.recharts, 'package.json 缺少 recharts 依赖');
assert(pkg.dependencies?.['react-is'], 'package.json 缺少 react-is 依赖');

requiredClientMarkers.forEach((marker) => {
  assert(client.includes(marker), `趋势组件缺少必要标记：${marker}`);
});

requiredCssMarkers.forEach((marker) => {
  assert(css.includes(marker), `趋势样式缺少必要标记：${marker}`);
});

forbiddenMarkers.forEach((marker) => {
  assert(!client.includes(marker), `趋势组件仍残留旧遮挡实现：${marker}`);
  assert(!css.includes(marker), `趋势样式仍残留旧遮挡实现：${marker}`);
});

console.log(JSON.stringify({
  ok: true,
  checked: {
    dependencies: ['recharts', 'react-is'],
    client: clientPath,
    css: cssPath,
  },
}, null, 2));
