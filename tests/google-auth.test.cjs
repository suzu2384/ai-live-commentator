const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GoogleAuth,SCOPES}=require('../google-auth.js');
function mock(){
 const records=new Map(),requests=[];
 globalThis.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
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
test('linked services survive reload as consent markers without storing tokens',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube','drive']);
 const next=new GoogleAuth('123-abc.apps.googleusercontent.com');
 assert.deepEqual(next.services().sort(),['drive','youtube']);
 assert.equal(next.token('drive'),'');
 assert.equal(next.token('youtube'),'');
 await next.authorize(next.services());
 assert.ok(next.token('drive')&&next.token('youtube'));
 assert.equal(requests.length,2);
});
test('a different Google account cannot be used when another service is linked',async()=>{
 const requests=mock(),auth=new GoogleAuth('123-abc.apps.googleusercontent.com');
 await auth.authorize(['youtube']);
 globalThis.fetch=async()=>({ok:true,json:async()=>({email:'wrong@example.com'})});
 await assert.rejects(auth.authorize(['drive']),/別のGoogleアカウント/);
 assert.equal(auth.isLinked('drive'),false);
 assert.equal(requests.length,2);
});
