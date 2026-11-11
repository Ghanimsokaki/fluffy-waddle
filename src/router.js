// Task router: inspects the user's message and decides WHICH AI to use.
//  - 3D request        -> the built-in TRELLIS text-to-3D pipeline
//  - coding request    -> a free code-specialised model on OpenRouter
//  - reasoning request -> a free reasoning model on OpenRouter
//  - anything else     -> the default free chat model
// The user can always override this by picking a provider/model manually.

import { listOpenRouterFreeModels } from './providers.js';

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

// Preference order for each task. "openrouter/free" is OpenRouter's own router
// over healthy free models, so it is a reliable last resort.
const CODE_HINTS = ['north-mini-code', 'coder', 'coding', 'codestral', 'qwen', 'deepseek', 'openrouter/free'];
const REASON_HINTS = ['reasoning', 'nemotron', 'r1', 'qwq', 'openrouter/free'];
const CHAT_HINTS = ['openrouter/free', 'nemotron', 'liquid', 'flint', 'gemma', 'llama', 'qwen'];

function pickModel(models, hints) {
  if (!models?.length) return null;
  for (const h of hints) {
    const m = models.find((x) => x.id.toLowerCase().includes(h));
    if (m) return m.id;
  }
  return models[0].id;
}

// Returns the chosen route for the latest user message.
export async function routeRequest({ messages = [], forcedTask } = {}) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const task = forcedTask || classifyTask(text);

  let free = [];
  try { free = await listOpenRouterFreeModels(); } catch { free = []; }

  // A 3D request still needs a chat model to drive the tool call, but the actual
  // 3D work is done by the built-in TRELLIS tool.
  if (task === '3d') {
    const model = pickModel(free, CHAT_HINTS) || free[0]?.id || 'openrouter/free';
    return {
      task,
      provider: 'openrouter',
      model,
      tool: 'generate_3d_model',
      builtin: true,
      reason: '3D-model request detected → calling the TRELLIS text-to-3D tool to build the model.',
    };
  }

  if (task === 'code') {
    const model = pickModel(free, CODE_HINTS) || 'openrouter/free';
    return { task, provider: 'openrouter', model, reason: 'Coding intent → picked a free code-specialised model.' };
  }
  if (task === 'reasoning') {
    const model = pickModel(free, REASON_HINTS) || free[0]?.id || 'openrouter/free';
    return { task, provider: 'openrouter', model, reason: 'Reasoning intent → picked a free reasoning model.' };
  }

  const model = pickModel(free, CHAT_HINTS) || free[0]?.id || 'openrouter/free';
  return { task, provider: 'openrouter', model, reason: `General ${task} intent → default free model.` };
}
