// Presentation policy only. The engine remains authoritative for settings and launch modes.
const modes = new Set(['on', 'off']);
const settings = new Set(['follow', ...modes]);
const invalid = () => { throw new Error('invalid-response'); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
export const serverFolder = value => text(value) && value.startsWith('/') && !value.split('/').some(part => part === '.' || part === '..');

const hasDisclosure = stamp => {
  if (stamp === null || stamp === undefined) return false;
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp < 0) throw new Error('invalid-disclosure');
  return true;
};
export function defaultRequest(value, acknowledged = false, disclosedAt = null) {
  if (!modes.has(value)) throw new Error('invalid-default');
  const recorded = hasDisclosure(disclosedAt);
  if (value === 'on' && !recorded && acknowledged !== true) throw new Error('disclosure-required');
  return {default: value, ...(acknowledged === true ? {disclosed:true} : {})};
}
export function recipeApproval(setting = 'follow', defaultValue = 'off') {
  if (!settings.has(setting) || !modes.has(defaultValue)) throw new Error('invalid-recipe');
  return {setting, effective: setting === 'follow' ? defaultValue : setting};
}
export function recipeApprovalPatch(setting, disclosedAt = null, acknowledged = false) {
  setting = recipeApproval(setting).setting;
  const recorded = hasDisclosure(disclosedAt);
  if (setting === 'on' && !recorded && acknowledged !== true) throw new Error('disclosure-required');
  return {autoApprove:setting, ...(setting === 'on' && !recorded && acknowledged === true ? {disclosed:true} : {})};
}
export function approvalSnapshot(value) {
  if (!value || !modes.has(value.default) || !Array.isArray(value.recipes) || value.recipes.length > 10000) invalid();
  const seen = new Set();
  const recipes = value.recipes.map(row => {
    if (!row || !text(row.id) || seen.has(row.id) || !settings.has(row.setting)) invalid();
    seen.add(row.id);
    const resolved = recipeApproval(row.setting, value.default);
    if (row.effective !== resolved.effective) invalid();
    if (row.name !== undefined && !text(row.name)) invalid();
    return {id: row.id, ...resolved, ...(row.name !== undefined ? {name:row.name} : {})};
  });
  const stamp = value.autoApproveDisclosedAt ?? null;
  if (stamp !== null && !(typeof stamp === 'number' && Number.isFinite(stamp) && stamp >= 0)) invalid();
  return {default: value.default, autoApproveDisclosedAt: stamp, recipes};
}
export function trustSnapshot(value) {
  if (!value || !Array.isArray(value.folders) || value.folders.length > 10000) invalid();
  const seen = new Set();
  return value.folders.map(row => {
    if (!row || !serverFolder(row.path) || seen.has(row.path) || (row.by !== null && !text(row.by))) invalid();
    if (!(typeof row.trustedAt === 'number' && Number.isFinite(row.trustedAt) && row.trustedAt >= 0) && !text(row.trustedAt)) invalid();
    seen.add(row.path);
    return {path: row.path, trustedAt: row.trustedAt, by: row.by};
  });
}
