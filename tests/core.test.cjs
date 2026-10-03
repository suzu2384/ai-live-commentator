const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const wrap = (value, finish='STOP') => ({candidates:[{finishReason:finish,content:{parts:[{thought:true,text:'private'},{text:JSON.stringify(value)}]}}]});
const profiles=[{id:'p1',name:'友達1',personality:'明るい'},{id:'p2',name:'友達2',personality:'落ち着いている'}];
const analysis={speak:true,summary:'道を進んでいる',turns:[{speakerId:'p1',text:'景色がいいね',speechText:'けしきがいいね'}]};
test('response parsing excludes thoughts and rejects incomplete output',()=>{
  assert.deepEqual(C.parseAnalysis(wrap(analysis),profiles),analysis);
  assert.throws(()=>C.parseAnalysis(wrap(analysis,'MAX_TOKENS'),profiles));
  assert.throws(()=>C.parseAnalysis(wrap({speak:'true'})));
  assert.equal(C.parseAnalysis({promptFeedback:{blockReason:'SAFETY'}}).speak,false);
});
test('fixed endpoint, ordered JPEG parts and opaque key in header only',async()=>{
  const frames=[{data:'data:image/jpeg;base64,AQ=='},{data:'data:image/jpeg;base64,Ag=='},{data:'data:image/jpeg;base64,Aw=='},{data:'data:image/jpeg;base64,BA=='}];
  const payload=C.makePayload(frames,{persona:'相方',talkativeness:2,profiles},[],[]);let calls=0;
  await C.gemini(' \uFEFFtest.token+/=\n',payload,new AbortController().signal,async(url,options)=>{
    calls++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(options.headers['x-goog-api-key'],'test.token+/=');assert.equal(options.redirect,'error');
    const p=JSON.parse(options.body);assert.equal(p.contents[0].parts[1].inlineData.data,'AQ==');assert.equal(p.contents[0].parts[3].inlineData.data,'Ag==');assert.equal(p.contents[0].parts[5].inlineData.data,'Aw==');assert.equal(p.contents[0].parts[7].inlineData.data,'BA==');
    assert.equal(p.contents[0].parts.filter(x=>x.inlineData).length,4);assert.ok(p.contents[0].parts.at(-1).text.includes('画像4'));
    assert.equal(p.generationConfig.thinkingConfig.thinkingLevel,'MINIMAL');return {ok:true,json:async()=>wrap(analysis)};
  });assert.equal(calls,1);
});
test('weighted speaker count uses relative weights and participant cap',()=>{
  const weights=[45,35,15,5,0,0];
  assert.equal(C.pickWeightedSpeakerCount(weights,6,()=>0),1);
  assert.equal(C.pickWeightedSpeakerCount(weights,6,()=>0.45),2);
  assert.equal(C.pickWeightedSpeakerCount(weights,6,()=>0.80),3);
  assert.equal(C.pickWeightedSpeakerCount(weights,6,()=>0.95),4);
  assert.equal(C.pickWeightedSpeakerCount([0,100,0,0,0,0],3,()=>0.7),2);
  assert.throws(()=>C.pickWeightedSpeakerCount([0,0,100,0,0,0],2,()=>0));
});
test('analysis payload requires the sampled speaker count and carries recent speakers',()=>{
  const frames=[{data:'data:image/jpeg;base64,AQ=='},{data:'data:image/jpeg;base64,Ag=='}];
  const s={persona:'相方',talkativeness:2,profiles,turnCount:2,recentSpeakerIds:['p1','p2','p1']};
  const payload=C.makePayload(frames,s,[],['友達1: ほんまやな','友達2: 次も見てみよか']);
  assert.equal(payload.generationConfig.responseSchema.properties.turns.minItems,2);
  assert.equal(payload.generationConfig.responseSchema.properties.turns.maxItems,2);
  const turnSchema=payload.generationConfig.responseSchema.properties.turns.items;
  assert.deepEqual(turnSchema.required,['speakerId','text','speechText']);assert.equal(turnSchema.properties.speechText.type,'STRING');
  assert.ok(payload.contents[0].parts.at(-1).text.includes('今回の候補発言人数: 2人'));
  assert.ok(payload.contents[0].parts.at(-1).text.includes('p1 → p2 → p1'));
  assert.ok(payload.contents[0].parts.at(-1).text.includes('直近の会話履歴（古い順、発言者名つき）'));
  assert.ok(payload.contents[0].parts.at(-1).text.includes('友達1: ほんまやな\n友達2: 次も見てみよか'));
  assert.ok(payload.systemInstruction.parts[0].text.includes('相づちだけの返答が何度も続く会話パターンを避ける'));
  assert.ok(payload.systemInstruction.parts[0].text.includes('相づち自体は禁止せず'));
  assert.ok(payload.systemInstruction.parts[0].text.includes('speechTextはtext全文を読み仮名へ変換'));
  assert.ok(payload.systemInstruction.parts[0].text.includes('漢字・英字・数字は一切含めず'));
  assert.ok(payload.systemInstruction.parts[0].text.includes('「早よ行こうや」ならspeechTextは「はよいこうや」'));
  const exactTwo={...analysis,turns:[{speakerId:'p1',text:'一つ目だよ',speechText:'ひとつめだよ'},{speakerId:'p2',text:'二つ目だよ',speechText:'ふたつめだよ'}]};
  assert.equal(C.parseAnalysis(wrap(exactTwo),profiles,2).turns.length,2);
  assert.throws(()=>C.parseAnalysis(wrap(analysis),profiles,2));
  const duplicate={...analysis,turns:[{speakerId:'p1',text:'一つ目だよ',speechText:'ひとつめだよ'},{speakerId:'p1',text:'二つ目だよ',speechText:'ふたつめだよ'}]};
  assert.throws(()=>C.parseAnalysis(wrap(duplicate),profiles,2));
});
test('speak false may carry exact candidate turns and forceSpeak reuses them for greetings',()=>{
  const silent={...analysis,speak:false,turns:[{speakerId:'p1',text:'今は見ておこう',speechText:'いまわみておこう'},{speakerId:'p2',text:'静かに見ようか',speechText:'しずかにみようか'}]};
  const parsed=C.parseAnalysis(wrap(silent),profiles,2);
  assert.equal(parsed.speak,false);assert.equal(parsed.turns.length,2);
  const forced=C.parseAnalysis(wrap(silent),profiles,2,true);
  assert.equal(forced.speak,true);assert.equal(forced.turns.length,2);
});
test('target content guidance is sent only when a content is selected',()=>{
  const frames=[{data:'data:image/jpeg;base64,AQ=='},{data:'data:image/jpeg;base64,Ag=='}];
  const selected=C.makePayload(frames,{persona:'相方',talkativeness:1,profiles,contentName:'The Division 2'},[],[]);
  const selectedText=selected.contents[0].parts.at(-1).text;
  assert.ok(selectedText.includes('現在見ている対象コンテンツは「The Division 2」'));
  assert.ok(selectedText.includes('このコンテンツについて既知の知識があれば'));
  assert.ok(selectedText.includes('知識を披露すること自体を目的にせず'));
  const none=C.makePayload(frames,{persona:'相方',talkativeness:1,profiles,contentName:''},[],[]);
  const noneText=none.contents[0].parts.at(-1).text;
  assert.equal(noneText.includes('対象コンテンツ'),false);
  assert.equal(noneText.includes('このコンテンツについて既知の知識があれば'),false);
});
test('quiet-mode payload favors relaxed friend chat and explicitly forbids rushing the player',()=>{
  const frames=[{data:'data:image/jpeg;base64,AQ=='},{data:'data:image/jpeg;base64,Ag=='}];
  const quiet=C.makePayload(frames,{persona:'相方',talkativeness:2,profiles,turnCount:1,quietMode:true,contentName:'The Division 2'},[],[]);
  const text=quiet.contents[0].parts.at(-1).text;
  assert.ok(text.includes('「雑談モード」'));
  assert.ok(text.includes('現在画面を逐一実況する必要はない'));
  assert.ok(text.includes('対象コンテンツ、直前の会話、画面の雰囲気'));
  assert.ok(text.includes('停滞を責める・急かす・進行を要求する発言は禁止'));
  assert.ok(text.includes('「進もう」「次へ行こう」「動こう」「何か起きないかな」'));
  const normal=C.makePayload(frames,{persona:'相方',talkativeness:2,profiles,turnCount:1,quietMode:false},[],[]);
  assert.ok(normal.contents[0].parts.at(-1).text.includes('通常実況モード'));
  assert.equal(normal.contents[0].parts.at(-1).text.includes('停滞を責める・急かす'),false);
});
test('analysis payload accepts only two to six ordered frames',()=>{
  const s={persona:'相方',talkativeness:1,profiles};
  assert.doesNotThrow(()=>C.makePayload(Array.from({length:6},(_,i)=>({data:`data:image/jpeg;base64,${Buffer.from([i]).toString('base64')}`})),s,[],[]));
  assert.throws(()=>C.makePayload([{data:'data:image/jpeg;base64,AQ=='}],s,[],[]));
  assert.throws(()=>C.makePayload(Array(7).fill({data:'data:image/jpeg;base64,AQ=='}),s,[],[]));
});
test('invalid keys and cancellation prevent network requests',async()=>{
  let calls=0;const f=()=>{calls++;};
  for(const k of ['','a b','a\rb','全角'])await assert.rejects(C.gemini(k,{},undefined,f));
  const ac=new AbortController();ac.abort();await assert.rejects(C.gemini('test',{},ac.signal,f),{name:'AbortError'});assert.equal(calls,0);
});
test('503, 429, auth and other failures are distinct and never retried inside client',async()=>{
  for(const [status,code]of[[503,'503'],[429,'429'],[403,'AUTH'],[500,'500']]){
    let calls=0;await assert.rejects(C.gemini('test',{},undefined,async()=>{calls++;return{status,ok:false};}),e=>e.code===code);assert.equal(calls,1);
  }
});
test('loopback and private LAN IPv4 endpoints are accepted; public or malformed URLs are rejected',()=>{
  assert.equal(C.localUrl('http://127.0.0.1:50080','http:'),'http://127.0.0.1:50080');
  for(const h of ['10.0.0.1','10.255.255.254','172.16.0.1','172.31.255.254','192.168.1.10']) for(const proto of ['http:','ws:']) assert.equal(C.localUrl(`${proto}//${h}:50021/`,proto),`${proto}//${h}:50021`);
  for(const u of ['http://172.15.1.1','http://172.32.0.1','http://192.169.0.1','http://8.8.8.8','http://0.0.0.0','http://192.168.1.10.evil.test','http://192.168.1.10/?x=1','http://192.168.1.10/#x','http://192.168.999.1','http://example.com','http://127.0.0.1.evil.test','http://user:pass@localhost','http://localhost/path','https://localhost'])assert.throws(()=>C.localUrl(u,'http:'));
});
test('minimum API interval overrides motion and quiet-scene interval',()=>{
  assert.equal(C.shouldAnalyze(29,1,30,60),false);assert.equal(C.shouldAnalyze(30,1,30,60),true);
  assert.equal(C.shouldAnalyze(59,0,30,60),false);assert.equal(C.shouldAnalyze(60,0,30,60),true);
  assert.equal(C.shouldAnalyze(60,0,120,30),false);
});
test('stale comments are rejected at the boundary even if model says speak',()=>{
  const s={freshness:15,speechInterval:20};assert.equal(C.fresh(1000,15999,15),true);assert.equal(C.fresh(1000,16000,15),false);
  assert.equal(C.skipReason(analysis,15000,s,99999,[]),'鮮度上限を超過');assert.equal(C.skipReason(analysis,14999,s,99999,[]),'');
  assert.equal(C.skipReason(analysis,1000,s,99999,[analysis.turns[0].text]),'直近と同じ発言');
});
test('freshness deadline aborts outstanding network work',async()=>{
  let aborted=false;await assert.rejects(C.deadline(token=>new Promise((_,reject)=>token.addEventListener('abort',()=>{aborted=true;reject(C.abortError());})),10,undefined,'stale','STALE'),e=>e.code==='STALE');assert.equal(aborted,true);
});
test('deadline settles even when inner work ignores abort',async()=>{
  await assert.rejects(C.deadline(()=>new Promise(()=>{}),10,undefined,'stale','STALE'),e=>e.code==='STALE');
});
test('user stop stays cancellation, including during recovery sleep',async()=>{
  const ac=new AbortController();const p=C.deadline(token=>C.sleep(10000,token),10000,ac.signal,'timeout');ac.abort();await assert.rejects(p,{name:'AbortError'});
  const ac2=new AbortController();const waiting=C.sleep(30000,ac2.signal);ac2.abort();await assert.rejects(waiting,{name:'AbortError'});
});
test('fixed short cooldown never grows; server retry hints override it',()=>{
  for(let i=0;i<100;i++)assert.equal(C.recoveryDelay({code:'503'}),5000);
  assert.equal(C.recoveryDelay({code:'NETWORK'}),5000);
  assert.equal(C.recoveryDelay({code:'STALE'}),0);
  assert.equal(C.recoveryDelay({code:'429'}),30000);
  assert.equal(C.recoveryDelay({code:'503',retryAfter:120000}),120000);
  assert.equal(C.recoveryDelay({code:'429',retryAfter:3600000}),3600000);
  assert.equal(C.needsSettings({code:'AUTH'}),true);
  assert.equal(C.needsSettings({code:'503'}),false);
});
test('503 retry hint is preserved',async()=>{
  await assert.rejects(C.gemini('test',{},undefined,async()=>({status:503,ok:false,headers:{get:()=> '20'},json:async()=>({})})),e=>e.code==='503'&&e.retryAfter===20000);
});
test('speechText must be a full kana reading with no kanji letters or digits',()=>{
  const dialect={...analysis,turns:[{speakerId:'p1',text:'早よ行こうや',speechText:'はよいこうや'}]};
  assert.equal(C.parseAnalysis(wrap(dialect),profiles).turns[0].speechText,'はよいこうや');
  for(const speechText of ['早よいこうや','HPひくいで','あと3かい','']){
    const invalid={...analysis,turns:[{speakerId:'p1',text:'早よ行こうや',speechText}]};
    assert.throws(()=>C.parseAnalysis(wrap(invalid),profiles));
  }
});
test('speechText punctuation differences are accepted instead of dropping the comment',()=>{
  for(const speechText of ['はよいこうや、まにあわへんで！','はよいこうやまにあわへんで！','はよいこうや、まにあわへんで','はよいこうや。まにあわへんで！']){
    const response={...analysis,turns:[{speakerId:'p1',text:'早よ行こうや、間に合わへんで！',speechText}]};
    assert.equal(C.parseAnalysis(wrap(response),profiles).turns[0].speechText,speechText);
  }
});
test('speaker subset is accepted; inactive speakers, long text and oversized exchanges are rejected',()=>{
  assert.equal(C.parseAnalysis(wrap(analysis),profiles).turns.length,1);
  for(const turns of [[{speakerId:'p3',text:'こんにちは'}],[{speakerId:'p1',text:'x'.repeat(81)}],[{speakerId:'p1',text:'こんにちは',speechText:'x'.repeat(121)}],Array(7).fill(analysis.turns[0])])
    assert.throws(()=>C.parseAnalysis(wrap({...analysis,turns}),profiles));
  assert.throws(()=>C.parseAnalysis(wrap({...analysis,speak:false}),profiles));
});
test('429 reads Retry-After and RetryInfo without echoing response details',async()=>{
  await assert.rejects(C.gemini('test',{},undefined,async()=>({status:429,ok:false,headers:{get:()=> '1200'},json:async()=>({error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'1500s'}]}})})),e=>e.code==='429'&&e.retryAfter===1500000);
});
test('plain speech strips executable tag and plugin syntax',()=>{
  assert.equal(C.plainSpeech('v)（音声ファイル C:\\evil.wav）<script>'), 'v音声ファイル Cevil.wavscript');
  assert.equal(C.plainSpeech('景色がいいね！'),'景色がいいね!');
});

const V=require('../vault.js');
test('encrypted vault round trip, random salts, wrong passphrase and tampering',async()=>{
 const clear={apiKey:'test-secret-api',obsPassword:'test-secret-obs'},pass='twelve-or-more-characters';
 const a=await V.seal(clear,pass),b=await V.seal(clear,pass);
 assert.notEqual(a.ciphertext,b.ciphertext);assert.notEqual(a.salt,b.salt);
 assert.ok(!JSON.stringify(a).includes(clear.apiKey));assert.ok(!JSON.stringify(a).includes(pass));
 assert.deepEqual(await V.open(a,pass),clear);
 await assert.rejects(V.open(a,'wrong-passphrase'));
 await assert.rejects(V.open({...a,ciphertext:(a.ciphertext[0]==='A'?'B':'A')+a.ciphertext.slice(1)},pass));
 await assert.rejects(V.open({...a,iterations:1},pass));await assert.rejects(V.seal(clear,'short'));
});
