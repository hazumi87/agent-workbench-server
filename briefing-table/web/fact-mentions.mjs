/* WHICH ROOM FACTS ARE "TO ME" [to-me facts] (lead [ref]): a fact shows under To me only when the engine flagged it to the person,
 * or its own text names the person. Pure, so the rule is testable. The names are read outside `code spans`; the person is @user or
 * their own handle. Nothing a quoted line or a reply carries counts: only the fact's own text. */
export function mentionsIn(body) {
  return [...String(body ?? '').replace(/`[^`]*`/g, ' ').matchAll(/(^|[\s(])@([A-Za-z0-9][A-Za-z0-9-]*)/g)].map((m) => m[2].toLowerCase());
}

export function namesPerson(mentions, handle) {
  const me = typeof handle === 'string' && handle ? handle.toLowerCase() : null;
  return (Array.isArray(mentions) ? mentions : String(mentions ?? '').split(' ')).some((n) => !!n && (n === 'user' || (me !== null && n === me)));
}

/** The whole rule for a fact line. */
export function factIsToMe({ toUser, mentions }, handle) {
  return toUser === true || toUser === '1' || namesPerson(mentions, handle);
}
