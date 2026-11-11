// Frontend: model picker, streaming chat over SSE, and MCP server management.

const $ = (id) => document.getElementById(id);
let closeNav = () => {};
const state = {
  // 'auto' (router picks per message) or `${provider}|${modelId}`.
  selection: 'auto',
  modelList: [],
  // saved conversations
  chats: [],
  currentId: null,
  servers: [],
  enabled: new Set(),
  messages: [],
  attachments: [], // { name, dataUrl } images waiting to be sent
  speak: false,    // read assistant replies aloud
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
  // Default to Auto unless the server pins a specific provider+model.
  state.selection = cfg.defaultProvider && cfg.defaultProvider !== 'auto' && cfg.defaultModel
    ? `${cfg.defaultProvider}|${cfg.defaultModel}`
    : 'auto';

  const keys = [];
  keys.push(cfg.hasHuggingFace ? '✔ Hugging Face key set' : '✖ Hugging Face key missing');
  keys.push(cfg.hasOpenRouter ? '✔ OpenRouter key set' : '✖ OpenRouter key missing');
  keys.push(cfg.hasNvidia ? '✔ NVIDIA NIM key set' : '✖ NVIDIA NIM key missing');
  if (cfg.hasHfEndpoint) keys.push('✔ HF Inference Endpoint set');
  keys.push(cfg.hasTrellis ? '✔ TRELLIS 3D ready' : '✖ TRELLIS 3D needs HF_TOKEN');
  $('keyStatus').innerHTML = keys.join('<br>');
  syncModelUI();
}

function syncModelUI() {
  const auto = state.selection === 'auto';
  $('routeHint').classList.toggle('hidden', !auto);
  $('routePool').classList.toggle('hidden', !auto);
}

function updateActiveModel() {
  if (state.selection === 'auto') {
    $('activeModel').textContent = 'Auto · router picks the model for the job';
    return;
  }
  $('activeModel').textContent = state.selection.split('|').slice(1).join('|');
}

// The models the auto-router can choose from.
async function loadRoutePool() {
  try {
    const { models } = await (await fetch('/api/route/models')).json();
    $('routePoolCount').textContent = `${models.length} models`;
    const list = $('routePoolList');
    list.innerHTML = '';
    for (const m of models) {
      const el = document.createElement('div');
      el.className = 'm';
      el.innerHTML = `<span class="id">${esc(m.id)}</span>`;
      list.appendChild(el);
    }
  } catch { $('routePoolCount').textContent = 'unavailable'; }
}

// One flat list: "Auto" first, then every model. No provider picker.
async function loadModels() {
  const sel = $('model');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const data = await (await fetch('/api/models')).json();
    state.modelList = data.models || [];
    sel.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Auto — pick the model for the job';
    sel.appendChild(autoOpt);
    for (const m of state.modelList) {
      const opt = document.createElement('option');
      opt.value = `${m.provider}|${m.id}`;
      opt.textContent = m.name || m.id;
      sel.appendChild(opt);
    }
    sel.value = state.selection;
    if (sel.value !== state.selection) sel.value = 'auto';
    state.selection = sel.value;
    if (data.warning) console.warn('model list warning:', data.warning);
    updateActiveModel();
  } catch (err) {
    sel.innerHTML = '<option value="auto">Auto</option>';
  }
}

// ---- chat sessions (saved in the browser) ---------------------------------
const CHAT_KEY = 'gemby.chats.v1';
let WELCOME = '';

function loadChats() {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    state.chats = raw ? JSON.parse(raw) : [];
  } catch { state.chats = []; }
  if (!Array.isArray(state.chats)) state.chats = [];
}

function persistChats() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(state.chats)); } catch { /* storage full or blocked */ }
}

function currentChat() {
  return state.chats.find((c) => c.id === state.currentId) || null;
}

function renderChats() {
  const list = $('chatList');
  list.innerHTML = '';
  if (!state.chats.length) {
    list.innerHTML = '<p class="hint">No chats yet.</p>';
    return;
  }
  for (const c of state.chats) {
    const el = document.createElement('div');
    el.className = `chat-item${c.id === state.currentId ? ' active' : ''}`;
    el.innerHTML = `<span class="t">${esc(c.title || 'New chat')}</span><button title="Delete">✕</button>`;
    el.onclick = (e) => { if (e.target.tagName !== 'BUTTON') openChat(c.id); };
    el.ondblclick = () => {
      const t = prompt('Rename chat', c.title || '');
      if (t && t.trim()) { c.title = t.trim(); persistChats(); renderChats(); }
    };
    el.querySelector('button').onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    list.appendChild(el);
  }
}

// Mirror the live conversation into the saved session, and title it from the
// first user message.
function syncCurrentChat() {
  const c = currentChat();
  if (!c) return;
  c.messages = state.messages.slice();
  const first = state.messages.find((m) => m.role === 'user');
  if (first && (!c.title || c.title === 'New chat')) {
    c.title = String(first.content).replace(/\s+/g, ' ').slice(0, 42) || 'New chat';
  }
  c.at = Date.now();
  persistChats();
  renderChats();
}

