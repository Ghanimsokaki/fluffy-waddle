const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Window}=require('happy-dom');

const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
async function makePage(configured=true,codecraft=false,extras=false,puterMock=null,autoPuter=false,pageUrl='https://app.example/#chat',initialSession=null){
  const html=fs.readFileSync('index.html','utf8');
  const script=html.split('<script>')[1].split('</script>')[0];
  const window=new Window({url:pageUrl});
  window.document.write(html.replace(/<script src="\/auth.js"><\/script>/,'').replace(/<script>[\s\S]*?<\/script>/,''));
  window.document.getElementById('auth-puter').checked=autoPuter;
  const writes=[];let callback,writeFailures=0,readFailures=0,loginFailures=0,oauthFailure=null,session=initialSession,codecraftHeaders=[],oauthCalls=[],catalog={data:[]};
  const client={
    auth:{onAuthStateChange(fn){callback=fn;fn('INITIAL_SESSION',session)},async signInWithOAuth(options){oauthCalls.push(options);return {data:{url:'https://provider.example'},error:oauthFailure}},async signInWithPassword({email}){if(loginFailures>0){loginFailures--;return {data:{},error:{message:'Invalid login credentials'}}}session={access_token:'supabase-session',user:{id:email,email}};callback('SIGNED_IN',session);return {data:{user:session.user,session},error:null}},async getSession(){return {data:{session},error:null}},async signOut(){session=null;callback('SIGNED_OUT',null);return {error:null}}},
    from(){return {select(){return {eq(){return {async maybeSingle(){if(readFailures>0){readFailures--;return {data:null,error:{message:'Database unavailable'}}}return {data:{chats:[],settings:{}},error:null}}}}}},async upsert(data){writes.push(data);if(writeFailures>0){writeFailures--;return {error:{message:'Network unavailable'}}}return {error:null}}}}
  };
  window.structuredClone=structuredClone;window.TextDecoder=TextDecoder;window.TextEncoder=TextEncoder;
  window.createGembyClient=()=>client;if(puterMock)window.puter=puterMock;
  window.fetch=async (url,options={})=>{
    if(url==='/api/config')return new Response(JSON.stringify(configured?{supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-key',codecraftConfigured:codecraft,moduckConfigured:extras,bytezConfigured:extras}:{}),{status:200});
    if(url==='/api/codecraft/models'){codecraftHeaders.push(options.headers);return new Response(JSON.stringify({data:[{id:'test-sonnet',type:'chat',capabilities:['tools','streaming']}]}),{status:200,headers:{'content-type':'application/json'}})}
    if(url==='/api/codecraft/chat/completions'){codecraftHeaders.push(options.headers);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello from CodeCraft'}}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})}
    if(url==='/api/moduck/models'||url==='/api/bytez/models'){codecraftHeaders.push(options.headers);return new Response(JSON.stringify(url.includes('moduck')?{data:[{id:'moduck-demo-chat'}]}:{output:[{modelId:'test/chat',task:'chat'}]}),{status:200})}
    if(url==='/api/moduck/chat/completions'||url==='/api/bytez/chat/completions'){codecraftHeaders.push({headers:options.headers,body:JSON.parse(options.body)});return url.includes('moduck')?new Response(JSON.stringify({choices:[{message:{content:'Hello from Moduck'},finish_reason:'stop'}]}),{status:200}):new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello from Bytez'}}]})+'\n\ndata: [DONE]\n\n',{status:200});}
    if(String(url).endsWith('/models'))return new Response(JSON.stringify(catalog),{status:200});
    throw new Error('Unexpected network request '+url);
  };
  window.eval(script);await pause();
  return {window,writes,codecraftHeaders,oauthCalls,setCatalog:data=>{catalog=data},failOAuth:message=>{oauthFailure={message}},emit:(event,session)=>callback(event,session),failWrites:n=>{writeFailures=n},failReads:n=>{readFailures=n},failLogins:n=>{loginFailures=n}};
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

test('Moduck and Bytez use confirmed account sessions and their respective chat contracts',async()=>{
  const {window,codecraftHeaders}=await makePage(true,false,true);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    for(const [p,model] of [['moduck','moduck-demo-chat'],['bytez','test/chat']]){
      d.querySelector('[data-p="'+p+'"]').click();await pause();assert.equal(d.getElementById('mname').textContent,model.split('/').pop());
      d.getElementById('settings').click();assert.equal(d.getElementById('ai-key').disabled,true);d.getElementById('s-cancel').click();
      d.getElementById('input').value='Hello';d.getElementById('form').requestSubmit();await pause();assert.match(d.getElementById('wrap').textContent,new RegExp('Hello from '+(p==='moduck'?'Moduck':'Bytez')));
      const request=codecraftHeaders.at(-1);assert.equal(request.headers.Authorization,'Bearer supabase-session');assert.equal(request.body.stream,p!=='moduck');if(p==='moduck')assert.equal(request.body.tools,undefined);
    }
  }finally{await window.happyDOM.abort();}
});

test('Puter model discovery, separate sign-in and streamed chat work without sending AI keys',async()=>{
  let signed=false,signIns=0,calls=[];
  const sdk={auth:{isSignedIn:()=>signed,signIn(){signIns++;signed=true;return Promise.resolve()}},ai:{async listModels(){return [{id:'claude-test',provider:'anthropic'},{id:'claude-test',provider:'other'}]},async chat(messages,options){calls.push({messages,options});return (async function*(){yield {type:'text',text:'Hello '};yield {type:'text',text:'from Puter'};})()}}};
  const {window,writes}=await makePage(true,false,false,sdk);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    d.getElementById('settings').click();d.getElementById('ai-key').value='sensitive-other-provider-key';d.getElementById('s-save').click();window.confirm=()=>true;
    d.querySelector('[data-p="puter"]').click();await pause();assert.equal(d.getElementById('mname').textContent,'claude-test');
    d.getElementById('settings').click();assert.equal(d.getElementById('ai-key').disabled,true);assert.match(d.getElementById('puter-status').textContent,/sign in to Puter/i);d.getElementById('puter-connect').click();await pause();assert.equal(signIns,1);assert.match(d.getElementById('puter-status').textContent,/Puter connected/);d.getElementById('s-cancel').click();
    d.getElementById('input').value='Hello';d.getElementById('form').requestSubmit();await pause();
    assert.match(d.getElementById('wrap').textContent,/Hello from Puter/);assert.equal(calls.length,1);assert.equal(calls[0].options.model,'claude-test');assert.equal(calls[0].options.stream,true);assert.doesNotMatch(JSON.stringify(calls),/sensitive-other-provider-key|supabase-session/);assert.doesNotMatch(JSON.stringify(writes),/sensitive-other-provider-key/);
  }finally{await window.happyDOM.abort();}
});

test('Puter explains sign-in requirement and blocks unsupported connectors before any call',async()=>{
  let calls=0;
  const sdk={auth:{isSignedIn:()=>false,signIn:async()=>{}},ai:{listModels:async()=>[{id:'test-chat'}],chat:async()=>{calls++;}}};
  const {window}=await makePage(true,false,false,sdk);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();d.querySelector('[data-p="puter"]').click();await pause();
    d.getElementById('input').value='Hello';d.getElementById('form').requestSubmit();await pause();assert.match(d.getElementById('wrap').textContent,/Sign in to Puter first/);assert.equal(calls,0);
    d.getElementById('settings').click();d.getElementById('box-enabled').checked=true;d.getElementById('s-save').click();await pause();d.getElementById('input').value='Hello again';d.getElementById('form').requestSubmit();await pause();assert.match(d.getElementById('wrap').textContent,/does not support connector tools/);assert.equal(calls,0);
  }finally{await window.happyDOM.abort();}
});

test('Puter must be reconnected after changing Gemby accounts',async()=>{
  let signed=true,calls=0;const sdk={auth:{isSignedIn:()=>signed,signIn:async()=>{}},ai:{listModels:async()=>[{id:'test-chat'}],async chat(){calls++;return (async function*(){yield {text:'ok'}})()}}};
  const {window,emit}=await makePage(true,false,false,sdk);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('settings').click();d.getElementById('puter-connect').click();await pause();d.getElementById('s-cancel').click();
    emit('SIGNED_IN',{user:{id:'bob@example.com',email:'bob@example.com'}});await pause();d.querySelector('[data-p="puter"]').click();await pause();
    d.getElementById('input').value='Hello';d.getElementById('form').requestSubmit();await pause();assert.match(d.getElementById('wrap').textContent,/Sign in to Puter first/);assert.equal(calls,0);
    d.getElementById('settings').click();assert.match(d.getElementById('puter-status').textContent,/Connect it to this Gemby session/);d.getElementById('puter-connect').click();await pause();d.getElementById('s-cancel').click();d.getElementById('input').value='Hello again';d.getElementById('form').requestSubmit();await pause();assert.equal(calls,1);
  }finally{await window.happyDOM.abort();}
});

test('stopping a waiting Puter stream clears busy state and closes its iterator',async()=>{
  let closed=false,started=false;const sdk={auth:{isSignedIn:()=>true,signIn:async()=>{}},ai:{listModels:async()=>[{id:'test-chat'}],async chat(){return {[Symbol.asyncIterator](){return {next(){started=true;return new Promise(()=>{})},return(){closed=true;return Promise.resolve({done:true})}}}}}}};
  const {window}=await makePage(true,false,false,sdk);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('settings').click();d.getElementById('puter-connect').click();await pause();d.getElementById('s-cancel').click();
    d.getElementById('input').value='Hello';d.getElementById('form').requestSubmit();await pause();assert.equal(started,true);assert.equal(d.getElementById('send').getAttribute('aria-label'),'Stop');d.getElementById('form').requestSubmit();await pause();assert.equal(closed,true);assert.equal(d.getElementById('send').getAttribute('aria-label'),'Send');
  }finally{await window.happyDOM.abort();}
});

test('local Puter SDK bundle exposes the documented browser API',async()=>{
  const window=new Window({url:'https://app.example/'});window.fetch=async()=>new Response('{}');
  try{window.eval(fs.readFileSync('public/puter.js','utf8'));assert.equal(typeof window.puter.ai.chat,'function');assert.equal(typeof window.puter.ai.listModels,'function');assert.equal(typeof window.puter.auth.signIn,'function');}
  finally{await window.happyDOM.abort();}
});

test('Puter sign-in cancellation is shown without sending a chat',async()=>{
  let calls=0;const sdk={auth:{isSignedIn:()=>false,signIn:()=>Promise.reject(new Error('Popup blocked'))},ai:{listModels:async()=>[{id:'test-chat'}],async chat(){calls++}}};
  const {window}=await makePage(true,false,false,sdk);const d=window.document;
  try{d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('settings').click();d.getElementById('puter-connect').click();await pause();assert.match(d.getElementById('puter-status').textContent,/Popup blocked/);assert.equal(calls,0);}
  finally{await window.happyDOM.abort();}
});

test('Gemby sign-in can connect Puter at the same time without sharing credentials',async()=>{
  let signed=false,signIns=0,calls=0;const sdk={auth:{isSignedIn:()=>signed,signIn(...args){assert.equal(args.length,0);signIns++;signed=true;return Promise.resolve()}},ai:{listModels:async()=>[{id:'chat'}],async chat(){calls++;return (async function*(){yield {text:'Puter works'}})()}}};
  const {window}=await makePage(true,false,false,sdk,true);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='private-password';d.getElementById('auth-login').click();assert.equal(signIns,1,'Puter popup starts directly on the click');await pause();assert.equal(d.getElementById('auth-dlg').open,false);
    d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('settings').click();assert.match(d.getElementById('puter-status').textContent,/Puter connected/);d.getElementById('s-cancel').click();
    d.getElementById('input').value='hello';d.getElementById('form').requestSubmit();await pause();assert.equal(calls,1);assert.match(d.getElementById('wrap').textContent,/Puter works/);
  }finally{await window.happyDOM.abort();}
});

