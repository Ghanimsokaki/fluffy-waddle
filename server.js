// Static server and fixed-destination API proxies. Node.js 20+.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MAX_PROXY_BODY = 1024 * 1024; // 1 MB for user-keyed provider and MCP proxies.

// Content-Security-Policy for the app. Scripts may only come from this origin (the build
// moves the inline script into /app.js). connect-src stays https: because users may add
// arbitrary remote MCP servers and their own Supabase project.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY', 'content-security-policy': CSP, 'permissions-policy': 'camera=(), microphone=(), geolocation=()' };

const intEnv = (name, fallback, min = 1, max = 1e9) => {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const emailList = name => (process.env[name] || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

function apiError(res, status, message, extra = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify({ error: { message } }));
}

// Pipe (or send a buffered body) to a fixed upstream host. Only content-type/accept and an
// explicit authorization are forwarded; cookies and other browser headers never are.
function proxy(req, res, host, upstreamPath, extraHeaders = {}, authorizationOverride = null, body = null) {
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*', ...extraHeaders };
  if (authorizationOverride) headers.authorization = authorizationOverride;
  else if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (body) headers['content-length'] = Buffer.byteLength(body);
  const up = https.request({ host, path: upstreamPath, method: req.method, headers, timeout: 60000 }, (r) => {
    const out = { 'content-type': r.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    for (const key of ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate', 'retry-after']) if (r.headers[key]) out[key] = r.headers[key];
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('Upstream timed out')));
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    apiError(res, 502, 'Could not reach upstream service.');
  });
  req.on('aborted', () => up.destroy());
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  if (body !== null) return up.end(body);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_PROXY_BODY) { up.destroy(); return apiError(res, 413, 'Request is too large.'); }
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_PROXY_BODY) { up.destroy(); apiError(res, 413, 'Request is too large.'); req.destroy(); return; }
    up.write(chunk);
  });
  req.on('end', () => up.end());
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > limit) return reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Request is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal JSON-over-HTTPS client used for Supabase verification, quotas and search.
function httpsJson(url, { method = 'GET', headers = {}, body = null, timeout = 10000, maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const allHeaders = { accept: 'application/json', ...headers };
    if (payload !== null) { allHeaders['content-type'] = 'application/json'; allHeaders['content-length'] = Buffer.byteLength(payload); }
    const request = https.request(url, { method, headers: allHeaders, timeout }, response => {
      let raw = ''; response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; if (raw.length > maxBytes) { response.destroy(); reject(new Error('Response too large')); } });
      response.on('error', reject);
      response.on('end', () => { let json; try { json = JSON.parse(raw); } catch {} resolve({ status: response.statusCode, json, raw }); });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(payload);
  });
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

function supabaseConfig() {
  const anon = publicSupabaseKey(process.env.SUPABASE_ANON_KEY);
  let base; try { base = new URL(process.env.SUPABASE_URL); } catch {}
  if (!anon || !base || base.protocol !== 'https:' || base.username || base.password) return null;
  return { anon, base };
}

// Verify a Supabase session server-side. Resolves to {user} or {status,message}.
async function verifyUser(req, allowedEmails, label) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { status: 401, message: `Sign in to use ${label}.` };
  const sb = supabaseConfig();
  if (!sb) return { status: 503, message: `${label} is not configured. Set the Supabase settings.` };
  let r;
  try { r = await httpsJson(new URL('/auth/v1/user', sb.base), { headers: { authorization: 'Bearer ' + token, apikey: sb.anon }, maxBytes: 65536 }); }
  catch { return { status: 502, message: 'Could not verify account with Supabase.' }; }
  if (r.status === 401 || r.status === 403) return { status: 401, message: 'Your session is invalid or expired. Sign in again.' };
  if (r.status !== 200 || !r.json) return { status: 502, message: 'Could not verify account with Supabase.' };
  const user = r.json;
  if (typeof user.id !== 'string' || typeof user.email !== 'string' || !user.email_confirmed_at || (allowedEmails && !allowedEmails.includes(user.email.trim().toLowerCase()))) {
    return { status: 403, message: `This account is not approved for ${label} or its email is unconfirmed.` };
  }
  return { user, token, sb };
}

