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
    for (const file of ['/server.js', '/.git/config', '/README.md', '/%2e%2e/server.js']) assert.equal((await fetch(base + file)).status, 404);
    assert.equal((await fetch(base + '/api/box', {method:'POST', headers:{origin:'https://evil.example'}})).status, 403);
    assert.equal((await fetch(base + '/api/box', {method:'GET'})).status, 404);
  });
});

function setup(fetch, confirm = () => true) {
  const html = fs.readFileSync('index.html','utf8');
  const source = html.slice(html.indexOf('// Streamable HTTP MCP client.'), html.indexOf('function showError('));
  const context = {fetch, confirm, AbortController, TextDecoder, Uint8Array, URL, performance, JSON, serverConfigPromise:Promise.resolve(), serverKeys:{openrouter:false,nvidia:false,box:false},
    cfg:{provider:'openrouter',model:{openrouter:'test-model'},boxEnabled:true,boxToken:'box-token',webSearch:true},
    endpoint:()=>({url:'https://provider.test/chat',key:'ai-token',hasKey:true,name:'OpenRouter',headers:{}}),
    UserError:class UserError extends Error {}, explain:(s)=>new Error('HTTP '+s),
    nearBottom:()=>false,toBottom:()=>{},thinkHTML:x=>x,md:x=>x};
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

test('configuration reports only key presence, never values', async () => {
  const names=['OPENROUTER_API_KEY','NVIDIA_API_KEY','BOX_ACCESS_TOKEN'];
  const before=names.map(n=>process.env[n]);
  process.env.OPENROUTER_API_KEY='or-secret'; process.env.NVIDIA_API_KEY=' '; process.env.BOX_ACCESS_TOKEN='box-secret';
  try {
    await serverTest(async base => {
      const res=await fetch(base+'/api/config');
      assert.equal(res.headers.get('cache-control'),'no-store');
      const raw=await res.text();
      assert.deepEqual(JSON.parse(raw),{openrouter:true,nvidia:false,box:true});
      assert.doesNotMatch(raw,/or-secret|box-secret/);
    });
  } finally {names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);}
});

test('server credentials are used only as fallback and sent to the correct upstream', async () => {
  const https=require('node:https'), {PassThrough}=require('node:stream');
  const original=https.request, names=['OPENROUTER_API_KEY','NVIDIA_API_KEY','BOX_ACCESS_TOKEN'];
  const before=names.map(n=>process.env[n]);let captured=[];
  process.env.OPENROUTER_API_KEY='server-or';process.env.NVIDIA_API_KEY='server-nv';process.env.BOX_ACCESS_TOKEN='server-box';
  https.request=(options,callback)=>{
    captured.push(options);const up=new PassThrough();up.on('finish',()=>{const r=new PassThrough();r.statusCode=200;r.headers={'content-type':'application/json'};callback(r);r.end('{}')});return up;
  };
  try {
    await serverTest(async base=>{
      for(const [path,authorization] of [['/api/openrouter/chat/completions',null],['/api/nvidia/chat/completions',null],['/api/box',null],['/api/openrouter/chat/completions','Bearer browser-key']]) {
        const headers={'content-type':'application/json'};if(authorization)headers.authorization=authorization;
        assert.equal((await fetch(base+path,{method:'POST',headers,body:'{}'})).status,200);
      }
      assert.deepEqual(captured.map(c=>[c.host,c.headers.authorization]),[['openrouter.ai','Bearer server-or'],['integrate.api.nvidia.com','Bearer server-nv'],['mcp.box.simular.ai','Bearer server-box'],['openrouter.ai','Bearer browser-key']]);
      assert.equal((await fetch(base+'/api/openrouter/other',{method:'POST'})).status,404);
      assert.equal((await fetch(base+'/api/nvidia/other',{method:'GET'})).status,404);
    });
  } finally {https.request=original;names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);}
});

test('server Box token can be used without sending a browser authorization header', async () => {
  const ctx=setup(async (url,options)=>{
    assert.equal(url,'/api/box');assert.equal(options.headers.Authorization,undefined);
    const body=JSON.parse(options.body);
    if(body.method==='initialize')return json({id:body.id,result:{protocolVersion:'2025-03-26'}});
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    return json({id:body.id,result:{tools:[]}});
  });
  ctx.serverKeys.box=true;
  assert.equal((await ctx.connectBox('')).tools.length,0);
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
      assert.deepEqual(body.tools.map(t=>t.function.name),['fw_mcp_0','fw_mcp_1']);
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
