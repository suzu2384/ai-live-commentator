const {test}=require('node:test');
const assert=require('node:assert/strict');
const T=require('../thumbnail.js');

function session(){
  return {
    contentName:'ゲームA',
    startedAtMs:1791190000000,
    representativeImageIds:['i1','i2','i3','i4','i5','i6'],
    thumbnailMaterialImageIds:[],
    thumbnailMaterialMode:'auto',
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
test('reference selection prefers chapter and strong visual events, capped at five',()=>{
  const ids=T.selectReferenceIds(session(),'g1');
  assert.equal(ids.length,5);assert.equal(ids[0],'i3');assert(ids.includes('i2'));assert(ids.includes('i4'));assert(!ids.includes('i1'));
});
test('manual material selection is preserved, invalid ids removed and maximum is five',()=>{
  const s=session();s.thumbnailMaterialMode='manual';s.thumbnailMaterialImageIds=['i6','i2','missing','i3','i4','i5','i1'];
  assert.deepEqual(T.selectedReferenceIds(s,'g1'),['i6','i2','i3','i4','i5']);
  assert.deepEqual(T.validSelection(s,['missing','i1','i1','i2']),['i1','i2']);
});
test('ChatGPT prompt uses stream context, selected image descriptions and optional caption',()=>{
  const s=session(),ids=T.selectReferenceIds(s,'g1');
  const withText=T.buildPrompt(s,{generationId:'g1',referenceImageIds:ids,includeText:true,caption:'ボス戦！'});
  assert(withText.includes('16:9'));assert(withText.includes('ボス戦！'));assert(withText.includes('新エリアへ'));assert(withText.includes('ボス戦開始'));assert(withText.includes('画像1:'));
  const without=T.buildPrompt(s,{generationId:'g1',referenceImageIds:ids,includeText:false,caption:'ignored'});
  assert(without.includes('文字・ロゴ・字幕は新しく追加しない'));assert(!without.includes('「ignored」'));
  assert.equal(T.suggestedCaption(s,'g1'),'新エリアへ');
});
test('ChatGPT material package is a ZIP containing original images and prompt',async()=>{
  const s=session(),images=[
    {blob:new Blob([Uint8Array.from([1,2,3])],{type:'image/jpeg'}),capturedAtMs:1},
    {blob:new Blob([Uint8Array.from([4,5])],{type:'image/png'}),capturedAtMs:2}
  ];
  const zip=await T.buildPackage({images,prompt:'16:9のサムネを作って',session:s});
  assert.equal(zip.type,'application/zip');
  const bytes=Buffer.from(await zip.arrayBuffer()),ascii=bytes.toString('utf8');
  assert.equal(bytes.readUInt32LE(0),0x04034b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  assert(ascii.includes('01-reference.jpg'));assert(ascii.includes('02-reference.png'));assert(ascii.includes('chatgpt-prompt.txt'));assert(ascii.includes('materials.json'));assert(ascii.includes('16:9のサムネを作って'));
  assert.equal(T.generate,undefined);
});
