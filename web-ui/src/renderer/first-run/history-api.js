// Translate only the five scoped preload calls. No URL, bearer, storage or filesystem access.
export function withEngineHistory(base, rooms, { pollMs = 1000 } = {}) {
  const listeners = new Set();
  let timer = null, stopped = false, generation = 0, pollActive = false;
  function selected(api) {
    if (stopped || !api.current()) throw Object.assign(Error('Account changed. Reopen settings.'), { code: 'account-changed' });
  }
  async function request(method, ...args) {
    if (base.ownsLocalHistory) return base[({historySet:'setHistoryEnabled',historyExport:'exportHistory',historyStart:'startHistoryExport',historyCancel:'cancelExport'})[method]](...args);
    const api = rooms.bind(); selected(api);
    const result = await api[method](...args); selected(api);
    if (!result?.ok) throw Object.assign(Error(result?.message || "Couldn't update chat history."), { code: result?.code || 'error' });
    return result.value;
  }
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  function history(value) {
    const done = count(value.done), total = Math.max(done, count(value.total));
    const date = value.lastRunAt && new Date(value.lastRunAt);
    return { enabled: value.enabled !== false, progress: value.running ? { done, total } : null,
      lastCopy: count(value.written) && date && Number.isFinite(date.getTime()) ? date.toLocaleString() : null,
      error: typeof value.lastError === 'string' ? value.lastError : null };
  }
  async function getState() {
    if (base.ownsLocalHistory) return base.getState();
    const bound = rooms.bind();
    const state = await base.getState();
    // Setup precedes engine startup; it must not require a history HTTP response.
    if (state.setupRequired || state.localRooms?.status !== 'running') return state;
    selected(bound);
    const result = await bound.historyGet(); selected(bound);
    if (!result?.ok) throw Error(result?.message || "Couldn't load chat history.");
    const value = result.value;
    return { ...state, history: history(value) };
  }
  async function poll(stamp) {
    if (pollActive) { if (stamp === generation && !stopped && listeners.size) timer = setTimeout(() => poll(stamp), pollMs); return; }
    pollActive = true;
    try {
      const visible = [...listeners].filter(item => item.visible());
      if (visible.length) {
        const state = await getState();
        if (stamp !== generation || stopped) return;
        for (const item of visible) if (listeners.has(item) && item.visible()) item.fn(state);
      }
    } catch (error) {
      if (stamp === generation && !stopped) for (const item of listeners) if (item.visible()) item.error?.(error);
    } finally {
      pollActive = false;
      if (stamp === generation && !stopped && listeners.size) timer = setTimeout(() => poll(stamp), pollMs);
    }
  }
  // contextBridge freezes API properties. Copy into our own configurable object;
  // proxying the bridge itself cannot legally replace its non-configurable methods.
  const wrapped = {};
  for (const key of Object.keys(base)) {
    const value = base[key];
    wrapped[key] = typeof value === 'function' ? value.bind(base) : value;
  }
  return Object.assign(wrapped, {
      getState,
      setHistoryEnabled: enabled => request('historySet', enabled),
      exportHistory: roomId => request('historyExport', roomId),
      startHistoryExport: () => request('historyStart'),
      cancelExport: () => request('historyCancel'),
      subscribeHistory(fn, visible = () => true, error) {
        const item = { fn, visible, error }; listeners.add(item);
        if (listeners.size === 1) { const stamp = ++generation; timer = setTimeout(() => poll(stamp), pollMs); }
        return () => { listeners.delete(item); if (!listeners.size) { generation++; clearTimeout(timer); timer = null; } };
      },
      destroyHistory() { stopped = true; generation++; clearTimeout(timer); listeners.clear(); },
  });
}
