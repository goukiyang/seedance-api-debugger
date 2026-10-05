export const catalog: Record<string, string[]> = {
  gender: ['女性', '男性'], age: ['22', '27', '32', '38', '45', '55', '65'], body_type: ['匀称', '偏瘦', '结实'], temperament: ['自然沉稳', '温和', '爽朗', '冷静'],
  face_shape: ['椭圆脸', '圆脸', '方脸', '长脸', '心形脸'], face_width: ['中等宽度', '略窄', '略宽'], face_length: ['中等长度', '略长', '略短'], cheekbone: ['自然颧骨', '略高颧骨'], jaw: ['柔和下颌', '清晰下颌'], chin: ['圆润下巴', '略尖下巴', '宽下巴'],
  eye_shape: ['杏眼', '细长眼', '圆眼'], eye_size: ['中等眼睛', '略小眼睛', '略大眼睛'], eye_spacing: ['自然眼距', '略宽眼距'], eye_angle: ['平直眼角', '微上扬眼角'], eyebrow_shape: ['平眉', '自然弯眉', '略扬眉'], eyebrow_thickness: ['自然眉毛', '细眉', '浓眉'],
  nose_length: ['中等鼻长', '略短鼻'], nose_bridge_height: ['自然鼻梁', '略高鼻梁', '较低鼻梁'], nose_width: ['中等鼻宽', '略宽鼻翼'], nose_tip: ['圆润鼻尖', '清晰鼻尖'], mouth_width: ['中等嘴宽', '略宽嘴'], upper_lip: ['自然上唇', '薄上唇'], lower_lip: ['自然下唇', '略厚下唇'], mouth_corner: ['平静嘴角', '微微上扬嘴角'],
  skin_tone: ['自然中等肤色', '浅肤色', '小麦肤色', '深肤色'], skin_temperature: ['中性肤色', '暖肤色', '冷肤色'], skin_detail: ['自然皮肤纹理', '轻微毛孔'],
  hair_length: ['短发', '中长发', '长发', '光头'], hair_shape: ['整齐自然发型', '蓬松发型', '微卷发型'], hair_texture: ['直发', '微卷'], hair_color: ['黑发', '深棕发', '棕发'], bangs: ['无刘海', '轻薄刘海'], parting: ['自然侧分', '中分'],
  glasses: ['不戴眼镜', '黑框眼镜', '细框眼镜'], feature: ['无明显标记', '少量雀斑', '左侧脸颊小痣', '自然酒窝', '右眉浅旧伤'], accessory: ['无饰品', '小耳钉', '细项链', '手表'], expression: ['放松自然表情', '轻微微笑', '平静专注表情'], clothing: ['简洁日常衣服', '素色衬衫', '简洁针织衫'],
  facial_hair: ['无胡须', '淡胡茬', '短络腮胡', '上唇小胡子', '山羊胡'],
};
export const AVATAR_CATALOG_VERSION = '1.1.0';
export const optionWeights: Record<string, Record<string, number>> = { hair_color: { 黑发: 2 }, glasses: { 不戴眼镜: 2 }, feature: { 无明显标记: 2 }, accessory: { 无饰品: 2 }, facial_hair: { 无胡须: 6, 淡胡茬: 2 } };
export function weightedCatalogPool(key: string) { return catalog[key].flatMap(value => Array(optionWeights[key]?.[value] || 1).fill(value) as string[]); }
export const fieldAliases: Record<string, Record<string, string[]>> = {
  gender: { 女性: ['女', '女生', '女人'], 男性: ['男', '男生', '男人'] },
  glasses: { 不戴眼镜: ['无眼镜', '不带眼镜', '不要眼镜'], 黑框眼镜: ['黑色框眼镜'], 细框眼镜: ['细边眼镜'] },
  facial_hair: { 无胡须: ['没胡子', '没有胡须', '不要胡须', '不留胡子', '刮干净胡须'], 淡胡茬: ['胡茬', '短胡茬'], 短络腮胡: ['络腮胡'], 上唇小胡子: ['小胡子', '八字胡'], 山羊胡: ['下巴胡须'] },
};
export function normalizeCatalogValue(key: string, value: string) { return Object.entries(fieldAliases[key] || {}).find(([canonical, aliases]) => canonical === value || aliases.includes(value))?.[0] || value; }
export function normalizeCatalogExclusions(key: string, values: string[]) {
  return Array.from(new Set(values.flatMap(value => key === 'facial_hair' && ['胡须', '胡子'].includes(value) ? catalog.facial_hair.filter(v => v !== '无胡须') : key === 'glasses' && value === '眼镜' ? catalog.glasses.filter(v => v !== '不戴眼镜') : [normalizeCatalogValue(key, value)])));
}
export const fieldLabels: Record<string, string> = { gender: '性别', age: '年龄', hair_length: '发型', glasses: '眼镜', feature: '面部特征', accessory: '饰品', face_shape: '脸型', hair_color: '发色', skin_tone: '肤色', temperament: '气质', body_type: '体型', expression: '表情', clothing: '穿着',face_width:'脸部宽度',face_length:'脸部长度',cheekbone:'颧骨',jaw:'下颌',chin:'下巴',eye_shape:'眼型',eye_size:'眼睛大小',eye_spacing:'眼距',eye_angle:'眼角',eyebrow_shape:'眉型',eyebrow_thickness:'眉毛浓淡',nose_length:'鼻长',nose_bridge_height:'鼻梁',nose_width:'鼻宽',nose_tip:'鼻尖',mouth_width:'嘴宽',upper_lip:'上唇',lower_lip:'下唇',mouth_corner:'嘴角',skin_temperature:'肤色冷暖',skin_detail:'皮肤纹理',hair_shape:'发型轮廓',hair_texture:'头发质地',bangs:'刘海',parting:'分发' };
export const quickFields = ['gender', 'age', 'hair_length', 'glasses', 'feature', 'accessory'];
fieldLabels.facial_hair = '胡须';
export const identityFields = Object.keys(catalog).filter(key => !['hair_length', 'hair_shape', 'hair_texture', 'hair_color', 'bangs', 'parting', 'accessory', 'glasses', 'expression', 'clothing', 'facial_hair'].includes(key));
