const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js');
const Embedded=require('../embedded-ai.js');
const config={mode:'shared-firebase',firebase:{apiKey:'public',appId:'firebase-app',projectId:'independent-project'},appCheckSiteKey:'site-key',model:'gemini-3.5-flash-lite'};
function mock(){
 const info={initializations:0,attestations:0,models:[],contents:[]};
 const sdk={
  app:{initializeApp:(settings,name)=>{info.initializations++;assert.equal(name,'minkome-ai-shared');assert.equal(settings.projectId,config.firebase.projectId);return {};}},
  check:{
   ReCaptchaEnterpriseProvider:class{constructor(key){assert.equal(key,'site-key');}},
   initializeAppCheck:(_app,options)=>{assert.equal(options.isTokenAutoRefreshEnabled,true);return {};},
   getToken:async()=>{info.attestations++;return {token:'checked'};}
  },
  ai:{GoogleAIBackend:class{},getAI:()=>({}),
   getGenerativeModel:(_service,options)=>{
    info.models.push(options);
    return {generateContent:async contents=>{
     info.contents.push(contents);
     return {response:{candidates:[{finishReason:'STOP',content:{parts:[{text:'{"speak":true}'}]}}]}};
    }};
   }}
 };
 return {sdk,info};
}
test('the embedded adapter preserves image, JSON schema, thinking, and response shape',async()=>{
 const {sdk,info}=mock();
 const provider=Embedded.createClient(config,{sdkLoader:async()=>sdk});
 const payload={systemInstruction:{parts:[{text:'system'}]},
  contents:[{role:'user',parts:[{text:'picture'},{inlineData:{mimeType:'image/jpeg',data:'AQ=='}}]}],
  generationConfig:{maxOutputTokens:2048,responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'MINIMAL',includeThoughts:false},responseSchema:{type:'OBJECT',properties:{speak:{type:'BOOLEAN'}}}}};
 C.setEmbeddedRequest((request,signal)=>provider.generate(request,signal));
 try{
  let r=await C.gemini(C.EMBEDDED_CREDENTIAL,payload);
  assert.equal(C.candidateText(r),'{"speak":true}');
  r=await C.gemini(C.EMBEDDED_CREDENTIAL,payload);
  assert.equal(info.initializations,1);assert.equal(info.attestations,1);
  assert.equal(info.models.length,2);
  assert.deepEqual(info.models[0].generationConfig,payload.generationConfig);
  assert.deepEqual(info.models[0].systemInstruction,payload.systemInstruction);
  assert.equal(info.models[0].model,config.model);
  assert.deepEqual(info.contents[0],{contents:payload.contents});
 }finally{C.setEmbeddedRequest(null);}
});
test('missing config fails closed without calling the Firebase SDK',async()=>{
 assert.equal(Embedded.isConfigured({mode:'disabled'}),false);
 const missing=Embedded.createClient({mode:'disabled'});
 assert.equal(missing.available,false);
 await assert.rejects(missing.generate({contents:[]}),/未設定/);
 await assert.rejects(C.gemini(C.EMBEDDED_CREDENTIAL,{contents:[]}),/設定されていません/);
});
test('Firebase quota errors use the existing 429 handling',async()=>{
 const {sdk}=mock();
 sdk.ai.getGenerativeModel=()=>({generateContent:async()=>{throw Error('429 RESOURCE_EXHAUSTED quota');}});
 const provider=Embedded.createClient(config,{sdkLoader:async()=>sdk});
 await assert.rejects(provider.generate({contents:[{role:'user',parts:[{text:'test'}]}]}),error=>error.code==='429');
});
test('cancelled requests do not accept late SDK responses',async()=>{
 const {sdk}=mock();let complete;
 sdk.ai.getGenerativeModel=()=>({generateContent:()=>new Promise(resolve=>{complete=resolve;})});
 const provider=Embedded.createClient(config,{sdkLoader:async()=>sdk});
 const ac=new AbortController();
 const result=provider.generate({contents:[{role:'user',parts:[{text:'test'}]}]},ac.signal);
 await new Promise(resolve=>setTimeout(resolve,0));
 ac.abort();
 await assert.rejects(result,e=>e.name==='AbortError');
 complete({response:{candidates:[]}});
});
