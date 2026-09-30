// Development only: npm install playwright, then set CHROME_PATH if necessary.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const entry='file://'+path.resolve(__dirname,'../index.html');
const sha=s=>createHash('sha256').update(s).digest('base64');
const answer={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進んでいる',turns:[{speakerId:'p1',text:'景色がいいね'}]})}]}}]};
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
  const events={images:0,api:0,analysisImages:[],turnLimits:[],promptTexts:[],talks:[],queries:0,voices:[],speeds:[],synths:0,identifies:0,unexpected:[]};let held=null;
  await page.clock.install();
  await page.route('https://**/*',async r=>{
   if(!r.request().url().startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent')){events.unexpected.push(r.request().url());return r.abort();}
   events.api++;assert.equal(r.request().headers()['x-goog-api-key'],'fake.test-key');
   const requestBody=JSON.parse(r.request().postData()||'{}');const parts=requestBody.contents?.[0]?.parts||[];events.analysisImages.push(parts.filter(p=>p.inlineData).length);events.turnLimits.push(requestBody.generationConfig?.responseSchema?.properties?.turns?.maxItems??null);events.promptTexts.push(parts.filter(p=>typeof p.text==='string').map(p=>p.text).join('\n'));
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
   if(u.pathname==='/audio_query'){events.queries++;events.voices.push(u.searchParams.get('speaker'));return r.fulfill({contentType:'application/json',body:'{}'});}
   if(u.pathname==='/synthesis'){
    events.synths++;events.speeds.push(JSON.parse(r.request().postData()||'{}').speedScale);if(config.holdSynth || events.synths===config.holdSynthAt){held=r;return;}
    return r.fulfill({contentType:'audio/wav',body:wave(config.waveSamples)});
   }await r.abort();
  });
  let jpeg;
  await page.routeWebSocket(`ws://${host}:4455`,ws=>{
   ws.onMessage(raw=>{
    const m=JSON.parse(raw);
    if(m.op===1){events.identifies++;assert.equal(m.d.authentication,sha(sha('obs-secret'+'salt')+'challenge'));ws.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));}
    if(m.op===6){events.images++;ws.send(JSON.stringify({op:7,d:{requestId:m.d.requestId,requestStatus:{result:true,code:100},responseData:{imageData:jpeg.replace('image/jpeg','image/jpg')}}}));}
   });ws.send(JSON.stringify({op:0,d:{rpcVersion:1,authentication:{salt:'salt',challenge:'challenge'}}}));
  });
  await page.goto(entry);
  await page.locator('details.setting-section').evaluateAll(ds=>ds.forEach(d=>d.open=true));
  await page.locator('#greetStart').uncheck();await page.locator('#greetEnd').uncheck();
  jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.fillStyle='#345a4b';x.fillRect(0,0,640,360);return c.toDataURL('image/jpeg');});
  await page.locator('#apiKey').fill('fake.test-key');await page.locator('#obsPassword').fill('obs-secret');await page.locator('#freeTier').check();
  await page.locator('summary').filter({hasText:'画像・通信'}).click();await page.locator('#sampleInterval').fill('4');
  if(config.host){await page.locator('#output').selectOption('voicevox');await page.locator('#voicevoxUrl').fill(`http://${host}:50021`);await page.locator('#output').selectOption('bouyomi');for(const [id,port,proto] of [['obsUrl',4455,'ws'],['bouyomiUrl',50080,'http']])await page.locator('#'+id).fill(`${proto}://${host}:${port}`);}
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
 async function test(name,fn){await fn();results.push(name);console.log('PASS:',name);}
 await test('file startup, responsive layout, settings persistence excludes credentials',async()=>{
  const x=await setup();const p=x.page;await p.locator('#save').click();const data=await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1'));
  assert.ok(!data.includes('fake.test-key')&&!data.includes('obs-secret')&&!data.includes('freeTier'));
  await p.reload();assert.equal(await p.locator('#apiKey').inputValue(),'');assert.equal(await p.locator('#freeTier').isChecked(),false);assert.equal(await p.locator('#sampleInterval').getAttribute('min'),'1');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/desktop.png'),fullPage:true});
  await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/mobile.png'),fullPage:true});await x.close();
 });
 await test('settings sections collapse, summarize values and persist open state',async()=>{
  const x=await setup();const p=x.page;
  await p.locator('#output').selectOption('voicevox');await p.locator('#analysisFrameCount').selectOption('4');await p.locator('#sampleInterval').fill('1');
  assert.equal(await p.locator('#summary-voice').textContent(),'VOICEVOX');assert.ok((await p.locator('#summary-frequency').textContent()).includes('4枚・1秒取得'));
  await p.locator('#settings-video > summary').click();await p.locator('#settings-ai > summary').click();
  assert.equal(await p.locator('#settings-video').getAttribute('open'),null);assert.equal(await p.locator('#settings-ai').getAttribute('open'),null);
  await p.reload();assert.equal(await p.locator('#settings-video').getAttribute('open'),null);assert.equal(await p.locator('#settings-ai').getAttribute('open'),null);
  assert.notEqual(await p.locator('#settings-frequency').getAttribute('open'),null);await x.close();
 });
 await test('OBS authentication and preview send no Gemini request',async()=>{const x=await setup();await x.page.locator('#testObs').click();await stopped(x.page);assert.equal(x.events.images,1);assert.equal(x.events.identifies,1);assert.equal(x.events.api,0);assert.equal(await x.page.locator('#preview').isVisible(),true);await x.close();});
 await test('Bouyomi audio test sends speech only',async()=>{const x=await setup();await x.page.locator('#testVoice').click();await stopped(x.page);assert.deepEqual(x.events.talks,['こんにちは。音声テストです。']);assert.equal(x.events.api,0);await x.close();});
 await test('VOICEVOX direct applies per-friend speech speed and plays WAV',async()=>{const x=await setup();await x.page.locator('#output').selectOption('voicevox');await x.page.locator('#tab-friends').click();await x.page.locator('#p1-speedScale').fill('1.25');await x.page.locator('#testVoice').click();await stopped(x.page);assert.equal(x.events.queries,1);assert.equal(x.events.synths,1);assert.deepEqual(x.events.speeds,[1.25]);assert.ok((await x.page.locator('#log').innerText()).includes('音声テスト再生完了'));await x.close();});
 await test('start greeting uses the configured speaker-count weight',async()=>{
  const intro={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'開始',turns:[{speakerId:'p1',text:'じゃあ今日も見ていこう'}]})}]}}]};
  const x=await setup({answer:intro,before:async p=>{
    await p.locator('#greetStart').check();await p.locator('#participantCount').selectOption('3');
    for(let n=1;n<=6;n++)await p.locator('#speakerWeight'+n).fill(n===3?'100':'0');
  }});const p=x.page;
  await p.locator('#start').click();await idle(p);
  assert.equal(x.events.api,1);assert.deepEqual(x.events.analysisImages,[0]);assert.equal(x.events.turnLimits[0],3);
  assert.ok(x.events.promptTexts[0].includes('今回の発言人数上限は3人'));assert.deepEqual(x.events.talks,['じゃあ今日も見ていこう']);
  assert.ok((await p.locator('#log').innerText()).includes('開始の挨拶'));await stop(p);await x.close();
 });
 await test('normal finish uses recent history and speaker-count weight for its closing greeting',async()=>{
  const closing={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'終了',turns:[{speakerId:'p1',text:'今日はこの辺かな。また見よう'}]})}]}}]};
  const x=await setup({answers:[answer,closing],before:async p=>{
    await p.locator('#greetEnd').check();await p.locator('#participantCount').selectOption('2');
    await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');
    for(let n=3;n<=6;n++)await p.locator('#speakerWeight'+n).fill('0');
  }});const p=x.page;
  await start(x);await idle(p);assert.equal(x.events.api,1);assert.deepEqual(x.events.talks,['景色がいいね']);
  await finish(p);assert.equal(x.events.api,2);assert.deepEqual(x.events.analysisImages,[2,0]);assert.equal(x.events.turnLimits[1],2);
  assert.ok(x.events.promptTexts[1].includes('道を進んでいる'));assert.ok(x.events.promptTexts[1].includes('今回の発言人数上限は2人'));
  assert.deepEqual(x.events.talks,['景色がいいね','今日はこの辺かな。また見よう']);
  assert.ok((await p.locator('#log').innerText()).includes('実況を通常終了しました。'));await x.close();
 });
 await test('immediate stop skips the configured closing greeting',async()=>{
  const x=await setup({before:async p=>{await p.locator('#greetEnd').check();}});const p=x.page;
  await p.locator('#start').click();await idle(p);assert.equal(x.events.api,0);
  await stop(p);assert.equal(x.events.api,0);assert.equal(x.events.talks.length,0);await x.close();
 });
 await test('speaker-count weights force the sampled maximum and are saved',async()=>{
  const two={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道',turns:[{speakerId:'p1',text:'まず見てみよう'},{speakerId:'p2',text:'うん、気になるね'}]})}]}}]};
  const x=await setup({answer:two,before:async p=>{
    await p.locator('#participantCount').selectOption('3');
    for(let n=1;n<=6;n++)await p.locator('#speakerWeight'+n).fill(n===2?'100':'0');
  }});const p=x.page;
  await start(x);await idle(p);assert.equal(x.events.api,1);assert.equal(x.events.turnLimits[0],2);
  assert.ok(x.events.promptTexts[0].includes('今回の発言人数上限: 2人'));assert.equal(x.events.talks.length,2);
  await stop(p);const saved=JSON.parse(await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1')));
  assert.equal(saved.speakerWeight2,100);assert.equal(saved.speakerWeight1,0);await x.close();
 });
 await test('configured analysis frame count sends the latest four frames',async()=>{
  const x=await setup({before:async p=>{await p.locator('#analysisFrameCount').selectOption('4');}});const p=x.page;
  await p.locator('#start').click();await idle(p);assert.equal(x.events.api,0);
  for(let i=0;i<3;i++){await p.clock.fastForward(4100);if(i<2)await idle(p);}
  await p.waitForFunction(()=>document.getElementById('usage').textContent==='1 回');
  assert.equal(x.events.api,1);assert.equal(x.events.analysisImages[0],4);assert.equal(x.events.images,4);
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
 await test('successful analysis continues beyond former request cap until manual stop',async()=>{
  const x=await setup();await start(x);await idle(x.page);assert.equal(x.events.api,1);assert.deepEqual(x.events.talks,['景色がいいね']);
  for(let i=0;i<21;i++){await x.page.clock.fastForward(61000);await idle(x.page);}
  assert.ok(x.events.api>20);assert.equal(await x.page.locator('#stop').isEnabled(),true);await stop(x.page);await x.close();
 });
 await test('freshness timeout aborts analysis and never sends old speech',async()=>{const x=await setup({hold:true});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');await x.page.clock.fastForward(16000);await recovery(x.page);await stop(x.page);assert.equal(x.events.talks.length,0);assert.equal(await x.page.locator('#staleCount').innerText(),'1');await x.held()?.fulfill({contentType:'application/json',body:JSON.stringify(answer)}).catch(()=>{});assert.equal(x.events.api,1);await x.close();});
 await test('freshness includes VOICEVOX synthesis; late audio is not played',async()=>{
  const x=await setup({holdSynth:true});const p=x.page;await p.locator('#output').selectOption('voicevox');await start(x);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('音声生成'));
  while(!x.events.synths)await new Promise(r=>setTimeout(r,10));const imagesBefore=x.events.images;
  await p.clock.fastForward(16000);await recovery(p);assert.ok(x.events.images>=imagesBefore+3);await stop(p);assert.equal(await p.locator('#staleCount').innerText(),'1');assert.ok(!(await p.locator('#log').innerText()).includes('AI: 景色'));
  await x.held()?.abort().catch(()=>{});await x.close();
 });
 await test('stop cancels pending analysis, with no late speech',async()=>{const x=await setup({hold:true,max:20});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');await x.page.locator('#stop').click();await stopped(x.page);await x.held()?.fulfill({contentType:'application/json',body:JSON.stringify(answer)}).catch(()=>{});assert.equal(x.events.talks.length,0);assert.equal(x.events.api,1);await x.close();});
 await test('429 backs off without stopping; stop cancels waiting',async()=>{
  const x=await setup({status:429});await start(x);await recovery(x.page);assert.equal(x.events.api,1);
  await x.page.clock.fastForward(29000);assert.equal(x.events.api,1);assert.equal(await x.page.locator('#stop').isEnabled(),true);
  await stop(x.page);await x.page.clock.fastForward(900000);assert.equal(x.events.api,1);await x.close();
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
  const next={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'さらに進む',turns:[{speakerId:'p1',text:'まだ先がありそうだね'}]})}]}}]};
  const x=await setup({answers:[first,next],holdSynthAt:2});const p=x.page;
  await p.locator('#output').selectOption('voicevox');await p.locator('#tab-friends').click();await p.locator('#participantCount').selectOption('2');
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
  await p.locator('#output').selectOption('voicevox');await p.locator('#tab-friends').click();await p.locator('#participantCount').selectOption('2');await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');await start(x);
  for(let i=0;i<200&&!x.held();i++)await new Promise(r=>setTimeout(r,10));assert.ok(x.held());
  assert.ok(!(await p.locator('#lastComment').textContent()).includes('友達1：'));assert.equal(x.events.synths,2);
  await stop(p);await x.held()?.abort().catch(()=>{});await x.close();
 });
 await test('two speakers use one generation and distinct VOICEVOX voices in order',async()=>{
  const multi={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道',turns:[{speakerId:'p2',text:'この道きれいだね'},{speakerId:'p1',text:'寄り道したくなるね'}]})}]}}]};
  const x=await setup({answer:multi});const p=x.page;await p.locator('#output').selectOption('voicevox');await p.locator('#tab-friends').click();await p.locator('#participantCount').selectOption('2');await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('100');
  await start(x);await idle(p);assert.equal(x.events.api,1);assert.deepEqual(x.events.voices,['2','3']);assert.ok((await p.locator('#lastComment').textContent()).includes('友達1'));
  await stop(p);await x.close();
 });
 for(const cancel of [false,true])await test(cancel?'stop during later speech cancels remaining conversation':'three speakers finish after freshness expires once conversation has started',async()=>{
  const turns=[{speakerId:'p1',text:'景色がいいね'},{speakerId:'p2',text:'こっちも見てみようよ'},{speakerId:'p3',text:'ちょっと寄り道しよう'}];
  const reply={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進む',turns})}]}}]};
  const x=await setup({answer:reply,holdSynthAt:2});const p=x.page;
  await p.locator('#output').selectOption('voicevox');await p.locator('#tab-friends').click();await p.locator('#participantCount').selectOption('3');await p.locator('#speakerWeight1').fill('0');await p.locator('#speakerWeight2').fill('0');await p.locator('#speakerWeight3').fill('100');await start(x);
  await p.waitForFunction(()=>document.getElementById('lastComment').textContent.includes('友達1：'));
  for(let i=0;i<200&&!x.held();i++)await new Promise(r=>setTimeout(r,10));assert.ok(x.held());
  await p.clock.fastForward(16000);assert.equal(await p.locator('#staleCount').textContent(),'0');
  if(cancel){await stop(p);await x.held().fulfill({contentType:'audio/wav',body:wave()}).catch(()=>{});assert.equal(x.events.synths,2);assert.ok((await p.locator('#lastComment').textContent()).includes('友達1：'));}
  else {await x.held().fulfill({contentType:'audio/wav',body:wave()});await idle(p);assert.deepEqual(x.events.voices,['3','2','3']);assert.ok((await p.locator('#lastComment').textContent()).includes('友達3：'));assert.equal(await p.locator('#staleCount').textContent(),'0');await stop(p);}
  assert.equal(x.events.api,1);await x.close();
 });
 await test('encrypted credentials survive reload, require passphrase, and lock clears fields',async()=>{
  const x=await setup();const p=x.page;await p.locator('#vaultPass').fill('a sufficiently long phrase');await p.locator('#vaultConfirm').fill('a sufficiently long phrase');await p.locator('#vaultSave').click();
  await p.waitForFunction(()=>document.getElementById('vaultState').textContent.includes('暗号化して保存しました'));
  const raw=await p.evaluate(()=>JSON.stringify(localStorage));assert.ok(!raw.includes('fake.test-key')&&!raw.includes('obs-secret')&&!raw.includes('sufficiently'));
  await p.reload();assert.equal(await p.locator('#apiKey').inputValue(),'');
  await p.locator('#vaultPass').fill('wrong passphrase');await p.locator('#vaultUnlock').click();await p.waitForFunction(()=>document.getElementById('vaultState').textContent.includes('解除できません'));
  assert.equal(await p.locator('#apiKey').inputValue(),'');await p.locator('#vaultPass').fill('a sufficiently long phrase');await p.locator('#vaultUnlock').click();
  await p.waitForFunction(()=>document.getElementById('vaultState').textContent.startsWith('解除しました'));
  assert.equal(await p.locator('#apiKey').inputValue(),'fake.test-key');assert.equal(await p.locator('#obsPassword').inputValue(),'obs-secret');assert.equal(await p.locator('#vaultPass').inputValue(),'');
  await p.locator('#vaultLock').click();assert.equal(await p.locator('#apiKey').inputValue(),'');assert.equal(await p.locator('#obsPassword').inputValue(),'');await x.close();
 });
 await test('old settings migrate voice IDs; tabs and mobile stop remain accessible',async()=>{
  const x=await setup();const p=x.page;
  await p.evaluate(()=>localStorage.setItem('ai-live-commentator-browser-v1',JSON.stringify({speaker:8,bouyomiVoice:12,maxRequests:1,resume503:false,sourceName:'Old source'})));
  await p.reload();assert.equal(await p.locator('#analysisFrameCount').inputValue(),'2');await p.locator('#tab-friends').click();assert.equal(await p.locator('#participantCount').inputValue(),'1');assert.equal(await p.locator('#p1-speaker').inputValue(),'8');assert.equal(await p.locator('#p1-speedScale').inputValue(),'1');assert.equal(await p.locator('#p1-bouyomiVoice').inputValue(),'12');
  await p.locator('#tab-friends').press('ArrowRight');assert.equal(await p.locator('#tab-history').getAttribute('aria-selected'),'true');
  await p.setViewportSize({width:390,height:844});await p.locator('#tab-help').click();await p.evaluate(()=>scrollTo(0,document.body.scrollHeight));
  const bounds=await p.locator('#start').boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=844);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.setViewportSize({width:1280,height:600});await p.evaluate(()=>scrollTo(0,0));assert.equal(await p.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);
  await x.close();
 });
 await test('LAN IP works for authenticated OBS, Bouyomi and VOICEVOX',async()=>{
  const x=await setup({host:'192.168.1.10'});const p=x.page;assert.equal(await p.locator('#voicevoxSettingsLink').getAttribute('href'),'http://192.168.1.10:50021/setting');
  await p.locator('#testObs').click();await stopped(p);assert.equal(x.events.images,1);assert.equal(x.events.identifies,1);
  await p.locator('#testVoice').click();await stopped(p);assert.equal(x.events.talks.length,1);
  await p.locator('#output').selectOption('voicevox');await p.locator('#testVoice').click();await stopped(p);assert.equal(x.events.synths,1);assert.equal(x.events.api,0);
  await x.close();
 });
 console.log(`${results.length} browser scenarios passed. No live Gemini/OBS/voice services used.`);await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
