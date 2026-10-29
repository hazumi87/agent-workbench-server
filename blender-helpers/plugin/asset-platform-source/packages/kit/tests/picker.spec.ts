// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// A3 acceptance for the legacy-mode <asset-picker> (consumed by demucs /
// audio-normalize / voice-filter): renders the /api/list clip list in light DOM,
// selecting a row emits 'asset-picker:select' with {id,label,url,duration_s,source}.
import { test, expect } from '@playwright/test';
import { startMock, type MockHandle } from './mock-clipboard-server';

let mock: MockHandle;
test.beforeAll(async () => {
  mock = await startMock();
});
test.afterAll(async () => {
  await new Promise<void>((r) => mock.server.close(() => r()));
});

test('asset-picker: lists clips, selection emits the vanilla onSelect payload', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __sel: unknown }).__sel = null;
    document.addEventListener('asset-picker:select', (e) => {
      (window as unknown as { __sel: unknown }).__sel = (e as CustomEvent).detail;
    });
  });
  await page.goto(`${mock.origin}/picker.html`);

  // seed two clips via the mock upload, then refresh the picker
  await page.evaluate(async () => {
    const base = '/asset-management/library';
    for (let i = 0; i < 2; i++) {
      const fd = new FormData();
      fd.append('file', new File([new Uint8Array([1, 2, 3])], `p${i}.wav`, { type: 'audio/wav' }));
      await fetch(`${base}/api/upload`, { method: 'POST', body: fd });
    }
  });
  await page.locator('asset-picker .ap-refresh').click();

  const rows = page.locator('asset-picker .ap-row');
  await expect(rows).toHaveCount(2);
  expect(await page.evaluate(() => document.querySelector('asset-picker')!.shadowRoot === null)).toBe(true);

  // select first row by clicking its label (the audio player stops propagation,
  // by design, so click the row's label area — the real selection affordance).
  await rows.first().locator('.ap-row-label').click();
  await expect(rows.first()).toHaveClass(/ap-selected/);
  const sel = await page.evaluate(
    () => (window as unknown as { __sel: { id: string; label: string; url: string } }).__sel,
  );
  expect(sel.id).toBeTruthy();
  expect(sel.label).toBeTruthy();
  expect(sel.url).toContain('/api/clip/');
});
