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
test('OAuth lists completed live broadcasts from the Brand Channel without applying the old manual channel ID',async()=>{
 const oauth={accessToken:'brand-token',channelId:channel},seen=[];
 const result=await Y.candidates(oauth,'UC'+'z'.repeat(22),signal(),async(url,options)=>{
  const u=new URL(url);seen.push(u.pathname);assert.equal(options.headers.Authorization,'Bearer brand-token');
  assert.equal(u.searchParams.has('channelId'),false);
  if(u.pathname.endsWith('/liveBroadcasts')){
   assert.equal(u.searchParams.get('broadcastStatus'),'completed');
   assert.equal(u.searchParams.get('broadcastType'),'all');
   return {ok:true,json:async()=>({items:ids.map(id=>({id})),nextPageToken:'page2'})};
  }
  if(u.pathname.endsWith('/videos'))return body(ids.map(id=>item(id)));
  throw Error('Unexpected '+u.pathname);
 });
 assert.deepEqual(result.items.map(x=>x.videoId),ids);
 assert.equal(result.nextPageToken,'page2');
 assert.deepEqual(seen,['/youtube/v3/liveBroadcasts','/youtube/v3/videos']);
});
test('OAuth falls back to uploads playlist when live broadcasts are not returned',async()=>{
 const oauth={accessToken:'brand-token',channelId:channel},paths=[];
 const completed={...item(ids[0]),liveStreamingDetails:{...item(ids[0]).liveStreamingDetails,actualEndTime:'2026-10-05T00:58:00Z'}};
 const result=await Y.candidates(oauth,'',signal(),async url=>{
  const u=new URL(url);paths.push(u.pathname);
  if(u.pathname.endsWith('/liveBroadcasts'))return body([]);
  if(u.pathname.endsWith('/channels'))return body([{id:channel,contentDetails:{relatedPlaylists:{uploads:'uploads'}}}]);
  if(u.pathname.endsWith('/playlistItems'))return {ok:true,json:async()=>({items:ids.map(videoId=>({contentDetails:{videoId}})),nextPageToken:'more'})};
  if(u.pathname.endsWith('/videos'))return body([completed,item(ids[1])]);
  throw Error('Unexpected '+u.pathname);
 });
 assert.deepEqual(result.items.map(x=>x.videoId),[ids[0]]);
 assert.equal(result.nextPageToken,'uploads:more');
 assert.deepEqual(paths,['/youtube/v3/liveBroadcasts','/youtube/v3/channels','/youtube/v3/playlistItems','/youtube/v3/videos']);
});
test('OAuth uploads page token does not repeat liveBroadcasts request',async()=>{
 const oauth={accessToken:'brand-token',channelId:channel},calls=[];
 const result=await Y.candidates(oauth,'',signal(),async url=>{
  const u=new URL(url);calls.push(u.pathname);
  if(u.pathname.endsWith('/channels'))return body([{id:channel,contentDetails:{relatedPlaylists:{uploads:'uploads'}}}]);
  if(u.pathname.endsWith('/playlistItems')){assert.equal(u.searchParams.get('pageToken'),'more');return body([]);}
  throw Error('Unexpected '+u.pathname);
 },{pageToken:'uploads:more'});
 assert.deepEqual(result,{items:[],nextPageToken:''});
 assert.deepEqual(calls,['/youtube/v3/channels','/youtube/v3/playlistItems']);
});
test('OAuth detects a changed authorized channel on uploads fallback',async()=>{
 const oauth={accessToken:'brand-token',channelId:channel};
 await assert.rejects(Y.candidates(oauth,'',signal(),async url=>{
  if(url.includes('/liveBroadcasts?'))return body([]);
  if(url.includes('/channels?'))return body([{id:'UC'+'z'.repeat(22),contentDetails:{relatedPlaylists:{uploads:'uploads'}}}]);
  throw Error('Unexpected '+url);
 }),/認証先チャンネル/);
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

test('description editing preserves video metadata, channel and privacy by updating snippet only',async()=>{
 const key={accessToken:'creator-token',channelId:channel},source={id:ids[0],
   snippet:{channelId:channel,title:'配信タイトル',categoryId:'20',description:'旧概要\nVOICEVOX: credit',
     tags:['game','live'],defaultLanguage:'ja'}},calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(options.method==='PUT')return {ok:true,json:async()=>({id:ids[0],snippet:JSON.parse(options.body).snippet})};
  return body([source]);
 };
 const result=await Y.loadDescription(ids[0],key,signal(),fetcher);
 assert.equal(result.description,'旧概要\nVOICEVOX: credit');
 const next=await Y.updateDescription(ids[0],'新概要\nVOICEVOX: credit',result.description,key,signal(),fetcher);
 assert.equal(next.description,'新概要\nVOICEVOX: credit');
 assert.equal(calls.length,3);
 const write=calls[2],payload=JSON.parse(write.options.body);
 assert.equal(write.options.method,'PUT');
 assert.equal(write.options.headers.Authorization,'Bearer creator-token');
 assert.equal(new URL(write.url).searchParams.get('part'),'snippet');
 assert.deepEqual(payload,{id:ids[0],snippet:{title:'配信タイトル',categoryId:'20',
   description:'新概要\nVOICEVOX: credit',tags:['game','live'],defaultLanguage:'ja'}});
 assert.equal(payload.status,undefined);
});
test('description write rejects API key, other brand channel, invalid text and concurrent changes',async()=>{
 const key={accessToken:'token',channelId:channel},resource={id:ids[0],
  snippet:{channelId:channel,title:'動画',categoryId:'20',description:'外部で変更した文章'}};
 let writes=0;const fetcher=async(url,options)=>{if(options.method==='PUT'){writes++;return {ok:true,json:async()=>({})};}return body([resource]);};
 await assert.rejects(Y.loadDescription(ids[0],'api-key',signal(),fetcher),/Google認証/);
 await assert.rejects(Y.loadDescription(ids[0],{accessToken:'token',channelId:'UC'+'b'.repeat(22)},signal(),fetcher),/一致しません/);
 await assert.rejects(Y.updateDescription(ids[0],'変更','古い文章',key,signal(),fetcher),/取得後に変更/);
 await assert.rejects(Y.updateDescription(ids[0],'<script>','外部で変更した文章',key,signal(),fetcher),/使用できません/);
 await assert.rejects(Y.updateDescription(ids[0],'あ'.repeat(2000),'外部で変更した文章',key,signal(),fetcher),/5000バイト/);
 assert.equal(writes,0);
});
test('managed chapter block updates idempotently and preserves credits',()=>{
 const source='配信ありがとうございました\nVOICEVOX: ずんだもん';
 const first=Y.mergeDescriptionChapters(source,'00:00 配信開始\n12:34 ボス戦');
 const second=Y.mergeDescriptionChapters(first,'00:00 配信開始\n15:00 ボス戦');
 assert.equal(second.split('【チャプター】').length,2);
 assert.match(second,/15:00 ボス戦/);assert.doesNotMatch(second,/12:34 ボス戦/);
 assert.ok(second.startsWith(source));assert.match(second,/VOICEVOX: ずんだもん/);
 assert.throws(()=>Y.mergeDescriptionChapters('00:00 古いチャプター','00:00 新しいチャプター'),/二重登録|既存/);
});
