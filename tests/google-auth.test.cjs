const {test}=require('node:test');
const assert=require('node:assert/strict');
const {GoogleAuth,SCOPES,preferredAccount}=require('../google-auth.js');
const CLIENT='123-abc.apps.googleusercontent.com';
const YOUTUBE_SCOPES=SCOPES.youtube.split(' ');
async function connectBoth(auth){
 await auth.authorize(['youtube']);
 await auth.authorize(['drive']);
}
function mock(){
 const records=new Map(),sessions=new Map(),requests=[],calls=[];
 let youtubeEmail='creator@example.com',driveEmail='storage@example.com',channel='UC'+'x'.repeat(22),emailFailure=false;
 globalThis.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 globalThis.sessionStorage={getItem:k=>sessions.get(k)||null,setItem:(k,v)=>sessions.set(k,v),removeItem:k=>sessions.delete(k)};
 globalThis.fetch=async(url)=>{
  calls.push(url);
  if(url.includes('/youtube/v3/channels'))return {ok:true,json:async()=>({items:[{id:channel,snippet:{title:'ブランド配信チャンネル'}}]})};
  if(url.includes('/oauth2/v3/userinfo'))return {ok:!emailFailure,json:async()=>({email:youtubeEmail})};
  if(url.includes('/drive/v3/about'))return {ok:!emailFailure,json:async()=>({user:{emailAddress:driveEmail}})};
  throw Error('Unexpected endpoint: '+url);
 };
 globalThis.google={accounts:{oauth2:{
  initTokenClient:config=>({requestAccessToken:options=>{
   requests.push({scopes:config.scope.split(' '),prompt:options.prompt,login_hint:config.login_hint||'',includeGranted:config.include_granted_scopes});
   config.callback({access_token:'token-'+requests.length,expires_in:3600,scope:config.scope});
  }}),
  hasGrantedAllScopes:(r,...scopes)=>scopes.every(s=>r.scope.split(' ').includes(s))
 }}};
 return {records,sessions,requests,calls,setChannel:v=>channel=v,setYoutubeEmail:v=>youtubeEmail=v,setDriveEmail:v=>driveEmail=v,setEmailFailure:v=>emailFailure=v};
}
test('brand channel connects separately and records its Google account hint',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube']);
 assert.deepEqual(m.requests[0].scopes,YOUTUBE_SCOPES);
 assert.equal(m.requests[0].prompt,'select_account');
 assert.equal(m.requests[0].login_hint,'');
 assert.equal(m.requests[0].includeGranted,false);
 assert.equal(auth.channel.id,'UC'+'x'.repeat(22));
 assert.ok(auth.token('youtube'));
 assert.equal(preferredAccount(CLIENT,'youtube'),'creator@example.com');
 assert.ok(m.calls.some(url=>url.includes('/youtube/v3/channels')));
});
test('Drive and YouTube remember their own accounts without enforcing equal email',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube']);
 await auth.authorize(['drive']);
 assert.deepEqual(m.requests[1].scopes,[SCOPES.drive]);
 assert.equal(preferredAccount(CLIENT,'drive'),'storage@example.com');
 assert.equal(preferredAccount(CLIENT,'youtube'),'creator@example.com');
 assert.deepEqual(auth.services().sort(),['drive','youtube']);
 const restored=new GoogleAuth(CLIENT);
 assert.ok(restored.token('drive')&&restored.token('youtube'));
});
test('account hint prevents repetitive account selection, even on explicit reconnect',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await connectBoth(auth);
 const token=auth.token('youtube');
 await assert.rejects(auth.authorize(['drive','youtube'],{force:true}),/別々に操作/);
 await auth.authorize(['youtube'],{force:true});
 await auth.authorize(['drive'],{force:true});
 assert.equal(m.requests[2].login_hint,'creator@example.com');
 assert.equal(m.requests[2].prompt,'');
 assert.equal(m.requests[3].login_hint,'storage@example.com');
 assert.equal(auth.token('youtube'),'token-3');
 assert.notEqual(auth.token('youtube'),token);
 assert.notEqual(auth.token('youtube'),auth.token('drive'));
});
test('normal authorization skips valid tokens and renews only expired service',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await connectBoth(auth);
 assert.deepEqual(await auth.authorize(['youtube','drive']),[]);
 auth.tokens.youtube.expires=Date.now()-1;
 assert.deepEqual(await auth.authorize(['youtube','drive']),['youtube']);
 assert.equal(m.requests.length,3);
});
test('changed brand channel requires disconnect; other service and hint remain',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await connectBoth(auth);
 m.setChannel('UC'+'y'.repeat(22));
 await assert.rejects(auth.authorize(['youtube'],{force:true}),/異なるYouTubeチャンネル/);
 assert.ok(auth.token('drive'));
 auth.disconnect('youtube');
 assert.equal(preferredAccount(CLIENT,'drive'),'storage@example.com');
 await auth.authorize(['youtube']);
 assert.equal(auth.channel.id,'UC'+'y'.repeat(22));
 assert.equal(m.requests.at(-1).login_hint,''); // A Drive hint must not select a YouTube Brand account.
});
test('account lookup failure never blocks a successful grant',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 m.setEmailFailure(true);
 await connectBoth(auth);
 assert.ok(auth.token('youtube')&&auth.token('drive'));
 assert.equal(preferredAccount(CLIENT,'drive'),'');
});
test('a remembered YouTube account never preselects a different Drive account',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await auth.authorize(['youtube']);
 assert.equal(preferredAccount(CLIENT,'drive'),'');
 await auth.authorize(['drive']);
 assert.equal(m.requests[1].login_hint,'');
});
test('persistent scoped tokens restore, legacy YouTube remains unverified',async()=>{
 const m=mock(),auth=new GoogleAuth(CLIENT);
 await connectBoth(auth);
 auth.setKeepConnected(true);m.sessions.clear();
 let restored=new GoogleAuth(CLIENT);
 assert.ok(restored.token('youtube')&&restored.token('drive'));
 restored.tokens.youtube.expires=Date.now()-1;restored.tokens.drive.expires=Date.now()-1;
 restored.saveTokens();
 restored=new GoogleAuth(CLIENT);
 assert.equal(restored.token('youtube'),'');
 assert.equal(restored.token('drive'),'');
 m.sessions.set('minkome-google-session-v1',JSON.stringify({version:1,clientId:CLIENT,tokens:{
  youtube:{value:'old-youtube',expires:Date.now()+900000,scope:'https://www.googleapis.com/auth/youtube.readonly'},
  drive:{value:'old-drive',expires:Date.now()+900000,scope:SCOPES.drive}
 }}));
 restored=new GoogleAuth(CLIENT);
 assert.equal(restored.token('youtube'),'');
 assert.equal(restored.token('drive'),'old-drive');
});
