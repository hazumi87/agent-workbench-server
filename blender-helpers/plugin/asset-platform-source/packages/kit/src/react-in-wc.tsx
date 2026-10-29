// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — vk task 1a
//
// WC <-> React LIGHT-DOM bridge (the design notes: light DOM, not shadow).
// React is mounted into the custom element ITSELF (createRoot(this)), so:
//   - the host page's CSS design tokens cascade in (theming "just works"),
//   - R3F canvas sizing / pointer / portals behave (shadow DOM breaks them),
//   - inputs participate in the host page normally.
//
// Config in:  string attributes (observedAttributes) AND arbitrary JS properties
//             (objects/callbacks set via element.someProp = ...). Both trigger a
//             re-render and are passed to the render fn merged together.
// Results out: components call host.dispatchEvent(new CustomEvent(...)); helper
//             `emit` is provided to the render fn.
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

export interface ReactElementContext {
  /** merged string attributes + JS properties currently on the element */
  attrs: Record<string, unknown>;
  /** the custom element host (light DOM root React is mounted into) */
  host: HTMLElement;
  /** dispatch a CustomEvent off the host element (results-out channel) */
  emit: (type: string, detail?: unknown) => void;
}

export function defineReactElement(
  tag: string,
  render: (ctx: ReactElementContext) => ReactNode,
  observedAttrs: string[] = [],
): void {
  if (customElements.get(tag)) return; // idempotent registration

  class ReactElement extends HTMLElement {
    private root: Root | null = null;
    private props: Record<string, unknown> = {};

    static get observedAttributes(): string[] {
      return observedAttrs;
    }

    connectedCallback(): void {
      // Mount into `this` — the element's own LIGHT DOM. No attachShadow.
      this.root = createRoot(this);
      this.renderReact();
    }

    attributeChangedCallback(): void {
      if (this.root) this.renderReact();
    }

    disconnectedCallback(): void {
      this.root?.unmount();
      this.root = null;
    }

    /** Allow `el.prop = value` (objects/callbacks) to drive a re-render. */
    setProp(name: string, value: unknown): void {
      this.props[name] = value;
      if (this.root) this.renderReact();
    }

    private renderReact(): void {
      const attrs: Record<string, unknown> = { ...this.props };
      for (const name of observedAttrs) {
        const v = this.getAttribute(name);
        if (v !== null) attrs[name] = v;
      }
      const emit = (type: string, detail?: unknown) =>
        this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
      this.root?.render(render({ attrs, host: this, emit }));
    }
  }

  customElements.define(tag, ReactElement);
}
