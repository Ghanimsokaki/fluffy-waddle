// Static server and fixed-destination API proxies. Node.js 20+.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;

function proxy(req, res, host, upstreamPath, extraHeaders = {}, authorizationOverride = null) {
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*', ...extraHeaders };
  if (authorizationOverride) headers.authorization = authorizationOverride;
  else if (req.headers.authorization) headers.authorization = req.headers.authorization;
  const up = https.request({ host, path: upstreamPath, method: req.method, headers, timeout: 60000 }, (r) => {
    const out = { 'content-type': r.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    for (const key of ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate']) if (r.headers[key]) out[key] = r.headers[key];
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('Upstream timed out')));
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message: 'Could not reach upstream service.' } }));
  });
  req.on('aborted', () => up.destroy());
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
}

function sameOrigin(req) {
  if (!req.headers.origin) return true; // Non-browser clients do not send Origin.
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

// Never intentionally publish a Supabase secret/service-role key as client config.
function publicSupabaseKey(value) {
  const key = (value || '').trim();
  if (/^sb_secret_/i.test(key)) return '';
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString());
    if (['service_role', 'supabase_admin'].includes(payload.role)) return '';
  } catch {} // Publishable keys are opaque and do not have a JWT payload.
  return key;
}

// Verify the Supabase session and confirmed email before using a shared provider key.
function codecraftProxy(req, res, upstreamPath, provider = 'codecraft') {
  const names = {codecraft: 'CodeCraft', moduck: 'Moduck', bytez: 'Bytez'};
  const name = names[provider], prefix = provider.toUpperCase();
  const token = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return apiError(res, 401, 'Sign in to use '+name+'.');
  const key = (process.env[prefix+'_API_KEY'] || '').trim();
  const anon = publicSupabaseKey(process.env.SUPABASE_ANON_KEY);
  let authUrl;try {authUrl = new URL('/auth/v1/user', process.env.SUPABASE_URL);} catch {}
  let destination;
  if(provider==='moduck') {
    try { const u=new URL(process.env.MODUCK_API_BASE_URL); if(u.protocol==='https:' && !u.username && !u.password && !u.port && u.pathname==='/' && !u.search && !u.hash && (u.hostname==='moduck.ai'||u.hostname.endsWith('.moduck.ai'))) destination=u.hostname; } catch {}
  } else destination=provider==='bytez'?'api.bytez.com':'codecraftapi.com';
  if (!key || !anon || !authUrl || authUrl.protocol !== 'https:' || authUrl.username || authUrl.password || !destination) {
    return apiError(res, 503, name+' is not configured. Set its key and Supabase settings'+(provider==='moduck'?' and MODUCK_API_BASE_URL':'')+'.');
  }
  let done = false;
  const fail = (status, message) => {if (done) return;done = true;apiError(res,status,message);};
  const verification = https.request(authUrl, {method:'GET',headers:{authorization:'Bearer '+token,apikey:anon,accept:'application/json'},timeout:10000}, response => {
    let raw='';response.setEncoding('utf8');
    response.on('data', chunk => {raw+=chunk;if(raw.length>65536){response.destroy();fail(502,'Could not verify account.');}});
    response.on('error',()=>fail(502,'Could not verify account.'));
    response.on('end',()=>{
      if(done)return;
      if(response.statusCode===401||response.statusCode===403)return fail(401,'Your session is invalid or expired. Sign in again.');
      if(response.statusCode!==200)return fail(502,'Could not verify account with Supabase.');
      let user;try{user=JSON.parse(raw)}catch{return fail(502,'Invalid account verification response.');}
      if(typeof user.id!=='string'||typeof user.email!=='string'||!user.email.trim()||!user.email_confirmed_at)return fail(403,'A confirmed email is required to use '+name+'.');
      done=true;
      // Never forward the Supabase session to the provider or its key to the browser.
      proxy(req,res,destination,upstreamPath,{},provider==='bytez' && req.method==='GET'?key:'Bearer '+key);
    });
  });
  verification.on('timeout',()=>verification.destroy(new Error('timeout')));
  verification.on('error',()=>fail(502,'Could not verify account with Supabase.'));
  req.on('aborted',()=>verification.destroy());
  verification.end();
}
function apiError(res,status,message) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({error:{message}}));
}

