/* YouTube read-only lookup using OAuth or the legacy API key; no writes. */
(function(root){
  'use strict';
  const C=root.LiveCore;
  const validId=id=>typeof id==='string'&&/^[\w-]{11}$/.test(id);
  const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
  async function request(resource,params,key,signal,fetcher=fetch){
    C.check(signal);const oauth=key&&typeof key==='object'&&typeof key.accessToken==='string';
    const headers=oauth?{Authorization:'Bearer '+key.accessToken}:{'X-Goog-Api-Key':C.normalizeKey(key)};
    const url=new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for(const [name,value] of Object.entries(params))url.searchParams.set(name,value);
    let response;
    try{response=await fetcher(url.href,{headers,signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'});}catch{C.check(signal);throw new Error('YouTubeへ接続できません。通信・APIキーの利用制限を確認してください。');}
    if(!response.ok)throw new Error(`YouTube API HTTP ${response.status}。${response.status===401?'Googleの再認証が必要です。':response.status===403?'APIの有効化・権限・利用上限を確認してください。':'接続設定やサービスの状態を確認してください。'}`);
    let body;try{body=await response.json();}catch{throw new Error('YouTubeの応答形式が不正です。');}
    C.check(signal);if(!Array.isArray(body?.items))throw new Error('YouTubeの応答に候補一覧がありません。');return body;
  }
  function video(item){
    if(!validId(item?.id)||!item.snippet)throw new Error('YouTubeの動画情報が不正です。');
    const detail=item.liveStreamingDetails||{},actualStartTimeMs=timestamp(detail.actualStartTime),actualEndTimeMs=timestamp(detail.actualEndTime);
    const thumbnails=item.snippet.thumbnails||{},thumbnail=thumbnails.medium?.url||thumbnails.default?.url||thumbnails.high?.url||`https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`;
    return {videoId:item.id,channelId:item.snippet.channelId,title:String(item.snippet.title||'タイトルなし'),
      thumbnail,
      state:detail.actualEndTime?'終了':item.snippet.liveBroadcastContent==='live'?'配信中':item.snippet.liveBroadcastContent==='upcoming'?'開始予定':'状態確認中',
      isLiveBroadcast:!!item.liveStreamingDetails,actualEndTime:actualEndTimeMs===null?null:detail.actualEndTime,actualEndTimeMs,
      scheduledStartTimeMs:timestamp(detail.scheduledStartTime),actualStartTime:actualStartTimeMs===null?null:detail.actualStartTime,actualStartTimeMs};
  }
  async function details(ids,key,signal,fetcher){
    const body=await request('videos',{part:'snippet,liveStreamingDetails',id:ids.join(',')},key,signal,fetcher);return body.items.map(video);
  }
  // Fetch one page per explicit action, avoiding unbounded API calls.
  async function candidates(key,channelId,signal,fetcher,{pageToken=''}={}){
    const oauth=key&&typeof key==='object'&&typeof key.accessToken==='string';
    if(!oauth){
      if(!/^UC[\w-]{22}$/.test(channelId))throw new Error('APIキーでの候補検索にはチャンネルIDを設定してください。');
      const params={part:'snippet',channelId,eventType:'completed',type:'video',order:'date',maxResults:'50'};
      if(pageToken)params.pageToken=pageToken;
      const body=await request('search',params,key,signal,fetcher),ids=new Set();
      for(const item of body.items){if(!validId(item?.id?.videoId))throw new Error('YouTubeの候補IDが不正です。');ids.add(item.id.videoId);}
      const items=ids.size?await details([...ids],key,signal,fetcher):[];
      if(items.length!==ids.size)throw new Error('一部のYouTube配信情報を取得できませんでした。再取得またはURL直接指定をお試しください。');
      return {items:items.filter(v=>v.channelId===channelId&&v.isLiveBroadcast),nextPageToken:typeof body.nextPageToken==='string'?body.nextPageToken:''};
    }
    // OAuth is bound to the verified Brand Channel, never to the old channel-ID text field.
    const authorizedChannel=/^UC[\w-]{22}$/.test(key.channelId||'')?key.channelId:'';
    const ownerStream=v=>v.isLiveBroadcast&&(!authorizedChannel||v.channelId===authorizedChannel);
    const uploadCandidates=async token=>{
      const account=await request('channels',{part:'contentDetails',mine:'true',maxResults:'1'},key,signal,fetcher);
      const channel=account.items[0];
      if(authorizedChannel&&channel?.id!==authorizedChannel)throw new Error('YouTubeの認証先チャンネルが変わりました。再認証してください。');
      const playlist=channel?.contentDetails?.relatedPlaylists?.uploads;
      if(!playlist)throw new Error('YouTubeの投稿動画一覧を取得できませんでした。チャンネルの権限を確認してください。');
      const params={part:'contentDetails',playlistId:playlist,maxResults:'50'};
      if(token)params.pageToken=token;
      const list=await request('playlistItems',params,key,signal,fetcher),ids=new Set();
      for(const item of list.items)if(validId(item?.contentDetails?.videoId))ids.add(item.contentDetails.videoId);
      const videos=ids.size?await details([...ids],key,signal,fetcher):[];
      return {items:videos.filter(v=>ownerStream(v)&&Number.isFinite(v.actualEndTimeMs)),
        nextPageToken:list.nextPageToken?'uploads:'+list.nextPageToken:''};
    };
    if(pageToken.startsWith('uploads:'))return uploadCandidates(pageToken.slice(8));
    // List completed broadcasts directly rather than relying on the search index.
    const params={part:'id,snippet,status',broadcastStatus:'completed',broadcastType:'all',maxResults:'50'};
    if(pageToken)params.pageToken=pageToken;
    const list=await request('liveBroadcasts',params,key,signal,fetcher),ids=new Set();
    for(const item of list.items)if(validId(item?.id))ids.add(item.id);
    const videos=ids.size?await details([...ids],key,signal,fetcher):[];
    const items=videos.filter(ownerStream),nextPageToken=typeof list.nextPageToken==='string'?list.nextPageToken:'';
    if(items.length||nextPageToken)return {items,nextPageToken};
    // Some finished archives remain accessible through the uploads playlist.
    return uploadCandidates('');
  }
  function parseVideoId(value){
    const input=String(value||'').trim();if(validId(input))return input;
    let url;try{url=new URL(input);}catch{throw new Error('YouTube動画URLまたは11文字の動画IDを入力してください。');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('YouTubeの動画URLを指定してください。');
    const host=url.hostname.toLowerCase(),parts=url.pathname.split('/').filter(Boolean);let id;
    if(host==='youtu.be')id=parts.length===1?parts[0]:null;
    else if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(host)){
      if(url.pathname==='/watch')id=url.searchParams.get('v');
      else if(['live','shorts','embed'].includes(parts[0])&&parts.length===2)id=parts[1];
    }
    if(!validId(id))throw new Error('対応するYouTube動画URLまたは11文字の動画IDを入力してください。');
    return id;
  }
  function sortCandidates(items,referenceAtMs){
    const distance=v=>Number.isFinite(referenceAtMs)&&Number.isFinite(v.actualStartTimeMs)?Math.abs(v.actualStartTimeMs-referenceAtMs):Infinity;
    return [...items].sort((a,b)=>distance(a)-distance(b)||(b.actualStartTimeMs||0)-(a.actualStartTimeMs||0)||a.videoId.localeCompare(b.videoId));
  }
  async function synchronize(previous,key,signal,fetcher){
    if(!validId(previous?.videoId))throw new Error('同期する動画IDがありません。');
    const result=await details([previous.videoId],key,signal,fetcher),v=result.find(x=>x.videoId===previous.videoId);
    if(!v)throw new Error('選択したYouTube配信を取得できませんでした。公開状態を確認してください。');
    if(!v.isLiveBroadcast)throw new Error('この動画にはライブ配信の情報がありません。配信アーカイブを指定してください。');
    return {...previous,...v,syncedAtMs:Date.now(),syncError:null};
  }
  function relative(at,sync){
    if(!Number.isFinite(at)||!Number.isFinite(sync?.actualStartTimeMs))return null;
    const diff=at-sync.actualStartTimeMs,seconds=Math.floor(Math.abs(diff)/1000),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
    return `${diff<0?'配信開始前 −':''}${h?`${String(h).padStart(2,'0')}:`:''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  const api={candidates,synchronize,relative,timestamp,parseVideoId,sortCandidates};root.LiveYouTube=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
