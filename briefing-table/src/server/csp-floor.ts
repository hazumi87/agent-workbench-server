/* The engine's floor for a CSP header the web app ships (<app dir>/csp.json). A per-response CSP replaces the global `frame-ancestors 'self'` header, so a shipped header is accepted only if it keeps the floor:
 *  - frame-ancestors lists 'self' and nothing broader (no `*`, no scheme-only source);
 *  - connect-src and script-src (default-src when one is absent) use only 'self', 'none', nonces, hashes and 'strict-dynamic': no host, wildcard, scheme source, 'unsafe-inline' or 'unsafe-eval'.
 * Anything else: the caller uses its default and says why. */
export function cspProblem(header: string): string | null {
  const dirs = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const t = part.trim().split(/\s+/).filter(Boolean);
    if (t.length) dirs.set(t[0].toLowerCase(), t.slice(1));
  }
  /* connect-src and script-src are an ALLOW-list: 'self', 'none', nonces, hashes, 'strict-dynamic' and nothing else (no host, no wildcard, no scheme, no 'unsafe-inline'/'unsafe-eval') */
  const allowed = (src: string): boolean => /^'(self|none|strict-dynamic)'$/i.test(src) || /^'nonce-[A-Za-z0-9+/_=-]+'$/.test(src) || /^'sha(256|384|512)-[A-Za-z0-9+/_=-]+'$/.test(src);
  const broad = (src: string): boolean => src === '*' || /^[a-z][a-z0-9+.-]*:$/i.test(src);
  const fa = dirs.get('frame-ancestors');
  if (!fa || !fa.includes("'self'") || fa.some(broad)) return "frame-ancestors must list 'self' and nothing broader";
  for (const name of ['connect-src', 'script-src']) {
    const list = dirs.get(name) ?? dirs.get('default-src');
    if (!list) return `${name}: not set (and no default-src)`;
    const bad = list.find((x) => !allowed(x));
    if (bad) return `${name}: ${bad} is not on the allow-list ('self', 'none', nonce, hash, 'strict-dynamic')`;
  }
  return null;
}

/** M5: with the app on the engine's own origin, `script-src 'self'` would also admit a script uploaded to the same origin. Scope it to the app's path: 'self' in script-src becomes <origin>/app/.
 *  Only for a plain scheme://host[:port] origin; anything else keeps the policy as shipped. */
export function scopeScriptSrc(header: string, origin: string | null): string {
  if (!origin || !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)) return header;
  return header
    .split(';')
    .map((part) => {
      const t = part.trim().split(/\s+/);
      return t[0]?.toLowerCase() === 'script-src' ? t.map((x, i) => (i > 0 && x === "'self'" ? `${origin}/app/` : x)).join(' ') : part.trim();
    })
    .filter(Boolean)
    .join('; ');
}
