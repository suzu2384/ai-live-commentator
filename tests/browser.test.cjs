// Development only: npm install playwright, then set CHROME_PATH if necessary.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const entry='file://'+path.resolve(__dirname,'../index.html');
const sha=s=>createHash('sha256').update(s).digest('base64');
const answer={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({speak:true,summary:'道を進んでいる',comment:'景色がいいね'})}]}}]};
require('node:fs').mkdirSync(path.resolve(__dirname,'../../.browser-test'),{recursive:true});
const results=[];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--no-sandbox']});
 async function setup(config={}){
  const ctx=await browser.newContext({viewport:{width:1360,height:1000}});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const events={images:0,api:0,talks:[],queries:0,synths:0,identifies:0,unexpected:[]};let held=null;
  await page.clock.install();
  await page.route('https://**/*',async r=>{
   if(!r.request().url().startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent')){events.unexpected.push(r.request().url());return r.abort();}
   events.api++;assert.equal(r.request().headers()['x-goog-api-key'],'fake.test-key');
   if(config.hold){held=r;return;}
   if(config.status)await r.fulfill({status:config.status,contentType:'application/json',body:'{}'});
   else await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(answer)});
  });
  await page.route('http://127.0.0.1:50080/**',async r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/GetTalkTaskCount')return r.fulfill({contentType:'application/json',body:JSON.stringify({talkTaskCount:config.busy?1:0})});
   if(u.pathname==='/talk'){events.talks.push(u.searchParams.get('text'));return r.fulfill({contentType:'application/json',body:'{"taskId":1}'});}
   events.unexpected.push(u.pathname);await r.abort();
  });
  await page.route('http://127.0.0.1:50021/**',async r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/audio_query'){events.queries++;return r.fulfill({contentType:'application/json',body:'{}'});}
   if(u.pathname==='/synthesis'){
    events.synths++;if(config.holdSynth){held=r;return;}
    const b=Buffer.alloc(44+2400*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4800,40);
    return r.fulfill({contentType:'audio/wav',body:b});
   }await r.abort();
  });
  let jpeg;
  await page.routeWebSocket('ws://127.0.0.1:4455',ws=>{
   ws.onMessage(raw=>{
    const m=JSON.parse(raw);
    if(m.op===1){events.identifies++;assert.equal(m.d.authentication,sha(sha('obs-secret'+'salt')+'challenge'));ws.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));}
    if(m.op===6){events.images++;ws.send(JSON.stringify({op:7,d:{requestId:m.d.requestId,requestStatus:{result:true,code:100},responseData:{imageData:jpeg.replace('image/jpeg','image/jpg')}}}));}
   });ws.send(JSON.stringify({op:0,d:{rpcVersion:1,authentication:{salt:'salt',challenge:'challenge'}}}));
  });
  await page.goto(entry);
  jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.fillStyle='#345a4b';x.fillRect(0,0,640,360);return c.toDataURL('image/jpeg');});
  await page.locator('#apiKey').fill('fake.test-key');await page.locator('#obsPassword').fill('obs-secret');await page.locator('#freeTier').check();await page.locator('#maxRequests').fill(String(config.max||1));
  await page.locator('summary').filter({hasText:'画像・通信'}).click();await page.locator('#sampleInterval').fill('4');
  return {page,ctx,events,errors,held:()=>held,close:async()=>{assert.deepEqual(errors,[]);assert.deepEqual(events.unexpected,[]);await ctx.close();}};
 }
 async function start(x){await x.page.locator('#start').click();await x.page.waitForFunction(()=>document.getElementById('status').textContent.includes('次の取得待ち'));await x.page.clock.fastForward(4100);}
 async function stopped(p){await p.waitForFunction(()=>!document.getElementById('start').disabled);}
 async function test(name,fn){await fn();results.push(name);console.log('PASS:',name);}
 await test('file startup, responsive layout, settings persistence excludes credentials',async()=>{
  const x=await setup();const p=x.page;await p.locator('#save').click();const data=await p.evaluate(()=>localStorage.getItem('ai-live-commentator-browser-v1'));
  assert.ok(!data.includes('fake.test-key')&&!data.includes('obs-secret')&&!data.includes('freeTier'));
  await p.reload();assert.equal(await p.locator('#apiKey').inputValue(),'');assert.equal(await p.locator('#freeTier').isChecked(),false);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/desktop.png'),fullPage:true});
  await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.resolve(__dirname,'../../.browser-test/mobile.png'),fullPage:true});await x.close();
 });
 await test('OBS authentication and preview send no Gemini request',async()=>{const x=await setup();await x.page.locator('#testObs').click();await stopped(x.page);assert.equal(x.events.images,1);assert.equal(x.events.identifies,1);assert.equal(x.events.api,0);assert.equal(await x.page.locator('#preview').isVisible(),true);await x.close();});
 await test('Bouyomi audio test sends speech only',async()=>{const x=await setup();await x.page.locator('#testVoice').click();await stopped(x.page);assert.deepEqual(x.events.talks,['こんにちは。音声テストです。']);assert.equal(x.events.api,0);await x.close();});
 await test('VOICEVOX direct synthesizes and plays WAV',async()=>{const x=await setup();await x.page.locator('#output').selectOption('voicevox');await x.page.locator('#testVoice').click();await stopped(x.page);assert.equal(x.events.queries,1);assert.equal(x.events.synths,1);assert.ok((await x.page.locator('#log').innerText()).includes('音声テスト再生完了'));await x.close();});
 await test('successful analysis speaks once and respects request budget',async()=>{const x=await setup();await start(x);await stopped(x.page);assert.equal(x.events.api,1);assert.deepEqual(x.events.talks,['景色がいいね']);assert.equal(x.events.images,2);assert.ok((await x.page.locator('#log').innerText()).includes('送信上限'));await x.close();});
 await test('freshness timeout aborts analysis and never sends old speech',async()=>{const x=await setup({hold:true});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');await x.page.clock.fastForward(16000);await stopped(x.page);assert.equal(x.events.talks.length,0);assert.equal(await x.page.locator('#staleCount').innerText(),'1');await x.held()?.fulfill({contentType:'application/json',body:JSON.stringify(answer)}).catch(()=>{});assert.equal(x.events.api,1);await x.close();});
 await test('freshness includes VOICEVOX synthesis; late audio is not played',async()=>{
  const x=await setup({holdSynth:true});const p=x.page;await p.locator('#output').selectOption('voicevox');await start(x);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('音声生成'));
  while(!x.events.synths)await new Promise(r=>setTimeout(r,10));
  await p.clock.fastForward(16000);await stopped(p);assert.equal(await p.locator('#staleCount').innerText(),'1');assert.ok(!(await p.locator('#log').innerText()).includes('AI: 景色'));
  await x.held()?.abort().catch(()=>{});await x.close();
 });
 await test('stop cancels pending analysis, with no late speech',async()=>{const x=await setup({hold:true,max:20});await start(x);await x.page.waitForFunction(()=>document.getElementById('status').textContent==='Geminiの応答待ち');await x.page.locator('#stop').click();await stopped(x.page);await x.held()?.fulfill({contentType:'application/json',body:JSON.stringify(answer)}).catch(()=>{});assert.equal(x.events.talks.length,0);assert.equal(x.events.api,1);await x.close();});
 await test('429 stops even when 503 resume is enabled',async()=>{const x=await setup({status:429,max:20});await x.page.locator('#resume503').check();await start(x);await stopped(x.page);assert.equal(x.events.api,1);assert.equal(x.events.talks.length,0);assert.ok((await x.page.locator('#log').innerText()).includes('429'));await x.close();});
 await test('503 opt-in waits, uses fresh frames and stops after three failures',async()=>{
  const x=await setup({status:503,max:20});const p=x.page;await p.locator('#resume503').check();await start(x);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('混雑待ち'));assert.equal(x.events.api,1);await p.clock.fastForward(30001);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('次の取得待ち'));await p.clock.fastForward(4100);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('60秒'));assert.equal(x.events.api,2);await p.clock.fastForward(60001);
  await p.waitForFunction(()=>document.getElementById('status').textContent.includes('次の取得待ち'));await p.clock.fastForward(4100);await stopped(p);
  assert.equal(x.events.api,3);assert.equal(x.events.images,6);assert.equal(x.events.talks.length,0);assert.ok((await p.locator('#log').innerText()).includes('3回連続'));await x.close();
 });
 await test('busy Bouyomi queue is not overwritten',async()=>{const x=await setup({busy:true});await start(x);await stopped(x.page);assert.equal(x.events.talks.length,0);assert.ok((await x.page.locator('#log').innerText()).includes('再生待ち'));await x.close();});
 console.log(`${results.length} browser scenarios passed. No live Gemini/OBS/voice services used.`);await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
