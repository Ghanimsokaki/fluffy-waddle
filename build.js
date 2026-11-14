const fs = require('node:fs');
const esbuild = require('esbuild');
fs.mkdirSync('public', { recursive: true });
for (const file of ['index.html', 'icon.svg']) fs.copyFileSync(file, `public/${file}`);
fs.copyFileSync('supabase/schema.sql', 'public/schema.sql');
esbuild.buildSync({entryPoints:['auth-entry.js'], bundle:true, minify:true, platform:'browser', format:'iife', outfile:'public/auth.js'});
