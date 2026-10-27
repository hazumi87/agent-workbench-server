/* MCP-CALL INDICATOR — the renderer's half (Owner's feature, ruled
 * 2026-09-25: styleguide mockup cli-mcp-indicator-v1, "Decided — MCP
 * indicator", M1 wire + C2 strip).
 *
 * The component is the design system (window-chrome v27, hwbMcpIndicator): the wire,
 * packets, relay, C2 fitting, +N list, timeout, phone and reduced-motion rules
 * all live in the bundle and are never restyled here. The engine's half is
 * nuc1's: `pane.mcp {paneid, id, phase:'start'|'end', server, label, verb,
 * caller, result?, ms?, why?, expectEnd?, ts}` on the pane socket, plus
 * `pane.ready.mcp` = the starts still in flight. This module is only the
 * joint: it forwards events 1:1 into the indicator, which takes the WHOLE
 * event object (the design system: "your wire shape maps 1:1").
 *
 * The factory is passed in rather than imported, because the shell and the
 * session page load the chrome from different paths (/assets/… vs /aurora/…)
 * and because a pin older than v27 has no such export: then everything here
 * is a no-op instead of a module-link error that would take the page down.
 */

/** Keep a tab's in-flight starts (id → start event) so a tab switch or a
 *  reconnect can re-show a long call. */
export function trackInFlight(map, e) {
  if (!map || !e || typeof e.id !== 'string') {
    return;
  }
  if (e.phase === 'start') {
    map.set(e.id, e);
  } else if (e.phase === 'end') {
    map.delete(e.id);
  }
}

/**
 * @param {() => HTMLElement|null} getBar  the session bar element
 * @param {Function|undefined} factory      hwbMcpIndicator, when the pin has it
 */
export function createMcpView(getBar, factory) {
  let ind = null;
  function ensure() {
    if (typeof factory !== 'function') {
      return null; // pre-v27 pin: no indicator, nothing breaks
    }
    if (!ind) {
      const el = getBar();
      if (!el) {
        return null;
      }
      try {
        ind = factory(el); // after hwbRenderSessionBar; survives later re-renders (v27)
      } catch {
        ind = null;
      }
    }
    return ind;
  }
  return {
    available: typeof factory === 'function',
    /** one pane.mcp event, forwarded as is */
    event(e) {
      const i = ensure();
      if (!i || !e || typeof e.id !== 'string') {
        return;
      }
      if (e.phase === 'start') {
        i.start(e.id, e);
      } else if (e.phase === 'end') {
        i.end(e.id, e);
      }
    },
    /** a clean slate + the starts still in flight (tab switch, reattach) */
    reset(starts) {
      const i = ensure();
      if (!i) {
        return;
      }
      i.clear();
      for (const e of starts || []) {
        if (e && e.phase === 'start' && typeof e.id === 'string') {
          i.start(e.id, e);
        }
      }
    },
  };
}
