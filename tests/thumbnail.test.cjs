const {test}=require('node:test');
const assert=require('node:assert/strict');
global.LiveCore=require('../core.js');
const T=require('../thumbnail.js');

function session(){
  return {
    contentName:'ゲームA',
    youtubeSync:{title:'配信タイトル'},
    events:[
      {id:'e1',kind:'menu',summary:'メニュー',observedAtMs:1,imageId:'i1'},
      {id:'e2',kind:'battle',summary:'ボス戦開始',observedAtMs:2,imageId:'i2'},
      {id:'e3',kind:'scene',summary:'新エリア',observedAtMs:3,imageId:'i3'},
      {id:'e4',kind:'result',summary:'勝利結果',observedAtMs:4,imageId:'i4'},
      {id:'e5',kind:'progress',summary:'重要アイテム',observedAtMs:5,imageId:'i5'},
      {id:'e6',kind:'other',summary:'会話',observedAtMs:6,imageId:'i6'}
    ],
    generations:[{id:'g1',chapters:[{sourceEventId:'e3',title:'新エリアへ'}]}]
  };
}
test('reference selection prefers chapter events and strong visual events, capped at five',()=>{
  const ids=T.selectReferenceIds(session(),'g1');
  assert.equal(ids.length,5);
  assert.equal(ids[0],'i3');
  assert(ids.includes('i2'));assert(ids.includes('i4'));assert(!ids.includes('i1'));
});
test('prompt uses stream context and exact optional caption',()=>{
  const s=session(),ids=T.selectReferenceIds(s,'g1');
  const withText=T.buildPrompt(s,{generationId:'g1',referenceImageIds:ids,includeText:true,caption:'ボス戦！'});
  assert(withText.includes('16:9'));assert(withText.includes('ボス戦！'));assert(withText.includes('新エリアへ'));assert(withText.includes('ボス戦開始'));
  const without=T.buildPrompt(s,{generationId:'g1',referenceImageIds:ids,includeText:false,caption:'ignored'});
  assert(without.includes('文字・ロゴ・字幕は新しく追加しない'));assert(!without.includes('「ignored」'));
  assert.equal(T.suggestedCaption(s,'g1'),'新エリアへ');
});
test('image generation sends at most five references and returns image blob',async()=>{
  const images=Array.from({length:7},(_,i)=>({blob:new Blob([Uint8Array.from([i+1])],{type:'image/jpeg'})}));
  let called=0;
  const result=await T.generate(' paid.test-key ',{prompt:'thumbnail',images,signal:new AbortController().signal,fetcher:async(url,options)=>{
    called++;assert.equal(url,'https://generativelanguage.googleapis.com/v1/models/gemini-nano-banana-2.1:generateContent');
    assert.equal(options.headers['x-goog-api-key'],'paid.test-key');
    const body=JSON.parse(options.body);
    assert.equal(body.contents[0].parts.filter(p=>p.inlineData).length,5);
    assert.equal(body.generationConfig.responseModalities[0],'IMAGE');
    assert.equal(body.generationConfig.responseFormat.image.aspectRatio,'16:9');
    assert.equal(body.generationConfig.responseFormat.image.imageSize,'1K');
    return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'AQID'}}]}}]})};
  }});
  assert.equal(called,1);assert.equal(result.model,T.MODEL);assert.equal(result.blob.type,'image/png');assert.equal(result.blob.size,3);
});
test('image generation explains paid-key auth errors and missing images',async()=>{
  const image={blob:new Blob([Uint8Array.from([1])],{type:'image/jpeg'})};
  await assert.rejects(T.generate('key',{prompt:'x',images:[image],fetcher:async()=>({status:403,ok:false})}),/課金設定/);
  await assert.rejects(T.generate('key',{prompt:'x',images:[image],fetcher:async()=>({status:200,ok:true,json:async()=>({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[]}}]})})}),/MAX_TOKENS/);
});
