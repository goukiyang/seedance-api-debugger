import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (path: string) => readFileSync(path, 'utf8');
const shellPath = 'src/components/template-studio/TemplateStudioShell.tsx';
const shellText = read(shellPath);
const shell = ts.createSourceFile(shellPath, shellText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function descendants<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function jsxName(node: ts.JsxTagNameExpression) {
  return ts.isIdentifier(node) ? node.text : node.getText(shell);
}

function jsxText(node: ts.Node): string {
  if (ts.isJsxText(node)) return node.text;
  let text = '';
  ts.forEachChild(node, child => { text += ` ${jsxText(child)}`; });
  return text;
}

function containsNode(root: ts.Node, target: ts.Node): boolean {
  if (root === target) return true;
  let found = false;
  ts.forEachChild(root, child => { if (containsNode(child, target)) found = true; });
  return found;
}

function isVideoGuard(node: ts.Node): boolean {
  return ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && node.left.getText(shell) === 'activeType'
    && ts.isStringLiteral(node.right)
    && node.right.text === 'video';
}

function hasConditionalAncestor(node: ts.Node, predicate: (condition: ts.Node) => boolean): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && predicate(current.left)
      && containsNode(current.right, node)) return true;
  }
  return false;
}

type JsxComponent = ts.JsxElement | ts.JsxSelfClosingElement;
function isJsxComponent(node: ts.Node): node is JsxComponent {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}
function componentName(node: JsxComponent) {
  return jsxName(ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName);
}
function jsxAttribute(node: JsxComponent, name: string): ts.JsxAttribute | undefined {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  return attributes.properties.find((property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && property.name.getText(shell) === name);
}

const favoritesButtons = descendants(shell, (node): node is ts.JsxElement =>
  ts.isJsxElement(node)
  && jsxName(node.openingElement.tagName) === 'button'
  && jsxText(node).includes('我的喜欢'));
assert.equal(favoritesButtons.length, 1, 'shell has one unique favorites button');
const videoFavoritesButton = favoritesButtons[0];
assert.ok(hasConditionalAncestor(videoFavoritesButton, isVideoGuard), 'favorites button is rendered only for video');
assert.equal(jsxAttribute(videoFavoritesButton, 'aria-expanded')?.initializer?.getText(shell), '{videoFavoritesOpen}');
assert.match(jsxAttribute(videoFavoritesButton, 'onClick')?.initializer?.getText(shell) || '', /setVideoFavoritesOpen\(current\s*=>\s*!current\)/);
assert.ok(!shellText.includes('StudioBatchHistory'), 'duplicate shell batch history is removed');
assert.ok(!shellText.includes('favoritesRequest'), 'image favorites proxy state and prop wiring are removed');

const favoriteList = descendants(shell, (node): node is JsxComponent =>
  isJsxComponent(node) && componentName(node) === 'TemplateFavoritesList');
assert.equal(favoriteList.length, 1, 'video favorites list remains unique');
assert.ok(hasConditionalAncestor(favoriteList[0], node =>
  node.getText(node.getSourceFile()) === "activeType === 'video' && videoFavoritesOpen"), 'favorites list remains gated by video and open state');
assert.match(shellText, /useTemplateFavorites\(userId,\s*activeType === 'video' && videoFavoritesOpen\)/);
assert.match(shellText, /target\.origin === window\.location\.origin/);
assert.match(shellText, /router\.push\(target\.pathname \+ target\.search\)/);

for (const marker of [
  'permissionMismatch', 'allowedTypes.includes(requestedType)', 'userChanged', 'styles.sessionGate',
  'readRememberedLocation(userId)', 'writeRememberedLocation(userId, stored)',
  'restoreAttemptedFor.current = userId', 'clearRememberedLocation', 'allowedTypes.map((type)',
]) assert.ok(shellText.includes(marker), `session, permission, or restore guard remains: ${marker}`);
assert.match(shellText, /<ImageStudio\s+key=\{userId\}\s+isAdmin=\{isAdmin\}\s+userId=\{userId\}\s+templateWorkbench\s*\/>/);

const imageStudio = read('src/app/image-studio/studio.tsx');
assert.match(imageStudio, /favoritesRequest\s*=\s*0/);
assert.match(imageStudio, /favoritesRequest\?: number/);
assert.match(imageStudio, /get\('favorites'\)\s*===\s*'1'/);
assert.match(imageStudio, /setFavoritesExpanded\(true\)/);
assert.equal(imageStudio.match(/<TemplateFavoritesList\b/g)?.length, 2, 'image favorites remain in desktop and narrow navigation');

const assetsPath = 'src/app/assets/page.tsx';
const assetsText = read(assetsPath);
const assets = ts.createSourceFile(assetsPath, assetsText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const batchEntrypoints = descendants(assets, (node): node is JsxComponent =>
  isJsxComponent(node) && componentName(node) === 'StudioBatchHistory');
assert.equal(batchEntrypoints.length, 1, 'assets page retains one full batch-history entrypoint');
const batchEntry = batchEntrypoints[0];
assert.ok(hasConditionalAncestor(batchEntry, node => /user\s*&&\s*canUseCompanyTemplates\(/.test(node.getText(node.getSourceFile()))), 'assets batch entry keeps its existing account permission gate');
assert.match(batchEntry.getText(assets), /userId=\{user\.id\}/);
assert.match(batchEntry.getText(assets), /initialId=\{params\.get\('imageBatchId'\) \|\| undefined\}/);
assert.match(assetsText, /import \{ StudioBatchHistory \} from '@\/app\/image-studio\/batch-results'/);

const batchPath = 'src/app/image-studio/batch-results.tsx';
const batchText = read(batchPath);
assert.match(batchText, /export function StudioBatchHistory\(\{ userId, initialId \}/);
assert.match(batchText, /initialId && \/\^\[a-f0-9\]\{64\}\$\/\.test\(initialId\)\) \{ setId\(initialId\); setOpen\(true\); \}/);
assert.match(batchText, /href=\{`\/assets\?imageBatchId=\$\{encodeURIComponent\(id\)\}`\}/);
assert.match(batchText, /new URLSearchParams\(\{ batchId: id \}\)/);

console.log('PASS UI40-03 shell AST keeps favorites video-only and preserves session/permission/restore, image favorites deep link, and assets batch identity/deep link');
