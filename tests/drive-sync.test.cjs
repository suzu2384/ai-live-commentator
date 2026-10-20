const {test}=require('node:test');
const assert=require('node:assert/strict');
const D=require('../drive-sync.js');

test('Drive OAuth accepts HTTPS and localhost but not file origins',()=>{
  assert.equal(D.availableOrigin({protocol:'https:',hostname:'example.com'}),true);
  assert.equal(D.availableOrigin({protocol:'http:',hostname:'localhost'}),true);
  assert.equal(D.availableOrigin({protocol:'file:',hostname:''}),false);
  assert.equal(D.availableOrigin({protocol:'http:',hostname:'192.168.1.2'}),false);
  assert.equal(D.validClientId('123456789-test.apps.googleusercontent.com'),true);
  assert.equal(D.validClientId('not-a-client-id'),false);
});

test('Drive appData client writes, reads and deletes settings and secrets as separate files',async()=>{
  const files=new Map();let next=1;
  const google={accounts:{oauth2:{initTokenClient:()=>({
    callback:null,
    requestAccessToken(){this.callback({access_token:'drive-token'});}
  }),revoke(_token,cb){cb();}}}};
  const fetchImpl=async(url,options={})=>{
    assert.equal(options.headers?.Authorization,'Bearer drive-token');
    const u=new URL(url),method=options.method||'GET';
    if(u.hostname==='www.googleapis.com'&&u.pathname==='/drive/v3/files'&&method==='GET'){
      const q=u.searchParams.get('q')||'',match=q.match(/name='([^']+)'/),name=match?.[1]||'';
      const list=[...files.values()].filter(f=>f.name===name).map(({id,name,modifiedTime,body})=>({id,name,modifiedTime,size:String(body?.length||0)}));
      return new Response(JSON.stringify({files:list}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    if(u.hostname==='www.googleapis.com'&&u.pathname==='/drive/v3/files'&&method==='POST'){
      const meta=JSON.parse(options.body),id='f'+next++,file={id,name:meta.name,modifiedTime:new Date().toISOString(),body:''};files.set(id,file);
      assert.deepEqual(meta.parents,['appDataFolder']);
      return new Response(JSON.stringify({id,name:file.name,modifiedTime:file.modifiedTime}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    const media=u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if(u.hostname==='www.googleapis.com'&&media&&method==='GET'&&u.searchParams.get('alt')==='media'){
      const file=files.get(media[1]);return new Response(file.body,{status:200,headers:{'Content-Type':'application/json'}});
    }
    if(u.hostname==='www.googleapis.com'&&media&&method==='DELETE'){files.delete(media[1]);return new Response(null,{status:204});}
    const upload=u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if(u.hostname==='www.googleapis.com'&&upload&&method==='PATCH'){
      const file=files.get(upload[1]);file.body=String(options.body);file.modifiedTime=new Date(Date.now()+1000).toISOString();
      return new Response(JSON.stringify({id:file.id,name:file.name,modifiedTime:file.modifiedTime}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    throw new Error('unexpected '+method+' '+url);
  };
  const client=new D.DriveClient({fetchImpl,googleProvider:()=>google,locationValue:{protocol:'https:',hostname:'example.com'}});
  client.configure('123456789-test.apps.googleusercontent.com');await client.authorize();
  const settings={format:'minkome-settings',version:1,settings:{theme:'midnight'}};
  const secrets={format:'minkome-secrets',version:1,apiKey:'secret-a',obsPassword:'secret-b',youtubeApiKey:'secret-c'};
  await client.writeJson(D.SETTINGS_FILE,settings);await client.writeJson(D.SECRETS_FILE,secrets);
  assert.equal(files.size,2);
  assert.deepEqual((await client.readJson(D.SETTINGS_FILE)).value,settings);
  assert.deepEqual((await client.readJson(D.SECRETS_FILE)).value,secrets);
  const status=await client.status();assert.equal(status.settings.name,D.SETTINGS_FILE);assert.equal(status.secrets.name,D.SECRETS_FILE);
  assert.equal(await client.deleteJson(D.SECRETS_FILE),true);assert.equal(await client.readJson(D.SECRETS_FILE),null);
  await client.disconnect();assert.equal(client.accessToken,'');
});
