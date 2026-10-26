import assert from 'node:assert/strict';
import { canRestoreResultMenuFocus, createResultMenuGesture, isResultMenuOpen, resultMenuKeyboardPoint } from '../src/components/result-image-context-menu-interaction';

// Pure event contracts. No browser, business request, React fixture or fee.
const point = resultMenuKeyboardPoint({ left: 310, top: 140, width: 184, height: 96 });
assert.ok(point.clientX > 310 && point.clientX < 494);
assert.ok(point.clientY > 140 && point.clientY < 236);
assert.notDeepEqual(point, { clientX: 0, clientY: 0 });

const gesture = createResultMenuGesture();
const touch = { pointerId: 7, pointerType: 'touch', button: 0, ctrlKey: false, clientX: 360, clientY: 175, timeStamp: 100 };
const releaseClick = { ...touch, detail: 1, timeStamp: 1100 };
gesture.pointerDown(touch);
gesture.menuOpened();
gesture.pointerUp({ pointerId: 7, timeStamp: 1090 });
assert.equal(gesture.consumeClick(releaseClick), true, 'the long-press release must not open a preview');
assert.equal(gesture.consumeDoubleClick({ ...releaseClick, detail: 2, timeStamp: 1110 }), true, 'a derived double click cannot trigger quick use');
assert.equal(gesture.consumeClick(releaseClick), false, 'the gesture consumes at most its own click');

gesture.pointerDown(touch);
assert.equal(gesture.cancelPending()?.pointerId, 7, 'scroll cancellation supplies the pointer Radix needs to cancel');
gesture.menuOpened();
assert.equal(gesture.consumeClick(releaseClick), false, 'a canceled long press does not suppress a normal click');

gesture.pointerDown(touch);
gesture.menuOpened();
gesture.pointerDown({ ...touch, timeStamp: 1800 });
assert.equal(gesture.consumeClick({ ...releaseClick, timeStamp: 1850 }), false, 'a later physical press starts a normal click');

gesture.pointerDown({ ...touch, pointerType: 'mouse', ctrlKey: true });
gesture.menuOpened();
gesture.pointerUp({ pointerId: 7, timeStamp: 200 });
assert.equal(gesture.consumeClick({ ...releaseClick, pointerType: 'mouse', timeStamp: 210 }), true, 'Control-click opens only the menu');

gesture.pointerDown(touch);
gesture.menuOpened();
assert.equal(gesture.consumeClick({ ...releaseClick, detail: 0 }), false, 'keyboard activation is unrelated to a touch release');
gesture.pointerDown(touch);
gesture.menuOpened();
assert.equal(gesture.consumeClick({ ...releaseClick, pointerId: 8 }), false, 'a different physical pointer is not swallowed');
gesture.pointerDown(touch);
gesture.menuOpened();
assert.equal(gesture.consumeClick({ ...releaseClick, timeStamp: 5000 }), false, 'a stale click ticket cannot swallow a later normal click');
gesture.reset();
assert.equal(gesture.cancelPending(), null);

const focus = { openingIdentity: 'account:a/result:1/content:1', currentIdentity: 'account:a/result:1/content:1',
  active: true, connected: true, transferFocus: false, open: false };
assert.equal(isResultMenuOpen(focus.openingIdentity, focus.currentIdentity, true), true);
assert.equal(isResultMenuOpen(focus.openingIdentity, 'account:a/result:2/content:1', true), false, 'changing result closes the old object immediately');
assert.equal(isResultMenuOpen(focus.openingIdentity, focus.currentIdentity, false), false, 'deactivating a card closes its menu');
assert.equal(isResultMenuOpen(null, focus.currentIdentity, true), false, 'a removed object leaves no open menu');
assert.equal(canRestoreResultMenuFocus(focus), true);
assert.equal(canRestoreResultMenuFocus({ ...focus, transferFocus: true }), false, 'preview/dialog takes focus after a selected command');
assert.equal(canRestoreResultMenuFocus({ ...focus, currentIdentity: 'account:b/result:1/content:1' }), false, 'account/identity change invalidates focus return');
assert.equal(canRestoreResultMenuFocus({ ...focus, active: false }), false);
assert.equal(canRestoreResultMenuFocus({ ...focus, connected: false }), false);
assert.equal(canRestoreResultMenuFocus({ ...focus, open: true }), false, 'a delayed close must not steal focus from a reopened menu');

console.log('Result image context menu offline event contracts complete');
