// Cloudflare Worker proxy for NVIDIA NIM (adds the CORS headers NVIDIA omits).
// Deploy, then set Settings > Proxy base URL to  https://<your-worker>.workers.dev/v1
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) return new Response('Not found', { status: 404, headers: CORS });
    const upstream = await fetch('https://integrate.api.nvidia.com' + url.pathname + url.search, {
      method: request.method,
      headers: {
        authorization: request.headers.get('authorization') || '',
        'content-type': request.headers.get('content-type') || 'application/json',
        accept: request.headers.get('accept') || '*/*',
      },
      body: request.method === 'POST' ? request.body : undefined,
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
