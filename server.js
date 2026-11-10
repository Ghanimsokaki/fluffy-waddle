import app from './app.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemby AI Web running on http://localhost:${PORT}`);
  console.log(`  Hugging Face key: ${process.env.HF_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`  HF endpoint URL:  ${process.env.HF_ENDPOINT_URL || '(none, using router)'}`);
  console.log(`  OpenRouter key:   ${process.env.OPENROUTER_API_KEY ? 'set' : 'MISSING'}`);
});
