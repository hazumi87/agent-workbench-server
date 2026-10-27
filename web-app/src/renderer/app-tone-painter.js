import {toneFor} from './app-tones.js';
import {APP_TONE_CHOICES} from './app-tone-palette.js';
// Callers supply a named app header/sample, never a page or message subtree.
export function createAppTonePainter(m3) {
  return (node,app,overrides) => {
    const choice=APP_TONE_CHOICES.find(item=>item.value===toneFor(app,overrides));
    if(!node||!choice)return;
    node.dataset.appTone=choice.value;
    m3.applyTo(node,choice.seed,m3.get().style);
  };
}
