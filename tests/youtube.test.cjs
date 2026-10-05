const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../core.js');
const Y=require('../youtube.js'),V=require('../vault.js');
const channel='UC'+'a'.repeat(22),ids=['abcdefghijk','lmnopqrstuv'],signal=()=>new AbortController().signal;
const body=items=>({ok:true,json:async()=>({items})});
const item=(id,start='2026-10-04T23:58:00Z')=>({id,snippet:{title:'配信 '+id,channelId:channel,liveBroadcastContent:start?'live':'upcoming'},liveStreamingDetails:{actualStartTime:start,scheduledStartTime:'2026-10-04T23:00:00Z'}});
test('YouTube search paginates live/upcoming and deduplicates without selecting',async()=>{
 const calls=[];const result=await Y.candidates('test.key',channel,signal(),async(url,options)=>{
  const u=new URL(url);calls.push(u);assert.equal(options.headers['X-Goog-Api-Key'],'test.key');assert.equal(u.searchParams.has('key'),false);
  assert.equal(options.credentials,'omit');
  if(u.pathname.endsWith('/videos'))return body(ids.map(id=>item(id)));
  assert.equal(u.searchParams.get('type'),'video');assert.equal(u.searchParams.get('channelId'),channel);
  if(u.searchParams.get('eventType')==='live'&&!u.searchParams.has('pageToken'))return {ok:true,json:async()=>({items:[{id:{videoId:ids[0]}}],nextPageToken:'page2'})};
  return body([{id:{videoId:ids[1]}}]);
 });assert.deepEqual(result.map(x=>x.videoId),ids);assert.equal(calls.length,4);assert.equal(result[0].actualStartTimeMs,Date.parse('2026-10-04T23:58:00Z'));
});
test('empty is distinct from API/network/malformed or partial lookup failure',async()=>{
 assert.deepEqual(await Y.candidates('key',channel,signal(),async()=>body([])),[]);
 await assert.rejects(Y.candidates('key',channel,signal(),async()=>({ok:false,status:403})),/403/);
 await assert.rejects(Y.candidates('key',channel,signal(),async()=>{throw Error('secret');}),/接続できません/);
 await assert.rejects(Y.candidates('key',channel,signal(),async()=>({ok:true,json:async()=>({})})),/候補一覧/);
 await assert.rejects(Y.candidates('key',channel,signal(),async url=>body(url.includes('/search?')?[{id:{videoId:ids[0]}}]:[])),/一部/);
});
test('sync requests the chosen video only; scheduled time is never actual time',async()=>{
 const s=await Y.synchronize({videoId:ids[1],selectedAtMs:123},'key',signal(),async url=>{assert.equal(new URL(url).searchParams.get('id'),ids[1]);return body([item(ids[1],undefined)]);});
 assert.equal(s.selectedAtMs,123);
 const pending=await Y.synchronize(s,'key',signal(),async()=>body([item(ids[1],null)]));
 assert.equal(pending.actualStartTimeMs,null);assert.equal(Y.relative(Date.now(),pending),null);assert(Number.isFinite(pending.scheduledStartTimeMs));
});
test('relative chapter time crosses midnight independently of commentary start',()=>{
 const sync={actualStartTimeMs:Date.parse('2026-10-04T23:58:00Z')};
 assert.equal(Y.relative(Date.parse('2026-10-05T00:10:18Z'),sync),'12:18');
 assert.equal(Y.relative(Date.parse('2026-10-05T01:10:18Z'),sync),'01:12:18');
 assert.equal(Y.relative(Date.parse('2026-10-04T23:57:59Z'),sync),'配信開始前 −00:01');
 assert.equal(Y.relative(Date.now(),null),null);assert.equal(Y.timestamp('invalid'),null);
});
test('YouTube secret uses the existing vault and legacy records still decrypt',async()=>{
 const pass='a safe test passphrase',old={apiKey:'gemini',obsPassword:'obs'},next={...old,youtubeApiKey:'youtube-secret'};
 assert.deepEqual(await V.open(await V.seal(old,pass),pass),old);
 const sealed=await V.seal(next,pass);assert(!JSON.stringify(sealed).includes(next.youtubeApiKey));assert.deepEqual(await V.open(sealed,pass),next);
});
