import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,writeFileSync,unlinkSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'wb-markup-store-'));
process.env.HARBOR_WB_TABLE=join(root,'table.db');
process.env.HARBOR_WB_ROOM_SCRATCH_DIR=join(root,'scratch');
process.env.HARBOR_WB_IDENTITY='legacy';process.env.HARBOR_WB_FABRIC_URL='';process.env.HARBOR_WB_NATS_URL='';
const {table}=await import('../src/table/endpoint.ts');
const scratch=await import('../src/engine/room-scratch.ts');
const room=table.createRoom({name:'Markup'},{actor:'user'}).result;
const parent=scratch.newId();scratch.write(parent,Buffer.from('image'));
table.addRoomScratch({id:parent,userKey:'person-a',roomId:room.id,name:'photo.png',type:'image/png',size:5},1);
const add=(id:string,extra={})=>table.addRoomScratch({id,userKey:'person-a',roomId:room.id,name:'photo.png.annotations.svg',type:'image/svg+xml',size:3,companionOf:parent,...extra},1);
test.after(()=>rmSync(root,{recursive:true,force:true}));
test('bound companion bypasses tile count but not ownership/uniqueness',()=>{const id=scratch.newId();add(id);assert.equal(table.countRoomScratch('person-a',room.id),1);assert.equal(table.getRoomScratch('person-a',room.id,id)?.companion_of,parent);assert.throws(()=>add(scratch.newId()),/companion-exists/);assert.throws(()=>add(scratch.newId(),{userKey:'other'}),/companion-invalid/);assert.equal(table.getRoomScratch('other',room.id,id),undefined);});
test('strong revision and synchronous replacement preserve bytes on stale tag and commit failure',()=>{const id=scratch.newId(),old=Buffer.from('old'),next=Buffer.from('new');scratch.write(id,old);const tag=scratch.etag(old);assert.equal(scratch.replace(id,next,'"wrong"',()=>{}),false);assert.deepEqual(scratch.read(id),old);assert.throws(()=>scratch.replace(id,next,tag,()=>{throw Error('synthetic row failure');}),/synthetic row failure/);assert.deepEqual(scratch.read(id),old);assert.equal(scratch.replace(id,next,tag,()=>{}),true);assert.equal(scratch.replace(id,old,tag,()=>{}),false);assert.deepEqual(scratch.read(id),next);assert.ok(readdirSync(scratch.dir()).every(n=>!n.includes('.replace-')&&!n.includes('.rollback-')));});
test('planted symlink is never read or replaced and invalid ids never escape root',()=>{const id=scratch.newId(),outside=join(root,'outside');writeFileSync(outside,'sentinel');symlinkSync(outside,join(scratch.dir(),id));assert.equal(scratch.read(id),null);assert.equal(scratch.replace(id,Buffer.from('change'),scratch.etag(Buffer.from('sentinel')),()=>{}),false);assert.equal(readFileSync(outside,'utf8'),'sentinel');assert.throws(()=>scratch.write('../outside',Buffer.from('change')));assert.equal(readFileSync(outside,'utf8'),'sentinel');unlinkSync(join(scratch.dir(),id));});

// the suite runner (scripts/run-tests.mjs) needs a PASS n FAIL m line; node:test prints its own format
process.on('exit', (code) => console.log(`\nPASS ${code === 0 ? 3 : 0} FAIL ${code === 0 ? 0 : 1}`));
