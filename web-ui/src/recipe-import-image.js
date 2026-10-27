'use strict';
function validRaster(value){
 if(value==null||value==='')return null;
 if(typeof value!=='string'||value.length>350000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value))throw Error('That recipe picture is not valid.');
 let binary;try{binary=atob(value.slice(22));}catch{throw Error('That recipe picture is not valid.');}
 const b=Uint8Array.from(binary,c=>c.charCodeAt(0));
 const signature=[137,80,78,71,13,10,26,10];
 if(b.length<24||b.length>262144||signature.some((v,i)=>b[i]!==v)||String.fromCharCode(...b.subarray(12,16))!=='IHDR')throw Error('That recipe picture is too large or is not PNG.');
 const header=new DataView(b.buffer,b.byteOffset,b.byteLength),width=header.getUint32(16),height=header.getUint32(20);
 if(width<1||height<1||width>256||height>256)throw Error('That recipe picture is too large or is not PNG.');
 return value;
}
module.exports={validRaster};
