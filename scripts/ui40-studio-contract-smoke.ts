import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = (file: string) => readFileSync(file, 'utf8');
const file = 'src/app/image-studio/studio.tsx', text = read(file);
const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes<T extends ts.Node>(node: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(child: ts.Node) { if (predicate(child)) result.push(child); ts.forEachChild(child, visit); }
  visit(node); return result;
}
const declaration = (name: string) => nodes(ast, ts.isVariableDeclaration).find(node => node.name.getText(ast) === name)!;
const functions = ['toggleImageSection', 'toggleModuleGroup', 'resetSidebarExpansion'];
const code = functions.map(name => `const ${name} = ${declaration(name).initializer!.getText(ast)}; this.${name}=${name};`).join('\n');
const state: any = { sidebarInteraction: { current: 0 }, expanded: ['A'], image: true, favorites: true, favorite: 'saved',
  setExpandedGroups(fn: any) { state.expanded = typeof fn === 'function' ? fn(state.expanded) : fn; },
  setImageGenerationExpanded(fn: any) { state.image = typeof fn === 'function' ? fn(state.image) : fn; },
  setFavoritesExpanded(value: any) { state.favorites = value; }, setSelectedFavorite(value: any) { state.favorite = value; } };
runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state);
state.toggleModuleGroup('B'); assert.deepEqual(Array.from(state.expanded), ['A', 'B']);
state.toggleModuleGroup('A'); assert.deepEqual(Array.from(state.expanded), ['B']);
state.toggleImageSection(); assert.equal(state.image, false); assert.equal(state.sidebarInteraction.current, 3);
state.resetSidebarExpansion(); assert.deepEqual(Array.from(state.expanded), []); assert.equal(state.favorites, false);
assert.ok(!/navigateToModule|replaceImageModuleLocation|markViewed|setRequestedView/.test(code), 'fold/reset handlers cannot navigate or write receipts');
console.log('PASS real fold handlers independently preserve siblings, only fold and invalidate pending auto-expansion');

