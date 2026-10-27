// One focus counter per document. Async attach/control acknowledgements cannot
// take focus back after the person has chosen another field (even and back).
const focusCounters = new WeakMap();
export function captureTerminalFocus(doc) {
  let counter = focusCounters.get(doc);
  if (!counter) {
    counter = { value: 0 };
    doc.addEventListener('focusin', () => { counter.value++; });
    focusCounters.set(doc, counter);
  }
  const version = counter.value, anchor = doc.activeElement;
  return {
    focus(term, current) {
      if (!current() || counter.value !== version || doc.hasFocus?.() === false) return false;
      const active = doc.activeElement;
      // Repainting the route strip removes its button and returns focus to body.
      if (active !== anchor && !(anchor?.isConnected === false && active === doc.body)) return false;
      term.focus(); return true;
    },
  };
}