// Durable per-user quota via the gemby_consume_quota RPC (see supabase/schema.sql). The RPC
// runs with the user's own JWT and counts against auth.uid(), so no service-role key is needed.
// Fails closed: if the function is missing, the billable request is refused.
async function consumeQuota(auth, bucket, limit) {
  let r;
  try { r = await httpsJson(new URL('/rest/v1/rpc/gemby_consume_quota', auth.sb.base), { method: 'POST', headers: { authorization: 'Bearer ' + auth.token, apikey: auth.sb.anon }, body: { p_bucket: bucket, p_limit: limit } }); }
  catch { return { status: 502, message: 'Could not check your usage limit.' }; }
  if (r.status === 404) return { status: 503, message: 'Usage limits are not set up. Run the latest supabase/schema.sql in Supabase.' };
  if (r.status !== 200) return { status: 502, message: 'Could not check your usage limit.' };
  if (r.json !== true) return { status: 429, message: bucket.endsWith('_day') ? 'Daily limit reached for this account. Try again tomorrow.' : 'Too many requests. Wait a minute and try again.' };
  return null;
}
async function consumeQuotas(auth, prefix) {
  const upper = prefix.toUpperCase();
  return (await consumeQuota(auth, prefix + '_minute', intEnv(upper + '_REQUESTS_PER_MINUTE', prefix === 'search' ? 10 : 6)))
    || (await consumeQuota(auth, prefix + '_day', intEnv(upper + '_REQUESTS_PER_DAY', prefix === 'search' ? 100 : 200)));
}

const CODECRAFT_FIELDS = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'stop'];
// Validate and cap a CodeCraft chat request. Unknown fields (n, max_completion_tokens, …) are dropped.
function sanitizeCodecraftBody(raw) {
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return { error: 'Request must be JSON.' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request must be a JSON object.' };
  if (typeof body.model !== 'string' || !body.model || body.model.length > 200) return { error: 'A model is required.' };
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 200) return { error: 'Messages must be a non-empty array of at most 200 entries.' };
  const cap = intEnv('CODECRAFT_MAX_TOKENS', 4096, 1, 200000);
  const out = {};
  for (const key of CODECRAFT_FIELDS) if (body[key] !== undefined) out[key] = body[key];
  const requested = Number(body.max_tokens);
  out.max_tokens = Number.isInteger(requested) && requested > 0 ? Math.min(requested, cap) : cap;
  if (out.tools !== undefined && (!Array.isArray(out.tools) || out.tools.length > 64)) return { error: 'Too many tools.' };
  return { body: JSON.stringify(out) };
}

// Verify the Supabase session server-side and require an explicitly allowed,
// confirmed email before using the deployer's shared CodeCraft credential.
async function codecraftProxy(req, res, upstreamPath) {
  if (!(req.headers.authorization || '').match(/^Bearer\s+\S+$/i)) return apiError(res, 401, 'Sign in to use CodeCraft.');
  const key = (process.env.CODECRAFT_API_KEY || '').trim();
  const allowed = emailList('CODECRAFT_ALLOWED_EMAILS');
  if (!key || !allowed.length || !supabaseConfig()) return apiError(res, 503, 'CodeCraft is not configured. Set its key, allowed emails, and Supabase settings.');
  const isChat = upstreamPath === '/v1/chat/completions';
  let raw = null;
  if (isChat) {
    try { raw = await readBody(req, intEnv('CODECRAFT_MAX_BODY_KB', 256, 1, 4096) * 1024); }
    catch (e) { return apiError(res, e.status || 400, e.status === 413 ? 'Request is too large for CodeCraft. Start a new chat or shorten the conversation.' : 'Could not read request.'); }
  }
  let aborted = false; req.on('aborted', () => { aborted = true; });
  const auth = await verifyUser(req, allowed, 'CodeCraft');
  if (!auth.user) return apiError(res, auth.status, auth.message);
  let body = null;
  if (isChat) {
    const clean = sanitizeCodecraftBody(raw);
    if (clean.error) return apiError(res, 400, clean.error);
    const limited = await consumeQuotas(auth, 'codecraft');
    if (limited) return apiError(res, limited.status, limited.message, limited.status === 429 ? { 'retry-after': '60' } : {});
    body = clean.body;
  }
  if (aborted) return;
  // Never forward the Supabase session to CodeCraft, or the CodeCraft key to the browser.
  proxy(req, res, 'codecraftapi.com', upstreamPath, isChat ? { 'content-type': 'application/json' } : {}, 'Bearer ' + key, body);
}

