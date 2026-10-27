/* SVG SANITIZER, server side (security review M6): an ALLOW-LIST parser with no DOM and no dependency. An SVG that reaches the engine (a logo upload, a recipe's logo) is parsed
 * and RE-SERIALISED from what is allowed; anything else is dropped, or the whole file is refused:
 *   - refused (null): not rooted at <svg>, a DOCTYPE or ENTITY, malformed/unbalanced markup, an unquoted attribute value, nesting over 64, over 2 MB;
 *   - dropped with their subtree: script, foreignObject, style, image, iframe, object, embed, a, animate/set (they can change href/on* values), use with a non-local reference, and any
 *     element not on the list;
 *   - dropped attributes: every on*, anything not on the list, href/xlink:href that is not a bare `#id`, any value with `javascript:` or `data:` or a `url(` that is not `url(#id)`;
 *   - text is kept only inside text/tspan/title/desc and re-escaped.
 * The browser also sanitises before it injects (DOMPurify's SVG profile); this is the copy that guards the stored bytes. */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'marker',
]);
const DROP_SUBTREE = new Set(['script', 'foreignobject', 'style', 'image', 'iframe', 'object', 'embed', 'a', 'animate', 'animatetransform', 'animatemotion', 'set', 'handler', 'listener', 'pattern', 'filter', 'switch', 'link', 'meta']);
const TEXTY = new Set(['text', 'tspan', 'title', 'desc']);
const ATTRS = new Set([
  'id', 'class', 'd', 'points', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'viewbox', 'preserveaspectratio', 'transform', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient', 'version',
  'xmlns', 'xmlns:xlink', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'letter-spacing', 'display', 'visibility', 'vector-effect',
  'style', 'href', 'xlink:href', 'role', 'aria-label', 'aria-hidden', 'focusable',
]);
const STYLE_PROPS = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'display', 'visibility', 'stop-color', 'stop-opacity', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'font-family', 'font-size', 'font-weight', 'font-style']);

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** A value is safe if it names no script/data URL and any url() is a local reference. */
function safeValue(v: string): boolean {
  const low = v.toLowerCase().replace(/[\s\u0000-\u001f]/g, '');
  if (low.includes('javascript:') || low.includes('data:') || low.includes('vbscript:') || low.includes('expression(') || low.includes('@import')) return false;
  for (const m of low.matchAll(/url\(([^)]*)\)/g)) {
    const inner = m[1].replace(/^['"]|['"]$/g, '');
    if (!/^#[\w.:-]+$/.test(inner)) return false;
  }
  return !/[<>]/.test(v);
}

function cleanStyle(v: string): string | null {
  const out: string[] = [];
  for (const decl of v.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (STYLE_PROPS.has(prop) && val && /^[#\w.,%()\s'"-]*$/.test(val) && safeValue(val)) out.push(`${prop}:${val}`);
  }
  return out.length ? out.join(';') : null;
}

interface Attr {
  name: string;
  value: string;
}

export function sanitizeSvg(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input) > MAX_BYTES) return null;
  const src = input.replace(/^﻿/, '');
  if (/<!doctype|<!entity|<!\[CDATA\[/i.test(src)) return null; // external entities and CDATA tricks: refuse the file
  let i = 0;
  const out: string[] = [];
  const stack: Array<{ name: string; dropped: boolean }> = [];
  let rootSeen = false;
  let rootClosed = false;
  const n = src.length;
  const text = (t: string): void => {
    const top = stack[stack.length - 1];
    if (!top || top.dropped) return;
    if (!TEXTY.has(top.name)) return;
    const clean = unesc(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    if (clean) out.push(esc(clean).replace(/"/g, '&quot;'));
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (src.slice(i).trim()) {
        if (!rootSeen || rootClosed) return null;
        text(src.slice(i));
      }
      break;
    }
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.trim() && (!rootSeen || rootClosed)) return null; // content outside the root
      text(t);
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (src[lt + 1] === '!') return null;
    // a tag: find its end, honouring quoted attribute values
    let j = lt + 1;
    let q: string | null = null;
    while (j < n) {
      const c = src[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) return null;
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim().toLowerCase();
      const top = stack.pop();
      if (!top || top.name !== name) return null; // unbalanced
      if (!top.dropped) out.push(`</${name === 'lineargradient' ? 'linearGradient' : name === 'radialgradient' ? 'radialGradient' : name === 'clippath' ? 'clipPath' : name}>`);
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([A-Za-z][\w:.-]*)/.exec(inner);
    if (!m) return null;
    const rawName = m[1];
    const name = rawName.toLowerCase();
    const attrs: Attr[] = [];
    const re = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let rest = inner.slice(rawName.length);
    let consumed = 0;
    for (let am = re.exec(rest); am; am = re.exec(rest)) {
      if (am.index !== consumed) return null; // junk between attributes (an unquoted value, a bare word)
      attrs.push({ name: am[1].toLowerCase(), value: unesc(am[3] ?? am[4] ?? '') });
      consumed = am.index + am[0].length;
    }
    if (rest.slice(consumed).trim() !== '') return null;
    if (!rootSeen) {
      if (name !== 'svg') return null;
      rootSeen = true;
    } else if (rootClosed) {
      return null;
    }
    const parent = stack[stack.length - 1];
    const drop = (parent?.dropped ?? false) || DROP_SUBTREE.has(name) || !ELEMENTS.has(name);
    if (!selfClose) {
      if (stack.length >= MAX_DEPTH) return null;
      stack.push({ name, dropped: drop });
    }
    if (!drop) {
      const kept: string[] = [];
      for (const a of attrs) {
        if (a.name.startsWith('on') || !ATTRS.has(a.name)) continue;
        if (a.name === 'href' || a.name === 'xlink:href') {
          if (!/^#[\w.:-]+$/.test(a.value)) continue;
        } else if (a.name === 'style') {
          const s = cleanStyle(a.value);
          if (s) kept.push(`style="${esc(s)}"`);
          continue;
        } else if (!safeValue(a.value)) continue;
        kept.push(`${a.name === 'viewbox' ? 'viewBox' : a.name === 'preserveaspectratio' ? 'preserveAspectRatio' : a.name}="${esc(a.value)}"`);
      }
      const outName = name === 'lineargradient' ? 'linearGradient' : name === 'radialgradient' ? 'radialGradient' : name === 'clippath' ? 'clipPath' : name;
      out.push(`<${outName}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClose ? '/' : ''}>`);
    }
    if (selfClose && stack.length === 0) rootClosed = true;
  }
  if (!rootSeen || stack.length !== 0) return null;
  return out.join('');
}
