// Used by independent message and Assets caches (10 MiB each, 20 MiB total). Budget counts retained UTF-16 URL
// text (two bytes per code unit) plus decoded pixel estimates reported on load.
// Transient browser decode/IPC allocations are outside the retained-cache budget.
export function createThumbnailCache(maxBytes = 20 * 1024 * 1024) {
  const entries = new Map(), pending = new Map(); let total = 0, generation = 0, roomId;
  let running = 0; const waiters = [];
  async function fetchOne(fetch, valid) {
    if (running >= 2) await new Promise(resolve => waiters.push(resolve));
    else running++;
    try { return valid() ? await fetch() : null; }
    finally { if (waiters.length) waiters.shift()(); else running--; }
  }
  function prune() {
    for (const entry of entries.values()) for (const ref of entry.refs) if (!ref.valid()) entry.refs.delete(ref);
  }
  function remove(key) {
    const entry = entries.get(key); if (!entry) return;
    entries.delete(key); total -= entry.bytes;
    for (const ref of entry.refs) if (ref.valid()) ref.reset();
    entry.refs.clear();
  }
  return {
    setRoom(next) { if (roomId !== next) { this.clear(); roomId = next; } },
    async load(key, fetch, paint, reset, valid) {
      const stamp = generation;
      prune(); let entry = entries.get(key);
      if (!entry) {
        let request = pending.get(key);
        if (!request) { request = Promise.resolve().then(() => fetchOne(fetch, () => stamp === generation && valid())).catch(() => null); pending.set(key, request); }
        const url = await request;
        if (pending.get(key) === request) pending.delete(key);
        if (stamp !== generation || !valid() || !url || url.length * 2 > maxBytes) return;
        entry = entries.get(key);
        if (!entry) {
          entry = { url, bytes: url.length * 2, refs: new Set() };
          while (total + entry.bytes > maxBytes && entries.size) remove(entries.keys().next().value);
          entries.set(key, entry); total += entry.bytes;
        }
      }
      if (!valid()) return;
      entries.delete(key); entries.set(key, entry);
      entry.refs.add({reset,valid});
      paint(entry.url, decoded => {
        if (entries.get(key) !== entry || !Number.isFinite(decoded) || decoded < 0) return;
        const bytes = entry.url.length * 2 + decoded;
        total += bytes - entry.bytes; entry.bytes = bytes;
        while (total > maxBytes && entries.size) remove(entries.keys().next().value);
      });
    },
    clear() { generation++; pending.clear(); for (const key of [...entries.keys()]) remove(key); },
    bytes: () => total,
  };
}
