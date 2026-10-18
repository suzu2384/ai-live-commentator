const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js'),H=require('../chapters.js');
const wrap=value=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
const frames=[{capturedAtMs:1791190000000},{capturedAtMs:1791190001000}];
function recorded(n){const s=H.session('ゲーム',1791190000000);s.events=Array.from({length:n},(_,i)=>({id:`e${i}`,observedAtMs:s.startedAtMs+i*30000,kind:'progress',summary:`出来事${i}`,contentName:'ゲーム'}));return s;}
test('events use capture wall-clock time, independent of speech and response time',()=>{
 const result=H.observation(wrap({speak:false,chapterEvents:[{kind:'result',summary:'結果画面が表示された'}]}),frames,'ゲーム',1791190050000);
 assert.equal(result[0].observedAtMs,frames[1].capturedAtMs);assert.equal(result[0].recordedAtMs,1791190050000);
 assert.equal(result[0].windowStartAtMs,frames[0].capturedAtMs);assert.equal(result[0].summary,'結果画面が表示された');
 assert.equal(H.observation(wrap({chapterEvents:[]}),frames).length,0);
 assert.equal(H.observation({promptFeedback:{blockReason:'SAFETY'}},frames).length,0);
 assert.throws(()=>H.observation(wrap({summary:'実況の感想'}),frames));
 assert.throws(()=>H.observation(wrap({chapterEvents:[{kind:'wrong',summary:'a'}]}),frames));
});
test('live analysis requests objective event field without adding a second image request',()=>{
 const p=C.makePayload([{data:'data:image/jpeg;base64,AQ=='},{data:'data:image/jpeg;base64,Ag=='}],{profiles:[],quietMode:true},[],[]);
 assert(p.generationConfig.responseSchema.required.includes('chapterEvents'));
 assert.equal(p.generationConfig.responseSchema.properties.chapterEvents.maxItems,3);
 assert(p.systemInstruction.parts[0].text.includes('客観的なイベント要約'));
});
test('candidates reference actual events and preserve their timestamps, sorted by time',async()=>{
 const s=recorded(3);const g=await H.generate(s,{signal:new AbortController().signal,request:async()=>wrap({chapters:[{eventId:'e2',title:'結果'},{eventId:'e0',title:'探索'}]})});
 assert.deepEqual(g.chapters.map(c=>c.sourceEventId),['e0','e2']);assert.equal(g.chapters[1].observedAtMs,s.events[2].observedAtMs);
 assert.deepEqual(g.sourceEventIds,['e0','e1','e2']);assert.equal(s.generations.length,0);assert.equal(s.youtubeSync,null);
 await assert.rejects(H.generate(s,{request:async()=>wrap({chapters:[{eventId:'invented',title:'架空'}]})}),/参照/);
 await assert.rejects(H.generate(s,{request:async()=>wrap({chapters:[{eventId:'e0',title:'a'},{eventId:'e0',title:'b'}]})}),/形式/);
});
test('long sessions process every event in bounded batches before merging',async()=>{
 const s=recorded(451),inputs=[];
 const g=await H.generate(s,{request:async p=>{
  const items=JSON.parse(p.contents[0].parts[0].text).events;inputs.push(items);
  assert(items.length<=H.BATCH_SIZE);
  return wrap({chapters:[{eventId:items[0].eventId,title:'区間開始'}]});
 }});
 assert.equal(inputs.length,4);assert.equal(inputs.slice(0,3).flat().length,451);
 assert.equal(g.sourceEventIds.length,451);assert.equal(inputs[3].length,3);
});
test('cancellation, failed regeneration and empty input do not mutate previous results',async()=>{
 const s=recorded(1);s.generations=[{id:'previous',chapters:[]}];const previous=JSON.stringify(s);const ac=new AbortController();
 await assert.rejects(H.generate(s,{signal:ac.signal,request:async()=>{ac.abort();return wrap({chapters:[]});}}),{name:'AbortError'});
 assert.equal(JSON.stringify(s),previous);
 await assert.rejects(H.generate(s,{request:async()=>{throw new Error('503');}}),/503/);assert.equal(JSON.stringify(s),previous);
 await assert.rejects(H.generate(recorded(0),{request:()=>assert.fail()}),/ありません/);
});
test('blocked persistence warns and retains the session in memory',async()=>{
 let warned=0;const store=new H.Store(()=>warned++,null);await store.ready;
 const s=recorded(2);await store.save(s);await store.flush();assert(warned>0);assert.equal(store.records.get(s.id).events.length,2);
});

test('representative images are bounded and prefer important events',async()=>{
 assert.equal(H.MAX_REPRESENTATIVE_IMAGES,30);
 assert(H.imagePriority([{kind:'result'}])>H.imagePriority([{kind:'menu'}]));
 const blob=H.dataUrlBlob('data:image/jpeg;base64,AQID');assert.equal(blob.type,'image/jpeg');assert.equal(blob.size,3);
 const store=new H.Store(()=>{},null);await store.ready;const s=H.session('ゲーム',1791190000000);
 for(let i=0;i<H.MAX_REPRESENTATIVE_IMAGES;i++){
  const e={id:`m${i}`,observedAtMs:s.startedAtMs+i,kind:'menu',summary:`メニュー${i}`,contentName:'ゲーム'};s.events.push(e);
  await store.saveRepresentativeImage(s,[e],{data:'data:image/jpeg;base64,AQ==',capturedAtMs:e.observedAtMs,width:640,height:360});
  assert(e.imageId);
 }
 const oldest=s.representativeImageIds[0],important={id:'boss',observedAtMs:s.startedAtMs+999,kind:'battle',summary:'ボス戦',contentName:'ゲーム'};s.events.push(important);
 await store.saveRepresentativeImage(s,[important],{data:'data:image/jpeg;base64,Ag==',capturedAtMs:important.observedAtMs,width:640,height:360});
 assert.equal(s.representativeImageIds.length,H.MAX_REPRESENTATIVE_IMAGES);assert(!s.representativeImageIds.includes(oldest));assert(important.imageId);
 assert.equal((await store.imagesForSession(s.id)).length,H.MAX_REPRESENTATIVE_IMAGES);
});
