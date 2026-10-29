// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — vk task 1a
//
// GATE SPIKE 2 (KEPT): the minimal "<asset-hello>" custom element from the
// blueprint acceptance — a React component mounted via the light-DOM WC bridge,
// themed by tokens. Proves React renders into the element's LIGHT DOM (queryable
// without piercing a shadow root), context flows, and CustomEvents cross the
// boundary. This is the foundation pattern for <asset-clipboard> (1b).
import { useEffect } from 'react';
import { defineReactElement, type ReactElementContext } from './react-in-wc';

function Hello({ name, onReady }: { name: string; onReady: () => void }) {
  useEffect(() => {
    onReady(); // results-out: fire a CustomEvent once React has rendered
  }, [onReady]);
  return (
    <span
      className="asset-hello"
      style={{
        fontFamily: 'var(--ap-font-sans)',
        color: 'var(--ap-accent)',
        fontSize: 'var(--ap-fs-base)',
      }}
    >
      Hello, {name}!
    </span>
  );
}

export function registerAssetHello(): void {
  defineReactElement(
    'asset-hello',
    ({ attrs, emit }: ReactElementContext) => (
      <Hello name={String(attrs.name ?? 'nobody')} onReady={() => emit('asset-hello:ready')} />
    ),
    ['name'],
  );
}
