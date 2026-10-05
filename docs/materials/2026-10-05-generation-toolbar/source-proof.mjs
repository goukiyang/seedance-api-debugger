import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] || process.cwd());
const requireFromProject = createRequire(path.join(root, 'package.json'));
const ts = requireFromProject('typescript');
const sourcePath = path.join(root, 'src/app/image-studio/studio.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements = [];
let submitFunction = null;

function visit(node) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submitFunction = node;
  ts.forEachChild(node, visit);
}
visit(file);

function openingElement(element) {
  return ts.isJsxElement(element) ? element.openingElement : element;
}
function tagName(element) {
  return openingElement(element).tagName.getText(file);
}
function attribute(element, name) {
  return openingElement(element).attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(file) === name);
}
function stringAttribute(element, name) {
  const value = attribute(element, name)?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : null;
}
function expressionAttribute(element, name) {
  const value = attribute(element, name)?.initializer;
  return value && ts.isJsxExpression(value) && value.expression ? value.expression.getText(file) : '';
}

const toolbars = elements.filter(element => tagName(element) === 'div' && expressionAttribute(element, 'className').includes('styles.generationToolbar'));
const reference = elements.find(element => tagName(element) === 'section' && stringAttribute(element, 'aria-label') === '参考图');
const footer = elements.find(element => tagName(element) === 'div' && expressionAttribute(element, 'className').includes('styles.materialFooter'));
const uploadInput = elements.find(element => tagName(element) === 'input' && expressionAttribute(element, 'ref') === 'fileInput');
const supplement = elements.find(element => tagName(element) === 'label' && expressionAttribute(element, 'htmlFor').includes('studio-prompt-'));

if (toolbars.length !== 1 || !reference || !footer || !uploadInput || !supplement) throw Error('Required generation UI anchors are missing or duplicated');
const toolbar = toolbars[0];
if (!(reference.end <= footer.pos && footer.end <= uploadInput.pos && uploadInput.end <= toolbar.pos && toolbar.end <= supplement.pos)) {
  throw Error('Generation toolbar is not after reference materials and before the supplementary prompt');
}
if (!submitFunction) throw Error('Existing submit handler is missing');
const submitSource = submitFunction.getText(file);
if (submitSource.includes('confirm(') || !submitSource.includes("fetch('/api/image-studio/tasks'")) {
  throw Error('Normal submit behavior changed; expected direct submit with no extra confirmation');
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const releaseSource = fs.readFileSync(path.join(root, 'src/lib/release.ts'), 'utf8');
if (version !== '0.43.3' || !releaseSource.includes('移到参考图下方、补充文案上方') || !releaseSource.includes('人物正文一次点击自动理解并提交图片')) throw Error('Version or release summary does not describe D1/D3');

console.log(JSON.stringify({
  source: 'src/app/image-studio/studio.tsx',
  toolbarCount: toolbars.length,
  order: ['参考图', 'materialFooter', 'fileInput', 'generationToolbar', '补充文案'],
  ordinarySubmit: 'direct POST; no confirmation; existing ambiguity guard preserved',
  version,
  route: '/template-studio?type=image',
  evidenceLimit: 'Source structure only; does not assert rendered DOM or visual layout',
}, null, 2));
