'use strict';
// A small Buffer for the rooms core in the browser: the calls it makes (from, concat, byteLength,
// isBuffer, toString utf8/base64), nothing else. A Uint8Array underneath, so fetch bodies take it as is.
class Buffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') {
      if (encoding === 'base64') {
        const bin = atob(value);
        const out = new Buffer(bin.length);
        for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
      }
      const bytes = new TextEncoder().encode(value);
      const out = new Buffer(bytes.length);
      out.set(bytes);
      return out;
    }
    if (value instanceof ArrayBuffer) return new Buffer(value);
    if (ArrayBuffer.isView(value) || Array.isArray(value)) {
      const out = new Buffer(value.length);
      out.set(value);
      return out;
    }
    throw new TypeError('Buffer.from: unsupported value');
  }
  static alloc(n) { return new Buffer(n); }
  static isBuffer(v) { return v instanceof Buffer; }
  static byteLength(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value).length;
    return value.byteLength;
  }
  static concat(list) {
    const total = list.reduce((n, b) => n + b.length, 0);
    const out = new Buffer(total);
    let at = 0;
    for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  }
  toString(encoding) {
    if (encoding === 'base64') {
      let bin = '';
      for (let i = 0; i < this.length; i += 0x8000) bin += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    return new TextDecoder('utf-8').decode(this);
  }
}
module.exports = { Buffer };
