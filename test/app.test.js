const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { handler } = require('../server');

async function serverTest(fn) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('only public assets are served and cross-origin proxy requests are rejected', async () => {
  await serverTest(async base => {
    assert.equal((await fetch(base + '/')).status, 200);
    const schema=await fetch(base+'/schema.sql');assert.equal(schema.status,200);assert.match(await schema.text(),/enable row level security/i);
    for (const file of ['/server.js', '/.git/config', '/README.md', '/%2e%2e/server.js']) assert.equal((await fetch(base + file)).status, 404);
    assert.equal((await fetch(base + '/api/box', {method:'POST', headers:{origin:'https://evil.example'}})).status, 403);
    assert.equal((await fetch(base + '/api/box', {method:'GET'})).status, 401);
  });
});

function setup(fetch, confirm = () => true) {
  const html = fs.readFileSync('index.html','utf8');
  const source = html.slice(html.indexOf('// Streamable HTTP MCP client.'), html.indexOf('function showError('));
  const context = {fetch, confirm, AbortController, TextDecoder, Uint8Array, URL, performance, JSON, serverConfigPromise:Promise.resolve(), serverKeys:{openrouter:false,nvidia:false,box:false},
    cfg:{provider:'openrouter',model:{openrouter:'test-model'},boxEnabled:true,boxToken:'box-token',webSearch:true},
    endpoint:()=>({url:'https://provider.test/chat',key:'ai-token',hasKey:true,name:'OpenRouter',headers:{}}),
    UserError:class UserError extends Error {}, explain:(s)=>new Error('HTTP '+s),
    nearBottom:()=>false,toBottom:()=>{},thinkHTML:x=>x,md:x=>x,saveCfg:()=>{}};
  vm.createContext(context); vm.runInContext(source, context);
  return context;
}
const json = (data, headers={}) => new Response(JSON.stringify(data), {headers:{'content-type':'application/json',...headers}});
const sse = (...events) => new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
const bubble = () => ({textContent:'',innerHTML:'',classList:{toggle(){}}});

test('Box initializes, discovers tools, asks permission, and returns results to the model with web search', async () => {
  let modelCalls=0, toolCalls=0, approvals=0;
  const ctx=setup(async (url, options) => {
    const body=JSON.parse(options.body);
    if(url==='/api/box'){
      assert.equal(options.headers.Authorization,'Bearer box-token');
      if(body.method==='initialize')return json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26'}},{'mcp-session-id':'session-1'});
      assert.equal(options.headers['Mcp-Session-Id'],'session-1');
      if(body.method==='notifications/initialized')return new Response(null,{status:202});
      if(body.method==='tools/list')return json({id:body.id,result:{tools:[{name:'search_box',inputSchema:{type:'object'}}]}});
      if(body.method==='tools/call'){toolCalls++;assert.equal(body.params.arguments.query,'report');return json({id:body.id,result:{content:[{type:'text',text:'found report'}]}})}
      assert.fail(body.method);
    }
    assert.equal(url,'https://provider.test/chat');
    assert.ok(body.tools.some(t=>t.type==='openrouter:web_search'));
    modelCalls++;
    if(modelCalls===1)return sse({choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'fw_mcp_0',arguments:'{"query":'}}]}}]}, {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"report"}'}}]}}]});
    assert.equal(body.messages.at(-1).tool_call_id,'call-1');
    assert.match(body.messages.at(-1).content,/found report/);
    return sse({choices:[{delta:{content:'Here is the report.',annotations:[{url_citation:{url:'https://example.com/report',title:'Report'}}]}}]});
  },()=>{approvals++;return true});
  const result=await ctx.stream([{role:'user',content:'Find a report'}],bubble());
  assert.match(result.content,/\[Report\]\(https:\/\/example.com\/report\)/);
  assert.equal(toolCalls,1);assert.equal(approvals,1);assert.equal(modelCalls,2);
});

