// MCP (Model Context Protocol) client manager.
// Connects to MCP servers over stdio (local commands) or HTTP (remote),
// exposes their tools to the model, and executes tool calls.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const STORE = path.resolve(process.cwd(), 'mcp-servers.local.json');
const prefix = (id) => id.replace(/-/g, '').slice(0, 8);

export class McpManager {
  constructor() {
    this.servers = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(STORE)) return;
      const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      for (const cfg of raw) this.servers.set(cfg.id, { cfg, client: null, tools: [] });
    } catch { /* ignore corrupt store */ }
  }

  save() {
    try {
      const arr = [...this.servers.values()].map((s) => s.cfg);
      fs.writeFileSync(STORE, JSON.stringify(arr, null, 2));
    } catch { /* ignore */ }
  }

  list() {
    return [...this.servers.values()].map((s) => ({
      id: s.cfg.id,
      name: s.cfg.name,
      transport: s.cfg.transport,
      connected: !!s.client,
      toolCount: s.tools.length,
      tools: s.tools.map((t) => t.name),
    }));
  }

  add(input = {}) {
    const id = input.id || randomUUID();
    const cfg = {
      id,
      name: input.name || id,
      transport: input.transport === 'http' ? 'http' : 'stdio',
      command: input.command || undefined,
      args: Array.isArray(input.args) ? input.args : [],
      env: input.env && typeof input.env === 'object' ? input.env : {},
      url: input.url || undefined,
    };
    if (cfg.transport === 'stdio' && !cfg.command) throw new Error('stdio server needs a "command"');
    if (cfg.transport === 'http' && !cfg.url) throw new Error('http server needs a "url"');
    this.servers.set(id, { cfg, client: null, tools: [] });
    this.save();
    return id;
  }

  async remove(id) {
    await this.disconnect(id);
    this.servers.delete(id);
    this.save();
  }

  async connect(id) {
    const s = this.servers.get(id);
    if (!s) throw new Error(`MCP server ${id} not found`);
    if (s.client) return this.list().find((x) => x.id === id);
    const client = new Client({ name: 'gemby-web', version: '1.0.0' }, { capabilities: {} });
    const transport = s.cfg.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(s.cfg.url))
      : new StdioClientTransport({ command: s.cfg.command, args: s.cfg.args, env: { ...process.env, ...s.cfg.env } });
    await client.connect(transport);
    s.client = client;
    const res = await client.listTools();
    s.tools = res.tools || [];
    return this.list().find((x) => x.id === id);
  }

  async disconnect(id) {
    const s = this.servers.get(id);
    if (s?.client) {
      try { await s.client.close(); } catch { /* ignore */ }
      s.client = null;
      s.tools = [];
    }
  }

  findByPrefix(p) {
    for (const s of this.servers.values()) if (prefix(s.cfg.id) === p) return s;
    return null;
  }

  // Tools in OpenAI function-calling format, for the servers the user enabled.
  openAiTools(ids) {
    const out = [];
    for (const id of ids) {
      const s = this.servers.get(id);
      if (!s?.client) continue;
      for (const t of s.tools) {
        out.push({
          type: 'function',
          function: {
            name: `${prefix(id)}__${t.name}`.slice(0, 64),
            description: `[${s.cfg.name}] ${t.description || t.name}`.slice(0, 1000),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    }
    return out;
  }

  async callTool(name, args) {
    const sep = name.indexOf('__');
    if (sep < 0) throw new Error(`Invalid tool name: ${name}`);
    const s = this.findByPrefix(name.slice(0, sep));
    if (!s?.client) throw new Error(`MCP server for tool ${name} is not connected`);
    const toolName = name.slice(sep + 2);
    const res = await s.client.callTool({ name: toolName, arguments: args || {} });
    if (Array.isArray(res?.content)) {
      return res.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    }
    return typeof res === 'string' ? res : JSON.stringify(res);
  }
}
