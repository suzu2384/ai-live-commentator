const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const python=path.resolve(__dirname,'../tools/sync-ai-config.py');
test('AI public config only enables verified Spark/App Check and changes cache key',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'minkome-ai-'));
 try{
  fs.writeFileSync(path.join(root,'index.html'),'<script src="ai-config.js?v=4.51.0" defer></script>');
  const config=JSON.stringify({apiKey:'public-key',appId:'firebase-app',projectId:'independent-project'});
  const vars={MINKOME_AI_FIREBASE_CONFIG:config,MINKOME_AI_APP_CHECK_SITE_KEY:'site-key',MINKOME_AI_SPARK_VERIFIED:'true'};
  const run=v=>spawnSync('python3',[python,'--root',root],{encoding:'utf8',
   env:{...process.env,MINKOME_AI_FIREBASE_CONFIG:'',MINKOME_AI_APP_CHECK_SITE_KEY:'',MINKOME_AI_SPARK_VERIFIED:'',MINKOME_AI_MODEL:'',...v}});
  let result=run({});assert.equal(result.status,0,result.stderr);
  assert.match(fs.readFileSync(path.join(root,'ai-config.js'),'utf8'),/"mode":"disabled"/);
  result=run({...vars,MINKOME_AI_SPARK_VERIFIED:'false'});
  assert.notEqual(result.status,0);
  result=run(vars);assert.equal(result.status,0,result.stderr);
  assert.match(fs.readFileSync(path.join(root,'ai-config.js'),'utf8'),/"mode":"shared-firebase"/);
  const first=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(first,/ai-config\.js\?v=4\.51\.0&amp;id=[0-9a-f]{12}/);
  assert.equal(run(vars).status,0);
  assert.equal(fs.readFileSync(path.join(root,'index.html'),'utf8'),first);
  assert.equal(run({...vars,MINKOME_AI_MODEL:'gemini-3.1-flash-lite'}).status,0);
  assert.notEqual(fs.readFileSync(path.join(root,'index.html'),'utf8'),first);
  assert.notEqual(run({...vars,MINKOME_AI_MODEL:'gemini-4-argon'}).status,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
