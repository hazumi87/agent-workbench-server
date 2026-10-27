import { createPictureEditor, paintPictureAvatar } from './user-picture.js';
import { onOwnPictureChange } from './user-picture-bridge.js';
const mounted = new WeakMap();
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};
/** First block in Accounts, also available without the Accounts module (room login is independent). */
export function renderYourPicture(sec, deps) {
  if (!sec) return;
  let rec = mounted.get(sec);
  if (!rec) {
    const box = el('section', 'ac-yourpicture'); box.setAttribute('aria-label', 'Your picture');
    const title = el('div', 'ac-title', 'Your picture');
    const preview = el('span', 'wr-av ac-picture-preview');
    const buttons = el('div', 'ac-picture-buttons');
    const choose = el('button', 'ac-btn o', 'Choose image…'), remove = el('button', 'ac-btn t', 'Remove picture');
    choose.type = remove.type = 'button';
    const input = el('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    const help = el('p', 'ac-sub', 'Shown beside your messages in every room.');
    const message = el('p', 'ac-picture-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    buttons.append(choose, remove); box.append(title, preview, buttons, input, help, message);
    rec = { box, deps, editor: null };
    rec.editor = createPictureEditor({
      status: () => rec.deps.status(),
      save: patch => rec.deps.save(patch),
      removed: undo => rec.deps.snackbar('Picture removed.', { action: { label: 'Undo', fn: undo } }),
      change: state => {
        const me = rec.deps.status()?.me || {};
        paintPictureAvatar(preview, { ...me, picture: state.picture }, 96);
        choose.disabled = state.busy || !state.enabled;
        remove.disabled = state.busy || !state.enabled || !state.picture;
        message.classList.toggle('err', !!state.error);
        message.textContent = state.error || (state.busy ? 'Saving…' : state.saved ? 'Saved' : !state.enabled ? 'Sign in to your rooms to choose your picture.' : '');
      },
    });
    // Observe account changes even while Settings is closed, including A → B → A.
    // These subscriptions live with this one persistent Settings section/window.
    if (window.wb?.on) {
      const off = [onOwnPictureChange(() => queueMicrotask(() => rec.editor.sync())), window.wb.on('rooms:account', () => rec.editor.invalidate()),
        window.wb.on('rooms:status', () => queueMicrotask(() => rec.editor.sync()))];
      window.addEventListener('beforeunload', () => { rec.editor.destroy(); for (const stop of off) if (typeof stop === 'function') stop(); }, { once: true });
    }
    choose.addEventListener('click', () => { input.value = ''; input.click(); });
    input.addEventListener('change', () => { if (input.files?.[0]) void rec.editor.choose(input.files[0]); });
    remove.addEventListener('click', () => { void rec.editor.remove(); });
    // Initial createPictureEditor notification runs synchronously; rec exists before it.
    mounted.set(sec, rec);
  }
  rec.deps = deps;
  rec.editor.sync();
  if (sec.firstChild !== rec.box) sec.prepend(rec.box);
  return rec.editor;
}
