(function(root){
  'use strict';
  const H=root.LiveChapters,C=root.LiveCore,$=id=>document.getElementById(id);
  const date=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
  const names={scene:'場面',progress:'進行',battle:'戦闘',result:'結果',menu:'メニュー',other:'その他'};
  class ChapterUI{
    constructor({log,onGenerate,onThumbnailGenerate,onSelectTab,onSync,onResync,onUnlink}){
      this.log=log;this.onSelectTab=onSelectTab;this.onThumbnailGenerate=onThumbnailGenerate;this.active=null;this.selected=null;this.busy=false;this.generating=false;this.page=0;this.generationId=null;this.warnedObservation=false;this.imageDialogUrl=null;this.imageRetentionSessions=10;this.pendingImageSaves=new Set();this.thumbnailUrl=null;this.thumbnailReferenceUrls=[];this.thumbnailRenderToken=0;this.thumbnailTextTouched=false;
      try{const stored=Number(localStorage.getItem('minkome-image-retention-sessions-v1'));if(Number.isInteger(stored)&&stored>=1&&stored<=100)this.imageRetentionSessions=stored;}catch{} $('chapterImageRetention').value=String(this.imageRetentionSessions);this.store=new H.Store(()=>{$('chapterStorageWarning').hidden=false;});
      this.ready=this.store.ready.then(async()=>{await this.store.pruneRepresentativeImages(this.imageRetentionSessions);this.selected=[...this.store.records.values()].sort((a,b)=>b.startedAtMs-a.startedAtMs)[0]?.id||null;$('chapterStatus').textContent=this.selected?'保存済みの記録を復元しました。生成・再生成できます。':'イベントを蓄積すると生成できます。';this.render();});
      try{$('chapterAuto').checked=localStorage.getItem('minkome-chapter-auto-v1')!=='false';}catch{}
      $('chapterAuto').addEventListener('change',()=>{try{localStorage.setItem('minkome-chapter-auto-v1',String($('chapterAuto').checked));}catch{}});
      $('chapterSession').addEventListener('change',()=>{this.selected=$('chapterSession').value;this.page=0;this.generationId=null;this.thumbnailTextTouched=false;$('chapterStatus').textContent='選択した記録から生成・再生成できます。';this.render();});
      $('chapterGeneration').addEventListener('change',()=>{this.generationId=$('chapterGeneration').value;this.thumbnailTextTouched=false;this.render();});
      $('youtubeSync').addEventListener('click',()=>onSync());
      $('youtubeResync').addEventListener('click',()=>onResync());
      $('youtubeUnlink').addEventListener('click',()=>onUnlink());
      $('chapterGenerate').addEventListener('click',()=>onGenerate());
      $('chapterPrev').addEventListener('click',()=>{this.page--;this.renderEvents();});
      $('chapterNext').addEventListener('click',()=>{this.page++;this.renderEvents();});
      $('chapterImageRetention').addEventListener('change',()=>void this.changeImageRetention());
      $('chapterImagesDelete').addEventListener('click',()=>void this.deleteCurrentRepresentativeImages());
      $('thumbnailGenerate').addEventListener('click',()=>this.onThumbnailGenerate?.());
      $('thumbnailHistory').addEventListener('change',()=>void this.selectThumbnailHistory());
      $('thumbnailText').addEventListener('input',()=>{this.thumbnailTextTouched=true;});
      $('thumbnailTextEnabled').addEventListener('change',()=>this.controls());
      $('thumbnailDownload').addEventListener('click',()=>void this.downloadCurrentThumbnail());
      this.editor=new root.LiveChapterEditorUI(this);
      $('chapterImageClose')?.addEventListener('click',()=>this.closeRepresentativeImage());
      $('chapterImageDialog')?.addEventListener('cancel',e=>{e.preventDefault();this.closeRepresentativeImage();});
    }
    current(){return this.store.records.get(this.selected);}
    imageRetentionCount(){
      const value=Math.max(1,Math.min(100,Math.trunc(Number($('chapterImageRetention').value)||10)));
      $('chapterImageRetention').value=String(value);return value;
    }
    async changeImageRetention(){
      const value=this.imageRetentionCount(),previous=this.imageRetentionSessions;
      if(value<previous){
        const affected=[...this.store.records.values()].filter(s=>(s.representativeImageIds?.length||0)>0).sort((a,b)=>b.startedAtMs-a.startedAtMs).slice(value);
        const images=affected.reduce((sum,s)=>sum+(s.representativeImageIds?.length||0),0);
        if(affected.length&&!confirm(`保持数を${value}配信に減らすと、古い${affected.length}配信の代表画像${images}枚を削除します。\nチャプター・イベントログは残ります。続けますか？`)){
          $('chapterImageRetention').value=String(previous);return;
        }
      }
      this.imageRetentionSessions=value;
      try{localStorage.setItem('minkome-image-retention-sessions-v1',String(value));}catch{}
      const result=await this.store.pruneRepresentativeImages(value);
      $('chapterImageStorageStatus').textContent=result.imagesDeleted
        ?`古い${result.sessionsDeleted}配信から代表画像${result.imagesDeleted}枚を削除しました。`
        :`直近${value}配信分の代表画像を保持します。`;
      this.render();
    }
    async deleteCurrentRepresentativeImages(){
      const s=this.current();if(!s?.representativeImageIds?.length||this.active===s.id)return;
      if(!confirm('この配信の代表画像をすべて削除しますか？\nチャプター・イベントログ・生成履歴は残ります。'))return;
      const count=await this.store.deleteRepresentativeImages(s.id);
      $('chapterImageStorageStatus').textContent=count?`この配信の代表画像${count}枚を削除しました。`:'削除する代表画像はありません。';
      this.render();
    }
    clearThumbnailUrls(){
      if(this.thumbnailUrl){URL.revokeObjectURL(this.thumbnailUrl);this.thumbnailUrl=null;}
      for(const url of this.thumbnailReferenceUrls)URL.revokeObjectURL(url);
      this.thumbnailReferenceUrls=[];
    }
    async selectThumbnailHistory(){
      const s=this.current();if(!s)return;
      const id=$('thumbnailHistory').value||null;await this.store.selectGeneratedThumbnail(s,id);await this.renderThumbnailPanel();
    }
    async generateThumbnail(key,signal){
      const s=this.current(),T=root.LiveThumbnails;if(!s)return;
      if(this.active===s.id)throw new Error('実況終了後にサムネを生成してください。');
      const referenceImageIds=T.selectReferenceIds(s,this.generationId);
      if(!referenceImageIds.length)throw new Error('サムネ生成に使える代表画像がありません。');
      const images=(await Promise.all(referenceImageIds.map(id=>this.store.image(id)))).filter(Boolean);
      if(!images.length)throw new Error('代表画像を読み込めませんでした。');
      const includeText=$('thumbnailTextEnabled').checked,caption=$('thumbnailText').value.trim();
      if(includeText&&!caption)throw new Error('サムネイルに入れる文字を入力してください。');
      const prompt=T.buildPrompt(s,{generationId:this.generationId,referenceImageIds,includeText,caption});
      $('thumbnailStatus').textContent=`${images.length}枚の代表画像からAIサムネを生成しています…`;
      const result=await C.deadline(t=>T.generate(key,{prompt,images,signal:t}),180000,signal,'サムネ生成がタイムアウトしました。再生成できます。');
      C.check(signal);const id=await this.store.saveGeneratedThumbnail(s,{blob:result.blob,model:result.model,prompt,caption,includeText,referenceImageIds});
      if(!id)throw new Error('生成したサムネイルを端末内に保存できませんでした。');
      $('thumbnailStatus').textContent='サムネイルを生成して履歴に保存しました。';this.log(`AIサムネイルを生成（${images.length}枚参照・${result.model}）。`);
      await this.renderThumbnailPanel();
    }
    async downloadCurrentThumbnail(){
      const s=this.current();if(!s)return;const id=s.selectedThumbnailId||$('thumbnailHistory').value;if(!id)return;
      const record=await this.store.thumbnail(id);if(!record?.blob)return;
      const ext=record.mimeType==='image/jpeg'?'jpg':record.mimeType==='image/webp'?'webp':'png',stamp=new Date(record.createdAtMs).toISOString().replace(/[:.]/g,'-');
      const url=URL.createObjectURL(record.blob),a=document.createElement('a');a.href=url;a.download=`minkome-thumbnail-${stamp}.${ext}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
      $('thumbnailStatus').textContent='選択中のサムネイルを保存しました。';
    }
    async renderThumbnailPanel(){
      const token=++this.thumbnailRenderToken,s=this.current(),T=root.LiveThumbnails,refs=$('thumbnailReferences'),history=$('thumbnailHistory');
      this.clearThumbnailUrls();refs.replaceChildren();history.replaceChildren();$('thumbnailPreview').removeAttribute('src');$('thumbnailPreviewWrap').hidden=true;
      if(!s){$('thumbnailReferenceInfo').textContent='代表画像がある終了済み配信を選択してください。';$('thumbnailHistoryInfo').textContent='';this.controls();return;}
      if(!this.thumbnailTextTouched)$('thumbnailText').value=T.suggestedCaption(s,this.generationId);
      const referenceIds=T.selectReferenceIds(s,this.generationId);
      $('thumbnailReferenceInfo').textContent=referenceIds.length?`${referenceIds.length}枚を生成素材として自動選定しています。`:'サムネ生成に使える代表画像がありません。';
      for(const id of referenceIds){
        const record=await this.store.image(id);if(token!==this.thumbnailRenderToken)return;if(!record?.blob)continue;
        const img=document.createElement('img'),url=URL.createObjectURL(record.blob);this.thumbnailReferenceUrls.push(url);img.src=url;img.alt='サムネ生成に使う代表画像';refs.append(img);
      }
      const records=await this.store.thumbnailsForSession(s.id);if(token!==this.thumbnailRenderToken)return;
      for(const record of records){const option=document.createElement('option');option.value=record.id;option.textContent=`${date(record.createdAtMs)} · ${record.caption||'文字なし'}`;history.append(option);}
      const selected=records.find(x=>x.id===s.selectedThumbnailId)||records[0]||null;
      if(selected){history.value=selected.id;this.thumbnailUrl=URL.createObjectURL(selected.blob);$('thumbnailPreview').src=this.thumbnailUrl;$('thumbnailPreviewWrap').hidden=false;$('thumbnailHistoryInfo').textContent=`${selected.model} · 参照${selected.referenceImageIds?.length||0}枚 · ${selected.includeText?'文字あり':'文字なし'}`;}
      else $('thumbnailHistoryInfo').textContent='まだ生成履歴はありません。';
      this.controls();
    }
    setBusy(value){this.busy=value;this.controls();}
    controls(){const s=this.current(),hasThumb=!!s?.selectedThumbnailId||$('thumbnailHistory').options.length>0;$('youtubeSync').disabled=this.busy||!(s?.generations.length||s?.youtubeSync);$('youtubeSync').textContent=s?.youtubeSync?'同期先を変更':'YouTubeと同期';$('youtubeUnlink').disabled=this.busy||!s?.youtubeSync;$('youtubeResync').disabled=this.busy||!s?.youtubeSync;$('chapterGenerate').disabled=this.busy||this.generating||!s?.events.length;$('chapterAuto').disabled=this.busy;$('chapterSession').disabled=this.busy||this.generating;$('chapterGeneration').disabled=this.busy||this.generating;$('chapterImageRetention').disabled=this.busy;$('chapterImagesDelete').disabled=this.busy||!s?.representativeImageIds?.length||this.active===s?.id;$('thumbnailGenerate').disabled=this.busy||!s?.representativeImageIds?.length||this.active===s?.id;$('thumbnailGenerate').textContent=s?.thumbnailIds?.length?'再生成':'サムネを生成';$('thumbnailHistory').disabled=this.busy||!hasThumb;$('thumbnailDownload').disabled=this.busy||!hasThumb;$('thumbnailTextEnabled').disabled=this.busy;$('thumbnailText').disabled=this.busy||!$('thumbnailTextEnabled').checked;this.editor?.controls();}
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
        const events=H.observation(body,frames,contentName),storedEvents=[];
        for(const e of events){const stored={...e,sessionId:s.id,sequence:s.events.length+1};s.events.push(stored);storedEvents.push(stored);}
        if(storedEvents.length){
          void this.store.save(s);
          if(this.selected===s.id)this.render();
          const frame=frames.at(-1);
          const task=this.store.saveRepresentativeImage(s,storedEvents,frame).then(id=>{if(id&&this.selected===s.id)this.render();}).finally(()=>this.pendingImageSaves.delete(task));
          this.pendingImageSaves.add(task);
        }
      }catch(e){if(!this.warnedObservation){this.warnedObservation=true;this.log('チャプター用イベントを記録できない応答がありました。実況は続行します。','warn');$('chapterStatus').textContent='一部の応答にイベント要約がなく、記録を見送りました。以降の解析では記録を続けます。';}}
    }
    async end(reason){
      const s=this.store.records.get(this.active);if(!s)return null;
      if(this.pendingImageSaves.size)await Promise.allSettled([...this.pendingImageSaves]);
      this.active=null;s.endedAtMs=Date.now();s.status=reason;await this.store.save(s);
      const pruned=await this.store.pruneRepresentativeImages(this.imageRetentionSessions);
      if(pruned.imagesDeleted)$('chapterImageStorageStatus').textContent=`保存配信数を超えたため、古い${pruned.sessionsDeleted}配信から代表画像${pruned.imagesDeleted}枚を削除しました。`;
      $('chapterStatus').textContent=s.events.length?'イベントの記録を終了しました。生成・再生成できます。':'記録を終了しました。生成に使えるイベントはありません。';this.render();return s.id;
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
      $('chapterSessionInfo').textContent=s?`${states[s.status]||'保存済み'} · ${date(s.startedAtMs)} ～ ${date(s.endedAtMs)} · イベント ${s.events.length}件 · 代表画像 ${s.representativeImageIds?.length||0}枚 · サムネ ${s.thumbnailIds?.length||0}件`:'実況を開始すると、ここに記録が蓄積されます。';
      const sync=s?.youtubeSync;
      $('youtubeSyncInfo').textContent=sync?`YouTube: ${sync.title} (${sync.videoId}) · ${Number.isFinite(sync.actualStartTimeMs)?'同期済み · 実際の開始 '+date(sync.actualStartTimeMs):'未同期 · 実際の開始時刻は未取得'} · 実際の終了 ${date(sync.actualEndTimeMs)}${sync.syncError?' · '+sync.syncError:''}`:'YouTube連携なし（絶対日時で表示）';
      const genSelect=$('chapterGeneration');genSelect.replaceChildren();
      for(const g of [...s?.generations||[]].reverse()){
        const option=document.createElement('option');option.value=g.id;option.textContent=`${date(g.createdAtMs)} · ${g.chapters.length}件`;genSelect.append(option);
      }
      if(!s?.generations.some(g=>g.id===this.generationId))this.generationId=s?.generations.at(-1)?.id||null;
      if(this.generationId)genSelect.value=this.generationId;
      const generation=s?.generations.find(g=>g.id===this.generationId);
      this.editor.render(s,generation);
      this.renderEvents();void this.renderThumbnailPanel();this.controls();
    }
    showEvent(id){
      const events=[...this.current()?.events||[]].reverse(),index=events.findIndex(e=>e.id===id);if(index<0)return;
      this.page=Math.floor(index/100);this.renderEvents();$('chapterEventsSection').open=true;
      const target=document.getElementById(`chapter-event-${id}`);target?.scrollIntoView({block:'nearest'});target?.focus({preventScroll:true});
    }
    renderEvents(){
      const events=[...this.current()?.events||[]].reverse(),pages=Math.max(1,Math.ceil(events.length/100));this.page=Math.max(0,Math.min(this.page,pages-1));
      $('chapterEventCount').textContent=`元イベントログ（${events.length}件）`;
      $('chapterPage').textContent=`${this.page+1} / ${pages} ページ（新しい順）`;$('chapterPrev').disabled=this.page===0;$('chapterNext').disabled=this.page+1>=pages;
      const list=$('chapterEvents');list.replaceChildren();
      for(const event of events.slice(this.page*100,(this.page+1)*100)){
        const item=document.createElement('li'),copy=document.createElement('div'),time=document.createElement('time'),text=document.createElement('p'),kind=document.createElement('small');
        item.id=`chapter-event-${event.id}`;item.tabIndex=-1;item.className='chapter-event-item';copy.className='chapter-event-copy';
        time.dateTime=new Date(event.observedAtMs).toISOString();time.textContent=date(event.observedAtMs)+(this.current()?.youtubeSync?' → '+(root.LiveYouTube.relative(event.observedAtMs,this.current().youtubeSync)??'未同期'):'');
        kind.textContent=`${names[event.kind]||event.kind} · ${event.contentName||'対象なし'}`;text.textContent=event.summary;copy.append(time,kind,text);item.append(copy);
        if(event.imageId){
          item.classList.add('has-image');
          const button=document.createElement('button');button.type='button';button.className='chapter-event-thumb';button.textContent='画像';button.setAttribute('aria-label','代表画像を表示');
          button.addEventListener('click',()=>void this.showRepresentativeImage(event));item.append(button);void this.loadRepresentativeThumbnail(event.imageId,button);
        }
        list.append(item);
      }
    }
    async loadRepresentativeThumbnail(imageId,button){
      const record=await this.store.image(imageId);if(!record?.blob||!button.isConnected)return;
      const img=document.createElement('img'),url=URL.createObjectURL(record.blob);img.alt='';
      img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>{URL.revokeObjectURL(url);};
      img.src=url;button.replaceChildren(img);
    }
    async showRepresentativeImage(event){
      const record=await this.store.image(event.imageId),dialog=$('chapterImageDialog');if(!record?.blob||!dialog)return;
      if(this.imageDialogUrl)URL.revokeObjectURL(this.imageDialogUrl);
      this.imageDialogUrl=URL.createObjectURL(record.blob);$('chapterImagePreview').src=this.imageDialogUrl;
      $('chapterImageInfo').textContent=`${date(event.observedAtMs)} · ${names[event.kind]||event.kind} · ${event.summary}`;
      if(!dialog.open)dialog.showModal();
    }
    closeRepresentativeImage(){
      const dialog=$('chapterImageDialog');if(dialog?.open)dialog.close();
      $('chapterImagePreview')?.removeAttribute('src');
      if(this.imageDialogUrl){URL.revokeObjectURL(this.imageDialogUrl);this.imageDialogUrl=null;}
    }
  }
  root.LiveChapterUI=ChapterUI;
})(globalThis);
