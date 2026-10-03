(function () {
  'use strict';
  const C = LiveCore, $ = id => document.getElementById(id);
  const storageKey = 'ai-live-commentator-browser-v1';
  const contentLibraryKey = 'ai-live-commentator-content-library-v1';
  const savedIds = ['theme','obsUrl','sourceName','output','bouyomiUrl','voicevoxUrl','talkativeness','persona','conversationHistoryCount','apiInterval','speechInterval','quietInterval','freshness','sampleInterval','imageWidth','analysisFrameCount','speakerWeight1','speakerWeight2','speakerWeight3','speakerWeight4','speakerWeight5','speakerWeight6','greetStart','greetEnd'];
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
  const numberRules = { talkativeness:[0,2], conversationHistoryCount:[0,20], apiInterval:[30,600], speechInterval:[15,600], quietInterval:[30,600], freshness:[5,180], sampleInterval:[1,60], imageWidth:[320,960], analysisFrameCount:[2,6], speakerWeight1:[0,999], speakerWeight2:[0,999], speakerWeight3:[0,999], speakerWeight4:[0,999], speakerWeight5:[0,999], speakerWeight6:[0,999] };
  let controller = null, obs = null, audioContext = null, activeAudio = null, wakeLock = null;
  let phaseAt = performance.now(), lastCaptureAt = null, busy = false, lastSettings = null;
  const stats = { used:0, stale:0 };
  let resumeAction=null, finishAction=null, streaming=false, vaultBusy=false, pageEpoch=0;
  function log(message, kind='') {
    const li = document.createElement('li'), time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ja-JP'); li.className = kind;
    li.append(time, document.createTextNode(message)); $('log').prepend(li);
    while ($('log').children.length > 160) $('log').lastElementChild.remove();
  }
  function setStatus(text, error=false) { $('status').textContent = text; phaseAt = performance.now(); $('stateDot').className = 'dot' + (error ? ' error' : busy ? ' running' : ''); }
  function updateStats() { $('usage').textContent = `${stats.used} 回`; $('staleCount').textContent = stats.stale; }
  function setBusy(value) {
    busy = value;
    for (const el of document.querySelectorAll('#settings input,#settings select,#settings textarea,#settings button,#panel-friends input,#panel-friends select,#panel-friends textarea,#panel-friends button')) el.disabled = value || vaultBusy;
    $('start').disabled = value; $('stop').disabled = !value; $('finish').disabled = !streaming;
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
    $('summary-video').textContent=$('sourceName').value.trim()||'映像ソース未入力';
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
  let contentLibrary=[];
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
  function renderContentManageList(){
    const container=$('contentManageList');container.replaceChildren();
    if(!contentLibrary.length){
      const empty=document.createElement('p');empty.className='content-empty';empty.textContent='対象コンテンツはまだ登録されていません。';container.append(empty);return;
    }
    for(const group of contentGroups()){
      const section=document.createElement('section');section.className='content-manage-group';
      const mainRow=document.createElement('div');mainRow.className='content-main-row';
      const mainLabel=document.createElement('strong');mainLabel.textContent=group.main;
      mainRow.append(mainLabel,deleteButton(group.main,true));section.append(mainRow);
      if(group.children.length){
        const children=document.createElement('div');children.className='content-sub-list';
        for(const child of group.children){
          const row=document.createElement('div');row.className='content-sub-row';
          const branch=document.createElement('span');branch.className='content-branch';branch.textContent='└';
          const label=document.createElement('span');label.className='content-sub-name';label.textContent=child.sub;
          row.append(branch,label,deleteButton(child.raw));children.append(row);
        }
        section.append(children);
      }
      container.append(section);
    }
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
    const selected=$('contentName').value;contentLibrary=contentLibrary.filter(item=>item!==name);saveContentLibrary();
    renderContentOptions(selected===name?'':selected);renderContentManageList();
  }
  function deleteContentMain(main){
    const group=contentGroups().find(item=>item.main===main);if(!group)return;
    const count=group.children.length;
    const message=count?`「${main}」とサブ項目${count}件を削除しますか？`:`「${main}」を対象コンテンツ一覧から削除しますか？`;
    if(!confirm(message))return;
    const selected=splitContentName($('contentName').value);
    contentLibrary=contentLibrary.filter(raw=>{const item=splitContentName(raw);return item.main!==main;});
    saveContentLibrary();renderContentOptions(selected.main===main?'':selected.raw);renderContentManageList();
  }
  function openContentDialog(){renderContentManageList();$('contentDialog').showModal();setTimeout(()=>$('newContentName').focus(),0);}
  function closeContentDialog(){$('contentDialog').close();}

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
    updateSettingSummaries();
  }
  function updateParticipantNames(){
    for(let i=0;i<6;i++){
      const id=`p${i+1}`,label=document.querySelector(`[data-participant-name="${id}"]`);
      if(label)label.textContent=$(`${id}-name`)?.value.trim()||`友達${i+1}`;
    }
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
    for (const [id,[min,max]] of Object.entries(numberRules)) {
      const value = Number(s[id]);
      if (s[id] === '' || !Number.isInteger(value) || value < min || value > max){revealSetting(id);throw new C.AppError(`${settingLabel(id)}は${min}〜${max}の整数で指定してください。`);}
      s[id] = value;
    }
    if (![320,640,960].includes(s.imageWidth)){revealSetting('imageWidth');throw new C.AppError('画像サイズを選択してください。');}
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
  function save(s) {
    // Explicit allowlist: secrets and free-tier confirmation are never persisted.
    const data = {...Object.fromEntries(savedIds.map(id => [id, s[id]])), contentName:s.contentName, selectedProfileIds:s.selectedProfileIds, participantCount:s.participantCount, profiles:s.allProfiles};
    try { localStorage.setItem(storageKey, JSON.stringify(data)); $('saveState').textContent = '設定を保存しました。キー類の保存は「暗号化して保存」から行えます。'; }
    catch { $('saveState').textContent = 'ブラウザが保存を許可していません。このタブ内では使えます。'; }
  }
  function voicevoxSettingsLink(){
    try{$('voicevoxSettingsLink').href=C.localUrl($('voicevoxUrl').value,'http:')+'/setting';}
    catch{$('voicevoxSettingsLink').removeAttribute('href');}
  }
  $('voicevoxUrl').addEventListener('input',voicevoxSettingsLink);
  function outputFields() { voicevoxSettingsLink(); $('bouyomiFields').hidden = $('output').value !== 'bouyomi'; $('voicevoxFields').hidden = $('output').value !== 'voicevox'; updateSettingSummaries(); }
  function requireKey() {
    let key;try{key=C.normalizeKey($('apiKey').value);}catch(e){revealSetting('apiKey');throw e;}
    if (!$('freeTier').checked){revealSetting('freeTier');throw new C.AppError('このキーのプロジェクトがFree Tier・課金未設定であることを確認し、チェックを付けてください。');}
    return key;
  }
  function reserve() { stats.used++; updateStats(); }
  async function getFrame(s, signal) {
    C.check(signal); const capturedAt = performance.now();
    const result = await obs.screenshot(s.sourceName, s.imageWidth, signal);
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
  async function playVoicevoxAudio(audio,s,frame,signal) {
    checkFresh(frame,s);C.check(signal);
    if(audioContext.state!=='running')throw new C.AppError('音声再生が中断されています。音声テストをやり直してください。');
    await C.deadline(token=>new Promise((resolve,reject)=>{
      const source=audioContext.createBufferSource();activeAudio=source;source.buffer=audio;source.connect(audioContext.destination);
      const clean=()=>{token.removeEventListener('abort',abort);source.disconnect();if(activeAudio===source)activeAudio=null;};
      const abort=()=>{source.onended=null;try{source.stop();}catch{}clean();reject(C.abortError());};
      source.onended=()=>{clean();resolve();};token.addEventListener('abort',abort,{once:true});source.start();
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
  function spokenText(turn){const value=typeof turn?.speechText==='string'&&turn.speechText.trim()?turn.speechText:turn?.text;return C.plainSpeech(String(value??''));}
  function showLatestComment(profile,turn){
    $('lastComment').textContent=profile.name+'：'+turn.text;
    const speech=typeof turn?.speechText==='string'&&turn.speechText.trim()?turn.speechText:turn?.text;
    $('lastSpeechText').textContent='読み上げ：'+String(speech??'');
    $('commentTime').textContent=new Date().toLocaleTimeString('ja-JP');
  }
  function greetingPayload(kind,s,history,turnCount){
    turnCount=Math.max(1,Math.min(s.profiles.length,Number(turnCount)||1));
    const ending=kind==='end';
    const context=ending&&history.length?history.slice(-5).join(' / '):'まだゲーム内容は判断しない';
    const task=ending
      ? '実況を通常終了する直前の締めの挨拶を作る。今回見えていた状況に軽く触れてもよいが、確認できない成果・勝敗・進捗は断定しない。「また見よう」「おつかれ」など自然に締める。'
      : '実況開始直後の短い挨拶を作る。まだゲーム内容を見ていないので、ゲーム名・状況・成果を推測せず、「始まったね」「今日も見ていこう」程度の自然な開始挨拶にする。';
    const parts=[{text:`共通の雰囲気: ${s.persona}\n参加者: ${JSON.stringify(s.profiles.map(({id,name,personality})=>({id,name,personality})))}\n直近の状況: ${context}\n${task}\n開始・終了挨拶が有効なので、この応答のturnsは必ず読み上げる。異なる${turnCount}人が1回ずつ発言し、turnsを必ず${turnCount}件にする。同じspeakerIdを重複させない。speakは互換用フィールドなので値にかかわらずturnsを生成する。各5〜25文字程度の自然な口語。架空の思い出は作らない。`}];
    return {systemInstruction:{parts:[{text:'あなたは無言のゲーム配信に添える友達役。指定された開始または終了の挨拶だけを短く返す。各turnのtextは表示用の自然な日本語、speechTextは同じ内容を実際に声に出すとおりの読みだけで書く。speechTextはtext全文を読み仮名へ変換し、内容・意味・口調・言葉は変えない。漢字・英字・数字は一切含めず、ひらがな・カタカナ・長音・空白・句読点だけを使う。表記上の綴りではなく実際の発音を書く。方言や崩した言い方も実際の読みへ直す。textにある「、」「。」「！」「？」「!」「?」は削除・変更せず、同じ順序でspeechTextにも必ず残す。自然な間のために必要ならspeechText側へ「、」だけ追加してよい。たとえばtextが「早よ行こうや、間に合わへんで！」ならspeechTextは「はよいこうや、まにあわへんで！」とする。英字や数字を含む語も実際の読みをかなで書く。'}]},
      contents:[{role:'user',parts}],generationConfig:{candidateCount:1,maxOutputTokens:512,thinkingConfig:{thinkingLevel:'MINIMAL',includeThoughts:false},responseMimeType:'application/json',
        responseSchema:{type:'OBJECT',properties:{speak:{type:'BOOLEAN'},summary:{type:'STRING'},turns:{type:'ARRAY',minItems:turnCount,maxItems:turnCount,items:{type:'OBJECT',properties:{speakerId:{type:'STRING',enum:s.profiles.map(p=>p.id)},text:{type:'STRING'},speechText:{type:'STRING'}},required:['speakerId','text','speechText']}}},required:['speak','summary','turns']}}};
  }
  async function playGreetingTurns(turns,s,signal,label){
    const items=turns.map(turn=>({turn,profile:s.profiles.find(p=>p.id===turn.speakerId)})).filter(x=>x.profile);
    const delivered=({turn,profile})=>{
      showLatestComment(profile,turn);
      $('delivery').textContent=s.output==='bouyomi'?'棒読みちゃんへ順番に送信済み（PC側の再生完了は未確認）':'このブラウザで再生しました';
      log(`${label}・${profile.name}: ${turn.text}`,'spoken');
    };
    if(!items.length)return;
    if(s.output==='voicevox'){
      let audio=await generateVoicevoxAudio(spokenText(items[0].turn),{...s,...items[0].profile},null,signal);
      for(let i=0;i<items.length;i++){
        const item=items[i],next=items[i+1];
        setStatus(next?`${label}を再生中・次の音声を先読み中`:`${label}を再生中`);
        const playback=playVoicevoxAudio(audio,{...s,...item.profile},null,signal);
        let prefetch=null,prefetchController=null,unlink=null;
        if(next){
          prefetchController=new AbortController();
          const abort=()=>prefetchController.abort();signal.addEventListener('abort',abort,{once:true});unlink=()=>signal.removeEventListener('abort',abort);
          prefetch=generateVoicevoxAudio(spokenText(next.turn),{...s,...next.profile},null,prefetchController.signal).then(value=>({value}),error=>({error}));
        }
        try{await playback;}catch(e){prefetchController?.abort();unlink?.();throw e;}
        delivered(item);
        if(prefetch){const prepared=await prefetch;unlink?.();if(prepared.error)throw prepared.error;audio=prepared.value;}
      }
    }else{
      for(let i=0;i<items.length;i++){const item=items[i];setStatus(`${label}を送信中`);if(!await speak(spokenText(item.turn),{...s,...item.profile},null,signal,true))throw new C.AppError(`${label}を読み上げ先へ送信できませんでした。`,'VOICE');delivered(item);}
    }
  }
  function fallbackGreetingTurns(kind,s,turnCount){
    const start=[
      ['じゃあ、今日も見ていこう','じゃあ、きょうもみていこう'],
      ['楽しんでいこうか','たのしんでいこうか'],
      ['どんな感じか見てみよう','どんなかんじかみてみよう'],
      ['今日もよろしくね','きょうもよろしくね'],
      ['さっそく見ていこう','さっそくみていこう'],
      ['一緒に楽しもう','いっしょにたのしもう']
    ];
    const end=[
      ['今日はこの辺かな。また見よう','きょうわこのへんかな。またみよう'],
      ['うん、おつかれさま','うん、おつかれさま'],
      ['今日も楽しかったね','きょうもたのしかったね'],
      ['また続き見ようね','またつづきみようね'],
      ['じゃあ、またね','じゃあ、またね'],
      ['おつかれ、また見よう','おつかれ、またみよう']
    ];
    const phrases=kind==='end'?end:start;
    return s.profiles.slice(0,turnCount).map((profile,i)=>({speakerId:profile.id,text:phrases[i][0],speechText:phrases[i][1]}));
  }
  async function greeting(kind,runtime,signal,{tolerateFailure=false}={}){
    const s=runtime.s,key=runtime.key,label=kind==='end'?'終了の挨拶':'開始の挨拶';
    try{
      const turnCount=C.pickWeightedSpeakerCount(s.speakerCountWeights,s.profiles.length);
      let result=null;
      for(let attempt=1;attempt<=2;attempt++){
        try{
          reserve(s);setStatus(`${label}を生成中`);log(`Geminiへ${label}を依頼（${stats.used}回・今回の発言人数${turnCount}人${attempt>1?'・再生成':''}）。`);
          const body=await C.deadline(token=>C.gemini(key,greetingPayload(kind,s,runtime.history,turnCount),token),60000,signal,`${label}の生成がタイムアウトしました。`);
          result=C.parseAnalysis(body,s.profiles,turnCount,true);
          if(result.turns.length!==turnCount)throw new C.AppError(`${label}の人数が指定と一致しません。`,'RESPONSE');
          break;
        }catch(e){
          C.check(signal);
          if(e instanceof C.AppError&&e.code==='RESPONSE'){
            if(attempt===1){
              log(`${label}の応答が条件を満たさなかったため、1回だけ再生成します。`,'warn');
              continue;
            }
            result={speak:true,summary:`${label}フォールバック`,turns:fallbackGreetingTurns(kind,s,turnCount)};
            log(`${label}の生成結果が2回とも不正だったため、固定の短い挨拶で続行します。`,'warn');
            break;
          }
          throw e;
        }
      }
      await playGreetingTurns(result.turns,s,signal,label);
    }catch(e){
      C.check(signal);
      log(`${label}を省略: ${e instanceof C.AppError?e.message:'生成または再生に失敗しました。'}`,'warn');
      if(!tolerateFailure)throw e;
    }
  }
  async function connectObs(s,signal) {
    if(!s.sourceName){revealSetting('sourceName');throw new C.AppError('OBSの映像ソース名を入力してください。');}
    setStatus('OBSに接続中'); obs=new C.ObsClient(); await obs.connect(s.obsUrl,$('obsPassword').value,signal); log('OBSへの接続完了。');
  }
  async function analyze(frames,s,key,history,spoken,speakerHistory,state,signal,quietMode=false) {
    const current=frames[frames.length-1];
    const turnCount=C.pickWeightedSpeakerCount(s.speakerCountWeights,s.profiles.length);
    const analysisSettings={...s,turnCount,quietMode,recentSpeakerIds:[...speakerHistory,...state.activeSpeakerIds].slice(-8)};
    const profileNames=new Map(s.profiles.map(p=>[p.id,p.name]));
    const deliveredConversation=spoken.map((text,i)=>({speakerId:speakerHistory[i],text}));
    const activeConversation=state.activeTurnTexts.map((text,i)=>({speakerId:state.activeSpeakerIds[i],text}));
    const recentConversation=s.conversationHistoryCount>0
      ? [...deliveredConversation,...activeConversation].slice(-s.conversationHistoryCount).map(item=>`${profileNames.get(item.speakerId)||item.speakerId}: ${item.text}`)
      : [];
    const remaining=current.capturedAt+s.freshness*1000-performance.now();
    if(remaining<=0) throw new C.AppError('画像取得中に鮮度上限に達しました。','STALE');
    const payload=C.makePayload(frames,analysisSettings,history,recentConversation); reserve(s); const began=performance.now();
    setStatus(state.speaking?'読み上げ中・裏でGemini解析中':'Geminiの応答待ち'); log(`Geminiへ画像${frames.length}枚を送信（${stats.used}回・今回の発言人数${turnCount}人・${quietMode?'雑談モード':'通常実況'}・鮮度上限${s.freshness}秒）。`);
    const response=await C.deadline(token=>C.gemini(key,payload,token),Math.min(180000,remaining),signal,'鮮度上限に達したためGeminiの応答待ちを打ち切りました。','STALE');
    const duration=(performance.now()-began)/1000; $('latency').textContent=duration.toFixed(1)+' 秒';log(`Gemini応答 ${duration.toFixed(1)}秒。`);
    checkFresh(current,s);return C.parseAnalysis(response,s.profiles,turnCount);
  }
  async function waitForSettings(signal) {
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
      const quietMode=state.lastAnalysis!==-Infinity&&motionValue<.07&&elapsed>=Math.max(s.apiInterval,s.quietInterval);
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
      showLatestComment(profile,turn);
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
          const playback=playVoicevoxAudio(audio,{...s,...item.profile},i===0?current:null,signal);
          let prefetch=null,prefetchController=null,unlink=null;
          if(next){
            prefetchController=new AbortController();
            const abort=()=>prefetchController.abort();signal.addEventListener('abort',abort,{once:true});unlink=()=>signal.removeEventListener('abort',abort);
            prefetch=generateVoicevoxAudio(spokenText(next.turn),{...s,...next.profile},null,prefetchController.signal).then(value=>({value}),error=>({error}));
          }
          try{await playback;}catch(e){prefetchController?.abort();unlink?.();throw e;}
          delivered(item.turn,item.profile);
          if(prefetch){const prepared=await prefetch;unlink?.();if(prepared.error)throw prepared.error;audio=prepared.value;}
        }
      }else{
        for(const {turn,profile} of turns){
          C.check(signal);setStatus(state.analysisInFlight?'棒読みちゃんへ送信中・裏でGemini解析中':'棒読みちゃんへ送信中');
          if(!await speak(spokenText(turn),{...s,...profile},conversationStarted?null:current,signal,conversationStarted))break;
          if(!conversationStarted)state.lastConversationStart=performance.now();
          delivered(turn,profile);
        }
      }
      return conversationStarted;
    } finally {
      state.speaking=false;state.activeTurnTexts=[];state.activeSpeakerIds=[];
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
          obs?.close();obs=null;({s,key}=await waitForSettings(signal));runtime.s=s;runtime.key=key;
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
    finally{obs?.close();obs=null;activeAudio?.stop();activeAudio=null;await wakeLock?.release().catch(()=>{});wakeLock=null;controller=null;finishAction=null;streaming=false;lastCaptureAt=null;setBusy(false);setStatus(failed?'エラーで停止・履歴を確認してください':'停止中',failed);$('elapsed').textContent='';}
  }
  $('start').addEventListener('click',()=>operation(async signal=>{
    lastCaptureAt=null;const s=settings(),key=requireKey();validateEndpoints(s);
    await unlockAudio(s);save(s);lastSettings=s;stats.used=0;stats.stale=0;updateStats();$('latency').textContent='—';
    const runtime={s,key,history:[],spoken:[],speakerHistory:[],state:{frames:[],frameVersion:0,pending:null,analysisVersion:0,speechEpoch:0,analysisInFlight:false,speaking:false,activeTurnTexts:[],activeSpeakerIds:[],rateLimitStreak:0,lastAnalysis:-Infinity,lastSpeech:-Infinity,lastConversationStart:-Infinity,lastAnalyzedFrameAt:-Infinity}};
    streaming=true;$('finish').disabled=true;
    log(`開始: ${C.MODEL}・最短${s.apiInterval}秒・鮮度${s.freshness}秒。今回のカウントを0にしました。`);
    try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
    if(s.greetStart)await greeting('start',runtime,signal,{tolerateFailure:true});
    const runController=new AbortController();let finishing=false;
    const stopRun=()=>runController.abort();signal.addEventListener('abort',stopRun,{once:true});
    finishAction=()=>{if(finishing||signal.aborted)return;finishing=true;$('finish').disabled=true;setStatus('実況終了の準備中');runController.abort();};$('finish').disabled=false;
    try{await run(runtime,runController.signal);}
    catch(e){if(!(finishing&&e.name==='AbortError'))throw e;}
    finally{signal.removeEventListener('abort',stopRun);}
    if(!finishing)return;
    C.check(signal);obs?.close();obs=null;lastCaptureAt=null;
    runtime.s=runtime.s||s;runtime.key=runtime.key||key;lastSettings=runtime.s;
    if(runtime.s.greetEnd)await greeting('end',runtime,signal,{tolerateFailure:true});
    log('実況を通常終了しました。');
  }));
  $('resume').addEventListener('click',()=>resumeAction?.());
  $('finish').addEventListener('click',()=>finishAction?.());
  $('stop').addEventListener('click',()=>{controller?.abort();obs?.close();try{activeAudio?.stop();}catch{}setStatus('即停止処理中');if(lastSettings?.output==='bouyomi')log('新しい送信を即停止します。棒読みちゃんに送信済みの音声は、必要なら棒読みちゃん側で停止してください。');});
  $('testObs').addEventListener('click',()=>operation(async signal=>{const s=settings();await connectObs(s,signal);setStatus('OBSの画像取得中');await getFrame(s,signal);log('映像確認完了。Geminiへの送信はありません。');}));
  $('testVoice').addEventListener('click',()=>operation(async signal=>{const s=settings();lastSettings=s;await unlockAudio(s);setStatus('音声テスト中');const ok=await speak('こんにちは。音声テストです。',s,null,signal);if(ok)log(s.output==='bouyomi'?'棒読みちゃんへの音声テスト送信完了。実際に聞こえるか確認してください。':'音声テスト再生完了。');}));
  $('testText').addEventListener('click',()=>operation(async signal=>{
    const s=settings(),key=requireKey();reserve(s);setStatus('Gemini接続テスト中');const began=performance.now();log(`文章だけの接続テストを送信（${stats.used}回）。`);
    const body=await C.deadline(token=>C.gemini(key,{contents:[{role:'user',parts:[{text:'日本語で「接続できました」とだけ答えて。'}]}],generationConfig:{maxOutputTokens:64,thinkingConfig:{thinkingLevel:'MINIMAL',includeThoughts:false}}},token),180000,signal,'Gemini接続テストが180秒でタイムアウトしました。');
    C.candidateText(body);const seconds=(performance.now()-began)/1000;$('latency').textContent=seconds.toFixed(1)+' 秒';log(`文章だけの応答を受信: ${seconds.toFixed(1)}秒。画像解析・音声再生は行っていません。`);
  }));
  $('save').addEventListener('click',()=>{try{const s=settings();save(s);updateStats();}catch(e){log(e.message,'warn');}});
  $('preset').addEventListener('click',()=>{for(const [id,value] of Object.entries({talkativeness:2,apiInterval:30,speechInterval:20,quietInterval:60}))$(id).value=value;updateSettingSummaries();log('よく話す設定を適用しました。「設定を保存」または「実況を開始」で保存します。');});
  $('clearLog').addEventListener('click',()=>$('log').replaceChildren());$('output').addEventListener('change',outputFields);
  $('manageContents').addEventListener('click',openContentDialog);
  $('closeContentDialog').addEventListener('click',closeContentDialog);
  $('doneContentDialog').addEventListener('click',closeContentDialog);
  $('addContent').addEventListener('click',addContent);
  $('newContentName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addContent();}});
  $('contentManageList').addEventListener('click',e=>{const child=e.target.closest('[data-content-name]');if(child){deleteContent(child.dataset.contentName);return;}const main=e.target.closest('[data-content-main]');if(main)deleteContentMain(main.dataset.contentMain);});
  $('contentDialog').addEventListener('click',e=>{if(e.target===$('contentDialog'))closeContentDialog();});
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
  new ResizeObserver(entries=>document.documentElement.style.setProperty('--toolbar-height',`${entries[0].target.getBoundingClientRect().height}px`)).observe(document.querySelector('.toolbar'));
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
  function defaultProfile(i){return {id:`p${i+1}`,name:`友達${i+1}`,personality:['気さくで明るい。感想と応援が多い。','落ち着いていて、軽いツッコミが得意。','好奇心旺盛。景色や細部に気づく。'][i%3],speaker:i%2===0?3:2,speedScale:1.0,bouyomiVoice:0};}
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
  contentLibrary=loadContentLibrary();renderContentOptions('');
  let stored={};try{stored=JSON.parse(localStorage.getItem(storageKey)||'{}')||{};for(const id of savedIds){if(stored[id]===undefined)continue;if($(id).type==='checkbox')$(id).checked=stored[id]===true;else if(['string','number'].includes(typeof stored[id]))$(id).value=stored[id];}}catch{}
  applyTheme($('theme').value);
  renderContentOptions(typeof stored.contentName==='string'?splitContentName(stored.contentName).raw:'');
  if(stored.analysisFrameCount===undefined)$('analysisFrameCount').value='2';
  const legacyCount=[1,2,3,4,5,6].includes(Number(stored.participantCount))?Number(stored.participantCount):1;
  const storedSelected=Array.isArray(stored.selectedProfileIds)?[...new Set(stored.selectedProfileIds.filter(id=>/^p[1-6]$/.test(id)))]:[];
  const selectedIds=storedSelected.length?storedSelected:Array.from({length:legacyCount},(_,i)=>`p${i+1}`);
  const profiles=Array.isArray(stored.profiles)?stored.profiles:[];
  if(!profiles.length)profiles.push({...defaultProfile(0),speaker:stored.speaker??3,bouyomiVoice:stored.bouyomiVoice??0});
  buildProfiles(profiles);renderParticipantSelection(selectedIds);vaultState();outputFields();initSettingSections();updateStats();
  log('準備できました。映像確認と音声テストを済ませてから開始してください。');
})();
