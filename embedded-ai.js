/* Optional Firebase AI Logic adapter. The legacy personal-key client stays isolated. */
(function(root){
 'use strict';
 const MODELS=new Set(['gemini-3.5-flash-lite','gemini-3.1-flash-lite']);
 function isConfigured(config){
  return config?.mode==='shared-firebase'&&MODELS.has(config.model)&&
   !!config.firebase&&['apiKey','appId','projectId'].every(k=>typeof config.firebase[k]==='string'&&!!config.firebase[k].trim())&&
   typeof config.appCheckSiteKey==='string'&&!!config.appCheckSiteKey.trim();
 }
 async function loadSDK(){
  const [app,check,ai]=await Promise.all([
   import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
   import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js'),
   import('https://www.gstatic.com/firebasejs/12.19.0/firebase-ai.js')
  ]);
  return {app,check,ai};
 }
 function abortAware(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(root.LiveCore.abortError());
  return new Promise((resolve,reject)=>{
   let done=false;
   const finish=(fn,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);fn(value);};
   const abort=()=>finish(reject,root.LiveCore.abortError());
   signal.addEventListener('abort',abort,{once:true});
   Promise.resolve(promise).then(v=>finish(resolve,v),e=>finish(reject,e));
  });
 }
 function asAppError(error,signal){
  root.LiveCore.check(signal);
  if(error instanceof root.LiveCore.AppError)return error;
  const message=String(error?.message||error||''),code=String(error?.code||''),reason=code+' '+message;
  if(/429|resource.exhausted|quota|rate.limit|too.many.requests/i.test(reason))
   return new root.LiveCore.AppError('組み込みGeminiの共有利用枠・頻度制限に達しました（HTTP 429）。','429');
  if(/503|unavailable|overloaded/i.test(reason))
   return new root.LiveCore.AppError('組み込みGeminiが一時的に利用できません（HTTP 503）。','503');
  if(/500|502|504|internal/i.test(reason))
   return new root.LiveCore.AppError('組み込みGeminiで一時的なエラーが発生しました（HTTP 500）。','500');
  if(/must enforce firebase app check|firebase ai logic has been deactivated/i.test(reason))
   return new root.LiveCore.AppError('Firebase AI LogicのApp Check適用が必要です。ベースライン保護が「適用」か確認してください。リプレイ保護がモニタリング中でも限定使用トークンを使用します。','AUTH');
  if(/app.?check|recaptcha|attestation/i.test(reason))
   return new root.LiveCore.AppError('App Checkの検証に失敗しました。reCAPTCHAのサイトキー、登録ドメイン、Firebaseのアプリ登録を確認してください。','AUTH');
  if(/403|permission|unauthentic|unauthoriz|401|api.key/i.test(reason))
   return new root.LiveCore.AppError('Firebase AI Logicの認証・権限エラーです。App Checkの適用、APIの有効化、Firebase Web設定のAPIキー制限を確認してください。','AUTH');
  if(/404|not.found|model/i.test(reason))
   return new root.LiveCore.AppError('組み込みAIのモデルが利用できません。FirebaseのAI設定を確認してください。','404');
  return new root.LiveCore.AppError('組み込みGeminiへの接続に失敗しました。通信やFirebase設定を確認してください。','NETWORK');
 }
 function createClient(config,{sdkLoader=loadSDK}={}){
  const available=isConfigured(config);
  let initialized=null;
  async function getAIService(){
   if(!available)throw new root.LiveCore.AppError('組み込みAIは未設定です。FirebaseとApp Checkの設定が必要です。','AUTH');
   if(!initialized)initialized=(async()=>{
    const {app,check,ai}=await sdkLoader();
    const firebase=app.initializeApp(config.firebase,'minkome-ai-shared');
    const appCheck=check.initializeAppCheck(firebase,{
     provider:new check.ReCaptchaEnterpriseProvider(config.appCheckSiteKey),
     isTokenAutoRefreshEnabled:true
    });
    await check.getToken(appCheck);
    // Replay monitoring can require limited-use App Check tokens for AI calls.
    return {service:ai.getAI(firebase,{
      backend:new ai.GoogleAIBackend(),
      useLimitedUseAppCheckTokens:true
    }),ai};
   })().catch(error=>{initialized=null;throw error;});
   return initialized;
  }
  return {
   available,model:available?config.model:'',
   async generate(payload,signal){
    root.LiveCore.check(signal);
    try{
     const {service,ai}=await abortAware(getAIService(),signal);
     root.LiveCore.check(signal);
     // Use the existing prompt, images, thinking settings, output cap and JSON schema.
     const model=ai.getGenerativeModel(service,{
      model:config.model,
      ...(payload.systemInstruction?{systemInstruction:payload.systemInstruction}:{}),
      ...(payload.generationConfig?{generationConfig:payload.generationConfig}:{})
     });
     const result=await abortAware(model.generateContent({contents:payload.contents}),signal);
     root.LiveCore.check(signal);
     if(!result?.response)throw new root.LiveCore.AppError('組み込みAIから応答を取得できませんでした。','RESPONSE');
     return result.response; // candidates[].content.parts[] is compatible with LiveCore
    }catch(error){throw asAppError(error,signal);}
   }
  };
 }
 root.LiveEmbeddedAI={createClient,isConfigured,MODELS};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.LiveEmbeddedAI;
})(globalThis);