test('cancelled Puter login does not block Gemby and can be retried in Settings',async()=>{
  let signIns=0,signed=false;const sdk={auth:{isSignedIn:()=>signed,signIn(){signIns++;return Promise.reject(new Error('popup blocked'))}},ai:{listModels:async()=>[{id:'chat'}],chat:async()=>{throw Error('must not call')}}};
  const {window}=await makePage(true,false,false,sdk,true);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();assert.equal(d.getElementById('auth-dlg').open,false);assert.match(d.getElementById('toast').textContent,/Connect Puter in Settings/);assert.equal(signIns,1);
    d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('settings').click();assert.match(d.getElementById('puter-status').textContent,/sign in to Puter/i);
  }finally{await window.happyDOM.abort();}
});

test('failed Gemby login never connects the Puter session to a later account',async()=>{
  let signed=false;const sdk={auth:{isSignedIn:()=>signed,signIn(){signed=true;return Promise.resolve()}},ai:{listModels:async()=>[{id:'chat'}],chat:async()=>{throw Error('must not call')}}};
  const {window,failLogins}=await makePage(true,false,false,sdk,true);const d=window.document;
  try{
    failLogins(1);d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='wrong';d.getElementById('auth-login').click();await pause();assert.match(d.getElementById('auth-message').textContent,/Invalid login/);
    d.getElementById('auth-puter').checked=false;d.getElementById('auth-email').value='bob@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('input').value='hello';d.getElementById('form').requestSubmit();await pause();assert.match(d.getElementById('wrap').textContent,/Sign in to Puter first/);
  }finally{await window.happyDOM.abort();}
});

