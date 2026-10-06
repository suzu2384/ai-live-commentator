const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../core.js');
const Y=require('../youtube.js'),V=require('../vault.js');
const channel='UC'+'a'.repeat(22),ids=['abcdefghijk','lmnopqrstuv'],signal=()=>new AbortController().signal;
const body=items=>({ok:true,json:async()=>({items})});
const item=(id,start='2026-10-04T23:58:00Z')=>({id,snippet:{title:'配信 '+id,channelId:channel,liveBroadcastContent:start?'live':'upcoming'},liveStreamingDetails:{actualStartTime:start,scheduledStartTime:'2026-10-04T23:00:00Z'}});
test('completed candidates load one explicit page and expose pagination',async()=>{
 const calls=[];const result=await Y.candidates('test.key',channel,signal(),async(url,options)=>{
  const u=new URL(url);calls.push(u);assert.equal(options.headers['X-Goog-Api-Key'],'test.key');assert.equal(u.searchParams.has('key'),false);
  if(u.pathname.endsWith('/videos'))return body(ids.map(id=>item(id)));
  assert.equal(u.searchParams.get('eventType'),'completed');assert.equal(u.searchParams.get('channelId'),channel);assert.equal(u.searchParams.get('pageToken'),'page1');assert.equal(u.searchParams.get('order'),'date');
  return {ok:true,json:async()=>({items:ids.map(id=>({id:{videoId:id}})),nextPageToken:'page2'})};
 },{pageToken:'page1'});assert.deepEqual(result.items.map(x=>x.videoId),ids);assert.equal(calls.length,2);assert.equal(result.nextPageToken,'page2');
});
test('URL parsing accepts known forms and rejects unrelated or misleading hosts',()=>{
 for(const url of [ids[0],`https://www.youtube.com/watch?v=${ids[0]}&t=30`,`https://youtu.be/${ids[0]}?si=token`,`https://youtube.com/live/${ids[0]}`,`https://m.youtube.com/shorts/${ids[0]}`,`https://www.youtube.com/embed/${ids[0]}`])assert.equal(Y.parseVideoId(url),ids[0]);
 for(const url of ['bad','https://evil.example/watch?v='+ids[0],'https://youtube.com.evil.example/watch?v='+ids[0],'https://youtube.com/@channel','javascript:alert(1)'])assert.throws(()=>Y.parseVideoId(url));
});
test('loaded candidates sort by absolute start proximity without changing input',()=>{
 const input=[{videoId:ids[0],actualStartTimeMs:1000},{videoId:ids[1],actualStartTimeMs:9500}];
 assert.deepEqual(Y.sortCandidates(input,10000).map(x=>x.videoId),[ids[1],ids[0]]);assert.equal(input[0].videoId,ids[0]);
});
test('empty is distinct from API/network/malformed or partial lookup failure',async()=>{
 assert.deepEqual(await Y.candidates('key',channel,signal(),async()=>body([])),{items:[],nextPageToken:''});
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

test('sync retains actual end and rejects ordinary videos without broadcast data',async()=>{
 const video=item(ids[0]);video.liveStreamingDetails.actualEndTime='2026-10-05T00:58:00Z';
 const synced=await Y.synchronize({videoId:ids[0]},'key',signal(),async()=>body([video]));assert.equal(synced.actualEndTime,'2026-10-05T00:58:00Z');assert.equal(synced.actualEndTimeMs,Date.parse(synced.actualEndTime));
 delete video.liveStreamingDetails;await assert.rejects(Y.synchronize({videoId:ids[0]},'key',signal(),async()=>body([video])),/ライブ配信/);
});
