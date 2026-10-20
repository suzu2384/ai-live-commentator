/* Google Drive appDataFolder storage for normal settings and plaintext secrets. */
(function(root){
  'use strict';
  const SCOPE='https://www.googleapis.com/auth/drive.appdata';
  const SETTINGS_FILE='minkome-settings.json';
  const SECRETS_FILE='minkome-secrets.json';
  const API='https://www.googleapis.com/drive/v3';
  const UPLOAD='https://www.googleapis.com/upload/drive/v3';

  function text(value){return String(value??'').trim();}
  function validClientId(value){return /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(text(value));}
  function availableOrigin(locationValue=root.location){
    const protocol=locationValue?.protocol||'';
    const hostname=String(locationValue?.hostname||'').toLowerCase();
    if(protocol==='https:')return true;
    if(protocol==='http:'&&(hostname==='localhost'||hostname==='127.0.0.1'||hostname==='[::1]'||hostname==='::1'))return true;
    return false;
  }
  function escapeQuery(value){return String(value).replaceAll('\\','\\\\').replaceAll("'","\\'");}
  async function responseError(response,defaultMessage){
    let detail='';
    try{
      const body=await response.clone().json();
      detail=body?.error?.message||body?.error_description||'';
    }catch{
      try{detail=(await response.clone().text()).trim();}catch{}
    }
    const error=new Error(detail?defaultMessage+': '+detail:defaultMessage);
    error.status=response.status;
    return error;
  }

  class DriveClient{
    constructor({fetchImpl=root.fetch?.bind(root),googleProvider=()=>root.google,locationValue=root.location}={}){
      if(typeof fetchImpl!=='function')throw new Error('fetchが利用できません。');
      this.fetchImpl=fetchImpl;this.googleProvider=googleProvider;this.locationValue=locationValue;
      this.clientId='';this.tokenClient=null;this.accessToken='';
    }
    configure(clientId){
      const id=text(clientId);
      if(!validClientId(id))throw new Error('Google OAuth Client IDを確認してください。');
      if(!availableOrigin(this.locationValue))throw new Error('Google Drive連携はGitHub Pagesまたはhttp://localhostで開いた時に利用できます。');
      const google=this.googleProvider();
      if(!google?.accounts?.oauth2?.initTokenClient)throw new Error('Google認証ライブラリを読み込めませんでした。ネット接続を確認してください。');
      if(this.clientId===id&&this.tokenClient)return;
      this.clientId=id;this.accessToken='';
      this.tokenClient=google.accounts.oauth2.initTokenClient({client_id:id,scope:SCOPE,callback:()=>{}});
    }
    async authorize({prompt='consent'}={}){
      if(!this.tokenClient)throw new Error('Google OAuth Client IDを設定してください。');
      return new Promise((resolve,reject)=>{
        this.tokenClient.callback=response=>{
          if(response?.error){const e=new Error(response.error_description||response.error);e.code='GOOGLE_AUTH';reject(e);return;}
          const token=text(response?.access_token);
          if(!token){reject(new Error('Googleのアクセストークンを取得できませんでした。'));return;}
          this.accessToken=token;resolve(token);
        };
        try{this.tokenClient.requestAccessToken({prompt});}catch(e){reject(e);}
      });
    }
    async ensureAuthorized(interactive=false){
      if(this.accessToken)return this.accessToken;
      return this.authorize({prompt:interactive?'consent':''});
    }
    async disconnect(){
      const token=this.accessToken,google=this.googleProvider();this.accessToken='';
      if(token&&google?.accounts?.oauth2?.revoke)await new Promise(resolve=>google.accounts.oauth2.revoke(token,()=>resolve()));
    }
    async request(url,{method='GET',headers={},body,interactive=false}={}){
      const token=await this.ensureAuthorized(interactive);
      const response=await this.fetchImpl(url,{method,headers:{Authorization:'Bearer '+token,...headers},body,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      if(response.status===401){this.accessToken='';const e=await responseError(response,'Google Driveの認証期限が切れました。再接続してください。');e.code='AUTH_EXPIRED';throw e;}
      if(!response.ok)throw await responseError(response,'Google Drive APIがHTTP '+response.status+'を返しました');
      return response;
    }
    async findFile(name){
      const q="name='"+escapeQuery(name)+"' and 'appDataFolder' in parents and trashed=false";
      const params=new URLSearchParams({spaces:'appDataFolder',q,fields:'files(id,name,modifiedTime,size)',pageSize:'10'});
      const response=await this.request(API+'/files?'+params);
      const data=await response.json(),files=Array.isArray(data.files)?data.files:[];
      files.sort((a,b)=>String(b.modifiedTime||'').localeCompare(String(a.modifiedTime||'')));
      return files[0]||null;
    }
    async readJson(name){
      const file=await this.findFile(name);if(!file)return null;
      const response=await this.request(API+'/files/'+encodeURIComponent(file.id)+'?alt=media');
      let value;try{value=await response.json();}catch{throw new Error(name+'をJSONとして読み取れませんでした。');}
      return {file,value};
    }
    async createFile(name){
      const response=await this.request(API+'/files?fields=id,name,modifiedTime',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,parents:['appDataFolder'],mimeType:'application/json'})});
      return response.json();
    }
    async writeJson(name,value){
      let file=await this.findFile(name);if(!file)file=await this.createFile(name);
      const response=await this.request(UPLOAD+'/files/'+encodeURIComponent(file.id)+'?uploadType=media&fields=id,name,modifiedTime',{method:'PATCH',headers:{'Content-Type':'application/json; charset=UTF-8'},body:JSON.stringify(value,null,2)+'\n'});
      return response.json();
    }
    async deleteJson(name){
      const file=await this.findFile(name);if(!file)return false;
      await this.request(API+'/files/'+encodeURIComponent(file.id),{method:'DELETE'});return true;
    }
    async status(){
      const [settings,secrets]=await Promise.all([this.findFile(SETTINGS_FILE),this.findFile(SECRETS_FILE)]);
      return {settings,secrets};
    }
  }

  root.LiveDriveSync={SCOPE,SETTINGS_FILE,SECRETS_FILE,validClientId,availableOrigin,DriveClient};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.LiveDriveSync;
})(globalThis);
