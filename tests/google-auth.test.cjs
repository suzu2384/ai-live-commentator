const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GoogleAuth,SCOPES}=require('../google-auth.js');
const CLIENT='123-abc.apps.googleusercontent.com';
function mock(){
 const records=new Map(),sessions=new Map(),requests=[],calls=[];
 let email='first@example.com',channel='UC'+'x'.repeat(22);
 globalThis.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 globalThis.sessionStorage={getItem:k=>sessions.get(k)||null,setItem:(k,v)=>sessions.set(k,v),removeItem:k=>sessions.delete(k)};
 globalThis.fetch=async(url,options)=>{
  calls.push(url);
  if(url.includes('/youtube/v3/channels'))return {ok:true,json:async()=>({items:[{id:channel,snippet:{title:'ブランド配信チャンネル'}}]})};
  throw Error('Unexpected endpoint (email retrieval is not required): '+url);
 };
 globalThis.google={accounts:{oauth2:{
  initTokenClient:config=>({requestAccessToken:options=>{
   requests.push({scopes:config.scope.split(' '),prompt:options.prompt,includeGranted:config.include_granted_scopes});
   config.callback({access_token:'token-'+requests.length,expires_in:3600,scope:config.scope});
  }}),
  hasGrantedAllScopes:(r,...scopes)=>scopes.every(s=>r.scope.split(' ').includes(s))
 }}};
 return {records,sessions,requests,calls,setChannel:value=>channel=value,setEmail:value=>email=value};
}
test('brand account connects without email or Drive permission',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube']);
 assert.deepEqual(m.requests[0].scopes,[SCOPES.youtube]);
 assert.equal(m.requests[0].includeGranted,false);
 assert.equal(m.requests[0].prompt,'select_account');
 assert.equal(auth.channel.id,'UC'+'x'.repeat(22));
 assert.equal(auth.channel.title,'ブランド配信チャンネル');
 assert.ok(auth.token('youtube'));
 assert.ok(m.calls.every(url=>url.includes('/youtube/v3/channels')));
});
test('Drive does not retrieve or compare email even after YouTube auth',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube']);
 await auth.authorize(['drive']);
 assert.deepEqual(m.requests[1].scopes,[SCOPES.drive]);
 assert.equal(m.calls.length,1);
 assert.deepEqual(auth.services().sort(),['drive','youtube']);
 const refreshed=new GoogleAuth(CLIENT);
 assert.ok(refreshed.token('drive')&&refreshed.token('youtube'));
 assert.equal(refreshed.channel.id,auth.channel.id);
 assert.equal(m.requests.length,2);
});
test('expired services are independently reauthorized, no mixed permission request',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube','drive']);
 assert.deepEqual(m.requests.map(r=>r.scopes),[[SCOPES.youtube],[SCOPES.drive]]);
 auth.tokens.youtube.expires=Date.now()-1;
 await auth.authorize(['youtube','drive']);
 assert.deepEqual(m.requests[2].scopes,[SCOPES.youtube]);
 auth.tokens.youtube.expires=Date.now()-1;auth.tokens.drive.expires=Date.now()-1;
 await auth.authorize(['youtube','drive']);
 assert.deepEqual(m.requests.slice(-2).map(r=>r.scopes),[[SCOPES.youtube],[SCOPES.drive]]);
 assert.notEqual(auth.token('youtube'),auth.token('drive'));
});
test('different YouTube channel requires disconnection, Drive remains active',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube','drive']);
 m.setChannel('UC'+'y'.repeat(22));auth.tokens.youtube.expires=Date.now()-1;
 await assert.rejects(auth.authorize(['youtube']),/異なるYouTubeチャンネル/);
 assert.ok(auth.token('drive'));
 auth.disconnect('youtube');await auth.authorize(['youtube']);
 assert.equal(auth.channel.id,'UC'+'y'.repeat(22));
 assert.ok(auth.token('drive'));
});
test('opted-in session resumes both scoped tokens but not old unverified YouTube tokens',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube','drive']);
 auth.setKeepConnected(true);m.sessions.clear();
 let restored=new GoogleAuth(CLIENT);
 assert.ok(restored.token('youtube')&&restored.token('drive'));
 restored.tokens.youtube.expires=Date.now()-1;restored.tokens.drive.expires=Date.now()-1;
 restored.saveTokens();
 restored=new GoogleAuth(CLIENT);
 assert.equal(restored.token('youtube'),'');
 assert.equal(restored.token('drive'),'');
 m.sessions.set('minkome-google-session-v1',JSON.stringify({version:1,clientId:CLIENT,email:'old@example.com',tokens:{
  youtube:{value:'old-youtube',expires:Date.now()+900000,scope:SCOPES.youtube},
  drive:{value:'old-drive',expires:Date.now()+900000,scope:SCOPES.drive}
 }}));
 restored=new GoogleAuth(CLIENT);
 assert.equal(restored.token('youtube'),''); // old authorization may target a personal channel
 assert.equal(restored.token('drive'),'old-drive'); // avoid another Drive prompt
});
