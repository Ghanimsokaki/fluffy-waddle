# Gemby AIs

An AI chat app with Supabase accounts, one user-supplied AI key, optional OpenRouter web search, instruction skills, and approval-gated MCP tools. The original chat layout, animations and responsive theme are retained.

## Supabase setup (required for accounts)

1. Create a Supabase project. In its SQL Editor run [`supabase/schema.sql`](supabase/schema.sql). This creates `gemby_profiles` with row-level security; each authenticated user can access only their own row. The app also serves this non-secret SQL at `/schema.sql` and links to it from the sign-in setup help.
2. Enable **Email** authentication in Supabase. Configure the Site URL and allowed Redirect URLs for your deployed site and, if testing locally, `http://localhost:8080/`. Email confirmation and password reset depend on your Supabase email settings and redirect configuration.
3. In Vercel → Project → Settings → Environment Variables add:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_ANON_KEY` | Your Supabase **publishable/anon** API key |

   These two values are public browser configuration. **Never use the service-role or secret key** as the anon key. Set them for the relevant Production, Preview and Development environments and redeploy after changes. This app does not use or need a Supabase service-role key.
4. Open Gemby AIs, select **Account**, create an account, and confirm the email if your project requires it. Sign in and add your AI key in Settings. The app needs Supabase configuration and the SQL schema before login and sync can work.

Chats, selected provider/model, skills and non-secret chat preferences are stored in Supabase under the signed-in account. AI keys, Simular keys, and custom connector configurations/headers are **not** synced; they stay unencrypted in browser localStorage, namespaced by account. Supabase session tokens also live in the browser. Anyone with access to the browser profile or running scripts on the site may access local secrets. Use HTTPS, a trusted device and browser, and clear site data on shared devices. Don't put secrets in chats or skills, since those can be synced and sent to your AI provider. Old `fw.*` browser data is left untouched and is not automatically imported. After signing in, use **Account → Import old browser chats** to upload previous chats into that account; old keys and connectors are never imported.

Sync currently saves the account's chat collection as one row; simultaneous edits from different devices are last-write-wins. Use **Retry sync** if a save fails, and check the sync status before leaving or changing devices.

## Run locally

Node.js 20 or newer is required. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in your shell (never commit secrets), then:

```bash
npm ci
npm start                 # builds browser auth client and listens on http://localhost:8080
npm test
```

On Vercel, import the repository using the **Other** framework preset. The build command and output directory are in `vercel.json`. Functions proxy NVIDIA, Simular, and CodeCraft requests to fixed upstream hosts. The chat/tool proxies require a user-supplied bearer token but do not authenticate users themselves. Protect or rate-limit your deployment as appropriate; they are not multi-tenant gateways.

## One AI key

Choose OpenRouter or NVIDIA in the chat header, then add the corresponding API key in **Settings**. Only one browser AI-provider key is stored at a time; switching provider clears it. OpenRouter calls go directly to OpenRouter; NVIDIA calls use the included fixed-destination proxy. Neither silently falls back to a server key. CodeCraft is a separate, explicitly selected provider that uses the Vercel key described below. AI keys are not sent to MCP servers. A separate connector may require its own credentials—an AI-provider key does not authenticate third-party services.

OpenRouter web search is optional in Settings and may incur charges even for free models. It requires an OpenRouter model/provider that supports the search tool. This OpenRouter search option is not supported with NVIDIA or CodeCraft.

## CodeCraft on Vercel

CodeCraft is an OpenAI-compatible provider; Gemby AIs uses its fixed `https://codecraftapi.com/v1` endpoint. Set up Supabase first. Then in **Vercel → Project → Settings → Environment Variables** add:

| Name | Value |
| --- | --- |
| `CODECRAFT_API_KEY` | Your CodeCraft API key (`cc_…`) |
| `CODECRAFT_ALLOWED_EMAILS` | A comma-separated list of Supabase account emails allowed to spend that key, e.g. `you@example.com` |

Also configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` as described above. Select the desired Production/Preview/Development environments and redeploy. Create/sign in to a Supabase account with a **confirmed email** from the allowlist, select **CodeCraft** in the chat header, and choose a model from the live list. The app does not invent model IDs; select a Sonnet model only if CodeCraft actually lists it. The key needs CodeCraft's inference and `models:read` scopes. Model availability, costs, and quotas are determined by CodeCraft.

The server checks each request's session with Supabase and rejects unconfirmed or non-allowlisted accounts before it uses the server key. The session is not forwarded to CodeCraft; the CodeCraft key is not returned to the browser or sent to MCP servers. **This is not a spending limit or rate limiter:** every approved account can spend the shared key's quota. Limit the allowlist, configure provider budgets and rate limits, and protect your deployment before production. An empty allowlist disables CodeCraft access. This feature has automated mocked tests but has not been verified against a live Supabase or CodeCraft account.

## MCP connectors and skills

**box by Simular:** Create a personal key at [box.simular.ai/access](https://box.simular.ai/access), enter it under **Settings → box by Simular MCP**, test the connection, and enable its tools. The server forwards requests only to `https://mcp.box.simular.ai/mcp`; interactive OAuth is not supported.

**Other MCP servers:** In Settings, add an HTTPS Streamable HTTP link or paste configuration JSON:

```json
{
  "mcpServers": {
    "example": { "url": "https://example.com/mcp" },
    "disabled-example": { "url": "https://example.org/mcp", "disabled": true }
  }
}
```

Optional `headers` can contain a bearer token. These configurations are stored locally and are visible in the JSON editor. Remote MCP URLs are contacted directly from the browser and require the server to allow CORS, including required MCP headers. Local/stdio commands, OAuth login, legacy SSE-only endpoints, environment-variable expansion, MCP resources/prompts and server-initiated requests are not supported. Image/audio tool results are omitted. A tool-calling model is required.

When enabled in Settings, the AI can propose a connector name and HTTPS URL, but it cannot provide credentials. You must approve the proposal; it is saved **disabled** until you enable it in Settings. Every MCP tool action also requires approval. Review URLs, names, and arguments carefully: tools may run commands, access data, or change files. Approved tool results and server-provided tool descriptions are sent to the selected AI provider. Never trust instructions in untrusted pages or tool results automatically.

In **Settings → Skills**, enable built-in skills or edit their JSON. Skills are reusable instructions sent to the model, not executable skill packages or automatic `SKILL.md` loaders.

## Verification and limitations

Run `npm test` and `npm run build`. The automated tests mock provider and Supabase calls; they do not prove your Supabase project, email delivery, RLS policies, model provider, MCP server, or Vercel deployment is correctly configured. Test sign-up, password reset, account isolation, sync, and connector access with your own configured project before production. Supabase Auth and email provider limits, Vercel function limits, and AI provider charges apply.
