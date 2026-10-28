/* Encrypted, device-local Gemini API key cache (no passphrase; opt-out supported). */
(function(root){
 'use strict';
 const CIPHER='minkome-gemini-key-cipher-v1',DATABASE='minkome-device-crypto-v1',STORE='keys',KEY_ID='gemini';
 let cryptoKeyPromise=null;
 const encoded=bytes=>btoa(String.fromCharCode(...bytes));
 const decoded=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
 function readKey(){
  return new Promise((resolve,reject)=>{
   if(!root.indexedDB||!root.crypto?.subtle) return reject(Error('このブラウザでは安全な端末内保存が利用できません。'));
   const request=root.indexedDB.open(DATABASE,1);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
   request.onerror=()=>reject(Error('暗号鍵の保存領域に接続できません。'));
   request.onsuccess=()=>{
    const db=request.result;
    const tx=db.transaction(STORE,'readonly'),get=tx.objectStore(STORE).get(KEY_ID);
    get.onerror=()=>{db.close();reject(Error('暗号鍵を読み込めません。'));};
    get.onsuccess=async()=>{
     if(get.result){db.close();resolve(get.result);return;}
     try{
      const key=await root.crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      const write=db.transaction(STORE,'readwrite'),put=write.objectStore(STORE).put(key,KEY_ID);
      put.onerror=()=>reject(Error('暗号鍵を保存できません。'));
      write.oncomplete=()=>{db.close();resolve(key);};
      write.onerror=()=>{db.close();reject(Error('暗号鍵を保存できません。'));};
     }catch(e){db.close();reject(e);}
    };
   };
  });
 }
 function deviceKey(){
  if(!cryptoKeyPromise)cryptoKeyPromise=readKey().catch(error=>{cryptoKeyPromise=null;throw error;});
  return cryptoKeyPromise;
 }
 async function save(value){
  const key=await deviceKey(),iv=root.crypto.getRandomValues(new Uint8Array(12));
  const cipher=new Uint8Array(await root.crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value)));
  root.localStorage.setItem(CIPHER,JSON.stringify({version:1,iv:encoded(iv),data:encoded(cipher)}));
 }
 async function restore(){
  let stored;try{stored=JSON.parse(root.localStorage.getItem(CIPHER)||'null');}catch{return '';}
  if(stored?.version!==1||typeof stored.iv!=='string'||typeof stored.data!=='string')return '';
  try{
   const bytes=await root.crypto.subtle.decrypt({name:'AES-GCM',iv:decoded(stored.iv)},await deviceKey(),decoded(stored.data));
   return new TextDecoder().decode(bytes);
  }catch{return '';}
 }
 function clear(){root.localStorage.removeItem(CIPHER);}
 root.LiveLocalGeminiKey={save,restore,clear};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.LiveLocalGeminiKey;
})(globalThis);
