/* Public YouTube lookup only. No OAuth or writes. */
(function(root){
  'use strict';
  const C=root.LiveCore;
  const validId=id=>typeof id==='string'&&/^[\w-]{11}$/.test(id);
  const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
  async function request(resource,params,key,signal,fetcher=fetch){
    C.check(signal);key=C.normalizeKey(key);
    const url=new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for(const [name,value] of Object.entries(params))url.searchParams.set(name,value);
    let response;
    try{response=await fetcher(url.href,{headers:{'X-Goog-Api-Key':key},signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'});}catch{C.check(signal);throw new Error('YouTubeへ接続できません。通信・APIキーの利用制限を確認してください。');}
    if(!response.ok)throw new Error(`YouTube API HTTP ${response.status}。${response.status===403?'APIの有効化・キーの制限・利用上限を確認してください。':'接続設定やサービスの状態を確認してください。'}`);
    let body;try{body=await response.json();}catch{throw new Error('YouTubeの応答形式が不正です。');}
    C.check(signal);if(!Array.isArray(body?.items))throw new Error('YouTubeの応答に候補一覧がありません。');return body;
  }
  function video(item){
    if(!validId(item?.id)||!item.snippet)throw new Error('YouTubeの動画情報が不正です。');
    const detail=item.liveStreamingDetails||{},actualStartTimeMs=timestamp(detail.actualStartTime);
    return {videoId:item.id,channelId:item.snippet.channelId,title:String(item.snippet.title||'タイトルなし'),
      thumbnail:`https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
      state:detail.actualEndTime?'終了':item.snippet.liveBroadcastContent==='live'?'配信中':item.snippet.liveBroadcastContent==='upcoming'?'開始予定':'状態確認中',
      scheduledStartTimeMs:timestamp(detail.scheduledStartTime),actualStartTime:actualStartTimeMs===null?null:detail.actualStartTime,actualStartTimeMs};
  }
  async function details(ids,key,signal,fetcher){
    const body=await request('videos',{part:'snippet,liveStreamingDetails',id:ids.join(',')},key,signal,fetcher);return body.items.map(video);
  }
  async function candidates(key,channelId,signal,fetcher){
    if(!/^UC[\w-]{22}$/.test(channelId))throw new Error('YouTubeチャンネルIDは UC で始まる24文字を指定してください。');
    const ids=new Set();
    for(const eventType of ['live','upcoming']){
      let pageToken='';const seen=new Set();
      do{
        const params={part:'snippet',channelId,eventType,type:'video',maxResults:'50'};if(pageToken)params.pageToken=pageToken;
        const body=await request('search',params,key,signal,fetcher);
        for(const item of body.items){if(!validId(item?.id?.videoId))throw new Error('YouTubeの候補IDが不正です。');ids.add(item.id.videoId);}
        pageToken=body.nextPageToken||'';
        if(pageToken&&seen.has(pageToken))throw new Error('YouTubeの候補一覧を最後まで取得できませんでした。');seen.add(pageToken);
      }while(pageToken);
    }
    const result=[],all=[...ids];
    for(let i=0;i<all.length;i+=50)result.push(...await details(all.slice(i,i+50),key,signal,fetcher));
    if(ids.size&&result.length!==ids.size)throw new Error('一部のYouTube配信情報を取得できませんでした。再取得するか連携なしで開始してください。');
    return result.filter(v=>v.channelId===channelId&&v.state!=='終了');
  }
  async function synchronize(previous,key,signal,fetcher){
    if(!validId(previous?.videoId))throw new Error('同期する動画IDがありません。');
    const result=await details([previous.videoId],key,signal,fetcher),v=result.find(x=>x.videoId===previous.videoId);
    if(!v)throw new Error('選択したYouTube配信を取得できませんでした。公開状態を確認してください。');
    return {...previous,...v,syncedAtMs:Date.now(),syncError:null};
  }
  function relative(at,sync){
    if(!Number.isFinite(at)||!Number.isFinite(sync?.actualStartTimeMs))return null;
    const diff=at-sync.actualStartTimeMs,seconds=Math.floor(Math.abs(diff)/1000),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
    return `${diff<0?'配信開始前 −':''}${h?`${String(h).padStart(2,'0')}:`:''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  const api={candidates,synchronize,relative,timestamp};root.LiveYouTube=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
