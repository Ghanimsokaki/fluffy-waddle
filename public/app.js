// Frontend: model picker, streaming chat over SSE, and MCP server management.

const $ = (id) => document.getElementById(id);
const state = {
  provider: 'openrouter',
  model: '',
  servers: [],
  enabled: new Set(),
  messages: [],
  controller: null,
};

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Minimal, safe markdown: fenced code, inline code, bold, links, newlines.
function md(text) {
  const blocks = [];
  let out = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = out
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[i]);
}

// ---- data loading ---------------------------------------------------------
async function loadConfig() {
  const cfg = await (await fetch('/api/config')).json();
  state.provider = cfg.defaultProvider || 'openrouter';
  $('provider').value = state.provider;
  if (state.provider === 'huggingface') state.model = 'Hwiiiiiiii/Gemby-2-agent';
  else state.model = cfg.defaultModel || '';

  const keys = [];
  keys.push(cfg.hasHuggingFace ? '✔ Hugging Face key set' : '✖ Hugging Face key missing');
  keys.push(cfg.hasOpenRouter ? '✔ OpenRouter key set' : '✖ OpenRouter key missing');
  if (cfg.hasHfEndpoint) keys.push('✔ HF Inference Endpoint set');
  $('keyStatus').innerHTML = keys.join('<br>');
}

async function loadModels() {
  const sel = $('model');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const data = await (await fetch(`/api/models?provider=${state.provider}`)).json();
    const models = data.models || [];
    sel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      if (m.id === state.model) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!models.some((m) => m.id === state.model)) {
      const opt = document.createElement('option');
      opt.value = state.model;
      opt.textContent = state.model || '(none)';
      opt.selected = true;
      sel.prepend(opt);
    }
    if (data.warning) console.warn('model list warning:', data.warning);
    state.model = sel.value;
    $('activeModel').textContent = `${state.provider} · ${state.model}`;
  } catch (err) {
    sel.innerHTML = '<option value="">(could not load models)</option>';
  }
}

