(function(root){
  'use strict';
  const H=root.LiveChapters,C=root.LiveCore,$=id=>document.getElementById(id);
  const date=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
  const names={scene:'場面',progress:'進行',battle:'戦闘',result:'結果',menu:'メニュー',other:'その他'};
  class ChapterUI{
    constructor({log,onGenerate,onSelectTab,onSync,onResync,onUnlink}){
      this.log=log;this.onSelectTab=onSelectTab;this.active=null;this.selected=null;this.busy=false;this.generating=false;this.page=0;this.generationId=null;this.warnedObservation=false;
      this.store=new H.Store(()=>{$('chapterStorageWarning').hidden=false;});
      this.ready=this.store.ready.then(()=>{this.selected=[...this.store.records.values()].sort((a,b)=>b.startedAtMs-a.startedAtMs)[0]?.id||null;$('chapterStatus').textContent=this.selected?'保存済みの記録を復元しました。生成・再生成できます。':'イベントを蓄積すると生成できます。';this.render();});
      try{$('chapterAuto').checked=localStorage.getItem('minkome-chapter-auto-v1')!=='false';}catch{}
      $('chapterAuto').addEventListener('change',()=>{try{localStorage.setItem('minkome-chapter-auto-v1',String($('chapterAuto').checked));}catch{}});
      $('chapterSession').addEventListener('change',()=>{this.selected=$('chapterSession').value;this.page=0;this.generationId=null;$('chapterStatus').textContent='選択した記録から生成・再生成できます。';this.render();});
      $('chapterGeneration').addEventListener('change',()=>{this.generationId=$('chapterGeneration').value;this.render();});
      $('youtubeSync').addEventListener('click',()=>onSync());
      $('youtubeResync').addEventListener('click',()=>onResync());
      $('youtubeUnlink').addEventListener('click',()=>onUnlink());
      $('chapterGenerate').addEventListener('click',()=>onGenerate());
      $('chapterPrev').addEventListener('click',()=>{this.page--;this.renderEvents();});
      $('chapterNext').addEventListener('click',()=>{this.page++;this.renderEvents();});
    }
    current(){return this.store.records.get(this.selected);}
    setBusy(value){this.busy=value;this.controls();}
    controls(){const s=this.current();$('youtubeSync').disabled=this.busy||!(s?.generations.length||s?.youtubeSync);$('youtubeSync').textContent=s?.youtubeSync?'同期先を変更':'YouTubeと同期';$('youtubeUnlink').disabled=this.busy||!s?.youtubeSync;$('youtubeResync').disabled=this.busy||!s?.youtubeSync;$('chapterGenerate').disabled=this.busy||this.generating||!s?.events.length;$('chapterAuto').disabled=this.busy;$('chapterSession').disabled=this.busy||this.generating;$('chapterGeneration').disabled=this.generating;}
    async begin(contentName){
      await this.ready;const s=H.session(contentName);this.active=s.id;this.selected=s.id;this.page=0;this.generationId=null;this.warnedObservation=false;
      await this.store.save(s);$('chapterStatus').textContent='実況の解析と一緒にイベントを記録しています。';this.render();
    }
    async linkYouTube(key,channelId,signal,setStatus){
      const s=this.current();if(!s)return;
      const generation=s.generations.find(g=>g.id===this.generationId)||s.generations.at(-1);
      const reference=generation?.chapters[0]?.observedAtMs??s.events[0]?.observedAtMs??s.startedAtMs;
      const sync=await root.LiveYouTubeUI.choose(key,channelId,signal,setStatus,reference);C.check(signal);
      if(!sync)return;
      // The only mutable data is synchronization metadata. Absolute event/chapter timestamps stay intact.
      s.youtubeSync=sync;await this.store.save(s);this.render();
    }
    async unlinkYouTube(signal){
      C.check(signal);const s=this.current();if(!s)return;
      s.youtubeSync=null;await this.store.save(s);this.render();
    }
    async syncYouTube(key,signal,sessionId=this.selected){
      const s=this.store.records.get(sessionId);if(!s?.youtubeSync)return;
      try{
        if(!key)throw new Error('接続設定でYouTube APIキーを入力・解除してください。');
        s.youtubeSync=await C.deadline(t=>root.LiveYouTube.synchronize(s.youtubeSync,key,t),15000,signal,'YouTube開始時刻の取得がタイムアウトしました。');
      }catch(e){C.check(signal);s.youtubeSync.syncError=e.message;this.log(e.message,'warn');}
      await this.store.save(s);this.render();
    }
    observe(body,frames,contentName){
      const s=this.store.records.get(this.active);if(!s)return;
      try{
        const events=H.observation(body,frames,contentName);
        for(const e of events)s.events.push({...e,sessionId:s.id,sequence:s.events.length+1});
        if(events.length){void this.store.save(s);if(this.selected===s.id)this.render();}
      }catch(e){if(!this.warnedObservation){this.warnedObservation=true;this.log('チャプター用イベントを記録できない応答がありました。実況は続行します。','warn');$('chapterStatus').textContent='一部の応答にイベント要約がなく、記録を見送りました。以降の解析では記録を続けます。';}}
    }
    async end(reason){
      const s=this.store.records.get(this.active);if(!s)return null;
      this.active=null;s.endedAtMs=Date.now();s.status=reason;await this.store.save(s);$('chapterStatus').textContent=s.events.length?'イベントの記録を終了しました。生成・再生成できます。':'記録を終了しました。生成に使えるイベントはありません。';this.render();return s.id;
    }
    async generate(key,signal,onRequest,sessionId=this.selected){
      const s=this.store.records.get(sessionId);if(!s)return;
      this.selected=s.id;this.generating=true;this.render();this.onSelectTab();
      try{
        const generation=await H.generate(s,{signal,onProgress:text=>{$('chapterStatus').textContent=text;},request:async(payload,token)=>{
          onRequest();return C.deadline(t=>C.gemini(key,payload,t),120000,token,'チャプター生成がタイムアウトしました。記録は残っているので再生成できます。');
        }});
        C.check(signal);s.generations.push(generation);await this.store.save(s);this.generationId=generation.id;
        $('chapterStatus').textContent=generation.chapters.length?`${generation.chapters.length}件の候補を生成しました。`:'候補を生成できる出来事がありませんでした。元イベントは保存しています。';
        this.log(`チャプター候補 ${generation.chapters.length}件を生成（API ${generation.requestCount}回）。`);
      }catch(e){
        $('chapterStatus').textContent=(signal.aborted?'生成を中止しました。':e.message)+' 元イベントと前回の候補は残っています。';
        if(!signal.aborted)this.log('チャプター生成: '+e.message,'warn');
      }finally{this.generating=false;this.render();}
    }
    render(){
      const select=$('chapterSession');select.replaceChildren();
      for(const s of [...this.store.records.values()].sort((a,b)=>b.startedAtMs-a.startedAtMs)){
        const option=document.createElement('option');option.value=s.id;option.textContent=`${date(s.startedAtMs)} · ${s.contentName||'対象なし'}`;select.append(option);
      }
      if(this.selected)select.value=this.selected;
      const s=this.current(),states={recording:this.active===s?.id?'記録中':'未終了の記録',finished:'終了',interrupted:'中断'};
      $('chapterSessionInfo').textContent=s?`${states[s.status]||'保存済み'} · ${date(s.startedAtMs)} ～ ${date(s.endedAtMs)} · イベント ${s.events.length}件`:'実況を開始すると、ここに記録が蓄積されます。';
      const sync=s?.youtubeSync;
      $('youtubeSyncInfo').textContent=sync?`YouTube: ${sync.title} (${sync.videoId}) · ${Number.isFinite(sync.actualStartTimeMs)?'同期済み · 実際の開始 '+date(sync.actualStartTimeMs):'未同期 · 実際の開始時刻は未取得'} · 実際の終了 ${date(sync.actualEndTimeMs)}${sync.syncError?' · '+sync.syncError:''}`:'YouTube連携なし（絶対日時で表示）';
      const genSelect=$('chapterGeneration');genSelect.replaceChildren();
      for(const g of [...s?.generations||[]].reverse()){
        const option=document.createElement('option');option.value=g.id;option.textContent=`${date(g.createdAtMs)} · ${g.chapters.length}件`;genSelect.append(option);
      }
      if(!s?.generations.some(g=>g.id===this.generationId))this.generationId=s?.generations.at(-1)?.id||null;
      if(this.generationId)genSelect.value=this.generationId;
      const generation=s?.generations.find(g=>g.id===this.generationId),list=$('chapterCandidates');list.replaceChildren();
      $('chapterCandidateEmpty').hidden=!!generation?.chapters.length;
      $('chapterCandidateEmpty').textContent=generation?'この生成では候補がありませんでした。':'生成されたチャプター候補がここに表示されます。';
      for(const chapter of generation?.chapters||[]){
        const item=document.createElement('li'),time=document.createElement('time'),title=document.createElement('strong'),button=document.createElement('button');
        time.dateTime=new Date(chapter.observedAtMs).toISOString();time.textContent=date(chapter.observedAtMs)+(s.youtubeSync?' → '+(root.LiveYouTube.relative(chapter.observedAtMs,s.youtubeSync)??'未同期'):'');title.textContent=chapter.title;
        button.type='button';button.className='subtle';button.textContent='元イベントを見る';button.addEventListener('click',()=>{
          const events=[...s.events].reverse(),index=events.findIndex(e=>e.id===chapter.sourceEventId);if(index<0)return;
          this.page=Math.floor(index/100);this.renderEvents();$('chapterEventsSection').open=true;
          const target=document.getElementById(`chapter-event-${chapter.sourceEventId}`);target?.scrollIntoView({block:'nearest'});target?.focus({preventScroll:true});
        });
        item.append(time,title,button);list.append(item);
      }
      this.renderEvents();this.controls();
    }
    renderEvents(){
      const events=[...this.current()?.events||[]].reverse(),pages=Math.max(1,Math.ceil(events.length/100));this.page=Math.max(0,Math.min(this.page,pages-1));
      $('chapterEventCount').textContent=`元イベントログ（${events.length}件）`;
      $('chapterPage').textContent=`${this.page+1} / ${pages} ページ（新しい順）`;$('chapterPrev').disabled=this.page===0;$('chapterNext').disabled=this.page+1>=pages;
      const list=$('chapterEvents');list.replaceChildren();
      for(const event of events.slice(this.page*100,(this.page+1)*100)){
        const item=document.createElement('li'),time=document.createElement('time'),text=document.createElement('p'),kind=document.createElement('small');
        item.id=`chapter-event-${event.id}`;item.tabIndex=-1;time.dateTime=new Date(event.observedAtMs).toISOString();time.textContent=date(event.observedAtMs)+(this.current()?.youtubeSync?' → '+(root.LiveYouTube.relative(event.observedAtMs,this.current().youtubeSync)??'未同期'):'');
        kind.textContent=`${names[event.kind]||event.kind} · ${event.contentName||'対象なし'}`;text.textContent=event.summary;item.append(time,kind,text);list.append(item);
      }
    }
  }
  root.LiveChapterUI=ChapterUI;
})(globalThis);
