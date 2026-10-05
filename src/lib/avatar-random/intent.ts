import { catalog, fieldLabels } from './catalog';
import type { AvatarConstraints, AvatarField, AvatarRules } from './types';

export function intentIssues(constraints: AvatarConstraints) {
  const conflicts: string[] = [];
  for(const fields of [constraints.explicit,...constraints.members?.map(member=>({...constraints.explicit,...member.explicit}))||[]]) {
    if(fields.hair_length?.value==='光头'&&['bangs','parting'].some(key=>fields[key]?.value&&!['不适用','无刘海'].includes(fields[key].value)))conflicts.push('光头与刘海或分发要求冲突，请选择保留哪一项');
    for(const [key,field] of Object.entries(fields))if(field.value&&field.excluded?.includes(field.value))conflicts.push(`${fieldLabels[key]}同时要求和排除“${field.value}”，请明确保留哪一项`);
  }
  for(const member of constraints.members||[])for(const [key,field] of Object.entries(member.explicit)) {
    const common=constraints.explicit[key];
    if(common?.value&&field.value&&common.value!==field.value||common?.excluded?.includes(field.value)||field.excluded?.includes(common?.value||''))conflicts.push(`共同${fieldLabels[key]}条件与某一位人物的要求冲突，请调整描述`);
  }
  // Classification gaps are not contradictory user requirements.
  return Array.from(new Set(conflicts));
}
export function intentView(constraints: AvatarConstraints) {
  const fields = Object.entries(constraints.explicit).map(([key, field]) => `${fieldLabels[key]}：${field.value || '不限'}${field.excluded?.length ? `；排除${field.excluded.join('、')}` : ''}`);
  const members = constraints.members?.flatMap((member, index) => Object.entries(member.explicit).map(([key, field]) => `第${index + 1}位${fieldLabels[key]}：${field.value || '不限'}${field.excluded?.length ? `；排除${field.excluded.join('、')}` : ''}`)) || [];
  const scopeLabels: Record<string, string> = { ordinary: '日常自然', office: '职场方向', protagonist: '有主角感', family: '家庭合影方向' };
  return {
    summary: constraints.summary || '已保留原描述中可确认的条件。',
    explicit: [...fields, ...constraints.details.map(detail => detail.value), ...members, ...(constraints.background ? [`背景：${constraints.background}`] : [])],
    soft: [...Object.entries(constraints.soft || {}).map(([key, field]) => `${fieldLabels[key]}：${field.value}`), ...constraints.scopes.map(scope => scopeLabels[scope] || scope)],
    randomizable: Object.keys(catalog).filter(key => !constraints.explicit[key]?.value && !constraints.members?.some(member => member.explicit[key]?.value)).map(key => fieldLabels[key]),
    issues: intentIssues(constraints),
  };
}
export function effectiveConditions(constraints: AvatarConstraints, rules: AvatarRules) {
  return Object.keys(catalog).flatMap(key=>{
    let explicit:AvatarField|undefined=constraints.explicit[key];const choice=rules.choices[key];
    if(explicit&&choice&&explicit.value!==choice&&rules.choiceSources?.[key]!=='config'&&(rules.choiceEditedAt?.[key]||0)>(rules.descriptionEditedAt||0))explicit=undefined;
    const value=explicit?.value||(choice&&rules.choiceSources?.[key]!=='config'?choice:rules.locks[key]?.value||choice);
    const excluded=explicit?.excluded||[];
    return value||excluded.length?[`${fieldLabels[key]}：${value||'允许随机'}${excluded.length?`；排除${excluded.join('、')}`:''}`]:[];
  });
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, ordered(val)]));
  return value;
}
// Quotes bind to effective inputs, not UI tabs, selected thumbnails or timestamps.
export function avatarRulesSignature(rules: AvatarRules, includeLayout = true) {
  const { description, choices, locks, intensity, choiceSources, choiceEditedAt, descriptionEditedAt, people, candidates, layout } = rules;
  const activeChoices = Object.fromEntries(Object.entries(choices).filter(([, value]) => value));
  const activeSources = Object.fromEntries(Object.keys(activeChoices).map(key => [key, choiceSources?.[key] || 'user']));
  const activeTimes = Object.fromEntries(Object.keys(activeChoices).map(key => [key, choiceEditedAt?.[key] || 0]));
  return JSON.stringify(ordered({ description: description.trim(), choices: activeChoices, locks, intensity, choiceSources: activeSources, choiceEditedAt: activeTimes, descriptionEditedAt: descriptionEditedAt || 0, ...(includeLayout ? { people, candidates, layout: layout || 'independent' } : {}) }));
}
