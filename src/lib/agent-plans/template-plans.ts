import type { SerializedGenerationTemplate, SerializedTemplateRule } from '@/lib/templates/workbench';

export type TemplateUserInput = {
  text: string;
  modifiers: string[];
};

export type AgentPlan = {
  key: 'A' | 'B' | 'C' | 'D';
  title: string;
  angle: string;
  structure: string[];
  fit: string;
  risk: string;
  prompt: string;
};

export type TemplatePlanResult = {
  plans: AgentPlan[];
  recommendedPlanKey: AgentPlan['key'];
  prompt: string;
};

const PLAN_DIRECTIONS: Array<Pick<AgentPlan, 'key' | 'title' | 'angle' | 'fit' | 'risk'> & { rhythm: string; camera: string }> = [
  {
    key: 'A',
    title: '品牌开场型',
    angle: '先建立品牌识别，再展示产品价值。',
    fit: '适合品牌宣传、发布会开场、官网首屏视频。',
    risk: '如果需求偏转化，开场品牌露出可能显得稍慢。',
    rhythm: '稳健推进，镜头清楚，转场克制。',
    camera: '从中景品牌环境推进到产品特写，再回到完整品牌画面。',
  },
  {
    key: 'B',
    title: '产品动线型',
    angle: '围绕一个清晰使用场景展示产品如何解决问题。',
    fit: '适合功能解释、产品介绍、销售材料。',
    risk: '如果模板素材不足，需要避免把产品细节虚构过多。',
    rhythm: '节奏更快，信息密度高，每段只表达一个动作。',
    camera: '用跟随镜头、俯拍细节和轻微推拉突出操作路径。',
  },
  {
    key: 'C',
    title: '情绪记忆型',
    angle: '用情绪和场景氛围增强品牌记忆点。',
    fit: '适合社媒传播、品牌概念片、活动预热。',
    risk: '如果情绪过强，可能弱化具体产品信息。',
    rhythm: '先蓄势再释放，画面更有呼吸感。',
    camera: '用慢推、环绕和空间层次强调主体气质。',
  },
  {
    key: 'D',
    title: '多段叙事型',
    angle: '把需求拆成连续段落，保证 15 秒内结构完整。',
    fit: '适合长一点的信息、需要分镜连续和帧传递的内容。',
    risk: '段落过多时单段表现会变薄，需要控制信息量。',
    rhythm: '按 3 段递进，每段保持明确起止动作。',
    camera: '用建立镜头、动作镜头和结果镜头形成闭环。',
  },
];

export function normalizeTemplateUserInput(input: unknown): TemplateUserInput {
  const object = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const text = typeof object.text === 'string' ? object.text.trim() : '';
  const modifiers = Array.isArray(object.modifiers)
    ? object.modifiers.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 8)
    : [];
  return { text, modifiers };
}

export function createTemplatePlanResult(template: SerializedGenerationTemplate, input: TemplateUserInput): TemplatePlanResult {
  const plans = PLAN_DIRECTIONS.map((direction) => {
    const structure = buildStructure(direction.key, template, input);
    const prompt = composePrompt(template, input, {
      key: direction.key,
      title: direction.title,
      angle: direction.angle,
      rhythm: direction.rhythm,
      camera: direction.camera,
      structure,
    });
    return {
      key: direction.key,
      title: direction.title,
      angle: direction.angle,
      structure,
      fit: direction.fit,
      risk: direction.risk,
      prompt,
    };
  });
  const recommendedPlanKey = input.modifiers.some((modifier) => modifier.includes('快')) ? 'B' : 'A';
  return {
    plans,
    recommendedPlanKey,
    prompt: plans.find((plan) => plan.key === recommendedPlanKey)?.prompt || plans[0]?.prompt || '',
  };
}

function buildStructure(key: AgentPlan['key'], template: SerializedGenerationTemplate, input: TemplateUserInput) {
  const subject = input.text || template.description || template.name;
  if (key === 'B') {
    return [
      `场景建立：用一句视觉动作明确用户需求：${subject}`,
      '产品动作：展示核心功能或服务如何进入画面并解决问题',
      '品牌收束：Logo 和主体稳定出现，留下明确记忆点',
    ];
  }
  if (key === 'C') {
    return [
      `氛围铺陈：用光影和环境建立 ${template.name} 的情绪基调`,
      `主体强化：围绕 ${subject} 做一次可感知的视觉转折`,
      '记忆点：以品牌色、Logo 或角色动作完成收束',
    ];
  }
  if (key === 'D') {
    return [
      `第一段 0-5s：建立需求和主体，主题是 ${subject}`,
      '第二段 5-10s：展示变化过程，保持角色、Logo 和风格一致',
      '第三段 10-15s：呈现结果，使用稳定品牌画面收尾',
    ];
  }
  return [
    `品牌信号：开场直接建立 ${template.name} 的识别`,
    `价值表达：围绕 ${subject} 展示一个清晰动作或场景`,
    '结束画面：Logo、主体和品牌风格稳定停留',
  ];
}

function composePrompt(
  template: SerializedGenerationTemplate,
  input: TemplateUserInput,
  plan: {
    key: AgentPlan['key'];
    title: string;
    angle: string;
    rhythm: string;
    camera: string;
    structure: string[];
  },
) {
  const activeRules = template.rules.filter((rule) => rule.status === 'active');
  const must = rulesByType(activeRules, 'must');
  const forbid = rulesByType(activeRules, 'forbid');
  const suggest = rulesByType(activeRules, 'suggest');
  const promptBlocks = template.prompts
    .filter((block) => block.status === 'active')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((block) => block.content);
  const modifiers = input.modifiers.length ? input.modifiers.join('，') : '保持模板默认风格';
  const temporal = template.temporal.enabled
    ? `默认按 ${template.temporal.segment}s 结构组织${template.temporal.handoff ? '，启用帧传递' : '，不强制帧传递'}。`
    : '不启用分段策略。';

  return [
    `使用模板：${template.name} ${template.version}`,
    `本次需求：${input.text || '按模板默认目标生成品牌视频'}`,
    `选择方案 ${plan.key}：${plan.title}。${plan.angle}`,
    `快速调节：${modifiers}`,
    `镜头策略：${plan.camera}`,
    `节奏：${plan.rhythm}`,
    `分段策略：${temporal}`,
    `结构：${plan.structure.join('；')}`,
    promptBlocks.length ? `模板提示词：${promptBlocks.join('；')}` : '',
    must.length ? `必须：${must.join('；')}` : '',
    suggest.length ? `建议：${suggest.join('；')}` : '',
    forbid.length ? `禁止：${forbid.join('；')}` : '',
    '输出为连续视频画面描述，保持主体、Logo、风格和镜头逻辑一致。',
  ].filter(Boolean).join('\n');
}

function rulesByType(rules: SerializedTemplateRule[], type: SerializedTemplateRule['rule_type']) {
  return rules
    .filter((rule) => rule.rule_type === type)
    .sort((a, b) => b.priority - a.priority || a.sort_order - b.sort_order)
    .map((rule) => rule.content);
}
