// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// A3 acceptance for the shared audio player: <asset-audio-player> renders a
// native <audio controls> into LIGHT DOM at parity with the vanilla picker inline
// player (preload=none, crossorigin=anonymous, the resolved src, .ap-audio class).
import { test, expect } from '@playwright/test';
import { startMock, type MockHandle } from './mock-clipboard-server';

let mock: MockHandle;
test.beforeAll(async () => {
  mock = await startMock();
});
test.afterAll(async () => {
  await new Promise<void>((r) => mock.server.close(() => r()));
});

test('asset-audio-player renders a native <audio> in light DOM at parity', async ({ page }) => {
  await page.goto(`${mock.origin}/audio-player.html`);

  const host = page.locator('asset-audio-player');
  await expect(host).toBeVisible();

  const probe = await page.evaluate(() => {
    const el = document.querySelector('asset-audio-player')!;
    const audio = el.querySelector('audio') as HTMLAudioElement | null;
    return {
      hasShadow: el.shadowRoot !== null,
      tag: audio?.tagName ?? null,
      controls: audio?.controls ?? null,
      preload: audio?.getAttribute('preload') ?? null,
      crossorigin: audio?.getAttribute('crossorigin') ?? null,
      cls: audio?.className ?? null,
      srcEndsWith: audio?.getAttribute('src')?.endsWith('/api/clip/x') ?? false,
    };
  });

  expect(probe.hasShadow).toBe(false); // light DOM
  expect(probe.tag).toBe('AUDIO');
  expect(probe.controls).toBe(true);
  expect(probe.preload).toBe('none');
  expect(probe.crossorigin).toBe('anonymous');
  expect(probe.cls).toBe('ap-audio');
  expect(probe.srcEndsWith).toBe(true);
});
