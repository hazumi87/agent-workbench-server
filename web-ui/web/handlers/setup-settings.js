'use strict';
// The foundation enumerates .js entry points; esbuild bundles the ESM implementation.
module.exports = { register: require('./setup-settings.mjs').register };
