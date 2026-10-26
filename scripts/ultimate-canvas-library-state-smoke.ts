import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const library = readFileSync('public/tools/ultimate-canvas/document-library.js', 'utf8');
const styles = readFileSync('public/tools/ultimate-canvas/document-library.css', 'utf8');

function functionBody(source: string, signature: string, nextSignature: string) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

const leave = functionBody(library, 'async function leave()', 'async function openDocument(');
const initialCancel = functionBody(library, 'async function cancelInitialSelection(reason)', 'function mutationId()');
const openDocument = functionBody(library, 'async function openDocument(doc, returning)', 'function returnToEditor(');
const mutate = functionBody(library, 'async function mutate(action, doc, title, job)', 'function setDialogBusy(');

assert.match(leave, /options\.beforeLeave\(\)/, 'chooser exits preserve the app save/conflict guard');
assert.match(initialCancel, /options\.onInitialCancel\(\{ reason, projectId \}\)/);
assert.match(initialCancel, /if \(!await leave\(\)\) return false/);
assert.match(initialCancel, /result === false[\s\S]*?return false/);
assert.match(initialCancel, /closeLibraryLayer\(focusTarget\)/);
assert.doesNotMatch(initialCancel, /createDocument\s*\(/, 'cancel never creates a document');
assert.match(openDocument, /if \(!await leave\(\)\) return/);
assert.match(openDocument, /idOf\(current\(\)\) !== idOf\(doc\)/);
assert.match(mutate, /base_revision: doc\.revision/);
assert.match(mutate, /pendingMutations\.get\(attemptKey\)/);

assert.match(library, /document\.addEventListener\('click',[\s\S]*?returnToEditor\('outside'\)/);
assert.match(library, /returnToEditor\('escape'\)/);
assert.match(library, /ui\.close = button\('×', \(\) => returnToEditor\('cancel'\)/);
assert.match(library, /new Intl\.RelativeTimeFormat\('zh-CN'/);
assert.match(library, /aria-describedby/);
assert.match(library, /trigger\.addEventListener\('pointerenter'/);
assert.match(library, /trigger\.addEventListener\('focus'/);
assert.match(library, /trigger\.addEventListener\('click'/);
assert.match(library, /time\.dateTime = date\.toISOString\(\)/);
assert.match(styles, /\.uc-doc-time-bubble\s*\{[^}]*position:\s*fixed/);
assert.match(library, /Only the server-approved thumbnail is used[\s\S]*?doc\.thumbnail_url/);

console.log('ultimate canvas library state smoke passed');
