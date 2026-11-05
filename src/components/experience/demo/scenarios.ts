export type ExperienceDemoKind = 'reference' | 'compare' | 'reuse' | 'frames' | 'request';

type Scenario = {
  title: string;
  steps: string[];
  window: string;
  source: string;
  choice: string;
  apply: string;
  destination: string;
  result: string;
  receipt: string;
  follow?: { label: string; result: string; receipt: string };
};

export const scenarios: Record<ExperienceDemoKind, Scenario> = {
  reference: {
    title: '怎么把素材加入参考区',
    steps: ['在素材库选中需要的素材。', '点击「加入工作区」，再从回执打开生成工作区。', '在参考区查看刚加入的素材。'],
    window: '创作工作台 · 添加参考', source: '素材库', choice: '街巷夜景',
    apply: '加入工作区', destination: '本次参考区', result: '街巷夜景', receipt: '参考图已加入',
  },
  compare: {
    title: '怎么并排比较两个版本',
    steps: ['在作品详情展开「比较作品」。', '选择一个同组作品，点击「进入比较」。', '点击「交换左右」，对照画面和设置差异。'],
    window: '作品详情 · 成品对比', source: '同组作品', choice: '夜景 · 第二版',
    apply: '进入比较', destination: '成品对比', result: '第一版 · 第二版', receipt: '两个版本已并排',
    follow: { label: '交换左右', result: '第二版 · 第一版', receipt: '画面与设置差异已交换' },
  },
  reuse: {
    title: '怎么从成品参考模板设置',
    steps: ['打开有模板来源的作品详情。', '点击「一键参考」，进入对应创作页面。', '查看带入的本次设置，补充素材和描述，再主动生成。'],
    window: '作品详情 · 一键参考', source: '有权访问的作品', choice: '人物参考 · 成品',
    apply: '一键参考', destination: '对应创作页面', result: '本次设置已带入', receipt: '可继续编辑素材和描述',
  },
  frames: {
    title: '怎么换帧并导出多视图拼图',
    steps: ['在拼图中选中要替换的一格。', '调整待选帧并应用，查看拼图中的新画面。', '点击「下载拼图」，文件准备好后交给浏览器下载。'],
    window: '3D多视图 · 换帧与导出', source: '换帧预览', choice: '第二格 · 待选帧',
    apply: '使用这一帧', destination: '拼图预览', result: '第二格已更新', receipt: '其余格保持当前画面',
    follow: { label: '下载拼图', result: '原尺寸PNG已准备', receipt: '已交给浏览器下载' },
  },
  request: {
    title: '提交待确认时怎么查询',
    steps: ['在原任务或提交回执查看待确认状态。', '点击原请求查询入口，抠图任务使用「重新查询」。', '按查到的真实状态继续，尚未查到时保留原请求核对入口。'],
    window: '任务详情 · 原请求查询', source: '原提交回执', choice: '提交结果待确认',
    apply: '查询原请求', destination: '本次查询结果', result: '原请求已受理', receipt: '沿原任务查看处理状态',
  },
};
