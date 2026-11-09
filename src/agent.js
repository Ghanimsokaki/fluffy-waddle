// Agent loop: streams the model's answer and, when the model asks to call tools
// (MCP tools exposed as OpenAI functions), executes them and feeds results back.

import { streamChat } from './providers.js';

const MAX_STEPS = 6;

export async function runAgent({ provider, model, messages, tools, signal, callTool, onEvent }) {
  const convo = [...messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    const pending = new Map();
    let assistantText = '';

    for await (const delta of streamChat({ provider, model, messages: convo, tools, signal })) {
      if (delta.content) {
        assistantText += delta.content;
        onEvent({ type: 'delta', text: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        const cur = pending.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        pending.set(idx, cur);
      }
    }

    if (pending.size === 0) return assistantText; // final answer, nothing to execute

    const calls = [...pending.values()];
    convo.push({ role: 'assistant', content: assistantText || null, tool_calls: calls });

    for (const call of calls) {
      let args = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* leave as {} */ }
      onEvent({ type: 'tool_start', name: call.function.name, args });
      let result;
      let ok = true;
      try {
        result = await callTool(call.function.name, args);
      } catch (err) {
        ok = false;
        result = { error: String(err?.message || err) };
      }
      onEvent({ type: 'tool_result', name: call.function.name, ok, result });
      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  onEvent({ type: 'delta', text: '\n\n(stopped: reached the maximum number of tool steps)' });
  return '';
}
