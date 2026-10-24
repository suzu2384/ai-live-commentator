const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GoogleAuth,SCOPES}=require('../google-auth.js');
function mock(){
 const records=new Map(),sessions=new Map(),requests=[];
 globalThis.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 globalThis.sessionStorage={getItem:k=>sessions.get(k)||null,setItem:(k,v)=>sessions.set(k,v),removeItem:k=>sessions.delete(k)};
 requests.records=records;requests.sessions=sessions;
 globalThis.fetch=async()=>({ok:true,json:async()=>({email:'minkome-test@example.com'})});
 globalThis.google={accounts:{oauth2:{
  initTokenClient:config=>({requestAccessToken:()=>{
   requests.push(config.scope.split(' '));
   config.callback({access_token:'token-'+requests.length,expires_in:3600,scope:config.scope});
  }}),
  hasGrantedAllScopes:(response,...scopes)=>scopes.every(s=>response.scope.split(' ').includes(s))
 }}};
 return requests;
}
test('YouTube and Drive can be connected separately and renewed together',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube']);
 assert.ok(auth.token('youtube'));
 assert.equal(auth.isLinked('drive'),false);
 assert.ok(!requests[0].includes(SCOPES.drive));
 await auth.authorize(['drive']);
 assert.deepEqual(auth.services().sort(),['drive','youtube']);
 assert.ok(!requests[1].includes(SCOPES.youtube));
 await auth.authorize(auth.services());
 assert.ok(requests[2].includes(SCOPES.drive)&&requests[2].includes(SCOPES.youtube));
 assert.equal(auth.token('drive'),auth.token('youtube'));
 auth.disconnect('drive');
 assert.ok(auth.token('youtube'));
 await auth.authorize(auth.services());
 assert.ok(!requests[3].includes(SCOPES.drive));
});
test('still-valid OAuth sessions survive page reload without another Google authorization',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube','drive']);
 const next=new GoogleAuth('123-abc.apps.googleusercontent.com');
 assert.deepEqual(next.services().sort(),['drive','youtube']);
 assert.ok(next.token('drive')&&next.token('youtube'));
 assert.equal(requests.length,1);
 assert.equal(requests.records.has('minkome-google-persistent-token-v1'),false);
 next.disconnect('drive');
 const third=new GoogleAuth('123-abc.apps.googleusercontent.com');
 assert.equal(third.token('drive'),'');
 assert.ok(third.token('youtube'));
});
test('opt-in keeps valid tokens after closing a tab; expiry requires user action',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube','drive']);
 auth.setKeepConnected(true);
 assert.equal(auth.keepConnected,true);
 requests.sessions.clear();
 const reopened=new GoogleAuth('123-abc.apps.googleusercontent.com');
 assert.ok(reopened.token('drive')&&reopened.token('youtube'));
 assert.equal(requests.length,1);
 reopened.tokens.drive.expires=Date.now()-1;
 reopened.tokens.youtube.expires=Date.now()-1;
 reopened.saveTokens();
 const expired=new GoogleAuth('123-abc.apps.googleusercontent.com');
 assert.equal(expired.token('drive'),'');
 assert.equal(expired.token('youtube'),'');
 assert.deepEqual(expired.services().sort(),['drive','youtube']);
 expired.setKeepConnected(false);
 assert.equal(expired.keepConnected,false);
 assert.equal(requests.records.has('minkome-google-persistent-token-v1'),false);
});
test('token persistence is never reused under a different OAuth client',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube']);
 auth.setKeepConnected(true);
 const changed=new GoogleAuth('555-changed.apps.googleusercontent.com');
 assert.equal(changed.token('youtube'),'');
});
test('a different Google account cannot be used when another service is linked',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube']);
 globalThis.fetch=async()=>({ok:true,json:async()=>({email:'wrong@example.com'})});
 await assert.rejects(auth.authorize(['drive']),/別のGoogleアカウント/);
 assert.equal(auth.isLinked('drive'),false);
 assert.equal(requests.length,2);
});