test('late Puter popup cannot connect after a Gemby account switch',async()=>{
  let resolveAuth,signed=false;const sdk={auth:{isSignedIn:()=>signed,signIn(){return new Promise(resolve=>{resolveAuth=()=>{signed=true;resolve()}})}},ai:{listModels:async()=>[{id:'chat'}],chat:async()=>{throw Error('must not call')}}};
  const {window,emit}=await makePage(true,false,false,sdk,true);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    emit('SIGNED_IN',{user:{id:'bob@example.com',email:'bob@example.com'}});await pause();resolveAuth();await pause();d.querySelector('[data-p="puter"]').click();await pause();d.getElementById('input').value='hello';d.getElementById('form').requestSubmit();await pause();assert.match(d.getElementById('wrap').textContent,/Sign in to Puter first/);
  }finally{await window.happyDOM.abort();}
});

test('Gemby sign-in succeeds when the Puter SDK is still loading',async()=>{
  const {window}=await makePage(true,false,false,null,true);const d=window.document;
  try{d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();assert.equal(d.getElementById('auth-dlg').open,false);assert.match(d.getElementById('toast').textContent,/Connect Puter in Settings/);}
  finally{await window.happyDOM.abort();}
});

test('GitHub sign-in uses Supabase with a same-origin callback and no Puter popup',async()=>{
  let puterSignIns=0;const sdk={auth:{isSignedIn:()=>false,signIn(){puterSignIns++;return Promise.resolve()}},ai:{listModels:async()=>[]}};
  const {window,oauthCalls}=await makePage(true,false,false,sdk,true);const d=window.document;
  try{d.getElementById('auth-github').click();await pause();assert.equal(oauthCalls.length,1);assert.equal(oauthCalls[0].provider,'github');assert.equal(oauthCalls[0].options.redirectTo,'https://app.example/?github_callback=1');assert.equal(puterSignIns,0);assert.match(d.getElementById('auth-message').textContent,/Redirecting to GitHub/);}
  finally{await window.happyDOM.abort();}
});

