// The allowlist sanitizer for a tool's SVG output (the design notes §4, §6; PM review on
// PR #1). A tool's card becomes live markup in the host page, which holds the app's privileged
// API, so what gets in is an allowlist, never a denylist: a fixed set of drawing elements, a fixed
// set of geometry / presentation / text attributes, no `style` element or attribute, no event
// handlers, no SMIL, and a `url(` only ever to `#an-id` in this document (no network). `href`
// lives on `use` only, and only as `#…`. The card is imported into the host page's own document, so
// its names would share the host's namespace: every `id` is rewritten under a per-render prefix,
// every local reference (`use` href, `url(#…)`, `aria-labelledby`) follows it, and a reference to an
// id that is not the card's own goes (no reaching host elements). No `class` either: host CSS and
// host selectors never pick up card elements. Pure: it walks any DOM-shaped tree (nodeName,
// attributes, childNodes, setAttribute, removeAttribute, remove), so node tests run it over a tiny
// parser and the renderer over DOMParser's document.

export const SVG_ELEMENTS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'symbol', 'use']);

export const SVG_ATTRS = new Set([
  // geometry
  'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'fx', 'fy', 'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'points', 'd', 'pathLength',
  'viewBox', 'preserveAspectRatio', 'transform', 'offset',
  // identity
  'id', 'xmlns', 'xmlns:xlink', 'xml:space', 'lang', 'role', 'aria-label', 'aria-hidden', 'aria-labelledby',
  // paint and shape
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'color', 'vector-effect', 'shape-rendering', 'paint-order',
  'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits',
  'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  // text
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'text-decoration', 'text-rendering', 'writing-mode', 'textLength', 'lengthAdjust',
]);

const LOCAL_URL = /^\s*url\(\s*(['"]?)#[A-Za-z0-9_.:-]+\1\s*\)\s*$/;
const LOCAL_REF = /url\(\s*(['"]?)#([A-Za-z0-9_.:-]+)\1\s*\)/;
const ID = /^#?([A-Za-z0-9_.:-]+)$/;

/** A value may name url(#id) in this document; any other url( is a fetch, and goes. */
function valueOk(name, value) {
  const v = String(value);
  if (/url\s*\(/i.test(v)) {
    // the whole value is one local reference, or it is out
    return LOCAL_URL.test(v) || (name === 'fill' || name === 'stroke' || name === 'clip-path' || name === 'mask' ? LOCAL_URL.test(v.replace(/\s+(none|currentColor)\s*$/i, '')) : false);
  }
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
}

function localName(node) {
  const n = String(node.localName || node.nodeName || '');
  return n.includes(':') ? n.split(':').pop() : n;
}

/**
 * Prune a parsed SVG tree in place, then scope its names: every id becomes `prefix + id`, every
 * local reference follows, and a reference to an id the card does not define goes. Returns what
 * went: { elements: [...], attributes: [...] }. The root must be an svg element; anything else is
 * emptied.
 */
export function sanitizeSvgTree(root, opts) {
  const prefix = opts && typeof opts.prefix === 'string' ? opts.prefix : '';
  const removed = { elements: [], attributes: [] };
  const ids = new Set();
  if (!root || localName(root) !== 'svg') {
    if (root && root.childNodes) {
      for (const c of [...root.childNodes]) c.remove();
    }
    removed.elements.push('(root)');
    return removed;
  }
  const walk = (el) => {
    for (const at of [...el.attributes]) {
      const name = String(at.name);
      const lower = name.toLowerCase();
      const isHref = lower === 'href' || lower === 'xlink:href';
      let keep = false;
      if (isHref) {
        keep = localName(el) === 'use' && /^#[A-Za-z0-9_.:-]+$/.test(String(at.value).trim());
      } else if (lower.startsWith('on') || lower === 'style') {
        keep = false;
      } else {
        keep = SVG_ATTRS.has(name) && valueOk(name, at.value);
      }
      if (!keep) {
        removed.attributes.push(localName(el) + '@' + name);
        el.removeAttribute(name);
      } else if (lower === 'id') {
        ids.add(String(at.value));
      }
    }
    for (const child of [...el.childNodes]) {
      const type = child.nodeType;
      if (type === 1) {
        if (!SVG_ELEMENTS.has(localName(child)) || (child.namespaceURI && child.namespaceURI !== 'http://www.w3.org/2000/svg')) {
          removed.elements.push(localName(child));
          child.remove(); // children go with it
        } else {
          walk(child);
        }
      } else if (type !== 3 && type !== 4) {
        child.remove(); // comments, processing instructions
      }
    }
  };
  walk(root);
  // the second pass: ids under the prefix, references to the card's own ids follow, any other goes
  const scope = (el) => {
    for (const at of [...el.attributes]) {
      const name = String(at.name);
      const lower = name.toLowerCase();
      const v = String(at.value);
      if (lower === 'id') {
        el.setAttribute(name, prefix + v);
        continue;
      }
      let next = null;
      if (lower === 'href' || lower === 'xlink:href') {
        const m = ID.exec(v.trim());
        next = m && ids.has(m[1]) ? '#' + prefix + m[1] : null;
      } else if (lower === 'aria-labelledby') {
        const keep = v.split(/\s+/).filter((t) => ids.has(t)).map((t) => prefix + t);
        next = keep.length ? keep.join(' ') : null;
      } else {
        const m = LOCAL_REF.exec(v);
        if (!m) continue;
        next = ids.has(m[2]) ? v.replace(m[0], 'url(#' + prefix + m[2] + ')') : null;
      }
      if (next === null) {
        removed.attributes.push(localName(el) + '@' + name + ' (not this card\'s id)');
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, next);
      }
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 1) scope(child);
    }
  };
  scope(root);
  return removed;
}