test('denied Box tool is not executed', async () => {
  let calls=0;
  const ctx=setup(async (url, options) => {
    const body=JSON.parse(options.body);
    if(url==='/api/box'){
      if(body.method==='initialize')return json({id:body.id,result:{protocolVersion:'2025-03-26'}});
      if(body.method==='notifications/initialized')return new Response(null,{status:202});
      if(body.method==='tools/list')return json({id:body.id,result:{tools:[{name:'delete_file',inputSchema:{type:'object'}}]}});
      assert.fail('Denied tool must not run');
    }
    if(++calls===1)return sse({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'fw_mcp_0',arguments:'{}'}}]}}]});
    assert.equal(body.messages.at(-1).content,'User denied this tool call.');
    return sse({choices:[{delta:{content:'Not deleted.'}}]});
  },()=>false);
  assert.equal((await ctx.stream([{role:'user',content:'Delete'}],bubble())).content,'Not deleted.');
});

test('web search is rejected clearly for NVIDIA', async () => {
  const ctx=setup(()=>assert.fail('no network request expected'));
  ctx.cfg.provider='nvidia';ctx.cfg.model.nvidia='test';
  await assert.rejects(ctx.stream([],bubble()),/only available with OpenRouter/);
});

test('Box proxy forwards authorization and MCP session only to the fixed Box endpoint', async () => {
  const https = require('node:https');
  const { PassThrough } = require('node:stream');
  const original = https.request;
  let captured;
  https.request = (options, callback) => {
    captured=options;
    const upstream=new PassThrough();
    upstream.on('finish',()=>{
      const response=new PassThrough(); response.statusCode=200;
      response.headers={'content-type':'application/json','mcp-session-id':'next-session'};
      callback(response); response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    return upstream;
  };
  try {
    await serverTest(async base => {
      const response=await fetch(base+'/api/box', {method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json','mcp-session-id':'session','mcp-protocol-version':'2025-03-26'},body:'{}'});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('mcp-session-id'),'next-session');
      assert.equal(captured.host,'mcp.box.simular.ai');assert.equal(captured.path,'/mcp');
      assert.equal(captured.headers.authorization,'Bearer test-token');
      assert.equal(captured.headers['mcp-session-id'],'session');
    });
  } finally { https.request=original; }
});

test('configuration only exposes public Supabase config, not provider credentials', async () => {
  const names=['OPENROUTER_API_KEY','NVIDIA_API_KEY','BOX_ACCESS_TOKEN','SUPABASE_URL','SUPABASE_ANON_KEY','CODECRAFT_API_KEY','CODECRAFT_ALLOWED_EMAILS'];
  const before=names.map(n=>process.env[n]);
  process.env.OPENROUTER_API_KEY='or-secret';process.env.NVIDIA_API_KEY='nv-secret';process.env.BOX_ACCESS_TOKEN='box-secret';
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='public-key';process.env.CODECRAFT_API_KEY='cc-secret';process.env.CODECRAFT_ALLOWED_EMAILS='owner@example.com';
  try {await serverTest(async base=>{const res=await fetch(base+'/api/config');const raw=await res.text();assert.equal(res.headers.get('cache-control'),'no-store');assert.deepEqual(JSON.parse(raw),{supabaseUrl:'https://example.supabase.co',supabaseAnonKey:'public-key',codecraftConfigured:true,codecraftAccessConfigured:true});assert.doesNotMatch(raw,/or-secret|nv-secret|box-secret|cc-secret|owner@example.com/);});}
  finally{names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);}
});

test('proxy never falls back to server credentials', async () => {
  const https=require('node:https'), {PassThrough}=require('node:stream');
  const original=https.request,names=['OPENROUTER_API_KEY','NVIDIA_API_KEY','BOX_ACCESS_TOKEN'];
  const before=names.map(n=>process.env[n]);let captured=[];
  process.env.OPENROUTER_API_KEY='server-or';process.env.NVIDIA_API_KEY='server-nv';process.env.BOX_ACCESS_TOKEN='server-box';
  https.request=(options,callback)=>{captured.push(options);const up=new PassThrough();up.on('finish',()=>{const r=new PassThrough();r.statusCode=200;r.headers={'content-type':'application/json'};callback(r);r.end('{}')});return up;};
  try{await serverTest(async base=>{
    for(const [path,authorization] of [['/api/openrouter/chat/completions',null],['/api/nvidia/chat/completions',null],['/api/box',null],['/api/openrouter/chat/completions','Bearer browser-key']]){const headers={'content-type':'application/json'};if(authorization)headers.authorization=authorization;assert.equal((await fetch(base+path,{method:'POST',headers,body:'{}'})).status,authorization?200:401);}
    assert.deepEqual(captured.map(c=>[c.host,c.headers.authorization]),[['openrouter.ai','Bearer browser-key']]);
  });}finally{https.request=original;names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);}
});

test('Simular requires the user’s own key',async()=>{
  const ctx=setup(()=>assert.fail('no network without a key'));
  await assert.rejects(ctx.connectBox(''),/personal key/);
});

test('MCP JSON validates HTTPS remote servers and rejects stdio, placeholders and reserved headers', () => {
  const ctx=setup(()=>assert.fail('no network'));
  const parse=x=>ctx.parseMcpConfig(JSON.stringify(x));
  assert.equal(parse({mcpServers:{remote:{url:'https://example.com/mcp',headers:{Authorization:'Bearer test'}}}}).mcpServers.remote.url,'https://example.com/mcp');
  for(const server of [
    {command:'npx',args:['server']}, {url:'http://example.com/mcp'},
    {url:'https://user:secret@example.com/mcp'}, {url:'https://example.com/mcp',headers:{Authorization:'Bearer ${TOKEN}'}},
    {url:'https://example.com/mcp',headers:{'Mcp-Session-Id':'forged'}}, {url:'https://example.com/mcp',type:'sse'}
  ]) assert.throws(()=>parse({mcpServers:{bad:server}}));
  assert.throws(()=>ctx.parseMcpConfig('{}'),/mcpServers/);
  assert.throws(()=>ctx.parseMcpConfig('{bad'),/valid JSON/);
});

test('remote MCP servers with same tool names route to the right server; skills are sent without secrets', async () => {
  let modelCalls=0, remoteCalls=[], seenApproval='';
  const ctx=setup(async (url,options)=>{
    const body=JSON.parse(options.body);
    if(url.startsWith('https://mcp')){
      assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'Bearer secret-'+url[11]);
      if(body.method==='initialize')return json({id:body.id,result:{protocolVersion:'2025-03-26'}},{'mcp-session-id':'session-'+url[11]});
      assert.equal(options.headers['Mcp-Session-Id'],'session-'+url[11]);
      if(body.method==='notifications/initialized')return new Response(null,{status:202});
      if(body.method==='tools/list')return json({id:body.id,result:{tools:[{name:'search',description:'Search',inputSchema:{type:'object'}}]}});
      if(body.method==='tools/call'){remoteCalls.push(url);return json({id:body.id,result:{content:[{type:'text',text:'Found'}]}})}
      assert.fail(body.method);
    }
    modelCalls++;
    assert.equal(body.messages[0].role,'system');assert.match(body.messages[0].content,/Be precise/);
    assert.doesNotMatch(JSON.stringify(body),/secret-/);
    if(modelCalls===1){
      assert.deepEqual(body.tools.map(t=>t.function.name),['fw_mcp_0','fw_mcp_1','gemby_propose_connector']);
      return sse({choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'fw_mcp_1',arguments:'{}'}}]}}]});
    }
    assert.match(body.messages.at(-1).content,/Found/);
    return sse({choices:[{delta:{content:'Done'}}]});
  },(message)=>{seenApproval=message;return true});
  ctx.cfg.boxEnabled=false;ctx.cfg.webSearch=false;
  ctx.cfg.skills=[{name:'Precise',enabled:true,instructions:'Be precise'},{name:'Off',enabled:false,instructions:'not active'}];
  ctx.cfg.mcpConfig={mcpServers:{one:{url:'https://mcp1.test/mcp',headers:{Authorization:'Bearer secret-1'}},two:{url:'https://mcp2.test/mcp',headers:{Authorization:'Bearer secret-2'}},off:{url:'https://mcp3.test/mcp',disabled:true}}};
  const out=await ctx.stream([{role:'user',content:'Search'}],bubble());
  assert.equal(out.content,'Done');assert.deepEqual(remoteCalls,['https://mcp2.test/mcp']);assert.match(seenApproval,/search.*two/);
});

