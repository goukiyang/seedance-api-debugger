import {
  buildTemplateModuleLibraryItem,
  getTemplateModuleLibrary,
  saveTemplateModuleLibrary,
  upsertTemplateModuleInLibrary,
} from '@/lib/templates/module-library';
import { VIDEO_PROMPT_FORMAT_REQUIREMENTS, type ModuleBuilderDraft } from '@/lib/templates/module-builder';
import { prisma } from '@/lib/prisma';
import {
  serializeGenerationTemplate,
  TEMPLATE_INCLUDE,
} from '@/lib/templates/workbench';

const MODULE_NAME = '视频提示词格式';
const MODULE_CATEGORY = '提示词格式';
const SOURCE_RULES = '来自 sd2-video-generate skill 和通用视频提示词格式.md，用于永久模块库。';

const PROMPT_FORMAT_CONTENT = [
  '生成视频提示词时，必须使用结构化分镜格式，不要输出散文式描述。',
  '',
  '输出格式必须如下：',
  '',
  '(创意名编号)',
  '',
  '【开场方式】，【空间/背景】，【主体】为视觉核心。主任务：【最终观众看到什么/记住什么】。限制：【必要禁止项】。',
  '',
  '时间 / 景别 / 运镜 / 内容',
  '时间 / 景别 / 运镜 / 内容',
  '时间 / 景别 / 运镜 / 内容',
  '...',
  '',
  '(end)',
  '',
  '格式规则：',
  '1. 首行必须是创意名编号，格式为“最多两个中文字符 + 三位数字”，例如：(弹力001)、(标动002)。',
  '2. 不要使用英文、下划线、长标题或中英混合标题。',
  '3. 总述必须包含开场方式、空间/背景、主体、主任务和限制。',
  '4. 每一条分镜必须使用“时间 / 景别 / 运镜 / 内容”。',
  '5. 时间必须连续、不重叠、不跳秒，并且最后一条落到目标总时长。',
  '6. 每一镜只写一个核心可见动作，不要把多个动作塞进同一镜。',
  '7. 景别必须明确，例如：全景、中景、中近景、近景、特写、低角度、俯拍。',
  '8. 运镜必须明确，例如：固定、推入、拉远、横移、跟随、锁定。',
  '9. 内容必须写可被画面呈现的动作和变化，不写“高级”“有质感”“更好看”这类抽象评价。',
  '10. 默认使用中文写提示词。',
  '11. 默认使用正向画面描述。禁止项只放在总述的“限制”里，且保持简短，不要堆叠大量负向提示词。',
  '12. 结尾必须写：(end)。',
].join('\n');

const LLM_REFERENCE = [
  '这个模块只控制“视频提示词输出格式”，不决定角色、风格、Logo、产品、镜头创意本身。',
  '如果用户指定了视频时长，分镜时间必须覆盖完整时长。',
  '如果用户没有指定时长，测试版本默认按 4 秒组织。',
  '如果是正式视频，根据用户指定时长拆分连续分镜。',
  '输出时优先保证：格式稳定 > 时间连续 > 动作可见 > 镜头清楚 > 文案好看。',
].join('\n');

function buildDraft(): ModuleBuilderDraft {
  return {
    moduleType: 'prompt_format',
    moduleName: MODULE_NAME,
    promptBlock: {
      content: PROMPT_FORMAT_CONTENT,
      llm_reference: LLM_REFERENCE,
      source_requirements: VIDEO_PROMPT_FORMAT_REQUIREMENTS,
    },
    rules: [
      {
        ruleType: 'MUST',
        injectionMode: 'prompt_required',
        target: 'prompt_format',
        content: '必须按“创意名编号 + 总述 + 连续分镜 + (end)”格式输出视频提示词。',
        priority: 100,
      },
      {
        ruleType: 'MUST',
        injectionMode: 'prompt_required',
        target: 'prompt_format',
        content: '每条分镜必须包含时间、景别、运镜和一个核心可见动作。',
        priority: 98,
      },
      {
        ruleType: 'FORBID',
        injectionMode: 'validation_only',
        target: 'prompt_format',
        content: '禁止输出散文式提示词，禁止使用英文长标题、下划线或中英混合创意名。',
        priority: 96,
      },
      {
        ruleType: 'SUGGEST',
        injectionMode: 'context_only',
        target: 'prompt_format',
        content: '默认使用正向画面描述，必要限制集中写在总述的“限制”字段。',
        priority: 82,
      },
    ],
    injectionMode: 'prompt_required',
    priority: 100,
    target: 'prompt_format',
    assetBinding: null,
  };
}

async function main() {
  const template = await prisma.generationTemplate.findFirst({
    where: { status: { in: ['draft', 'active'] } },
    orderBy: { updated_at: 'desc' },
    include: TEMPLATE_INCLUDE,
  });
  if (!template) throw new Error('缺少可用模板，无法写入模块库来源');

  const actor = await prisma.user.findFirst({
    where: { role: 'admin', status: 'active' },
    orderBy: { created_at: 'asc' },
  });
  if (!actor) throw new Error('缺少可用管理员，无法记录模块创建人');

  const result = await prisma.$transaction(async (tx) => {
    const serializedTemplate = serializeGenerationTemplate(template);
    const library = await getTemplateModuleLibrary(tx);
    const draft = buildDraft();
    const existingModule = library.modules.find((item) => (
      item.scope === 'global'
      && item.module_type === 'prompt_format'
      && item.name === MODULE_NAME
    )) || null;

    const moduleItem = buildTemplateModuleLibraryItem({
      draft,
      template: serializedTemplate,
      actorUserId: actor.id,
      sessionRules: SOURCE_RULES,
      scope: 'global',
      status: 'active',
      category: MODULE_CATEGORY,
      existingModule,
      adminModified: false,
      diffSummary: existingModule ? ['更新视频提示词格式模块'] : ['新增视频提示词格式模块'],
    });

    const nextLibrary = upsertTemplateModuleInLibrary(library, moduleItem);
    await saveTemplateModuleLibrary(nextLibrary, actor.id, tx);

    await tx.operationLog.create({
      data: {
        operator_id: actor.id,
        action: 'module_library_seed_prompt_format',
        target_type: 'PlatformSetting',
        target_id: 'template_module_library_v1',
        detail: JSON.stringify({
          module_id: moduleItem.id,
          module_type: moduleItem.module_type,
          module_name: moduleItem.name,
          category: moduleItem.category,
          scope: moduleItem.scope,
          version: moduleItem.current_version,
          source_template_id: serializedTemplate.id,
        }),
      },
    });

    return {
      id: moduleItem.id,
      name: moduleItem.name,
      category: moduleItem.category,
      scope: moduleItem.scope,
      version: moduleItem.current_version,
      updated_at: moduleItem.updated_at,
    };
  });

  console.log(JSON.stringify({ ok: true, module: result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
