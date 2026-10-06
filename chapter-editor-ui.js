(function(root){
  'use strict';
  const E=root.LiveChapterEditor,$=id=>document.getElementById(id);
  const date=ms=>new Date(ms).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const localTime=ms=>new Date(ms-new Date(ms).getTimezoneOffset()*60000).toISOString().slice(0,-1);
  class ChapterEditorUI{
    constructor(owner){
      this.owner=owner;this.undo=null;this.editing=null;
      $('chapterAdd').addEventListener('click',()=>this.open());
      $('chapterReset').addEventListener('click',()=>{
        if(!this.available()||!confirm('この生成履歴の編集・追加・削除を取り消し、AIの生成結果に戻しますか？'))return;
        E.reset(this.session,this.generation);this.undo=null;this.persist('元の生成結果に戻しました。');
      });
      $('chapterUndoDelete').addEventListener('click',()=>{
        if(!this.available()||!this.matchesUndo())return;
        E.restore(this.session,this.generation,this.undo.item);this.undo=null;this.persist('削除したチャプターを戻しました。');
      });
      const intro=()=>{
        if(!this.available())return;
        const draft=E.draft(this.session,this.generation);draft.introEnabled=$('chapterIntro').checked;draft.introTitle=$('chapterIntroTitle').value;
        E.save(this.session,this.generation,draft);void this.owner.store.save(this.session);this.renderExport();this.controls();
      };
      $('chapterIntro').addEventListener('change',intro);$('chapterIntroTitle').addEventListener('input',intro);
      $('chapterCopy').addEventListener('click',()=>void this.copy());
      $('chapterSelectText').addEventListener('click',()=>this.selectText());
      $('chapterEditCancel').addEventListener('click',()=>$('chapterEditDialog').close());
      $('chapterEditDialog').addEventListener('close',()=>{this.editing=null;});
      $('chapterTimeMode').addEventListener('change',()=>{
        try{this.setTime($('chapterTimeMode').value,this.readTime());$('chapterEditError').textContent='';}
        catch(e){$('chapterTimeMode').value=this.mode;$('chapterEditError').textContent=e.message;}
      });
      $('chapterEditTime').addEventListener('input',()=>this.timePreview());
      $('chapterEditForm').addEventListener('submit',event=>{
        event.preventDefault();if(!this.available()||!this.editing)return;
        try{
          E.edit(this.session,this.generation,this.editing.id,{title:$('chapterEditTitle').value,atMs:this.readTime()});
          $('chapterEditDialog').close();this.persist('編集内容を保存しました。');
        }catch(e){$('chapterEditError').textContent=e.message;}
      });
    }
    available(){return !!this.generation&&!this.owner.busy&&!this.owner.generating;}
    matchesUndo(){return this.undo?.sessionId===this.session?.id&&this.undo?.generationId===this.generation?.id;}
    controls(){
      const disabled=!this.available();
      for(const id of ['chapterAdd','chapterIntro','chapterReset','chapterUndoDelete'])$(id).disabled=disabled;
      $('chapterReset').disabled=disabled||!this.session?.chapterEdits?.some(x=>x.generationId===this.generation?.id);
      $('chapterIntroTitle').disabled=disabled||!$('chapterIntro').checked;
      for(const button of $('chapterCandidates').querySelectorAll('[data-edit-action]'))button.disabled=disabled;
      $('chapterCopy').disabled=disabled||!this.output?.canCopy;
      $('chapterSelectText').disabled=disabled||!this.output?.canCopy;
      $('chapterUndoDelete').hidden=!this.matchesUndo();
    }
    persist(message){void this.owner.store.save(this.session);this.owner.render();$('chapterEditStatus').textContent=message;}
    render(session,generation){
      this.session=session;this.generation=generation;
      const draft=E.draft(session,generation),list=$('chapterCandidates');list.replaceChildren();
      $('chapterEditStatus').textContent='';
      $('chapterCandidateEmpty').hidden=!!draft.chapters.length;
      $('chapterCandidateEmpty').textContent=generation?'チャプターがありません。「チャプターを追加」で追加できます。':'生成されたチャプター候補がここに表示されます。';
      for(const chapter of [...draft.chapters].sort((a,b)=>a.atMs-b.atMs)){
        const item=document.createElement('li'),time=document.createElement('time'),name=document.createElement('strong'),actions=document.createElement('div');
        item.dataset.chapterId=chapter.id;actions.className='actions wrap';
        time.dateTime=new Date(chapter.atMs).toISOString();time.textContent=date(chapter.atMs)+(session.youtubeSync?' → '+(root.LiveYouTube.relative(chapter.atMs,session.youtubeSync)??'未同期'):'');
        name.textContent=chapter.title;item.append(time,name);
        if(chapter.editedAtMs!=null){const note=document.createElement('small');note.textContent=chapter.sourceChapterId?`編集済み · 元の観測日時 ${date(chapter.originalObservedAtMs)}`:'手動で追加';item.append(note);}
        const button=(label,fn,edit=true)=>{const el=document.createElement('button');el.type='button';el.className='subtle';el.textContent=label;if(edit)el.dataset.editAction='';el.addEventListener('click',fn);actions.append(el);};
        button('編集',()=>this.open(chapter.id));
        button('削除',()=>{
          if(!this.available())return;
          this.undo={sessionId:session.id,generationId:generation.id,item:E.remove(session,generation,chapter.id)};this.persist('チャプターを削除しました。「直前の削除を戻す」で取り消せます。');
        });
        if(chapter.sourceEventId)button('元イベントを見る',()=>this.owner.showEvent(chapter.sourceEventId),false);
        item.append(actions);list.append(item);
      }
      $('chapterIntro').checked=draft.introEnabled;$('chapterIntroTitle').value=draft.introTitle;
      this.renderExport();this.controls();
    }
    renderExport(){
      this.output=E.exportText(this.session,this.generation);const output=this.output;
      $('chapterOutput').value=output.text;$('chapterCopyStatus').textContent='';
      $('chapterExportStatus').textContent=output.errors.length?'修正・同期が必要です。':output.warnings.length?'確認事項があります。テキストはコピーできます。':'YouTube貼り付け用テキストを生成しました。';
      const notes=$('chapterExportNotes');notes.replaceChildren();
      for(const [kind,text] of [...output.errors.map(t=>['error',t]),...output.warnings.map(t=>['warning',t]),...output.excluded.map(x=>['warning',`${x.reason}: ${x.title}`])]){
        const li=document.createElement('li');li.dataset.kind=kind;li.textContent=text;notes.append(li);
      }
      $('chapterIntroAdded').hidden=!output.introAdded;this.controls();
    }
    open(id=null){
      if(!this.available())return;
      const draft=E.draft(this.session,this.generation),item=id?draft.chapters.find(c=>c.id===id):null;
      if(id&&!item)return;
      const start=this.session.youtubeSync?.actualStartTimeMs;
      const atMs=item?.atMs??(draft.chapters.length?Math.max(...draft.chapters.map(c=>c.atMs))+10000:start??this.session.startedAtMs);
      this.editing={id,start};$('chapterEditDialogTitle').textContent=id?'チャプターを編集':'チャプターを追加';
      $('chapterEditTitle').value=item?.title||'';$('chapterEditError').textContent='';
      $('chapterOriginalTime').textContent=item?.sourceChapterId?`元の観測日時: ${date(item.originalObservedAtMs)}（元イベント・生成履歴に保持）`:'手動で追加するチャプターです。';
      const relative=$('chapterTimeMode').querySelector('[value="relative"]');relative.disabled=!Number.isFinite(start);
      this.setTime(Number.isFinite(start)?'relative':'absolute',atMs);
      $('chapterEditDialog').showModal();$('chapterEditTitle').focus();
    }
    setTime(mode,atMs){
      this.mode=mode;this.atMs=atMs;$('chapterTimeMode').value=mode;
      const input=$('chapterEditTime');input.type=mode==='relative'?'text':'datetime-local';
      input.step='0.001';input.placeholder=mode==='relative'?'12:34 または 1:02:34':'';
      const diff=atMs-this.editing.start,fraction=Math.abs(diff)%1000;
      this.timeValue=mode==='relative'?E.formatTime(diff/1000)+(fraction?'.'+String(fraction).padStart(3,'0'):''):localTime(atMs);
      input.value=this.timeValue;this.timeValue=input.value;this.timePreview();
    }
    readTime(){
      const input=$('chapterEditTime');if(input.value===this.timeValue)return this.atMs;
      if(this.mode==='relative')return this.editing.start+E.parseTime(input.value);
      const atMs=new Date(input.value).getTime();
      if(!Number.isFinite(atMs))throw new Error('日時を入力してください。');return atMs;
    }
    timePreview(){
      try{$('chapterTimePreview').textContent=`保存する日時: ${date(this.readTime())}`;}
      catch{$('chapterTimePreview').textContent='日時・時刻を確認してください。';}
    }
    selectText(){const el=$('chapterOutput');el.focus();el.select();el.setSelectionRange(0,el.value.length);}
    async copy(){
      if(!this.available())return;this.renderExport();if(!this.output.canCopy)return;
      const text=this.output.text,sessionId=this.session.id,generationId=this.generation.id;let copied=false;
      try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);copied=true;}}catch{}
      // Do not select or report a different session if the user switched while permission was pending.
      if(this.session?.id!==sessionId||this.generation?.id!==generationId||this.output.text!==text)return;
      if(!copied){this.selectText();try{copied=!!document.execCommand('copy');}catch{}}
      $('chapterCopyStatus').textContent=copied?'コピーしました。YouTubeの説明欄に貼り付けてください。':'自動コピーできませんでした。テキストを選択したので、コピー操作（Ctrl+C／長押し）をしてください。';
    }
  }
  root.LiveChapterEditorUI=ChapterEditorUI;
})(globalThis);
