import assert from 'node:assert/strict';
import {
  buildModuleBuilderSystemPrompt,
  parseModuleBuilderAgentResponse,
  validateModuleBuilderDraft,
} from '@/lib/templates/module-builder';

const fencedJson = [
  '```json',
  JSON.stringify({
    moduleType: 'character',
    moduleName: '兔子IP',
    promptBlock: {
      description: '白色兔子IP角色，保持原有造型比例与核心识别点。',
      personality: '灵动、活泼、略带调皮。',
    },
    rules: [
      {
        ruleType: 'MUST',
        injectionMode: 'prompt_required',
        target: 'character',
        content: '必须保持兔子IP核心造型、比例和白色兔子识别点。',
        priority: 95,
      },
      {
        ruleType: 'FORBID',
        injectionMode: 'validation_only',
        target: 'character',
        content: '禁止写实化、禁止改变角色结构、禁止变形成其他动物。',
        priority: 100,
      },
    ],
  }),
  '```',
].join('\n');

const parsed = parseModuleBuilderAgentResponse(fencedJson);
assert.equal(parsed.needsClarification, false);
assert.equal(parsed.draft?.moduleType, 'character');
assert.equal(parsed.draft?.moduleName, '兔子IP');
assert.deepEqual(validateModuleBuilderDraft(parsed.draft), []);

const clarification = parseModuleBuilderAgentResponse(JSON.stringify({
  needsClarification: true,
  questions: ['请上传或选择兔子IP参考图。'],
}));
assert.equal(clarification.needsClarification, true);
assert.equal(clarification.questions?.[0], '请上传或选择兔子IP参考图。');

const prompt = buildModuleBuilderSystemPrompt({
  moduleType: 'prompt_format',
  defaultRules: '默认规则',
  sessionRules: '本次规则',
});
for (const token of ['moduleType', 'prompt_required', 'MUST', 'needsClarification', '提示词格式']) {
  assert.ok(prompt.includes(token), `system prompt should include ${token}`);
}

console.log('module-builder-agent smoke passed');
