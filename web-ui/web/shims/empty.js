'use strict';
// http and https for modules that only import them: the browser client never uses node's.
const refuse = () => { throw new Error('node http is not available in the browser build'); };
module.exports = { request: refuse, get: refuse };
