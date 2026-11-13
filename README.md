# Fluffy Waddle

A clean AI chat web app for **free OpenRouter models** and **NVIDIA NIM** models.
No build step, no dependencies.

## Run

```bash
node server.js          # then open http://localhost:8080
```

`server.js` serves the page and proxies NVIDIA requests (see below).

## Keys

Open **Settings** (⚙) and paste:

- OpenRouter key from https://openrouter.ai/keys
- NVIDIA key (`nvapi-…`) from https://build.nvidia.com

Keys and chats are stored only in your browser's `localStorage`, in plain text.

## Why the proxy?

- **OpenRouter** allows browser requests, so it is called directly. The free-model list is loaded live.
- **NVIDIA NIM** (`integrate.api.nvidia.com`) sends no CORS headers, so browsers block direct calls
  with a "Failed to fetch" error. `server.js` forwards `/api/nvidia/*` to NVIDIA.

Hosting the page on a static host (Netlify, GitHub Pages)? Deploy `proxy/worker.js` as a Cloudflare Worker
and set **Settings → Proxy base URL** to `https://<your-worker>.workers.dev/v1`.
The proxy never stores keys; it forwards the `Authorization` header you send.

## Features

- Landing page with scroll-linked animations (progress bar, parallax, reveal, count-up) that respect reduced motion
- Provider switch and model picker, streaming replies with a stop button
- Reasoning models show their thinking in a collapsible block
- Clear error messages (bad key, rate limit, CORS, empty reply) with a retry button
- Light/dark theme, saved chats, copyable code blocks, mobile layout
