/* ChatGPT thumbnail material selection, prompt building and ZIP export. */
(function(root){
  'use strict';
  const MAX_REFERENCES=5,kindScore={result:70,battle:70,scene:55,progress:45,other:20,menu:5};
  const text=value=>String(value??'').trim();
  function generationOf(session,generationId){
    return session?.generations?.find(g=>g.id===generationId)||session?.generations?.at(-1)||null;
  }
  function rows(session,generationId){
    if(!session)return [];
    const generation=generationOf(session,generationId),chapterEvents=new Set((generation?.chapters||[]).map(c=>c.sourceEventId).filter(Boolean)),best=new Map();
    for(const [index,event] of (session.events||[]).entries()){
      if(!event?.imageId)continue;
      const row={imageId:event.imageId,eventId:event.id,kind:event.kind,summary:text(event.summary),observedAtMs:Number(event.observedAtMs)||0,
        isChapter:chapterEvents.has(event.id),score:(kindScore[event.kind]||0)+(chapterEvents.has(event.id)?120:0),index};
      const previous=best.get(row.imageId);
      if(!previous||row.score>previous.score||(row.score===previous.score&&row.observedAtMs>previous.observedAtMs))best.set(row.imageId,row);
    }
    return [...best.values()];
  }
  function selectReferenceIds(session,generationId,max=MAX_REFERENCES){
    const candidates=rows(session,generationId),limit=Math.max(1,Math.min(MAX_REFERENCES,Math.trunc(Number(max)||MAX_REFERENCES)));
    if(candidates.length<=limit)return candidates.sort((a,b)=>b.score-a.score||a.observedAtMs-b.observedAtMs).map(x=>x.imageId);
    const times=candidates.map(x=>x.observedAtMs),span=Math.max(1,Math.max(...times)-Math.min(...times)),selected=[],remaining=[...candidates];
    while(selected.length<limit&&remaining.length){
      let winner=0,bestValue=-Infinity;
      for(let i=0;i<remaining.length;i++){
        const row=remaining[i],distance=selected.length?Math.min(...selected.map(x=>Math.abs(x.observedAtMs-row.observedAtMs)))/span:1;
        const value=row.score+distance*45;
        if(value>bestValue||(value===bestValue&&row.observedAtMs<remaining[winner]?.observedAtMs)){bestValue=value;winner=i;}
      }
      selected.push(remaining.splice(winner,1)[0]);
    }
    return selected.map(x=>x.imageId);
  }
  function validSelection(session,ids){
    const available=new Set(session?.representativeImageIds||[]);
    return [...new Set(Array.isArray(ids)?ids:[])].filter(id=>available.has(id)).slice(0,MAX_REFERENCES);
  }
  function selectedReferenceIds(session,generationId){
    const saved=validSelection(session,session?.thumbnailMaterialImageIds);
    if(session?.thumbnailMaterialMode==='manual'&&saved.length)return saved;
    return selectReferenceIds(session,generationId);
  }
  function imageInfo(session,imageId,generationId){
    const item=rows(session,generationId).find(x=>x.imageId===imageId);
    return item||{imageId,eventId:null,kind:'other',summary:'代表画像',observedAtMs:0,isChapter:false,score:0};
  }
  function suggestedCaption(session,generationId){
    const generation=generationOf(session,generationId),chapter=text(generation?.chapters?.[0]?.title);
    return (chapter||text(session?.contentName)||text(session?.youtubeSync?.title)).slice(0,32);
  }
  function buildPrompt(session,{generationId=null,referenceImageIds=[],includeText=true,caption=''}={}){
    const ids=validSelection(session,referenceImageIds),generation=generationOf(session,generationId);
    const chapters=(generation?.chapters||[]).slice(0,8).map(c=>text(c.title)).filter(Boolean);
    const sourceLines=ids.map((id,index)=>{
      const info=imageInfo(session,id,generationId),chapter=info.isChapter?'・チャプター採用場面':'';
      return `画像${index+1}: [${info.kind||'other'}${chapter}] ${info.summary||'代表画像'}`;
    });
    const copy=includeText&&text(caption)
      ?`サムネイル内に日本語で「${text(caption).slice(0,50)}」を1か所だけ、大きく読みやすく配置してください。文字は正確に描画してください。`
      :'文字・ロゴ・字幕は新しく追加しないでください。';
    return [
      `添付した${ids.length||'複数'}枚の画像は、同じゲーム配信から選んだサムネイル素材です。`,
      'これらを参考に、YouTubeの通常動画向け16:9サムネイルを1枚生成してください。',
      '元画像のゲーム画面・登場人物・UI・世界観を尊重し、存在しないキャラクター、装備、重要アイテム、出来事を創作しないでください。',
      '複数画像を無理にコラージュする必要はありません。配信内容を象徴する最も強い場面を中心に、小さい表示でも主役が一目で分かる構図にしてください。',
      '重要部分を大きく見せ、背景は必要に応じて整理し、十分なコントラストを確保してください。過度な煽りや内容と異なる演出は避けてください。',
      copy,
      text(session?.contentName)&&`配信対象: ${text(session.contentName)}`,
      chapters.length&&`主なチャプター: ${chapters.join(' / ')}`,
      sourceLines.length&&['添付画像の内容:',...sourceLines].join('\n')
    ].filter(Boolean).join('\n');
  }
  const encoder=new TextEncoder();
  function crc32(bytes){
    let crc=0xffffffff;
    for(const b of bytes){
      crc^=b;
      for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    return (crc^0xffffffff)>>>0;
  }
  function dosDateTime(ms){
    const d=new Date(Number.isFinite(ms)?ms:Date.now()),year=Math.max(1980,d.getFullYear());
    return {time:(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1),date:((year-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate()};
  }
  function u16(view,offset,value){view.setUint16(offset,value,true);}
  function u32(view,offset,value){view.setUint32(offset,value>>>0,true);}
  function extension(mime){
    return mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
  }
  async function zipBlob(files){
    const prepared=[];
    for(const file of files){
      const name=encoder.encode(file.name),data=file.data instanceof Uint8Array?file.data:new Uint8Array(await file.data.arrayBuffer()),crc=crc32(data),dt=dosDateTime(file.modifiedAtMs);
      prepared.push({name,data,crc,...dt});
    }
    const locals=[],centrals=[];let offset=0;
    for(const f of prepared){
      const local=new Uint8Array(30+f.name.length+f.data.length),lv=new DataView(local.buffer);
      u32(lv,0,0x04034b50);u16(lv,4,20);u16(lv,6,0x0800);u16(lv,8,0);u16(lv,10,f.time);u16(lv,12,f.date);u32(lv,14,f.crc);
      u32(lv,18,f.data.length);u32(lv,22,f.data.length);u16(lv,26,f.name.length);u16(lv,28,0);local.set(f.name,30);local.set(f.data,30+f.name.length);locals.push(local);
      const central=new Uint8Array(46+f.name.length),cv=new DataView(central.buffer);
      u32(cv,0,0x02014b50);u16(cv,4,20);u16(cv,6,20);u16(cv,8,0x0800);u16(cv,10,0);u16(cv,12,f.time);u16(cv,14,f.date);u32(cv,16,f.crc);
      u32(cv,20,f.data.length);u32(cv,24,f.data.length);u16(cv,28,f.name.length);u16(cv,30,0);u16(cv,32,0);u16(cv,34,0);u16(cv,36,0);u32(cv,38,0);u32(cv,42,offset);central.set(f.name,46);centrals.push(central);
      offset+=local.length;
    }
    const centralSize=centrals.reduce((sum,x)=>sum+x.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
    u32(ev,0,0x06054b50);u16(ev,4,0);u16(ev,6,0);u16(ev,8,prepared.length);u16(ev,10,prepared.length);u32(ev,12,centralSize);u32(ev,16,offset);u16(ev,20,0);
    return new Blob([...locals,...centrals,end],{type:'application/zip'});
  }
  async function buildPackage({images,prompt,session}){
    if(!Array.isArray(images)||!images.length)throw new Error('保存する代表画像がありません。');
    const files=[];
    for(let i=0;i<images.length;i++){
      const record=images[i];if(!record?.blob)continue;
      files.push({name:`${String(i+1).padStart(2,'0')}-reference.${extension(record.blob.type||record.mimeType)}`,data:record.blob,modifiedAtMs:record.capturedAtMs});
    }
    if(!files.length)throw new Error('代表画像を読み込めませんでした。');
    files.push({name:'chatgpt-prompt.txt',data:encoder.encode(String(prompt||'')+'\n'),modifiedAtMs:Date.now()});
    const info={contentName:text(session?.contentName),startedAtMs:session?.startedAtMs??null,sourceImages:files.length-1};
    files.push({name:'materials.json',data:encoder.encode(JSON.stringify(info,null,2)+'\n'),modifiedAtMs:Date.now()});
    return zipBlob(files);
  }
  const api={MAX_REFERENCES,selectReferenceIds,selectedReferenceIds,validSelection,imageInfo,suggestedCaption,buildPrompt,buildPackage,zipBlob};
  root.LiveThumbnailMaterials=api;root.LiveThumbnails=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
