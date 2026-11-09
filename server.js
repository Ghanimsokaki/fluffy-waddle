import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerConfig, listOpenRouterFreeModels, openRouterFallback, HF_CURATED_MODELS } from './src/providers.js';
import { McpManager } from './src/mcp.js';
import { runAgent } from './src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const mcp = new McpManager();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    defaultProvider: process.env.DEFAULT_PROVIDER || 'openrouter',
    defaultModel: process.env.DEFAULT_MODEL || '',
    hasHuggingFace: !!process.env.HF_TOKEN,
    hasOpenRouter: !!process.env.OPENROUTER_API_KEY,
  });
});

app.get('/api/models', async (req, res) => {
  const provider = req.query.provider || 'openrouter';
  try {
    if (provider === 'huggingface') return res.json({ provider, models: HF_CURATED_MODELS });
    const models = await listOpenRouterFreeModels();
    res.json({ provider, models });
  } catch (err) {
    // Keep the UI usable offline with a small built-in free list.
    res.json({ provider: 'openrouter', models: openRouterFallback(), warning: String(err.message || err) });
  }
});

// ---- MCP servers ---------------------------------------------------------
app.get('/api/mcp/servers', (_req, res) => res.json(mcp.list()));

app.post('/api/mcp/servers', (req, res) => {
  try {
    res.json({ id: mcp.add(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/mcp/servers/:id/connect', async (req, res) => {
  try {
    res.json(await mcp.connect(req.params.id));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/mcp/servers/:id/disconnect', async (req, res) => {
  await mcp.disconnect(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/mcp/servers/:id', async (req, res) => {
  await mcp.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Chat (Server-Sent Events) -------------------------------------------
app.post('/api/chat', async (req, res) => {
  const { provider, model, messages, mcpServers } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    if (!model) throw new Error('No model selected');
    const cfg = providerConfig(provider);
    if (!cfg.apiKey) {
      throw new Error(`No API key configured on the server for ${cfg.label}. Add it to your .env file.`);
    }
    const tools = mcpServers?.length ? mcp.openAiTools(mcpServers) : [];
    await runAgent({
      provider,
      model,
      messages: Array.isArray(messages) ? messages : [],
      tools,
      signal: controller.signal,
      callTool: (name, args) => mcp.callTool(name, args),
      onEvent: send,
    });
  } catch (err) {
    send({ type: 'error', message: String(err?.message || err) });
  }

  send({ type: 'done' });
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemby AI Web running on http://localhost:${PORT}`);
  console.log(`  Hugging Face key: ${process.env.HF_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`  OpenRouter key:   ${process.env.OPENROUTER_API_KEY ? 'set' : 'MISSING'}`);
});
