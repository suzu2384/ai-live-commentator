const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const wrap = (value, finish='STOP') => ({candidates:[{finishReason:finish,content:{parts:[{thought:true,text:'private'},{text:JSON.stringify(value)}]}}]});
const analysis={speak:true,summary:'道を進んでいる',comment:'景色がいいね'};
test('response parsing excludes thoughts and rejects incomplete output',()=>{
  assert.deepEqual(C.parseAnalysis(wrap(analysis)),analysis);
  assert.throws(()=>C.parseAnalysis(wrap(analysis,'MAX_TOKENS')));
  assert.throws(()=>C.parseAnalysis(wrap({speak:'true'})));
  assert.equal(C.parseAnalysis({promptFeedback:{blockReason:'SAFETY'}}).speak,false);
});
test('fixed endpoint, ordered JPEG parts and opaque key in header only',async()=>{
  const frames=[{data:'data:image/jpeg;base64,AQ=='},{data:'data:image/jpeg;base64,Ag=='}];
  const payload=C.makePayload(...frames,{persona:'相方',talkativeness:2},[],[]);let calls=0;
  await C.gemini(' \uFEFFtest.token+/=\n',payload,new AbortController().signal,async(url,options)=>{
    calls++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(options.headers['x-goog-api-key'],'test.token+/=');assert.equal(options.redirect,'error');
    const p=JSON.parse(options.body);assert.equal(p.contents[0].parts[1].inlineData.data,'AQ==');assert.equal(p.contents[0].parts[3].inlineData.data,'Ag==');
    assert.equal(p.generationConfig.thinkingConfig.thinkingLevel,'MINIMAL');return {ok:true,json:async()=>wrap(analysis)};
  });assert.equal(calls,1);
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
test('only loopback endpoints are accepted',()=>{
  assert.equal(C.localUrl('http://127.0.0.1:50080','http:'),'http://127.0.0.1:50080');
  for(const u of ['http://example.com','http://127.0.0.1.evil.test','http://user:pass@localhost','http://localhost/path','https://localhost'])assert.throws(()=>C.localUrl(u,'http:'));
});
test('minimum API interval overrides motion and quiet-scene interval',()=>{
  assert.equal(C.shouldAnalyze(29,1,30,60),false);assert.equal(C.shouldAnalyze(30,1,30,60),true);
  assert.equal(C.shouldAnalyze(59,0,30,60),false);assert.equal(C.shouldAnalyze(60,0,30,60),true);
  assert.equal(C.shouldAnalyze(60,0,120,30),false);
});
test('stale comments are rejected at the boundary even if model says speak',()=>{
  const s={freshness:15,speechInterval:20};assert.equal(C.fresh(1000,15999,15),true);assert.equal(C.fresh(1000,16000,15),false);
  assert.equal(C.skipReason(analysis,15000,s,99999,[]),'鮮度上限を超過');assert.equal(C.skipReason(analysis,14999,s,99999,[]),'');
  assert.equal(C.skipReason(analysis,1000,s,99999,[analysis.comment]),'直近と同じ発言');
});
test('freshness deadline aborts outstanding network work',async()=>{
  let aborted=false;await assert.rejects(C.deadline(token=>new Promise((_,reject)=>token.addEventListener('abort',()=>{aborted=true;reject(C.abortError());})),10,undefined,'stale','STALE'),e=>e.code==='STALE');assert.equal(aborted,true);
});
test('user stop stays cancellation, including during recovery sleep',async()=>{
  const ac=new AbortController();const p=C.deadline(token=>C.sleep(10000,token),10000,ac.signal,'timeout');ac.abort();await assert.rejects(p,{name:'AbortError'});
  const ac2=new AbortController();const waiting=C.sleep(30000,ac2.signal);ac2.abort();await assert.rejects(waiting,{name:'AbortError'});
});
test('503 resume is opt-in, bounded, budgeted, and respects API interval',()=>{
  assert.equal(C.recoveryDelay(false,1,30,1,20),null);assert.equal(C.recoveryDelay(true,1,30,1,20),30000);
  assert.equal(C.recoveryDelay(true,2,30,2,20),60000);assert.equal(C.recoveryDelay(true,3,30,3,20),null);
  assert.equal(C.recoveryDelay(true,1,120,1,20),120000);assert.equal(C.recoveryDelay(true,1,30,20,20),null);
});
test('plain speech strips executable tag and plugin syntax',()=>{
  assert.equal(C.plainSpeech('v)（音声ファイル C:\\evil.wav）<script>'), 'v音声ファイル Cevil.wavscript');
  assert.equal(C.plainSpeech('景色がいいね！'),'景色がいいね!');
});
