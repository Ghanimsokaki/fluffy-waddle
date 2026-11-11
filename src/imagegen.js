// Text-to-image generation. Keyless: uses Pollinations (real per-prompt
// generation) and falls back to the Trae image endpoint if it is unavailable.
// The result is saved under public/generated so the browser can show and
// download it.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const OUT_DIR = process.env.IMAGE_OUT_DIR || path.resolve(process.cwd(), 'public', 'generated');

const SIZE_PX = {
  square_hd: [1024, 1024],
  square: [768, 768],
  portrait_4_3: [768, 1024],
  portrait_16_9: [720, 1280],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1280, 720],
};

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image service returned ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`image service returned ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('image service returned an empty image');
  return buf;
}

function pollinations(prompt, size) {
  const [w, h] = SIZE_PX[size] || SIZE_PX.square_hd;
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
    + `?width=${w}&height=${h}&nologo=true&seed=${seed}`;
  return fetchImage(url);
}

function trae(prompt, size) {
  const url = 'https://core-normal.trae.ai/api/ide/v1/text_to_image'
    + `?prompt=${encodeURIComponent(prompt)}&image_size=${size}`;
  return fetchImage(url);
}

export async function generateImage(prompt, size = 'square_hd') {
  const p = String(prompt || '').trim();
  if (!p) throw new Error('generateImage needs a text prompt');
  const sz = SIZE_PX[size] ? size : 'square_hd';

  let buf;
  try {
    buf = await pollinations(p, sz);
  } catch {
    buf = await trae(p, sz);
  }

  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const ext = isPng ? '.png' : '.jpg';
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const name = `${randomUUID().slice(0, 8)}${ext}`;
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    return { prompt: p, size: sz, file: name, url: `/generated/${name}`, bytes: buf.length };
  } catch {
    // Read-only filesystem (e.g. serverless): hand back a data URL instead.
    const mime = isPng ? 'image/png' : 'image/jpeg';
    return { prompt: p, size: sz, file: `image${ext}`, url: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
  }
}
