'use strict';
// The foundation enumerates .js entry points; esbuild bundles the ESM implementation.
module.exports = { register: require('./capabilities.mjs').register };
