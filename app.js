import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerConfig, listOpenRouterFreeModels, openRouterFallback, listNvidiaModels, nvidiaFallback, HF_CURATED_MODELS } from './src/providers.js';
import { McpManager } from './src/mcp.js';
import { runAgent } from './src/agent.js';
import { routeRequest, classifyTask, routerPool, textOf, hasImagePart } from './src/router.js';
import { builtinTools, isBuiltinTool, callBuiltinTool } from './src/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const mcp = new McpManager();

// Ready-made MCP servers the user can add with one click.
const MCP_PRESETS = [
  { key: 'roblox', name: 'Roblox Studio', transport: 'stdio', command: 'npx', args: ['-y', 'robloxstudio-mcp'],
    hint: 'Connect to Roblox Studio. Install the companion Studio plugin from the package, then Start.' },
  { key: 'everything', name: 'Everything (demo)', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'],
    hint: 'A demo server with sample tools (math, echo, …).' },
];

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    defaultProvider: process.env.DEFAULT_PROVIDER || 'openrouter',
    defaultModel: process.env.DEFAULT_MODEL || '',
    hasHuggingFace: !!process.env.HF_TOKEN,
    hasOpenRouter: !!process.env.OPENROUTER_API_KEY,
    hasNvidia: !!process.env.NVIDIA_API_KEY,
    hasHfEndpoint: !!process.env.HF_ENDPOINT_URL,
    hasTrellis: !!process.env.HF_TOKEN,
    providers: ['auto', 'openrouter', 'nvidia', 'huggingface'],
  });
});

// One flat list of every model the app can talk to - there is no provider
// picker in the UI. Each item carries the provider it belongs to internally so
// /api/chat knows where to send it.
app.get('/api/models', async (_req, res) => {
  const models = [...HF_CURATED_MODELS];
  const warnings = [];
  try {
    models.push(...await listOpenRouterFreeModels());
  } catch (err) {
    models.push(...openRouterFallback());
    warnings.push(String(err.message || err));
  }
  if (process.env.NVIDIA_API_KEY) {
    try {
      models.push(...await listNvidiaModels());
    } catch (err) {
      models.push(...nvidiaFallback());
      warnings.push(String(err.message || err));
    }
  }
  res.json({ models, warning: warnings.join('; ') || undefined });
});

// ---- Router: decide which AI to use for a request ------------------------
app.post('/api/route', async (req, res) => {
  try {
    const { messages, task } = req.body || {};
    res.json(await routeRequest({ messages: Array.isArray(messages) ? messages : [], forcedTask: task }));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
app.get('/api/classify', (req, res) => res.json({ task: classifyTask(String(req.query.text || '')) }));

// The list of AIs the auto-router can choose from (OpenRouter + NVIDIA NIM).
app.get('/api/route/models', async (_req, res) => {
  try {
    res.json({ models: await routerPool() });
  } catch (err) {
    res.json({ models: [], warning: String(err.message || err) });
  }
});

// ---- MCP servers ---------------------------------------------------------
app.get('/api/mcp/presets', (_req, res) => res.json(MCP_PRESETS));
app.get('/api/mcp/servers', (_req, res) => res.json(mcp.list()));

app.post('/api/mcp/servers', (req, res) => {
  try {
    res.json({ id: mcp.add(req.body || {}), readOnly: mcp.readOnly });
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
  const { provider, model, messages, mcpServers, web } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let emitted = false;
  const send = (obj) => {
    if (obj && (obj.type === 'delta' || obj.type === 'tool_call')) emitted = true;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const convo = Array.isArray(messages) ? messages : [];

    // "auto" lets the router pick the right AI for this request.
    let useProvider = provider;
    let useModel = model;
    let routeTask = null;
    if (provider === 'auto') {
      const route = await routeRequest({ messages: convo });
      useProvider = route.provider;
      useModel = route.model || process.env.DEFAULT_MODEL || '';
      routeTask = route.task;
      send({ type: 'route', ...route, provider: useProvider, model: useModel });
    }

    if (!useModel) throw new Error('No model selected');
    const cfg = providerConfig(useProvider);
    if (!cfg.apiKey) {
      throw new Error(`No API key configured on the server for ${cfg.label}. Add it to your environment variables.`);
    }

    // On serverless hosts there is no persistent state, so connect HTTP MCP servers on demand.
    const ids = Array.isArray(mcpServers) ? mcpServers : [];
    for (const id of ids) {
      try {
        await mcp.ensureConnected(id);
      } catch (err) {
        send({ type: 'tool_result', name: 'MCP connect', ok: false, result: String(err.message || err) });
      }
    }

    // Only offer each tool when the request actually needs it. Sending the 3D /
    // image tool on every turn makes chat models read the tool description back
    // to the user (e.g. claiming to be TRELLIS).
    const lastUser = [...convo].reverse().find((m) => m.role === 'user');
    const attachedImage = convo.some((m) => hasImagePart(m.content));
    const task = routeTask || (attachedImage ? 'vision' : classifyTask(textOf(lastUser?.content)));
    const builtin = builtinTools({ web: web !== false, threeD: task === '3d', image: task === 'image' });

    const tools = [...builtin, ...mcp.openAiTools(ids)];
    const callTool = (name, args) => (isBuiltinTool(name)
      ? callBuiltinTool(name, args, send)
      : mcp.callTool(name, args));

    const runOnce = (p, m) => runAgent({
      provider: p,
      model: m,
      messages: convo,
      tools,
      signal: controller.signal,
      callTool,
      onEvent: send,
    });

    try {
      await runOnce(useProvider, useModel);
    } catch (err) {
      // If an auto-routed provider fails before producing anything, retry on a
      // known-good fallback instead of showing the user an error.
      const canRetry = provider === 'auto' && !emitted && useProvider !== 'openrouter';
      if (!canRetry) throw err;
      const fbProvider = 'openrouter';
      const fbModel = process.env.DEFAULT_MODEL || 'openrouter/free';
      send({ type: 'route', task: routeTask, provider: fbProvider, model: fbModel,
        reason: `${useProvider} failed (${String(err.message || err).slice(0, 120)}) — retrying on a fallback model.` });
      await runOnce(fbProvider, fbModel);
    }
  } catch (err) {
    send({ type: 'error', message: String(err?.message || err) });
  }

  send({ type: 'done' });
  res.end();
});

export default app;
