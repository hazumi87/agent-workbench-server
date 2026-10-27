// Inline raster profile only; the engine's cap is 256 KiB of decoded image bytes.
const { createHash } = require('node:crypto');
function profilePicture(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(256 * 1024 / 3) + 32) return null;
  const match = /^data:image\/(?:png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
  if (!match || !match[1]) return null;
  const bytes = match[1].length / 4 * 3 - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0);
  return bytes <= 256 * 1024 ? value : null;
}
const profilePictureKey = value => value ? createHash('sha256').update(value).digest('hex') : null;
module.exports = { profilePicture, profilePictureKey };
