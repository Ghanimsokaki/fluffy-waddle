// Static checks for this dependency-light app (no framework linter): syntax of every JS file,
// unique element ids, and that every $('id') used by the app script exists in index.html.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let failed = false;
const fail = msg => { failed = true; console.error('✗ ' + msg); };
const files = ['server.js', 'build.js', 'auth-entry.js', 'scripts/check.js', ...fs.readdirSync('test').map(f => 'test/' + f)];
(function walk(dir) { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); } })('api');
if (fs.existsSync('public/app.js')) files.push('public/app.js'); else fail('public/app.js missing: run npm run build first');
for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail(`${f}: ${e.stderr}`); } }
const html = fs.readFileSync('index.html', 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) fail('duplicate id: ' + id);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const id of new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]))) if (!ids.includes(id)) fail(`$('${id}') has no element in index.html`);
for (const m of html.matchAll(/<label for="([^"]+)"/g)) if (!ids.includes(m[1])) fail(`label for="${m[1]}" has no matching control`);
if (failed) process.exit(1);
console.log(`✓ ${files.length} JS files parse; ${ids.length} unique ids; all $() references and labels resolve`);
