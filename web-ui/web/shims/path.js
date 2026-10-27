'use strict';
// posix path: join, basename, dirname, resolve, as the rooms core and the scoped wrapper use them.
function normalize(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
}
const join = (...parts) => normalize(parts.filter(Boolean).join('/')) || '.';
const basename = (p) => String(p).split('/').filter(Boolean).pop() || '';
const dirname = (p) => { const i = String(p).replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '.') : String(p).slice(0, i); };
const resolve = (...parts) => normalize(parts.join('/'));
module.exports = { join, basename, dirname, resolve, sep: '/' };
