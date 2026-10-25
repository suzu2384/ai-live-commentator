/* YouTube Brand Channel and Google Drive authorization are independent.
   Remember only the preferred Google login account per service. */
(function(root){
 'use strict';
 const SCOPES={drive:'https://www.googleapis.com/auth/drive.appdata',youtube:'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.email'};
 const LINKED='minkome-google-linked-v1',CHANNEL='minkome-youtube-channel-v1';
 const LEGACY_EMAIL='minkome-google-account-v1';
 const ACCOUNT_HINTS='minkome-google-account-hints-v1';
 const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 const validEmail=v=>typeof v==='string'&&v.length<=254&&EMAIL.test(v)?v:'';
 function storedHints(clientId){
  try{
   const saved=JSON.parse(root.localStorage?.getItem(ACCOUNT_HINTS)||'null');
   if(saved?.clientId!==clientId||!saved.hints||typeof saved.hints!=='object')return {};
   return Object.fromEntries(Object.entries(saved.hints).filter(([s,e])=>SCOPES[s]&&validEmail(e)));
  }catch{return {};}
 }
 function preferredAccount(clientId,service){
  const hints=storedHints(clientId);
  return hints[service]||hints[service==='youtube'?'drive':'youtube']||'';
 }
 function rememberAccount(clientId,service,email){
  email=validEmail(email);
  if(!clientId||!SCOPES[service]||!email)return false;
  try{
   root.localStorage?.setItem(ACCOUNT_HINTS,JSON.stringify({clientId,hints:{...storedHints(clientId),[service]:email}}));
   return true;
  }catch{return false;}
 }
 function forgetAccount(clientId,service){
  if(!SCOPES[service])return;
  try{
   const hints=storedHints(clientId);delete hints[service];
   if(Object.keys(hints).length)root.localStorage?.setItem(ACCOUNT_HINTS,JSON.stringify({clientId,hints}));
   else root.localStorage?.removeItem(ACCOUNT_HINTS);
  }catch{}
 }
 async function accountForToken(service,token){
  const url=service==='drive'?'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)':'https://www.googleapis.com/oauth2/v3/userinfo';
  try{
   const opts={headers:{Authorization:'Bearer '+token},credentials:'omit',cache:'no-store'};
   if(typeof root.AbortSignal?.timeout==='function')opts.signal=root.AbortSignal.timeout(8000);
   const r=await root.fetch(url,opts);
   if(!r.ok)return '';
   const data=await r.json();
   return validEmail(service==='drive'?data?.user?.emailAddress:data?.email);
  }catch{return '';}
 }
 const SESSION='minkome-google-session-v1',PERSIST='minkome-google-persistent-token-v1',KEEP='minkome-google-keep-connected-v1';
 const valid=id=>/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(String(id||'').trim());
 class GoogleAuth{
  constructor(clientId){
   this.clientId=String(clientId||'').trim();this.tokens={drive:null,youtube:null};this.pending=false;this.channel=null;
   try{
    const linked=JSON.parse(root.localStorage?.getItem(LINKED)||'{}');
    this.linked={drive:linked?.drive===true,youtube:linked?.youtube===true};
    const channel=JSON.parse(root.localStorage?.getItem(CHANNEL)||'null');
    if(this.linked.youtube&&/^UC[\w-]{22}$/.test(channel?.id)){
     this.channel={id:channel.id,title:String(channel.title||channel.id).slice(0,100)};
    }
   }catch{this.linked={drive:false,youtube:false};this.channel=null;}
   this.restoreTokens();
  }
  get keepConnected(){try{return root.localStorage?.getItem(KEEP)==='1';}catch{return false;}}
  services(){return Object.keys(SCOPES).filter(s=>this.linked[s]);}
  isLinked(s){return !!this.linked[s];}
  token(s){const t=this.tokens[s];return t&&t.expires>Date.now()?t.value:'';}
  tokenRecord(){return {version:3,clientId:this.clientId,channelId:this.channel?.id||'',tokens:
   Object.fromEntries(Object.keys(SCOPES).filter(s=>this.linked[s]&&this.token(s)).map(s=>[s,{...this.tokens[s],scope:SCOPES[s]}]))};}
  saveTokens(){
   const record=this.tokenRecord(),present=Object.keys(record.tokens).length>0,raw=JSON.stringify(record);
   try{if(present)root.sessionStorage?.setItem(SESSION,raw);else root.sessionStorage?.removeItem(SESSION);}catch{}
   try{if(present&&this.keepConnected)root.localStorage?.setItem(PERSIST,raw);else root.localStorage?.removeItem(PERSIST);}catch{}
  }
  restoreTokens(){
   let raw;
   try{raw=root.sessionStorage?.getItem(SESSION);}catch{}
   if(!raw&&this.keepConnected){try{raw=root.localStorage?.getItem(PERSIST);}catch{}}
   if(!raw)return;
   let stored;try{stored=JSON.parse(raw);}catch{}
   const now=Date.now(),max=now+86400000;
   if(stored?.clientId!==this.clientId||![1,3].includes(stored?.version)||!stored.tokens){
    this.saveTokens();return;
   }
   for(const service of Object.keys(SCOPES)){
    // Legacy Drive tokens can still be reused, but legacy YouTube tokens were
    // never verified against the actual Brand Channel. Require a new authorization.
    if(service==='youtube'&&(stored.version!==3||!this.channel||stored.channelId!==this.channel.id))continue;
    const token=stored.tokens[service];
    if(this.linked[service]&&token?.scope===SCOPES[service]&&typeof token.value==='string'&&token.value.length>0&&token.value.length<8192&&
       Number.isFinite(token.expires)&&token.expires>now&&token.expires<=max)this.tokens[service]={value:token.value,expires:token.expires};
   }
   this.saveTokens();
  }
  save(){
   try{
    root.localStorage?.setItem(LINKED,JSON.stringify(this.linked));
    if(this.linked.youtube&&this.channel)root.localStorage?.setItem(CHANNEL,JSON.stringify(this.channel));
    else root.localStorage?.removeItem(CHANNEL);
    root.localStorage?.removeItem(LEGACY_EMAIL);
   }catch{}
  }
  setKeepConnected(enabled){
   if(enabled){
    try{if(!root.localStorage)throw Error();root.localStorage.setItem(KEEP,'1');this.saveTokens();}
    catch{throw Error('この端末では接続を保持できません。ブラウザの保存設定を確認してください。');}
   }else{try{root.localStorage?.removeItem(KEEP);root.localStorage?.removeItem(PERSIST);}catch{}}
  }
  disconnect(service){
   if(!SCOPES[service])throw Error('不明なGoogleサービスです。');
   this.linked[service]=false;this.tokens[service]=null;
   if(service==='youtube')this.channel=null;
   forgetAccount(this.clientId,service);
   if(!this.services().length)this.setKeepConnected(false);
   this.save();this.saveTokens();
  }
  async authorize(names,{force=false}={}){
   const selected=[...new Set(names)];
   if(!selected.length||selected.some(s=>!SCOPES[s]))throw Error('認証対象がありません。');
   if(!valid(this.clientId))throw Error('GitHubのGOOGLE_OAUTH_CLIENT_IDを設定してください。');
   if(this.pending)throw Error('Google認証の処理中です。');
   // Explicit reconnect renews valid tokens too. YouTube must never be skipped.
   const needed=force?selected:selected.filter(service=>!this.token(service));
   if(!needed.length)return [];
   // The first popup keeps the originating click's user activation.
   if(force&&needed.includes('youtube'))needed.sort((a,b)=>(a==='youtube'?0:1)-(b==='youtube'?0:1));
   this.pending=true;const completed=[];
   try{
    // Separate Brand Channel and Drive grants. Never combine their scopes.
    // Valid connections do not require another popup.
    for(const service of needed){await this.authorizeService(service);completed.push(service);}
    return completed;
   }catch(error){
    if(completed.length)error.message+='（'+completed.map(s=>s==='youtube'?'YouTube':'Drive').join('・')+'への接続は完了しています。）';
    throw error;
   }finally{this.pending=false;}
  }
  authorizeService(service){
   const oauth=root.google?.accounts?.oauth2;
   if(!oauth?.initTokenClient)throw Error('Google認証ライブラリを読み込めませんでした。');
   return new Promise((resolve,reject)=>{
    let settled=false;
    const fail=e=>{if(settled)return;settled=true;reject(e);};
    try{
     const preferred=preferredAccount(this.clientId,service);
    const client=oauth.initTokenClient({
      client_id:this.clientId,scope:SCOPES[service],include_granted_scopes:false,
      ...(preferred?{login_hint:preferred}:{}),
      callback:async response=>{
       if(settled)return;
       try{
        if(response?.error)throw Error('Google認証に失敗しました（'+response.error+'）。');
        if(!response?.access_token||!oauth.hasGrantedAllScopes(response,...SCOPES[service].split(' ')))
         throw Error('必要な'+(service==='youtube'?'YouTube':'Drive')+'権限を許可してください。');
        const expires=Date.now()+Math.max(0,Number(response.expires_in||0)-60)*1000;
        if(expires<=Date.now())throw Error('有効なGoogle認証情報を取得できませんでした。');
        if(service==='youtube'){
         // The channel is the identity: Brand Accounts do not expose a separate
         // email address. No userinfo endpoint or userinfo.email scope is used.
         const r=await root.fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=1',
          {headers:{Authorization:'Bearer '+response.access_token},cache:'no-store',credentials:'omit'});
         if(!r.ok)throw Error('YouTubeチャンネルの確認に失敗しました（HTTP '+r.status+'）。YouTube Data API v3の有効化と権限を確認してください。');
         const channel=(await r.json())?.items?.[0];
         if(!/^UC[\w-]{22}$/.test(channel?.id))throw Error('認証先にYouTubeチャンネルがありません。配信するブランドチャンネルを選択してください。');
         if(this.channel?.id&&this.channel.id!==channel.id)throw Error('前回とは異なるYouTubeチャンネルです。'+this.channel.title+'を選ぶか、YouTube連携を解除して切り替えてください。');
         this.channel={id:channel.id,title:String(channel.snippet?.title||channel.id).slice(0,100)};
        }
        this.linked[service]=true;this.tokens[service]={value:response.access_token,expires};
        this.save();this.saveTokens();
        // Email is a best-effort account hint; channel verification above stays authoritative.
        const email=await accountForToken(service,response.access_token);
        if(email)rememberAccount(this.clientId,service,email);
        settled=true;resolve(service);
       }catch(e){fail(e);}
      },
      error_callback:error=>fail(Error(error?.type==='popup_closed'?'Google認証画面を閉じました。':'Googleの認証画面を開けませんでした。ポップアップを許可し、再度接続してください。'))
     });
     // Called synchronously from the original click (for the first service).
     client.requestAccessToken({prompt:service==='youtube'&&!preferred?'select_account':''});
    }catch(e){fail(e);}
   });
  }
 }
 root.LiveGoogleAuth={GoogleAuth,valid,SCOPES,preferredAccount,rememberAccount,forgetAccount};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.LiveGoogleAuth;
})(globalThis);
