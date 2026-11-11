// Text-to-3D via the Microsoft TRELLIS NIM hosted by NVIDIA.
// Nothing heavy runs on this server - NVIDIA runs the model; we just send the
// prompt and store the returned .glb mesh.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ENDPOINT = process.env.NVIDIA_TRELLIS_URL || 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';
const OUT_DIR = process.env.TRELLIS_OUT_DIR || path.resolve(process.cwd(), 'public', 'generated');
const TRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  return process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '';
}

// NVIDIA's trial TRELLIS endpoint occasionally answers 500 on a first hit
// (cold start / GPU busy). Retry a couple of times before giving up.
async function infer(prompt) {
  if (!apiKey()) throw new Error('NVIDIA_API_KEY is not set, so the 3D model cannot be generated.');
  let lastErr;
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt, seed: 0 }),
    });

    if (res.ok) {
      const json = await res.json();
      const b64 = json?.artifacts?.[0]?.base64;
      if (!b64) throw new Error('TRELLIS returned no 3D asset.');
      return Buffer.from(b64, 'base64');
    }

    const body = await res.text().catch(() => '');
    lastErr = new Error(`TRELLIS NIM responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    if (res.status < 500) throw lastErr;          // 4xx won't fix itself
    if (attempt < TRIES) await sleep(1500 * attempt);
  }
  throw lastErr;
}

export async function generate3D(prompt, onProgress = () => {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Describe the 3D object you want to build.');

  onProgress(`Sending the prompt to NVIDIA TRELLIS (${ENDPOINT.replace(/^https?:\/\//, '')})`);
  onProgress('Generating the 3D mesh — this usually takes 20-60 seconds');
  const buf = await infer(text);
  onProgress(`Mesh ready (${Math.round(buf.length / 1024)} KB)`);

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const name = `${randomUUID().slice(0, 8)}.glb`;
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    onProgress(`Saved ${name}`);
    return { prompt: text, engine: 'nvidia-nim-trellis', file: name, url: `/generated/${name}`, bytes: buf.length };
  } catch {
    // Read-only filesystem (e.g. Vercel): hand the mesh back as a data URL.
    onProgress('Local storage unavailable — returning the model inline');
    return {
      prompt: text,
      engine: 'nvidia-nim-trellis',
      file: 'model.glb',
      url: `data:model/gltf-binary;base64,${buf.toString('base64')}`,
      bytes: buf.length,
    };
  }
}
