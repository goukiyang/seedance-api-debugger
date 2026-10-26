export type ResultMenuPointer = {
  pointerId: number;
  pointerType: string;
  button: number;
  ctrlKey: boolean;
  clientX: number;
  clientY: number;
  timeStamp: number;
};

type ResultMenuClick = Pick<ResultMenuPointer, 'button' | 'clientX' | 'clientY' | 'timeStamp'> & {
  detail: number;
  pointerId?: number;
  pointerType?: string;
};

export function resultMenuKeyboardPoint(rect: { left: number; top: number; width: number; height: number }) {
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
}

export function isResultMenuOpen(openingIdentity: string | null, currentIdentity: string, active: boolean) {
  return active && openingIdentity === currentIdentity;
}

export function canRestoreResultMenuFocus(state: {
  openingIdentity: string | null;
  currentIdentity: string;
  active: boolean;
  connected: boolean;
  transferFocus: boolean;
  open: boolean;
}) {
  return state.connected && state.active && !state.open && !state.transferFocus
    && state.openingIdentity === state.currentIdentity;
}

// Radix owns the 700ms timer. This tracks only the physical gesture that may
// produce a compatibility click after its menu has opened.
export function createResultMenuGesture() {
  let press: ResultMenuPointer | null = null;
  let suppressed: ResultMenuPointer | null = null;
  let suppressedDoubleClick: ResultMenuPointer | null = null;
  function matches(ticket: ResultMenuPointer | null, event: ResultMenuClick) {
    if (!ticket || event.detail === 0 || event.button !== 0) return false;
    const elapsed = event.timeStamp - ticket.timeStamp;
    if (elapsed < 0 || elapsed > 1200) return false;
    if (event.pointerType && event.pointerType !== ticket.pointerType) return false;
    if (event.pointerId !== undefined && event.pointerId !== ticket.pointerId) return false;
    return Math.abs(event.clientX - ticket.clientX) <= 20 && Math.abs(event.clientY - ticket.clientY) <= 20;
  }
  return {
    pointerDown(event: ResultMenuPointer) {
      suppressed = null;
      suppressedDoubleClick = null;
      press = event.button === 0 && (event.pointerType !== 'mouse' || event.ctrlKey) ? { ...event } : null;
    },
    menuOpened() {
      if (press) suppressed = { ...press };
    },
    pointerUp(event: Pick<ResultMenuPointer, 'pointerId' | 'timeStamp'>) {
      if (suppressed?.pointerId === event.pointerId) suppressed.timeStamp = event.timeStamp;
      if (press?.pointerId === event.pointerId) press = null;
    },
    cancelPending() {
      const pending = press;
      press = null;
      return pending;
    },
    consumeClick(event: ResultMenuClick) {
      const ticket = suppressed;
      suppressed = null;
      const consumed = matches(ticket, event);
      suppressedDoubleClick = consumed && ticket ? { ...ticket, timeStamp: event.timeStamp } : null;
      return consumed;
    },
    consumeDoubleClick(event: ResultMenuClick) {
      const ticket = suppressedDoubleClick;
      suppressedDoubleClick = null;
      return matches(ticket, event);
    },
    reset() { press = null; suppressed = null; suppressedDoubleClick = null; },
  };
}