// Redraw the message pane from state.messages.
function paint() {
  const box = $('messages');
  box.innerHTML = state.messages.length ? '' : WELCOME;
  for (const m of state.messages) {
    if (m.role === 'user') renderUser(addMsg('user'), m.content);
    else if (m.role === 'assistant') addMsg('assistant').innerHTML = md(String(m.content));
  }
  box.scrollTop = box.scrollHeight;
}

function newChat() {
  const chat = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: 'New chat', at: Date.now(), messages: [] };
  state.chats.unshift(chat);
  state.currentId = chat.id;
  state.messages = [];
  persistChats();
  renderChats();
  paint();
  $('input').focus();
}

function openChat(id) {
  const c = state.chats.find((x) => x.id === id);
  if (!c) return;
  state.currentId = id;
  state.messages = Array.isArray(c.messages) ? c.messages.slice() : [];
  renderChats();
  paint();
  closeNav();
}

function deleteChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  persistChats();
  if (state.currentId === id) {
    if (state.chats.length) openChat(state.chats[0].id);
    else newChat();
  } else {
    renderChats();
  }
}

// ---- chat -----------------------------------------------------------------
// Flatten OpenAI-style content (string or parts array) to its text.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n');
  return '';
}

// Draw a user message: any attached images, then the text.
function renderUser(bubble, content) {
  bubble.innerHTML = '';
  const imgs = Array.isArray(content) ? content.filter((p) => p?.type === 'image_url' && p.image_url?.url) : [];
  for (const p of imgs) {
    const img = document.createElement('img');
    img.className = 'attached';
    img.src = p.image_url.url;
    bubble.appendChild(img);
  }
  const text = contentText(content);
  if (text) {
    const div = document.createElement('div');
    div.innerHTML = md(text);
    bubble.appendChild(div);
  }
}

// Downscale an image file to a JPEG data URL (keeps requests and storage small).
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.classList.toggle('hidden', state.attachments.length === 0);
  state.attachments.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'att';
    el.innerHTML = `<img src="${a.dataUrl}" alt="attachment" /><button title="Remove">✕</button>`;
    el.querySelector('button').onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(el);
  });
}

async function addImageFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      state.attachments.push({ name: f.name, dataUrl: await fileToDataUrl(f) });
    } catch (err) { alert(String(err.message || err)); }
  }
  renderAttachments();
}

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
  const images = state.attachments.slice();
  if ((!text && !images.length) || state.controller) return;
  $('input').value = '';
  $('input').style.height = 'auto';

  // With images attached, send the OpenAI multi-part content form.
  const content = images.length
    ? [
      ...(text ? [{ type: 'text', text }] : []),
      ...images.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } })),
    ]
    : text;

  state.messages.push({ role: 'user', content });
  renderUser(addMsg('user'), content);
  state.attachments = [];
  renderAttachments();
  syncCurrentChat();

  const bubble = addMsg('assistant');
  bubble.classList.add('cursor');
  let answer = '';
  let progressEl = null;
  const controller = new AbortController();
  state.controller = controller;
  $('send').classList.add('hidden');
  $('stop').classList.remove('hidden');

  try {
    // Resolve the picker into a concrete provider + model for the server.
    const custom = $('customModel').value.trim();
    let provider;
    let model;
    if (custom) {
      provider = 'openrouter'; // typed ids default to OpenRouter
      model = custom;
    } else if (state.selection === 'auto') {
      provider = 'auto';
      model = '';
    } else {
      const [p, ...rest] = state.selection.split('|');
      provider = p;
      model = rest.join('|');
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        provider,
        model,
        messages: state.messages,
        mcpServers: [...state.enabled],
        web: $('webToggle').checked,
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
        } else if (ev.type === 'route') {
          progressEl = null;
          toolChip(bubble, `🧭 router → ${ev.model || ev.provider} [${ev.task}]`, ev.reason || '');
        } else if (ev.type === 'tool_start') {
          progressEl = null;
          toolChip(bubble, `▸ ${ev.name}`, JSON.stringify(ev.args));
        } else if (ev.type === 'tool_progress') {
          if (!progressEl) {
            progressEl = document.createElement('div');
            progressEl.className = 'tool progress';
            bubble.appendChild(progressEl);
          }
          progressEl.innerHTML = `<b>… ${esc(ev.name)}</b>\n${esc(ev.text)}`;
          $('messages').scrollTop = $('messages').scrollHeight;
        } else if (ev.type === 'tool_result') {
          progressEl = null;
          const body = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result);
          toolChip(bubble, `✓ ${ev.name}`, body.slice(0, 1500), !ev.ok);
        } else if (ev.type === 'tool_artifact' && ev.url) {
          progressEl = null;
          const wrap = document.createElement('div');
          wrap.className = 'artifact';
          if (ev.kind === 'image') {
            const kb = ev.bytes ? ` (${Math.round(ev.bytes / 1024)} KB)` : '';
            wrap.innerHTML = `<div class="sub">Image generated</div>
              <img class="gen-img" src="${ev.url}" alt="${esc(ev.prompt || 'generated image')}" />
              <a href="${ev.url}" download="${esc(ev.file || 'image.jpg')}" target="_blank" rel="noopener">⬇ Download ${esc(ev.file || 'image.jpg')}${kb}</a>`;
          } else {
            wrap.innerHTML = `<div class="sub">3D model generated by TRELLIS</div>
              <a href="${ev.url}" download="${esc(ev.file || '')}" target="_blank" rel="noopener">⬇ Download ${esc(ev.file || 'model.glb')} (${Math.round((ev.bytes || 0) / 1024)} KB)</a>
              <model-viewer src="${ev.url}" camera-controls auto-rotate style="width:100%;height:280px;margin-top:8px;background:#0e1116;border-radius:10px"></model-viewer>`;
          }
          bubble.appendChild(wrap);
          $('messages').scrollTop = $('messages').scrollHeight;
        } else if (ev.type === 'error') {
          toolChip(bubble, '✖ error', ev.message, true);
        }
      }
    }
    if (answer) state.messages.push({ role: 'assistant', content: answer });
    syncCurrentChat();
    if (state.speak && answer) speak(answer);
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

