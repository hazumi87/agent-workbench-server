'use strict';
// The few process fields the rooms core and the preload read. No WB_SELFTEST, no WB_ROOMS_URL: the browser
// has one origin. argv carries the feature flags the desktop passes to the preload (web/features.json).
const meta = (typeof globalThis !== 'undefined' && globalThis.__WB_WEB__) || {};
module.exports = { env: {}, platform: 'linux', argv: Array.isArray(meta.argv) ? meta.argv.slice() : [], versions: {} };