function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (url.pathname.startsWith('/api/')) {
    if (!sameOrigin(req)) { res.writeHead(403); return res.end('Origin not allowed'); }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL?.trim() || '', supabaseAnonKey: publicSupabaseKey(process.env.SUPABASE_ANON_KEY), codecraftConfigured: !!process.env.CODECRAFT_API_KEY?.trim(), moduckConfigured: !!process.env.MODUCK_API_KEY?.trim() && !!process.env.MODUCK_API_BASE_URL?.trim(), bytezConfigured: !!process.env.BYTEZ_API_KEY?.trim() }));
    }
    if ((url.pathname==='/api/codecraft/models' && req.method==='GET') || (url.pathname==='/api/codecraft/chat/completions' && req.method==='POST')) {
      return codecraftProxy(req,res,url.pathname==='/api/codecraft/models'?'/v1/models':'/v1/chat/completions');
    }
    for (const provider of ['moduck','bytez']) {
      if (url.pathname==='/api/'+provider+'/models' && req.method==='GET')
        return codecraftProxy(req,res,provider==='bytez'?'/models/v2/list/models?task=chat':'/v1/models',provider);
      if (url.pathname==='/api/'+provider+'/chat/completions' && req.method==='POST')
        return codecraftProxy(req,res,provider==='bytez'?'/models/v2/openai/v1/chat/completions':'/v1/chat/completions',provider);
    }
    if (['/api/nvidia/chat/completions','/api/openrouter/chat/completions','/api/box'].includes(url.pathname) && !/^Bearer\s+\S+$/i.test(req.headers.authorization || '')) {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: { message: 'A user-supplied bearer credential is required.' } }));
    }
    if ((url.pathname === '/api/nvidia/models' && req.method === 'GET') || (url.pathname === '/api/nvidia/chat/completions' && req.method === 'POST')) {
      return proxy(req, res, 'integrate.api.nvidia.com', '/v1' + url.pathname.slice('/api/nvidia'.length) + url.search, {});
    }
    if (url.pathname === '/api/openrouter/chat/completions' && req.method === 'POST') {
      return proxy(req, res, 'openrouter.ai', '/api/v1/chat/completions', {});
    }
    if (url.pathname === '/api/box' && ['POST', 'DELETE'].includes(req.method)) {
      const headers = {};
      for (const key of ['mcp-session-id', 'mcp-protocol-version']) if (req.headers[key]) headers[key] = req.headers[key];
      return proxy(req, res, 'mcp.box.simular.ai', '/mcp', headers);
    }
    res.writeHead(404); return res.end('Not found');
  }
  // Serve only public assets, never the repository or server source.
  if (!['GET', 'HEAD'].includes(req.method) || !['/', '/index.html', '/icon.svg', '/auth.js', '/schema.sql'].includes(url.pathname)) {
    res.writeHead(404); return res.end('Not found');
  }
  const file = url.pathname === '/icon.svg' ? path.join(ROOT,'icon.svg') : url.pathname === '/auth.js' ? path.join(ROOT,'public','auth.js') : url.pathname === '/schema.sql' ? path.join(ROOT,'supabase','schema.sql') : path.join(ROOT,'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Could not load app'); }
    res.writeHead(200, { 'content-type': url.pathname === '/icon.svg' ? 'image/svg+xml' : url.pathname === '/auth.js' ? 'text/javascript; charset=utf-8' : url.pathname === '/schema.sql' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

if (require.main === module) http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`Gemby AIs listening on port ${PORT}`));
module.exports = { handler, sameOrigin, publicSupabaseKey };
