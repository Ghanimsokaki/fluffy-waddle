// Built-in tools that ship with the app (no MCP server needed):
//   * generate_3d_model - text-to-3D via TRELLIS
//   * generate_image    - text-to-image
//   * web_search        - search the web (DuckDuckGo, no key)
//   * fetch_url         - read a web page as text
// Only the tools relevant to a request are sent, so chat models are not handed
// tool descriptions they do not need.

import { generate3D } from './gen3d.js';
import { generateImage } from './imagegen.js';
import { webSearch, fetchPage } from './search.js';

const NAMES = new Set(['generate_3d_model', 'generate_image', 'web_search', 'fetch_url']);

export function threeDTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'generate_3d_model',
        description:
          'Generate a real 3D model (.glb) from a text description. '
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

export function imageTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Generate a real image from a text description and show it to the user. '
          + 'Use this whenever the user asks to draw, generate, create, or make a picture, image, '
          + 'artwork, illustration, logo, icon, poster, wallpaper, or photo. Pass a rich, descriptive prompt.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
            size: {
              type: 'string',
              enum: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'],
              description: 'Aspect-ratio preset (default square_hd).',
            },
          },
          required: ['prompt'],
        },
      },
    },
  ];
}

export function webTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the web and return the top results (title, url, snippet). '
          + 'Use it for recent news, current facts, prices, or anything you are unsure about. '
          + 'Follow up with fetch_url to read a promising page in full.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            max: { type: 'integer', description: 'How many results to return (default 5, max 8).' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Download a web page and return its readable text with the HTML stripped. Use it to read a page found via web_search.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
          required: ['url'],
        },
      },
    },
  ];
}

export function builtinTools({ web = false, threeD = false, image = false } = {}) {
  return [...(web ? webTools() : []), ...(threeD ? threeDTools() : []), ...(image ? imageTools() : [])];
}

export function isBuiltinTool(name) {
  return NAMES.has(name);
}

// Returns a plain-text result for the model and emits SSE progress events.
export async function callBuiltinTool(name, args, onEvent = () => {}) {
  if (name === 'generate_3d_model') {
    const r = await generate3D(args?.prompt, (text) => onEvent({ type: 'tool_progress', name, text }));
    onEvent({ type: 'tool_artifact', kind: '3d', name, url: r.url, file: r.file, bytes: r.bytes });
    const size = r.bytes ? ` (${Math.round(r.bytes / 1024)} KB)` : '';
    return `3D model generated with TRELLIS and saved to ${r.url}${size}.`;
  }

  if (name === 'generate_image') {
    const size = typeof args?.size === 'string' ? args.size : 'square_hd';
    const r = await generateImage(args?.prompt, size);
    onEvent({ type: 'tool_artifact', kind: 'image', name, url: r.url, file: r.file, bytes: r.bytes, prompt: r.prompt });
    const size2 = r.bytes ? ` (${Math.round(r.bytes / 1024)} KB)` : '';
    return `Image generated and saved to ${r.url}${size2}. Show the user the image.`;
  }

  if (name === 'web_search') {
    const q = String(args?.query || '').trim();
    onEvent({ type: 'tool_progress', name, text: `Searching the web for "${q}"…` });
    const results = await webSearch(q, args?.max);
    if (!results.length) return `No web results found for "${q}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  }

  if (name === 'fetch_url') {
    const url = String(args?.url || '').trim();
    onEvent({ type: 'tool_progress', name, text: `Reading ${url}…` });
    const text = await fetchPage(url);
    return text || 'That page had no readable text.';
  }

  throw new Error(`Unknown built-in tool: ${name}`);
}
