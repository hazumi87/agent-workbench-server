// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — vk task 1a
import { defineConfig } from '@playwright/test';

// Spike-2 runs against the built dist/ + local fixtures over a static server.
// python3 -m http.server is already on the server host (no extra dep). The 1b
// clipboard spec runs against the LIVE gateway and has its own config
// (playwright.gateway.config.ts).
export default defineConfig({
  testDir: './tests',
  testMatch: 'spike-hello.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:4410',
    headless: true,
  },
  webServer: {
    command: 'python3 -m http.server 4410 --directory .',
    url: 'http://127.0.0.1:4410/tests/fixture-spike-hello.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
