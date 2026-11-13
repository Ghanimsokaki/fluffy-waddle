// Static server and fixed-destination API proxies. Node.js 20+.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;

function proxy(req, res, host, upstreamPath, extraHeaders = {}, environmentKey = '') {
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*', ...extraHeaders };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  else if (environmentKey) headers.authorization = 'Bearer ' + environmentKey;
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

function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (url.pathname.startsWith('/api/')) {
    if (!sameOrigin(req)) { res.writeHead(403); return res.end('Origin not allowed'); }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(JSON.stringify({ openrouter: !!process.env.OPENROUTER_API_KEY?.trim(), nvidia: !!process.env.NVIDIA_API_KEY?.trim(), box: !!process.env.BOX_ACCESS_TOKEN?.trim() }));
    }
    if ((url.pathname === '/api/nvidia/models' && req.method === 'GET') || (url.pathname === '/api/nvidia/chat/completions' && req.method === 'POST')) {
      return proxy(req, res, 'integrate.api.nvidia.com', '/v1' + url.pathname.slice('/api/nvidia'.length) + url.search, {}, process.env.NVIDIA_API_KEY?.trim());
    }
    if (url.pathname === '/api/openrouter/chat/completions' && req.method === 'POST') {
      return proxy(req, res, 'openrouter.ai', '/api/v1/chat/completions', {}, process.env.OPENROUTER_API_KEY?.trim());
    }
    if (url.pathname === '/api/box' && ['POST', 'DELETE'].includes(req.method)) {
      const headers = {};
      for (const key of ['mcp-session-id', 'mcp-protocol-version']) if (req.headers[key]) headers[key] = req.headers[key];
      return proxy(req, res, 'mcp.box.simular.ai', '/mcp', headers, process.env.BOX_ACCESS_TOKEN?.trim());
    }
    res.writeHead(404); return res.end('Not found');
  }
  // Serve only public assets, never the repository or server source.
  if (!['GET', 'HEAD'].includes(req.method) || !['/', '/index.html'].includes(url.pathname)) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(path.join(ROOT, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Could not load app'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

if (require.main === module) http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`Fluffy Waddle listening on port ${PORT}`));
module.exports = { handler, sameOrigin };
