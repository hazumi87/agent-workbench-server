// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// A3 acceptance for the yt-audio porting surface: <asset-picker-panel> renders the
// url-history grid + exported-clips list in light DOM, tabs switch, and a card
// click bubbles 'asset-picker:select' with the entry. This is the WC-mount path
// that replaces yt-audio's window.AssetPicker.mount(tabs:[…]) call.
import { test, expect } from '@playwright/test';
import { startMock, type MockHandle } from './mock-clipboard-server';

let mock: MockHandle;
test.beforeAll(async () => {
  mock = await startMock();
});
test.afterAll(async () => {
  await new Promise<void>((r) => mock.server.close(() => r()));
});

test('asset-picker-panel: url-history + exported-clips tabs in light DOM, select event', async ({ page }) => {
  await page.goto(`${mock.origin}/picker-panel.html`);

  const host = page.locator('asset-picker-panel');
  await expect(host).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('asset-picker-panel')!.shadowRoot === null)).toBe(true);

  // default tab = History → 2 url-history cards
  const cards = page.locator('asset-picker-panel .ap-hist-card');
  await expect(cards).toHaveCount(2);

  // selection bubbles as 'asset-picker:select' with the history entry
  await page.addInitScript(() => {
    (window as unknown as { __picked: unknown }).__picked = null;
    document.addEventListener('asset-picker:select', (e) => {
      (window as unknown as { __picked: unknown }).__picked = (e as CustomEvent).detail;
    });
  });
  await page.reload(); // ensure init script is in place before bundle runs
  await expect(page.locator('asset-picker-panel .ap-hist-card')).toHaveCount(2);
  await page.locator('asset-picker-panel .ap-hist-card').first().click();
  const picked = await page.evaluate(() => (window as unknown as { __picked: { tab: string; entry: { url: string } } }).__picked);
  expect(picked.tab).toBe('History');
  expect(picked.entry.url).toContain('youtu.be');

  // switch to Clips tab → exported-clips list with the shared audio player
  await page.locator('asset-picker-panel .ap-tab', { hasText: 'Clips' }).click();
  await expect(page.locator('asset-picker-panel .ap-clips-list .ap-row')).toHaveCount(1);
  await expect(page.locator('asset-picker-panel .ap-clips-list audio.ap-audio')).toHaveCount(1);
});
