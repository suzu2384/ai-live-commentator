(function () {
  'use strict';
  const C = LiveCore, $ = id => document.getElementById(id);
  const storageKey = 'ai-live-commentator-browser-v1';
  const savedIds = ['obsUrl','sourceName','output','bouyomiUrl','bouyomiVoice','voicevoxUrl','speaker','talkativeness','persona','apiInterval','speechInterval','quietInterval','maxRequests','freshness','resume503','sampleInterval','imageWidth'];
  const numberRules = { bouyomiVoice:[0,65535], speaker:[0,99999], talkativeness:[0,2], apiInterval:[30,600], speechInterval:[15,600], quietInterval:[30,600], maxRequests:[1,10000], freshness:[5,180], sampleInterval:[4,60], imageWidth:[320,960] };
  let controller = null, obs = null, audioContext = null, activeAudio = null, wakeLock = null;
  let phaseAt = performance.now(), busy = false, lastSettings = null;
  const stats = { used:0, stale:0, max:20 };
  function log(message, kind='') {
    const li = document.createElement('li'), time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ja-JP'); li.className = kind;
    li.append(time, document.createTextNode(message)); $('log').prepend(li);
    while ($('log').children.length > 160) $('log').lastElementChild.remove();
  }
  function setStatus(text, error=false) { $('status').textContent = text; phaseAt = performance.now(); $('stateDot').className = 'dot' + (error ? ' error' : busy ? ' running' : ''); }
  function updateStats() { $('usage').textContent = `${stats.used} / ${stats.max}`; $('staleCount').textContent = stats.stale; }
  function setBusy(value) {
    busy = value;
    for (const el of $('settings').querySelectorAll('input,select,textarea,button')) el.disabled = value;
    $('start').disabled = value; $('stop').disabled = !value;
  }
  function settings() {
    const s = {};
    for (const id of savedIds) s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value.trim();
    for (const [id,[min,max]] of Object.entries(numberRules)) {
      const value = Number(s[id]);
      if (s[id] === '' || !Number.isInteger(value) || value < min || value > max) throw new C.AppError(`${$(id).parentElement.firstChild.textContent.trim()}は${min}〜${max}の整数で指定してください。`);
      s[id] = value;
    }
    if (![320,640,960].includes(s.imageWidth)) throw new C.AppError('画像サイズを選択してください。');
    if (!['bouyomi','voicevox'].includes(s.output)) throw new C.AppError('読み上げ先を選択してください。');
    return s;
  }
  function save(s) {
    // Explicit allowlist: secrets and free-tier confirmation are never persisted.
    const data = Object.fromEntries(savedIds.map(id => [id, s[id]]));
    try { localStorage.setItem(storageKey, JSON.stringify(data)); $('saveState').textContent = '設定を保存しました。キー・パスワードは保存していません。'; }
    catch { $('saveState').textContent = 'ブラウザが保存を許可していません。このタブ内では使えます。'; }
  }
  function outputFields() { $('bouyomiFields').hidden = $('output').value !== 'bouyomi'; $('voicevoxFields').hidden = $('output').value !== 'voicevox'; }
  function requireKey() {
    const key = C.normalizeKey($('apiKey').value);
    if (!$('freeTier').checked) throw new C.AppError('このキーのプロジェクトがFree Tier・課金未設定であることを確認し、チェックを付けてください。');
    return key;
  }
  function reserve(s) {
    if (stats.used >= s.maxRequests) throw new C.AppError('今回の送信上限に達しました。', 'BUDGET');
    stats.used++; stats.max = s.maxRequests; updateStats();
  }
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
    return { data, capturedAt, pixels };
  }
  function motion(a,b) { let changed=0; for(let i=0;i<a.length;i+=4) if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>85) changed++; return changed/(a.length/4); }
  async function fetchLocal(url, options, signal) {
    let r;
    try { r = await fetch(url, {...options, signal, credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer'}); }
    catch { C.check(signal); throw new C.AppError('読み上げ先に接続できません。起動状態・URL・HTTP連携・CORSやローカル接続の許可を確認してください。'); }
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
  async function speak(text,s,frame,signal) {
    checkFresh(frame,s); C.check(signal);
    const ms = frame ? Math.min(120000,frame.capturedAt+s.freshness*1000-performance.now()) : 120000;
    // Synthesis and delivery must finish before the freshness deadline. Playback may finish after it.
    if(s.output==='bouyomi') {
      return C.deadline(async token => {
        const base=C.localUrl(s.bouyomiUrl,'http:');
        const state=await jsonLocal(base+'/GetTalkTaskCount',{},token);
        if(!Number.isInteger(state.talkTaskCount) || state.talkTaskCount<0) throw new C.AppError('棒読みちゃんの待機数を取得できませんでした。HTTP連携を確認してください。');
        if(state.talkTaskCount>0) { log('見送り: 棒読みちゃんに再生待ちの音声があります。','warn'); return false; }
        const plain=C.plainSpeech(text); if(plain.length<2) { log('見送り: 読み上げ可能な文章がありません。','warn'); return false; }
        checkFresh(frame,s); C.check(token);
        const params=new URLSearchParams({text:plain,voice:String(s.bouyomiVoice),speed:'-1',tone:'-1',volume:'-1'});
        const r=await fetchLocal(base+'/talk?'+params,{},token);
        const body=await r.text(); C.check(token);
        if(body.trim()) { let result; try { result=JSON.parse(body); } catch { throw new C.AppError('棒読みちゃんの応答を確認できませんでした。重複を避けるため再送しません。'); }
          if(result?.error || result?.success===false) throw new C.AppError('棒読みちゃんが読み上げ要求を受け付けませんでした。'); }
        return true;
      },ms,signal,frame?'鮮度上限に達しました。棒読みちゃんへの送信が済んでいる場合はPC側で再生されることがあります。':'棒読みちゃんがタイムアウトしました。',frame?'STALE':'TIMEOUT');
    }
    const audio=await C.deadline(async token => {
      const base=C.localUrl(s.voicevoxUrl,'http:');
      const query=await jsonLocal(base+'/audio_query?'+new URLSearchParams({text,speaker:String(s.speaker)}),{method:'POST'},token);
      const r=await fetchLocal(base+'/synthesis?speaker='+s.speaker,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(query)},token);
      const wave=await r.arrayBuffer(); C.check(token);
      if(wave.byteLength>32*1024*1024) throw new C.AppError('生成された音声が大きすぎます。');
      const decoded=await audioContext.decodeAudioData(wave); C.check(token); return decoded;
    },ms,signal,frame?'音声生成中に鮮度上限に達したため破棄しました。':'VOICEVOXの音声生成がタイムアウトしました。',frame?'STALE':'TIMEOUT');
    checkFresh(frame,s); C.check(signal);
    if(audioContext.state!=='running') throw new C.AppError('音声再生が中断されています。音声テストをやり直してください。');
    await C.deadline(token=>new Promise((resolve,reject)=>{
      const source=audioContext.createBufferSource(); activeAudio=source; source.buffer=audio; source.connect(audioContext.destination);
      const clean=()=>{token.removeEventListener('abort',abort);source.disconnect();if(activeAudio===source)activeAudio=null;};
      const abort=()=>{source.onended=null;try{source.stop();}catch{}clean();reject(C.abortError());};
      source.onended=()=>{clean();resolve();};token.addEventListener('abort',abort,{once:true});source.start();
    }),120000,signal,'音声再生がタイムアウトしました。');
    return true;
  }
  async function connectObs(s,signal) {
    if(!s.sourceName) throw new C.AppError('OBSの映像ソース名を入力してください。');
    setStatus('OBSに接続中'); obs=new C.ObsClient(); await obs.connect(s.obsUrl,$('obsPassword').value,signal); log('OBSへの接続完了。');
  }
  async function analyze(previous,current,s,key,history,spoken,signal) {
    const remaining=current.capturedAt+s.freshness*1000-performance.now();
    if(remaining<=0) throw new C.AppError('画像取得中に鮮度上限に達しました。','STALE');
    const payload=C.makePayload(previous,current,s,history,spoken); reserve(s); const began=performance.now();
    setStatus('Geminiの応答待ち'); log(`Geminiへ画像2枚を送信（${stats.used}/${s.maxRequests}回・鮮度上限${s.freshness}秒）。`);
    const response=await C.deadline(token=>C.gemini(key,payload,token),Math.min(180000,remaining),signal,'鮮度上限に達したためGeminiの応答待ちを打ち切りました。','STALE');
    const duration=(performance.now()-began)/1000; $('latency').textContent=duration.toFixed(1)+' 秒';log(`Gemini応答 ${duration.toFixed(1)}秒。`);
    checkFresh(current,s);return C.parseAnalysis(response);
  }
  async function run(s,key,signal) {
    const history=[],spoken=[];let previous=null,lastAnalysis=-Infinity,lastSpeech=-Infinity,failures=0;
    await connectObs(s,signal);
    while(true) {
      C.check(signal);if(stats.used>=s.maxRequests){log('設定した送信上限に達したため終了しました。','warn');return;}
      setStatus('OBSの画像取得中');const current=await getFrame(s,signal);
      if(previous && C.shouldAnalyze((performance.now()-lastAnalysis)/1000,motion(previous.pixels,current.pixels),s.apiInterval,s.quietInterval)) {
        lastAnalysis=performance.now();
        try {
          const result=await analyze(previous,current,s,key,history,spoken,signal);failures=0;
          const reason=C.skipReason(result,performance.now()-current.capturedAt,s,performance.now()-lastSpeech,spoken);
          if(result.summary){history.push(result.summary);if(history.length>6)history.shift();}
          if(reason)log(`見送り（${reason}）: ${result.summary}`);
          else {
            setStatus(s.output==='bouyomi'?'棒読みちゃんへ送信中':'VOICEVOXの音声生成・再生中');
            if(await speak(result.comment,s,current,signal)) {
              lastSpeech=performance.now();spoken.push(result.comment);if(spoken.length>5)spoken.shift();
              $('lastComment').textContent=result.comment;$('commentTime').textContent=new Date().toLocaleTimeString('ja-JP');
              $('delivery').textContent=s.output==='bouyomi'?'棒読みちゃんへ送信済み（PC側の再生完了は未確認）':'このブラウザで再生しました';
              log((s.output==='bouyomi'?'送信: ':'AI: ')+result.comment,'spoken');
            }
          }
        } catch(e) {
          C.check(signal);
          if(e.code==='STALE') {stats.stale++;updateStats();log(e.message,'warn');$('latency').textContent='鮮度切れ';}
          else if(e.code==='503') {
            failures++;const wait=C.recoveryDelay(s.resume503,failures,s.apiInterval,stats.used,s.maxRequests);
            if(wait===null) throw new C.AppError(e.message+(!s.resume503?'再開設定がOFFのため停止します。':stats.used>=s.maxRequests?'送信上限に達しました。':'3回連続のため停止します。'));
            log(`503が連続${failures}回。${wait/1000}秒後、最新の映像で再開します。`,'warn');setStatus(`Geminiの混雑待ち（${wait/1000}秒）`);
            await C.sleep(wait,signal);previous=null;lastAnalysis=-Infinity;continue;
          } else throw e;
        }
      }
      if(stats.used>=s.maxRequests){log('設定した送信上限に達したため終了しました。','warn');return;}
      previous=current;setStatus('映像監視中・次の取得待ち');await C.sleep(s.sampleInterval*1000,signal);
    }
  }
  async function operation(fn) {
    if(busy)return;
    controller=new AbortController();const signal=controller.signal;setBusy(true);let failed=false;
    try {await fn(signal);}
    catch(e){if(signal.aborted || e.name==='AbortError')log('停止しました。');else{failed=true;log('停止: '+(e instanceof C.AppError?e.message:'処理に失敗しました。接続先やブラウザの状態を確認してください。'),'warn');}}
    finally{obs?.close();obs=null;activeAudio?.stop();activeAudio=null;await wakeLock?.release().catch(()=>{});wakeLock=null;controller=null;setBusy(false);setStatus(failed?'エラーで停止・履歴を確認してください':'停止中',failed);$('elapsed').textContent='';}
  }
  $('start').addEventListener('click',()=>operation(async signal=>{
    const s=settings(),key=requireKey();C.localUrl(s.obsUrl,'ws:');C.localUrl(s.output==='bouyomi'?s.bouyomiUrl:s.voicevoxUrl,'http:');
    await unlockAudio(s);save(s);lastSettings=s;stats.used=0;stats.stale=0;stats.max=s.maxRequests;updateStats();$('latency').textContent='—';
    log(`開始: ${C.MODEL}・最短${s.apiInterval}秒・上限${s.maxRequests}回・鮮度${s.freshness}秒。今回のカウントを0にしました。`);
    try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
    await run(s,key,signal);
  }));
  $('stop').addEventListener('click',()=>{controller?.abort();obs?.close();try{activeAudio?.stop();}catch{}setStatus('停止処理中');if(lastSettings?.output==='bouyomi')log('新しい送信を停止します。棒読みちゃんに送信済みの音声は、必要なら棒読みちゃん側で停止してください。');});
  $('testObs').addEventListener('click',()=>operation(async signal=>{const s=settings();await connectObs(s,signal);setStatus('OBSの画像取得中');await getFrame(s,signal);log('映像確認完了。Geminiへの送信はありません。');}));
  $('testVoice').addEventListener('click',()=>operation(async signal=>{const s=settings();lastSettings=s;await unlockAudio(s);setStatus('音声テスト中');const ok=await speak('こんにちは。音声テストです。',s,null,signal);if(ok)log(s.output==='bouyomi'?'棒読みちゃんへの音声テスト送信完了。実際に聞こえるか確認してください。':'音声テスト再生完了。');}));
  $('testText').addEventListener('click',()=>operation(async signal=>{
    const s=settings(),key=requireKey();reserve(s);setStatus('Gemini接続テスト中');const began=performance.now();log(`文章だけの接続テストを送信（${stats.used}/${s.maxRequests}回）。`);
    const body=await C.deadline(token=>C.gemini(key,{contents:[{role:'user',parts:[{text:'日本語で「接続できました」とだけ答えて。'}]}],generationConfig:{maxOutputTokens:64,thinkingConfig:{thinkingLevel:'MINIMAL',includeThoughts:false}}},token),180000,signal,'Gemini接続テストが180秒でタイムアウトしました。');
    C.candidateText(body);const seconds=(performance.now()-began)/1000;$('latency').textContent=seconds.toFixed(1)+' 秒';log(`文章だけの応答を受信: ${seconds.toFixed(1)}秒。画像解析・音声再生は行っていません。`);
  }));
  $('save').addEventListener('click',()=>{try{const s=settings();save(s);stats.max=s.maxRequests;updateStats();}catch(e){log(e.message,'warn');}});
  $('preset').addEventListener('click',()=>{for(const [id,value] of Object.entries({talkativeness:2,apiInterval:30,speechInterval:20,quietInterval:60}))$(id).value=value;log('よく話す設定を適用しました。「設定を保存」または「実況を開始」で保存します。');});
  $('clearLog').addEventListener('click',()=>$('log').replaceChildren());$('output').addEventListener('change',outputFields);
  $('apiKey').addEventListener('input',()=>{$('freeTier').checked=false;});$('settings').addEventListener('submit',e=>e.preventDefault());
  setInterval(()=>{if(busy)$('elapsed').textContent=`${Math.floor((performance.now()-phaseAt)/1000)}秒`;},500);
  document.addEventListener('visibilitychange',()=>{if(busy&&document.hidden)log('タブが非表示になりました。ブラウザの節電で間隔が延びる場合があります。','warn');});
  window.addEventListener('pagehide',()=>{controller?.abort();obs?.close();try{activeAudio?.stop();}catch{}});
  try{const s=JSON.parse(localStorage.getItem(storageKey)||'{}');for(const id of savedIds){if(s[id]===undefined)continue;if($(id).type==='checkbox')$(id).checked=s[id]===true;else if(['string','number'].includes(typeof s[id]))$(id).value=s[id];}}catch{}
  outputFields();stats.max=Number($('maxRequests').value)||20;updateStats();
  log('準備できました。映像確認と音声テストを済ませてから開始してください。');
})();
