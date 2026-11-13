// Only the app HTML is public; Vercel bundles API dependencies separately.
const fs = require('node:fs');
fs.mkdirSync('public', { recursive: true });
fs.copyFileSync('index.html', 'public/index.html');
