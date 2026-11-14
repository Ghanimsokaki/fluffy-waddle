const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Window}=require('happy-dom');

const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function makePage(configured=true,codecraft=false,opts={}){
  const html=fs.readFileSync('index.html','utf8');
  const script=html.split('<script>')[1].split('</script>')[0];
  const window=new Window({url:opts.url||'https://app.example/#chat'});
  window.document.write(html.replace(/<script src="\/auth.js"><\/script>/,'').replace(/<script>[\s\S]*?<\/script>/,''));
  const writes=[],oauthCalls=[],clientArgs=[];let callback,writeFailures=0,readFailures=0,session=null,codecraftHeaders=[];
  const client={
    auth:{onAuthStateChange(fn){callback=fn;fn('INITIAL_SESSION',null)},async signInWithPassword({email}){session={access_token:'supabase-session',user:{id:email,email}};callback('SIGNED_IN',session);return {data:{},error:null}},async getSession(){return {data:{session},error:null}},async signOut(){session=null;callback('SIGNED_OUT',null);return {error:null}},async signInWithOAuth(args){oauthCalls.push(args);return {data:{},error:null}}},
    from(){return {select(){return {eq(){return {async maybeSingle(){if(readFailures>0){readFailures--;return {data:null,error:{message:'Database unavailable'}}}const profile=opts.profiles?.[session?.user?.id];return {data:profile?structuredClone(profile):{chats:[],settings:{}},error:null}}}}}},async upsert(data){writes.push(data);if(writeFailures>0){writeFailures--;return {error:{message:'Network unavailable'}}}return {error:null}}}}
  };
  window.structuredClone=structuredClone;window.TextDecoder=TextDecoder;
  window.createGembyClient=(...args)=>{clientArgs.push(args);return client};
  window.fetch=async (url,options={})=>{
    const custom=await opts.fetch?.(String(url),options);if(custom)return custom;
    if(url==='/api/config')return new Response(JSON.stringify(configured?{supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-key',codecraftConfigured:codecraft,codecraftAccessConfigured:codecraft}:{}),{status:200});
    if(url==='/api/codecraft/models'){codecraftHeaders.push(options.headers);return new Response(JSON.stringify({data:[{id:'test-sonnet',type:'chat',capabilities:['tools','streaming']}]}),{status:200,headers:{'content-type':'application/json'}})}
    if(url==='/api/codecraft/chat/completions'){codecraftHeaders.push(options.headers);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello from CodeCraft'}}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})}
    if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[]}),{status:200});
    throw new Error('Unexpected network request '+url);
  };
  // Test-only: a direct eval inside the app script's scope to read its let/const state.
  window.eval(script+'\n;window.__peek=code=>eval(code);');await pause();
  return {window,writes,codecraftHeaders,oauthCalls,clientArgs,emit:(event,session)=>callback(event,session),failWrites:n=>{writeFailures=n},failReads:n=>{readFailures=n}};
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
    assert.ok(window.localStorage.getItem('gemby.private.alice@example.com'));
    d.getElementById('s-cancel').click();d.getElementById('account').click();d.getElementById('auth-logout').click();await pause();
    assert.equal(window.localStorage.getItem('gemby.private.alice@example.com'),null,'sign-out removes stored keys');
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

const signIn=async(d,email='alice@example.com')=>{d.getElementById('auth-email').value=email;d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();};
const sseBody=(...events)=>events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');

test('the Supabase client uses PKCE and only enabled OAuth providers are offered; OAuth uses a fixed redirect',async()=>{
  const {window,oauthCalls,clientArgs}=await makePage(true,false,{fetch:url=>url==='https://example.supabase.co/auth/v1/settings'?new Response(JSON.stringify({external:{google:true,github:true,email:true}}),{status:200}):null});
  const d=window.document;
  try{
    assert.equal(clientArgs[0][2].auth.flowType,'pkce');
    assert.equal(d.getElementById('oauth').hidden,false);
    assert.deepEqual([...d.querySelectorAll('[data-oauth]')].map(b=>b.textContent),['Continue with Google','Continue with GitHub']);
    d.querySelector('[data-oauth="github"]').click();await pause();
    assert.deepEqual(JSON.parse(JSON.stringify(oauthCalls)),[{provider:'github',options:{redirectTo:'https://app.example/'}}]);
    assert.equal(window.sessionStorage.getItem('gemby.next'),'#chat');
  }finally{await window.happyDOM.abort();}
});

test('an OAuth error in the callback URL is shown and removed from the address bar',async()=>{
  const {window}=await makePage(true,false,{url:'https://app.example/?error=access_denied&error_code=access_denied&error_description=User+denied#chat'});
  try{
    await pause();
    assert.match(window.document.getElementById('auth-message').textContent,/cancelled or access was denied/);
    assert.equal(window.location.search,'');assert.equal(window.location.hash,'#chat');
  }finally{await window.happyDOM.abort();}
});

test('the approval dialog shows the tool and arguments; Allow once approves, Escape or an account switch denies',async()=>{
  const {window,emit}=await makePage();const d=window.document;
  try{
    await signIn(d);
    let p=window.eval('approve({kind:"tool",tool:"delete_file",server:"box",args:{path:"/tmp/x"},provider:"OpenRouter"})');await pause();
    const dlg=d.getElementById('approve-dlg');assert.equal(dlg.open,true);
    assert.match(d.getElementById('approve-meta').textContent,/delete_file.*box/s);assert.match(d.getElementById('approve-args').textContent,/"path": "\/tmp\/x"/);
    assert.equal(d.activeElement.id,'approve-deny','Deny has focus by default');
    d.getElementById('approve-allow').click();assert.equal(await p,true);assert.equal(dlg.open,false);
    p=window.eval('approve({kind:"tool",tool:"t",server:"s",args:{}})');await pause();dlg.close();assert.equal(await p,false);
    p=window.eval('approve({kind:"connector",name:"Docs",url:"https://docs.example/mcp"})');await pause();assert.match(d.getElementById('approve-meta').textContent,/docs\.example/);
    emit('SIGNED_IN',{access_token:'t',user:{id:'bob@example.com',email:'bob@example.com'}});await pause();
    assert.equal(await p,false,'switching account denies a pending approval');
  }finally{await window.happyDOM.abort();}
});

test('a reply that fails midway keeps the partial text, shows Retry, and syncs the partial message',async()=>{
  let calls=0;
  const {window,writes}=await makePage(true,false,{fetch:url=>{if(url==='https://openrouter.ai/api/v1/chat/completions'){calls++;return new Response(sseBody({choices:[{delta:{content:'The first half'}}]},{error:{message:'Provider overloaded'}}),{status:200,headers:{'content-type':'text/event-stream'}})}
    if(url==='https://openrouter.ai/api/v1/models')return new Response(JSON.stringify({data:[{id:'org/model:free',pricing:{prompt:'0',completion:'0'},architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools'],context_length:131072}]}),{status:200});return null}});
  const d=window.document;
  try{
    await signIn(d);
    d.getElementById('settings').click();d.getElementById('ai-key').value='sk-or-v1-userkey-1234567890';d.getElementById('allow-proposals').checked=false;d.getElementById('s-save').click();await pause();
    assert.equal(d.getElementById('mname').textContent,'model');
    d.getElementById('input').value='Tell me';d.getElementById('form').requestSubmit();await pause();await pause();
    assert.equal(calls,1);
    const wrap=d.getElementById('wrap').textContent;assert.match(wrap,/The first half/);assert.match(wrap,/Provider overloaded/);
    assert.ok(d.querySelector('#wrap [data-retry]'));
    const last=writes.at(-1).chats[0].msgs.at(-1);assert.equal(last.role,'assistant');assert.equal(last.content,'The first half');assert.match(last.error.message,/Provider overloaded/);
    assert.doesNotMatch(JSON.stringify(writes),/sk-or-v1-userkey/);
    d.querySelector('#wrap [data-retry]').click();await pause();await pause();assert.equal(calls,2);
    assert.equal(window.__peek('active().msgs.filter(m=>m.role==="assistant").length'),1,'retry replaces the failed message');
  }finally{await window.happyDOM.abort();}
});

test('a CodeCraft model list requested by account A never lands in account B',async()=>{
  let release;
  const {window,emit}=await makePage(true,true,{profiles:{'bob@example.com':{chats:[],settings:{provider:'codecraft'}}},fetch:url=>url==='/api/codecraft/models'&&!release?new Promise(r=>{release=()=>r(new Response(JSON.stringify({data:[{id:'alice-only-model',type:'chat'}]}),{status:200}))}):null});
  const d=window.document;
  try{
    await signIn(d);d.querySelector('[data-p="codecraft"]').click();await pause();
    assert.equal(typeof release,'function');
    emit('SIGNED_IN',{access_token:'t2',user:{id:'bob@example.com',email:'bob@example.com'}});await pause();
    release();await pause();
    assert.doesNotMatch(window.__peek('JSON.stringify(models.codecraft)'),/alice-only-model/);
    assert.equal(window.__peek('currentUser.id'),'bob@example.com');
  }finally{await window.happyDOM.abort();}
});

test('chat list rows are keyboard-reachable buttons, delete can be undone, and the per-chat search toggle is announced',async()=>{
  const {window}=await makePage();const d=window.document;
  try{
    await signIn(d);
    window.__peek('chats=[{id:"c1",title:"First",msgs:[{role:"user",content:"hi"}]},{id:"c2",title:"Second",msgs:[]}];cur="c1";renderAll()');
    const del=d.querySelector('#chats .chat .del');assert.equal(del.tagName,'BUTTON');assert.equal(del.getAttribute('aria-label'),'Delete chat: First');
    del.click();assert.equal(window.__peek('chats.length'),1);
    d.querySelector('#toast button').click();assert.equal(window.__peek('chats.length'),2);assert.equal(window.__peek('cur'),'c1');
    const toggle=d.getElementById('search-toggle');assert.equal(toggle.getAttribute('aria-pressed'),'false');
    toggle.click();assert.equal(toggle.getAttribute('aria-pressed'),'true');assert.equal(window.__peek('active().webSearch'),true);
    assert.equal(d.getElementById('menu').getAttribute('aria-expanded'),'false');d.getElementById('menu').click();assert.equal(d.getElementById('menu').getAttribute('aria-expanded'),'true');assert.equal(d.getElementById('scrim').hidden,false);
    d.getElementById('scrim').click();assert.equal(d.getElementById('side').classList.contains('open'),false);
  }finally{await window.happyDOM.abort();}
});