test('MCP SSE response can be read without waiting for the stream to close', async () => {
  const enc=new TextEncoder();
  const ctx=setup(async (url,options)=>{
    const body=JSON.parse(options.body);
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    const payload=body.method==='initialize'?{id:body.id,result:{protocolVersion:'2025-03-26'}}:{id:body.id,result:{tools:[]}};
    return new Response(new ReadableStream({start(controller){controller.enqueue(enc.encode('data: '+JSON.stringify(payload)+'\n\n'));},cancel(){}}),{headers:{'content-type':'text/event-stream'}});
  });
  const connection=await ctx.connectMcp({name:'remote',url:'https://example.com/mcp'});
  assert.equal(connection.tools.length,0);
});

test('invalid skills are rejected and only enabled skills are sent', async () => {
  const ctx=setup(async (url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.messages[0].role,'system');assert.match(body.messages[0].content,/Active instruction/);assert.doesNotMatch(body.messages[0].content,/Hidden instruction/);
    return sse({choices:[{delta:{content:'ok'}}]});
  });
  assert.throws(()=>ctx.parseSkills('[{"name":"bad","enabled":"yes","instructions":"x"}]'));
  ctx.cfg.boxEnabled=false;ctx.cfg.webSearch=false;ctx.cfg.skills=[{name:'Active',enabled:true,instructions:'Active instruction'},{name:'Hidden',enabled:false,instructions:'Hidden instruction'}];
  assert.equal((await ctx.stream([{role:'user',content:'Hi'}],bubble())).content,'ok');
});

