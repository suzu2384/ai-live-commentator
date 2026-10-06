(function(root){
  'use strict';
  const C=root.LiveCore,Y=root.LiveYouTube,$=id=>document.getElementById(id);
  const date=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('ja-JP'):'未取得';
  // Only returns a selection; cancelled/failed lookups never mutate session data.
  async function choose(key,channelId,signal,setStatus,referenceAtMs){
    C.check(signal);
    const dialog=$('youtubeDialog'),list=$('youtubeCandidates'),message=$('youtubeMessage'),confirm=$('youtubeConfirm'),retry=$('youtubeRetry'),more=$('youtubeMore'),direct=$('youtubeDirect'),lookupButton=$('youtubeLookup');
    const lookup=new AbortController(),token=lookup.signal;
    let selected=null,items=[],nextPageToken='',loading=false,settled=false;
    direct.value='';list.replaceChildren();
    const state=(text,kind='ready')=>{message.textContent=text;message.dataset.state=kind;};
    const controls=()=>{confirm.disabled=loading||!selected;retry.disabled=loading;more.disabled=loading||!nextPageToken;more.hidden=!nextPageToken;lookupButton.disabled=loading;direct.disabled=loading;};
    const render=()=>{
      list.replaceChildren();
      for(const item of Y.sortCandidates(items,referenceAtMs)){
        const label=document.createElement('label'),radio=document.createElement('input'),image=document.createElement('img'),text=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('small');
        label.className='youtube-candidate';radio.type='radio';radio.name='youtube-video';radio.value=item.videoId;radio.checked=false;radio.disabled=loading;
        radio.addEventListener('change',()=>{selected=item;controls();});
        image.src=item.thumbnail;image.alt='';image.referrerPolicy='no-referrer';title.textContent=item.title;
        meta.textContent=`${item.state} · 開始 ${date(item.actualStartTimeMs)} · 終了 ${date(item.actualEndTimeMs)} · ID: ${item.videoId}${item.actualStartTimeMs===null?' · 開始時刻未取得のため相対時間は未同期':''}`;
        text.append(title,meta);label.append(radio,image,text);list.append(label);
      }
    };
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{settled=true;lookup.abort();signal.removeEventListener('abort',abort);confirm.removeEventListener('click',pick);$('youtubeCancel').removeEventListener('click',cancel);retry.removeEventListener('click',reload);more.removeEventListener('click',next);lookupButton.removeEventListener('click',find);dialog.removeEventListener('cancel',cancel);dialog.close();};
      const done=value=>{if(settled)return;cleanup();resolve(value);};
      const abort=()=>{if(settled)return;cleanup();reject(C.abortError());};
      const cancel=e=>{e?.preventDefault();done(null);};
      const perform=async(fn)=>{
        if(loading||settled)return;loading=true;controls();list.querySelectorAll('input').forEach(el=>el.disabled=true);
        try{if(!key.trim())throw new Error('接続設定でYouTube APIキーを入力・解除してください。');await fn();}
        catch(e){if(!settled&&!token.aborted)state('取得失敗: '+e.message+' 元のチャプターと同期先は変更していません。','error');}
        finally{loading=false;if(!settled){controls();list.querySelectorAll('input').forEach(el=>el.disabled=false);setStatus('YouTube同期先の選択待ち');}}
      };
      const load=append=>perform(async()=>{
        state('終了済みの配信候補を取得しています…','loading');setStatus('YouTube配信候補を取得中');
        const result=await C.deadline(t=>Y.candidates(key,channelId.trim(),t,undefined,{pageToken:append?nextPageToken:''}),25000,token,'候補取得がタイムアウトしました。');C.check(token);
        if(append&&result.nextPageToken===nextPageToken&&nextPageToken)throw new Error('次の候補を取得できませんでした。');
        items=[...new Map([...(append?items:[]),...result.items].map(v=>[v.videoId,v])).values()];nextPageToken=result.nextPageToken;selected=null;render();
        state(items.length?'取得した候補をチャプター日時に近い順で表示しています。同期先を選択してください。':'同期できる配信が見つかりませんでした。URL／動画IDの直接指定も利用できます。',items.length?'ready':'empty');
      });
      const reload=()=>void load(false),next=()=>void load(true);
      const find=()=>void perform(async()=>{
        const videoId=Y.parseVideoId(direct.value);state('指定した動画を取得しています…','loading');
        const item=await C.deadline(t=>Y.synchronize({videoId},key,t),15000,token,'動画取得がタイムアウトしました。');C.check(token);
        items=[item];nextPageToken='';selected=null;render();state('動画を確認し、選択して「この動画と同期」を押してください。');
      });
      const pick=()=>{if(!selected)return;void perform(async()=>{
        state('選択した配信の開始時刻を取得しています…','loading');
        const value=await C.deadline(t=>Y.synchronize({videoId:selected.videoId,selectedAtMs:Date.now()},key,t),15000,token,'開始時刻の取得がタイムアウトしました。');C.check(token);done(value);
      });};
      confirm.addEventListener('click',pick);$('youtubeCancel').addEventListener('click',cancel);retry.addEventListener('click',reload);more.addEventListener('click',next);lookupButton.addEventListener('click',find);dialog.addEventListener('cancel',cancel);signal.addEventListener('abort',abort,{once:true});
      controls();dialog.showModal();
      if(channelId.trim())reload();else state('候補検索にはチャンネルIDを設定してください。URL／動画IDの直接指定はチャンネルIDなしでも利用できます。');
    });
  }
  root.LiveYouTubeUI={choose};
})(globalThis);
