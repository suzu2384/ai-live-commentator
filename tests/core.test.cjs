const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const wrap = (value, finish='STOP') => ({candidates:[{finishReason:finish,content:{parts:[{thought:true,text:'private'},{text:JSON.stringify(value)}]}}]});
const profiles=[{id:'p1',name:'友達1',personality:'明るい'},{id:'p2',name:'友達2',personality:'落ち着いている'}];
const analysis={speak:true,summary:'道を進んでいる',turns:[{speakerId:'p1',text:'景色がいいね'}]};
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
test('user stop stays cancellation, including during recovery sleep',async()=>{
  const ac=new AbortController();const p=C.deadline(token=>C.sleep(10000,token),10000,ac.signal,'timeout');ac.abort();await assert.rejects(p,{name:'AbortError'});
  const ac2=new AbortController();const waiting=C.sleep(30000,ac2.signal);ac2.abort();await assert.rejects(waiting,{name:'AbortError'});
});
test('fixed short cooldown never grows; server retry hints override it',()=>{
  for(let i=0;i<100;i++)assert.equal(C.recoveryDelay({code:'503'}),5000);
  assert.equal(C.recoveryDelay({code:'NETWORK'}),5000);
  assert.equal(C.recoveryDelay({code:'STALE'}),5000);
  assert.equal(C.recoveryDelay({code:'429'}),30000);
  assert.equal(C.recoveryDelay({code:'503',retryAfter:120000}),120000);
  assert.equal(C.recoveryDelay({code:'429',retryAfter:3600000}),3600000);
  assert.equal(C.needsSettings({code:'AUTH'}),true);
  assert.equal(C.needsSettings({code:'503'}),false);
});
test('503 retry hint is preserved',async()=>{
  await assert.rejects(C.gemini('test',{},undefined,async()=>({status:503,ok:false,headers:{get:()=> '20'},json:async()=>({})})),e=>e.code==='503'&&e.retryAfter===20000);
});
test('speaker subset is accepted; inactive speakers, long text and oversized exchanges are rejected',()=>{
  assert.equal(C.parseAnalysis(wrap(analysis),profiles).turns.length,1);
  for(const turns of [[{speakerId:'p3',text:'こんにちは'}],[{speakerId:'p1',text:'x'.repeat(81)}],Array(7).fill(analysis.turns[0])])
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