test('AI connector proposals need approval, reject credentials, and stay disabled', () => {
  let prompts=[];
  const ctx=setup(()=>assert.fail('proposal must not access network'),message=>{prompts.push(message);return true});
  assert.match(ctx.proposeConnector({name:'Docs',url:'https://example.com/mcp'}),/saved disabled/);
  assert.equal(ctx.cfg.mcpConfig.mcpServers.Docs.disabled,true);
  assert.match(prompts[0],/https:\/\/example.com\/mcp/);
  for(const proposal of [{name:'Secrets',url:'https://example.com/mcp?token=secret'}, {name:'Local',url:'https://127.0.0.1/mcp'}, {name:'Auth',url:'https://example.com',headers:{Authorization:'Bearer secret'}}, {name:'Hidden',url:'https://name:pass@example.com/mcp'}]) assert.match(ctx.proposeConnector(proposal),/Invalid|non-public/);
  assert.equal(prompts.length,1);
  const denied=setup(()=>assert.fail('no network'),()=>false);
  assert.match(denied.proposeConnector({name:'Docs',url:'https://example.com/mcp'}),/denied/);
  assert.equal(denied.cfg.mcpConfig,undefined);
});

function setupAccounts(profileLoader) {
  const html=fs.readFileSync('index.html','utf8');
  const source=html.slice(html.indexOf('const DEFAULT_SKILLS='),html.indexOf('const esc=s=>'));
  const values=new Map(),elements=new Map(),writes=[];
  const $=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:false,open:false,close(){this.open=false},showModal(){this.open=true}});return elements.get(id)};
  const mock={from(table){assert.equal(table,'gemby_profiles');return {
    select(){return {eq(_field,id){return {maybeSingle:()=>profileLoader(id)}}}},
    upsert(snapshot){writes.push(snapshot);return Promise.resolve({error:null})}
  }}};
  const ctx={$,FALLBACK:{openrouter:[],nvidia:[]},store:{get:(k,d)=>values.has(k)?values.get(k):d,set:(k,v)=>values.set(k,structuredClone(v))},fetch:()=>new Promise(()=>{}),window:{},structuredClone,crypto:require('node:crypto').webcrypto,renderAll(){},loadModels(){},toast(){},setTimeout,console};
  vm.createContext(ctx);vm.runInContext(source,ctx);ctx.mock=mock;vm.runInContext('accountClient=mock',ctx);
  return {ctx,values,writes,elements};
}

test('account data and provider keys remain isolated, and cloud sync excludes secrets', async () => {
  const {ctx,values,writes}=setupAccounts(async id=>({data:{chats:[{id,title:id,msgs:[]}],settings:{provider:'openrouter',model:{},skills:[]}},error:null}));
  values.set('gemby.private.a',{provider:'openrouter',aiKey:'private-key-a',boxToken:'private-box',mcpConfig:{mcpServers:{x:{url:'https://example.com',headers:{Authorization:'Bearer private-header'}}}}});
  await ctx.applySession({user:{id:'a',email:'a@example.com'}},'SIGNED_IN');
  assert.equal(vm.runInContext('cfg.aiKey',ctx),'private-key-a');
  vm.runInContext('save()',ctx);await vm.runInContext('saveQueue',ctx);
  assert.equal(writes[0].user_id,'a');assert.doesNotMatch(JSON.stringify(writes[0]),/private-key|private-box|private-header/);
  await ctx.applySession({user:{id:'b',email:'b@example.com'}},'SIGNED_IN');
  assert.equal(vm.runInContext('cfg.aiKey',ctx),'');assert.equal(vm.runInContext('chats[0].id',ctx),'b');
  await ctx.applySession(null,'SIGNED_OUT');
  assert.equal(vm.runInContext('chats.length',ctx),0);assert.equal(vm.runInContext('cfg.aiKey',ctx),'');
});

