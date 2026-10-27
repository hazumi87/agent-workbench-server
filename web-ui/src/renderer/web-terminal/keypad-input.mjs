// P07 sends through the existing terminal input path. No commands, queue,
// reconnect retry or keyboard-lease acquisition lives in this component.
const FIXED = Object.freeze({ escape: '\x1b', tab: '\t', interrupt: '\x03' });
const ARROWS = Object.freeze({ up: 'A', down: 'B', right: 'C', left: 'D' });
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

export function createKeypadSender({ current, controlling, applicationCursor, send } = {}) {
  let disposed = false, control = false;
  const ready = () => {
    try { return !disposed && current?.() === true && controlling?.() === true && typeof send === 'function'; }
    catch { return false; }
  };
  const emit = (bytes) => { try { return send(bytes) !== false; } catch { return false; } };
  return {
    get control() { return control; },
    reset() { control = false; },
    press(key, event) {
      if (event?.isTrusted !== true || event?.type !== 'click' || event.repeat === true || typeof key !== 'string') return false;
      if (key !== 'control' && !own(FIXED, key) && !own(ARROWS, key)) return false;
      if (!ready()) { control = false; return false; }
      if (key === 'control') { control = !control; return true; }
      control = false;
      try {
        const bytes = own(FIXED, key) ? FIXED[key] : '\x1b' + (applicationCursor?.() === true ? 'O' : '[') + ARROWS[key];
        return emit(bytes);
      } catch { return false; }
    },
    // Called in capture phase on xterm's textarea, BEFORE xterm handles the
    // original event. true consumes that event, including a failed send: never
    // fall through to type a different key. Paste/protocol data is not mapped.
    type(event) {
      if (!control || event?.isTrusted !== true || !['keydown', 'beforeinput'].includes(event.type)) return false;
      if (!ready()) { control = false; return false; }
      if (event.type === 'keydown' && ['Control','Shift','Alt','Meta'].includes(event.key)) return false;
      control = false;
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || (event.type === 'beforeinput' && event.inputType !== 'insertText')) return false;
      const key = event.type === 'keydown' ? event.key : event.data;
      if (typeof key !== 'string' || !/^[ -~]$/.test(key)) return false;
      const code = key.toUpperCase().charCodeAt(0);
      const byte = key === ' ' ? 0 : key === '?' ? 127 : code >= 64 && code <= 95 ? code & 31 : null;
      if (byte === null) return false;
      emit(String.fromCharCode(byte));
      return true;
    },
    dispose() { disposed = true; control = false; },
  };
}
