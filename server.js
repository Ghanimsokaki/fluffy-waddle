// Zero-dependency static server + NVIDIA NIM proxy.
// Usage: node server.js [port]
// The browser calls /api/nvidia/* and this server forwards it to NVIDIA,
// because integrate.api.nvidia.com does not allow cross-origin browser requests.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const NVIDIA_HOST = 'integrate.api.nvidia.com';
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function proxy(req, res) {
  const upstreamPath = '/v1' + req.url.slice('/api/nvidia'.length);
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  const up = https.request({ host: NVIDIA_HOST, path: upstreamPath, method: req.method, headers }, (r) => {
    const out = { 'content-type': r.headers['content-type'] || 'application/json', 'cache-control': 'no-cache' };
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy could not reach NVIDIA: ' + e.message } }));
  });
  req.pipe(up);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/nvidia/')) return proxy(req, res);
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Fluffy Waddle running at http://localhost:${PORT}`));
