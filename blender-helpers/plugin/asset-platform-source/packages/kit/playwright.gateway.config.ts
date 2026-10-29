// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task; A2 multi-spec task
import { defineConfig } from '@playwright/test';

// Component acceptance specs (1b clipboard parity + A2 theme override). Each spec
// starts its own combined mock server (API + static fixture/bundle) on an
// OS-assigned ephemeral port — single origin, no CORS, no registry-managed port
// squatted, no separate webServer. Build dist first (pnpm --filter @asset/kit
// build). Pollution-free; live gateway wiring is verified separately, read-only.
export default defineConfig({
  testDir: './tests',
  testMatch: /(asset-clipboard|theme-override|audio-player|picker-panel|picker)\.spec\.ts$/,
  use: { headless: true },
  // Serialize: each spec stands up its own mock server + drives an Add-menu whose
  // onBlur auto-closes; running in parallel introduced focus/timing races. These
  // are quick integration specs — one worker is plenty and deterministic.
  workers: 1,
});
