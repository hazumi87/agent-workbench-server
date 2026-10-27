/* MARKDOWN IN CHAT LINES [line markdown] (Owner via room interface [ref]; the design system spec, UI [ref]). Room line bubbles and the agent chat render a message's body as
 * Markdown, at the bubble's own text size, through the ONE sanitizing renderer the viewer already has (web/room-doc-view.mjs: marked + DOMPurify, loaded once).
 *
 * THE RULES (the design system):
 *   - a bubble stays a message: nothing bigger than the message text (headings included); the bubble's width cap never moves;
 *   - raw HTML in a message is shown AS TEXT, never rendered; images are shown as a link (pictures come through attachments);
 *   - @mentions and links keep their chips: the rendered text nodes go through the same `linkNodes(text, mentionNodes)` the plain line uses, EXCEPT inside code,
 *     a block quote or an existing link (the engine's fence rule, eng/fence-at: an @name in a fence or a "> " line is not a mention);
 *   - lists stop at three levels (deeper ones join the third), task boxes are read-only glyphs, tables and code scroll inside themselves;
 *   - a message with NO markup takes today's plain path unchanged (hasMarkup), so the common line costs nothing and cannot regress;
 *   - event lines, the reply quote's excerpt, search results and the room card's last line stay plain: stripMarks() takes the marks out there.
 * UNTRUSTED: the text is written by agents; DOMPurify forbids class/id/style and every active tag (room-doc-view FORBID_*), which is why structure is carried by
 * TAGS here (h1-h6, pre, blockquote, table) and the only classes are put on AFTER sanitizing, by this file, on nodes it made itself. */
import { loadLibs, sanitizeHtml } from '/room-doc-view.mjs';
import { linkNodes } from '/room-links.mjs';
import { openExternal } from '/open-external.mjs';
import { copyText } from '/room-app-port.mjs';
import { hasMarkup, stripMarks } from '/markdown-plain.mjs';

export { hasMarkup, stripMarks };

let lib = null; // {marked: <Marked instance>, purify}
let loading = null;
const readyCbs = new Set();
let langs = []; // the language of each fenced block of the render in progress, in order (a class would not survive the sanitizer)

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Load the libraries once; resolves true when rendering is possible, false when they would not load (lines then stay plain). */
export function ensureMarkdown() {
  if (lib) {
    return Promise.resolve(true);
  }
  loading ??= loadLibs()
    .then(({ marked, purify }) => {
      const M = marked.Marked;
      const inst = new M({
        gfm: true,
        breaks: true, // a newline is a line break, as the plain line has always shown it
        async: false,
        tokenizer: {
          url() {
            return undefined; // no autolink here: a bare URL is made a link by linkNodes (the host's own open-in-new-window), exactly as today
          },
        },
        renderer: {
          html({ text }) {
            return esc(text); // raw HTML is text
          },
          image({ href, text }) {
            const label = text || href || 'image';
            return href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label); // pictures come through attachments
          },
          code({ text, lang }) {
            langs.push(String(lang || '').split(/\s+/)[0].slice(0, 24));
            return `<pre><code>${esc(text)}</code></pre>\n`;
          },
          checkbox({ checked }) {
            return checked ? '☑ ' : '☐ '; // read-only boxes
          },
        },
      });
      lib = { marked: inst, purify };
      for (const f of [...readyCbs]) {
        f();
      }
      readyCbs.clear();
      return true;
    })
    .catch(() => {
      loading = null; // a later try may work
      return false;
    });
  return loading;
}
export const markdownReady = () => !!lib;
/** Call `f` once when rendering becomes possible (the lines drawn before that are redrawn). */
export function onMarkdownReady(f) {
  if (lib) {
    f();
  } else {
    readyCbs.add(f);
  }
}

/** Lists nested deeper than three levels join the third. */
function flattenLists(root) {
  for (;;) {
    const deep = [...root.querySelectorAll('ul, ol')].find((l) => {
      let n = 0;
      for (let p = l.parentElement; p && p !== root; p = p.parentElement) {
        if (p.tagName === 'UL' || p.tagName === 'OL') {
          n += 1;
        }
      }
      return n >= 3;
    });
    if (!deep) {
      return;
    }
    const li = deep.closest('li');
    const items = [...deep.children];
    if (li && li.parentElement) {
      let at = li;
      for (const it of items) {
        at.after(it);
        at = it;
      }
    }
    deep.remove();
  }
}

/** @mentions and bare URLs in the TEXT of the rendered message, but never inside code, a quote or a link. */
function chipText(root, rest) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('pre, code, blockquote, a')) {
      hits.push(n);
    }
  }
  for (const n of hits) {
    const nodes = linkNodes(n.nodeValue ?? '', rest);
    if (nodes.length === 1 && nodes[0].nodeType === Node.TEXT_NODE) {
      continue;
    }
    n.replaceWith(...nodes);
  }
}

/** Fade the right edge of a scroller while there is more to see that way (the hint that it scrolls): .md-more toggles with its size and its scroll. */
function scrollHint(el) {
  const f = () => el.classList.toggle('md-more', el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
  el.addEventListener('scroll', f, { passive: true });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(f).observe(el); // fires once it is in the page and whenever its size changes
  }
  requestAnimationFrame(f);
}

/** A code block: a small header strip inside it (the language on the left, Copy on the right, always there), the code under it. */
function codeBlock(pre, lang) {
  const wrap = document.createElement('div');
  wrap.className = 'md-code';
  const head = document.createElement('div');
  head.className = 'md-codehead';
  const l = document.createElement('span');
  l.className = 'md-lang';
  l.textContent = lang;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'md-copy';
  btn.textContent = 'Copy';
  btn.setAttribute('aria-label', 'Copy the code');
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const done = await copyText(pre.textContent ?? '');
    btn.textContent = done ? 'Copied' : 'Not copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  });
  head.append(l, btn);
  pre.replaceWith(wrap);
  wrap.append(head, pre);
  scrollHint(pre);
}

/**
 * The message as nodes: one `.md` block, or null when it has no markup or the libraries are not loaded (the caller then draws the plain line).
 * `rest` is the @mention toning the plain line uses for its text runs.
 */
export function renderLineMarkdown(text, rest) {
  if (!lib || !hasMarkup(text)) {
    return null;
  }
  langs = [];
  let frag;
  try {
    const html = lib.marked.parse(String(text), { async: false });
    frag = sanitizeHtml(lib.purify, html, location.href);
  } catch {
    return null; // never break a line over its formatting
  }
  const root = document.createElement('div');
  root.className = 'md';
  root.append(frag);
  flattenLists(root);
  [...root.querySelectorAll('pre')].forEach((pre, i) => codeBlock(pre, langs[i] ?? ''));
  for (const t of [...root.querySelectorAll('table')]) {
    const w = document.createElement('div');
    w.className = 'md-table';
    t.replaceWith(w);
    w.append(t);
    scrollHint(w);
  }
  /* a task item drops its bullet: the box takes the bullet's place */
  for (const li of root.querySelectorAll('li')) {
    if (/^[\u2610\u2611]\s/.test(li.textContent ?? '')) {
      li.classList.add('md-task');
    }
  }
  chipText(root, rest);
  for (const a of root.querySelectorAll('a[href]:not(.rl-link)')) {
    a.classList.add('rl-link');
    const open = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openExternal(a.href);
    };
    a.addEventListener('click', open);
    a.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) {
        open(ev);
      }
    });
  }
  return [root];
}