test('stale account loads cannot overwrite a newer user', async () => {
  let resolveA;
  const {ctx}=setupAccounts(id=>id==='a'?new Promise(resolve=>{resolveA=resolve}):Promise.resolve({data:{chats:[{id:'b',msgs:[]}],settings:{}},error:null}));
  const first=ctx.applySession({user:{id:'a'}},'SIGNED_IN');
  await ctx.applySession({user:{id:'b'}},'SIGNED_IN');
  resolveA({data:{chats:[{id:'a',msgs:[]}],settings:{}},error:null});await first;
  assert.equal(vm.runInContext('currentUser.id',ctx),'b');assert.equal(vm.runInContext('chats[0].id',ctx),'b');
});

test('stored AI key is not reused after provider changes on another device',async()=>{
  const {ctx,values}=setupAccounts(async()=>({data:{chats:[],settings:{provider:'nvidia'}},error:null}));
  values.set('gemby.private.a',{provider:'openrouter',aiKey:'openrouter-key'});
  await ctx.applySession({user:{id:'a'}},'SIGNED_IN');
  assert.equal(vm.runInContext('cfg.aiKey',ctx),'');
});

test('Supabase service-role and secret keys are never exposed as client configuration', () => {
  const {publicSupabaseKey}=require('../server');
  const jwt=role=>'x.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.x';
  assert.equal(publicSupabaseKey(jwt('service_role')),'');
  assert.equal(publicSupabaseKey('sb_secret_very_private'),'');
  assert.equal(publicSupabaseKey(jwt('anon')),jwt('anon'));
  assert.equal(publicSupabaseKey('sb_publishable_public'),'sb_publishable_public');
});

test('AI connector proposal completes the model tool loop without transmitting credentials', async () => {
  let turns=0, seen='';
  const ctx=setup(async(url,options)=>{
    const body=JSON.parse(options.body);assert.doesNotMatch(JSON.stringify(body),/private-api-key/);
    if(++turns===1)return sse({choices:[{delta:{tool_calls:[{index:0,id:'proposal-1',function:{name:'gemby_propose_connector',arguments:'{"name":"Docs","url":"https://example.com/mcp"}'}}]}}]});
    assert.match(body.messages.at(-1).content,/saved disabled/);return sse({choices:[{delta:{content:'Ready to enable.'}}]});
  },message=>{seen=message;return true});
  ctx.cfg.boxEnabled=false;ctx.cfg.webSearch=false;ctx.cfg.aiKey='private-api-key';
  assert.equal((await ctx.stream([{role:'user',content:'Add a docs connector'}],bubble())).content,'Ready to enable.');
  assert.equal(ctx.cfg.mcpConfig.mcpServers.Docs.disabled,true);assert.match(seen,/Docs/);assert.equal(turns,2);
});

test('row level security schema restricts all profile operations to the authenticated owner',()=>{
  const sql=fs.readFileSync('supabase/schema.sql','utf8');
  assert.match(sql,/enable row level security/i);
  for(const action of ['select','insert','update','delete'])assert.match(sql,new RegExp('for '+action+' to authenticated','i'));
  assert.equal((sql.match(/auth\.uid\(\)/g)||[]).length,5);
  assert.match(sql,/revoke all on public\.gemby_profiles from public, anon/i);
});