const attributes = (node: ts.JsxElement) => node.openingElement.attributes.properties.filter(ts.isJsxAttribute);
const attr = (node: ts.JsxElement, name: string) => attributes(node).find(attribute => attribute.name.getText(ast) === name)?.initializer?.getText(ast) || '';
const buttons = nodes(ast, ts.isJsxElement).filter(node => node.openingElement.tagName.getText(ast) === 'button');
const groupButton = buttons.find(node => attr(node, 'className').includes('styles.moduleRailGroupTitle'))!;
assert.equal(attr(groupButton, 'onClick'), '{() => toggleModuleGroup(group)}');
assert.equal(attr(groupButton, 'aria-expanded'), '{expanded}'); assert.equal(attr(groupButton, 'disabled'), '{!items.length}');
assert.match(attr(groupButton, 'className'), /!coverView && items.some\(item => item.id === active\)/);
assert.ok(!attr(groupButton, 'className').includes('selectedGroup === group'), 'group indicator follows the actual active template, not a filter');
const groupName = nodes(groupButton, ts.isJsxElement).find(node => attr(node, 'title') === '{group}');
assert.ok(groupName, 'truncated group names keep their full title');
for (const button of buttons.filter(node => attr(node, 'className') === '{styles.moduleRailMajorLink}' || attr(node, 'className') === '{styles.mobileMajorLink}')) {
  assert.ok(!attr(button, 'onClick').includes('navigate'), 'major controls only fold');
}
assert.ok(!text.includes('navigateToImageSection'));
const lateBranch = nodes(ast, ts.isIfStatement).find(node => node.expression.getText(ast) === 'pendingModuleScroll.expansionRevision === sidebarInteraction.current')!;
assert.ok(lateBranch, 'late hydration must honor the user fold revision');
const expandCalls = nodes(lateBranch.thenStatement, ts.isCallExpression).map(node => node.expression.getText(ast));
assert.ok(expandCalls.includes('setExpandedGroups') && expandCalls.includes('setImageGenerationExpanded'));
assert.match(text, /expandParents: sidebarInteraction.current === 0/);
assert.match(text, /if \(routedContentHandled.current === routeKey\) return/);
assert.match(text, /storage.setItem\(viewStorageKey, JSON.stringify/);
assert.match(text, /expandedGroups, imageGenerationExpanded, favoritesExpanded, selectedFavorite/);
console.log('PASS actual row AST/deep-link one-shot guard, late catalog fold protection and existing account preference fields');

const pruneEffect = nodes(ast, ts.isCallExpression).find(node => node.expression.getText(ast) === 'useEffect'
  && node.arguments[0]?.getText(ast).includes('const available = new Set(Object.keys(groupedModules))'))!;
assert.ok(pruneEffect, 'expanded preferences are validated only against the completed directory');
const prune: any = { viewRestored: true, directoryReady: false, loading: false, groupedModules: { A: [], B: [] },
  current: ['A', 'Deleted'], setExpandedGroups(fn: any) { prune.current = fn(prune.current); } };
runInNewContext(ts.transpileModule(`this.prune = ${pruneEffect.arguments[0].getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, prune);
prune.prune(); assert.deepEqual(Array.from(prune.current), ['A', 'Deleted'], 'failed/incomplete catalogs cannot erase preferences');
prune.directoryReady = true; prune.loading = true; prune.prune();
assert.deepEqual(Array.from(prune.current), ['A', 'Deleted'], 'in-flight catalogs cannot erase preferences');
prune.loading = false; prune.prune(); assert.deepEqual(Array.from(prune.current), ['A']);
const same = prune.current; prune.prune(); assert.equal(prune.current, same, 'valid preferences do not cause repeated updates');
assert.match(text, /if \(Array.isArray\(data.directory\)\) \{[\s\S]*?setDirectoryReady\(true\)/);
console.log('PASS actual completed-directory pruning preserves failed/in-flight restoration and removes only missing groups');

const sections = nodes(ast, ts.isJsxElement).filter(node => node.openingElement.tagName.getText(ast) === 'section');
const styleSection = sections.find(node => attr(node, 'aria-label') === '"风格组与文字 skills"')!;
const referenceSection = sections.find(node => attr(node, 'aria-label') === '"参考图"')!;
const tags = (node: ts.Node) => nodes(node, ts.isJsxSelfClosingElement).map(child => child.tagName.getText(ast));
assert.ok(tags(styleSection).includes('StudioSkills') && tags(styleSection).includes('StudioStyleGroups'));
assert.ok(!tags(referenceSection).includes('StudioSkills'));
assert.ok(!text.includes('等待自动保存') && !text.includes('设置未保存') && !text.includes('上下文未保存') && !text.includes('生成参数为临时草稿'));
assert.match(text, /moduleSaveError && <p role="alert"/); assert.match(text, /重试保存/);
assert.match(text, /useUnsavedNavigation\(dirty \|\| automaticDirty/);
assert.match(text, /资产库的“我的批次”/);
const css = read('src/app/image-studio/studio.module.css');
for (const [group, desktop, narrow] of [['primaryMaterials', 128, 112], ['styleMaterials', 96, 88], ['auxiliaryMaterials', 72, 64]]) {
  assert.ok(css.includes(`.${group} { --material-tile-size: ${desktop}px;`)); assert.ok(css.includes(`.${group} { --material-tile-size: ${narrow}px;`));
}
assert.ok(!css.includes('.materialSection > div,') && !css.includes('.deleteResult'));
for (const selector of ['.page .moduleRail button', '.page .moduleRailGroup button', '.page .mobileModuleNav button']) {
  const rules = css.split('}').filter(rule => rule.includes(selector));
  assert.ok(rules.length && rules.every(rule => rule.includes(`${selector}:where(:not([data-reaction-action]))`)), `${selector} must exclude reaction buttons`);
}
for (const [className, height, size] of [['moduleRailMajorLink', 40, 14], ['moduleRailGroupTitle', 36, 13], ['moduleRailChild', 32, 12]]) {
  assert.match(css, new RegExp(`\\.${className} \\{[^}]*height: ${height}px;[^}]*font-size: ${size}px;`));
}
console.log('PASS REF39 category grouping/three fixed sizes, scoped alignment, hierarchy and removal-only dirty display');

const base = 'd0e8a84a2a32f0e2a9b27ffac686086aaa108fb4';
function functionBody(source: string, name: string) {
  const parsed = ts.createSourceFile('input.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return nodes(parsed, ts.isFunctionDeclaration).find(node => node.name?.text === name)?.getText(parsed)
    || nodes(parsed, ts.isVariableDeclaration).find(node => node.name.getText(parsed) === name)?.getText(parsed);
}
for (const [sourcePath, names] of [
  [file, ['saveModule', 'saveModuleSettings', 'closeModuleDialog', 'addImages', 'deleteResult', 'deleteModule', 'restoreTask', 'submit']],
  ['src/components/content-reactions/ContentReactions.tsx', ['writeReaction', 'confirmed', 'act', 'flush', 'update']],
] as Array<[string, string[]]>) {
  const previous = execFileSync('git', ['show', `${base}:${sourcePath}`], { encoding: 'utf8' });
  for (const name of names) {
    const before = functionBody(previous, name), after = functionBody(read(sourcePath), name);
    assert.ok(before, `existing guard function ${name} must be found`); assert.equal(after, before, `business/permission/save guard ${name} cannot drift`);
  }
}
for (const unchanged of ['src/components/content-reactions/LikeButton.tsx', 'public/tools/ultimate-canvas/like-button.css', 'src/app/image-studio/template-favorites.tsx', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/worker.ts']) {
  assert.equal(read(unchanged), execFileSync('git', ['show', `${base}:${unchanged}`], { encoding: 'utf8' }), `${unchanged} is protected`);
}
console.log('PASS actual saved/revision/submission/unknown/like mutation/worker guards match deployed d0; no business or browser acceptance');
