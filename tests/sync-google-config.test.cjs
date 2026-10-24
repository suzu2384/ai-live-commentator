const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const python=path.resolve(__dirname,'../tools/sync-google-config.py');

test('Google OAuth config sync invalidates its URL when the client ID changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minkome-oauth-'));
 try{
  const filename=path.join(dir,'index.html');
  fs.writeFileSync(filename,'<script src="google-config.js?v=4.50.3" defer></script>\n');
  const run=id=>spawnSync('python3',[python,'--root',dir],{encoding:'utf-8',env:{...process.env,GOOGLE_OAUTH_CLIENT_ID:id}});
  const first=run('123456789-first.apps.googleusercontent.com');
  assert.equal(first.status,0,first.stderr);
  const html1=fs.readFileSync(filename,'utf8');
  assert.match(html1,/google-config\.js\?v=4\.50\.3&amp;id=[0-9a-f]{12}/);
  assert.match(fs.readFileSync(path.join(dir,'google-config.js'),'utf8'),/123456789-first/);
  const second=run('123456789-second.apps.googleusercontent.com');
  assert.equal(second.status,0,second.stderr);
  const html2=fs.readFileSync(filename,'utf8');
  assert.notEqual(html1,html2);
  assert.equal(run('123456789-second.apps.googleusercontent.com').status,0);
  assert.equal(fs.readFileSync(filename,'utf8'),html2);
  assert.notEqual(run('').status,0);
  assert.equal(fs.readFileSync(filename,'utf8'),html2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
