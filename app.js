(function () {
  'use strict';
  const C = LiveCore, $ = id => document.getElementById(id);
  const storageKey = 'ai-live-commentator-browser-v1';
  const contentLibraryKey = 'ai-live-commentator-content-library-v1';
  const contentKnowledgeKey = 'ai-live-commentator-content-knowledge-v1';
  const greetingHistoryKey = 'ai-live-commentator-greeting-history-v1';
  const fontLibraryKey = 'ai-live-commentator-font-library-v1';
  const settingsExportFormat = 'minkome-settings';
  const settingsExportVersion = 1;
  const obsOverlaySourceName='みんコメ 吹き出し';
  const legacyObsOverlaySourceName='みんコメ コメント';
  const obsOverlayColors=['#2e7fa3','#a93b6b','#3f7f46','#b47420','#6549a7','#a8443b'];
  const savedIds = ['theme','obsUrl','sourceName','obsOverlayEnabled','obsOverlayPosition','obsOverlayFont','obsOverlayFontSize','obsOverlayShowName','obsOverlayBold','obsOverlayHold','output','bouyomiUrl','voicevoxUrl','talkativeness','persona','conversationHistoryCount','apiInterval','speechInterval','quietInterval','freshness','sampleInterval','imageWidth','analysisFrameCount','speakerWeight1','speakerWeight2','speakerWeight3','speakerWeight4','speakerWeight5','speakerWeight6','greetStart','greetEnd'];
  const themes={
    midnight:{scheme:'dark',color:'#0d151c'},
    graphite:{scheme:'dark',color:'#17191c'},
    aurora:{scheme:'dark',color:'#111326'},
    crimson:{scheme:'dark',color:'#1b1014'},
    forest:{scheme:'dark',color:'#0f1813'},
    amber:{scheme:'dark',color:'#1b1710'},
    mist:{scheme:'light',color:'#f2f3f4'},
    lavender:{scheme:'light',color:'#f3f0fb'},
    rose:{scheme:'light',color:'#fbf0f3'},
    sage:{scheme:'light',color:'#eef5ef'},
    daylight:{scheme:'light',color:'#f3f6f9'},
    sand:{scheme:'light',color:'#f3ede3'}
  };
  function applyTheme(value){
    const theme=Object.hasOwn(themes,value)?value:'midnight',config=themes[theme];
    document.documentElement.dataset.theme=theme;
    document.documentElement.style.colorScheme=config.scheme;
    document.querySelector('meta[name="theme-color"]').content=config.color;
    $('theme').value=theme;
    return theme;
  }
  function persistTheme(){
    const theme=applyTheme($('theme').value);
    try{
      const stored=JSON.parse(localStorage.getItem(storageKey)||'{}');
      const data=stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{};
      data.theme=theme;localStorage.setItem(storageKey,JSON.stringify(data));
    }catch{}
  }
  $('theme').addEventListener('change',persistTheme);
  const numberRules = { talkativeness:[0,2], conversationHistoryCount:[0,20], apiInterval:[30,600], speechInterval:[15,600], quietInterval:[30,600], freshness:[5,180], sampleInterval:[1,60], imageWidth:[320,960], analysisFrameCount:[2,6], obsOverlayFontSize:[20,72], obsOverlayHold:[0,30], speakerWeight1:[0,999], speakerWeight2:[0,999], speakerWeight3:[0,999], speakerWeight4:[0,999], speakerWeight5:[0,999], speakerWeight6:[0,999] };
  let controller = null, obs = null, audioContext = null, activeAudio = null, wakeLock = null;
  let obsOverlayTimer=null,obsOverlayEpoch=0,obsOverlayFaulted=false,obsOverlayTarget=null;
  let phaseAt = performance.now(), lastCaptureAt = null, busy = false, lastSettings = null;
  const stats = { used:0, stale:0 };
  let resumeAction=null, finishAction=null, streaming=false, vaultBusy=false, pageEpoch=0;
  let obsSourceFailurePending=false,obsSourceRecoveryReady=false;
  const speakerSessionCounts=Object.fromEntries(Array.from({length:6},(_,i)=>[`p${i+1}`,0]));
  let activeSpeakerId=null,lastSpeakerId=null,activeSpeakerMode='';
  function log(message, kind='') {
    const li = document.createElement('li'), time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ja-JP'); li.className = kind;
    li.append(time, document.createTextNode(message)); $('log').prepend(li);
    while ($('log').children.length > 160) $('log').lastElementChild.remove();
  }
  function setStatus(text, error=false) { $('status').textContent = text; phaseAt = performance.now(); $('stateDot').className = 'dot' + (error ? ' error' : busy ? ' running' : ''); }
  function updateStats() { $('usage').textContent = `${stats.used} 回`; $('staleCount').textContent = stats.stale; }
  function speakerProfilesForDisplay(){
    if(streaming&&Array.isArray(lastSettings?.profiles)&&lastSettings.profiles.length)return lastSettings.profiles.map(({id,name})=>({id,name}));
    const selected=new Set(selectedProfileIds());
    return Array.from({length:6},(_,i)=>{const id=`p${i+1}`;return {id,name:$(`${id}-name`)?.value.trim()||`友達${i+1}`};}).filter(p=>selected.has(p.id));
  }
  function renderSpeakerStats(){
    const root=$('speakerStatsList'),donut=$('speakerStatsDonut');if(!root||!donut)return;
    const profiles=speakerProfilesForDisplay(),total=profiles.reduce((sum,p)=>sum+(speakerSessionCounts[p.id]||0),0);
    $('speakerStatsTotal').textContent=String(total);
    root.classList.toggle('two-columns',profiles.length>3);
    root.replaceChildren();
    const segments=[];let angle=0;
    for(const profile of profiles){
      const count=speakerSessionCounts[profile.id]||0,percent=total?Math.round(count*100/total):0;
      const index=Math.max(0,Math.min(5,Number(profile.id.slice(1))-1)),color=`var(--friend-${index+1})`;
      if(total&&count){
        const next=angle+count/total*360;segments.push(`${color} ${angle.toFixed(2)}deg ${next.toFixed(2)}deg`);angle=next;
      }
      const row=document.createElement('div');row.className='speaker-stat-row';row.dataset.speakerId=profile.id;row.style.setProperty('--speaker-color',color);
      if(activeSpeakerId===profile.id)row.classList.add('active');
      else if(lastSpeakerId===profile.id&&count>0)row.classList.add('recent');
      const main=document.createElement('div');main.className='speaker-stat-main';
      const dot=document.createElement('span');dot.className='speaker-stat-dot';dot.setAttribute('aria-hidden','true');
      const name=document.createElement('strong');name.className='speaker-stat-name';name.textContent=profile.name;
      const state=document.createElement('span');state.className='speaker-stat-state';
      state.textContent=activeSpeakerId===profile.id?(activeSpeakerMode||'発話中'):(lastSpeakerId===profile.id&&count>0?'直近':'待機');
      main.append(dot,name,state);
      const value=document.createElement('span');value.className='speaker-stat-value';value.textContent=`${count}回 · ${percent}%`;
      row.append(main,value);root.append(row);
    }
    donut.style.background=total?`conic-gradient(${segments.join(',')})`:'var(--line)';
    donut.setAttribute('aria-label',total
      ?`今回 ${total}発言。 ${profiles.map(p=>{const count=speakerSessionCounts[p.id]||0;return `${p.name} ${count}回 ${Math.round(count*100/total)}%`;}).join('、')}`
      :'今回の発言はまだありません');
  }
  function resetSpeakerStats(){
    for(const id of Object.keys(speakerSessionCounts))speakerSessionCounts[id]=0;
    activeSpeakerId=null;lastSpeakerId=null;activeSpeakerMode='';renderSpeakerStats();
  }
  function setSpeakerActivity(profile,mode){
    activeSpeakerId=profile?.id||null;activeSpeakerMode=mode||'発話中';renderSpeakerStats();
  }
  function clearSpeakerActivity(id){
    if(activeSpeakerId===id){activeSpeakerId=null;activeSpeakerMode='';renderSpeakerStats();}
  }
  function recordSpeaker(profile){
    if(!profile?.id||!Object.hasOwn(speakerSessionCounts,profile.id))return;
    speakerSessionCounts[profile.id]++;lastSpeakerId=profile.id;renderSpeakerStats();
  }
  function updateObsRefreshButton(){
    $('resetObsSource').disabled=vaultBusy||(busy&&!streaming);
  }
  function setBusy(value) {
    busy = value;
    for (const el of document.querySelectorAll('#settings input,#settings select,#settings textarea,#settings button,#panel-friends input,#panel-friends select,#panel-friends textarea,#panel-friends button')) el.disabled = value || vaultBusy;
    $('start').disabled = value; $('stop').disabled = !value; $('finish').disabled = !streaming;updateObsRefreshButton();
  }
  function revealSetting(id){
    const el=$(id),panel=el?.closest('[role=tabpanel]');
    if(panel?.id?.startsWith('panel-'))selectTab(panel.id.slice(6));
    let section=el?.closest('details');
    while(section){section.open=true;section=section.parentElement?.closest('details');}
  }
  function updateSettingSummaries(){
    const talk=['控えめ','標準','よく話す'][Number($('talkativeness').value)]||'話し方';
    const content=$('contentName').selectedOptions?.[0]?.textContent?.trim()||'対象なし';
    $('summary-live').textContent=`${content||'対象なし'} / ${$('participantCount').value||'1'}人 / ${talk}`;
    $('summary-video').textContent=($('sourceName').value.trim()||'映像ソース未入力')+($('obsOverlayEnabled').checked?' / コメント表示ON':'');
    $('summary-ai').textContent=$('apiKey').value?($('freeTier').checked?'APIキー入力済み / Free確認済み':'APIキー入力済み'):'APIキー未入力';
    $('summary-voice').textContent=$('output').value==='voicevox'?'VOICEVOX':'棒読みちゃん';
    try{$('summary-vault').textContent=localStorage.getItem('ai-live-commentator-vault-v1')?'保存あり':'保存なし';}
    catch{$('summary-vault').textContent='保存状態不明';}
  }
  function initSettingSections(){
    for(const section of document.querySelectorAll('details.setting-section'))section.open=section.id==='settings-vault';
    try{localStorage.removeItem('ai-live-commentator-settings-sections-v1');}catch{}
    $('settings').addEventListener('input',updateSettingSummaries);
    $('settings').addEventListener('change',updateSettingSummaries);
    updateSettingSummaries();
  }
  let contentLibrary=[],contentKnowledge={},fontLibrary=[];
  let editingContentKnowledgeName='';
  function splitContentName(value){
    const name=typeof value==='string'?value.trim():'';
    const match=name.match(/^([^：:]+)[：:](.+)$/);
    if(!match)return {main:name,sub:'',raw:name};
    const main=match[1].trim(),sub=match[2].trim();
    if(!main||!sub)return {main:name,sub:'',raw:name};
    return {main,sub,raw:`${main}：${sub}`};
  }
  function normalizeContentLibrary(values){
    const unique=[];
    for(const value of values){
      if(typeof value!=='string')continue;
      const item=splitContentName(value.slice(0,100));
      if(!item.raw)continue;
      if(item.sub&&!unique.includes(item.main))unique.push(item.main);
      if(!unique.includes(item.raw))unique.push(item.raw);
    }
    return unique;
  }
  function loadContentLibrary(){
    try{
      const raw=JSON.parse(localStorage.getItem(contentLibraryKey)||'[]');
      return Array.isArray(raw)?normalizeContentLibrary(raw):[];
    }catch{return [];}
  }
  function saveContentLibrary(){
    try{localStorage.setItem(contentLibraryKey,JSON.stringify(contentLibrary));}
    catch{log('対象コンテンツ一覧を保存できませんでした。ブラウザ設定を確認してください。','warn');}
  }
  function normalizeContentKnowledge(value,library=contentLibrary){
    const result={};
    if(!plainObject(value))return result;
    const allowed=new Set(library);
    for(const [rawName,rawText] of Object.entries(value)){
      const name=splitContentName(rawName).raw;
      if(!name||!allowed.has(name)||typeof rawText!=='string')continue;
      const text=rawText.trim().slice(0,4000);
      if(text)result[name]=text;
    }
    return result;
  }
  function loadContentKnowledge(){
    try{return normalizeContentKnowledge(JSON.parse(localStorage.getItem(contentKnowledgeKey)||'{}'));}
    catch{return {};}
  }
  function saveContentKnowledge(){
    contentKnowledge=normalizeContentKnowledge(contentKnowledge);
    try{localStorage.setItem(contentKnowledgeKey,JSON.stringify(contentKnowledge));}
    catch{log('対象コンテンツの追加知識を保存できませんでした。ブラウザ設定を確認してください。','warn');}
  }
  function contentGroups(){
    const groups=[];
    for(const raw of contentLibrary){
      const item=splitContentName(raw);
      if(item.sub)continue;
      groups.push({main:item.main,children:contentLibrary.map(splitContentName).filter(child=>child.sub&&child.main===item.main)});
    }
    return groups;
  }
  function renderContentOptions(selected=$('contentName').value){
    selected=splitContentName(selected).raw;
    const select=$('contentName');select.replaceChildren();
    const none=document.createElement('option');none.value='';none.textContent='なし';select.append(none);
    for(const group of contentGroups()){
      const main=document.createElement('option');main.value=group.main;main.textContent=group.main;main.dataset.level='main';select.append(main);
      for(const child of group.children){
        const option=document.createElement('option');option.value=child.raw;option.textContent=`　${child.sub}`;option.dataset.level='sub';select.append(option);
      }
    }
    select.value=contentLibrary.includes(selected)?selected:'';
  }
  function deleteButton(name,main=false){
    const button=document.createElement('button');button.type='button';button.className='content-delete-button';button.textContent='削除';
    if(main)button.dataset.contentMain=name;else button.dataset.contentName=name;
    return button;
  }
  function knowledgeButton(name){
    const button=document.createElement('button');button.type='button';button.className='content-knowledge-button';button.textContent=contentKnowledge[name]?'知識あり':'知識';
    button.dataset.contentKnowledge=name;
    return button;
  }
  function contentManageActions(name,main=false){
    const actions=document.createElement('div');actions.className='content-manage-actions';
    actions.append(knowledgeButton(name),deleteButton(name,main));return actions;
  }
  function renderContentManageList(){
    const container=$('contentManageList');container.replaceChildren();
    if(!contentLibrary.length){
      const empty=document.createElement('p');empty.className='content-empty';empty.textContent='対象コンテンツはまだ登録されていません。';container.append(empty);return;
    }
    for(const group of contentGroups()){
      const section=document.createElement('section');section.className='content-manage-group';
      const mainRow=document.createElement('div');mainRow.className='content-main-row';
      const mainLabel=document.createElement('strong');mainLabel.textContent=group.main;
      mainRow.append(mainLabel,contentManageActions(group.main,true));section.append(mainRow);
      if(group.children.length){
        const children=document.createElement('div');children.className='content-sub-list';
        for(const child of group.children){
          const row=document.createElement('div');row.className='content-sub-row';
          const branch=document.createElement('span');branch.className='content-branch';branch.textContent='└';
          const label=document.createElement('span');label.className='content-sub-name';label.textContent=child.sub;
          row.append(branch,label,contentManageActions(child.raw));children.append(row);
        }
        section.append(children);
      }
      container.append(section);
    }
  }
  function openContentKnowledgeEditor(name){
    name=splitContentName(name).raw;if(!contentLibrary.includes(name))return;
    editingContentKnowledgeName=name;$('contentKnowledgeName').textContent=name;
    $('contentKnowledgeText').value=contentKnowledge[name]||'';
    $('contentKnowledgeState').textContent='空欄で保存すると、このコンテンツの追加知識を削除します。';
    $('contentKnowledgeEditor').hidden=false;
    setTimeout(()=>$('contentKnowledgeText').focus(),0);
  }
  function closeContentKnowledgeEditor(){
    editingContentKnowledgeName='';$('contentKnowledgeEditor').hidden=true;$('contentKnowledgeText').value='';
  }
  function saveContentKnowledgeEditor(){
    if(!editingContentKnowledgeName||!contentLibrary.includes(editingContentKnowledgeName)){closeContentKnowledgeEditor();return;}
    const text=$('contentKnowledgeText').value.trim().slice(0,4000);
    if(text)contentKnowledge[editingContentKnowledgeName]=text;else delete contentKnowledge[editingContentKnowledgeName];
    saveContentKnowledge();renderContentManageList();
    $('contentKnowledgeState').textContent=text?'追加知識を保存しました。':'追加知識を削除しました。';
  }
  function addContent(){
    const input=$('newContentName'),item=splitContentName(input.value.slice(0,100));
    if(!item.raw)return;
    if(contentLibrary.includes(item.raw)){log(`対象コンテンツ「${item.raw}」は登録済みです。`,'warn');input.select();return;}
    if(item.sub&&!contentLibrary.includes(item.main))contentLibrary.push(item.main);
    contentLibrary.push(item.raw);contentLibrary=normalizeContentLibrary(contentLibrary);
    saveContentLibrary();renderContentOptions(item.raw);renderContentManageList();input.value='';input.focus();
  }
  function deleteContent(name){
    name=splitContentName(name).raw;
    if(!contentLibrary.includes(name))return;
    if(!confirm(`「${name}」を対象コンテンツ一覧から削除しますか？`))return;
    const selected=$('contentName').value;contentLibrary=contentLibrary.filter(item=>item!==name);delete contentKnowledge[name];saveContentLibrary();saveContentKnowledge();
    if(editingContentKnowledgeName===name)closeContentKnowledgeEditor();renderContentOptions(selected===name?'':selected);renderContentManageList();
  }
  function deleteContentMain(main){
    const group=contentGroups().find(item=>item.main===main);if(!group)return;
    const count=group.children.length;
    const message=count?`「${main}」とサブ項目${count}件を削除しますか？`:`「${main}」を対象コンテンツ一覧から削除しますか？`;
    if(!confirm(message))return;
    const selected=splitContentName($('contentName').value);
    const removed=contentLibrary.filter(raw=>splitContentName(raw).main===main);contentLibrary=contentLibrary.filter(raw=>{const item=splitContentName(raw);return item.main!==main;});
    for(const name of removed)delete contentKnowledge[name];saveContentLibrary();saveContentKnowledge();if(removed.includes(editingContentKnowledgeName))closeContentKnowledgeEditor();renderContentOptions(selected.main===main?'':selected.raw);renderContentManageList();
  }
  function openContentDialog(){closeContentKnowledgeEditor();renderContentManageList();$('contentDialog').showModal();setTimeout(()=>$('newContentName').focus(),0);}
  function closeContentDialog(){closeContentKnowledgeEditor();$('contentDialog').close();}

  function normalizeFontName(value){
    if(typeof value!=='string')return '';
    const name=value.trim().replace(/\s+/g,' ').slice(0,100);
    if(!name||/[\x00-\x1f\x7f"'\\;{}<>]/u.test(name))return '';
    return name;
  }
  function normalizeFontLibrary(values){
    const unique=[];
    for(const value of values){
      const name=normalizeFontName(value);
      if(name&&name.toLowerCase()!=='system'&&!unique.some(item=>item.toLocaleLowerCase()===name.toLocaleLowerCase()))unique.push(name);
    }
    return unique;
  }
  function loadFontLibrary(){
    try{
      const raw=JSON.parse(localStorage.getItem(fontLibraryKey)||'[]');
      return Array.isArray(raw)?normalizeFontLibrary(raw):[];
    }catch{return [];}
  }
  function saveFontLibrary(){
    try{localStorage.setItem(fontLibraryKey,JSON.stringify(fontLibrary));}
    catch{log('フォント一覧を保存できませんでした。ブラウザ設定を確認してください。','warn');}
  }
  function legacyFontName(value){
    return ({yugothic:'Yu Gothic UI',meiryo:'Meiryo',bizudp:'BIZ UDPGothic',noto:'Noto Sans JP',msgothic:'MS PGothic'})[value]||'';
  }
  function renderFontOptions(selected=$('obsOverlayFont').value){
    const select=$('obsOverlayFont');select.replaceChildren();
    const system=document.createElement('option');system.value='system';system.textContent='システム標準';select.append(system);
    for(const name of fontLibrary){const option=document.createElement('option');option.value=name;option.textContent=name;select.append(option);}
    select.value=selected==='system'||fontLibrary.includes(selected)?selected:'system';
  }
  function renderFontManageList(){
    const container=$('fontManageList');container.replaceChildren();
    const system=document.createElement('div');system.className='content-manage-row';
    const systemName=document.createElement('span');systemName.textContent='システム標準';
    const fixed=document.createElement('span');fixed.className='hint';fixed.textContent='固定';
    system.append(systemName,fixed);container.append(system);
    for(const name of fontLibrary){
      const row=document.createElement('div');row.className='content-manage-row';
      const label=document.createElement('span');label.textContent=name;
      const button=document.createElement('button');button.type='button';button.className='content-delete-button';button.textContent='削除';button.dataset.fontName=name;
      row.append(label,button);container.append(row);
    }
  }
  function addFont(){
    const input=$('newFontName'),name=normalizeFontName(input.value);
    if(!name){log('フォント名を確認してください。引用符・セミコロンなどは使えません。','warn');input.select();return;}
    if(name.toLowerCase()==='system'){log('「system」は予約名です。','warn');input.select();return;}
    if(fontLibrary.some(item=>item.toLocaleLowerCase()===name.toLocaleLowerCase())){log(`フォント「${name}」は登録済みです。`,'warn');input.select();return;}
    fontLibrary.push(name);fontLibrary=normalizeFontLibrary(fontLibrary);saveFontLibrary();renderFontOptions(name);renderFontManageList();input.value='';input.focus();
  }
  function deleteFont(name){
    if(!fontLibrary.includes(name))return;
    if(!confirm(`「${name}」をフォント一覧から削除しますか？`))return;
    const selected=$('obsOverlayFont').value;
    fontLibrary=fontLibrary.filter(item=>item!==name);saveFontLibrary();renderFontOptions(selected===name?'system':selected);renderFontManageList();
  }
  function openFontDialog(){renderFontManageList();$('fontDialog').showModal();setTimeout(()=>$('newFontName').focus(),0);}
  function closeFontDialog(){$('fontDialog').close();}

  function settingLabel(id){
    const label=$(id).closest('label');
    if(!label)return id;
    const title=label.querySelector(':scope > span:first-child');
    if(title?.textContent.trim())return title.textContent.trim();
    for(const node of label.childNodes)if(node.nodeType===Node.TEXT_NODE&&node.textContent.trim())return node.textContent.trim();
    return id;
  }
  function selectedProfileIds(){
    return [...document.querySelectorAll('#participantSelection input[data-profile-id]:checked')].map(input=>input.dataset.profileId);
  }
  function syncParticipantCount(){
    $('participantCount').value=String(selectedProfileIds().length);
    updateSettingSummaries();renderSpeakerStats();
  }
  function updateParticipantNames(){
    for(let i=0;i<6;i++){
      const id=`p${i+1}`,label=document.querySelector(`[data-participant-name="${id}"]`);
      if(label)label.textContent=$(`${id}-name`)?.value.trim()||`友達${i+1}`;
    }
    renderSpeakerStats();
  }
  function renderParticipantSelection(selectedIds){
    const valid=new Set(Array.isArray(selectedIds)?selectedIds.filter(id=>/^p[1-6]$/.test(id)):[]);
    const root=$('participantSelection');root.replaceChildren();
    for(let i=0;i<6;i++){
      const id=`p${i+1}`,label=document.createElement('label'),input=document.createElement('input'),name=document.createElement('span');
      label.className='participant-choice';input.type='checkbox';input.id=`participant-${id}`;input.dataset.profileId=id;input.checked=valid.has(id);
      name.dataset.participantName=id;name.textContent=$(`${id}-name`)?.value.trim()||`友達${i+1}`;
      label.classList.toggle('selected',input.checked);
      input.addEventListener('change',()=>{label.classList.toggle('selected',input.checked);syncParticipantCount();});
      label.append(input,name);root.append(label);
    }
    syncParticipantCount();
  }
  function settings() {
    const s = {};
    for (const id of savedIds) s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value.trim();
    s.contentName=splitContentName($('contentName').value).raw;
    if(s.contentName&&!contentLibrary.includes(s.contentName))s.contentName='';
    s.contentKnowledge=s.contentName?(contentKnowledge[s.contentName]||''):'';
    for (const [id,[min,max]] of Object.entries(numberRules)) {
      const value = Number(s[id]);
      if (s[id] === '' || !Number.isInteger(value) || value < min || value > max){revealSetting(id);throw new C.AppError(`${settingLabel(id)}は${min}〜${max}の整数で指定してください。`);}
      s[id] = value;
    }
    if (![320,640,960].includes(s.imageWidth)){revealSetting('imageWidth');throw new C.AppError('画像サイズを選択してください。');}
    if (!['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'].includes(s.obsOverlayPosition)){revealSetting('obsOverlayPosition');throw new C.AppError('OBSコメントの表示位置を選択してください。');}
    if (s.obsOverlayFont!=='system'&&!fontLibrary.includes(s.obsOverlayFont)){revealSetting('obsOverlayFont');throw new C.AppError('OBSコメントのフォントを選択してください。');}
    if (!['bouyomi','voicevox'].includes(s.output)){revealSetting('output');throw new C.AppError('読み上げ先を選択してください。');}
    s.selectedProfileIds=selectedProfileIds();
    if(!s.selectedProfileIds.length){revealSetting('participantSelection');throw new C.AppError('参加する友達を1人以上選択してください。');}
    s.participantCount=s.selectedProfileIds.length;$('participantCount').value=String(s.participantCount);
    s.speakerCountWeights=Array.from({length:6},(_,i)=>s[`speakerWeight${i+1}`]);
    if(s.speakerCountWeights.slice(0,s.participantCount).every(w=>w===0)){revealSetting('speakerWeight1');throw new C.AppError('選択した友達の人数以内の発言人数の重みを1つ以上0より大きくしてください。');}
    s.allProfiles=readProfiles();const selected=new Set(s.selectedProfileIds);s.profiles=s.allProfiles.filter(p=>selected.has(p.id));
    s.speaker=s.profiles[0].speaker; s.speedScale=s.profiles[0].speedScale; s.bouyomiVoice=s.profiles[0].bouyomiVoice;
    return s;
  }
  function persistedSettings(s){
    // Explicit allowlist: secrets and free-tier confirmation are never persisted or exported.
    return {...Object.fromEntries(savedIds.map(id => [id, s[id]])),contentName:s.contentName,selectedProfileIds:s.selectedProfileIds,participantCount:s.participantCount,profiles:s.allProfiles};
  }
  function save(s) {
    const data=persistedSettings(s);
    try { localStorage.setItem(storageKey, JSON.stringify(data)); $('saveState').textContent = '設定を保存しました。キー類の保存は「暗号化して保存」から行えます。'; }
    catch { $('saveState').textContent = 'ブラウザが保存を許可していません。このタブ内では使えます。'; }
  }
  function plainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
  function normalizeImportedBundle(value){
    if(!plainObject(value)||value.format!==settingsExportFormat||value.version!==settingsExportVersion||!plainObject(value.settings))throw new C.AppError('みんコメの設定ファイルとして認識できません。');
    const source=value.settings,data={};
    const importedContents=normalizeContentLibrary(Array.isArray(value.contentLibrary)?value.contentLibrary:[]);
    const importedKnowledge=normalizeContentKnowledge(value.contentKnowledge,importedContents);
    const importedFonts=normalizeFontLibrary(Array.isArray(value.fontLibrary)?value.fontLibrary:[]);
    for(const id of savedIds){
      if(source[id]===undefined)throw new C.AppError('設定ファイルに必要な設定項目が不足しています。');
      const el=$(id),raw=source[id];
      if(el.type==='checkbox'){
        if(typeof raw!=='boolean')throw new C.AppError(`${settingLabel(id)}の値が不正です。`);
        data[id]=raw;
      }else if(typeof raw==='string'||typeof raw==='number')data[id]=raw;
      else throw new C.AppError(`${settingLabel(id)}の値が不正です。`);
    }
    for(const [id,[min,max]] of Object.entries(numberRules)){
      if(data[id]===undefined)continue;
      const n=Number(data[id]);
      if(!Number.isInteger(n)||n<min||n>max)throw new C.AppError(`${settingLabel(id)}は${min}〜${max}の整数で指定してください。`);
      data[id]=n;
    }
    if(data.theme!==undefined&&!Object.hasOwn(themes,String(data.theme)))throw new C.AppError('テーマの値が不正です。');
    if(data.imageWidth!==undefined&&![320,640,960].includes(data.imageWidth))throw new C.AppError('画像サイズの値が不正です。');
    if(data.obsOverlayPosition!==undefined&&!['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'].includes(String(data.obsOverlayPosition)))throw new C.AppError('OBSコメントの表示位置が不正です。');
    if(data.output!==undefined&&!['bouyomi','voicevox'].includes(String(data.output)))throw new C.AppError('読み上げ先の値が不正です。');
    if(data.obsOverlayFont!==undefined&&data.obsOverlayFont!=='system'&&!importedFonts.includes(String(data.obsOverlayFont)))throw new C.AppError('OBSコメントのフォントが登録フォント一覧にありません。');
    const contentName=typeof source.contentName==='string'?splitContentName(source.contentName).raw:'';
    if(contentName&&!importedContents.includes(contentName))throw new C.AppError('対象コンテンツが対象コンテンツ一覧にありません。');
    const rawProfiles=Array.isArray(source.profiles)?source.profiles:[];
    if(rawProfiles.length!==6)throw new C.AppError('友達設定は6人分必要です。');
    const profiles=rawProfiles.map((raw,i)=>{
      if(!plainObject(raw))throw new C.AppError(`友達${i+1}の設定が不正です。`);
      const name=typeof raw.name==='string'?raw.name.trim():'',personality=typeof raw.personality==='string'?raw.personality.trim():'';
      const speaker=Number(raw.speaker),speedScale=Number(raw.speedScale),bouyomiVoice=Number(raw.bouyomiVoice);
      if(!name||name.length>40||!personality||personality.length>300)throw new C.AppError(`友達${i+1}の呼び名または性格・話し方が不正です。`);
      if(!Number.isInteger(speaker)||speaker<0||speaker>99999||!Number.isFinite(speedScale)||speedScale<0.5||speedScale>2||!Number.isInteger(bouyomiVoice)||bouyomiVoice<0||bouyomiVoice>65535)throw new C.AppError(`友達${i+1}の音声設定が不正です。`);
      return {id:`p${i+1}`,name,personality,speaker,speedScale,bouyomiVoice};
    });
    const selected=Array.isArray(source.selectedProfileIds)?[...new Set(source.selectedProfileIds.filter(id=>/^p[1-6]$/.test(id)))]:[];
    if(!selected.length)throw new C.AppError('参加する友達を1人以上指定してください。');
    if(Array.from({length:selected.length},(_,i)=>data[`speakerWeight${i+1}`]).every(w=>w===0))throw new C.AppError('選択した友達の人数以内の発言人数の重みを1つ以上0より大きくしてください。');
    return {data:{...data,contentName,selectedProfileIds:selected,participantCount:selected.length,profiles},contentLibrary:importedContents,contentKnowledge:importedKnowledge,fontLibrary:importedFonts};
  }
  function applyImportedBundle(bundle){
    contentLibrary=bundle.contentLibrary;contentKnowledge=bundle.contentKnowledge||{};fontLibrary=bundle.fontLibrary;saveContentLibrary();saveContentKnowledge();saveFontLibrary();
    for(const id of savedIds){
      if(bundle.data[id]===undefined)continue;
      if($(id).type==='checkbox')$(id).checked=bundle.data[id]===true;else $(id).value=String(bundle.data[id]);
    }
    renderFontOptions(bundle.data.obsOverlayFont===undefined?$('obsOverlayFont').value:String(bundle.data.obsOverlayFont));
    applyTheme($('theme').value);
    renderContentOptions(bundle.data.contentName);
    $('profiles').replaceChildren();buildProfiles(bundle.data.profiles);renderParticipantSelection(bundle.data.selectedProfileIds);
    outputFields();overlayFields();updateSettingSummaries();
    const s=settings();save(s);
    $('saveState').textContent='設定をインポートしました。APIキーとOBSパスワードは変更していません。';
    log('設定をインポートしました。友達設定・対象コンテンツ一覧・追加知識・登録フォント一覧も反映しました。');
  }
  function exportSettings(){
    const s=settings();
    const bundle={format:settingsExportFormat,version:settingsExportVersion,exportedAt:new Date().toISOString(),secretsIncluded:false,settings:persistedSettings(s),contentLibrary:[...contentLibrary],contentKnowledge:{...contentKnowledge},fontLibrary:[...fontLibrary]};
    const blob=new Blob([JSON.stringify(bundle,null,2)+'\n'],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a'),stamp=new Date().toISOString().slice(0,10).replaceAll('-','');
    a.href=url;a.download=`minkome-settings-${stamp}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
    $('saveState').textContent='設定を書き出しました。APIキーとOBSパスワードは含まれていません。';
    log('設定をエクスポートしました。秘密情報は含めていません。');
  }
  async function importSettingsFile(file){
    if(!file)return;
    if(file.size>1024*1024)throw new C.AppError('設定ファイルが大きすぎます。1MB以下のJSONファイルを選択してください。');
    let raw;try{raw=JSON.parse(await file.text());}catch{throw new C.AppError('設定ファイルのJSONを読み取れませんでした。');}
    const bundle=normalizeImportedBundle(raw);
    if(!confirm('現在の通常設定を、選択した設定ファイルの内容で置き換えますか？\nAPIキーとOBSパスワードは変更しません。'))return;
    applyImportedBundle(bundle);
  }
  function voicevoxSettingsLink(){
    try{$('voicevoxSettingsLink').href=C.localUrl($('voicevoxUrl').value,'http:')+'/setting';}
    catch{$('voicevoxSettingsLink').removeAttribute('href');}
  }
  $('voicevoxUrl').addEventListener('input',voicevoxSettingsLink);
  function outputFields() { voicevoxSettingsLink(); $('bouyomiFields').hidden = $('output').value !== 'bouyomi'; $('voicevoxFields').hidden = $('output').value !== 'voicevox'; updateSettingSummaries(); }
  function overlayFields(){ $('obsOverlayFields').hidden=!$('obsOverlayEnabled').checked; updateSettingSummaries(); }
  function requireKey() {
    let key;try{key=C.normalizeKey($('apiKey').value);}catch(e){revealSetting('apiKey');throw e;}
    if (!$('freeTier').checked){revealSetting('freeTier');throw new C.AppError('このキーのプロジェクトがFree Tier・課金未設定であることを確認し、チェックを付けてください。');}
    return key;
  }
  function reserve() { stats.used++; updateStats(); }
  async function getFrame(s, signal) {
    C.check(signal); const capturedAt = performance.now();
    let result;
    try{result=await obs.screenshot(s.sourceName, s.imageWidth, signal);}
    catch(e){
      if(e instanceof C.AppError&&e.code==='OBS_SOURCE'){obsSourceFailurePending=true;obsSourceRecoveryReady=false;}
      throw e;
    }
    const data = typeof result.imageData === 'string' ? result.imageData.replace(/^data:image\/jpg;/, 'data:image/jpeg;') : result.imageData;
    if (typeof data !== 'string' || data.length > 8 * 1024 * 1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) throw new C.AppError('OBSから有効なJPEG画像を取得できませんでした。');
    const im = new Image();
    await C.deadline(token => new Promise((resolve,reject) => {
      const done = fn => () => { token.removeEventListener('abort',abort); im.onload = im.onerror = null; fn(); };
      const abort = done(() => reject(C.abortError()));
      im.onload = done(resolve); im.onerror = done(() => reject(new C.AppError('OBS画像を表示できません。')));
      token.addEventListener('abort',abort,{once:true}); im.src = data;
    }), 10000, signal, 'OBS画像の読み込みがタイムアウトしました。');
    C.check(signal);
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const ctx = canvas.getContext('2d', {willReadFrequently:true}); ctx.drawImage(im,0,0,32,18);
    const pixels = ctx.getImageData(0,0,32,18).data;
    $('preview').src = data; $('preview').hidden = false; $('placeholder').hidden = true;
    $('imageInfo').textContent = `${im.naturalWidth} × ${im.naturalHeight} · ${new Date().toLocaleTimeString('ja-JP')}`;
    lastCaptureAt=performance.now();
    return { data, capturedAt, pixels };
  }
  function motion(a,b) { let changed=0; for(let i=0;i<a.length;i+=4) if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>85) changed++; return changed/(a.length/4); }
  async function fetchLocal(url, options, signal) {
    let r;
    try { r = await fetch(url, {...options, signal, credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer'}); }
    catch { C.check(signal); throw new C.AppError('読み上げ先に接続できません。起動状態・URL・HTTP連携・CORSやローカル接続の許可を確認してください。ヘルプのVOICEVOX項目もご覧ください。'); }
    if (!r.ok) throw new C.AppError(`読み上げ先がHTTP ${r.status}を返しました。設定を確認してください。`);
    return r;
  }
  async function jsonLocal(url, options, signal) {
    const r=await fetchLocal(url,options,signal);
    try { return await r.json(); } catch { C.check(signal); throw new C.AppError('読み上げ先の応答形式が不正です。接続先とバージョンを確認してください。'); }
  }
  async function unlockAudio(s) {
    if(s.output!=='voicevox') return;
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    if(audioContext.state!=='running') throw new C.AppError('ブラウザで音声再生が許可されていません。「音声テスト」を押して再度お試しください。');
  }
  function checkFresh(frame,s) { if(frame && !C.fresh(frame.capturedAt,performance.now(),s.freshness)) throw new C.AppError('鮮度上限を超えたため、コメントを破棄しました。','STALE'); }
  async function generateVoicevoxAudio(text,s,frame,signal) {
    checkFresh(frame,s); C.check(signal);
    const ms=frame?Math.min(120000,frame.capturedAt+s.freshness*1000-performance.now()):120000;
    return C.deadline(async token=>{
      const base=C.localUrl(s.voicevoxUrl,'http:');
      const query=await jsonLocal(base+'/audio_query?'+new URLSearchParams({text,speaker:String(s.speaker)}),{method:'POST'},token);
      query.speedScale=s.speedScale;
      const r=await fetchLocal(base+'/synthesis?speaker='+s.speaker,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(query)},token);
      const wave=await r.arrayBuffer();C.check(token);
      if(wave.byteLength>32*1024*1024)throw new C.AppError('生成された音声が大きすぎます。');
      const decoded=await audioContext.decodeAudioData(wave);C.check(token);return decoded;
    },ms,signal,frame?'音声生成中に鮮度上限に達したため破棄しました。':'VOICEVOXの音声生成がタイムアウトしました。',frame?'STALE':'TIMEOUT');
  }
  async function playVoicevoxAudio(audio,s,frame,signal,onStart=null) {
    checkFresh(frame,s);C.check(signal);
    if(audioContext.state!=='running')throw new C.AppError('音声再生が中断されています。音声テストをやり直してください。');
    await C.deadline(token=>new Promise((resolve,reject)=>{
      const source=audioContext.createBufferSource();activeAudio=source;source.buffer=audio;source.connect(audioContext.destination);
      const clean=()=>{token.removeEventListener('abort',abort);source.disconnect();if(activeAudio===source)activeAudio=null;};
      const abort=()=>{source.onended=null;try{source.stop();}catch{}clean();reject(C.abortError());};
      source.onended=()=>{clean();resolve();};token.addEventListener('abort',abort,{once:true});
      onStart?.();source.start();
    }),120000,signal,'音声再生がタイムアウトしました。');
  }
  async function speak(text,s,frame,signal,ownQueue=false) {
    checkFresh(frame,s);C.check(signal);
    const ms=frame?Math.min(120000,frame.capturedAt+s.freshness*1000-performance.now()):120000;
    // The first delivered turn must meet freshness. Later turns use ordinary timeouts.
    if(s.output==='bouyomi') {
      return C.deadline(async token=>{
        const base=C.localUrl(s.bouyomiUrl,'http:');
        const state=await jsonLocal(base+'/GetTalkTaskCount',{},token);
        if(!Number.isInteger(state.talkTaskCount)||state.talkTaskCount<0)throw new C.AppError('棒読みちゃんの待機数を取得できませんでした。HTTP連携を確認してください。');
        if(state.talkTaskCount>0&&!ownQueue){log('見送り: 棒読みちゃんに再生待ちの音声があります。','warn');return false;}
        const plain=C.plainSpeech(text);if(plain.length<2){log('見送り: 読み上げ可能な文章がありません。','warn');return false;}
        checkFresh(frame,s);C.check(token);
        const params=new URLSearchParams({text:plain,voice:String(s.bouyomiVoice),speed:'-1',tone:'-1',volume:'-1'});
        const r=await fetchLocal(base+'/talk?'+params,{},token);
        const body=await r.text();C.check(token);
        if(body.trim()){let result;try{result=JSON.parse(body);}catch{throw new C.AppError('棒読みちゃんの応答を確認できませんでした。重複を避けるため再送しません。');}
          if(result?.error||result?.success===false)throw new C.AppError('棒読みちゃんが読み上げ要求を受け付けませんでした。');}
        return true;
      },ms,signal,frame?'鮮度上限に達しました。棒読みちゃんへの送信が済んでいる場合はPC側で再生されることがあります。':'棒読みちゃんがタイムアウトしました。',frame?'STALE':'TIMEOUT');
    }
    const audio=await generateVoicevoxAudio(text,s,frame,signal);
    await playVoicevoxAudio(audio,s,frame,signal);
    return true;
  }
  function obsOverlayColor(profile){
    const index=Math.max(0,Math.min(5,(Number(String(profile?.id||'').replace(/^p/,''))||1)-1));
    return obsOverlayColors[index];
  }
  function darkenHex(hex,factor=.32){
    const n=parseInt(String(hex).replace('#',''),16);
    if(!Number.isFinite(n))return '#20242a';
    const c=shift=>Math.max(0,Math.min(255,Math.round(((n>>shift)&255)*factor)));
    return '#'+[c(16),c(8),c(0)].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function escapeHtml(value){
    return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function obsOverlayFontFamily(value){
    if(value==='system')return 'system-ui,-apple-system,"Segoe UI",sans-serif';
    const name=normalizeFontName(value);
    return name?`"${name}",system-ui,-apple-system,"Segoe UI",sans-serif`:'system-ui,-apple-system,"Segoe UI",sans-serif';
  }
  function splitBubbleLines(text){
    const chars=Array.from(String(text??'').trim());
    if(chars.length<=18)return [chars.join('')];
    const mid=Math.ceil(chars.length/2);
    let cut=mid;
    for(let distance=0;distance<=6;distance++){
      const candidates=[mid+distance,mid-distance];
      const found=candidates.find(i=>i>3&&i<chars.length-3&&/[、。！？!? 　]/u.test(chars[i-1]));
      if(found!==undefined){cut=found;break;}
    }
    return [chars.slice(0,cut).join('').trim(),chars.slice(cut).join('').trim()].filter(Boolean).slice(0,2);
  }
  function obsBubbleDocument(profile,turn,s){
    const color=obsOverlayColor(profile),edgeColor=darkenHex(color),fontSize=s.obsOverlayFontSize,fontFamily=obsOverlayFontFamily(s.obsOverlayFont);
    const fontWeight=s.obsOverlayBold?700:400;
    const stroke=Math.max(2,Math.min(5,Math.round(fontSize*.075)));
    const nameSize=Math.max(15,Math.round(fontSize*.48));
    const radius=Math.max(20,Math.round(fontSize*.72));
    const position=String(s.obsOverlayPosition||'bottom-left');
    const horizontal=position.endsWith('right')?'flex-end':position.endsWith('center')?'center':'flex-start';
    const vertical=position.startsWith('top')?'flex-start':'flex-end';
    const tailRight=position.endsWith('right'),tailCenter=position.endsWith('center');
    const outerPos=tailCenter?'left:50%;transform:translateX(-50%);':tailRight?'right:52px;':'left:52px;';
    const innerPos=tailCenter?'left:50%;transform:translateX(-50%);':tailRight?'right:55px;':'left:55px;';
    const nameHtml=s.obsOverlayShowName?`<div class="name">${escapeHtml(profile.name)}</div>`:'';
    const textHtml=splitBubbleLines(turn.text).map(line=>`<span class="line">${escapeHtml(line)}</span>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:${fontFamily}}
body{box-sizing:border-box;padding:30px 10px 52px;display:flex;align-items:${vertical};justify-content:${horizontal}}
.bubble{position:relative;display:inline-block;width:fit-content;max-width:100%;min-width:0;box-sizing:border-box;padding:${Math.max(18,Math.round(fontSize*.5))}px ${Math.max(24,Math.round(fontSize*.72))}px;border-radius:${radius}px;background:${color}e8;border:2px solid rgba(255,255,255,.34);box-shadow:0 10px 28px rgba(0,0,0,.35);color:#fff}
.bubble:before{content:"";position:absolute;bottom:-31px;${outerPos}width:42px;height:31px;background:rgba(255,255,255,.34);clip-path:polygon(0 0,100% 0,50% 100%)}
.bubble:after{content:"";position:absolute;bottom:-26px;${innerPos}width:36px;height:27px;background:${color};clip-path:polygon(0 0,100% 0,50% 100%)}
.name,.text{font-weight:${fontWeight};-webkit-text-stroke:${stroke}px ${edgeColor};paint-order:stroke fill;text-shadow:0 2px 2px rgba(0,0,0,.32)}
.name{font-size:${nameSize}px;line-height:1.15;opacity:.96;margin-bottom:6px;white-space:nowrap}
.text{font-size:${fontSize}px;line-height:1.24;letter-spacing:0}
.line{display:block;white-space:nowrap}
</style></head><body><div class="bubble">${nameHtml}<div class="text">${textHtml}</div></div></body></html>`;
  }
  function obsOverlayGeometry(position,baseWidth,baseHeight,boxWidth,boxHeight){
    const margin=Math.max(20,Math.round(Math.min(baseWidth,baseHeight)*0.035));
    const right=Math.max(margin,baseWidth-boxWidth-margin),bottom=Math.max(margin,baseHeight-boxHeight-margin);
    const centerX=Math.max(margin,Math.round((baseWidth-boxWidth)/2));
    if(position==='top-center')return {x:centerX,y:margin};
    if(position==='top-right')return {x:right,y:margin};
    if(position==='bottom-left')return {x:margin,y:bottom};
    if(position==='bottom-center')return {x:centerX,y:bottom};
    if(position==='bottom-right')return {x:right,y:bottom};
    return {x:margin,y:margin};
  }
  function clearObsOverlayTimer(){
    if(obsOverlayTimer!==null){clearTimeout(obsOverlayTimer);obsOverlayTimer=null;}
  }
  function disableObsOverlayTarget(target=obsOverlayTarget){
    if(!target||!obs?.ready)return;
    obs.notify('SetSceneItemEnabled',{sceneName:target.sceneName,sceneItemId:target.sceneItemId,sceneItemEnabled:false});
  }
  function clearObsOverlayNow(){
    clearObsOverlayTimer();obsOverlayEpoch++;
    disableObsOverlayTarget();obsOverlayTarget=null;
  }
  async function resetObsOverlayScene(signal){
    if(!obs?.ready)return;
    try{
      const [sceneInfo,inputList]=await Promise.all([
        obs.request('GetCurrentProgramScene',{},signal),
        obs.request('GetInputList',{},signal)
      ]);
      const sceneName=sceneInfo.sceneName||sceneInfo.currentProgramSceneName;if(!sceneName)return;
      const items=await obs.request('GetSceneItemList',{sceneName},signal);
      for(const sourceName of [obsOverlaySourceName,legacyObsOverlaySourceName]){
        const item=(items.sceneItems||[]).find(x=>x.sourceName===sourceName);
        if(item&&Number.isInteger(Number(item.sceneItemId)))
          await obs.request('SetSceneItemEnabled',{sceneName,sceneItemId:Number(item.sceneItemId),sceneItemEnabled:false},signal);
      }
      const legacy=(inputList.inputs||[]).find(input=>input.inputName===legacyObsOverlaySourceName);
      if(legacy&&String(legacy.inputKind||legacy.unversionedInputKind||'').startsWith('text_gdiplus'))
        await obs.request('SetInputSettings',{inputName:legacyObsOverlaySourceName,inputSettings:{text:''},overlay:true},signal);
    }catch(e){
      C.check(signal);log('旧OBSコメント表示の後片付けを省略しました。','warn');
    }
  }
  async function ensureObsOverlay(profile,turn,s,signal){
    C.check(signal);
    const [sceneInfo,inputList,kindList,video]=await Promise.all([
      obs.request('GetCurrentProgramScene',{},signal),
      obs.request('GetInputList',{},signal),
      obs.request('GetInputKindList',{},signal),
      obs.request('GetVideoSettings',{},signal)
    ]);
    const sceneName=sceneInfo.sceneName||sceneInfo.currentProgramSceneName;
    if(!sceneName)throw new C.AppError('OBSの現在シーンを取得できませんでした。','OBS_OVERLAY');
    const existing=(inputList.inputs||[]).find(input=>input.inputName===obsOverlaySourceName);
    if(existing&&!String(existing.inputKind||existing.unversionedInputKind||'').startsWith('browser_source'))
      throw new C.AppError(`OBSに「${obsOverlaySourceName}」という別種類のソースがあります。名前を変更または削除してください。`,'OBS_OVERLAY');
    const kinds=Array.isArray(kindList.inputKinds)?kindList.inputKinds:[];
    const browserKind=existing?.inputKind||kinds.find(k=>String(k).startsWith('browser_source'));
    if(!browserKind)throw new C.AppError('OBSで Browser Source を利用できません。OBSのBrowser Source機能を確認してください。','OBS_OVERLAY');
    const baseWidth=Number(video.baseWidth)||1920,baseHeight=Number(video.baseHeight)||1080;
    const lines=splitBubbleLines(turn.text);
    const longest=Math.max(1,...lines.map(line=>Array.from(line).length));
    const nameCount=s.obsOverlayShowName?Array.from(String(profile.name||'')).length:0;
    const glyphWidth=s.obsOverlayFontSize*1.1;
    const textWidth=longest*glyphWidth;
    const nameWidth=nameCount*Math.max(15,Math.round(s.obsOverlayFontSize*.48))*1.08;
    const bubblePad=Math.max(24,Math.round(s.obsOverlayFontSize*.72))*2;
    const outerPad=24;
    const targetWidth=Math.max(textWidth,nameWidth)+bubblePad+outerPad;
    const boxWidth=Math.round(Math.max(360,Math.min(baseWidth-16,targetWidth)));
    const boxHeight=Math.round(Math.max(420,Math.min(baseHeight-16,s.obsOverlayFontSize*8.0)));
    const html=obsBubbleDocument(profile,turn,s);
    const inputSettings={
      is_local_file:false,url:'data:text/html;charset=utf-8,'+encodeURIComponent(html),
      width:boxWidth,height:boxHeight,fps:30,shutdown:false,restart_when_active:false,reroute_audio:false,
      css:'body{background-color:rgba(0,0,0,0);margin:0;overflow:hidden;}'
    };
    const items=await obs.request('GetSceneItemList',{sceneName},signal,{errorCode:'OBS_OVERLAY',errorMessage:'OBSシーンの項目を取得できませんでした'});
    const legacyItem=(items.sceneItems||[]).find(x=>x.sourceName===legacyObsOverlaySourceName);
    if(legacyItem&&Number.isInteger(Number(legacyItem.sceneItemId)))
      obs.notify('SetSceneItemEnabled',{sceneName,sceneItemId:Number(legacyItem.sceneItemId),sceneItemEnabled:false});
    const legacy=(inputList.inputs||[]).find(input=>input.inputName===legacyObsOverlaySourceName);
    if(legacy&&String(legacy.inputKind||legacy.unversionedInputKind||'').startsWith('text_gdiplus'))
      obs.notify('SetInputSettings',{inputName:legacyObsOverlaySourceName,inputSettings:{text:''},overlay:true});
    let sceneItemId=null;
    if(!existing){
      const created=await obs.request('CreateInput',{sceneName,inputName:obsOverlaySourceName,inputKind:browserKind,inputSettings,sceneItemEnabled:false},signal,{errorCode:'OBS_OVERLAY',errorMessage:'OBS吹き出しソースを作成できませんでした'});
      sceneItemId=Number(created.sceneItemId);
      log(`OBSに「${obsOverlaySourceName}」ソースを作成しました。`);
    }else{
      await obs.request('SetInputSettings',{inputName:obsOverlaySourceName,inputSettings,overlay:true},signal,{errorCode:'OBS_OVERLAY',errorMessage:'OBS吹き出しを更新できませんでした'});
      const item=(items.sceneItems||[]).find(x=>x.sourceName===obsOverlaySourceName);
      if(item)sceneItemId=Number(item.sceneItemId);
      else{
        const created=await obs.request('CreateSceneItem',{sceneName,sourceName:obsOverlaySourceName,sceneItemEnabled:false},signal,{errorCode:'OBS_OVERLAY',errorMessage:'OBS吹き出しを現在シーンへ追加できませんでした'});
        sceneItemId=Number(created.sceneItemId);
      }
    }
    if(!Number.isInteger(sceneItemId)||sceneItemId<0)throw new C.AppError('OBS吹き出しのシーン項目IDを取得できませんでした。','OBS_OVERLAY');
    if(obsOverlayTarget&&(obsOverlayTarget.sceneName!==sceneName||obsOverlayTarget.sceneItemId!==sceneItemId))disableObsOverlayTarget(obsOverlayTarget);
    const pos=obsOverlayGeometry(s.obsOverlayPosition,baseWidth,baseHeight,boxWidth,boxHeight);
    await obs.request('SetSceneItemTransform',{sceneName,sceneItemId,sceneItemTransform:{positionX:pos.x,positionY:pos.y,alignment:5,scaleX:1,scaleY:1}},signal,{errorCode:'OBS_OVERLAY',errorMessage:'OBS吹き出しの位置を変更できませんでした'});
    await obs.request('SetSceneItemEnabled',{sceneName,sceneItemId,sceneItemEnabled:true},signal,{errorCode:'OBS_OVERLAY',errorMessage:'OBS吹き出しを表示できませんでした'});
    obsOverlayTarget={sceneName,sceneItemId};
    return ++obsOverlayEpoch;
  }
  async function showObsOverlay(profile,turn,s,signal,{strict=false}={}){
    if(!s.obsOverlayEnabled||!obs?.ready||(!strict&&obsOverlayFaulted))return 0;
    clearObsOverlayTimer();
    try{return await ensureObsOverlay(profile,turn,s,signal);}
    catch(e){
      if(strict)throw e;
      obsOverlayFaulted=true;
      clearObsOverlayNow();
      log('OBSコメント表示をこの接続中は省略します: '+(e instanceof C.AppError?e.message:'OBS表示に失敗しました。'),'warn');
      return 0;
    }
  }
  function scheduleObsOverlayHide(s,epoch){
    if(!epoch||!s.obsOverlayEnabled)return;
    clearObsOverlayTimer();
    obsOverlayTimer=setTimeout(()=>{
      obsOverlayTimer=null;
      if(epoch!==obsOverlayEpoch||!obs?.ready)return;
      disableObsOverlayTarget();obsOverlayTarget=null;
    },Math.max(0,s.obsOverlayHold)*1000);
  }
  function speechSourceText(turn){
    const display=String(turn?.text??'').trim(),candidate=String(turn?.speechText??'').trim();
    const normalized=C.plainSpeech(candidate);
    return /[\p{L}\p{N}]/u.test(normalized)?candidate:display;
  }
  function spokenText(turn){
    const source=speechSourceText(turn),spoken=C.plainSpeech(source);
    return spoken||C.plainSpeech(String(turn?.text??''));
  }
  function showLatestComment(profile,turn){
    $('lastComment').textContent=profile.name+'：'+turn.text;
    $('lastSpeechText').querySelector('strong').textContent=speechSourceText(turn)||'—';
    $('commentTime').textContent=new Date().toLocaleTimeString('ja-JP');
  }
  function greetingHistory(){
    try{
      const raw=JSON.parse(localStorage.getItem(greetingHistoryKey)||'{}'),result={start:[],end:[]};
      for(const kind of ['start','end']){
        const values=Array.isArray(raw?.[kind])?raw[kind]:[];
        result[kind]=values.filter(v=>typeof v==='string').map(v=>v.trim().slice(0,300)).filter(Boolean).slice(-8);
      }
      return result;
    }catch{return {start:[],end:[]};}
  }
  function recordGreetingHistory(kind,turns){
    const text=turns.map(turn=>String(turn?.text??'').trim()).filter(Boolean).join(' / ').slice(0,300);if(!text)return;
    const history=greetingHistory();history[kind]=[...history[kind],text].slice(-8);
    try{localStorage.setItem(greetingHistoryKey,JSON.stringify(history));}catch{}
  }
  function greetingVariation(kind){
    const start=[
      '合流型。配信開始そのものを宣言せず、友達が席についたような自然な一言から入る。「始まったね」「見ていこう」「よろしく」は使わない。',
      '期待型。これから何が起きるかへの軽い楽しみを出す。「今日も」「さあ」「じゃあ」で始めない。',
      '雑談開始型。挨拶らしい定型句を避け、友達同士の短い一言から自然に会話を始める。ゲーム内容はまだ推測しない。',
      '軽いテンション型。少し楽しみ・気になる、という温度感から入る。「始まった」「開始」「見ていこう」は使わない。',
      'タイトル寄り型。対象コンテンツ名が設定されていれば一人だけ自然に触れてよいが、全員でタイトルを繰り返さない。設定がなければ普通の一言にする。',
      'あっさり型。5〜15文字程度の短い一言で始め、典型的な開始挨拶を使わない。'
    ];
    const end=[
      '余韻型。終了を宣言せず、直近の雰囲気への一言で自然に締める。「おつかれ」「また見よう」は使わない。',
      '次回期待型。続きへの軽い興味を残して締める。ただし進捗や成果は断定しない。「おつかれ」で終わらせない。',
      '雑談締め型。一人だけが締め役になり、複数人なら他の人は短い反応や別視点を添える。全員が別れの挨拶を繰り返さない。',
      '感想型。今回確認できた状況の雰囲気に軽く触れて締める。「またね」「おつかれ」を両方とも使わない。',
      '区切り型。今日はここで一区切り、という空気だけを自然に出す。定型的な「今日はこの辺」「また続き」を避ける。',
      'あっさり型。5〜15文字程度の短い一言で終え、別れの定型句を使わない。'
    ];
    const list=kind==='end'?end:start;
    return list[Math.floor(Math.random()*list.length)];
  }
  function greetingPayload(kind,s,history,turnCount){
    turnCount=Math.max(1,Math.min(s.profiles.length,Number(turnCount)||1));
    const ending=kind==='end';
    const context=ending&&history.length?history.slice(-5).join(' / '):'まだゲーム画面の内容は判断しない';
    const recent=greetingHistory()[kind].slice(-5);
    const variation=greetingVariation(kind);
    const content=s.contentName?`対象コンテンツはユーザーが「${s.contentName}」と設定済み。名前は必要な時だけ自然に使ってよいが、未確認の状況や成果は推測しない。`:'対象コンテンツ名は設定されていない。';
    const task=ending
      ? `実況を通常終了する直前の締めを作る。今回見えていた状況に軽く触れてよいが、確認できない成果・勝敗・進捗は断定しない。毎回「おつかれ」「また見よう」「今日はこの辺」の言い換えになるのを避ける。今回の変化パターン: ${variation}`
      : `実況開始直後の短い一言を作る。まだゲーム画面を見ていないので状況・成果を推測しない。毎回「始まったね」「今日も見ていこう」「よろしく」の言い換えになるのを避ける。今回の変化パターン: ${variation}`;
    const recentNote=recent.length?`直近の${ending?'終了':'開始'}挨拶（同一・類似の入り方、語尾、意味を避ける）:\n${recent.map(text=>`・${text}`).join('\n')}`:`直近の${ending?'終了':'開始'}挨拶: なし`;
    const multi=turnCount>1?'複数人のときは全員が独立した挨拶を並べず、最初の一言を受けて軽く反応したり別の温度感を添えたりして、ひと続きの短い掛け合いにする。':'';
    const parts=[{text:`共通の雰囲気: ${s.persona}\n参加者: ${JSON.stringify(s.profiles.map(({id,name,personality})=>({id,name,personality})))}\n${content}\n直近の状況: ${context}\n${recentNote}\n${task}\n${multi}\n開始・終了挨拶が有効なので、この応答のturnsは必ず読み上げる。異なる${turnCount}人が1回ずつ発言し、turnsを必ず${turnCount}件にする。同じspeakerIdを重複させない。各turnには表示用textと読み上げ用speechTextを必ず入れる。speechTextは発音用なので、漢字はできるだけかなへ、英字略語はカタカナ読みへ、数字は文脈に合う自然な読みへ変換する。漢字・英字・数字を含むtextをspeechTextへ丸コピーしない。読みが不確かな固有名詞だけは原表記を残してよい。speakは互換用フィールドなので値にかかわらずturnsを生成する。各5〜25文字程度の自然な口語。架空の思い出は作らない。`}];
    return {systemInstruction:{parts:[{text:'あなたは無言のゲーム配信に添える友達役。開始や終了の定型句を機械的に言い換えるのではなく、その場の友達同士として自然で変化のある短い一言を返す。各turnのtextは画面表示用、speechTextは読み上げ専用にする。speechTextはVOICEVOXや棒読みちゃんが自然に読める発音表記にし、漢字はできるだけかなへ、英字略語はカタカナ読みへ、数字は自然な日本語読みへ直す。漢字・英字・数字を含むtextをそのままコピーしない。読みが不確かな固有名詞だけ原表記を残してよい。方言や崩した言い方も、その友達が実際に話す自然な表記で書く。'}]},
      contents:[{role:'user',parts}],generationConfig:{candidateCount:1,maxOutputTokens:512,thinkingConfig:{thinkingLevel:'MINIMAL',includeThoughts:false},responseMimeType:'application/json',
        responseSchema:{type:'OBJECT',properties:{speak:{type:'BOOLEAN'},summary:{type:'STRING'},turns:{type:'ARRAY',minItems:turnCount,maxItems:turnCount,items:{type:'OBJECT',properties:{speakerId:{type:'STRING',enum:s.profiles.map(p=>p.id)},text:{type:'STRING'},speechText:{type:'STRING'}},required:['speakerId','text','speechText']}}},required:['speak','summary','turns']}}};
  }
  async function playGreetingTurns(turns,s,signal,label){
    const items=turns.map(turn=>({turn,profile:s.profiles.find(p=>p.id===turn.speakerId)})).filter(x=>x.profile);
    const delivered=({turn,profile})=>{
      recordSpeaker(profile);
      $('delivery').textContent=s.output==='bouyomi'?'棒読みちゃんへ順番に送信済み（PC側の再生完了は未確認）':'このブラウザで再生しました';
      log(`${label}・${profile.name}: ${turn.text}`,'spoken');
    };
    if(!items.length)return;
    if(s.output==='voicevox'){
      let audio=await generateVoicevoxAudio(spokenText(items[0].turn),{...s,...items[0].profile},null,signal);
      for(let i=0;i<items.length;i++){
        const item=items[i],next=items[i+1];
        setStatus(next?`${label}を再生中・次の音声を先読み中`:`${label}を再生中`);
        const overlayEpoch=await showObsOverlay(item.profile,item.turn,s,signal);
        setSpeakerActivity(item.profile,'発話中');const playback=playVoicevoxAudio(audio,{...s,...item.profile},null,signal,()=>{showLatestComment(item.profile,item.turn);$('delivery').textContent='このブラウザで再生中';});
        let prefetch=null,prefetchController=null,unlink=null;
        if(next){
          prefetchController=new AbortController();
          const abort=()=>prefetchController.abort();signal.addEventListener('abort',abort,{once:true});unlink=()=>signal.removeEventListener('abort',abort);
          prefetch=generateVoicevoxAudio(spokenText(next.turn),{...s,...next.profile},null,prefetchController.signal).then(value=>({value}),error=>({error}));
        }
        try{await playback;}catch(e){prefetchController?.abort();unlink?.();if(overlayEpoch===obsOverlayEpoch)clearObsOverlayNow();throw e;}finally{clearSpeakerActivity(item.profile.id);}
        delivered(item);scheduleObsOverlayHide(s,overlayEpoch);
        if(prefetch){const prepared=await prefetch;unlink?.();if(prepared.error)throw prepared.error;audio=prepared.value;}
      }
    }else{
      for(let i=0;i<items.length;i++){const item=items[i];setStatus(`${label}を送信中`);setSpeakerActivity(item.profile,'送信中');let sent=false;try{sent=await speak(spokenText(item.turn),{...s,...item.profile},null,signal,true);}finally{clearSpeakerActivity(item.profile.id);}if(!sent)throw new C.AppError(`${label}を読み上げ先へ送信できませんでした。`,'VOICE');showLatestComment(item.profile,item.turn);$('delivery').textContent='棒読みちゃんへ送信済み（PC側の再生開始は未確認）';const overlayEpoch=await showObsOverlay(item.profile,item.turn,s,signal);delivered(item);scheduleObsOverlayHide(s,overlayEpoch);}
    }
  }
  function fallbackGreetingTurns(kind,s,turnCount){
    const start=['ちょっと楽しみだね','さて、どんな感じかな','のんびり見てよっか','今日は何があるかな','気楽にいこうか','ちょっと気になるね','いい感じにいこう','ま、ゆるく見よっか','何が来るかな','楽しめるといいね'];
    const end=['いい余韻だったね','ここで一区切りかな','続きも気になるね','なかなか面白かったね','今日はいい感じだった','この先も気になるな','ひとまずここまでかな','いいところで切れたね','今日は満足だね','余韻残るね'];
    const pool=[...(kind==='end'?end:start)];
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    return s.profiles.slice(0,turnCount).map((profile,i)=>({speakerId:profile.id,text:pool[i%pool.length]}));
  }
  async function greeting(kind,runtime,signal,{tolerateFailure=false}={}){
    const s=runtime.s,key=runtime.key,label=kind==='end'?'終了の挨拶':'開始の挨拶';
    try{
      const turnCount=C.pickWeightedSpeakerCount(s.speakerCountWeights,s.profiles.length);
      let result=null;
      for(let attempt=1;attempt<=2;attempt++){
        try{
          const payload=greetingPayload(kind,s,runtime.history,turnCount);
          reserve(s);setStatus(`${label}を生成中`);log(`Geminiへ${label}を依頼（${stats.used}回・今回の発言人数${turnCount}人${attempt>1?'・応答形式を再生成':''}）。`);
          const body=await C.deadline(token=>C.gemini(key,payload,token),60000,signal,`${label}の生成がタイムアウトしました。`);
          result=C.parseAnalysis(body,s.profiles,turnCount,true);
          if(result.turns.length!==turnCount)throw new C.AppError(`${label}の人数が指定と一致しません。`,'RESPONSE');
          break;
        }catch(e){
          C.check(signal);
          if(e instanceof C.AppError&&e.code==='RESPONSE'){
            if(attempt===1){
              log(`${label}の応答形式が条件を満たさなかったため、1回だけ再生成します。`,'warn');
              continue;
            }
            result={speak:true,summary:`${label}フォールバック`,turns:fallbackGreetingTurns(kind,s,turnCount)};
            log(`${label}の生成結果が2回とも不正だったため、固定の短い挨拶で続行します。`,'warn');
            break;
          }
          throw e;
        }
      }
      await playGreetingTurns(result.turns,s,signal,label);recordGreetingHistory(kind,result.turns);
    }catch(e){
      C.check(signal);
      log(`${label}を省略: ${e instanceof C.AppError?e.message:'生成または再生に失敗しました。'}`,'warn');
      if(!tolerateFailure)throw e;
    }
  }
  async function connectObs(s,signal) {
    if(!s.sourceName){revealSetting('sourceName');throw new C.AppError('OBSの映像ソース名を入力してください。');}
    setStatus('OBSに接続中'); obs=new C.ObsClient(); await obs.connect(s.obsUrl,$('obsPassword').value,signal);obsOverlayFaulted=false;obsOverlayTarget=null;
    await resetObsOverlayScene(signal);
    log('OBSへの接続完了。');
  }
  async function analyze(frames,s,key,history,spoken,speakerHistory,state,signal,quietMode=false) {
    const current=frames[frames.length-1];
    const turnCount=C.pickWeightedSpeakerCount(s.speakerCountWeights,s.profiles.length);
    const analysisSettings={...s,turnCount,quietMode,recentSpeakerIds:[...speakerHistory,...state.activeSpeakerIds].slice(-8)};
    const recentConversation=s.conversationHistoryCount>0
      ? spoken.slice(-s.conversationHistoryCount)
      : [];
    const remaining=current.capturedAt+s.freshness*1000-performance.now();
    if(remaining<=0) throw new C.AppError('画像取得中に鮮度上限に達しました。','STALE');
    const payload=C.makePayload(frames,analysisSettings,history,recentConversation);reserve(s);const began=performance.now();
    setStatus(state.speaking?'読み上げ中・裏でGemini解析中':'Geminiの応答待ち');
    log(`Geminiへ画像${frames.length}枚を送信（${stats.used}回・今回の発言人数${turnCount}人・${quietMode?'雑談モード':'通常実況'}・鮮度上限${s.freshness}秒）。`);
    const response=await C.deadline(token=>C.gemini(key,payload,token),Math.min(180000,remaining),signal,'鮮度上限に達したためGeminiの応答待ちを打ち切りました。','STALE');
    const duration=(performance.now()-began)/1000;$('latency').textContent=duration.toFixed(1)+' 秒';log(`Gemini応答 ${duration.toFixed(1)}秒。`);
    checkFresh(current,s);return C.parseAnalysis(response,s.profiles,turnCount);
  }
  async function waitForSettings(signal,{autoResumeObsSource=false}={}) {
    C.check(signal); $('resume').hidden=false;
    for(const el of document.querySelectorAll('#settings input,#settings select,#settings textarea,#panel-friends input,#panel-friends select,#panel-friends textarea'))el.disabled=false;
    setStatus('設定の修正待ち（修正後に再開できます）',true);
    try { return await new Promise((resolve,reject)=>{
      const stop=()=>{resumeAction=null;reject(C.abortError());};
      signal.addEventListener('abort',stop,{once:true});
      resumeAction=async()=>{
        $('resume').disabled=true;
        try {
          const s=settings(),key=requireKey();validateEndpoints(s);await unlockAudio(s);C.check(signal);
          save(s);lastSettings=s;signal.removeEventListener('abort',stop);resumeAction=null;resolve({s,key});
        } catch(e){if(!signal.aborted)log(e instanceof C.AppError?e.message:'設定を確認してください。','warn');}
        finally{$('resume').disabled=false;}
      };
      if(autoResumeObsSource&&obsSourceFailurePending&&obsSourceRecoveryReady){
        log('映像ソースは復旧済みのため、実況を自動再開します。');
        queueMicrotask(()=>resumeAction?.());
      }
    }); } finally { $('resume').hidden=true;resumeAction=null;setBusy(true); }
  }
  function validateEndpoints(s){
    if(!s.sourceName){revealSetting('sourceName');throw new C.AppError('OBSの映像ソース名を入力してください。');}
    try{C.localUrl(s.obsUrl,'ws:');}catch(e){revealSetting('obsUrl');throw e;}
    const id=s.output==='bouyomi'?'bouyomiUrl':'voicevoxUrl';try{C.localUrl(s[id],'http:');}catch(e){revealSetting(id);throw e;}
  }
  async function waitRecovery(ms,signal,label='自動再開まで'){
    const until=performance.now()+ms;
    while(performance.now()<until){
      C.check(signal);setStatus(`${label} ${Math.ceil((until-performance.now())/1000)}秒`);
      await C.sleep(Math.min(1000,until-performance.now()),signal);
    }
  }
  function retryHintNote(error){
    if(error?.code!=='429'||!Number.isFinite(error.retryAfter)||error.retryAfter<=0)return '';
    const seconds=Math.ceil(error.retryAfter/1000),source=error.retrySource||'サーバー';
    return error.retryAfter>300000
      ? ` ${source}の待機指示は約${seconds}秒ですが、配信継続のため自動再試行は最大300秒間隔に制限します。`
      : ` ${source}の待機指示は約${seconds}秒です。`;
  }
  async function captureLoop(s,state,signal) {
    const interval=s.sampleInterval*1000;
    let nextCaptureAt=performance.now();
    while(true) {
      C.check(signal);
      const wait=nextCaptureAt-performance.now();
      if(wait>0)await C.sleep(wait,signal);
      const startedAt=performance.now();
      nextCaptureAt=startedAt+interval;
      const frame=await getFrame(s,signal);
      state.frames.push(frame);while(state.frames.length>s.analysisFrameCount)state.frames.shift();
      state.frameVersion++;
    }
  }
  function candidateSkipReason(candidate,s,spoken) {
    const age=performance.now()-candidate.frame.capturedAt;
    if(age>=s.freshness*1000)return '鮮度上限を超過';
    if(!candidate.result.speak)return 'AIが発言不要と判断';
    if(candidate.result.turns.every(t=>spoken.slice(-12).includes(t.text)))return '直近と同じ発言';
    return '';
  }
  async function analysisLoop(s,key,state,history,spoken,speakerHistory,signal) {
    let shownBufferCount=-1;
    while(true) {
      C.check(signal);
      if(state.frames.length<s.analysisFrameCount) {
        if(shownBufferCount!==state.frames.length){
          shownBufferCount=state.frames.length;
          if(!state.speaking)setStatus(`映像履歴を準備中 ${state.frames.length}/${s.analysisFrameCount}`);
        }
        await C.sleep(100,signal);continue;
      }
      if(shownBufferCount!==s.analysisFrameCount){
        shownBufferCount=s.analysisFrameCount;if(!state.speaking)setStatus('映像監視中');
      }
      const frames=state.frames.slice(),current=frames[frames.length-1],previous=frames[frames.length-2];
      const elapsed=(performance.now()-state.lastAnalysis)/1000,motionValue=motion(previous.pixels,current.pixels);
      if(current.capturedAt<=state.lastAnalyzedFrameAt ||
         !C.shouldAnalyze(elapsed,motionValue,s.apiInterval,s.quietInterval)) {
        await C.sleep(100,signal);continue;
      }
      const lowMotionDue=state.lastAnalysis!==-Infinity&&motionValue<.07&&elapsed>=Math.max(s.apiInterval,s.quietInterval);
      if(motionValue>=.07)state.quietSceneStreak=0;
      else if(lowMotionDue)state.quietSceneStreak=(state.quietSceneStreak||0)+1;
      const quietMode=lowMotionDue&&state.quietSceneStreak>=2;
      state.lastAnalysis=performance.now();state.lastAnalyzedFrameAt=current.capturedAt;state.analysisInFlight=true;
      const speechEpochAtStart=state.speechEpoch,startedDuringSpeech=state.speaking;
      try {
        const result=await analyze(frames,s,key,history,spoken,speakerHistory,state,signal,quietMode);
        state.rateLimitStreak=0;
        state.analysisVersion++;
        if(result.summary){history.push(result.summary);if(history.length>6)history.shift();}
        const candidate={result,frame:current,version:state.analysisVersion,prefetchedDuringSpeech:startedDuringSpeech||state.speaking||state.speechEpoch!==speechEpochAtStart};
        const reason=candidateSkipReason(candidate,s,spoken);
        const hadPending=!!state.pending;
        state.pending=null;
        if(reason){
          log(`見送り（${reason}）: ${result.summary}`);
          if(reason==='AIが発言不要と判断'&&!state.speaking)setStatus('AIが今回は発言なしと判断');
        } else {
          state.pending=candidate;
          log(hadPending?'次の発言候補を最新の解析結果に更新しました。':'次の発言候補を先読みしました。');
        }
      } catch(e) {
        C.check(signal);
        if(!(e instanceof C.AppError)||C.needsSettings(e))throw e;
        if(e.code==='STALE'){
          stats.stale++;updateStats();log(e.message,'warn');$('latency').textContent='鮮度切れ';
          state.lastAnalysis=-Infinity;
          setStatus('鮮度切れ・最新映像で再解析中');
        } else {
          if(e.code==='429')state.rateLimitStreak=(state.rateLimitStreak||0)+1;
          else state.rateLimitStreak=0;
          log(e.message,'warn');
          const delay=C.recoveryDelay(e,state.rateLimitStreak);
          const note=retryHintNote(e);
          log(`${Math.ceil(delay/1000)}秒待機し、その間も映像取得と読み上げを継続して最新映像で再開します。停止ボタンで終了できます。${note}`,'warn');
          await waitRecovery(delay,signal,e.code==='429'?'頻度制限・再試行まで':'自動再開まで');
          state.lastAnalysis=-Infinity;
        }
      } finally {
        state.analysisInFlight=false;
        if(!state.speaking&&!$('status').textContent.startsWith('鮮度切れ・'))setStatus(state.pending?'次の発言候補を待機中':'映像監視中');
      }
    }
  }
  async function waitForSpeakableCandidate(candidate,s,state,spoken,signal) {
    while(true) {
      C.check(signal);
      if(state.pending&&state.pending.version>candidate.version){
        candidate=state.pending;state.pending=null;
        log('発言待ちの候補を、より新しい解析結果に差し替えました。');
      } else if(state.analysisVersion>candidate.version&&!state.pending) {
        log('見送り（より新しい解析で発言不要）');
        return null;
      }
      const reason=candidateSkipReason(candidate,s,spoken);
      if(reason){if(reason==='鮮度上限を超過'){stats.stale++;updateStats();$('latency').textContent='鮮度切れ';}log(`見送り（${reason}）: ${candidate.result.summary}`);return null;}
      const wait=candidate.prefetchedDuringSpeech||state.lastConversationStart===-Infinity?0:state.lastConversationStart+s.speechInterval*1000-performance.now();
      if(wait<=0)return candidate;
      const freshLeft=candidate.frame.capturedAt+s.freshness*1000-performance.now();
      if(freshLeft<=0){stats.stale++;updateStats();$('latency').textContent='鮮度切れ';log(`見送り（発言待ち中に鮮度上限を超過）: ${candidate.result.summary}`);return null;}
      setStatus(state.analysisInFlight?'次の発言候補を待機中・裏でGemini解析中':'次の発言候補を待機中');
      await C.sleep(Math.min(100,wait,freshLeft),signal);
    }
  }
  async function playAnalysisCandidate(candidate,s,state,spoken,speakerHistory,signal) {
    const current=candidate.frame,result=candidate.result;
    const seen=new Set(spoken.slice(-12)),turns=[];
    for(const turn of result.turns){
      if(seen.has(turn.text))continue;
      const profile=s.profiles.find(p=>p.id===turn.speakerId);if(!profile)continue;
      seen.add(turn.text);turns.push({turn,profile});
    }
    if(!turns.length)return false;
    state.activeTurnTexts=turns.map(x=>x.turn.text);state.activeSpeakerIds=turns.map(x=>x.turn.speakerId);state.speechEpoch++;
    let conversationStarted=false;
    const delivered=(turn,profile)=>{
      conversationStarted=true;state.lastSpeech=performance.now();spoken.push(turn.text);if(spoken.length>20)spoken.shift();
      speakerHistory.push(turn.speakerId);if(speakerHistory.length>20)speakerHistory.shift();
      recordSpeaker(profile);
      $('delivery').textContent=s.output==='bouyomi'?'棒読みちゃんへ順番に送信済み（PC側の再生完了は未確認）':'このブラウザで再生しました';
      log(`${profile.name}: ${turn.text}`,'spoken');
    };
    state.speaking=true;
    try{
      if(s.output==='voicevox'){
        let item=turns[0];setStatus(state.analysisInFlight?'VOICEVOXの音声生成中・裏でGemini解析中':'VOICEVOXの音声生成中');
        let audio=await generateVoicevoxAudio(spokenText(item.turn),{...s,...item.profile},current,signal);
        for(let i=0;i<turns.length;i++){
          C.check(signal);item=turns[i];const next=turns[i+1];
          if(i===0){checkFresh(current,s);state.lastConversationStart=performance.now();}
          const suffix=state.analysisInFlight?'・裏でGemini解析中':'';
          setStatus((next?'VOICEVOX再生中・次の音声を先読み中':'VOICEVOXの音声再生中')+suffix);
          const overlayEpoch=await showObsOverlay(item.profile,item.turn,s,signal);
          setSpeakerActivity(item.profile,'発話中');const playback=playVoicevoxAudio(audio,{...s,...item.profile},i===0?current:null,signal,()=>{showLatestComment(item.profile,item.turn);$('delivery').textContent='このブラウザで再生中';});
          let prefetch=null,prefetchController=null,unlink=null;
          if(next){
            prefetchController=new AbortController();
            const abort=()=>prefetchController.abort();signal.addEventListener('abort',abort,{once:true});unlink=()=>signal.removeEventListener('abort',abort);
            prefetch=generateVoicevoxAudio(spokenText(next.turn),{...s,...next.profile},null,prefetchController.signal).then(value=>({value}),error=>({error}));
          }
          try{await playback;}catch(e){prefetchController?.abort();unlink?.();if(overlayEpoch===obsOverlayEpoch)clearObsOverlayNow();throw e;}finally{clearSpeakerActivity(item.profile.id);}
          delivered(item.turn,item.profile);scheduleObsOverlayHide(s,overlayEpoch);
          if(prefetch){const prepared=await prefetch;unlink?.();if(prepared.error)throw prepared.error;audio=prepared.value;}
        }
      }else{
        for(const {turn,profile} of turns){
          C.check(signal);setStatus(state.analysisInFlight?'棒読みちゃんへ送信中・裏でGemini解析中':'棒読みちゃんへ送信中');
          setSpeakerActivity(profile,'送信中');let sent=false;try{sent=await speak(spokenText(turn),{...s,...profile},conversationStarted?null:current,signal,conversationStarted);}finally{clearSpeakerActivity(profile.id);}if(!sent)break;
          if(!conversationStarted)state.lastConversationStart=performance.now();
          showLatestComment(profile,turn);$('delivery').textContent='棒読みちゃんへ送信済み（PC側の再生開始は未確認）';
          const overlayEpoch=await showObsOverlay(profile,turn,s,signal);
          delivered(turn,profile);scheduleObsOverlayHide(s,overlayEpoch);
        }
      }
      return conversationStarted;
    } finally {
      activeSpeakerId=null;activeSpeakerMode='';renderSpeakerStats();state.speaking=false;state.activeTurnTexts=[];state.activeSpeakerIds=[];
    }
  }
  async function speechLoop(s,state,spoken,speakerHistory,signal) {
    while(true){
      C.check(signal);
      if(!state.pending){if(!state.analysisInFlight&&state.frames.length>=s.analysisFrameCount)setStatus('映像監視中');await C.sleep(100,signal);continue;}
      let candidate=state.pending;state.pending=null;
      candidate=await waitForSpeakableCandidate(candidate,s,state,spoken,signal);
      if(!candidate)continue;
      try{
        await playAnalysisCandidate(candidate,s,state,spoken,speakerHistory,signal);
      }catch(e){
        C.check(signal);
        if(e instanceof C.AppError&&e.code==='STALE'){
          stats.stale++;updateStats();log(e.message,'warn');$('latency').textContent='鮮度切れ';continue;
        }
        if(!(e instanceof C.AppError)||C.needsSettings(e))throw e;
        const delay=C.recoveryDelay(e);log(`読み上げエラー: ${e.message} ${Math.ceil(delay/1000)}秒後に再開します。`,'warn');
        await C.sleep(delay,signal);
      }finally{
        state.speaking=false;if(!state.analysisInFlight)setStatus(state.pending?'次の発言候補を待機中':'映像監視中');
      }
    }
  }
  async function run(runtime,signal) {
    let {s,key}=runtime;const {history,spoken,speakerHistory,state}=runtime;
    while(true) {
      C.check(signal);
      try {
        if(!obs?.ready){obs?.close();await connectObs(s,signal);}
        state.frames.length=0;state.pending=null;state.analysisInFlight=false;state.speaking=false;state.activeTurnTexts=[];state.activeSpeakerIds=[];
        state.lastAnalysis=-Infinity;state.lastAnalyzedFrameAt=-Infinity;
        const session=new AbortController();
        const stop=()=>session.abort();signal.addEventListener('abort',stop,{once:true});
        const capture=captureLoop(s,state,session.signal);
        const analysis=analysisLoop(s,key,state,history,spoken,speakerHistory,session.signal);
        const speech=speechLoop(s,state,spoken,speakerHistory,session.signal);
        try {
          await Promise.race([capture,analysis,speech]);
          throw new C.AppError('監視処理が予期せず終了しました。','NETWORK');
        } finally {
          session.abort();signal.removeEventListener('abort',stop);
          await Promise.allSettled([capture,analysis,speech]);
        }
      } catch(e) {
        C.check(signal);
        if(e.code==='STALE'){
          stats.stale++;updateStats();log(e.message,'warn');$('latency').textContent='鮮度切れ';
        } else log(e instanceof C.AppError?e.message:'処理に失敗しました。設定と接続を確認してください。','warn');
        if(!(e instanceof C.AppError)||C.needsSettings(e)){
          const obsSourceFailure=e instanceof C.AppError&&e.code==='OBS_SOURCE';
          obs?.close();obs=null;({s,key}=await waitForSettings(signal,{autoResumeObsSource:obsSourceFailure}));runtime.s=s;runtime.key=key;
          if(obsSourceFailure){obsSourceFailurePending=false;obsSourceRecoveryReady=false;}
        }else if(e.code==='STALE'){
          setStatus('鮮度切れ・最新映像で再解析中');
        }else{
          obs?.close();obs=null;
          const delay=C.recoveryDelay(e);
          log(`${Math.ceil(delay/1000)}秒待機し、OBSへ再接続して再開します。停止ボタンで終了できます。`,'warn');
          await waitRecovery(delay,signal);
        }
        state.frames.length=0;state.pending=null;state.analysisInFlight=false;state.speaking=false;state.activeTurnTexts=[];state.activeSpeakerIds=[];
        state.lastAnalysis=-Infinity;state.lastAnalyzedFrameAt=-Infinity;
      }
    }
  }
  async function operation(fn) {
    if(busy)return;
    controller=new AbortController();const signal=controller.signal;setBusy(true);let failed=false;
    try {await fn(signal);}
    catch(e){if(signal.aborted || e.name==='AbortError')log('停止しました。');else{failed=true;log('停止: '+(e instanceof C.AppError?e.message:'処理に失敗しました。接続先やブラウザの状態を確認してください。'),'warn');}}
    finally{clearObsOverlayNow();obs?.close();obs=null;activeAudio?.stop();activeAudio=null;await wakeLock?.release().catch(()=>{});wakeLock=null;controller=null;finishAction=null;streaming=false;lastCaptureAt=null;setBusy(false);setStatus(failed?'エラーで停止・履歴を確認してください':'停止中',failed);$('elapsed').textContent='';}
  }
  $('start').addEventListener('click',()=>operation(async signal=>{
    lastCaptureAt=null;const s=settings(),key=requireKey();validateEndpoints(s);
    await unlockAudio(s);save(s);lastSettings=s;stats.used=0;stats.stale=0;updateStats();resetSpeakerStats();$('latency').textContent='—';
    const runtime={s,key,history:[],spoken:[],speakerHistory:[],state:{frames:[],frameVersion:0,pending:null,analysisVersion:0,speechEpoch:0,analysisInFlight:false,speaking:false,activeTurnTexts:[],activeSpeakerIds:[],rateLimitStreak:0,quietSceneStreak:0,lastAnalysis:-Infinity,lastSpeech:-Infinity,lastConversationStart:-Infinity,lastAnalyzedFrameAt:-Infinity}};
    streaming=true;$('finish').disabled=true;updateObsRefreshButton();
    log(`開始: ${C.MODEL}・最短${s.apiInterval}秒・鮮度${s.freshness}秒。今回のカウントを0にしました。`);
    try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
    if(s.greetStart&&s.obsOverlayEnabled&&!obs?.ready)await connectObs(s,signal);
    if(s.greetStart)await greeting('start',runtime,signal,{tolerateFailure:true});
    const runController=new AbortController();let finishing=false;
    const stopRun=()=>runController.abort();signal.addEventListener('abort',stopRun,{once:true});
    finishAction=()=>{if(finishing||signal.aborted)return;finishing=true;$('finish').disabled=true;setStatus('実況終了の準備中');runController.abort();};$('finish').disabled=false;
    try{await run(runtime,runController.signal);}
    catch(e){if(!(finishing&&e.name==='AbortError'))throw e;}
    finally{signal.removeEventListener('abort',stopRun);}
    if(!finishing)return;
    C.check(signal);lastCaptureAt=null;
    runtime.s=runtime.s||s;runtime.key=runtime.key||key;lastSettings=runtime.s;
    if(runtime.s.greetEnd&&runtime.s.obsOverlayEnabled&&!obs?.ready){
      try{await connectObs(runtime.s,signal);}catch(e){log('終了挨拶のOBS吹き出し接続を省略: '+(e instanceof C.AppError?e.message:'OBSへ再接続できませんでした。'),'warn');}
    }
    if(runtime.s.greetEnd)await greeting('end',runtime,signal,{tolerateFailure:true});
    log('実況を通常終了しました。');
  }));
  $('resume').addEventListener('click',()=>resumeAction?.());
  $('finish').addEventListener('click',()=>finishAction?.());
  $('stop').addEventListener('click',()=>{clearObsOverlayNow();controller?.abort();obs?.close();try{activeAudio?.stop();}catch{}setStatus('即停止処理中');if(lastSettings?.output==='bouyomi')log('新しい送信を即停止します。棒読みちゃんに送信済みの音声は、必要なら棒読みちゃん側で停止してください。');});
  async function refreshObsSource(s,signal){
    setStatus('OBS映像ソースを再取得中');
    await obs.request('SetInputSettings',{inputName:s.sourceName,inputSettings:{},overlay:true},signal,{errorCode:'OBS_SOURCE',errorMessage:'OBS映像ソースの再取得に失敗しました'});
    await C.sleep(300,signal);setStatus('再取得後の映像を確認中');await getFrame(s,signal);
    log(`映像ソース「${s.sourceName}」を再取得し、映像を確認しました。`);
  }
  $('testObs').addEventListener('click',()=>operation(async signal=>{const s=settings();await connectObs(s,signal);setStatus('OBSの画像取得中');await getFrame(s,signal);log('映像確認完了。Geminiへの送信はありません。');}));
  $('resetObsSource').addEventListener('click',async()=>{
    if(streaming&&controller){
      const button=$('resetObsSource');button.disabled=true;
      try{
        const s=lastSettings||settings(),signal=controller.signal;
        if(!obs?.ready){obs?.close();await connectObs(s,signal);}
        await refreshObsSource(s,signal);
        if(obsSourceFailurePending)obsSourceRecoveryReady=true;
        if(resumeAction){
          log('映像ソースの再取得に成功したため、実況を自動再開します。');
          await resumeAction();
        }
      }catch(e){
        if(e.name!=='AbortError')log('映像ソース再取得: '+(e instanceof C.AppError?e.message:'処理に失敗しました。'),'warn');
      }finally{updateObsRefreshButton();}
      return;
    }
    operation(async signal=>{const s=settings();await connectObs(s,signal);await refreshObsSource(s,signal);});
  });
  $('testObsOverlay').addEventListener('click',()=>operation(async signal=>{
    const s=settings();if(!s.obsOverlayEnabled){revealSetting('obsOverlayEnabled');throw new C.AppError('「OBSにコメントを表示」をONにしてからテストしてください。');}
    await connectObs(s,signal);const profile=s.profiles[0];setStatus('OBSコメント表示をテスト中');
    const epoch=await showObsOverlay(profile,{text:'こんな感じでコメントが表示されるよ！'},s,signal,{strict:true});
    log(`OBS吹き出し表示テスト: 「${obsOverlaySourceName}」を現在シーンに表示しました。`);
    await C.sleep(2500,signal);if(epoch===obsOverlayEpoch)clearObsOverlayNow();
  }));
  $('testVoice').addEventListener('click',()=>operation(async signal=>{const s=settings();lastSettings=s;await unlockAudio(s);setStatus('音声テスト中');const ok=await speak('こんにちは。音声テストです。',s,null,signal);if(ok)log(s.output==='bouyomi'?'棒読みちゃんへの音声テスト送信完了。実際に聞こえるか確認してください。':'音声テスト再生完了。');}));
  $('testText').addEventListener('click',()=>operation(async signal=>{
    const s=settings(),key=requireKey();reserve(s);setStatus('Gemini接続テスト中');const began=performance.now();log(`文章だけの接続テストを送信（${stats.used}回）。`);
    const body=await C.deadline(token=>C.gemini(key,{contents:[{role:'user',parts:[{text:'日本語で「接続できました」とだけ答えて。'}]}],generationConfig:{maxOutputTokens:64,thinkingConfig:{thinkingLevel:'MINIMAL',includeThoughts:false}}},token),180000,signal,'Gemini接続テストが180秒でタイムアウトしました。');
    C.candidateText(body);const seconds=(performance.now()-began)/1000;$('latency').textContent=seconds.toFixed(1)+' 秒';log(`文章だけの応答を受信: ${seconds.toFixed(1)}秒。画像解析・音声再生は行っていません。`);
  }));
  $('save').addEventListener('click',()=>{try{const s=settings();save(s);updateStats();}catch(e){log(e.message,'warn');}});
  $('exportSettings').addEventListener('click',()=>{try{exportSettings();}catch(e){$('saveState').textContent=e.message;log(e.message,'warn');}});
  $('importSettings').addEventListener('click',()=>{$('importSettingsFile').click();});
  $('importSettingsFile').addEventListener('change',async e=>{const file=e.target.files?.[0];e.target.value='';try{await importSettingsFile(file);}catch(error){$('saveState').textContent=error.message||'設定のインポートに失敗しました。';log(error.message||'設定のインポートに失敗しました。','warn');}});
  $('preset').addEventListener('click',()=>{for(const [id,value] of Object.entries({talkativeness:2,apiInterval:30,speechInterval:20,quietInterval:60}))$(id).value=value;updateSettingSummaries();log('よく話す設定を適用しました。「設定を保存」または「実況を開始」で保存します。');});
  $('clearLog').addEventListener('click',()=>$('log').replaceChildren());$('output').addEventListener('change',outputFields);$('obsOverlayEnabled').addEventListener('change',overlayFields);
  $('manageContents').addEventListener('click',openContentDialog);
  $('closeContentDialog').addEventListener('click',closeContentDialog);
  $('doneContentDialog').addEventListener('click',closeContentDialog);
  $('addContent').addEventListener('click',addContent);
  $('newContentName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addContent();}});
  $('contentManageList').addEventListener('click',e=>{const knowledge=e.target.closest('[data-content-knowledge]');if(knowledge){openContentKnowledgeEditor(knowledge.dataset.contentKnowledge);return;}const child=e.target.closest('[data-content-name]');if(child){deleteContent(child.dataset.contentName);return;}const main=e.target.closest('[data-content-main]');if(main)deleteContentMain(main.dataset.contentMain);});
  $('saveContentKnowledge').addEventListener('click',saveContentKnowledgeEditor);
  $('closeContentKnowledge').addEventListener('click',closeContentKnowledgeEditor);
  $('contentDialog').addEventListener('click',e=>{if(e.target===$('contentDialog'))closeContentDialog();});
  $('manageFonts').addEventListener('click',openFontDialog);
  $('closeFontDialog').addEventListener('click',closeFontDialog);
  $('doneFontDialog').addEventListener('click',closeFontDialog);
  $('addFont').addEventListener('click',addFont);
  $('newFontName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addFont();}});
  $('fontManageList').addEventListener('click',e=>{const button=e.target.closest('[data-font-name]');if(button)deleteFont(button.dataset.fontName);});
  $('fontDialog').addEventListener('click',e=>{if(e.target===$('fontDialog'))closeFontDialog();});
  const helpDialog=$('helpDialog');
  const openHelpDialog=()=>{if(typeof helpDialog.showModal==='function')helpDialog.showModal();else helpDialog.setAttribute('open','');};
  const closeHelpDialog=()=>{if(typeof helpDialog.close==='function'&&helpDialog.open)helpDialog.close();else helpDialog.removeAttribute('open');};
  $('openHelp').addEventListener('click',openHelpDialog);
  $('closeHelpDialog').addEventListener('click',closeHelpDialog);
  $('doneHelpDialog').addEventListener('click',closeHelpDialog);
  helpDialog.addEventListener('click',e=>{if(e.target===helpDialog)closeHelpDialog();});
  $('apiKey').addEventListener('input',()=>{$('freeTier').checked=false;});$('settings').addEventListener('submit',e=>e.preventDefault());
  setInterval(()=>{
    if(!busy){$('elapsed').textContent='';return;}
    if(lastCaptureAt!==null){$('elapsed').textContent=`最終取得 ${((performance.now()-lastCaptureAt)/1000).toFixed(1)}秒前`;return;}
    $('elapsed').textContent=`経過 ${Math.floor((performance.now()-phaseAt)/1000)}秒`;
  },200);
  document.addEventListener('visibilitychange',()=>{if(busy&&document.hidden)log('タブが非表示になりました。ブラウザの節電で間隔が延びる場合があります。','warn');});
  window.addEventListener('pagehide',()=>{pageEpoch++;lockSecrets();controller?.abort();obs?.close();try{activeAudio?.stop();}catch{}});
  const tabsBar=document.querySelector('.tabs');
  let stickyTabsFrame=0;
  function updateStickyTabsState(){
    stickyTabsFrame=0;
    if(innerWidth>900){tabsBar.classList.remove('is-stuck');return;}
    const styles=getComputedStyle(document.documentElement);
    const toolbarHeight=parseFloat(styles.getPropertyValue('--toolbar-height'))||0;
    const previewHeight=parseFloat(styles.getPropertyValue('--preview-sticky-height'))||0;
    tabsBar.classList.toggle('is-stuck',tabsBar.getBoundingClientRect().top<=toolbarHeight+previewHeight+1);
  }
  function scheduleStickyTabsState(){
    if(stickyTabsFrame)return;
    stickyTabsFrame=requestAnimationFrame(updateStickyTabsState);
  }
  new ResizeObserver(entries=>{document.documentElement.style.setProperty('--toolbar-height',`${entries[0].target.getBoundingClientRect().height}px`);scheduleStickyTabsState();}).observe(document.querySelector('.toolbar'));
  new ResizeObserver(entries=>{document.documentElement.style.setProperty('--preview-sticky-height',`${entries[0].target.getBoundingClientRect().height}px`);scheduleStickyTabsState();}).observe(document.querySelector('.preview-sticky'));
  addEventListener('scroll',scheduleStickyTabsState,{passive:true});
  addEventListener('resize',scheduleStickyTabsState,{passive:true});
  scheduleStickyTabsState();
  function selectTab(name,focus=false){
    for(const tab of document.querySelectorAll('[role=tab]')){
      const selected=tab.id===`tab-${name}`;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
      $(tab.getAttribute('aria-controls')).hidden=!selected;if(selected&&focus)tab.focus();
    }
    document.querySelector('.panel-scroll').scrollTop=0;
  }
  for(const tab of document.querySelectorAll('[role=tab]')){
    tab.addEventListener('click',()=>selectTab(tab.id.slice(4)));
    tab.addEventListener('keydown',e=>{
      const tabs=[...document.querySelectorAll('[role=tab]')];let n=tabs.indexOf(tab);
      if(e.key==='ArrowRight')n=(n+1)%tabs.length;else if(e.key==='ArrowLeft')n=(n+tabs.length-1)%tabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=tabs.length-1;else return;
      e.preventDefault();selectTab(tabs[n].id.slice(4),true);
    });
  }
  function defaultProfile(i){return {id:`p${i+1}`,name:`友達${i+1}`,personality:['気さくで明るい。感想と応援が多い。','落ち着いていて、軽いツッコミが得意。','好奇心旺盛。景色や細部に気づく。','リアクションが大きくノリがいい。驚きや盛り上がりを素直に出す。','冷静な分析好き。状況整理や先の予想を短く口にする。','マイペースで少し天然。独特な着眼点で一言を挟む。'][i],speaker:i%2===0?3:2,speedScale:1.0,bouyomiVoice:0};}
  function buildProfiles(saved=[]){
    for(let i=0;i<6;i++){
      const d={...defaultProfile(i),...saved[i]},section=document.createElement('section');section.className='card friend';section.dataset.index=i;
      const heading=document.createElement('h2');heading.textContent=`友達 ${i+1}`;section.append(heading);
      const voiceGrid=document.createElement('div');voiceGrid.className='friend-voice-grid';
      for(const [field,label,type,min,max,step] of [['name','呼び名','text',null,40,null],['personality','性格・話し方','text',null,300,null],['speaker','VOICEVOX スタイルID','number',0,99999,1],['speedScale','VOICEVOX 話速','number',0.5,2,0.05],['bouyomiVoice','棒読みちゃん 声ID','number',0,65535,1]]){
        const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.id=`p${i+1}-${field}`;input.type=type;input.setAttribute('form','settings');
        if(type==='number'){input.min=min;input.max=max;input.step=step;}else input.maxLength=max;
        input.value=typeof d[field]==='string'||typeof d[field]==='number'?d[field]:defaultProfile(i)[field];
        if(field==='name')input.addEventListener('input',updateParticipantNames);
        l.append(input);(type==='number'?voiceGrid:section).append(l);
      }
      section.append(voiceGrid);
      const button=document.createElement('button');button.type='button';button.textContent='この友達の音声テスト';
      button.addEventListener('click',()=>operation(async signal=>{const s=settings(),profile=readProfiles()[i];lastSettings=s;await unlockAudio(s);setStatus('音声テスト中');await speak(`${profile.name}です。よろしくね。`,{...s,...profile},null,signal);log(`${profile.name}の音声テスト完了。`);}));
      section.append(button);$('profiles').append(section);
    }
  }
  function readProfiles(){return Array.from({length:6},(_,i)=>{
    const p=defaultProfile(i);
    for(const f of ['name','personality']){p[f]=$(`${p.id}-${f}`).value.trim();if(!p[f])throw new C.AppError('友達の呼び名と性格を入力してください。');}
    for(const [f,max] of [['speaker',99999],['bouyomiVoice',65535]]){const v=$(`${p.id}-${f}`).value;p[f]=Number(v);if(v===''||!Number.isInteger(p[f])||p[f]<0||p[f]>max)throw new C.AppError('友達の声IDを確認してください。');}
    const speed=$(`${p.id}-speedScale`).value;p.speedScale=Number(speed);if(speed===''||!Number.isFinite(p.speedScale)||p.speedScale<0.5||p.speedScale>2)throw new C.AppError('VOICEVOXの話速は0.5〜2.0で指定してください。');
    return p;
  });}
  const vaultKey='ai-live-commentator-vault-v1';
  function lockSecrets(){$('apiKey').value='';$('obsPassword').value='';$('vaultPass').value='';$('vaultConfirm').value='';$('freeTier').checked=false;updateSettingSummaries();}
  function vaultState(){try{$('vaultState').textContent=localStorage.getItem(vaultKey)?'暗号化した情報があります。合言葉を入力して解除できます。':'暗号化した情報はまだありません。';}catch{$('vaultState').textContent='ブラウザが保存を許可していません。';}updateSettingSummaries();}
  async function vaultOperation(fn){
    if(busy||vaultBusy)return;vaultBusy=true;setBusy(false);$('start').disabled=true;
    try{await fn();}catch(e){$('vaultState').textContent=e.message||'暗号化保存に失敗しました。';}
    finally{$('vaultPass').value='';$('vaultConfirm').value='';vaultBusy=false;setBusy(false);}
  }
  $('vaultSave').addEventListener('click',()=>vaultOperation(async()=>{
    if($('vaultPass').value!==$('vaultConfirm').value)throw new Error('確認用の合言葉が一致しません。');
    const apiKey=C.normalizeKey($('apiKey').value);
    const epoch=pageEpoch;
    const data=await LiveVault.seal({apiKey,obsPassword:$('obsPassword').value},$('vaultPass').value);
    if(epoch!==pageEpoch)return;
    localStorage.setItem(vaultKey,JSON.stringify(data));$('vaultState').textContent='暗号化して保存しました。現在は解除中です。';updateSettingSummaries();
  }));
  $('vaultUnlock').addEventListener('click',()=>vaultOperation(async()=>{
    const raw=localStorage.getItem(vaultKey);if(!raw)throw new Error('保存された情報がありません。');
    let data;try{data=JSON.parse(raw);}catch{throw new Error('保存データを読み取れません。再保存してください。');}
    const epoch=pageEpoch;
    const credentials=await LiveVault.open(data,$('vaultPass').value);
    if(epoch!==pageEpoch)return;
    $('apiKey').value=credentials.apiKey;$('obsPassword').value=credentials.obsPassword;$('freeTier').checked=false;
    $('vaultState').textContent='解除しました。Free Tierの確認をしてから開始してください。';updateSettingSummaries();
  }));
  $('vaultLock').addEventListener('click',()=>{lockSecrets();vaultState();});
  $('vaultDelete').addEventListener('click',()=>{if(confirm('暗号化した保存情報を削除しますか？')){try{localStorage.removeItem(vaultKey);lockSecrets();vaultState();}catch{$('vaultState').textContent='削除できませんでした。ブラウザ設定を確認してください。';}}});
  contentLibrary=loadContentLibrary();contentKnowledge=loadContentKnowledge();renderContentOptions('');
  fontLibrary=loadFontLibrary();
  let stored={};try{stored=JSON.parse(localStorage.getItem(storageKey)||'{}')||{};}catch{}
  const migratedFont=legacyFontName(stored.obsOverlayFont);
  if(migratedFont&&!fontLibrary.includes(migratedFont)){fontLibrary.push(migratedFont);fontLibrary=normalizeFontLibrary(fontLibrary);saveFontLibrary();stored.obsOverlayFont=migratedFont;}
  for(const id of savedIds){if(stored[id]===undefined)continue;if($(id).type==='checkbox')$(id).checked=stored[id]===true;else if(['string','number'].includes(typeof stored[id])&&id!=='obsOverlayFont')$(id).value=stored[id];}
  renderFontOptions(typeof stored.obsOverlayFont==='string'?stored.obsOverlayFont:'system');
  applyTheme($('theme').value);
  renderContentOptions(typeof stored.contentName==='string'?splitContentName(stored.contentName).raw:'');
  if(stored.analysisFrameCount===undefined)$('analysisFrameCount').value='2';
  const legacyCount=[1,2,3,4,5,6].includes(Number(stored.participantCount))?Number(stored.participantCount):1;
  const storedSelected=Array.isArray(stored.selectedProfileIds)?[...new Set(stored.selectedProfileIds.filter(id=>/^p[1-6]$/.test(id)))]:[];
  const selectedIds=storedSelected.length?storedSelected:Array.from({length:legacyCount},(_,i)=>`p${i+1}`);
  const profiles=Array.isArray(stored.profiles)?stored.profiles:[];
  if(!profiles.length)profiles.push({...defaultProfile(0),speaker:stored.speaker??3,bouyomiVoice:stored.bouyomiVoice??0});
  buildProfiles(profiles);renderParticipantSelection(selectedIds);vaultState();outputFields();overlayFields();initSettingSections();updateStats();renderSpeakerStats();
  log('準備できました。映像確認と音声テストを済ませてから開始してください。');
})();
