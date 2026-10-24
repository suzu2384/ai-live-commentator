/* Independent service grants, shared one-step renewal. */
(function(root){
 'use strict';
 const SCOPES={drive:'https://www.googleapis.com/auth/drive.appdata',youtube:'https://www.googleapis.com/auth/youtube.readonly'};
 const EMAIL='https://www.googleapis.com/auth/userinfo.email',KEY='minkome-google-linked-v1',ACCOUNT='minkome-google-account-v1';
 const SESSION='minkome-google-session-v1',PERSIST='minkome-google-persistent-token-v1',KEEP='minkome-google-keep-connected-v1';
 const valid=id=>/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(String(id||'').trim());
 class GoogleAuth{
  constructor(clientId){
   this.clientId=String(clientId||'').trim();this.tokens={drive:null,youtube:null};this.pending=false;
   try{const v=JSON.parse(root.localStorage?.getItem(KEY)||'{}');this.linked={drive:v.drive===true,youtube:v.youtube===true};this.email=root.localStorage?.getItem(ACCOUNT)||'';}
   catch{this.linked={drive:false,youtube:false};this.email='';}
   this.restoreTokens();
  }
  get keepConnected(){try{return root.localStorage?.getItem(KEEP)==='1';}catch{return false;}}
  tokenRecord(){
   return {version:1,clientId:this.clientId,email:this.email,
     tokens:Object.fromEntries(Object.keys(SCOPES).filter(s=>this.linked[s]&&this.token(s)).map(s=>[s,{...this.tokens[s],scope:SCOPES[s]}]))};
  }
  saveTokens(){
   const rec=this.tokenRecord(),valid=Object.keys(rec.tokens).length>0,raw=JSON.stringify(rec);
   try{if(valid)root.sessionStorage?.setItem(SESSION,raw);else root.sessionStorage?.removeItem(SESSION);}catch{}
   try{
    if(valid&&this.keepConnected)root.localStorage?.setItem(PERSIST,raw);
    else root.localStorage?.removeItem(PERSIST);
   }catch{}
  }
  restoreTokens(){
   const now=Date.now(),maxFuture=now+24*60*60*1000;
   let raw=null;
   try{raw=root.sessionStorage?.getItem(SESSION);}catch{}
   if(!raw&&this.keepConnected){try{raw=root.localStorage?.getItem(PERSIST);}catch{}}
   if(!raw)return;
   let saved;
   try{saved=JSON.parse(raw);}catch{saved=null;}
   if(saved?.version!==1||saved?.clientId!==this.clientId||saved?.email!==this.email||!saved?.tokens){
    this.saveTokens();return;
   }
   for(const [service,scope] of Object.entries(SCOPES)){
    const t=saved.tokens[service];
    if(this.linked[service]&&t?.scope===scope&&typeof t.value==='string'&&t.value.length>0&&t.value.length<8192&&
      Number.isFinite(t.expires)&&t.expires>now&&t.expires<=maxFuture)this.tokens[service]={value:t.value,expires:t.expires};
   }
   this.saveTokens();
  }
  setKeepConnected(enabled){
   if(enabled){
    try{
     if(!root.localStorage)throw Error();
     root.localStorage.setItem(KEEP,'1');
     this.saveTokens();
    }catch{throw Error('この端末では認証の保持を有効化できません。ブラウザの保存設定を確認してください。');}
   }else{
    try{root.localStorage?.removeItem(KEEP);root.localStorage?.removeItem(PERSIST);}catch{}
   }
  }
  services(){return Object.keys(SCOPES).filter(s=>this.linked[s]);}
  isLinked(s){return !!this.linked[s];}
  token(s){const t=this.tokens[s];return t&&t.expires>Date.now()?t.value:'';}
  save(){try{root.localStorage?.setItem(KEY,JSON.stringify(this.linked));if(this.email)root.localStorage?.setItem(ACCOUNT,this.email);else root.localStorage?.removeItem(ACCOUNT);}catch{}}
  disconnect(s){if(!SCOPES[s])throw Error('不明なGoogleサービスです。');this.linked[s]=false;this.tokens[s]=null;if(!this.services().length){this.email='';this.setKeepConnected(false);}this.save();this.saveTokens();}
  authorize(names){
   const services=[...new Set(names)];
   if(!services.length||services.some(s=>!SCOPES[s]))throw Error('認証対象のサービスがありません。');
   if(!valid(this.clientId))throw Error('GitHubのGOOGLE_OAUTH_CLIENT_IDを設定してください。');
   const oauth=root.google?.accounts?.oauth2;if(!oauth?.initTokenClient)throw Error('Google認証の読み込みが完了していません。');
   if(this.pending)throw Error('Google認証の処理中です。');
   this.pending=true;const scopes=[...services.map(s=>SCOPES[s]),EMAIL];
   return new Promise((resolve,reject)=>{
    let done=false;
    const fail=e=>{if(done)return;done=true;this.pending=false;reject(e);};
    try{
     const client=oauth.initTokenClient({
      client_id:this.clientId,scope:scopes.join(' '),...(this.email?{login_hint:this.email}:{}),
      callback:async r=>{
       if(done)return;
       try{
        if(r?.error)throw Error('Google認証に失敗しました（'+r.error+'）。');
        if(!r?.access_token||!oauth.hasGrantedAllScopes(r,...scopes))throw Error('必要な権限がすべて許可されていません。');
        const expires=Date.now()+Math.max(0,Number(r.expires_in||0)-60)*1000;
        if(expires<=Date.now())throw Error('有効な認証情報を取得できませんでした。');
        const res=await root.fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:'Bearer '+r.access_token},cache:'no-store',credentials:'omit'});
        if(!res.ok)throw Error('Googleアカウントを確認できませんでした。');
        const email=String((await res.json()).email||'').trim().toLowerCase();
        if(!email)throw Error('Googleアカウントを確認できませんでした。');
        if(this.email&&this.email.toLowerCase()!==email)throw Error('別のGoogleアカウントです。先に接続したアカウントを選んでください。');
        this.email=email;for(const s of services){this.linked[s]=true;this.tokens[s]={value:r.access_token,expires};}
        this.save();this.saveTokens();done=true;this.pending=false;resolve(services);
       }catch(e){fail(e);}
      },
      error_callback:e=>fail(Error(e?.type==='popup_closed'?'Google認証画面を閉じました。':'Google認証画面を開けませんでした。'))
     });
     // Invocation stays within the original click gesture.
     client.requestAccessToken({prompt:''});
    }catch(e){fail(e);}
   });
  }
 }
 root.LiveGoogleAuth={GoogleAuth,valid,SCOPES};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.LiveGoogleAuth;
})(globalThis);
