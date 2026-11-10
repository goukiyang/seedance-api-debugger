import assert from 'node:assert/strict';
import { defaults, generateBatch, parseSettings, textFor, txtFor } from '../src/lib/character-fusion/engine';
import { BODY_CARDS, bodyCombination, catalogueCards, updateCard } from '../src/lib/character-fusion/body-cards';
import { parseCardDraft } from '../src/lib/character-fusion/cards';

const settings = defaults();
settings.requirementsEnabled = true;
settings.cards = [{ id: 'card-body-head-ratio', title: '头身比', titleEn: 'Head-to-body ratio', joined: true, locked: true, value: '8+头身', tags: [{ label: '8+头身', en: '8 or more head lengths tall', status: 'default' }] }];
const row = generateBatch(settings, 835)[0];
assert(textFor(row, settings).includes('8+头身'));
assert(!textFor(row, settings).includes('2.5头身'), 'Selected body ratio must replace the built-in default ratio in the same prompt');
assert(!textFor(row, { ...settings, lang: 'en' }).includes('2.5 heads tall'));
console.log('PASS: selected body ratio takes precedence over unchanged built-in art direction in both languages.');

const legacy = defaults(), untouched = JSON.stringify(legacy);
assert.equal(catalogueCards(legacy.cards).length, 4);
assert.equal(JSON.stringify(legacy), untouched);
assert.deepEqual(parseSettings(JSON.parse(untouched)), legacy);
assert.equal(bodyCombination([], 'both'), '');
assert.deepEqual(BODY_CARDS.map(card => card.tags.length), [7, 11, 8, 9]);
for (const preset of BODY_CARDS) {
  parseCardDraft(preset);
  for (const tag of preset.tags) {
    const option = defaults();
    option.cards = updateCard(option.cards, preset.id, card => ({ ...card, joined: true, value: tag.label, locked: true }));
    const result = generateBatch(option, 836)[0];
    assert(textFor(result, option).includes(tag.label));
    const english = textFor(result, { ...option, lang: 'en' });
    assert(english.includes(tag.en));
    assert(!/[\u3400-\u9fff]/.test(english));
  }
}
const joined = defaults();
for (const preset of BODY_CARDS) joined.cards = updateCard(joined.cards, preset.id, card => ({ ...card, joined: true, locked: true }));
assert.equal(bodyCombination(joined.cards, 'zh'), '2–3头身 × 圆球型 × 短躯长腿 × 巨掌');
assert(!/[\u3400-\u9fff]/.test(bodyCombination(joined.cards, 'en')));
assert(bodyCombination(joined.cards, 'both').includes('[ENGLISH]'));
assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(joined))).cards, joined.cards);
const lockedRows = generateBatch(joined, 837);
assert(lockedRows.every(result => result.cards?.every(card => joined.cards.find(value => value.id === card.id)?.value === card.label)));
assert(txtFor(lockedRows, joined).includes('短躯长腿'));
joined.cards = joined.cards.map(card => ({ ...card, joined: false }));
assert(generateBatch(joined, 838).every(result => result.cards?.length === 0));
assert.equal(lockedRows[0].cards?.length, 4);

const rules = defaults(), preset = BODY_CARDS[1], must = preset.tags[1].label, excluded = preset.tags[0].label;
rules.cards = updateCard([], preset.id, card => ({ ...card, joined: true, tags: card.tags.map(tag => ({ ...tag, status: tag.label === must ? 'must' : tag.label === excluded ? 'exclude' : 'default' })) }));
const ruledRows = generateBatch(rules, 839);
assert(ruledRows.some(result => result.cards?.[0].label === must));
assert(ruledRows.every(result => result.cards?.[0].label !== excluded));
assert.equal(BODY_CARDS[1].tags[0].status, 'default');
const full = Array.from({ length: 16 }, (_, i) => ({ ...joined.cards[0], id: `card-existing-${i}` }));
const fullBefore = JSON.stringify(full);
assert.equal(catalogueCards(full).length, 20);
assert.throws(() => updateCard(full, BODY_CARDS[0].id, card => ({ ...card, joined: true })), /16/);
assert.equal(JSON.stringify(full), fullBefore);
assert.equal(updateCard(full, full[0].id, card => ({ ...card, joined: true })).length, 16);

const normal = defaults(); normal.requirementsEnabled = true;
const oldRow = generateBatch(normal, 840)[0];
assert(textFor(oldRow, normal).includes('2.5头身'));
assert(textFor(oldRow, { ...normal, lang: 'en' }).includes('2.5 heads tall'));
const custom = { ...settings, requirements: '自定义画风，2.5头身。', requirementsEn: 'Custom art direction, 2.5 heads tall.' };
assert(textFor(row, custom).includes(custom.requirements));
assert(textFor(row, { ...custom, lang: 'en' }).includes(custom.requirementsEn));
console.log('PASS: 35 bilingual choices; optional catalogue; immutable lazy join; locked generation; required/excluded rules; recipe roundtrip; prompt/export/combination copy; remove preserves old rows; 16-card capacity; old/custom art direction unchanged. No network, database or paid calls.');
