/* Editing and export are projections. Never modify source events or AI generations. */
(function(root){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const uid=()=>root.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const validTime=ms=>Number.isSafeInteger(ms)&&Math.abs(ms)<=8640000000000000;
  const title=value=>String(value??'').replace(/\s+/gu,' ').trim();
  function draft(session,generation){
    const saved=session?.chapterEdits?.find(x=>x.generationId===generation?.id);
    if(saved)return clone(saved);
    return {generationId:generation?.id,updatedAtMs:null,introEnabled:true,introTitle:'配信開始',
      chapters:(generation?.chapters||[]).map(c=>({id:c.id,sourceChapterId:c.id,sourceEventId:c.sourceEventId,
        originalObservedAtMs:c.observedAtMs,atMs:c.observedAtMs,title:c.title,editedAtMs:null}))};
  }
  function save(session,generation,value){
    if(!generation||value.generationId!==generation.id)throw new Error('編集する生成履歴がありません。');
    value=clone(value);value.updatedAtMs=Date.now();
    session.chapterEdits=[...(session.chapterEdits||[]).filter(x=>x.generationId!==generation.id),value];
    return value;
  }
  function edit(session,generation,id,values){
    const value=draft(session,generation),name=title(values.title);
    if(!name||name.length>80)throw new Error('タイトルは1〜80文字で入力してください。');
    if(!validTime(values.atMs))throw new Error('有効な日時を入力してください。');
    const item=id?value.chapters.find(c=>c.id===id):{id:uid(),sourceChapterId:null,sourceEventId:null,originalObservedAtMs:null};
    if(!item)throw new Error('編集するチャプターが見つかりません。');
    Object.assign(item,{title:name,atMs:values.atMs,editedAtMs:Date.now()});
    if(!id)value.chapters.push(item);
    save(session,generation,value);return item;
  }
  function remove(session,generation,id){
    const value=draft(session,generation),removed=value.chapters.find(c=>c.id===id);
    value.chapters=value.chapters.filter(c=>c.id!==id);save(session,generation,value);return removed;
  }
  function restore(session,generation,item){
    const value=draft(session,generation);
    if(item&&!value.chapters.some(c=>c.id===item.id))value.chapters.push(clone(item));
    save(session,generation,value);
  }
  function reset(session,generation){session.chapterEdits=(session.chapterEdits||[]).filter(x=>x.generationId!==generation.id);}
  function formatTime(seconds){
    const s=Math.floor(Math.abs(seconds)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);
    return `${seconds<0?'-':''}${h?String(h).padStart(2,'0')+':':''}${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }
  function parseTime(text){
    const match=/^(-)?(?:(\d+):)?(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(String(text).trim());
    if(!match||(match[2]&&Number(match[3])>59))throw new Error('時刻は「12:34」または「1:02:34」で入力してください。');
    const ms=((Number(match[2]||0)*3600+Number(match[3])*60+Number(match[4]))*1000+Number((match[5]||'').padEnd(3,'0')))*(match[1]?-1:1);
    if(!Number.isSafeInteger(ms))throw new Error('時刻が大きすぎます。');return ms;
  }
  function exportText(session,generation){
    const result={text:'',errors:[],warnings:[],excluded:[],introAdded:false,canCopy:false};
    if(!generation){result.errors.push('生成結果を選択してください。');return result;}
    const start=session?.youtubeSync?.actualStartTimeMs,end=session?.youtubeSync?.actualEndTimeMs;
    if(!validTime(start)){result.errors.push('YouTubeと同期して、実際の配信開始時刻を取得してください。');return result;}
    if(end!=null&&(!validTime(end)||end<=start)){result.errors.push('YouTubeの開始・終了時刻を確認し、時刻を再取得してください。');return result;}
    const value=draft(session,generation),rows=[];
    for(const item of [...value.chapters].sort((a,b)=>a.atMs-b.atMs)){
      if(!validTime(item.atMs)||!title(item.title)){result.errors.push('日時またはタイトルが不正なチャプターがあります。編集して確認してください。');continue;}
      const reason=item.atMs<start?'配信開始前':end!=null&&item.atMs>=end?'配信終了以降':null;
      if(reason){result.excluded.push({id:item.id,title:item.title,reason});continue;}
      rows.push({seconds:Math.floor((item.atMs-start)/1000),title:title(item.title)});
    }
    if(result.excluded.length)result.warnings.push(`${result.excluded.length}件は配信の範囲外のため出力しません。元の記録と編集内容は残っています。`);
    if(!rows.length){result.errors.push('出力できるチャプターがありません。追加または日時を調整してください。');return result;}
    if(rows[0].seconds>0&&value.introEnabled){
      if(!title(value.introTitle))result.errors.push('00:00のタイトルを入力してください。');
      else {rows.unshift({seconds:0,title:title(value.introTitle)});result.introAdded=true;}
    }
    if(rows[0].seconds!==0)result.warnings.push('最初の時刻が00:00ではありません。冒頭を補うか、チャプターを追加してください。');
    if(rows.length<3)result.warnings.push('3件未満です。YouTubeのチャプター表示には3件以上が必要です。');
    const duplicates=[],short=[];
    for(let i=1;i<rows.length;i++){
      const gap=rows[i].seconds-rows[i-1].seconds;
      if(gap===0)duplicates.push(formatTime(rows[i].seconds));
      else if(gap<10)short.push(formatTime(rows[i-1].seconds));
    }
    if(duplicates.length)result.errors.push(`時刻が重複しています（${[...new Set(duplicates)].join('、')}）。編集または削除してください。`);
    if(end!=null&&(end-start)/1000-rows.at(-1).seconds<10)short.push(formatTime(rows.at(-1).seconds));
    if(short.length)result.warnings.push(`10秒未満の区間があります（${short.join('、')}）。YouTubeのチャプター表示には各区間10秒以上が必要です。`);
    if(end==null)result.warnings.push('配信終了時刻が未取得のため、最後の区間の長さと終了後の候補は確認できません。');
    result.text=rows.map(row=>`${formatTime(row.seconds)} ${row.title}`).join('\n');
    result.canCopy=result.errors.length===0;return result;
  }
  const api={draft,save,edit,remove,restore,reset,formatTime,parseTime,exportText};
  root.LiveChapterEditor=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
