// Development only: npm install playwright, then set CHROME_PATH if necessary.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const entry='file://'+path.resolve(__dirname,'../index.html');
const sha=s=>createHash('sha256').update(s).digest('base64');
const answer={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進んでいる',chapterEvents:[],turns:[{speakerId:'p1',text:'景色がいいね'}]})}]}}]};
require('node:fs').mkdirSync(path.resolve(__dirname,'../../.browser-test'),{recursive:true});
function wave(samples=2400){
    const b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);
    return b;
}
const results=[];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--no-sandbox']});
 async function setup(config={}){
  const ctx=await browser.newContext({viewport:{width:1360,height:768}});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const host=config.host||'127.0.0.1';
  const events={images:0,api:0,analysisImages:[],turnLimits:[],speakerEnums:[],promptTexts:[],talks:[],queries:0,voiceTexts:[],voices:[],speeds:[],synths:0,identifies:0,obsRequests:[],overlayUrls:[],overlayTransforms:[],overlayEnabled:[],unexpected:[]};let held=null;
  await page.clock.install();
  await page.route('https://**/*',async r=>{
   if(r.request().url().startsWith('https://i.ytimg.com/'))return r.fulfill({status:204});
   if(r.request().url().startsWith('https://www.googleapis.com/youtube/v3/')){
    events.youtube=(events.youtube||0)+1;assert.equal(r.request().headers()['x-goog-api-key'],'youtube-test-key');
    const u=new URL(r.request().url());
    if(config.holdYouTube){held=r;return;}
    if(config.youtubeError)return r.fulfill({status:403,body:'{}'});
    const videos=config.youtubeVideos||[];
    const items=u.pathname.endsWith('/search')?(u.searchParams.get('eventType')==='live'?videos.map(v=>({id:{videoId:v.id}})):[]):videos.filter(v=>u.searchParams.get('id').split(',').includes(v.id));
    return r.fulfill({contentType:'application/json',body:JSON.stringify({items})});
   }
   if(!r.request().url().startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent')){events.unexpected.push(r.request().url());return r.abort();}
   events.api++;assert.equal(r.request().headers()['x-goog-api-key'],'fake.test-key');
   const requestBody=JSON.parse(r.request().postData()||'{}');
   if(requestBody.generationConfig?.responseSchema?.properties?.chapters){
    if(config.holdChapter){held=r;return;}
    if(config.chapterStatus)return r.fulfill({status:config.chapterStatus,contentType:'application/json',body:'{}'});
    const items=JSON.parse(requestBody.contents[0].parts[0].text).events;
    return r.fulfill({contentType:'application/json',body:JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({chapters:[{eventId:items[0].eventId,title:'新しいエリアを探索'}]})}]}}]})});
   }
   const parts=requestBody.contents?.[0]?.parts||[];events.analysisImages.push(parts.filter(p=>p.inlineData).length);events.turnLimits.push(requestBody.generationConfig?.responseSchema?.properties?.turns?.maxItems??null);events.speakerEnums.push(requestBody.generationConfig?.responseSchema?.properties?.turns?.items?.properties?.speakerId?.enum??[]);events.promptTexts.push(parts.filter(p=>typeof p.text==='string').map(p=>p.text).join('\n'));
   if(config.hold){held=r;return;}
   if(config.status && (!config.failCount || events.api<=config.failCount))await r.fulfill({status:config.status,contentType:'application/json',body:'{}'});
   else {const response=config.answers?.[events.api-1]||config.answer||answer;await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});}
  });
  await page.route(`http://${host}:50080/**`,async r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/GetTalkTaskCount')return r.fulfill({contentType:'application/json',body:JSON.stringify({talkTaskCount:config.busy?1:0})});
   if(u.pathname==='/talk'){events.talks.push(u.searchParams.get('text'));return r.fulfill({contentType:'application/json',body:'{"taskId":1}'});}
   events.unexpected.push(u.pathname);await r.abort();
  });
  await page.route(`http://${host}:50021/**`,async r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/audio_query'){events.queries++;events.voiceTexts.push(u.searchParams.get('text'));events.voices.push(u.searchParams.get('speaker'));return r.fulfill({contentType:'application/json',body:'{}'});}
   if(u.pathname==='/synthesis'){
    events.synths++;events.speeds.push(JSON.parse(r.request().postData()||'{}').speedScale);if(config.holdSynth || events.synths===config.holdSynthAt){held=r;return;}
    return r.fulfill({contentType:'audio/wav',body:wave(config.waveSamples)});
   }await r.abort();
  });
  let jpeg,bubbleExists=false,bubbleSceneItem=false,legacyExists=!!config.legacyOverlay,legacySceneItem=!!config.legacyOverlay;
  await page.routeWebSocket(`ws://${host}:4455`,ws=>{
   const reply=(m,responseData={})=>ws.send(JSON.stringify({op:7,d:{requestType:m.d.requestType,requestId:m.d.requestId,requestStatus:{result:true,code:100},responseData}}));
   const fail=(m,code=600,comment='test failure')=>ws.send(JSON.stringify({op:7,d:{requestType:m.d.requestType,requestId:m.d.requestId,requestStatus:{result:false,code,comment}}}));
   ws.onMessage(raw=>{
    const m=JSON.parse(raw);
    if(m.op===1){events.identifies++;assert.equal(m.d.authentication,sha(sha('obs-secret'+'salt')+'challenge'));ws.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));}
    if(m.op!==6)return;
    const type=m.d.requestType,data=m.d.requestData||{};events.obsRequests.push({type,data});
    if(type==='GetSourceScreenshot'){events.images++;if(config.failScreenshotCount&&events.images<=config.failScreenshotCount)return fail(m,600,'source unavailable');return reply(m,{imageData:jpeg.replace('image/jpeg','image/jpg')});}
    if(type==='GetCurrentProgramScene')return reply(m,{sceneName:'Gameplay',currentProgramSceneName:'Gameplay'});
    if(type==='GetInputList'){
      const inputs=[];
      if(bubbleExists)inputs.push({inputName:'みんコメ 吹き出し',inputKind:'browser_source'});
      if(legacyExists)inputs.push({inputName:'みんコメ コメント',inputKind:'text_gdiplus_v2'});
      return reply(m,{inputs});
    }
    if(type==='GetInputKindList')return reply(m,{inputKinds:['text_gdiplus_v2','browser_source']});
    if(type==='GetVideoSettings')return reply(m,{baseWidth:1920,baseHeight:1080});
    if(type==='GetSceneItemList'){
      const sceneItems=[];
      if(bubbleSceneItem)sceneItems.push({sourceName:'みんコメ 吹き出し',sceneItemId:99});
      if(legacySceneItem)sceneItems.push({sourceName:'みんコメ コメント',sceneItemId:77});
      return reply(m,{sceneItems});
    }
    if(type==='CreateInput'){
      if(data.inputName==='みんコメ 吹き出し'){bubbleExists=true;bubbleSceneItem=true;if(data.inputSettings?.url)events.overlayUrls.push(data.inputSettings.url);return reply(m,{sceneItemId:99,inputUuid:'overlay-uuid'});}
      events.unexpected.push('create:'+data.inputName);return reply(m,{sceneItemId:199});
    }
    if(type==='CreateSceneItem'){if(data.sourceName==='みんコメ 吹き出し'){bubbleSceneItem=true;return reply(m,{sceneItemId:99});}return reply(m,{sceneItemId:199});}
    if(type==='SetInputSettings'){
      if(data.inputName==='みんコメ 吹き出し'&&data.inputSettings?.url)events.overlayUrls.push(data.inputSettings.url);
      return reply(m,{});
    }
    if(type==='SetSceneItemTransform'){events.overlayTransforms.push(data.sceneItemTransform);return reply(m,{});}
    if(type==='SetSceneItemEnabled'){events.overlayEnabled.push({sceneItemId:data.sceneItemId,enabled:data.sceneItemEnabled});return reply(m,{});}
    events.unexpected.push('obs:'+type);return reply(m,{});
   });ws.send(JSON.stringify({op:0,d:{rpcVersion:1,authentication:{salt:'salt',challenge:'challenge'}}}));
  });
  await page.goto(entry);
  await page.locator('details.setting-section').evaluateAll(ds=>ds.forEach(d=>d.open=true));
  await page.locator('#settings-advanced').evaluate(d=>d.open=true);
  await page.locator('#greetStart').uncheck();await page.locator('#greetEnd').uncheck();
  jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.fillStyle='#345a4b';x.fillRect(0,0,640,360);return c.toDataURL('image/jpeg');});
  await page.locator('#sampleInterval').fill('4');
  await page.locator('#tab-connect').click();
  await page.locator('#apiKey').fill('fake.test-key');await page.locator('#obsPassword').fill('obs-secret');await page.locator('#freeTier').check();
  if(config.host){await page.locator('#output').selectOption('voicevox');await page.locator('#voicevoxUrl').fill(`http://${host}:50021`);await page.locator('#output').selectOption('bouyomi');for(const [id,port,proto] of [['obsUrl',4455,'ws'],['bouyomiUrl',50080,'http']])await page.locator('#'+id).fill(`${proto}://${host}:${port}`);}
  await page.locator('#tab-live').click();
  for(let n=1;n<=6;n++)await page.locator('#speakerWeight'+n).fill(n===1?'100':'0');
  if(config.before)await config.before(page);
  return {page,ctx,events,errors,held:()=>held,close:async()=>{assert.deepEqual(errors,[]);assert.deepEqual(events.unexpected,[]);await ctx.close();}};
 }
 async function start(x){await x.page.locator('#start').click();await idle(x.page);await x.page.clock.fastForward(4100);}
 async function stop(p){await p.locator('#stop').click();await stopped(p);}
 async function finish(p){await p.locator('#finish').click();await stopped(p);}
 async function idle(p){await p.waitForFunction(()=>{const s=document.getElementById('status').textContent;return s==='映像監視中'||s.startsWith('映像履歴を準備中');});}
 async function recovery(p){await p.waitForFunction(()=>document.getElementById('status').textContent.includes('自動再開まで'));}
 async function next(x,ms){await x.page.clock.fastForward(ms);await idle(x.page);await x.page.clock.fastForward(4100);}
 async function stopped(p){await p.waitForFunction(()=>!document.getElementById('start').disabled);}
 async function openConnect(p){await p.locator('#tab-connect').click();await p.locator('details.setting-section').evaluateAll(ds=>ds.forEach(d=>d.open=true));}
 async function setOutput(p,value){await openConnect(p);await p.locator('#output').selectOption(value);}
 async function selectParticipants(p,ids){
  await p.locator('#tab-live').click();const selected=new Set(ids);
  for(let n=1;n<=6;n++)await p.locator('#participant-p'+n).setChecked(selected.has('p'+n));
 }
 async function test(name,fn){if(process.env.TEST_FILTER&&!new RegExp(process.env.TEST_FILTER).test(name))return;await fn();results.push(name);console.log('PASS:',name);}
 async function chapterRecords(p){return p.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('minkome-chapters-v1',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('sessions'),r=tx.objectStore('sessions').getAll();r.onsuccess=()=>{db.close();resolve(r.result)};r.onerror=reject;};open.onerror=reject;}));}

 const youtubeChannel='UC'+'a'.repeat(22);
 const youtubeVideo=(id,actualStartTime=null)=>({id,snippet:{title:'テスト配信 '+id,channelId:youtubeChannel,liveBroadcastContent:actualStartTime?'live':'upcoming'},liveStreamingDetails:{scheduledStartTime:'2026-10-04T23:00:00Z',...(actualStartTime?{actualStartTime}:{})}});
 async function youtubeSettings(p){await openConnect(p);await p.locator('#youtubeApiKey').fill('youtube-test-key');await p.locator('#youtubeChannelId').fill(youtubeChannel);}
 await test('YouTube empty skips modal; API failure explicitly permits unlinked start',async()=>{
  for(const error of [false,true]){
   const x=await setup({youtubeError:error}),p=x.page;await youtubeSettings(p);await p.locator('#start').click();
   if(error){await p.locator('#youtubeDialog').waitFor({state:'visible'});assert.match(await p.locator('#youtubeMessage').textContent(),/403/);assert.equal(x.events.identifies,0);await p.locator('#youtubeWithout').click();}
   await idle(p);assert.equal(await p.locator('#youtubeDialog').isVisible(),false);await stop(p);assert.equal((await chapterRecords(p))[0].youtubeSync,null);await x.close();
  }
 });
 await test('YouTube one or two candidates require explicit choice; cancel starts no session',async()=>{
  for(const count of [1,2]){
   const config={youtubeVideos:[youtubeVideo('abcdefghijk'),youtubeVideo('lmnopqrstuv')].slice(0,count)},x=await setup(config),p=x.page;
   await youtubeSettings(p);await p.locator('#start').click();await p.locator('#youtubeDialog').waitFor({state:'visible'});
   assert.equal(await p.locator('#youtubeCandidates input:checked').count(),0);assert.equal(await p.locator('#youtubeConfirm').isDisabled(),true);assert.equal(x.events.identifies,0);
   if(count===1){await p.locator('#youtubeCancel').click();await stopped(p);assert.equal((await chapterRecords(p)).length,0);}
   else{
    await p.setViewportSize({width:390,height:844});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/youtube-mobile.png')});
    await p.locator('#youtubeCandidates input').nth(1).check();await p.locator('#youtubeConfirm').click();await idle(p);await stop(p);
    const record=(await chapterRecords(p))[0];assert.equal(record.youtubeSync.videoId,'lmnopqrstuv');assert.equal(record.youtubeSync.actualStartTimeMs,null);
   }await x.close();
  }
 });
 await test('YouTube retry cancellation ignores late lookup responses',async()=>{
  const config={youtubeError:true},x=await setup(config),p=x.page;await youtubeSettings(p);await p.locator('#start').click();await p.locator('#youtubeDialog').waitFor({state:'visible'});
  config.youtubeError=false;config.holdYouTube=true;await p.locator('#youtubeRetry').click();await p.waitForFunction(()=>document.getElementById('youtubeMessage').textContent.includes('取得しています'));
  await p.locator('#youtubeWithout').click();await idle(p);await stop(p);assert.equal((await chapterRecords(p))[0].youtubeSync,null);assert.equal(await p.locator('#youtubeDialog').isVisible(),false);await x.close();
 });
 await test('YouTube sync preserves absolute chapters and persists selected video on reload',async()=>{
  const config={youtubeVideos:[youtubeVideo('abcdefghijk')],answer:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:false,summary:'移動',chapterEvents:[{kind:'scene',summary:'ボス部屋へ入った'}],turns:[{speakerId:'p1',text:'静かだね'}]})}]}}]}},x=await setup(config),p=x.page;
  await youtubeSettings(p);await p.locator('#start').click();await p.locator('#youtubeCandidates input').check();await p.locator('#youtubeConfirm').click();await idle(p);await p.clock.fastForward(4100);
  await p.waitForFunction(()=>document.getElementById('chapterEventCount').textContent.includes('1件'));await finish(p);
  let before=(await chapterRecords(p))[0];assert.equal(before.generations.length,1);assert.match(await p.locator('#chapterCandidates').textContent(),/未同期/);
  const time=before.events[0].observedAtMs;config.youtubeVideos=[youtubeVideo('abcdefghijk',new Date(time-738000).toISOString())];
  const api=x.events.api;await p.locator('#youtubeResync').click();await stopped(p);assert.match(await p.locator('#chapterCandidates').textContent(),/12:18/);assert.equal(x.events.api,api);
  let after=(await chapterRecords(p))[0];assert.deepEqual(after.events,before.events);assert.deepEqual(after.generations,before.generations);
  config.youtubeError=true;await p.locator('#youtubeResync').click();await stopped(p);assert.match(await p.locator('#youtubeSyncInfo').textContent(),/403/);assert.match(await p.locator('#chapterCandidates').textContent(),/12:18/);
  await p.reload();await p.locator('#tab-chapters').click();await p.waitForFunction(()=>document.getElementById('chapterCandidates').textContent.includes('12:18'));
  assert.equal(await p.locator('#youtubeApiKey').inputValue(),'');assert.equal((await chapterRecords(p))[0].youtubeSync.videoId,'abcdefghijk');await x.close();
 });
 await test('chapters record silent observations, auto-generate, persist and retain history on failure or cancellation',async()=>{
  const config={answer:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:false,summary:'感想ではない状況',chapterEvents:[{kind:'scene',summary:'新しいエリアに移動した'}],turns:[{speakerId:'p1',text:'静かだね',speechText:'しずかだね'}]})}]}}]}};
  const x=await setup(config),p=x.page;await start(x);
  await p.waitForFunction(()=>document.getElementById('chapterEventCount').textContent.includes('1件'));
  assert.equal(x.events.talks.length,0);
  await finish(p);
  assert.equal(await p.locator('#chapterCandidates li').count(),1);
  let records=await chapterRecords(p),record=records[0];assert.equal(record.status,'finished');assert.equal(record.events.length,1);assert.equal(record.generations.length,1);
  assert(record.events[0].observedAtMs>1700000000000);assert(record.events[0].recordedAtMs>=record.events[0].observedAtMs);assert.equal(record.generations[0].chapters[0].sourceEventId,record.events[0].id);
  assert.equal(record.generations[0].chapters[0].observedAtMs,record.events[0].observedAtMs);
  await p.locator('#chapterCandidates button').click();assert.equal(await p.locator('#chapterEvents li').count(),1);
  await p.locator('#chapterGenerate').click();await stopped(p);assert.equal((await chapterRecords(p))[0].generations.length,2);
  config.chapterStatus=503;await p.locator('#chapterGenerate').click();await stopped(p);assert((await p.locator('#chapterStatus').textContent()).includes('503'));assert.equal((await chapterRecords(p))[0].generations.length,2);
  config.chapterStatus=0;config.holdChapter=true;await p.locator('#chapterGenerate').click();await p.waitForFunction(()=>document.getElementById('chapterStatus').textContent.includes('生成中'));await stop(p);assert.equal((await chapterRecords(p))[0].generations.length,2);
  await p.reload();await p.locator('#tab-chapters').click();await p.waitForFunction(()=>document.getElementById('chapterGeneration').options.length===2);
  assert.equal(await p.locator('#chapterEvents li').count(),1);assert.equal(await p.locator('#chapterCandidates li').count(),1);
  assert.equal(await p.locator('#apiKey').inputValue(),'');assert.equal(await p.locator('#freeTier').isChecked(),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/chapters-desktop.png')});
  await p.setViewportSize({width:390,height:844});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.locator('#chapterSession').scrollIntoViewIfNeeded();await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/chapters-mobile.png')});
  await x.close();
 });
 await test('immediate stop keeps events without automatic chapter requests',async()=>{
  const x=await setup({answer:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:false,summary:'結果',chapterEvents:[{kind:'result',summary:'結果画面が表示された'}],turns:[{speakerId:'p1',text:'結果だね'}]})}]}}]}});await start(x);await x.page.waitForFunction(()=>document.getElementById('chapterEventCount').textContent.includes('1件'));await stop(x.page);
  const records=await chapterRecords(x.page);assert.equal(records[0].status,'interrupted');assert.equal(records[0].events.length,1);assert.equal(records[0].generations.length,0);assert.equal(x.events.api,1);await x.close();
 });
 await test('chapter recording preserves speech and closing greeting before auto-generation',async()=>{
  const wrap=value=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
  const x=await setup({answers:[wrap({speak:true,summary:'新しいエリア',chapterEvents:[{kind:'scene',summary:'新しいエリアに移動した'}],turns:[{speakerId:'p1',text:'景色が変わったね'}]}),wrap({speak:true,summary:'終了',turns:[{speakerId:'p1',text:'続きが気になるね'}]})],before:async p=>{await p.locator('#greetEnd').check();}});
  const p=x.page;await start(x);await p.waitForFunction(()=>document.getElementById('speakerStatsTotal').textContent==='1');
  assert.deepEqual(x.events.talks,['景色が変わったね']);await finish(p);
  assert.deepEqual(x.events.talks,['景色が変わったね','続きが気になるね']);assert.equal(x.events.api,3);
  const s=(await chapterRecords(p))[0];assert.equal(s.events.length,1);assert.equal(s.generations.length,1);assert.equal(s.status,'finished');await x.close();
 });
 await test('file startup, responsive layout, settings persistence excludes credentials',async()=>{
  const x=await setup();const p=x.page;await p.locator('#conversationHistoryCount').fill('4');await p.locator('#save').click();const data=await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1'));
  assert.ok(!data.includes('fake.test-key')&&!data.includes('obs-secret')&&!data.includes('freeTier'));assert.equal(JSON.parse(data).theme,'midnight');
  await p.reload();await openConnect(p);assert.equal(await p.locator('#apiKey').inputValue(),'');assert.equal(await p.locator('#freeTier').isChecked(),false);assert.equal(await p.locator('#sampleInterval').getAttribute('min'),'1');assert.equal(await p.locator('#conversationHistoryCount').inputValue(),'4');assert.equal(await p.locator('#conversationHistoryCount').getAttribute('max'),'20');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/desktop.png'),fullPage:true});
  await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/mobile.png'),fullPage:true});await x.close();
 });
 await test('settings export and import round-trip friends, libraries and normal settings without secrets',async()=>{
  const x=await setup();const p=x.page;await youtubeSettings(p);
  await p.locator('#tab-friends').click();
  await p.locator('#p4-name').fill('リアクション役');await p.locator('#p4-personality').fill('テンション高めで驚きを素直に出す。');await p.locator('#p4-speedScale').fill('1.25');
  await selectParticipants(p,['p2','p4','p6']);
  await p.locator('#persona').fill('エクスポート確認用の雰囲気');
  await p.locator('#manageContents').click();await p.locator('#newContentName').fill('ゲーム：Monster Hunter');await p.locator('#addContent').click();await p.locator('[data-content-knowledge="ゲーム：Monster Hunter"]').click();await p.locator('#contentKnowledgeText').fill('リオレウスは飛竜種。キャンプでは装備変更ができる。');await p.locator('#saveContentKnowledge').click();await p.locator('#doneContentDialog').click();
  await p.locator('#tab-connect').click();await p.locator('#obsOverlayEnabled').check();await p.locator('#manageFonts').click();await p.locator('#newFontName').fill('Meiryo');await p.locator('#addFont').click();await p.locator('#doneFontDialog').click();await p.locator('#obsOverlayFont').selectOption('Meiryo');
  await p.locator('#tab-live').click();
  const downloadPromise=p.waitForEvent('download');await p.locator('#exportSettings').click();const download=await downloadPromise;
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const text=Buffer.concat(chunks).toString('utf8'),bundle=JSON.parse(text);
  assert.equal(bundle.format,'minkome-settings');assert.equal(bundle.version,1);assert.equal(bundle.secretsIncluded,false);
  assert.ok(!text.includes('fake.test-key')&&!text.includes('obs-secret')&&!text.includes('freeTier')&&!text.includes('vault')&&!text.includes('youtube-test-key'));
  assert.deepEqual(bundle.settings.selectedProfileIds,['p2','p4','p6']);assert.equal(bundle.settings.profiles[3].name,'リアクション役');assert.equal(bundle.settings.profiles[3].personality,'テンション高めで驚きを素直に出す。');assert.equal(bundle.settings.profiles[3].speedScale,1.25);
  assert.deepEqual(bundle.contentLibrary,['ゲーム','ゲーム：Monster Hunter']);assert.deepEqual(bundle.contentKnowledge,{'ゲーム：Monster Hunter':'リオレウスは飛竜種。キャンプでは装備変更ができる。'});assert.deepEqual(bundle.fontLibrary,['Meiryo']);assert.equal(bundle.settings.obsOverlayFont,'Meiryo');
  assert.equal(bundle.settings.youtubeChannelId,youtubeChannel);delete bundle.settings.youtubeChannelId; // Legacy exports omit the optional YouTube setting.
  bundle.settings.theme='rose';bundle.settings.persona='インポート後の雰囲気';bundle.settings.contentName='配信：新作';bundle.settings.selectedProfileIds=['p1','p5'];bundle.settings.participantCount=2;bundle.settings.obsOverlayFont='BIZ UDPGothic';bundle.settings.profiles[4].name='分析役';bundle.settings.profiles[4].personality='冷静に状況を整理して予想する。';bundle.contentLibrary=['配信','配信：新作'];bundle.contentKnowledge={'配信：新作':'主人公はテスト太郎。固有技はテストブレイク。'};bundle.fontLibrary=['BIZ UDPGothic'];
  p.once('dialog',d=>d.accept());
  await p.locator('#importSettingsFile').setInputFiles({name:'minkome-settings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
  await p.waitForFunction(()=>document.getElementById('saveState').textContent.includes('インポートしました'));
  assert.equal(await p.locator('#theme').inputValue(),'rose');assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'rose');assert.equal(await p.locator('#persona').inputValue(),'インポート後の雰囲気');assert.equal(await p.locator('#contentName').inputValue(),'配信：新作');
  assert.deepEqual(await p.locator('#participantSelection input:checked').evaluateAll(xs=>xs.map(x=>x.dataset.profileId)),['p1','p5']);
  await p.locator('#tab-friends').click();assert.equal(await p.locator('#p5-name').inputValue(),'分析役');assert.equal(await p.locator('#p5-personality').inputValue(),'冷静に状況を整理して予想する。');
  await p.locator('#tab-connect').click();assert.equal(await p.locator('#obsOverlayFont').inputValue(),'BIZ UDPGothic');assert.equal(await p.locator('#apiKey').inputValue(),'fake.test-key');assert.equal(await p.locator('#obsPassword').inputValue(),'obs-secret');
  const saved=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));assert.equal(saved.persona,'インポート後の雰囲気');assert.deepEqual(saved.selectedProfileIds,['p1','p5']);assert.equal(saved.profiles[4].personality,'冷静に状況を整理して予想する。');assert.ok(!JSON.stringify(saved).includes('fake.test-key')&&!JSON.stringify(saved).includes('obs-secret'));
  assert.deepEqual(JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-content-library-v1'))),['配信','配信：新作']);assert.deepEqual(JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-content-knowledge-v1'))),{'配信：新作':'主人公はテスト太郎。固有技はテストブレイク。'});assert.deepEqual(JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-font-library-v1'))),['BIZ UDPGothic']);
  await x.close();
 });
 await test('color themes apply immediately, persist and default old settings to midnight',async()=>{
  const x=await setup();const p=x.page;
  assert.equal(await p.locator('#theme').inputValue(),'midnight');assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'midnight');
  await p.locator('#theme').selectOption('daylight');
  assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'daylight');
  assert.equal(await p.locator('meta[name="theme-color"]').getAttribute('content'),'#f3f6f9');
  let stored=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));assert.equal(stored.theme,'daylight');
  await p.reload();assert.equal(await p.locator('#theme').inputValue(),'daylight');assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'daylight');
  for(const [value,color] of [['aurora','#111326'],['crimson','#1b1014'],['forest','#0f1813'],['amber','#1b1710'],['mist','#f2f3f4'],['lavender','#f3f0fb'],['rose','#fbf0f3'],['sage','#eef5ef']]){
    await p.locator('#theme').selectOption(value);assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),value);
    assert.equal(await p.locator('meta[name="theme-color"]').getAttribute('content'),color);
    stored=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));assert.equal(stored.theme,value);
  }
  await p.evaluate(()=>localStorage.setItem('ai-live-commentator-browser-v1',JSON.stringify({sourceName:'legacy'})));await p.reload();
  assert.equal(await p.locator('#theme').inputValue(),'midnight');assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'midnight');
  await x.close();
 });
 await test('page title is concise and content manager follows active theme colors',async()=>{
  const x=await setup();const p=x.page;
  assert.equal(await p.title(),'みんコメAI');
  await p.locator('#manageContents').click();
  await p.locator('#newContentName').fill('ゲーム：Theme Test');await p.locator('#addContent').click();
  for(const theme of ['midnight','crimson','forest','amber','mist','lavender','rose','sage','daylight','sand']){
    await p.locator('#theme').selectOption(theme);
    const colors=await p.locator('.content-manage-group').evaluate(group=>{
      const root=document.documentElement,probe=document.createElement('span');
      probe.style.cssText='position:absolute;background:var(--surface);color:var(--muted);border-color:var(--line)';
      document.body.append(probe);
      const expected={surface:getComputedStyle(probe).backgroundColor,muted:getComputedStyle(probe).color,line:getComputedStyle(probe).borderTopColor};
      probe.style.background='var(--surface-open)';probe.style.color='var(--text)';
      expected.open=getComputedStyle(probe).backgroundColor;expected.text=getComputedStyle(probe).color;probe.remove();
      const main=group.querySelector('.content-main-row'),branch=group.querySelector('.content-branch'),sub=group.querySelector('.content-sub-name'),rows=group.querySelectorAll('.content-sub-row');
      return {expected,groupBg:getComputedStyle(group).backgroundColor,groupBorder:getComputedStyle(group).borderTopColor,mainBg:getComputedStyle(main).backgroundColor,branch:getComputedStyle(branch).color,sub:getComputedStyle(sub).color,rowBorder:rows.length>1?getComputedStyle(rows[1]).borderTopColor:null};
    });
    assert.equal(colors.groupBg,colors.expected.surface);assert.equal(colors.groupBorder,colors.expected.line);assert.equal(colors.mainBg,colors.expected.open);assert.equal(colors.branch,colors.expected.muted);assert.equal(colors.sub,colors.expected.text);
  }
  await p.locator('#doneContentDialog').click();await x.close();
 });
 await test('six friend cards keep unique visible colors across dark and light themes',async()=>{
  const x=await setup();const p=x.page;await p.locator('#tab-friends').click();
  for(const theme of ['midnight','crimson','forest','amber','daylight','rose','sage','sand']){
    await p.locator('#theme').selectOption(theme);
    const colors=await p.locator('#profiles .friend').evaluateAll(cards=>cards.map(card=>getComputedStyle(card).borderLeftColor));
    assert.equal(colors.length,6);assert.equal(new Set(colors).size,6);
    for(const color of colors)assert.notEqual(color,'rgba(0, 0, 0, 0)');
  }
  await x.close();
 });
 await test('selected participant border and checkbox follow every theme accent',async()=>{
  const x=await setup();const p=x.page;
  for(const theme of ['midnight','graphite','aurora','crimson','forest','amber','mist','lavender','rose','sage','daylight','sand']){
    await p.locator('#theme').selectOption(theme);
    const colors=await p.locator('#participant-p1').evaluate(input=>{
      const choice=input.closest('.participant-choice');
      const probe=document.createElement('span');probe.style.color='var(--accent)';document.body.append(probe);
      const accent=getComputedStyle(probe).color;probe.remove();
      return {accent,border:getComputedStyle(choice).borderTopColor,checkbox:getComputedStyle(input).accentColor};
    });
    assert.equal(colors.border,colors.accent);
    assert.equal(colors.checkbox,colors.accent);
  }
  await x.close();
 });
 await test('tabs group live, friends, connection and history without changing setting ids',async()=>{
  const x=await setup();const p=x.page;
  assert.deepEqual(await p.locator('[role=tab]').allTextContents(),['実況','友達','接続','履歴','チャプター']);
  assert.equal(await p.locator('#contentName').evaluate(el=>el.closest('[role=tabpanel]').id),'panel-live');
  assert.equal(await p.locator('#participantCount').evaluate(el=>el.closest('[role=tabpanel]').id),'panel-live');
  assert.equal(await p.locator('#apiInterval').evaluate(el=>el.closest('details').id),'settings-advanced');
  assert.equal(await p.locator('#obsUrl').evaluate(el=>el.closest('[role=tabpanel]').id),'panel-connect');
  assert.equal(await p.locator('#apiKey').evaluate(el=>el.closest('[role=tabpanel]').id),'panel-connect');
  assert.equal(await p.locator('#output').evaluate(el=>el.closest('[role=tabpanel]').id),'panel-connect');
  await p.locator('#tab-friends').click();assert.equal(await p.locator('#p1-name').evaluate(el=>el.closest('[role=tabpanel]').id),'panel-friends');
  await p.locator('#openHelp').click();assert.equal(await p.locator('#helpDialog').getAttribute('open'),'');await p.locator('#doneHelpDialog').click();
  await x.close();
 });
 await test('narrow layout keeps the acquired preview stacked above sticky tabs and uses triangle disclosure icons',async()=>{
  const x=await setup();const p=x.page;
  await p.setViewportSize({width:800,height:900});
  await p.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--preview-sticky-height'))>0);
  const layout=await p.evaluate(()=>{
    const workspace=document.querySelector('.workspace'),toolbar=document.querySelector('.toolbar'),preview=document.querySelector('.preview-sticky'),tabs=document.querySelector('.tabs');
    const previewImage=preview.querySelector('.preview'),heading=document.querySelector('.preview-card>.card-head'),metrics=document.querySelector('.preview-card>.metrics');
    const headingBox=heading.getBoundingClientRect(),previewBox=preview.getBoundingClientRect(),metricsBox=metrics.getBoundingClientRect();
    return {
      workspaceGap:parseFloat(getComputedStyle(workspace).gap),
      previewPosition:getComputedStyle(preview).position,
      previewTop:parseFloat(getComputedStyle(preview).top),
      toolbarHeight:toolbar.getBoundingClientRect().height,
      tabsTop:parseFloat(getComputedStyle(tabs).top),
      tabsRadius:parseFloat(getComputedStyle(tabs).borderTopLeftRadius),
      tabsBackground:getComputedStyle(tabs).backgroundColor,
      tabsTopBorder:parseFloat(getComputedStyle(tabs).borderTopWidth),
      tabsBottomBorder:parseFloat(getComputedStyle(tabs).borderBottomWidth),
      tabsTransition:getComputedStyle(tabs).transitionDuration,
      previewHeight:previewBox.height,
      hasHeading:!!preview.querySelector('.card-head'),
      hasMetrics:!!preview.querySelector('.metrics'),
      hasImage:!!previewImage,
      stickyBackground:getComputedStyle(preview).backgroundColor,
      imageRadius:parseFloat(getComputedStyle(previewImage).borderTopLeftRadius),
      headingToPreview:Math.abs(headingBox.bottom-previewBox.top),
      previewToMetrics:Math.abs(previewBox.bottom-metricsBox.top)
    };
  });
  assert.equal(layout.workspaceGap,0);
  assert.equal(layout.previewPosition,'sticky');
  assert.ok(layout.previewTop>=layout.toolbarHeight-1);
  assert.ok(Math.abs(layout.tabsTop-(layout.toolbarHeight+layout.previewHeight))<=1);
  assert.ok(layout.tabsRadius>0);
  assert.notEqual(layout.tabsBackground,'rgba(0, 0, 0, 0)');
  assert.equal(layout.tabsTopBorder,1);
  assert.equal(layout.tabsBottomBorder,1);
  assert.notEqual(layout.tabsTransition,'0s');
  assert.equal(layout.hasHeading,false);
  assert.equal(layout.hasMetrics,false);
  assert.equal(layout.hasImage,true);
  assert.notEqual(layout.stickyBackground,'rgba(0, 0, 0, 0)');
  assert.equal(layout.imageRadius,0);
  assert.ok(layout.headingToPreview<=1);
  assert.ok(layout.previewToMetrics<=1);
  await p.evaluate(()=>scrollTo(0,document.body.scrollHeight));
  await p.clock.fastForward(20);
  await p.waitForFunction(()=>document.querySelector('.tabs').classList.contains('is-stuck'));
  await p.clock.fastForward(200);
  const stuck=await p.evaluate(()=>{
    const tabs=document.querySelector('.tabs'),style=getComputedStyle(tabs);
    return {
      radius:parseFloat(style.borderTopLeftRadius),
      marginLeft:parseFloat(style.marginLeft),
      marginRight:parseFloat(style.marginRight),
      topBorder:parseFloat(style.borderTopWidth),
      bottomBorder:parseFloat(style.borderBottomWidth),
      boxShadow:style.boxShadow
    };
  });
  assert.equal(stuck.radius,0);
  assert.equal(stuck.marginLeft,0);
  assert.equal(stuck.marginRight,0);
  assert.equal(stuck.topBorder,1);
  assert.equal(stuck.bottomBorder,1);
  assert.equal(stuck.boxShadow,'none');
  await p.evaluate(()=>scrollTo(0,0));
  await p.clock.fastForward(20);
  await p.waitForFunction(()=>!document.querySelector('.tabs').classList.contains('is-stuck'));
  await p.clock.fastForward(200);
  assert.ok(await p.locator('.tabs').evaluate(el=>parseFloat(getComputedStyle(el).borderTopLeftRadius)>0));
  await p.locator('#tab-connect').click();
  const summary=p.locator('#settings-video > .setting-summary');
  const closedIcon=await summary.evaluate(el=>getComputedStyle(el,'::after').content);
  assert.ok(closedIcon.includes('▶'));
  await summary.click();
  const openIcon=await summary.evaluate(el=>getComputedStyle(el,'::after').content);
  assert.ok(openIcon.includes('▼'));
  await x.close();
 });
 await test('speaker balance sits beside the latest comment when wide and stacks below when narrow',async()=>{
  const x=await setup();const p=x.page;
  const wide=await p.evaluate(()=>{
    const layout=document.querySelector('.comment-status-layout'),status=document.querySelector('.speaker-status-section');
    return {columns:getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length,borderLeft:parseFloat(getComputedStyle(status).borderLeftWidth),borderTop:parseFloat(getComputedStyle(status).borderTopWidth)};
  });
  assert.equal(wide.columns,2);assert.ok(wide.borderLeft>0);assert.equal(wide.borderTop,0);
  await p.setViewportSize({width:800,height:900});
  const narrow=await p.evaluate(()=>{
    const layout=document.querySelector('.comment-status-layout'),status=document.querySelector('.speaker-status-section');
    return {columns:getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length,borderLeft:parseFloat(getComputedStyle(status).borderLeftWidth),borderTop:parseFloat(getComputedStyle(status).borderTopWidth)};
  });
  assert.equal(narrow.columns,1);assert.equal(narrow.borderLeft,0);assert.ok(narrow.borderTop>0);
  await x.close();
 });
 await test('desktop header and toolbar stay compact to preserve preview height',async()=>{
  const x=await setup();const p=x.page;
  const desktop=await p.evaluate(()=>{
    const header=document.querySelector('header'),toolbar=document.querySelector('.toolbar'),logo=document.querySelector('.brand-logo'),tagline=document.querySelector('.brand-copy>p');
    return {
      headerHeight:header.getBoundingClientRect().height,
      toolbarHeight:toolbar.getBoundingClientRect().height,
      logoWidth:logo.getBoundingClientRect().width,
      taglineDisplay:getComputedStyle(tagline).display
    };
  });
  assert.ok(desktop.headerHeight<=70);
  assert.ok(desktop.toolbarHeight<=52);
  assert.ok(desktop.logoWidth<=156);
  assert.equal(desktop.taglineDisplay,'none');
  await x.close();
 });
 await test('mobile header shows version under theme without increasing header content height',async()=>{
  const x=await setup();const p=x.page;
  await p.setViewportSize({width:390,height:844});
  const mobile=await p.evaluate(()=>{
    const header=document.querySelector('header'),tools=document.querySelector('.header-tools'),logo=document.querySelector('.brand-logo'),badge=document.querySelector('.header-tools>.badge'),theme=document.querySelector('.theme-picker');
    const tb=theme.getBoundingClientRect(),bb=badge.getBoundingClientRect();
    return {
      version:badge.textContent.trim(),
      badgeDisplay:getComputedStyle(badge).display,
      toolsDirection:getComputedStyle(tools).flexDirection,
      toolsHeight:tools.getBoundingClientRect().height,
      logoHeight:logo.getBoundingClientRect().height,
      headerHeight:header.getBoundingClientRect().height,
      themeTop:tb.top,
      badgeTop:bb.top
    };
  });
  assert.ok(mobile.version.includes('v4.'));
  assert.notEqual(mobile.badgeDisplay,'none');
  assert.equal(mobile.toolsDirection,'column');
  assert.ok(mobile.badgeTop>mobile.themeTop);
  assert.ok(mobile.toolsHeight<=mobile.logoHeight+1);
  assert.ok(mobile.headerHeight<=mobile.logoHeight+30);
  await x.close();
 });
 await test('saved v4 settings survive the tab reorganization',async()=>{
  const x=await setup();const p=x.page;
  await p.evaluate(()=>{
    localStorage.setItem('ai-live-commentator-content-library-v1',JSON.stringify(['ゲーム','ゲーム：The Division 2']));
    localStorage.setItem('ai-live-commentator-browser-v1',JSON.stringify({
      obsUrl:'ws://127.0.0.1:4455',sourceName:'Saved source',output:'voicevox',bouyomiUrl:'http://127.0.0.1:50080',voicevoxUrl:'http://127.0.0.1:50021',
      talkativeness:1,persona:'保存済みの会話の雰囲気',conversationHistoryCount:9,apiInterval:45,speechInterval:33,quietInterval:75,freshness:22,
      sampleInterval:3,imageWidth:320,analysisFrameCount:4,speakerWeight1:10,speakerWeight2:20,speakerWeight3:30,speakerWeight4:0,speakerWeight5:0,speakerWeight6:0,
      greetStart:false,greetEnd:true,contentName:'ゲーム：The Division 2',participantCount:3,
      profiles:[{id:'p1',name:'保存友達1',personality:'明るい',speaker:8,speedScale:1.2,bouyomiVoice:12},{id:'p2',name:'保存友達2',personality:'冷静',speaker:3,speedScale:.9,bouyomiVoice:4},{id:'p3',name:'保存友達3',personality:'好奇心旺盛',speaker:2,speedScale:1.1,bouyomiVoice:5}]
    }));
  });
  await p.reload();
  assert.equal(await p.locator('#contentName').inputValue(),'ゲーム：The Division 2');assert.equal(await p.locator('#participantCount').inputValue(),'3');
  assert.deepEqual(await p.locator('#participantSelection input:checked').evaluateAll(xs=>xs.map(x=>x.dataset.profileId)),['p1','p2','p3']);
  assert.equal(await p.locator('#persona').inputValue(),'保存済みの会話の雰囲気');assert.equal(await p.locator('#conversationHistoryCount').inputValue(),'9');
  assert.equal(await p.locator('#apiInterval').inputValue(),'45');assert.equal(await p.locator('#sampleInterval').inputValue(),'3');assert.equal(await p.locator('#analysisFrameCount').inputValue(),'4');
  assert.equal(await p.locator('#sourceName').inputValue(),'Saved source');assert.equal(await p.locator('#output').inputValue(),'voicevox');
  await p.locator('#tab-friends').click();assert.equal(await p.locator('#p1-name').inputValue(),'保存友達1');assert.equal(await p.locator('#p2-name').inputValue(),'保存友達2');assert.equal(await p.locator('#p3-name').inputValue(),'保存友達3');
  await x.close();
 });
 await test('non-contiguous friend selection is saved and limits Gemini speakers',async()=>{
  const selectedReply={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'選択確認',turns:[{speakerId:'p4',text:'四番目も参加してるね'}]})}]}}]};
  const x=await setup({answer:selectedReply,before:async p=>{await selectParticipants(p,['p2','p4']);}});const p=x.page;
  assert.deepEqual(await p.locator('#participantSelection input:checked').evaluateAll(xs=>xs.map(x=>x.dataset.profileId)),['p2','p4']);
  await start(x);await idle(p);assert.deepEqual(x.events.speakerEnums[0],['p2','p4']);assert.equal(await p.locator('#participantCount').inputValue(),'2');
  await stop(p);const saved=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));
  assert.deepEqual(saved.selectedProfileIds,['p2','p4']);assert.equal(saved.participantCount,2);
  await p.reload();assert.deepEqual(await p.locator('#participantSelection input:checked').evaluateAll(xs=>xs.map(x=>x.dataset.profileId)),['p2','p4']);
  await x.close();
 });
 await test('target content supports selectable main and indented sub items',async()=>{
  const x=await setup();const p=x.page;
  assert.deepEqual(await p.locator('#contentName option').allTextContents(),['なし']);
  await p.locator('#manageContents').click();assert.equal(await p.locator('#contentDialog').getAttribute('open'),'');
  await p.locator('#newContentName').fill('ゲーム：The Division 2');await p.locator('#addContent').click();
  assert.deepEqual(await p.locator('#contentName option').allTextContents(),['なし','ゲーム','　The Division 2']);
  assert.deepEqual(await p.locator('#contentName option').evaluateAll(os=>os.map(o=>o.value)),['','ゲーム','ゲーム：The Division 2']);
  assert.equal(await p.locator('#contentName').inputValue(),'ゲーム：The Division 2');
  assert.equal(await p.locator('.content-manage-group').count(),1);
  assert.equal(await p.locator('.content-main-row strong').textContent(),'ゲーム');
  assert.equal(await p.locator('.content-sub-row .content-sub-name').textContent(),'The Division 2');
  await p.locator('#doneContentDialog').click();
  await p.locator('#contentName').selectOption('ゲーム');await p.locator('#save').click();await p.reload();
  assert.equal(await p.locator('#contentName').inputValue(),'ゲーム');
  await p.locator('details.setting-section').evaluateAll(ds=>ds.forEach(d=>d.open=true));
  await p.locator('#contentName').selectOption('ゲーム：The Division 2');await p.locator('#save').click();await p.reload();
  assert.equal(await p.locator('#contentName').inputValue(),'ゲーム：The Division 2');
  await p.locator('details.setting-section').evaluateAll(ds=>ds.forEach(d=>d.open=true));
  await p.locator('#manageContents').click();p.once('dialog',d=>d.accept());await p.locator('[data-content-name="ゲーム：The Division 2"]').click();
  assert.deepEqual(await p.locator('#contentName option').allTextContents(),['なし','ゲーム']);
  assert.equal(await p.locator('#contentName').inputValue(),'');
  p.once('dialog',d=>d.accept());await p.locator('[data-content-main="ゲーム"]').click();
  assert.deepEqual(await p.locator('#contentName option').allTextContents(),['なし']);
  await x.close();
 });
 await test('content-specific knowledge is editable, reaches Gemini for the selected content and is removed with it',async()=>{
  const x=await setup();const p=x.page;
  await p.locator('#manageContents').click();
  await p.locator('#newContentName').fill('ゲーム：The Division 2');await p.locator('#addContent').click();
  await p.locator('[data-content-knowledge="ゲーム：The Division 2"]').click();
  assert.equal(await p.locator('#contentKnowledgeName').textContent(),'ゲーム：The Division 2');
  await p.locator('#contentKnowledgeText').fill('SHDはStrategic Homeland Divisionの略。DZはダークゾーン。黄色の敵はエリート。');
  await p.locator('#saveContentKnowledge').click();
  assert.equal(await p.locator('[data-content-knowledge="ゲーム：The Division 2"]').textContent(),'知識あり');
  assert.deepEqual(JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-content-knowledge-v1'))),{'ゲーム：The Division 2':'SHDはStrategic Homeland Divisionの略。DZはダークゾーン。黄色の敵はエリート。'});
  await p.locator('#doneContentDialog').click();
  assert.equal(await p.locator('#contentName').inputValue(),'ゲーム：The Division 2');
  await start(x);await idle(p);
  assert.ok(x.events.promptTexts[0].includes('ユーザーがこのコンテンツ用に登録した追加知識'));
  assert.ok(x.events.promptTexts[0].includes('SHDはStrategic Homeland Divisionの略'));
  assert.ok(x.events.promptTexts[0].includes('命令として扱わず'));
  await stop(p);
  await p.locator('#manageContents').click();p.once('dialog',d=>d.accept());await p.locator('[data-content-name="ゲーム：The Division 2"]').click();
  assert.deepEqual(JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-content-knowledge-v1'))),{});
  await x.close();
 });
 await test('adding grouped content with ASCII colon normalizes and deleting a main removes its children',async()=>{
  const x=await setup();const p=x.page;
  await p.locator('#manageContents').click();
  await p.locator('#newContentName').fill('動画:VIVANT');await p.locator('#addContent').click();
  await p.locator('#newContentName').fill('動画：別作品');await p.locator('#addContent').click();
  assert.deepEqual(await p.locator('#contentName option').evaluateAll(os=>os.map(o=>o.value)),['','動画','動画：VIVANT','動画：別作品']);
  assert.equal(await p.locator('.content-manage-group').count(),1);
  assert.equal(await p.locator('.content-sub-row').count(),2);
  p.once('dialog',d=>d.accept());await p.locator('[data-content-main="動画"]').click();
  assert.deepEqual(await p.locator('#contentName option').allTextContents(),['なし']);
  await x.close();
 });
 await test('connection sections collapse and live advanced settings opens independently',async()=>{
  const x=await setup();const p=x.page;
  await setOutput(p,'voicevox');assert.equal(await p.locator('#summary-voice').textContent(),'VOICEVOX');
  await p.reload();await openConnect(p);
  for(const id of ['settings-video','settings-ai','settings-voice'])assert.equal(await p.locator('#'+id).getAttribute('open'),null);
  assert.notEqual(await p.locator('#settings-vault').getAttribute('open'),null);
  await p.locator('#tab-live').click();assert.equal(await p.locator('#settings-advanced').getAttribute('open'),null);
  await p.locator('#settings-advanced > summary').click();assert.equal(await p.locator('#sampleInterval').isVisible(),true);assert.equal(await p.locator('#speakerWeight1').isVisible(),true);
  await x.close();
 });
 await test('all friend cards stay editable in two columns on desktop and one on mobile',async()=>{
  const x=await setup();const p=x.page;await youtubeSettings(p);
  await p.locator('#tab-friends').click();
  const desktop=await p.locator('#profiles .friend').evaluateAll(cards=>cards.map(c=>{const r=c.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width)};}));
  assert.equal(desktop.length,6);assert.equal(desktop[0].y,desktop[1].y);assert.ok(desktop[1].x>desktop[0].x);assert.equal(desktop[4].y,desktop[5].y);
  await p.setViewportSize({width:390,height:844});
  const mobile=await p.locator('#profiles .friend').evaluateAll(cards=>cards.map(c=>Math.round(c.getBoundingClientRect().x)));
  assert.equal(new Set(mobile).size,1);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await x.close();
 });
 await test('OBS authentication and preview send no Gemini request',async()=>{const x=await setup();await openConnect(x.page);await x.page.locator('#testObs').click();await stopped(x.page);assert.equal(x.events.images,1);assert.equal(x.events.identifies,1);assert.equal(x.events.api,0);assert.equal(await x.page.locator('#preview').isVisible(),true);await x.close();});
 await test('OBS source refresh is placed on the preview card, reapplies input settings and refreshes preview',async()=>{const x=await setup();assert.equal(await x.page.locator('#resetObsSource').evaluate(el=>el.closest('.preview-card')!==null),true);assert.equal(await x.page.locator('#settings-video #resetObsSource').count(),0);await x.page.locator('#resetObsSource').click();await stopped(x.page);const req=x.events.obsRequests.find(r=>r.type==='SetInputSettings'&&r.data.inputName==='PS Remote Play');assert.ok(req);assert.deepEqual(req.data.inputSettings,{});assert.equal(req.data.overlay,true);assert.equal(x.events.images,1);assert.equal(x.events.api,0);assert.equal(await x.page.locator('#preview').isVisible(),true);assert.ok((await x.page.locator('#log').innerText()).includes('映像ソース「PS Remote Play」を再取得'));await x.close();});
 await test('OBS source refresh stays available during streaming and reuses the active connection',async()=>{
  const x=await setup();const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.equal(await p.locator('#resetObsSource').evaluate(el=>el.closest('.preview-card')!==null),true);
  assert.equal(await p.locator('#resetObsSource').isDisabled(),false);
  const identifiesBefore=x.events.identifies;
  const resetsBefore=x.events.obsRequests.filter(r=>r.type==='SetInputSettings'&&r.data.inputName==='PS Remote Play').length;
  await p.locator('#resetObsSource').click();
  await p.waitForFunction(()=>document.getElementById('log').textContent.includes('映像ソース「PS Remote Play」を再取得'));
  assert.equal(x.events.identifies,identifiesBefore);
  assert.equal(x.events.obsRequests.filter(r=>r.type==='SetInputSettings'&&r.data.inputName==='PS Remote Play').length,resetsBefore+1);
  await stop(p);await x.close();
 });
 await test('OBS source refresh automatically resumes monitoring after a source capture failure',async()=>{
  const x=await setup({failScreenshotCount:1});const p=x.page;
  await p.locator('#start').click();
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('設定の修正待ち'));
  assert.equal(await p.locator('#resume').isVisible(),true);
  assert.equal(await p.locator('#resetObsSource').isDisabled(),false);
  await p.locator('#resetObsSource').click();await p.clock.fastForward(400);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('映像監視中')||document.getElementById('status').textContent.includes('映像履歴を準備中'));
  assert.equal(await p.locator('#resume').isVisible(),false);
  assert.ok(x.events.identifies>=2);assert.ok(x.events.images>=2);
  assert.ok((await p.locator('#log').innerText()).includes('映像ソースの再取得に成功したため、実況を自動再開します。'));
  await stop(p);await x.close();
 });
 await test('Bouyomi audio test sends speech only',async()=>{const x=await setup();await openConnect(x.page);await x.page.locator('#testVoice').click();await stopped(x.page);assert.deepEqual(x.events.talks,['こんにちは。音声テストです。']);assert.equal(x.events.api,0);await x.close();});
 await test('VOICEVOX direct applies per-friend speech speed and plays WAV',async()=>{const x=await setup();await setOutput(x.page,'voicevox');await x.page.locator('#tab-friends').click();await x.page.locator('#p1-speedScale').fill('1.25');await x.page.locator('#testVoice').click();await stopped(x.page);assert.equal(x.events.queries,1);assert.equal(x.events.synths,1);assert.deepEqual(x.events.speeds,[1.25]);assert.ok((await x.page.locator('#log').innerText()).includes('音声テスト再生完了'));await x.close();});
 await test('Bouyomi prefers speechText even when it still contains kanji and shows both texts in the UI',async()=>{
  const reading={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'読み上げ',turns:[{speakerId:'p1',text:'この性は変わらないね？',speechText:'この性質は変わらないね？'}]})}]}}]};
  const x=await setup({answer:reading});await start(x);await idle(x.page);
  assert.deepEqual(x.events.talks,['この性質は変わらないね?']);
  assert.ok((await x.page.locator('#lastComment').textContent()).includes('この性は変わらないね？'));
  assert.equal(await x.page.locator('#lastSpeechText strong').textContent(),'この性質は変わらないね？');
  await stop(x.page);await x.close();
 });
 await test('analysis never retries only because speechText matches display text',async()=>{
  const copied={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'読み上げ',turns:[{speakerId:'p1',text:'HP3でも行けそうだね？',speechText:'HP3でも行けそうだね？'}]})}]}}]};
  const x=await setup({answer:copied});await start(x);await idle(x.page);
  assert.equal(x.events.api,1);
  assert.deepEqual(x.events.talks,['HP3でも行けそうだね?']);
  assert.equal(await x.page.locator('#lastSpeechText strong').textContent(),'HP3でも行けそうだね？');
  assert.equal((await x.page.locator('#log').innerText()).includes('読みを作り直します'),false);
  await stop(x.page);await x.close();
 });
 await test('VOICEVOX shows display and speech text as soon as playback starts, before playback finishes',async()=>{
  const reading={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'読み上げ',turns:[{speakerId:'p1',text:'HP3でも行けそうだね？',speechText:'エイチピー3でもいけそうだね？'}]})}]}}]};
  const x=await setup({answer:reading,waveSamples:240000});const p=x.page;
  await setOutput(p,'voicevox');
  await p.locator('#start').click();
  await p.waitForFunction(()=>document.getElementById('lastComment').textContent.includes('HP3でも行けそうだね？'));
  assert.equal(await p.locator('#lastSpeechText strong').textContent(),'エイチピー3でもいけそうだね？');
  assert.equal(await p.locator('#delivery').textContent(),'このブラウザで再生中');
  assert.ok((await p.locator('#status').textContent()).includes('VOICEVOX'));
  await p.locator('#stop').click();await stopped(p);await x.close();
 });
 await test('VOICEVOX prefers speechText for pronunciation while keeping display text unchanged',async()=>{
  const reading={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'読み上げ',turns:[{speakerId:'p1',text:'HP3でも行けそうだね？',speechText:'エイチピー3でもいけそうだね？'}]})}]}}]};
  const x=await setup({answer:reading});await setOutput(x.page,'voicevox');await start(x);await idle(x.page);
  assert.deepEqual(x.events.voiceTexts,['エイチピー3でもいけそうだね?']);
  assert.ok((await x.page.locator('#lastComment').textContent()).includes('HP3でも行けそうだね？'));
  assert.equal(await x.page.locator('#lastSpeechText strong').textContent(),'エイチピー3でもいけそうだね？');
  await stop(x.page);await x.close();
 });
 await test('invalid or missing speechText falls back to display text instead of skipping speech',async()=>{
  const punctuationOnly={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'読み上げ',turns:[{speakerId:'p1',text:'SHDだね',speechText:'！！'}]})}]}}]};
  const x=await setup({answer:punctuationOnly});await start(x);await idle(x.page);
  assert.deepEqual(x.events.talks,['SHDだね']);
  assert.equal(await x.page.locator('#lastSpeechText strong').textContent(),'SHDだね');
  await stop(x.page);await x.close();
 });
 await test('greeting supports separate display and speech text',async()=>{
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'今日はMHを見よう',speechText:'きょうはモンハンをみよう'}]})}]}}]};
  const x=await setup({answer:intro,before:async p=>{await p.locator('#greetStart').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.deepEqual(x.events.talks,['きょうはモンハンをみよう']);assert.ok((await p.locator('#lastComment').textContent()).includes('今日はMHを見よう'));assert.equal(await p.locator('#lastSpeechText strong').textContent(),'きょうはモンハンをみよう');assert.ok(x.events.promptTexts[0].includes('表示用textと読み上げ用speechText'));
  await stop(p);await x.close();
 });
 await test('start greeting varies its direction and avoids recent greeting patterns',async()=>{
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'ちょっと楽しみだね'}]})}]}}]};
  const x=await setup({answer:intro,before:async p=>{
    await p.evaluate(()=>localStorage.setItem('ai-live-commentator-greeting-history-v1',JSON.stringify({start:['前と同じ開始だよ'],end:['前と同じ終了だよ']})));
    await p.locator('#greetStart').check();
  }});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.ok(x.events.promptTexts[0].includes('今回の変化パターン:'));
  assert.ok(x.events.promptTexts[0].includes('前と同じ開始だよ'));
  assert.ok(x.events.promptTexts[0].includes('同一・類似の入り方、語尾、意味を避ける'));
  assert.ok(x.events.promptTexts[0].includes('毎回「始まったね」「今日も見ていこう」「よろしく」の言い換えになるのを避ける'));
  const history=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-greeting-history-v1')));
  assert.equal(history.start.at(-1),'ちょっと楽しみだね');
  assert.equal(history.end.at(-1),'前と同じ終了だよ');
  await stop(p);await x.close();
 });
 await test('greeting never retries only because speechText matches display text',async()=>{
  const copied={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'今日はMHを見よう',speechText:'今日はMHを見よう'}]})}]}}]};
  const x=await setup({answer:copied,before:async p=>{await p.locator('#greetStart').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.equal(x.events.api,1);
  assert.deepEqual(x.events.talks,['今日はMHを見よう']);
  assert.equal((await p.locator('#log').innerText()).includes('読み上げ用テキストが表示文の丸コピーだったため'),false);
  await stop(p);await x.close();
 });
 await test('start greeting is shown in the OBS bubble',async()=>{
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'今日も見ていこう'}]})}]}}]};
  const x=await setup({answer:intro,before:async p=>{
    await p.locator('#greetStart').check();
    await p.locator('#tab-connect').click();await p.locator('#obsOverlayEnabled').check();await p.locator('#tab-live').click();
  }});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.ok(x.events.overlayUrls.length>0);
  const html=decodeURIComponent(x.events.overlayUrls[0].slice(x.events.overlayUrls[0].indexOf(',')+1));
  assert.ok(html.includes('今日も見ていこう'));
  assert.ok(x.events.obsRequests.find(r=>r.type==='CreateInput'&&r.data.inputName==='みんコメ 吹き出し'));
  await stop(p);await x.close();
 });
 await test('start greeting uses candidate turns even when Gemini returns speak false',async()=>{
  const silent={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:false,summary:'開始',turns:[]})}]}}]};
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'今日も見ていこう'}]})}]}}]};
  const silentWithCandidate={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:false,summary:'開始',turns:[{speakerId:'p1',text:'今日も見ていこう'}]})}]}}]};
  const x=await setup({answer:silentWithCandidate,before:async p=>{await p.locator('#greetStart').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.equal(x.events.api,1);assert.deepEqual(x.events.talks,['きょうもみていこう']);
  await stop(p);await x.close();
 });
 await test('start greeting falls back locally after two invalid generated greetings',async()=>{
  const bad={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[]})}]}}]};
  const x=await setup({answers:[bad,bad],before:async p=>{await p.locator('#greetStart').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.equal(x.events.api,2);assert.equal(x.events.talks.length,1);assert.ok(x.events.talks[0].length>0);
  assert.ok((await p.locator('#log').innerText()).includes('固定の短い挨拶'));
  const fallbackHistory=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-greeting-history-v1')));assert.equal(fallbackHistory.start.length,1);
  await stop(p);await x.close();
 });
 await test('start greeting is queued even when Bouyomi already has pending audio',async()=>{
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'今日も見ていこう'}]})}]}}]};
  const x=await setup({answer:intro,busy:true,before:async p=>{await p.locator('#greetStart').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.deepEqual(x.events.talks,['きょうもみていこう']);
  await stop(p);await x.close();
 });
 await test('start greeting uses the configured speaker-count weight',async()=>{
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'じゃあ今日も見ていこう'},{speakerId:'p2',text:'楽しんでいこうか'},{speakerId:'p3',text:'どんな感じか見てみよう'}]})}]}}]};
  const x=await setup({answer:intro,before:async p=>{
    await p.locator('#greetStart').check();await selectParticipants(p,['p1','p2','p3']);
    for(let n=1;n<=6;n++)await p.locator('#speakerWeight'+n).fill(n===3?'100':'0');
  }});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.equal(x.events.api,1);assert.deepEqual(x.events.analysisImages,[0]);assert.equal(x.events.turnLimits[0],3);
  assert.ok(x.events.promptTexts[0].includes('異なる3人が1回ずつ発言'));assert.deepEqual(x.events.talks,['じゃあ今日も見ていこう','楽しんでいこうか','どんな感じか見てみよう']);
  assert.ok((await p.locator('#log').innerText()).includes('開始の挨拶'));await stop(p);await x.close();
 });
 await test('speaker status shows selected participants and resets at the next start',async()=>{
  const x=await setup();const p=x.page;
  assert.equal(await p.locator('#speakerStatsTotal').textContent(),'0');
  assert.equal(await p.locator('#speakerStatsList .speaker-stat-row').count(),1);
  assert.equal(await p.locator('[data-speaker-id="p1"] .speaker-stat-state').textContent(),'待機');
  await start(x);await idle(p);
  assert.equal(await p.locator('#speakerStatsTotal').textContent(),'1');
  assert.equal(await p.locator('[data-speaker-id="p1"] .speaker-stat-value').textContent(),'1回 · 100%');
  assert.equal(await p.locator('[data-speaker-id="p1"] .speaker-stat-state').textContent(),'直近');
  await stop(p);
  await p.locator('#start').click();
  assert.equal(await p.locator('#speakerStatsTotal').textContent(),'0');
  await stop(p);await x.close();
 });
 await test('speaker balance uses one column up to three friends and two columns above three',async()=>{
  const x=await setup();const p=x.page;
  await selectParticipants(p,['p1','p2','p3']);
  let layout=await p.locator('#speakerStatsList').evaluate(el=>({two:el.classList.contains('two-columns'),columns:getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,rows:el.children.length}));
  assert.equal(layout.two,false);assert.equal(layout.columns,1);assert.equal(layout.rows,3);
  await selectParticipants(p,['p1','p2','p3','p4','p5','p6']);
  layout=await p.locator('#speakerStatsList').evaluate(el=>({two:el.classList.contains('two-columns'),columns:getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,rows:el.children.length}));
  assert.equal(layout.two,true);assert.equal(layout.columns,2);assert.equal(layout.rows,6);
  await x.close();
 });
 await test('normal finish uses recent history and speaker-count weight for its closing greeting',async()=>{
  const normalTwo={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進んでいる',turns:[{speakerId:'p1',text:'景色がいいね'},{speakerId:'p2',text:'この先も見てみよう'}]})}]}}]};
  const closing={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'終了',turns:[{speakerId:'p1',text:'今日はこの辺かな。また見よう'},{speakerId:'p2',text:'うん、おつかれさま'}]})}]}}]};
  const x=await setup({answers:[normalTwo,closing],before:async p=>{
    await p.locator('#greetEnd').check();await selectParticipants(p,['p1','p2']);
    await p.locator('#tab-connect').click();await p.locator('#obsOverlayEnabled').check();await p.locator('#tab-live').click();
    await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');
    for(let n=3;n<=6;n++)await p.locator('#speakerWeight'+n).fill('0');
  }});const p=x.page;
  await start(x);await idle(p);assert.equal(x.events.api,1);assert.deepEqual(x.events.talks,['景色がいいね','この先も見てみよう']);
  assert.equal(await p.locator('#speakerStatsTotal').textContent(),'2');
  assert.equal(await p.locator('[data-speaker-id="p1"] .speaker-stat-value').textContent(),'1回 · 50%');
  assert.equal(await p.locator('[data-speaker-id="p2"] .speaker-stat-value').textContent(),'1回 · 50%');
  assert.equal(await p.locator('[data-speaker-id="p2"] .speaker-stat-state').textContent(),'直近');
  assert.ok((await p.locator('#speakerStatsDonut').evaluate(el=>el.style.background)).includes('conic-gradient'));
  assert.ok((await p.locator('#speakerStatsDonut').getAttribute('aria-label')).includes('友達1 1回 50%'));
  assert.ok((await p.locator('#speakerStatsDonut').getAttribute('aria-label')).includes('友達2 1回 50%'));
  await finish(p);assert.equal(x.events.api,2);assert.deepEqual(x.events.analysisImages,[2,0]);assert.equal(x.events.turnLimits[1],2);
  assert.ok(x.events.promptTexts[1].includes('道を進んでいる'));assert.ok(x.events.promptTexts[1].includes('異なる2人が1回ずつ発言'));
  assert.deepEqual(x.events.talks,['景色がいいね','この先も見てみよう','今日はこの辺かな。また見よう','うん、おつかれさま']);
  assert.equal(await p.locator('#speakerStatsTotal').textContent(),'4');
  assert.equal(await p.locator('[data-speaker-id="p1"] .speaker-stat-value').textContent(),'2回 · 50%');
  assert.equal(await p.locator('[data-speaker-id="p2"] .speaker-stat-value').textContent(),'2回 · 50%');
  assert.ok(x.events.overlayUrls.some(url=>decodeURIComponent(url.slice(url.indexOf(',')+1)).includes('今日はこの辺かな。また見よう')));
  assert.ok((await p.locator('#log').innerText()).includes('実況を通常終了しました。'));await x.close();
 });
 await test('immediate stop skips the configured closing greeting',async()=>{
  const x=await setup({before:async p=>{await p.locator('#greetEnd').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);assert.equal(x.events.api,0);
  await stop(p);assert.equal(x.events.api,0);assert.equal(x.events.talks.length,0);await x.close();
 });
 await test('speaker-count weights force the sampled exact count and are saved',async()=>{
  const two={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道',turns:[{speakerId:'p1',text:'まず見てみよう'},{speakerId:'p2',text:'うん、気になるね'}]})}]}}]};
  const x=await setup({answer:two,before:async p=>{
    await selectParticipants(p,['p1','p2','p3']);
    for(let n=1;n<=6;n++)await p.locator('#speakerWeight'+n).fill(n===2?'100':'0');
  }});const p=x.page;
  await start(x);await idle(p);assert.equal(x.events.api,1);assert.equal(x.events.turnLimits[0],2);
  assert.ok(x.events.promptTexts[0].includes('今回の候補発言人数: 2人'));assert.equal(x.events.talks.length,2);
  await stop(p);const saved=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));
  assert.equal(saved.speakerWeight2,100);assert.equal(saved.speakerWeight1,0);await x.close();
 });
 await test('sampled speaker count rejects fewer turns and duplicate speakers',async()=>{
  const tooFew={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'不足',turns:[{speakerId:'p1',text:'一人しかいないね'}]})}]}}]};
  const x=await setup({answer:tooFew,before:async p=>{await selectParticipants(p,['p1','p2']);await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');}});const p=x.page;
  await start(x);await p.waitForFunction(()=>document.getElementById('status').textContent.includes('自動再開まで'));
  assert.equal(x.events.talks.length,0);assert.ok((await p.locator('#log').innerText()).includes('発言人数が今回の抽選結果と一致しません'));
  await stop(p);await x.close();
 });
 await test('configured analysis frame count sends the latest four frames',async()=>{
  const x=await setup({before:async p=>{await p.locator('#analysisFrameCount').selectOption('4');}});const p=x.page;
  await p.locator('#start').click();await idle(p);assert.equal(x.events.api,0);
  for(let i=0;i<3;i++){await p.clock.fastForward(4100);if(i<2)await idle(p);}
  await p.waitForFunction(()=>document.getElementById('usage').textContent==='1 回');
  assert.equal(x.events.api,1);assert.equal(x.events.analysisImages[0],4);assert.equal(x.events.images,4);
  await stop(p);await x.close();
 });
 await test('OBS comment overlay creates a speech-bubble Browser Source and fully hides it after use',async()=>{
  const x=await setup({legacyOverlay:true,before:async p=>{
    await p.locator('#tab-connect').click();
    await p.locator('#obsOverlayEnabled').check();
    await p.locator('#obsOverlayPosition').selectOption('bottom-right');
    await p.locator('#manageFonts').click();
    await p.locator('#newFontName').fill('Meiryo');
    await p.locator('#addFont').click();
    await p.locator('#doneFontDialog').click();
    await p.locator('#obsOverlayFont').selectOption('Meiryo');
    await p.locator('#obsOverlayFontSize').fill('44');
    await p.locator('#obsOverlayShowName').uncheck();
    await p.locator('#obsOverlayBold').check();
    await p.locator('#obsOverlayHold').fill('2');
    await p.locator('#tab-live').click();
  }});const p=x.page;
  await start(x);await idle(p);
  for(let i=0;i<200&&!x.events.overlayUrls.length;i++)await new Promise(r=>setTimeout(r,10));
  const create=x.events.obsRequests.find(r=>r.type==='CreateInput'&&r.data.inputName==='みんコメ 吹き出し');
  assert.ok(create);assert.equal(create.data.inputKind,'browser_source');
  const url=x.events.overlayUrls[0];assert.ok(url.startsWith('data:text/html;charset=utf-8,'));
  const html=decodeURIComponent(url.slice(url.indexOf(',')+1));
  assert.ok(html.includes('class="bubble"'));assert.ok(html.includes('.bubble:before'));assert.ok(html.includes('.bubble:after'));
  assert.ok(html.includes('width:fit-content'));assert.ok(html.includes('max-width:100%'));
  assert.ok(html.includes('clip-path:polygon(0 0,100% 0,50% 100%)'));
  assert.ok(html.includes('-webkit-text-stroke:3px #0f2935'));
  assert.ok(html.includes('paint-order:stroke fill'));
  assert.ok(html.includes('font-weight:700'));
  assert.ok(html.includes('"Meiryo"'));assert.ok(html.includes('景色がいいね'));
  assert.equal(html.includes('class="name"'),false);
  assert.ok(x.events.overlayTransforms.some(t=>t.positionX>900&&t.positionY>500));
  assert.ok(x.events.overlayEnabled.some(e=>e.sceneItemId===99&&e.enabled===true));
  assert.ok(x.events.overlayEnabled.some(e=>e.sceneItemId===77&&e.enabled===false));
  await p.clock.fastForward(2100);
  assert.ok(x.events.overlayEnabled.some(e=>e.sceneItemId===99&&e.enabled===false));
  await stop(p);
  const saved=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));
  assert.equal(saved.obsOverlayEnabled,true);assert.equal(saved.obsOverlayPosition,'bottom-right');
  assert.equal(saved.obsOverlayFont,'Meiryo');assert.equal(saved.obsOverlayShowName,false);assert.equal(saved.obsOverlayBold,true);
  const fonts=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-font-library-v1')));
  assert.deepEqual(fonts,['Meiryo']);
  await x.close();
 });
 await test('OBS bubble forces long comments into at most two explicit non-wrapping lines',async()=>{
  const longAnswer={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'長文',turns:[{speakerId:'p1',text:'この先の景色もかなり変わってきたしそろそろ何かありそうな感じするね'}]})}]}}]};
  const x=await setup({answer:longAnswer,before:async p=>{
    await p.locator('#tab-connect').click();await p.locator('#obsOverlayEnabled').check();await p.locator('#tab-live').click();
  }});const p=x.page;
  await start(x);await idle(p);
  for(let i=0;i<200&&!x.events.overlayUrls.length;i++)await new Promise(r=>setTimeout(r,10));
  const html=decodeURIComponent(x.events.overlayUrls[0].slice(x.events.overlayUrls[0].indexOf(',')+1));
  assert.equal((html.match(/class="line"/g)||[]).length,2);
  assert.ok(html.includes('.line{display:block;white-space:nowrap}'));
  const create=x.events.obsRequests.find(r=>r.type==='CreateInput'&&r.data.inputName==='みんコメ 吹き出し');
  assert.ok(create.data.inputSettings.width>700);
  assert.ok(create.data.inputSettings.height>=420);
  await stop(p);await x.close();
 });
 await test('OBS bubble shows friend name by default and saves font/name preferences',async()=>{
  const x=await setup();const p=x.page;
  await p.locator('#tab-connect').click();
  await p.locator('#obsOverlayEnabled').check();
  assert.equal(await p.locator('#obsOverlayShowName').isChecked(),true);
  assert.equal(await p.locator('#obsOverlayBold').isChecked(),false);
  assert.equal(await p.locator('#obsOverlayFont').inputValue(),'system');
  assert.deepEqual(await p.locator('#obsOverlayFont option').allTextContents(),['システム標準']);
  await p.locator('#testObsOverlay').click();
  for(let i=0;i<200&&!x.events.overlayUrls.length;i++)await new Promise(r=>setTimeout(r,10));
  const html=decodeURIComponent(x.events.overlayUrls[0].slice(x.events.overlayUrls[0].indexOf(',')+1));
  assert.ok(html.includes('class="name"'));assert.ok(html.includes('友達1'));
  assert.ok(html.includes('font-weight:400'));assert.ok(html.includes('-webkit-text-stroke:3px #0f2935'));
  await stopped(p);await x.close();
 });
 await test('OBS font manager adds and removes custom font names',async()=>{
  const x=await setup();const p=x.page;
  await p.locator('#tab-connect').click();await p.locator('#obsOverlayEnabled').check();
  await p.locator('#manageFonts').click();
  await p.locator('#newFontName').fill('M PLUS Rounded 1c');await p.locator('#addFont').click();
  assert.ok((await p.locator('#fontManageList').innerText()).includes('M PLUS Rounded 1c'));
  await p.locator('#doneFontDialog').click();
  assert.equal(await p.locator('#obsOverlayFont').inputValue(),'M PLUS Rounded 1c');
  p.once('dialog',d=>d.accept());
  await p.locator('#manageFonts').click();
  await p.locator('#fontManageList [data-font-name="M PLUS Rounded 1c"]').click();
  await p.locator('#doneFontDialog').click();
  assert.equal(await p.locator('#obsOverlayFont').inputValue(),'system');
  assert.deepEqual(JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-font-library-v1'))),[]);
  await x.close();
 });
 await test('next Gemini request treats previous speech as non-reply history without speaker labels',async()=>{
  const first={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'最初',turns:[{speakerId:'p1',text:'前のコメントだよ'}]})}]}}]};
  const second={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:false,summary:'次',turns:[{speakerId:'p1',text:'別の話にしよう'}]})}]}}]};
  const x=await setup({answers:[first,second],before:async p=>{await p.locator('#apiInterval').fill('30');await p.locator('#quietInterval').fill('30');}});const p=x.page;
  await start(x);await idle(p);assert.equal(x.events.api,1);
  await p.clock.fastForward(31000);
  for(let i=0;i<200&&x.events.api<2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(x.events.api,2);
  const prompt=x.events.promptTexts[1];
  assert.ok(prompt.includes('過去に読み上げ済みの発言（古い順・返答対象ではなく重複回避用）'));
  assert.ok(prompt.includes('・前のコメントだよ'));
  assert.equal(prompt.includes('友達1: 前のコメントだよ'),false);
  await stop(p);await x.close();
 });
 await test('one-second capture continues while Gemini is still responding',async()=>{
  const x=await setup({hold:true,before:async p=>{await p.locator('#sampleInterval').fill('1');}});const p=x.page;
  await p.locator('#start').click();await idle(p);await p.waitForFunction(()=>document.getElementById('elapsed').textContent.startsWith('最終取得 '));
  await p.clock.fastForward(1100);await p.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');
  const before=x.events.images;await p.clock.fastForward(3100);assert.ok(x.events.images>=before+3);
  assert.ok((await p.locator('#elapsed').textContent()).startsWith('最終取得 '));
  await stop(p);await x.held()?.abort().catch(()=>{});await x.close();
 });
 await test('low-motion scene waits for two quiet intervals before relaxed chat mode',async()=>{
  const x=await setup({before:async p=>{
    await p.locator('#apiInterval').fill('30');await p.locator('#quietInterval').fill('30');await p.locator('#freshness').fill('180');
  }});const p=x.page;
  await start(x);await idle(p);assert.equal(x.events.api,1);
  assert.ok(x.events.promptTexts[0].includes('通常実況モード'));
  await p.clock.fastForward(31000);
  for(let i=0;i<200&&x.events.api<2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(x.events.api,2);
  assert.ok(x.events.promptTexts[1].includes('通常実況モード'));
  assert.equal(x.events.promptTexts[1].includes('「雑談モード」'),false);
  await p.clock.fastForward(31000);
  for(let i=0;i<200&&x.events.api<3;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(x.events.api,3);
  assert.ok(x.events.promptTexts[2].includes('「雑談モード」'));
  assert.ok(x.events.promptTexts[2].includes('飲み物を取りに行く'));
  assert.ok(x.events.promptTexts[2].includes('埋め草として使わない'));
  assert.ok((await p.locator('#log').innerText()).includes('雑談モード'));
  await stop(p);await x.close();
 });
 await test('successful analysis continues beyond former request cap until manual stop',async()=>{
  const x=await setup();await start(x);await idle(x.page);assert.equal(x.events.api,1);assert.deepEqual(x.events.talks,['景色がいいね']);
  for(let i=0;i<21;i++){await x.page.clock.fastForward(61000);await idle(x.page);}
  assert.ok(x.events.api>20);assert.equal(await x.page.locator('#stop').isEnabled(),true);await stop(x.page);await x.close();
 });
 await test('freshness timeout increments stale immediately and retries from newest frames without cooldown',async()=>{const x=await setup({hold:true});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');await x.page.clock.fastForward(16000);await x.page.waitForFunction(()=>Number(document.getElementById('staleCount').textContent)>=1);assert.equal(x.events.talks.length,0);assert.ok(x.events.api>=1);assert.ok(!(await x.page.locator('#log').innerText()).includes('0秒待機し'));await stop(x.page);await x.held()?.fulfill({contentType:'application/json',body:JSON.stringify(answer)}).catch(()=>{});await x.close();});
 await test('freshness includes VOICEVOX synthesis; late audio is not played',async()=>{
  const x=await setup({holdSynth:true});const p=x.page;await setOutput(p,'voicevox');await start(x);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('音声生成'));
  while(!x.events.synths)await new Promise(r=>setTimeout(r,10));const imagesBefore=x.events.images;
  await p.clock.fastForward(16000);await recovery(p);assert.ok(x.events.images>=imagesBefore+3);await stop(p);assert.equal(await p.locator('#staleCount').innerText(),'1');assert.ok(!(await p.locator('#log').innerText()).includes('AI: 景色'));
  await x.held()?.abort().catch(()=>{});await x.close();
 });
 await test('stop cancels pending analysis, with no late speech',async()=>{const x=await setup({hold:true,max:20});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');await x.page.locator('#stop').click();await stopped(x.page);await x.held()?.fulfill({contentType:'application/json',body:JSON.stringify(answer)}).catch(()=>{});assert.equal(x.events.talks.length,0);assert.equal(x.events.api,1);await x.close();});
 await test('429 backs off without stopping; stop cancels waiting',async()=>{
  const x=await setup({status:429});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent.includes('頻度制限・再試行まで'));assert.equal(x.events.api,1);
  await x.page.clock.fastForward(29000);assert.equal(x.events.api,1);assert.equal(await x.page.locator('#stop').isEnabled(),true);
  await stop(x.page);await x.page.clock.fastForward(900000);assert.equal(x.events.api,1);await x.close();
 });
 await test('repeated 429 retries at 30 then 60 seconds and resumes after success',async()=>{
  const x=await setup({status:429,failCount:2});const p=x.page;await start(x);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('頻度制限・再試行まで'));assert.equal(x.events.api,1);
  await p.clock.fastForward(31000);
  for(let i=0;i<200&&x.events.api<2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(x.events.api,2);await p.waitForFunction(()=>document.getElementById('status').textContent.includes('頻度制限・再試行まで'));
  await p.clock.fastForward(61000);
  for(let i=0;i<300&&x.events.api<3;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(x.events.api,3);await idle(p);assert.deepEqual(x.events.talks,['景色がいいね']);
  await stop(p);await x.close();
 });
 await test('503 retries at a fixed 5 seconds while capture keeps refreshing frames',async()=>{
  const x=await setup({status:503,failCount:4});const p=x.page;await start(x);await recovery(p);
  for(let i=0;i<4;i++){await p.clock.fastForward(5100);if(i<3)await recovery(p);else await idle(p);}
  assert.equal(x.events.api,5);assert.ok(x.events.images>=5);assert.deepEqual(x.events.talks,['景色がいいね']);
  assert.ok((await p.locator('#log').innerText()).includes('その間も映像取得を続けて'));await stop(p);await x.close();
 });
 await test('auth waits for correction without repeated API requests, then resumes',async()=>{
  const x=await setup({status:403,failCount:1});await start(x);await x.page.waitForFunction(()=>!document.getElementById('resume').hidden);
  await x.page.clock.fastForward(600000);assert.equal(x.events.api,1);assert.equal(await x.page.locator('#apiKey').isEnabled(),true);
  await x.page.locator('#resume').click();await idle(x.page);await x.page.clock.fastForward(4100);await idle(x.page);
  assert.equal(x.events.api,2);assert.deepEqual(x.events.talks,['景色がいいね']);await stop(x.page);await x.close();
 });
 await test('busy Bouyomi queue is not overwritten',async()=>{const x=await setup({busy:true});await start(x);await idle(x.page);assert.equal(x.events.talks.length,0);assert.ok((await x.page.locator('#log').innerText()).includes('再生待ち'));await stop(x.page);await x.close();});
 await test('Gemini prefetches the next comment while the current VOICEVOX conversation is still active',async()=>{
  const first={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進む',turns:[{speakerId:'p1',text:'景色がいいね'},{speakerId:'p2',text:'この道きれいだね'}]})}]}}]};
  const next={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'さらに進む',turns:[{speakerId:'p1',text:'まだ先がありそうだね'},{speakerId:'p2',text:'もう少し見てみよう'}]})}]}}]};
  const x=await setup({answers:[first,next],holdSynthAt:2});const p=x.page;
  await setOutput(p,'voicevox');await p.locator('#tab-friends').click();await selectParticipants(p,['p1','p2']);
  await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');
  await p.locator('#apiInterval').fill('30');await p.locator('#quietInterval').fill('30');await p.locator('#speechInterval').fill('600');await p.locator('#freshness').fill('180');
  await start(x);
  for(let i=0;i<200&&!x.held();i++)await new Promise(r=>setTimeout(r,10));assert.ok(x.held());assert.equal(x.events.api,1);
  await p.clock.fastForward(31000);
  for(let i=0;i<200&&x.events.api<2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(x.events.api,2);assert.ok(x.events.promptTexts[1].includes('景色がいいね'));assert.ok(x.events.promptTexts[1].includes('この道きれいだね'));
  await x.held().fulfill({contentType:'audio/wav',body:wave()});
  for(let i=0;i<300&&!((await p.locator('#lastComment').textContent()).includes('まだ先がありそうだね'));i++)await new Promise(r=>setTimeout(r,10));
  assert.ok((await p.locator('#lastComment').textContent()).includes('まだ先がありそうだね'));assert.ok(x.events.synths>=3);
  assert.ok((await p.locator('#log').innerText()).includes('次の発言候補を先読みしました。'));await stop(p);await x.close();
 });
 await test('VOICEVOX prefetches the next turn while the current turn is still playing',async()=>{
  const multi={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道',turns:[{speakerId:'p1',text:'景色がいいね'},{speakerId:'p2',text:'この道きれいだね'}]})}]}}]};
  const x=await setup({answer:multi,holdSynthAt:2,waveSamples:48000});const p=x.page;
  await setOutput(p,'voicevox');await p.locator('#tab-friends').click();await selectParticipants(p,['p1','p2']);await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');await start(x);
  for(let i=0;i<200&&!x.held();i++)await new Promise(r=>setTimeout(r,10));assert.ok(x.held());
  assert.ok(!(await p.locator('#lastComment').textContent()).includes('友達1：'));assert.equal(x.events.synths,2);
  await stop(p);await x.held()?.abort().catch(()=>{});await x.close();
 });
 await test('two speakers use one generation and distinct VOICEVOX voices in order',async()=>{
  const multi={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道',turns:[{speakerId:'p2',text:'この道きれいだね'},{speakerId:'p1',text:'寄り道したくなるね'}]})}]}}]};
  const x=await setup({answer:multi});const p=x.page;await setOutput(p,'voicevox');await p.locator('#tab-friends').click();await selectParticipants(p,['p1','p2']);await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');
  await start(x);await idle(p);assert.equal(x.events.api,1);assert.deepEqual(x.events.voices,['2','3']);assert.ok((await p.locator('#lastComment').textContent()).includes('友達1'));
  await stop(p);await x.close();
 });
 for(const cancel of [false,true])await test(cancel?'stop during later speech cancels remaining conversation':'three speakers finish after freshness expires once conversation has started',async()=>{
  const turns=[{speakerId:'p1',text:'景色がいいね'},{speakerId:'p2',text:'こっちも見てみようよ'},{speakerId:'p3',text:'ちょっと寄り道しよう'}];
  const reply={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進む',turns})}]}}]};
  const x=await setup({answer:reply,holdSynthAt:2});const p=x.page;
  await setOutput(p,'voicevox');await p.locator('#tab-friends').click();await selectParticipants(p,['p1','p2','p3']);await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('0');await p.locator('#speakerWeight3').fill('100');await start(x);
  await p.waitForFunction(()=>document.getElementById('lastComment').textContent.includes('友達1：'));
  for(let i=0;i<200&&!x.held();i++)await new Promise(r=>setTimeout(r,10));assert.ok(x.held());
  await p.clock.fastForward(16000);assert.equal(await p.locator('#staleCount').textContent(),'0');
  if(cancel){await stop(p);await x.held().fulfill({contentType:'audio/wav',body:wave()}).catch(()=>{});assert.equal(x.events.synths,2);assert.ok((await p.locator('#lastComment').textContent()).includes('友達1：'));}
  else {await x.held().fulfill({contentType:'audio/wav',body:wave()});await idle(p);assert.deepEqual(x.events.voices,['3','2','3']);assert.ok((await p.locator('#lastComment').textContent()).includes('友達3：'));assert.equal(await p.locator('#staleCount').textContent(),'0');await stop(p);}
  assert.equal(x.events.api,1);await x.close();
 });
 await test('encrypted credentials survive reload, require passphrase, and lock clears fields',async()=>{
  const x=await setup();const p=x.page;await youtubeSettings(p);await p.locator('#vaultPass').fill('a sufficiently long phrase');await p.locator('#vaultConfirm').fill('a sufficiently long phrase');await p.locator('#vaultSave').click();
  await p.waitForFunction(()=>document.getElementById('vaultState').textContent.includes('暗号化して保存しました'));
  const raw=await p.evaluate(()=>JSON.stringify(localStorage));assert.ok(!raw.includes('fake.test-key')&&!raw.includes('obs-secret')&&!raw.includes('sufficiently')&&!raw.includes('youtube-test-key'));
  await p.reload();assert.equal(await p.locator('#apiKey').inputValue(),'');
  await openConnect(p);await p.locator('#vaultPass').fill('wrong passphrase');await p.locator('#vaultUnlock').click();await p.waitForFunction(()=>document.getElementById('vaultState').textContent.includes('解除できません'));
  assert.equal(await p.locator('#apiKey').inputValue(),'');await p.locator('#vaultPass').fill('a sufficiently long phrase');await p.locator('#vaultUnlock').click();
  await p.waitForFunction(()=>document.getElementById('vaultState').textContent.startsWith('解除しました'));
  assert.equal(await p.locator('#apiKey').inputValue(),'fake.test-key');assert.equal(await p.locator('#obsPassword').inputValue(),'obs-secret');assert.equal(await p.locator('#vaultPass').inputValue(),'');assert.equal(await p.locator('#youtubeApiKey').inputValue(),'youtube-test-key');
  await p.locator('#vaultLock').click();assert.equal(await p.locator('#apiKey').inputValue(),'');assert.equal(await p.locator('#obsPassword').inputValue(),'');assert.equal(await p.locator('#youtubeApiKey').inputValue(),'');await x.close();
 });
 await test('old settings migrate voice IDs; tabs and mobile stop remain accessible',async()=>{
  const x=await setup();const p=x.page;
  await p.evaluate(()=>localStorage.setItem('ai-live-commentator-browser-v1',JSON.stringify({speaker:8,bouyomiVoice:12,maxRequests:1,resume503:false,sourceName:'Old source'})));
  await p.reload();assert.equal(await p.locator('#analysisFrameCount').inputValue(),'2');assert.deepEqual(await p.locator('#participantSelection input:checked').evaluateAll(xs=>xs.map(x=>x.dataset.profileId)),['p1']);await p.locator('#tab-friends').click();assert.equal(await p.locator('#participantCount').inputValue(),'1');assert.equal(await p.locator('#p1-speaker').inputValue(),'8');assert.equal(await p.locator('#p1-speedScale').inputValue(),'1');assert.equal(await p.locator('#p1-bouyomiVoice').inputValue(),'12');
  await p.locator('#tab-friends').press('ArrowRight');assert.equal(await p.locator('#tab-connect').getAttribute('aria-selected'),'true');
  await p.locator('#tab-connect').press('ArrowRight');assert.equal(await p.locator('#tab-history').getAttribute('aria-selected'),'true');
  await p.setViewportSize({width:390,height:844});await p.locator('#openHelp').click();assert.equal(await p.locator('#helpDialog').getAttribute('open'),'');await p.locator('#doneHelpDialog').click();await p.evaluate(()=>scrollTo(0,document.body.scrollHeight));
  const bounds=await p.locator('#start').boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=844);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.setViewportSize({width:1280,height:600});await p.evaluate(()=>scrollTo(0,0));assert.equal(await p.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);
  await x.close();
 });
 await test('LAN IP works for authenticated OBS, Bouyomi and VOICEVOX',async()=>{
  const x=await setup({host:'192.168.1.10'});const p=x.page;await openConnect(p);assert.equal(await p.locator('#voicevoxSettingsLink').getAttribute('href'),'http://192.168.1.10:50021/setting');
  await p.locator('#testObs').click();await stopped(p);assert.equal(x.events.images,1);assert.equal(x.events.identifies,1);
  await p.locator('#testVoice').click();await stopped(p);assert.equal(x.events.talks.length,1);
  await setOutput(p,'voicevox');await p.locator('#testVoice').click();await stopped(p);assert.equal(x.events.synths,1);assert.equal(x.events.api,0);
  await x.close();
 });
 console.log(`${results.length} browser scenarios passed. No live Gemini/OBS/voice services used.`);await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
