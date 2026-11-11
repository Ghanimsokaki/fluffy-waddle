// Web search + page reading, with no API key required.
// Uses DuckDuckGo's HTML endpoint for search and a small HTML-to-text reducer.
// All requests happen on the server, so the browser never sees third-party calls.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'", hellip: '…', mdash: '—', ndash: '–' };

function decode(s = '') {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

// Reduce an HTML document to readable text.
function htmlToText(html = '') {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Pull results out of a DuckDuckGo HTML page.
function parseResults(html, limit) {
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a[^>]+class="[^"]*result__a|$)/g;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    const snippetMatch = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    results.push({
      title: htmlToText(m[2]).replace(/\s+/g, ' ').trim(),
      url,
      snippet: snippetMatch ? htmlToText(snippetMatch[1]).replace(/\s+/g, ' ').trim() : '',
    });
  }
  return results;
}

export async function webSearch(query, limit = 5) {
  const n = Math.max(1, Math.min(Number(limit) || 5, 8));
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`Web search failed (HTTP ${res.status})`);
  return parseResults(await res.text(), n);
}

export async function fetchPage(url, maxChars = 5000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  const text = type.includes('html') ? htmlToText(body) : body.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n… (truncated)` : text;
}