test('GitHub sign-in errors are visible and button can be retried',async()=>{
  const {window,oauthCalls,failOAuth}=await makePage();const d=window.document;
  try{failOAuth('Provider not enabled');d.getElementById('auth-github').click();await pause();assert.match(d.getElementById('auth-message').textContent,/Provider not enabled/);assert.equal(d.getElementById('auth-github').disabled,false);assert.equal(oauthCalls.length,1);}
  finally{await window.happyDOM.abort();}
});

test('GitHub OAuth return opens the account and removes callback parameters',async()=>{
  const session={user:{id:'github-user',email:'gh@example.com'}};
  const {window}=await makePage(true,false,false,null,false,'https://app.example/?github_callback=1#access_token=hidden&refresh_token=hidden',session);
  try{assert.equal(window.location.hash,'#chat');assert.equal(window.location.search,'');assert.equal(window.document.body.classList.contains('chat'),true);assert.equal(window.document.getElementById('sync-status').textContent,'Synced');assert.doesNotMatch(window.location.href,/hidden/);}
  finally{await window.happyDOM.abort();}
});

test('GitHub OAuth errors are cleared from URL and explained',async()=>{
  const {window}=await makePage(true,false,false,null,false,'https://app.example/?github_callback=1#error=access_denied&error_description=cancelled');
  try{assert.equal(window.location.hash,'#chat');assert.equal(window.location.search,'');assert.equal(window.document.getElementById('auth-dlg').open,true);assert.match(window.document.getElementById('auth-message').textContent,/cancelled or failed/);}
  finally{await window.happyDOM.abort();}
});