const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);
// Web search via Tavily with the server key. Results are untrusted text; the browser marks them as such.
async function searchHandler(req, res) {
  const key = (process.env.TAVILY_API_KEY || '').trim();
  if (!key) return apiError(res, 503, 'Web search is not configured on this deployment.');
  let raw; try { raw = await readBody(req, 8192); } catch (e) { return apiError(res, e.status || 400, 'Search request is too large.'); }
  let input; try { input = JSON.parse(raw.toString('utf8')); } catch {}
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > 400) return apiError(res, 400, 'Search query must be 1–400 characters.');
  const allowed = emailList('SEARCH_ALLOWED_EMAILS');
  const auth = await verifyUser(req, allowed.length ? allowed : null, 'web search');
  if (!auth.user) return apiError(res, auth.status, auth.message);
  const limited = await consumeQuotas(auth, 'search');
  if (limited) return apiError(res, limited.status, limited.message);
  const maxResults = Math.min(Math.max(Number.parseInt(input.max_results, 10) || 5, 1), 8);
  let r;
  try { r = await httpsJson('https://api.tavily.com/search', { method: 'POST', timeout: 15000, headers: { authorization: 'Bearer ' + key }, body: { query, max_results: maxResults, search_depth: 'basic', include_answer: false, include_raw_content: false, include_images: false } }); }
  catch { return apiError(res, 504, 'The search provider did not respond. Try again.'); }
  if (r.status === 429 || r.status === 432 || r.status === 433) return apiError(res, 429, 'The search provider limit was reached. Try again later.');
  if (r.status === 401 || r.status === 403) return apiError(res, 502, 'The search provider rejected this deployment’s key.');
  if (r.status !== 200 || !Array.isArray(r.json?.results)) return apiError(res, 502, 'The search provider returned an error.');
  const results = [];
  for (const item of r.json.results) {
    let url; try { url = new URL(item.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    results.push({ title: cleanText(item.title || url.hostname, 200), url: url.href.slice(0, 2000), snippet: cleanText(item.content, 600) });
    if (results.length >= maxResults) break;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ query, results }));
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/auth.js': ['auth.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/schema.sql': ['schema.sql', 'text/plain; charset=utf-8'],
};

function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (url.pathname.startsWith('/api/')) {
    if (!sameOrigin(req)) { res.writeHead(403); return res.end('Origin not allowed'); }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL?.trim() || '', supabaseAnonKey: publicSupabaseKey(process.env.SUPABASE_ANON_KEY), codecraftConfigured: !!process.env.CODECRAFT_API_KEY?.trim(), codecraftAccessConfigured: emailList('CODECRAFT_ALLOWED_EMAILS').length > 0, searchConfigured: !!process.env.TAVILY_API_KEY?.trim() }));
    }
    if ((url.pathname === '/api/codecraft/models' && req.method === 'GET') || (url.pathname === '/api/codecraft/chat/completions' && req.method === 'POST')) {
      return void codecraftProxy(req, res, url.pathname === '/api/codecraft/models' ? '/v1/models' : '/v1/chat/completions').catch(() => apiError(res, 500, 'CodeCraft request failed.'));
    }
    if (url.pathname === '/api/search' && req.method === 'POST') return void searchHandler(req, res).catch(() => apiError(res, 500, 'Search failed.'));
    if (['/api/nvidia/chat/completions', '/api/openrouter/chat/completions', '/api/box'].includes(url.pathname) && !/^Bearer\s+\S+$/i.test(req.headers.authorization || '')) {
      return apiError(res, 401, 'A user-supplied bearer credential is required.');
    }
    if (url.pathname === '/api/nvidia/models' && req.method === 'GET') {
      // NVIDIA's model list is public; never attach a server credential.
      return proxy(req, res, 'integrate.api.nvidia.com', '/v1/models', {});
    }
    if (url.pathname === '/api/nvidia/chat/completions' && req.method === 'POST') {
      return proxy(req, res, 'integrate.api.nvidia.com', '/v1/chat/completions', {});
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
  // Serve only built public assets, never the repository or server source.
  const entry = STATIC[url.pathname];
  if (!['GET', 'HEAD'].includes(req.method) || !entry) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(PUBLIC, entry[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Could not load app. Run npm run build.'); }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

if (require.main === module) http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`Gemby AIs listening on port ${PORT}`));
module.exports = { handler, sameOrigin, publicSupabaseKey, sanitizeCodecraftBody, CSP, SECURITY_HEADERS };
