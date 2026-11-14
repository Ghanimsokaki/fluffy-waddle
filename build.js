// Builds the static site into public/. The inline app script is moved to /app.js so the
// Content-Security-Policy can forbid inline scripts (script-src 'self').
const fs = require('node:fs');
const esbuild = require('esbuild');
fs.rmSync('public', { recursive: true, force: true });
fs.mkdirSync('public', { recursive: true });
const html = fs.readFileSync('index.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('index.html must contain the inline app <script>.');
if (/<script>/.test(html.slice(match.index + match[0].length))) throw new Error('Only one inline <script> is supported.');
fs.writeFileSync('public/app.js', match[1]);
fs.writeFileSync('public/index.html', html.replace(match[0], '<script src="/app.js"></script>'));
fs.copyFileSync('icon.svg', 'public/icon.svg');
fs.copyFileSync('supabase/schema.sql', 'public/schema.sql');
esbuild.buildSync({ entryPoints: ['auth-entry.js'], bundle: true, minify: true, platform: 'browser', format: 'iife', outfile: 'public/auth.js' });
