const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Window}=require('happy-dom');

const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function makePage(configured=true,codecraft=false){
  const html=fs.readFileSync('index.html','utf8');
  const script=html.split('<script>')[1].split('</script>')[0];
  const window=new Window({url:'https://app.example/#chat'});
  window.document.write(html.replace(/<script src="\/auth.js"><\/script>/,'').replace(/<script>[\s\S]*?<\/script>/,''));
  const writes=[];let callback,writeFailures=0,readFailures=0,session=null,codecraftHeaders=[];
  const client={
    auth:{onAuthStateChange(fn){callback=fn;fn('INITIAL_SESSION',null)},async signInWithPassword({email}){session={access_token:'supabase-session',user:{id:email,email}};callback('SIGNED_IN',session);return {data:{},error:null}},async getSession(){return {data:{session},error:null}},async signOut(){session=null;callback('SIGNED_OUT',null);return {error:null}}},
    from(){return {select(){return {eq(){return {async maybeSingle(){if(readFailures>0){readFailures--;return {data:null,error:{message:'Database unavailable'}}}return {data:{chats:[],settings:{}},error:null}}}}}},async upsert(data){writes.push(data);if(writeFailures>0){writeFailures--;return {error:{message:'Network unavailable'}}}return {error:null}}}}
  };
  window.structuredClone=structuredClone;window.TextDecoder=TextDecoder;
  window.createGembyClient=()=>client;
  window.fetch=async (url,options={})=>{
    if(url==='/api/config')return new Response(JSON.stringify(configured?{supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-key',codecraftConfigured:codecraft,codecraftAccessConfigured:codecraft}:{}),{status:200});
    if(url==='/api/codecraft/models'){codecraftHeaders.push(options.headers);return new Response(JSON.stringify({data:[{id:'test-sonnet',type:'chat',capabilities:['tools','streaming']}]}),{status:200,headers:{'content-type':'application/json'}})}
    if(url==='/api/codecraft/chat/completions'){codecraftHeaders.push(options.headers);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello from CodeCraft'}}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})}
    if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[]}),{status:200});
    throw new Error('Unexpected network request '+url);
  };
  window.eval(script);await pause();
  return {window,writes,codecraftHeaders,emit:(event,session)=>callback(event,session),failWrites:n=>{writeFailures=n},failReads:n=>{readFailures=n}};
}

test('page sign-in, single-key settings and sign-out isolate visible account state',async()=>{
  const {window,writes}=await makePage();const d=window.document;
  try{
    assert.match(d.title,/Gemby AIs/);
    assert.equal(d.getElementById('auth-dlg').open,true);
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';
    d.getElementById('auth-login').click();await pause();
    assert.equal(d.getElementById('auth-dlg').open,false);
    d.getElementById('settings').click();assert.equal(d.getElementById('dlg').open,true);
    d.getElementById('ai-key').value='private-openrouter-key';d.getElementById('s-save').click();await pause();
    assert.ok(writes.length);assert.doesNotMatch(JSON.stringify(writes),/private-openrouter-key/);
    window.confirm=()=>false;d.querySelector('[data-p="nvidia"]').click();d.getElementById('settings').click();assert.equal(d.getElementById('ai-key').value,'private-openrouter-key');d.getElementById('s-cancel').click();
    window.confirm=()=>true;d.querySelector('[data-p="nvidia"]').click();d.getElementById('settings').click();
    assert.equal(d.getElementById('ai-key').value,'');assert.match(d.getElementById('key-provider').textContent,/NVIDIA/);
    d.getElementById('s-cancel').click();d.getElementById('account').click();d.getElementById('auth-logout').click();await pause();
    assert.equal(d.getElementById('account').textContent,'Sign in');
    assert.equal(d.getElementById('ai-key').value,'');
  }finally{await window.happyDOM.abort();}
});

test('page clearly reports missing Supabase configuration',async()=>{
  const {window}=await makePage(false);
  try{assert.match(window.document.getElementById('auth-message').textContent,/Supabase is not configured/);assert.equal(window.document.getElementById('setup-help').open,true);assert.equal(window.document.querySelector('#setup-help a').getAttribute('href'),'/schema.sql');}
  finally{await window.happyDOM.abort();}
});

test('bundled Supabase client initializes and uses the configured auth endpoint',async()=>{
  const html=fs.readFileSync('index.html','utf8');
  const script=html.split('<script>')[1].split('</script>')[0];
  const window=new Window({url:'https://app.example/#chat'});
  window.document.write(html.replace(/<script src="\/auth.js"><\/script>/,'').replace(/<script>[\s\S]*?<\/script>/,''));
  window.structuredClone=structuredClone;
  let authRequests=0;
  window.fetch=async(url,options={})=>{
    url=String(url);
    if(url==='/api/config')return new Response(JSON.stringify({supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-key'}),{status:200});
    if(url.endsWith('/models'))return new Response(JSON.stringify({data:[]}),{status:200});
    if(url.includes('/auth/v1/token?grant_type=password')){authRequests++;return new Response(JSON.stringify({access_token:'test-access',refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user:{id:'test-user',email:'test@example.com'}}),{status:200,headers:{'content-type':'application/json'}});}
    if(url.includes('/rest/v1/gemby_profiles'))return new Response('[]',{status:200,headers:{'content-type':'application/json'}});
    throw new Error('Unexpected request '+url);
  };
  try{
    window.eval(fs.readFileSync('public/auth.js','utf8'));window.eval(script);await pause();
    window.document.getElementById('auth-email').value='test@example.com';window.document.getElementById('auth-password').value='test-password';
    window.document.getElementById('auth-login').click();await pause();
    assert.equal(authRequests,1);assert.match(window.document.getElementById('auth-message').textContent,/Signed in/);
  }finally{await window.happyDOM.abort();}
});

test('old browser chats are imported only after explicit confirmation',async()=>{
  const {window,writes}=await makePage();const d=window.document;
  try{
    window.localStorage.setItem('fw.chats',JSON.stringify([{id:'old',title:'Previous',msgs:[{role:'user',content:'Hello before'}]}]));
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    d.getElementById('account').click();assert.equal(d.getElementById('auth-import').hidden,false);
    window.confirm=()=>false;d.getElementById('auth-import').click();await pause();assert.equal(writes.length,0);
    window.confirm=()=>true;d.getElementById('auth-import').click();await pause();assert.match(JSON.stringify(writes),/Hello before/);assert.equal(d.getElementById('auth-import').hidden,true);
  }finally{await window.happyDOM.abort();}
});

test('failed sync can be retried without editing or losing the key',async()=>{
  const {window,writes,failWrites}=await makePage();const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    failWrites(1);d.getElementById('settings').click();d.getElementById('ai-key').value='private-key';d.getElementById('s-save').click();await pause();
    assert.equal(d.getElementById('sync-retry').hidden,false);assert.match(d.getElementById('sync-status').textContent,/failed/);
    d.getElementById('sync-retry').click();await pause();assert.equal(d.getElementById('sync-retry').hidden,true);assert.equal(d.getElementById('sync-status').textContent,'Synced');assert.equal(writes.length,2);
    d.getElementById('settings').click();assert.equal(d.getElementById('ai-key').value,'private-key');
  }finally{await window.happyDOM.abort();}
});

test('failed account load can be retried without signing out',async()=>{
  const {window,failReads}=await makePage();const d=window.document;
  try{
    failReads(1);d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    assert.equal(d.getElementById('auth-retry').hidden,false);assert.match(d.getElementById('auth-message').textContent,/Could not load/);
    d.getElementById('auth-retry').click();await pause();assert.equal(d.getElementById('auth-dlg').open,false);assert.equal(d.getElementById('sync-status').textContent,'Synced');
  }finally{await window.happyDOM.abort();}
});

test('CodeCraft model selection and chat use only the account session, not a browser key',async()=>{
  const {window,codecraftHeaders}=await makePage(true,true);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    d.querySelector('[data-p="codecraft"]').click();await pause();
    assert.equal(d.getElementById('mname').textContent,'test-sonnet');
    d.getElementById('settings').click();assert.equal(d.getElementById('ai-key').disabled,true);assert.match(d.getElementById('codecraft-status').textContent,/key configured/);d.getElementById('s-cancel').click();
    d.getElementById('input').value='Hello';d.getElementById('form').requestSubmit();await pause();
    assert.match(d.getElementById('wrap').textContent,/Hello from CodeCraft/);
    assert.equal(codecraftHeaders.length,2);assert.equal(codecraftHeaders[0].Authorization,'Bearer supabase-session');assert.equal(codecraftHeaders[1].Authorization,'Bearer supabase-session');
  }finally{await window.happyDOM.abort();}
});
