# Fluffy Waddle

A dependency-free AI chat app for OpenRouter and NVIDIA NIM, with optional OpenRouter web search and Simular's hosted box MCP server.

## Run and test

Use Node.js 20 or newer:

```bash
node server.js                 # http://localhost:8080, or set PORT
node --test test/*.test.js
```

Open **Settings** to add an OpenRouter or NVIDIA API key, or configure server environment variables as described below. Browser settings, tokens and chats are saved **unencrypted in localStorage** and are accessible to anyone with access to that browser profile. Use HTTPS on any non-local deployment. Clear browser storage when using a shared device.

## Web search

In Settings, check **Enable OpenRouter web search**. This sends OpenRouter's `openrouter:web_search` tool with chat requests; the model decides whether to use it. Search can incur charges **even when the model is free**. Source links from returned citations are shown where available. Search requires OpenRouter and may depend on model/provider tool support; it is not supported for NVIDIA. Switch off the setting to use NVIDIA.

## Other MCP servers

Open **Settings → Other MCP servers**. To add a link, enter a name, an HTTPS MCP URL, and an optional bearer token; click **Add link to JSON**, then **Test enabled servers** and **Save**. Alternatively paste JSON such as:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    },
    "second-server": {
      "url": "https://example.org/mcp",
      "disabled": true
    }
  }
}
```

This accepts remote **Streamable HTTP** MCP servers (optionally `"type": "http"`). Set `disabled` to `true` to skip a server. Headers are optional; use an actual value, not an environment-variable placeholder. The JSON editor displays credentials and saves them unencrypted in browser localStorage, so don't use shared browsers or paste secrets into chat. The token goes to the specified MCP server, not to the model; tool descriptions and approved results are sent to the model provider. Connect only trusted servers and review every tool call before approving it.

Other MCP URLs are contacted **directly from the browser**, not through a general-purpose server proxy. They must support HTTPS, Streamable HTTP, and CORS for the app's origin, including POST/OPTIONS and the required request and response headers (such as `Mcp-Session-Id`). Servers that do not allow browser CORS will not work directly. Local/stdio `command` configurations, OAuth sign-in flows, environment expansion, legacy SSE-only transport, MCP resources/prompts, and server-initiated requests are not supported. The built-in Simular connection uses its own fixed-destination proxy and remains available separately. Up to 10 remote servers and 200 total tools can be enabled; a tool-calling model is required.

## Skills

In **Settings → Skills**, check a built-in skill to enable it. Edit **Skills JSON** to change instructions or add your own:

```json
[
  { "name": "Writing", "enabled": true, "instructions": "Write clearly and concisely." }
]
```

Enabled skills are reusable instructions included in each model request. They are not executable Agent Skills packages: the app does not install packages, run scripts, or load `SKILL.md` files and their supporting files automatically. Only add instructions you trust, and don't put secrets in them. These settings are stored locally in the browser.

## box by Simular MCP

1. Sign in at [box by Simular](https://box.simular.ai/), then create a personal key at [box.simular.ai/access](https://box.simular.ai/access). The key normally begins with `cb_`.
2. Enter the personal key in **Settings → box by Simular MCP**, click **Test Simular box connection**, and enable box tools. The app accepts personal keys; it does **not** support Simular's interactive OAuth login. On a protected deployment, you can instead use the server variable below.
3. Choose a tool-calling model and ask it to use the cloud computer. The app discovers MCP tools, passes their definitions to the model, and asks for confirmation on **every** proposed tool call. Inspect the tool and arguments carefully: tools can browse, run commands, and modify or delete files. Declining prevents execution. Tool results are sent to your AI provider. Image output is not displayed as a visual screenshot in this app.

The server forwards MCP requests only to `https://mcp.box.simular.ai/mcp`; it is not an arbitrary URL proxy. It supports Streamable HTTP request/response MCP tools with JSON or SSE responses, including session IDs. It does not support stdio/local MCP servers, interactive OAuth, or server-initiated MCP requests. Tool calling requires a compatible model/provider. Never approve an action solely because a page or model asks you to; external content can contain misleading instructions. See [Simular's MCP documentation](https://box.simular.ai/docs/mcp).

## Vercel deployment

Import this repository into Vercel. Leave the framework preset as **Other**; the included configuration builds `public/index.html` and creates Node functions for `/api/config`, NVIDIA, OpenRouter and Box. Choose Node.js 20 or later in the project settings. Add only the environment variables you need in **Project → Settings → Environment Variables**, select the relevant Production/Preview/Development environments, and redeploy after changing them:

| Exact name | Value | Required? |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Your OpenRouter API key, from [OpenRouter keys](https://openrouter.ai/keys) | For OpenRouter server-side chat and web search, unless users enter their own browser key |
| `NVIDIA_API_KEY` | Your NVIDIA NIM API key, from [NVIDIA build](https://build.nvidia.com/) | For NVIDIA server-side chat, unless users enter their own browser key |
| `BOX_ACCESS_TOKEN` | A Simular box personal key from [box.simular.ai/access](https://box.simular.ai/access) | Optional; for a protected deployment only, or users can enter their own token in Settings |

In each Vercel entry, the **Key/Name** is exactly the text in the first column; the **Value** is your actual secret, without quotes or `Bearer `. Do not commit secrets or share them in chat. The settings dialog detects whether each variable is present but does **not** validate that it works. Browser-provided credentials take precedence over server credentials. A custom NVIDIA proxy URL requires a browser NVIDIA key; server fallback only applies to the built-in `/api/nvidia` route. Web search needs no separate search key, but OpenRouter may charge for it. This app does not perform OAuth login or token refresh.

**Security:** This app has no login, authorization, or rate limiting. A secret configured on a server is usable by anyone who can reach its API, even though the secret value itself is not displayed. The Box confirmation is only in the browser UI and can be bypassed by calling the API directly. A shared `BOX_ACCESS_TOKEN` would let visitors control the Simular cloud computer, potentially including running commands and modifying or deleting files. Do not set server secrets on a publicly accessible deployment without protecting **all** routes, including `/api/*`, with appropriate authentication and abuse controls. Prefer individual browser credentials on a public deployment. Vercel function duration and payload limits can also interrupt long AI responses.

## Other deployment options

Run `node server.js` on a Node host with outbound HTTPS access to `integrate.api.nvidia.com` and `mcp.box.simular.ai`. It listens on `0.0.0.0` and uses the `PORT` environment variable. The same optional environment variables above work locally. Terminate TLS at your hosting provider or reverse proxy. Configure request-size limits, rate limiting, monitoring, and access controls at that layer before exposing it publicly; the included server is an unauthenticated application proxy, not a multi-tenant gateway. It serves only the public HTML page, not repository files.

Static hosting (such as GitHub Pages) can use OpenRouter directly. NVIDIA requires the optional `proxy/worker.js` Cloudflare Worker; set **Proxy base URL** to `https://<your-worker>.workers.dev/v1`. That Worker only proxies NVIDIA and does **not** provide Box MCP. For Box, host the included Node server on the same origin as the page. The Worker permits cross-origin requests and is not rate-limited; configure appropriate protections before public use.

## Features

- Live OpenRouter free-model list and NVIDIA model picker
- Streaming replies, stop, retry, reasoning view, and copyable code blocks
- Saved chats, light/dark theme, responsive layout, and reduced-motion support
- Optional web search, approval-gated MCP tools, and reusable instruction skills
