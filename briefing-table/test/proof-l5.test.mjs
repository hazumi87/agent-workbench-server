/** L5: public health is status-only; node information and presets require sign-in. */
import { proof, scratchEngine } from './_hosting-proof.mjs';
await proof('L5', async check => {
  const engine = await scratchEngine();
  try {
    const health = await engine.request('/health', { signedIn: false });
    check(health.status === 200 && JSON.stringify(health.body) === '{"status":"ok"}', 'public health is exactly status=ok with no additional fields');
    for (const path of ['/api/node', '/vendor/aurora-logo-presets.js']) {
      const anonymous = await engine.request(path, { signedIn: false });
      check(anonymous.status === 401, `${path} refuses anonymous reads`);
      check(!anonymous.text.includes('LOGO_PRESETS') && !anonymous.body?.node && !anonymous.body?.targets, `${path} leaks no protected response`);
      const signedIn = await engine.request(path);
      check(signedIn.status === 200, `${path} works when signed in (positive control)`);
    }
  } finally { await engine.close(); }
});
