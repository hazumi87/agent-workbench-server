// Display projection only. The engine validates archives and owns consent/admission.
export const MAX_ENTRIES = 500;
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,60}$/.test(value) && !value.includes('..');
export const validCheckId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const text = (value, cap=1000) => typeof value === 'string' && value.length>0 && value.length<=cap && !/[\x00-\x1f]/.test(value);
const fail = () => {throw {code:'unconfirmed'};};
export function checkSummary(input) {
  if(!input || !validCheckId(input.checkId) || !validId(input.plugin?.id) || !text(input.plugin.name,200) || !text(input.plugin.version,100))fail();
  if(!Array.isArray(input.files) || input.files.length<1 || input.files.length>MAX_ENTRIES || !Array.isArray(input.permissions) || input.permissions.length>100 || !Array.isArray(input.warnings) || input.warnings.length>100)fail();
  const paths=new Set();let total=0;
  const files=input.files.map(file=>{
    if(!file || !text(file.path,200) || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(p=>!p || p==='.' || p==='..') || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes<0)fail();
    paths.add(file.path);total+=file.bytes;if(total>MAX_UNPACKED_BYTES)fail();return {path:file.path,sha256:file.sha256,bytes:file.bytes};
  });
  if(input.permissions.some(p=>!text(p,200)) || new Set(input.permissions).size!==input.permissions.length || input.warnings.some(p=>!text(p)))fail();
  let replaces;
  if(input.replaces !== undefined){
    const old=input.replaces;
    if(!old || !text(old.version,100) || !Array.isArray(old.permissions) || old.permissions.length>100 || old.permissions.some(p=>!text(p,200)) || new Set(old.permissions).size!==old.permissions.length)fail();
    replaces={version:old.version,permissions:[...old.permissions]};
  }
  return {...(replaces?{replaces}:{}),checkId:input.checkId,plugin:{id:input.plugin.id,name:input.plugin.name,version:input.plugin.version},files,permissions:[...input.permissions],warnings:[...input.warnings]};
}
// Same consent wording as module-consent.js, with the hosted-server terminology.
const words={
  'concierge.send':'send messages as you through Concierge',
  'concierge.read':'read your Concierge conversations',
  'rooms.tasks.read':"read your rooms' tasks",
  'rooms.tasks.write':"add and change your rooms' tasks",
  'rooms.tasks.delete':"delete your rooms' tasks",
  service:'run a program in the background on this server',
  storage:'store data for this tool on this server',
  'ui.widget':'show a panel in Workbench',
  microphone:"use the microphone",
};
export const permissionWords = permission => words[permission] || `Permission: ${permission}`;
export const RESIDUAL = 'A tool can send data you let it read to other sites. Only allow tools you trust.';
export const OFF = 'Installing tools is off on this server.';
export const MICROPHONE = "It needs the microphone, which this version doesn't have.";
