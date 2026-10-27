/* M5 (security review of web/foundation): with the web app on the engine's origin, `script-src 'self'` would also admit a room upload served as text/javascript. So an uploaded file is served as itself ONLY if its type is on
 * this short allowlist (raster images, PDF, plain text, markdown, csv, json); anything else (javascript, html, svg, xml, unknown) goes out as application/octet-stream and an attachment. nosniff is set by the callers. */
const SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);

export function safeServeType(type: string | null | undefined): { type: string; attachment: boolean } {
  const t = String(type ?? '').split(';')[0].trim().toLowerCase();
  return SAFE.has(t) ? { type: String(type), attachment: false } : { type: 'application/octet-stream', attachment: true };
}

/** The disposition a served upload gets (M5): a type forced to an attachment STAYS one whatever the upstream said; the upstream can only turn an inline type into an attachment. */
export function dispositionFor(served: { attachment: boolean }, upstream: string | null | undefined): 'attachment' | 'inline' {
  return served.attachment || /^attachment/i.test(upstream ?? '') ? 'attachment' : 'inline';
}
