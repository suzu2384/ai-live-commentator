(function(root){
  'use strict';
  const C=root.LiveCore,Y=root.LiveYouTube,$=id=>document.getElementById(id);
  const date=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('ja-JP'):'未取得';
  async function choose(key,channelId,signal,setStatus){
    if(!key.trim()||!channelId.trim())return null;
    const dialog=$('youtubeDialog'),list=$('youtubeCandidates'),message=$('youtubeMessage'),confirm=$('youtubeConfirm'),retry=$('youtubeRetry');
    const lookup=new AbortController(),lookupSignal=lookup.signal;
    const stopLookup=()=>lookup.abort();signal.addEventListener('abort',stopLookup,{once:true});
    let selected=null,items=[],loading=false,settled=false;
    const load=async()=>{
      loading=true;selected=null;confirm.disabled=true;retry.disabled=true;list.replaceChildren();message.textContent='配信候補を取得しています…';setStatus('YouTube配信候補を取得中');
      try{items=await C.deadline(t=>Y.candidates(key,channelId.trim(),t),25000,lookupSignal,'YouTube配信候補の取得がタイムアウトしました。');C.check(lookupSignal);message.textContent=items.length?'連携する配信を選んでください。自動選択はしません。':'現在の配信候補はありません。';}
      catch(e){C.check(lookupSignal);items=null;message.textContent=e.message;}
      finally{loading=false;if(!settled)retry.disabled=false;}
      if(items)for(const item of items){
        const label=document.createElement('label'),radio=document.createElement('input'),image=document.createElement('img'),text=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('small');
        label.className='youtube-candidate';radio.type='radio';radio.name='youtube-video';radio.value=item.videoId;radio.addEventListener('change',()=>{selected=item;confirm.disabled=false;});
        image.src=item.thumbnail;image.alt='';image.referrerPolicy='no-referrer';title.textContent=item.title;
        meta.textContent=`${item.state} · ${item.actualStartTimeMs!==null?'実際の開始':'予定開始'} ${date(item.actualStartTimeMs??item.scheduledStartTimeMs)} · ${item.videoId}`;
        text.append(title,meta);label.append(radio,image,text);list.append(label);
      }
    };
    try{await load();C.check(signal);}catch(e){signal.removeEventListener('abort',stopLookup);lookup.abort();throw e;}
    if(items?.length===0){signal.removeEventListener('abort',stopLookup);return null;}
    setStatus('YouTube連携先の選択待ち');
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{settled=true;lookup.abort();signal.removeEventListener('abort',stopLookup);signal.removeEventListener('abort',abort);confirm.removeEventListener('click',pick);$('youtubeWithout').removeEventListener('click',without);$('youtubeCancel').removeEventListener('click',cancel);retry.removeEventListener('click',reload);dialog.removeEventListener('cancel',cancel);dialog.close();};
      const done=value=>{if(settled)return;cleanup();resolve(value);};
      const abort=()=>{if(settled)return;cleanup();reject(C.abortError());};
      const cancel=e=>{e?.preventDefault();abort();};
      const without=()=>done(null);
      const pick=()=>{if(selected&&!loading)done({...selected,selectedAtMs:Date.now(),syncedAtMs:Date.now(),syncError:null});};
      const reload=()=>{void load().then(()=>{if(settled)return;if(items?.length===0)done(null);else setStatus('YouTube連携先の選択待ち');}).catch(()=>{if(signal.aborted)abort();});};
      confirm.addEventListener('click',pick);$('youtubeWithout').addEventListener('click',without);$('youtubeCancel').addEventListener('click',cancel);retry.addEventListener('click',reload);dialog.addEventListener('cancel',cancel);signal.addEventListener('abort',abort,{once:true});dialog.showModal();
    });
  }
  root.LiveYouTubeUI={choose};
})(globalThis);
