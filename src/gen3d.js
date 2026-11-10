// Text-to-3D via the TRELLIS.2 Space on Hugging Face.
// Runs remotely on a (ZeroGPU) Space - nothing heavy runs on this server.
// IMPORTANT: a Hugging Face token is required. Anonymous callers are capped to a
// short GPU duration and the Space rejects the run; a signed-in token is allowed
// the Space's full duration.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@gradio/client';

const SPACE = process.env.TRELLIS_SPACE || 'prithivMLmods/TRELLIS.2-Text-to-3D';
const OUT_DIR = process.env.TRELLIS_OUT_DIR || path.resolve(process.cwd(), 'public', 'generated');

const DEFAULT_3D = {
  seed: 0,
  resolution: '1024',
  decimation_target: 150000,
  texture_size: 1024,
  ss_guidance_strength: 7.5,
  ss_guidance_rescale: 0.7,
  ss_sampling_steps: 12,
  ss_rescale_t: 5.0,
  shape_guidance: 7.5,
  shape_rescale: 0.5,
  shape_steps: 12,
  shape_rescale_t: 3.0,
  tex_guidance: 1.0,
  tex_rescale: 0.0,
  tex_steps: 12,
  tex_rescale_t: 3.0,
};

// Human-friendly message for the common ZeroGPU quota failures.
function friendly(err) {
  const msg = String(err?.message || err);
  if (/ZeroGPU quota/i.test(msg)) {
    return 'TRELLIS could not run: the free Hugging Face ZeroGPU quota for today is used up '
      + '(one TRELLIS generation needs ~240s of GPU time). It resets daily; Hugging Face PRO raises the limit. '
      + 'Original error: ' + msg;
  }
  if (/GPU duration|ZeroGPU|subscribe to Hugging Face PRO/i.test(msg)) {
    return 'TRELLIS is a ZeroGPU Space, so it needs an authenticated Hugging Face token with available GPU quota. '
      + 'Make sure HF_TOKEN is set (and open the Space once and click "Sign in"). Original error: ' + msg;
  }
  return msg;
}

async function saveRemote(url, ext) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = `${randomUUID().slice(0, 8)}${ext}`;
  fs.writeFileSync(path.join(OUT_DIR, name), buf);
  return { name, bytes: buf.length, url: `/generated/${name}` };
}

export async function generate3D(prompt, onProgress = () => {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('generate3D needs a text prompt');
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;

  onProgress(`Connecting to TRELLIS Space: ${SPACE}`);
  const opts = token ? { token } : {}; // @gradio/client v2 renamed hf_token -> token
  const client = await Client.connect(SPACE, opts);

  try {
    onProgress('Starting GPU session');
    await client.predict('/start_session', {});

    onProgress('Generating a concept image from your prompt');
    const img = await client.predict('/generate_txt2img', { prompt: String(prompt) });
    const imageUrl = img.data?.[0];
    if (!imageUrl) throw new Error('TRELLIS did not return an image');

    onProgress('Pre-processing the image');
    const pre = await client.predict('/preprocess_image', { input: imageUrl });
    const processed = pre.data?.[0] || imageUrl;

    onProgress('Building the 3D mesh (this usually takes 1-2 minutes)');
    const out = await client.predict('/generate_3d', { image: processed, ...DEFAULT_3D });
    const files = out.data?.[0];
    const list = Array.isArray(files) ? files : [files];
    const meshUrl = list.find((f) => typeof f === 'string' && /\.(glb|gltf)$/i.test(f))
      || list.find((f) => typeof f === 'string');
    if (!meshUrl) throw new Error('TRELLIS did not return a 3D file');

    onProgress('Saving the model');
    const ext = /\.gltf$/i.test(meshUrl) ? '.gltf' : '.glb';
    try {
      const saved = await saveRemote(meshUrl, ext);
      onProgress(`Saved ${saved.name} (${Math.round(saved.bytes / 1024)} KB)`);
      return { prompt, space: SPACE, file: saved.name, url: saved.url, bytes: saved.bytes };
    } catch (saveErr) {
      // Read-only filesystem (e.g. Vercel): hand back the hosted file link directly.
      onProgress('Local storage unavailable — returning the hosted file link');
      return { prompt, space: SPACE, file: meshUrl.split('/').pop() || `model${ext}`, url: meshUrl, bytes: null };
    }
  } catch (err) {
    throw new Error(friendly(err));
  }
}