// ---- chat -----------------------------------------------------------------
function addMsg(role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="avatar">${role === 'user' ? 'You' : 'G'}</div><div class="bubble"></div>`;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el.querySelector('.bubble');
}

function toolChip(bubble, name, body, isErr) {
  const div = document.createElement('div');
  div.className = `tool${isErr ? ' err' : ''}`;
  div.innerHTML = `<b>${esc(name)}</b>\n${esc(body)}`;
  bubble.appendChild(div);
}

async function send() {
  const text = $('input').value.trim();
  if (!text || state.controller) return;
  $('input').value = '';
  $('input').style.height = 'auto';

  state.messages.push({ role: 'user', content: text });
  addMsg('user').innerHTML = md(text);

  const bubble = addMsg('assistant');
  bubble.classList.add('cursor');
  let answer = '';
  const controller = new AbortController();
  state.controller = controller;
  $('send').classList.add('hidden');
  $('stop').classList.remove('hidden');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        provider: state.provider,
        model: ($('customModel').value.trim() || state.model),
        messages: state.messages,
        mcpServers: [...state.enabled],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'delta') {
          answer += ev.text;
          bubble.innerHTML = md(answer);
          $('messages').scrollTop = $('messages').scrollHeight;
        } else if (ev.type === 'tool_start') {
          toolChip(bubble, `▸ ${ev.name}`, JSON.stringify(ev.args));
        } else if (ev.type === 'tool_result') {
          const body = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result);
          toolChip(bubble, `✓ ${ev.name}`, body.slice(0, 1500), !ev.ok);
        } else if (ev.type === 'error') {
          toolChip(bubble, '✖ error', ev.message, true);
        }
      }
    }
    if (answer) state.messages.push({ role: 'assistant', content: answer });
  } catch (err) {
    if (err.name !== 'AbortError') toolChip(bubble, '✖ error', String(err.message || err), true);
  } finally {
    bubble.classList.remove('cursor');
    state.controller = null;
    $('send').classList.remove('hidden');
    $('stop').classList.add('hidden');
  }
}

// ---- MCP servers ----------------------------------------------------------
async function loadServers() {
  state.servers = await (await fetch('/api/mcp/servers')).json();
  renderServers();
}

function renderServers() {
  const list = $('serverList');
  list.innerHTML = '';
  if (!state.servers.length) {
    list.innerHTML = '<p class="hint">No servers yet. Add one, e.g. command <code>npx</code> args <code>-y @modelcontextprotocol/server-everything</code>.</p>';
    return;
  }
  for (const s of state.servers) {
    const el = document.createElement('div');
    el.className = 'server';
    const checked = state.enabled.has(s.id) && s.connected;
    el.innerHTML = `
      <span class="dot ${s.connected ? 'on' : ''}"></span>
      <input type="checkbox" style="width:auto" ${checked ? 'checked' : ''} ${s.connected ? '' : 'disabled'} />
      <div class="grow">
        <div class="name">${esc(s.name)}</div>
        <div class="sub">${s.transport}${s.connected ? ` · ${s.toolCount} tool(s)` : ' · disconnected'}</div>
      </div>
      <button data-act="toggle">${s.connected ? 'Stop' : 'Start'}</button>
      <button data-act="del">✕</button>`;
    el.querySelector('input').onchange = (e) => {
      if (e.target.checked) state.enabled.add(s.id);
      else state.enabled.delete(s.id);
    };
    el.querySelector('[data-act="toggle"]').onclick = async () => {
      const act = s.connected ? 'disconnect' : 'connect';
      await fetch(`/api/mcp/servers/${s.id}/${act}`, { method: 'POST' });
      await loadServers();
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      await fetch(`/api/mcp/servers/${s.id}`, { method: 'DELETE' });
      state.enabled.delete(s.id);
      await loadServers();
    };
    list.appendChild(el);
  }
}

// ---- wiring ---------------------------------------------------------------
function wire() {
  $('provider').onchange = (e) => {
    state.provider = e.target.value;
    state.enabled.clear();
    if (state.provider === 'huggingface') state.model = 'Hwiiiiiiii/Gemby-2-agent';
    else state.model = '';
    $('customModel').value = '';
    $('activeModel').textContent = `${state.provider} · …`;
    loadModels();
  };

  $('model').onchange = (e) => {
    state.model = e.target.value;
    $('activeModel').textContent = `${state.provider} · ${state.model}`;
  };

  $('refresh').onclick = loadModels;
  $('customModel').oninput = (e) => {
    if (e.target.value.trim()) $('activeModel').textContent = `${state.provider} · ${e.target.value.trim()} (custom)`;
  };

  $('composer').onsubmit = (e) => { e.preventDefault(); send(); };
  $('stop').onclick = () => state.controller?.abort();
  $('clear').onclick = () => {
    state.messages = [];
    $('messages').innerHTML = '';
  };

  const input = $('input');
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  $('addServerToggle').onclick = () => $('serverForm').classList.toggle('hidden');
  $('sTransport').onchange = (e) => {
    const stdio = e.target.value === 'stdio';
    $('sCommand').classList.toggle('hidden', !stdio);
    $('sArgs').classList.toggle('hidden', !stdio);
    $('sUrl').classList.toggle('hidden', stdio);
  };
  $('serverForm').onsubmit = async (e) => {
    e.preventDefault();
    const transport = $('sTransport').value;
    const body = { name: $('sName').value.trim(), transport };
    if (transport === 'stdio') {
      body.command = $('sCommand').value.trim();
      body.args = $('sArgs').value.trim().split(/\s+/).filter(Boolean);
    } else {
      body.url = $('sUrl').value.trim();
    }
    const res = await fetch('/api/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { alert((await res.json()).error || 'Could not save server'); return; }
    $('serverForm').reset();
    $('serverForm').classList.add('hidden');
    $('sTransport').onchange({ target: $('sTransport') });
    await loadServers();
  };
}

(async function init() {
  wire();
  $('sTransport').onchange({ target: $('sTransport') });
  try {
    await loadConfig();
    await Promise.all([loadModels(), loadServers()]);
    $('conn').textContent = 'ready';
  } catch (err) {
    $('conn').textContent = 'offline';
    console.error(err);
  }
})();
