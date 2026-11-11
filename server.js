import app from './app.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemby AI Web running on http://localhost:${PORT}`);
  console.log(`  OpenRouter key:   ${process.env.OPENROUTER_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  NVIDIA NIM key:   ${process.env.NVIDIA_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  3D (TRELLIS):     ${process.env.NVIDIA_API_KEY ? 'ready' : 'needs the NVIDIA key'}`);
});
