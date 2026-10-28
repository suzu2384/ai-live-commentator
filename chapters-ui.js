(function(root){
  'use strict';
  const H=root.LiveChapters,C=root.LiveCore,$=id=>document.getElementById(id);
  const date=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
  const names={scene:'場面',progress:'進行',battle:'戦闘',result:'結果',menu:'メニュー',other:'その他'};
  class ChapterUI{
    constructor({log,onGenerate,onSelectTab,onSync,onResync,onUnlink}){
      this.log=log;this.onSelectTab=onSelectTab;this.active=null;this.selected=null;this.busy=false;this.generating=false;this.page=0;this.generationId=null;this.view='chapters';this.warnedObservation=false;this.imageDialogUrl=null;this.imageRetentionSessions=10;this.pendingImageSaves=new Set();this.thumbnailReferenceUrls=[];this.thumbnailPickerUrls=[];this.thumbnailRenderToken=0;this.thumbnailTextTouched=false;
      try{const stored=Number(localStorage.getItem('minkome-image-retention-sessions-v1'));if(Number.isInteger(stored)&&stored>=1&&stored<=100)this.imageRetentionSessions=stored;}catch{} $('chapterImageRetention').value=String(this.imageRetentionSessions);this.store=new H.Store(()=>{$('chapterStorageWarning').hidden=false;});
      this.ready=this.store.ready.then(async()=>{await this.store.pruneRepresentativeImages(this.imageRetentionSessions);this.selected=[...this.store.records.values()].sort((a,b)=>b.startedAtMs-a.startedAtMs)[0]?.id||null;$('chapterStatus').textContent=this.selected?'保存済みの記録を復元しました。生成・再生成できます。':'イベントを蓄積すると生成できます。';this.render();});
      try{$('chapterAuto').checked=localStorage.getItem('minkome-chapter-auto-v1')!=='false';}catch{}
      $('chapterAuto').addEventListener('change',()=>{try{localStorage.setItem('minkome-chapter-auto-v1',String($('chapterAuto').checked));}catch{}});
      const viewButtons=[...document.querySelectorAll('[data-chapter-view]')];
      for(const button of viewButtons){
        button.addEventListener('click',()=>this.selectView(button.dataset.chapterView));
        button.addEventListener('keydown',event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();const current=viewButtons.indexOf(button);
          const next=event.key==='Home'?0:event.key==='End'?viewButtons.length-1:(current+(event.key==='ArrowRight'?1:-1)+viewButtons.length)%viewButtons.length;
          this.selectView(viewButtons[next].dataset.chapterView,true);
        });
      }
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
      $('thumbnailAutoSelect').addEventListener('click',()=>void this.autoSelectThumbnailMaterials());
      $('thumbnailPickerDetails').addEventListener('toggle',()=>{if($('thumbnailPickerDetails').open)void this.renderThumbnailPicker();});
      $('thumbnailText').addEventListener('input',()=>{this.thumbnailTextTouched=true;this.updateThumbnailPrompt();});
      $('thumbnailTextEnabled').addEventListener('change',()=>{this.controls();this.updateThumbnailPrompt();});
      $('thumbnailCopyPrompt').addEventListener('click',()=>void this.copyThumbnailPrompt());
      $('thumbnailDownloadPackage').addEventListener('click',()=>void this.downloadThumbnailPackage());
      this.editor=new root.LiveChapterEditorUI(this);
      $('chapterImageClose')?.addEventListener('click',()=>this.closeRepresentativeImage());
      $('chapterImageDialog')?.addEventListener('cancel',e=>{e.preventDefault();this.closeRepresentativeImage();});
      this.selectView('chapters');
    }
    current(){return this.store.records.get(this.selected);}
    selectView(view,focus=false){
      const button=document.querySelector(`[data-chapter-view="${view}"]`);if(!button)return;
      this.view=view;
      for(const item of document.querySelectorAll('[data-chapter-view]')){
        const selected=item===button;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;
      }
      for(const section of document.querySelectorAll('[data-chapter-section]'))section.hidden=section.dataset.chapterSection!==view;
      if(focus)button.focus();
      if(view==='records')this.renderEvents();
      if(view==='thumbnail')void this.renderThumbnailPanel();
    }
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
      if(!confirm('この配信の代表画像をすべて削除しますか？\nチャプター・イベントログは残ります。ChatGPT用素材の選択は解除されます。'))return;
      const count=await this.store.deleteRepresentativeImages(s.id);
      $('chapterImageStorageStatus').textContent=count?`この配信の代表画像${count}枚を削除しました。`:'削除する代表画像はありません。';
      this.render();
    }
    clearThumbnailUrls(){
      for(const url of this.thumbnailReferenceUrls)URL.revokeObjectURL(url);
      for(const url of this.thumbnailPickerUrls)URL.revokeObjectURL(url);
      this.thumbnailReferenceUrls=[];this.thumbnailPickerUrls=[];
    }
    async thumbnailMaterialIds(){
      const s=this.current(),T=root.LiveThumbnailMaterials;if(!s)return [];
      const ids=T.selectedReferenceIds(s,this.generationId);
      if(s.thumbnailMaterialMode!=='manual'){
        const previous=JSON.stringify(s.thumbnailMaterialImageIds||[]);
        s.thumbnailMaterialMode='auto';s.thumbnailMaterialImageIds=[...ids];
        if(previous!==JSON.stringify(ids))await this.store.save(s);
      }
      return ids;
    }
    updateThumbnailPrompt(ids=null){
      const s=this.current(),T=root.LiveThumbnailMaterials;if(!s)return;
      const selected=ids||T.selectedReferenceIds(s,this.generationId),includeText=$('thumbnailTextEnabled').checked,caption=$('thumbnailText').value.trim();
      $('thumbnailPrompt').value=T.buildPrompt(s,{generationId:this.generationId,referenceImageIds:selected,includeText,caption});
    }
    async autoSelectThumbnailMaterials(){
      const s=this.current(),T=root.LiveThumbnailMaterials;if(!s||this.active===s.id)return;
      s.thumbnailMaterialMode='auto';s.thumbnailMaterialImageIds=T.selectReferenceIds(s,this.generationId);await this.store.save(s);
      $('thumbnailStatus').textContent=s.thumbnailMaterialImageIds.length?`${s.thumbnailMaterialImageIds.length}枚を自動選別しました。`:'選別できる代表画像がありません。';
      await this.renderThumbnailPanel();if($('thumbnailPickerDetails').open)await this.renderThumbnailPicker();
    }
    async changeThumbnailMaterial(id,checked,input){
      const s=this.current(),T=root.LiveThumbnailMaterials;if(!s||this.active===s.id)return;
      const current=T.selectedReferenceIds(s,this.generationId);
      if(checked&&!current.includes(id)&&current.length>=T.MAX_REFERENCES){
        input.checked=false;$('thumbnailStatus').textContent=`素材は最大${T.MAX_REFERENCES}枚です。別の画像を外してから選んでください。`;return;
      }
      if(!checked&&current.includes(id)&&current.length<=1){
        input.checked=true;$('thumbnailStatus').textContent='素材は1枚以上選んでください。';return;
      }
      let next=checked?[...current,id]:current.filter(x=>x!==id);
      next=T.validSelection(s,next);
      s.thumbnailMaterialMode='manual';s.thumbnailMaterialImageIds=next;await this.store.save(s);
      $('thumbnailStatus').textContent=next.length?`${next.length}枚を手動選択しています。`:'素材が未選択です。「自動選別」で戻せます。';
      await this.renderThumbnailPanel();
    }
    async copyThumbnailPrompt(){
      const text=$('thumbnailPrompt').value;if(!text)return;
      try{await navigator.clipboard.writeText(text);$('thumbnailStatus').textContent='ChatGPTへの依頼文をコピーしました。';}
      catch{const prompt=$('thumbnailPrompt'),details=prompt.closest('details');if(details)details.open=true;prompt.focus();prompt.select();$('thumbnailStatus').textContent='コピーできなかったため依頼文を表示して選択しました。Ctrl+Cでコピーしてください。';}
    }
    async downloadThumbnailPackage(){
      const s=this.current(),T=root.LiveThumbnailMaterials;if(!s||this.active===s.id)return;
      const ids=await this.thumbnailMaterialIds();if(!ids.length){$('thumbnailStatus').textContent='保存する素材画像を1枚以上選んでください。';return;}
      const images=(await Promise.all(ids.map(id=>this.store.image(id)))).filter(Boolean);
      if(!images.length){$('thumbnailStatus').textContent='選択した代表画像を読み込めませんでした。';return;}
      try{
        const blob=await T.buildPackage({images,prompt:$('thumbnailPrompt').value,session:s}),url=URL.createObjectURL(blob),a=document.createElement('a');
        const stamp=new Date(s.startedAtMs||Date.now()).toISOString().slice(0,10).replaceAll('-','');
        a.href=url;a.download=`minkome-chatgpt-thumbnail-materials-${stamp}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
        $('thumbnailStatus').textContent=`選択画像${images.length}枚と依頼文をZIPに保存しました。`;this.log(`ChatGPT用サムネ素材 ${images.length}枚を保存。`);
      }catch(e){$('thumbnailStatus').textContent=e.message||'ChatGPT用素材を保存できませんでした。';}
    }
    async renderThumbnailPanel(){
      const token=++this.thumbnailRenderToken,s=this.current(),T=root.LiveThumbnailMaterials,refs=$('thumbnailReferences');
      for(const url of this.thumbnailReferenceUrls)URL.revokeObjectURL(url);this.thumbnailReferenceUrls=[];refs.replaceChildren();
      if(!s){$('thumbnailReferenceInfo').textContent='代表画像がある終了済み配信を選択してください。';$('thumbnailPrompt').value='';this.controls();return;}
      if(!this.thumbnailTextTouched)$('thumbnailText').value=T.suggestedCaption(s,this.generationId);
      const ids=await this.thumbnailMaterialIds();if(token!==this.thumbnailRenderToken)return;
      for(const id of ids){
        const record=await this.store.image(id);if(token!==this.thumbnailRenderToken)return;if(!record?.blob)continue;
        const card=document.createElement('div'),img=document.createElement('img'),meta=document.createElement('span'),url=URL.createObjectURL(record.blob),info=T.imageInfo(s,id,this.generationId);
        card.className='thumbnail-reference-card';img.src=url;img.alt='ChatGPT用に選択した代表画像';meta.textContent=`${names[info.kind]||info.kind} · ${info.summary}`;
        this.thumbnailReferenceUrls.push(url);card.append(img,meta);refs.append(card);
      }
      const mode=s.thumbnailMaterialMode==='manual'?'手動選択':'自動選別';
      $('thumbnailReferenceInfo').textContent=ids.length?`${mode}で${ids.length}枚を選択中です。ZIPには元画質の画像と依頼文を保存します。`:'サムネ素材に使える代表画像がありません。';
      this.updateThumbnailPrompt(ids);this.controls();
      if($('thumbnailPickerDetails').open)void this.renderThumbnailPicker();
    }
    async renderThumbnailPicker(){
      const token=this.thumbnailRenderToken,s=this.current(),T=root.LiveThumbnailMaterials,picker=$('thumbnailPicker');picker.replaceChildren();
      for(const url of this.thumbnailPickerUrls)URL.revokeObjectURL(url);this.thumbnailPickerUrls=[];
      if(!s?.representativeImageIds?.length){picker.textContent='代表画像がありません。';return;}
      const selected=new Set(T.selectedReferenceIds(s,this.generationId)),records=await this.store.imagesForSession(s.id);if(token!==this.thumbnailRenderToken)return;
      for(const record of records){
        const label=document.createElement('label'),input=document.createElement('input'),img=document.createElement('img'),copy=document.createElement('span'),title=document.createElement('strong'),summary=document.createElement('small');
        const info=T.imageInfo(s,record.id,this.generationId),url=URL.createObjectURL(record.blob);this.thumbnailPickerUrls.push(url);
        label.className='thumbnail-picker-card';label.classList.toggle('selected',selected.has(record.id));input.type='checkbox';input.checked=selected.has(record.id);input.disabled=this.busy||this.active===s.id;
        img.src=url;img.alt='代表画像';title.textContent=`${date(record.capturedAtMs)} · ${names[info.kind]||info.kind}${info.isChapter?' · チャプター':''}`;summary.textContent=info.summary||'代表画像';copy.append(title,summary);label.append(input,img,copy);
        input.addEventListener('change',async()=>{await this.changeThumbnailMaterial(record.id,input.checked,input);label.classList.toggle('selected',input.checked);});
        picker.append(label);
      }
    }
    setBusy(value){this.busy=value;this.controls();}
    controls(){const s=this.current(),T=root.LiveThumbnailMaterials,ids=s?T.selectedReferenceIds(s,this.generationId):[],usable=!!s&&this.active!==s.id&&ids.length>0;$('youtubeSync').disabled=this.busy||!(s?.generations.length||s?.youtubeSync);$('youtubeSync').textContent=s?.youtubeSync?'同期先を変更':'YouTubeと同期';$('youtubeUnlink').disabled=this.busy||!s?.youtubeSync;$('youtubeResync').disabled=this.busy||!s?.youtubeSync;$('chapterGenerate').disabled=this.busy||this.generating||!s?.events.length;$('chapterAuto').disabled=this.busy;$('chapterSession').disabled=this.busy||this.generating;$('chapterGeneration').disabled=this.busy||this.generating;$('chapterImageRetention').disabled=this.busy;$('chapterImagesDelete').disabled=this.busy||!s?.representativeImageIds?.length||this.active===s?.id;$('thumbnailAutoSelect').disabled=this.busy||!s?.representativeImageIds?.length||this.active===s?.id;$('thumbnailCopyPrompt').disabled=this.busy||!usable;$('thumbnailDownloadPackage').disabled=this.busy||!usable;$('thumbnailTextEnabled').disabled=this.busy||!s||this.active===s?.id;$('thumbnailText').disabled=this.busy||!s||this.active===s?.id||!$('thumbnailTextEnabled').checked;this.editor?.controls();}
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
       s.youtubeSync=sync;this.thumbnailTextTouched=false;await this.store.save(s);this.render();
    }
    async unlinkYouTube(signal){
      C.check(signal);const s=this.current();if(!s)return;
       s.youtubeSync=null;this.thumbnailTextTouched=false;await this.store.save(s);this.render();
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
      this.selected=s.id;this.generating=true;this.selectView('chapters');this.render();this.onSelectTab();
      try{
        const generation=await H.generate(s,{signal,model:key===C.EMBEDDED_CREDENTIAL?root.MINKOME_AI_CONFIG?.model:C.MODEL,onProgress:text=>{$('chapterStatus').textContent=text;},request:async(payload,token)=>{
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
      $('chapterSessionInfo').textContent=s?`${states[s.status]||'保存済み'} · イベント ${s.events.length}件 · 代表画像 ${s.representativeImageIds?.length||0}枚`:'実況を開始すると、ここに記録が蓄積されます。';
      const sync=s?.youtubeSync;
      $('youtubeSyncInfo').textContent=sync?`${sync.title} · ${Number.isFinite(sync.actualStartTimeMs)?'同期済み / 開始 '+date(sync.actualStartTimeMs):'動画選択済み / 開始時刻未取得'}${sync.syncError?' · '+sync.syncError:''}`:'未同期。動画を選ぶと説明欄用の相対時刻を作成できます。';
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
      this.page=Math.floor(index/100);this.selectView('records');this.renderEvents();$('chapterEventsSection').open=true;
      requestAnimationFrame(()=>{const target=document.getElementById(`chapter-event-${id}`);target?.scrollIntoView({block:'nearest'});target?.focus({preventScroll:true});});
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
