/* AI thumbnail generation: selection, prompt building and paid Gemini image request. */
(function(root){
  'use strict';
  const MODEL='gemini-nano-banana-2.1',MAX_REFERENCES=5;
  const kindScore={result:60,battle:60,scene:45,progress:40,other:20,menu:5};
  const text=value=>String(value??'').trim();
  function generationOf(session,generationId){
    return session?.generations?.find(g=>g.id===generationId)||session?.generations?.at(-1)||null;
  }
  function selectReferenceIds(session,generationId,max=MAX_REFERENCES){
    if(!session)return [];
    const generation=generationOf(session,generationId),chapterEvents=new Set((generation?.chapters||[]).map(c=>c.sourceEventId).filter(Boolean));
    const rows=(session.events||[]).filter(e=>e.imageId).map((e,index)=>({
      imageId:e.imageId,eventId:e.id,observedAtMs:e.observedAtMs||0,
      score:(kindScore[e.kind]||0)+(chapterEvents.has(e.id)?100:0),index
    }));
    const best=new Map();
    for(const row of rows){
      const previous=best.get(row.imageId);
      if(!previous||row.score>previous.score||(row.score===previous.score&&row.observedAtMs>previous.observedAtMs))best.set(row.imageId,row);
    }
    return [...best.values()].sort((a,b)=>b.score-a.score||b.observedAtMs-a.observedAtMs||b.index-a.index).slice(0,Math.max(1,Math.min(MAX_REFERENCES,max))).map(x=>x.imageId);
  }
  function suggestedCaption(session,generationId){
    const generation=generationOf(session,generationId);
    const chapter=text(generation?.chapters?.[0]?.title);
    const source=chapter||text(session?.contentName)||text(session?.youtubeSync?.title);
    return source.slice(0,32);
  }
  function buildPrompt(session,{generationId=null,referenceImageIds=[],includeText=true,caption=''}={}){
    const wanted=new Set(referenceImageIds),events=(session?.events||[]).filter(e=>e.imageId&&wanted.has(e.imageId));
    const generation=generationOf(session,generationId);
    const chapters=(generation?.chapters||[]).slice(0,8).map(c=>c.title).filter(Boolean);
    const context=[
      text(session?.contentName)&&`配信対象: ${text(session.contentName)}`,
      chapters.length&&`主なチャプター: ${chapters.join(' / ')}`,
      events.length&&`参照場面: ${events.map(e=>`${e.kind}: ${e.summary}`).join(' / ')}`
    ].filter(Boolean).join('\n');
    const copy=includeText&&text(caption)?`サムネイル内に日本語で「${text(caption).slice(0,50)}」を1か所だけ、大きく読みやすく配置してください。文字は正確に描画してください。`:'文字・ロゴ・字幕は新しく追加しないでください。';
    return [
      'YouTubeの通常動画向けサムネイルを1枚作成してください。',
      '添付したゲーム配信のスクリーンショット群を素材として使い、配信内容を象徴する1つの強い場面にまとめてください。',
      '元画像のゲーム画面・登場人物・UI・世界観を尊重し、存在しないキャラクターや重要アイテムを創作しないでください。',
      '構図は16:9。小さい表示でも主役が一目で分かるよう、重要部分を大きく、背景は整理し、コントラストを確保してください。',
      '過度な煽り、誤解を招く演出、無関係な要素は避けてください。',
      copy,
      context
    ].filter(Boolean).join('\n');
  }
  function bytesBase64(buffer){
    const bytes=new Uint8Array(buffer);let binary='';
    for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return root.btoa(binary);
  }
  async function blobPart(record){
    if(!record?.blob)throw new Error('代表画像を読み込めませんでした。');
    const mime=record.blob.type||record.mimeType||'image/jpeg';
    if(!/^image\/(jpeg|png|webp)$/.test(mime))throw new Error('代表画像の形式に対応していません。');
    return {inlineData:{mimeType:mime,data:bytesBase64(await record.blob.arrayBuffer())}};
  }
  async function generate(key,{prompt,images,signal,fetcher=root.fetch}){
    const C=root.LiveCore;C?.check?.(signal);
    key=C?.normalizeKey?C.normalizeKey(key):text(key);
    if(!key)throw new Error('画像生成用Gemini APIキーを入力してください。');
    if(!Array.isArray(images)||!images.length)throw new Error('サムネ生成に使える代表画像がありません。');
    const parts=[{text:prompt}];
    for(const image of images.slice(0,MAX_REFERENCES))parts.push(await blobPart(image));
    C?.check?.(signal);
    let response;
    try{
      response=await fetcher(`https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent`,{
        method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':key},
        body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseModalities:['IMAGE'],responseFormat:{image:{aspectRatio:'16:9',imageSize:'1K'}}}}),
        signal,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'
      });
    }catch(e){C?.check?.(signal);throw new Error('画像生成APIに接続できませんでした。通信状態を確認してください。');}
    if(response.status===401||response.status===403)throw new Error('画像生成APIの認証・課金設定を確認してください。Nano Banana 2.1はFree Tier対象外です。');
    if(response.status===429)throw new Error('画像生成APIの利用上限・頻度制限です（HTTP 429）。');
    if(response.status>=500)throw new Error(`画像生成APIが一時的に利用できません（HTTP ${response.status}）。`);
    if(!response.ok)throw new Error(`画像生成API HTTP ${response.status}。`);
    let body;try{body=await response.json();}catch{throw new Error('画像生成APIの応答を読み取れませんでした。');}
    C?.check?.(signal);
    const imagePart=(body.candidates||[]).flatMap(c=>c?.content?.parts||[]).find(p=>p?.inlineData?.data&&/^image\/(png|jpeg|webp)$/.test(p.inlineData.mimeType||''));
    if(!imagePart){
      const reason=body.candidates?.[0]?.finishReason;
      throw new Error(reason?`画像が生成されませんでした（${reason}）。再生成してください。`:'画像が生成されませんでした。再生成してください。');
    }
    const raw=root.atob(imagePart.inlineData.data);
    if(raw.length>50*1024*1024)throw new Error('生成画像が大きすぎます。');
    const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return {blob:new Blob([bytes],{type:imagePart.inlineData.mimeType}),model:MODEL};
  }
  root.LiveThumbnails={MODEL,MAX_REFERENCES,selectReferenceIds,suggestedCaption,buildPrompt,generate};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.LiveThumbnails;
})(globalThis);
