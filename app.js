import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerConfig, listOpenRouterFreeModels, openRouterFallback, listNvidiaModels, nvidiaFallback, HF_CURATED_MODELS } from './src/providers.js';
import { McpManager } from './src/mcp.js';
import { runAgent } from './src/agent.js';
import { routeRequest, classifyTask, routerPool } from './src/router.js';
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
app.use(express.json({ limit: '2mb' }));
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

app.get('/api/models', async (req, res) => {
  const provider = req.query.provider || 'openrouter';
  try {
    if (provider === 'huggingface') return res.json({ provider, models: HF_CURATED_MODELS });
    if (provider === 'nvidia') return res.json({ provider, models: await listNvidiaModels() });
    const models = await listOpenRouterFreeModels();
    res.json({ provider, models });
  } catch (err) {
    // Keep the UI usable offline with a small built-in list.
    if (provider === 'nvidia') return res.json({ provider, models: nvidiaFallback(), warning: String(err.message || err) });
    res.json({ provider: 'openrouter', models: openRouterFallback(), warning: String(err.message || err) });
  }
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
  const { provider, model, messages, mcpServers } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
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

    // Only offer the 3D tool when the request is actually about 3D. Sending it
    // on every turn makes chat models describe themselves as the TRELLIS
    // pipeline (they just read the tool description back to the user).
    const lastUser = [...convo].reverse().find((m) => m.role === 'user');
    const task = routeTask || classifyTask(typeof lastUser?.content === 'string' ? lastUser.content : '');
    const builtin = task === '3d' ? builtinTools() : [];

    const tools = [...builtin, ...mcp.openAiTools(ids)];
    const callTool = (name, args) => (isBuiltinTool(name)
      ? callBuiltinTool(name, args, send)
      : mcp.callTool(name, args));

    await runAgent({
      provider: useProvider,
      model: useModel,
      messages: convo,
      tools,
      signal: controller.signal,
      callTool,
      onEvent: send,
    });
  } catch (err) {
    send({ type: 'error', message: String(err?.message || err) });
  }

  send({ type: 'done' });
  res.end();
});

export default app;
