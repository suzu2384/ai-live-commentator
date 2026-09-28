/* Local encrypted credentials. No passphrase or derived key is persisted. */
(function(root){
  'use strict';
  const iterations=600000, encoder=new TextEncoder(), decoder=new TextDecoder();
  const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
  function decode(s,max){
    if(typeof s!=='string'||s.length>max||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw new Error('Invalid vault');
    return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  }
  async function key(pass,salt){
    const material=await crypto.subtle.importKey('raw',encoder.encode(pass),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function seal(credentials,pass){
    if(typeof pass!=='string'||pass.length<12||pass.length>200)throw new Error('合言葉は12〜200文字にしてください。');
    if(typeof credentials.apiKey!=='string'||typeof credentials.obsPassword!=='string'||credentials.apiKey.length>4096||credentials.obsPassword.length>4096)throw new Error('保存する情報が長すぎます。');
    const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
    const data=encoder.encode(JSON.stringify({apiKey:credentials.apiKey,obsPassword:credentials.obsPassword}));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('ai-live-commentator:v1')},await key(pass,salt),data);
    data.fill(0);return {version:1,iterations,salt:encode(salt),iv:encode(iv),ciphertext:encode(ciphertext)};
  }
  async function open(v,pass){
    try{
      if(v?.version!==1||v.iterations!==iterations||typeof pass!=='string'||pass.length>200)throw new Error();
      const salt=decode(v.salt,24),iv=decode(v.iv,16),ciphertext=decode(v.ciphertext,70000);
      if(salt.length!==16||iv.length!==12)throw new Error();
      const clear=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode('ai-live-commentator:v1')},await key(pass,salt),ciphertext));
      let data;try{data=JSON.parse(decoder.decode(clear));}finally{clear.fill(0);}
      if(typeof data.apiKey!=='string'||typeof data.obsPassword!=='string')throw new Error();
      return {apiKey:data.apiKey,obsPassword:data.obsPassword};
    }catch{throw new Error('解除できません。合言葉、または保存データを確認してください。');}
  }
  root.LiveVault={seal,open};if(typeof module!=='undefined')module.exports=root.LiveVault;
})(globalThis);
