// Task router: inspects the user's message and decides WHICH AI to use.
//  - 3D request        -> the built-in TRELLIS text-to-3D pipeline
//  - coding request    -> a code-specialised model
//  - reasoning request -> a reasoning model
//  - anything else     -> a general chat model
//
// The pool of candidate AIs is a LIST drawn from BOTH providers:
//   * OpenRouter  (every free text model, live-fetched)
//   * NVIDIA NIM  (used when NVIDIA_API_KEY is set)
// So a single "Auto" choice can route across either provider. The user can
// always override the router by picking a provider/model manually.

import { listOpenRouterFreeModels, listNvidiaModels } from './providers.js';

const RULES = [
  { task: '3d', re: /\b(3d|three[- ]?d|mesh|glb|gltf|\.obj|sculpt|trellis|voxel|low[- ]?poly|game ?assets?|game ?models?|roblox ?(part|model|mesh|asset)s?|stl)\b/i },
  { task: 'code', re: /\b(code|coding|program|function|method|class|debug|bug|refactor|script|api|endpoint|regex|sql|query|bash|shell|python|javascript|typescript|java|c\+\+|rust|golang|html|css|react|vue|node|compile|error|exception|stack ?trace|parse|algorithm|leetcode)\b/i },
  { task: 'reasoning', re: /\b(prove|derive|solve|calculate|math|equation|logic|reason|why|analy[sz]e|step by step|think through)\b/i },
  { task: 'creative', re: /\b(story|poem|essay|letter|blog|caption|song|lyric|joke|screenplay|write me)\b/i },
];

export function classifyTask(text = '') {
  for (const r of RULES) if (r.re.test(text)) return r.task;
  return 'chat';
}

// The list of AIs the auto-router may choose from. OpenRouter free models come
// first, then NVIDIA NIM models (only if a key is configured, since calls to
// NIM need one). Failures are swallowed so one provider being down is fine.
export async function routerPool() {
  const pool = [];
  try { pool.push(...await listOpenRouterFreeModels()); } catch { /* provider offline */ }
  if (process.env.NVIDIA_API_KEY) {
    try { pool.push(...await listNvidiaModels()); } catch { /* provider offline */ }
  }
  return pool;
}

// Per-task preference plan. Each step optionally pins a provider and matches a
// substring of the model id, so the same model name on both providers can be
// told apart (e.g. "nemotron-3.5-lightning" exists on both OpenRouter and NIM).
const PLAN = {
  code: [
    { provider: 'openrouter', id: 'north-mini-code' },
    { id: 'coder' },
    { id: 'codestral' },
    { id: 'deepseek' },
    { id: 'qwen' },
  ],
  reasoning: [
    { provider: 'nvidia', id: 'nemotron-3-nano-omni' },
    { id: 'reasoning' },
    { id: 'r1' },
    { id: 'qwq' },
  ],
  chat: [
    { provider: 'nvidia', id: 'nemotron-3.5-lightning' },
    { id: 'nemotron' },
    { id: 'llama' },
    { id: 'qwen' },
    { id: 'gemma' },
  ],
  creative: [
    { id: 'gemma' },
    { id: 'llama' },
    { id: 'qwen' },
  ],
};

function pick(pool, task) {
  const plan = PLAN[task] || PLAN.chat;
  for (const step of plan) {
    const m = pool.find((x) => (!step.provider || x.provider === step.provider) && x.id.toLowerCase().includes(step.id));
    if (m) return m;
  }
  // Nothing matched: fall back to OpenRouter's own healthy free router.
  return pool.find((x) => x.id === 'openrouter/free') || pool[0] || null;
}

// Returns the chosen route for the latest user message.
export async function routeRequest({ messages = [], forcedTask } = {}) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const task = forcedTask || classifyTask(text);

  const pool = await routerPool();

  // A 3D request still needs a chat model to drive the tool call, but the actual
  // 3D work is done by the built-in TRELLIS tool.
  if (task === '3d') {
    const m = pick(pool, 'chat');
    return {
      task,
      provider: m?.provider || 'openrouter',
      model: m?.id || 'openrouter/free',
      tool: 'generate_3d_model',
      builtin: true,
      reason: '3D-model request detected → calling the TRELLIS text-to-3D tool to build the model.',
    };
  }

  const m = pick(pool, task);
  const provider = m?.provider || 'openrouter';
  const model = m?.id || 'openrouter/free';

  const why = {
    code: 'Coding intent → picked a code-specialised model.',
    reasoning: 'Reasoning intent → picked a reasoning model.',
    creative: 'Creative intent → picked a general model.',
    chat: 'General chat intent → picked a general model.',
  }[task] || 'Picked a general model.';

  return { task, provider, model, reason: `${why} (from ${provider})` };
}
