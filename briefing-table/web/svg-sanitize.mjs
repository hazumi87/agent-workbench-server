/* SVG SANITIZER, browser side (security review M6): the same ALLOW-LIST as src/engine/svg-sanitize.ts, but over a real parse (DOMParser, image/svg+xml), so what is injected is rebuilt from the elements
 * and attributes on the list and nothing else. It replaces the regex that removed only <script> and on*= (foreignObject, javascript: links, srcdoc and the rest passed). A file that does not parse, has a
 * DOCTYPE/ENTITY, or is not rooted at <svg> gives ''. Keep the two lists in step with the server copy. */
const ELEMENTS = new Set(['svg', 'g', 'defs', 'symbol', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'marker',]);
const DROP_SUBTREE = new Set(['script', 'foreignobject', 'style', 'image', 'iframe', 'object', 'embed', 'a', 'animate', 'animatetransform', 'animatemotion', 'set', 'handler', 'listener', 'pattern', 'filter', 'switch', 'link', 'meta']);
const TEXTY = new Set(['text', 'tspan', 'title', 'desc']);
const ATTRS = new Set(['id', 'class', 'd', 'points', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'viewbox', 'preserveaspectratio', 'transform', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient', 'version',
  'xmlns', 'xmlns:xlink', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'letter-spacing', 'display', 'visibility', 'vector-effect',
  'style', 'href', 'xlink:href', 'role', 'aria-label', 'aria-hidden', 'focusable',]);
const STYLE_PROPS = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'display', 'visibility', 'stop-color', 'stop-opacity', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'font-family', 'font-size', 'font-weight', 'font-style']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;

/** A value is safe if it names no script/data URL and any url() is a local reference. */
function safeValue(v) {
  const low = v.toLowerCase().replace(/[\s\u0000-\u001f]/g, '');
  if (low.includes('javascript:') || low.includes('data:') || low.includes('vbscript:') || low.includes('expression(') || low.includes('@import')) return false;
  for (const m of low.matchAll(/url\(([^)]*)\)/g)) {
    const inner = m[1].replace(/^['"]|['"]$/g, '');
    if (!/^#[\w.:-]+$/.test(inner)) return false;
  }
  return !/[<>]/.test(v);
}

function cleanStyle(v) {
  const out = [];
  for (const decl of v.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (STYLE_PROPS.has(prop) && val && /^[#\w.,%()\s'"-]*$/.test(val) && safeValue(val)) out.push(prop + ':' + val);
  }
  return out.length ? out.join(';') : null;
}

function copy(src, dst, doc, depth) {
  for (const a of Array.from(src.attributes)) {
    const name = a.name.toLowerCase();
    if (name.startsWith('on') || !ATTRS.has(name)) continue;
    let value = a.value;
    if (name === 'href' || name === 'xlink:href') {
      if (!/^#[\w.:-]+$/.test(value)) continue;
    } else if (name === 'style') {
      const c = cleanStyle(value);
      if (!c) continue;
      value = c;
    } else if (!safeValue(value)) {
      continue;
    }
    if (name === 'xlink:href') dst.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', value);
    else dst.setAttribute(a.name, value);
  }
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === 3) {
      if (TEXTY.has(src.localName.toLowerCase())) dst.appendChild(doc.createTextNode(child.nodeValue.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')));
    } else if (child.nodeType === 1) {
      const name = child.localName.toLowerCase();
      if (child.namespaceURI !== SVG_NS || DROP_SUBTREE.has(name) || !ELEMENTS.has(name) || depth >= MAX_DEPTH) continue;
      const el = doc.createElementNS(SVG_NS, child.localName);
      copy(child, el, doc, depth + 1);
      dst.appendChild(el);
    }
  }
}

/** The cleaned markup, or '' when the input is not an acceptable SVG. */
export function sanitizeSvgText(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  if (!text || text.length > MAX_BYTES || /<!doctype|<!entity|<!\[CDATA\[/i.test(text)) return '';
  /* a pasted export often leaves the namespaces off (HTML parses it anyway; XML does not): declare them on the root tag */
  const fixed = text.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
    let add = '';
    if (!/\sxmlns\s*=/.test(attrs)) add += ` xmlns="${SVG_NS}"`;
    if (/xlink:/.test(text) && !/xmlns:xlink\s*=/.test(attrs)) add += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    return add ? `<svg${add}${attrs}>` : m;
  });
  const doc = new DOMParser().parseFromString(fixed, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) return '';
  const out = doc.implementation.createDocument(SVG_NS, 'svg', null);
  const dst = out.documentElement;
  copy(root, dst, out, 1);
  return new XMLSerializer().serializeToString(dst);
}