test('GitHub sign-in does not discard unsynced changes without confirmation',async()=>{
  const {window,oauthCalls,failWrites}=await makePage();const d=window.document;
  try{d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();failWrites(1);d.getElementById('settings').click();d.getElementById('s-save').click();await pause();d.getElementById('account').click();window.confirm=()=>false;d.getElementById('auth-github').click();await pause();assert.equal(oauthCalls.length,0);assert.equal(d.getElementById('auth-github').disabled,false);}
  finally{await window.happyDOM.abort();}
});

test('bundled Supabase client processes a GitHub callback and loads the account',async()=>{
  const html=fs.readFileSync('index.html','utf8'),script=html.split('<script>')[1].split('</script>')[0];
  const window=new Window({url:'https://app.example/?github_callback=1#access_token=test-access&refresh_token=test-refresh&expires_in=3600&token_type=bearer'});
  window.document.write(html.replace(/<script src="\/auth.js"><\/script>/,'').replace(/<script>[\s\S]*?<\/script>/,''));window.structuredClone=structuredClone;let userRequests=0;
  window.fetch=async(url,options={})=>{
    url=String(url);
    if(url==='/api/config')return new Response(JSON.stringify({supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-key'}),{status:200});
    if(url.endsWith('/models'))return new Response(JSON.stringify({data:[]}),{status:200});
    if(url.includes('/auth/v1/user')){userRequests++;return new Response(JSON.stringify({id:'github-user',email:'github@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'}),{status:200,headers:{'content-type':'application/json'}})}
    if(url.includes('/rest/v1/gemby_profiles'))return new Response('[]',{status:200,headers:{'content-type':'application/json'}});
    throw new Error('Unexpected request '+url);
  };
  try{window.eval(fs.readFileSync('public/auth.js','utf8'));window.eval(script);await pause();await pause();assert.equal(userRequests,1);assert.equal(window.location.hash,'#chat');assert.equal(window.location.search,'');assert.match(window.document.getElementById('auth-message').textContent,/github@example.com/);assert.equal(window.document.getElementById('sync-status').textContent,'Synced');assert.doesNotMatch(window.location.href,/test-access|test-refresh/);}
  finally{await window.happyDOM.abort();}
});


test('model picker shows and searches provider-reported specs without inventing agent abilities',async()=>{
  const sdk={auth:{isSignedIn:()=>true},ai:{listModels:async()=>[{id:'puter-demo',provider:'<unsafe>',context:200000,max_tokens:64000},{id:'no-details',provider:'puter'}]}};
  const {window,setCatalog}=await makePage(true,true,false,sdk);const d=window.document;
  try{
    d.getElementById('auth-email').value='alice@example.com';d.getElementById('auth-password').value='password';d.getElementById('auth-login').click();await pause();
    setCatalog({data:[{id:'vendor/test:free',pricing:{prompt:'0',completion:'0'},context_length:131072,parameter_count:7000000000,top_provider:{max_completion_tokens:8192},architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools','reasoning']},{id:'vendor/unknown:free',pricing:{prompt:'0',completion:'0'}}]});
    await window.eval('loadModels()');
    let list=d.getElementById('mlist');assert.match(list.textContent,/131.1K context tokens/);assert.match(list.textContent,/8.2K max output tokens/);assert.match(list.textContent,/7B parameters/);assert.match(list.textContent,/Tool calling/);assert.match(list.textContent,/Reasoning controls/);assert.match(list.textContent,/Input: text, image/);assert.match(list.textContent,/Specs unavailable/);
    d.getElementById('msearch').value='tool calling';d.getElementById('msearch').dispatchEvent(new window.Event('input'));assert.equal(list.querySelectorAll('.mi').length,1);assert.match(list.textContent,/test/);
    d.getElementById('msearch').value='';d.querySelector('[data-p="codecraft"]').click();await pause();assert.match(list.textContent,/Tool calling/);
    d.querySelector('[data-p="puter"]').click();await pause();assert.match(list.textContent,/200K context tokens/);assert.match(list.textContent,/64K max output tokens/);assert.match(list.textContent,/Specs unavailable/);assert.match(list.textContent,/<unsafe>/);assert.equal(list.querySelector('unsafe'),null);
    assert.match(d.querySelector('.model-note').textContent,/does not make a model an agent/);
  }finally{await window.happyDOM.abort();}
});