test('CodeCraft verifies confirmed allowed accounts and never forwards their session', async () => {
  const https=require('node:https'), {PassThrough}=require('node:stream');
  const original=https.request,names=['SUPABASE_URL','SUPABASE_ANON_KEY','CODECRAFT_API_KEY','CODECRAFT_ALLOWED_EMAILS'];
  const before=names.map(n=>process.env[n]);let captured=[],verified={id:'user-a',email:'owner@example.com',email_confirmed_at:'2026-01-01T00:00:00Z'},verificationStatus=200;
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='public-key';process.env.CODECRAFT_API_KEY='cc-secret';process.env.CODECRAFT_ALLOWED_EMAILS='Owner@example.com, person@example.com';
  https.request=(options,second,third)=>{
    const isVerification=options instanceof URL;const config=isVerification?second:options;const callback=isVerification?third:second;
    captured.push({isVerification,options,config});const up=new PassThrough();
    up.on('finish',()=>{const r=new PassThrough();r.statusCode=isVerification?verificationStatus:200;r.headers={'content-type':'application/json'};callback(r);r.end(isVerification?JSON.stringify(verified):'{"data":[]}')});return up;
  };
  try{await serverTest(async base=>{
    const missing=await fetch(base+'/api/codecraft/models');assert.equal(missing.status,401);assert.equal(captured.length,0);
    let r=await fetch(base+'/api/codecraft/models',{headers:{authorization:'Bearer user-session'}});assert.equal(r.status,200);
    assert.equal(captured.length,2);assert.equal(captured[0].options.hostname,'example.supabase.co');assert.equal(captured[0].config.headers.authorization,'Bearer user-session');
    assert.equal(captured[1].options.host,'codecraftapi.com');assert.equal(captured[1].options.path,'/v1/models');assert.equal(captured[1].config.headers.authorization,'Bearer cc-secret');
    assert.doesNotMatch(await r.text(),/cc-secret|user-session/);
    r=await fetch(base+'/api/codecraft/chat/completions',{method:'POST',headers:{authorization:'Bearer user-session','content-type':'application/json'},body:'{}'});assert.equal(r.status,200);assert.equal(captured[3].options.path,'/v1/chat/completions');assert.equal(captured[3].config.headers.authorization,'Bearer cc-secret');
    verificationStatus=401;r=await fetch(base+'/api/codecraft/models',{headers:{authorization:'Bearer invalid'}});assert.equal(r.status,401);assert.equal(captured.length,5);
    verificationStatus=200;verified={id:'user-b',email:'other@example.com',email_confirmed_at:'now'};r=await fetch(base+'/api/codecraft/models',{headers:{authorization:'Bearer outsider'}});assert.equal(r.status,403);assert.equal(captured.length,6);
    verified={id:'user-a',email:'owner@example.com',email_confirmed_at:null};r=await fetch(base+'/api/codecraft/models',{headers:{authorization:'Bearer unconfirmed'}});assert.equal(r.status,403);assert.equal(captured.length,7);
    delete process.env.CODECRAFT_ALLOWED_EMAILS;r=await fetch(base+'/api/codecraft/models',{headers:{authorization:'Bearer user-session'}});assert.equal(r.status,503);assert.equal(captured.length,7);
    const config=await (await fetch(base+'/api/config')).text();assert.doesNotMatch(config,/cc-secret|owner@example.com/);
  });}finally{https.request=original;names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);}
});

test('CodeCraft provider setting is restored per account without reusing a browser key',async()=>{
  const {ctx,values}=setupAccounts(async()=>({data:{chats:[],settings:{provider:'codecraft',model:{codecraft:'example-model'}}},error:null}));
  values.set('gemby.private.a',{provider:'openrouter',aiKey:'openrouter-key'});
  await ctx.applySession({user:{id:'a'}},'SIGNED_IN');
  assert.equal(vm.runInContext('cfg.provider',ctx),'codecraft');assert.equal(vm.runInContext('cfg.aiKey',ctx),'');
});

test('saved CodeCraft model is preserved while the live model list is loading',()=>{
  const html=fs.readFileSync('index.html','utf8');const source=html.slice(html.indexOf('const shortName='),html.indexOf('function buildTrack()'));
  const elements={mname:{textContent:''},msearch:{value:''},mlist:{innerHTML:''}};
  const ctx={cfg:{provider:'codecraft',model:{codecraft:'saved-sonnet'}},models:{codecraft:[]},codecraftError:'',document:{querySelectorAll:()=>[]},$:id=>elements[id],esc:x=>x,buildTrack:()=>{}};
  vm.createContext(ctx);vm.runInContext(source,ctx);ctx.renderModels();
  assert.equal(ctx.cfg.model.codecraft,'saved-sonnet');assert.equal(elements.mname.textContent,'Choose model');
  ctx.models.codecraft=['another-model','saved-sonnet'];ctx.renderModels();assert.equal(elements.mname.textContent,'saved-sonnet');
});
