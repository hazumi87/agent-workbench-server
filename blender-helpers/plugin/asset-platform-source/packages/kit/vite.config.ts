// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — vk task 1a
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Library build → a single self-contained IIFE bundle (dist/asset-kit.js).
// React + ReactDOM are bundled IN (not externalized): the host page is plain
// HTML served by the gateway with no module system, so the bundle must stand
// alone. The custom elements self-register as a side effect of importing
// src/index.tsx.
export default defineConfig({
  plugins: [react()],
  // The bundle is loaded by a plain <script> tag on a gateway-served HTML page
  // with NO bundler-injected globals. React's internals read
  // `process.env.NODE_ENV`; without this define the IIFE throws
  // "process is not defined" at load, before customElements.define runs, so
  // the element never upgrades. Hard-code production here.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': '{}',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'AssetKit',
      formats: ['iife'],
      fileName: () => 'asset-kit.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
    // CSS injected by JS so a single <script> tag is all the host needs.
    cssCodeSplit: false,
    emptyOutDir: true,
  },
});