// One-click ready-made servers (Roblox Studio, demo, …).
async function loadPresets() {
  const box = $('presets');
  try {
    const presets = await (await fetch('/api/mcp/presets')).json();
    box.innerHTML = '';
    for (const p of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini preset';
      b.textContent = `+ ${p.name}`;
      b.title = p.hint || '';
      b.onclick = async () => {
        const res = await fetch('/api/mcp/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: p.name, transport: p.transport, command: p.command, args: p.args }),
        });
        if (!res.ok) { alert((await res.json()).error || 'Could not add preset'); return; }
        await loadServers();
      };
      box.appendChild(b);
    }
  } catch { box.innerHTML = ''; }
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

// ---- voice (Web Speech API) ----------------------------------------------
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;

  if (SR) {
    recog = new SR();
    recog.lang = navigator.language || 'en-US';
    recog.interimResults = false;
    recog.continuous = false;
    recog.onresult = (e) => {
      const phrase = [...e.results].map((r) => r[0].transcript).join(' ');
      const input = $('input');
      input.value = `${input.value} ${phrase}`.trim();
      input.focus();
    };
    recog.onerror = () => $('micBtn').classList.remove('rec');
    recog.onend = () => $('micBtn').classList.remove('rec');
  } else {
    $('micBtn').disabled = true;
    $('micBtn').title = 'Voice input is not supported in this browser';
  }

  $('micBtn').onclick = () => {
    if (!recog) return;
    if ($('micBtn').classList.contains('rec')) { recog.stop(); return; }
    $('micBtn').classList.add('rec');
    try { recog.start(); } catch { $('micBtn').classList.remove('rec'); }
  };

  if (!('speechSynthesis' in window)) $('speakBtn').disabled = true;
  $('speakBtn').onclick = () => {
    state.speak = !state.speak;
    $('speakBtn').classList.toggle('on', state.speak);
    if (!state.speak) window.speechSynthesis?.cancel();
  };
}

// ---- wiring ---------------------------------------------------------------
function wire() {
  $('model').onchange = (e) => {
    state.selection = e.target.value;
    $('customModel').value = '';
    syncModelUI();
    updateActiveModel();
  };

  $('refresh').onclick = loadModels;
  $('customModel').oninput = (e) => {
    const v = e.target.value.trim();
    if (v) $('activeModel').textContent = `${v} (custom)`;
    else updateActiveModel();
  };

  $('composer').onsubmit = (e) => { e.preventDefault(); send(); };
  $('stop').onclick = () => state.controller?.abort();
  $('newChat').onclick = () => { newChat(); closeNav(); };
  $('clear').onclick = () => { newChat(); closeNav(); };

  // image attachments (button or paste)
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { addImageFiles(e.target.files); e.target.value = ''; };
  $('input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  });

  // mobile: slide-out settings drawer
  const appEl = document.querySelector('.app');
  const setNav = (open) => {
    appEl.classList.toggle('nav-open', open);
    $('backdrop').classList.toggle('show', open);
  };
  closeNav = setNav;
  $('menuBtn').onclick = () => setNav(!appEl.classList.contains('nav-open'));
  $('backdrop').onclick = () => setNav(false);
  window.matchMedia('(min-width: 769px)').addEventListener('change', (e) => { if (e.matches) setNav(false); });

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
  setupVoice();
  $('sTransport').onchange({ target: $('sTransport') });

  // restore saved chats (newest first) or start a fresh one
  WELCOME = document.querySelector('.welcome')?.outerHTML || '';
  loadChats();
  state.chats.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (state.chats.length) openChat(state.chats[0].id);
  else newChat();

  try {
    await loadConfig();
    await Promise.all([loadModels(), loadServers(), loadPresets(), loadRoutePool()]);
    $('conn').textContent = 'ready';
  } catch (err) {
    $('conn').textContent = 'offline';
    console.error(err);
  }
})();
