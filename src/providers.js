// Provider layer: talks to Hugging Face's OpenAI-compatible router and to OpenRouter.
// All API keys stay on the server (read from .env) and are never sent to the browser.

const HF_BASE = () => process.env.HF_BASE_URL || 'https://router.huggingface.co/v1';
const OR_BASE = () => process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const NIM_BASE = () => process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';

export function providerConfig(provider) {
  if (provider === 'huggingface') {
    // A dedicated Inference Endpoint (OpenAI-compatible /v1) takes priority over the
    // shared router - this is how you serve a model the router will not host.
    const endpoint = process.env.HF_ENDPOINT_URL;
    return {
      name: 'huggingface',
      label: 'Hugging Face',
      baseUrl: endpoint ? endpoint.replace(/\/+$/, '') : HF_BASE(),
      apiKey: process.env.HF_TOKEN || '',
      endpoint: !!endpoint,
    };
  }
  if (provider === 'openrouter') {
    return { name: 'openrouter', label: 'OpenRouter', baseUrl: OR_BASE(), apiKey: process.env.OPENROUTER_API_KEY || '' };
  }
  if (provider === 'nvidia') {
    return { name: 'nvidia', label: 'NVIDIA NIM', baseUrl: NIM_BASE(), apiKey: process.env.NVIDIA_API_KEY || '' };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// Models published by the author of Gemby-2-agent, plus a few widely available chat models.
export const HF_CURATED_MODELS = [
  { id: 'Hwiiiiiiii/Gemby-2-agent', name: 'Gemby-2-agent (author, experimental)', note: 'Not served by HF serverless inference yet' },
  { id: 'Hwiiiiiiii/gemby.v1', name: 'Gemby v1 (Qwen2.5-0.5B fine-tune)' },
  { id: 'Hwiiiiiiii/gemby', name: 'Gemby (base)' },
  { id: 'Hwiiiiiiii/gemby-1B-2026', name: 'Gemby-1B-2026' },
  { id: 'Hwiiiiiiii/Gemby-14B-instruct', name: 'Gemby-14B-instruct (private)' },
  { id: 'Ghanimtta/Gemby.45.omni', name: 'Gemby.45.omni' },
  { id: 'meta-llama/Llama-3.2-3B-Instruct', name: 'Llama 3.2 3B Instruct' },
  { id: 'google/gemma-3-4b-it', name: 'Gemma 3 4B IT' },
  { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5 7B Instruct' },
  { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B Instruct v0.3' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', name: 'DeepSeek-R1 Distill Qwen 7B' },
].map((m) => ({ ...m, provider: 'huggingface' }));

const FREE_FALLBACK = [
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B IT (free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (free)' },
  { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek Chat v3 (free)' },
  { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen2.5 72B Instruct (free)' },
  { id: 'mistralai/mistral-small-3.2-24b-instruct:free', name: 'Mistral Small 3.2 24B (free)' },
].map((m) => ({ ...m, provider: 'openrouter' }));

let orCache = { at: 0, models: null };

export async function listOpenRouterFreeModels() {
  const now = Date.now();
  if (orCache.models && now - orCache.at < 10 * 60 * 1000) return orCache.models;
  const res = await fetch(`${OR_BASE()}/models`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = await res.json();
  const isFree = (v) => v === '0' || v === '0.0' || v === '0.00' || v === 0;
  // Keep only text-output models (drops audio/music entries that are also priced 0).
  const isTextOut = (m) => {
    const out = m.architecture?.output_modalities;
    return !out || (out.includes('text') && out.every((x) => x === 'text'));
  };
  const models = (data.data || [])
    .filter((m) => isFree(m.pricing?.prompt) && isFree(m.pricing?.completion) && isTextOut(m))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      provider: 'openrouter',
      contextLength: m.context_length || m.top_provider?.context_length,
      // Accepts image input -> eligible to handle uploaded images.
      vision: (m.architecture?.input_modalities || []).includes('image'),
      free: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  orCache = { at: now, models };
  return models;
}

export function openRouterFallback() {
  return FREE_FALLBACK;
}

// ---------------------------------------------------------------------------
// NVIDIA NIM (https://build.nvidia.com) - OpenAI-compatible at /v1.
// The catalogue is public; only inference calls need NVIDIA_API_KEY.
//
// Caveat: the public catalogue lists ~84 models, but an API key can only call
// the ones enabled for that account - the rest return 404/410. So we keep an
// allowlist of models VERIFIED to work with the configured key, and only route
// to those. Add an id here once NVIDIA enables it for your account.
// ---------------------------------------------------------------------------
const NIM_USABLE = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
  { id: 'nvidia/nemotron-3.5-bolt-e4b' },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', vision: true },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' },
].map((m) => ({ name: m.id.split('/').pop(), provider: 'nvidia', ...m }));

let nimCache = { at: 0, models: null };

export async function listNvidiaModels() {
  const now = Date.now();
  if (nimCache.models && now - nimCache.at < 10 * 60 * 1000) return nimCache.models;
  try {
    const res = await fetch(`${NIM_BASE()}/models`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      const live = new Set((data.data || data.models || []).map((m) => m.id));
      // Only offer allow-listed models that still exist in the live catalogue.
      const models = NIM_USABLE.filter((m) => live.has(m.id));
      if (models.length) { nimCache = { at: now, models }; return models; }
    }
  } catch { /* offline - fall through to the allowlist */ }
  nimCache = { at: now, models: NIM_USABLE };
  return NIM_USABLE;
}

export function nvidiaFallback() {
  return NIM_USABLE;
}

// Streaming chat completion. Yields raw OpenAI-style `delta` objects.
export async function* streamChat({ provider, model, messages, tools, signal }) {
  const cfg = providerConfig(provider);
  const body = { model, messages, stream: true };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.name === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'Gemby AI Web';
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(`${cfg.label} error ${res.status}: ${msg}`.slice(0, 500));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content || delta.tool_calls) yield delta;
    }
  }
}
