import { AVATAR_CATALOG_VERSION, catalog, fieldAliases, fieldLabels, identityFields, optionWeights } from './catalog';

// These are independently worded product definitions, not translated dataset tables.
export const catalogSources = {
  project: { use: 'original-product-definitions', license: 'project-owned; no third-party dataset license asserted', version: AVATAR_CATALOG_VERSION },
  dicebear: { use: 'mechanism-reference-only; no code or artwork copied', version: '4db7af08605ecbf1c142b710ad1819473c096895', url: 'https://github.com/dicebear/dicebear/blob/4db7af08605ecbf1c142b710ad1819473c096895/src/js/core/src/Resolver.ts', license: 'MIT software only; styles have separate licenses; not imported' },
  avataaars: { use: 'grouping-reference-only; no code or artwork copied', version: '93aa902c729b1a9eaf2b5917c6d1ebe9de32af75', url: 'https://github.com/fangpenlin/avataaars/blob/93aa902c729b1a9eaf2b5917c6d1ebe9de32af75/src/options/index.tsx', license: 'MIT code does not license all artwork; not imported' },
  maad: { use: 'research-comparison-only; no labels, arrangement, frequencies or data copied', version: '5915271b855399c830fc4cfd360df19c8f300791', url: 'https://github.com/pterhoer/MAAD-Face/blob/5915271b855399c830fc4cfd360df19c8f300791/README.md', license: 'CC BY-SA 4.0 annotation obligations; images separate; adoption not cleared and not imported' },
  celeba: { use: 'excluded-from-commercial-data-and-training', url: 'https://mmlab.ie.cuhk.edu.hk/projects/CelebA.html', version: 'public agreement checked 2026-10-05', license: 'non-commercial research; no data, derivatives or weights imported' },
} as const;

export const catalogDefinitions = Object.fromEntries(Object.entries(catalog).map(([key, values]) => [key, {
  id: key, version: AVATAR_CATALOG_VERSION, label: fieldLabels[key],
  definition: key === 'age' ? '生成形象的目标年龄外观，不推断真实人物年龄' : key === 'facial_hair' ? '人物上唇、下巴与脸侧可见胡须的造型，不作为性别或身份判断' : `生成形象的${fieldLabels[key]}外观方向，不用于照片识别或真实身份判断`,
  adoption: key === 'facial_hair' ? 'necessary-addition' : 'existing-retained', source: 'project',
  references: key === 'facial_hair' ? ['avataaars:grouping-reference-only', 'maad:research-comparison-only'] : ['dicebear:mechanism-reference-only'],
  // Value identifiers are append-only. Do not reuse an identifier when retiring a value.
  values: values.map((value, index) => ({ id: `${key}.v${index + 1}`, value, definition: `${fieldLabels[key]}采用“${value}”的视觉表现`, aliases: fieldAliases[key]?.[value] || [], weight: optionWeights[key]?.[value] || 1 })),
  exclusions: '原文否定保留；同字段肯定与排除相撞时要求澄清，禁止静默选择',
  range: key === 'age' ? '1..99 integer or inclusive min-max; explicit range precedes random sample' : 'catalog values or evidence-backed bounded custom string',
  conflicts: key === 'facial_hair' ? '无胡须与留胡须互斥；未成年默认不随机胡须；明确条件不按性别删除' : key === 'hair_length' ? '光头与刘海、分发互斥' : '同字段矛盾及显式排除不得被随机覆盖',
  sampling: key === 'facial_hair' ? '默认女性或16岁以下不随机增加胡须；成人男性按产品权重；明确要求优先' : '权重来自产品策略，不来自人口比例或数据集频率',
  promptTarget: identityFields.includes(key) ? 'compileAvatar.structure' : 'compileAvatar.style-or-explicit-feature',
} ]));
export const catalogNonAdoption = ['ethnicity', 'attractiveness-score', 'dataset-identities', 'dataset-images', 'dataset-annotations', 'training-weights'];
export const seedGuarantee = 'Only the same rule/catalog versions and complete saved sampling context can reproduce DNA. Historical snapshots are restored without sampling. No cross-version seed or image pixel guarantee.';
