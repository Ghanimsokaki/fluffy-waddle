// Built-in tools that are always available to the model (no MCP server needed).
// Currently: text-to-3D generation via TRELLIS.

import { generate3D } from './gen3d.js';

const NAMES = new Set(['generate_3d_model']);

export function builtinTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'generate_3d_model',
        description:
          'Generate a real 3D model (.glb) from a text description using the TRELLIS text-to-3D pipeline. '
          + 'Use this whenever the user asks to create/design/make a 3D model, a game asset, a mesh, or a Roblox model/part. '
          + 'Pass a rich, descriptive prompt.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Detailed description of the 3D object, e.g. "a low-poly red mushroom with a white spotted cap".',
            },
          },
          required: ['prompt'],
        },
      },
    },
  ];
}

export function isBuiltinTool(name) {
  return NAMES.has(name);
}

// Returns a plain-text result for the model and emits SSE progress/artifact events.
export async function callBuiltinTool(name, args, onEvent = () => {}) {
  if (name === 'generate_3d_model') {
    const r = await generate3D(args?.prompt, (text) => onEvent({ type: 'tool_progress', name, text }));
    onEvent({ type: 'tool_artifact', kind: '3d', name, url: r.url, file: r.file, bytes: r.bytes });
    const size = r.bytes ? ` (${Math.round(r.bytes / 1024)} KB)` : '';
    return `3D model generated with TRELLIS and saved to ${r.url}${size}.`;
  }
  throw new Error(`Unknown built-in tool: ${name}`);
}
